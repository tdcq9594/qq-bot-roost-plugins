/**
 * 让模型「看得见」图。
 *
 * 之前只把图片 URL 拼成一句话塞给模型——它看到的是一行字，
 * 根本看不见图。有人发张截图问「这报错怎么修」，它只能干瞪眼。
 *
 * 做法跟 Aurabot 一样：下载下来转 base64，作为图片块交给宿主。
 * 限张数、限大小——一张图几百到几千 token，不设上限能把上下文撑爆。
 *
 * 同时**落一份到本地**并把路径写进正文：
 * QQ 的图片 URL 是有时效的，模型拿它去 `<<image: url>>` 转发，
 * 过一会儿就 404 了。本地路径不会过期，模型也能直接引用。
 */

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 默认最多看几张 */
export const MAX_IMAGES = 4;
/** 单张上限，超了就跳过（宁可看不见，也别把请求撑到几 MB） */
export const MAX_BYTES = 2 * 1024 * 1024;

/** 落盘的图片留多久。它会出现在对话上下文里，删太早模型引用就断 */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** 清理节流：一小时最多扫一次目录 */
const SWEEP_EVERY_MS = 60 * 60 * 1000;
let lastSweep = 0;

/** 只认这几种，别把奇怪的东西当图喂给模型 */
const OK_MIME = /^image\/(png|jpe?g|gif|webp)$/i;

/** 以「文件」形式发出来的图：扩展名和 contentType 两条线索都认 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

/**
 * 这个附件是不是能看的图。
 *
 * **`type === 'file'` 也要认**：QQ 有时把图片按文件发（原图、从相册选原文件），
 * 这时 `content_type` 是 `file` 而不是 `image/png`，框架就把它归成 `file`。
 * 只认 `type === 'image'` 的话，这类图会被当成普通文件——模型只看到
 * 「（发了个文件：xxx.png）」，等于"只能看到文件名"（2026-11-03 反馈）。
 */
export function isImageAttachment(a) {
  if (!a?.url) return false;
  if (a.type === 'image') return true;
  if (a.type !== 'file') return false;
  return IMAGE_EXT.test(String(a.filename || '')) || /^image\//i.test(String(a.contentType || ''));
}

/** mime → 扩展名。落盘要带后缀，否则别的工具认不出来 */
function extOf(mime) {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/webp') return '.webp';
  return '.jpg';
}

/**
 * 清掉过期图片。
 *
 * 不清理的话，聊得多的机器人几个月能攒出几个 G——而这些图发完就没用了。
 * **只删自己写的 `qq-*.` 文件**：目录是插件自己的，但宁可保守一点。
 */
function sweep(cacheDir) {
  const now = Date.now();
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  try {
    for (const name of readdirSync(cacheDir)) {
      if (!name.startsWith('qq-')) continue;
      const file = join(cacheDir, name);
      try {
        if (now - statSync(file).mtimeMs > KEEP_MS) unlinkSync(file);
      } catch {}
    }
  } catch {}
}

/** 从 content-type 或文件头猜 mime */
export function guessMime(buf, contentType = '') {
  const ct = String(contentType).split(';')[0].trim().toLowerCase();
  if (OK_MIME.test(ct)) return ct;
  if (buf?.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  }
  return '';
}

/**
 * 把消息里的图片下载成 base64 块，并落一份到本地。
 *
 * 任何一张失败都只是**少看一张**，不影响整轮对话——
 * 图片挂了不该让用户连文字回复都收不到。
 *
 * @param {object} msg
 * @param {object} [opts]
 * @param {string} [opts.cacheDir] 落盘目录。不传就只给 base64（老行为）
 * @returns {Promise<Array<{data:string, mediaType:string, name:string, path:string, index:number}>>}
 */
export async function collectImages(msg, { max = MAX_IMAGES, maxBytes = MAX_BYTES, cacheDir = '', log = () => {} } = {}) {
  const urls = (msg?.attachments ?? [])
    .filter(isImageAttachment)
    .map((a) => String(a.url))
    .slice(0, max);

  if (!urls.length) return [];

  if (cacheDir) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      sweep(cacheDir);
    } catch (e) {
      log(`图片缓存目录不可用（${e?.message ?? e}），这一轮只走内存`);
    }
  }

  const out = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const res = await fetch(urls[i], { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        log(`图片下载失败（HTTP ${res.status}）：${urls[i].slice(0, 60)}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) {
        log(`图片太大（${Math.round(buf.length / 1024)}KB），跳过`);
        continue;
      }
      const mime = guessMime(buf, res.headers.get('content-type') || '');
      if (!mime) {
        log(`不是认识的图片格式，跳过：${urls[i].slice(0, 60)}`);
        continue;
      }

      /**
       * 文件名只用「消息 id + 序号」。
       *
       * 不拿 URL 里的东西拼名字：那串是外部输入，带 `../` 或盘符就能写到
       * 缓存目录外面去。id 里也先洗一遍，只留字母数字和连字符。
       */
      const safeId = String(msg.messageId || 'img').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'img';
      const name = `qq-${safeId}-${i + 1}${extOf(mime)}`;

      let path = '';
      if (cacheDir) {
        try {
          path = join(cacheDir, name);
          writeFileSync(path, buf);
        } catch (e) {
          log(`图片落盘失败（${e?.message ?? e}），这一轮只走内存`);
          path = '';
        }
      }

      out.push({ data: buf.toString('base64'), mediaType: mime, name, path, index: i });
    } catch (e) {
      log(`图片下载出错：${e?.message ?? e}`);
    }
  }
  return out;
}

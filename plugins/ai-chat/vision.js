/**
 * 让模型「看得见」图。
 *
 * 之前只把图片 URL 拼成一句话塞给模型——它看到的是一行字，
 * 根本看不见图。有人发张截图问「这报错怎么修」，它只能干瞪眼。
 *
 * 做法跟 Aurabot 一样：下载下来转 base64，作为图片块交给宿主。
 * 限张数、限大小——一张图几百到几千 token，不设上限能把上下文撑爆。
 */

/** 默认最多看几张 */
export const MAX_IMAGES = 4;
/** 单张上限，超了就跳过（宁可看不见，也别把请求撑到几 MB） */
export const MAX_BYTES = 2 * 1024 * 1024;

/** 只认这几种，别把奇怪的东西当图喂给模型 */
const OK_MIME = /^image\/(png|jpe?g|gif|webp)$/i;

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
 * 把消息里的图片下载成 base64 块。
 *
 * 任何一张失败都只是**少看一张**，不影响整轮对话——
 * 图片挂了不该让用户连文字回复都收不到。
 *
 * @param {object} msg
 * @param {object} [opts]
 * @returns {Promise<Array<{data:string, mediaType:string, name:string}>>}
 */
export async function collectImages(msg, { max = MAX_IMAGES, maxBytes = MAX_BYTES, log = () => {} } = {}) {
  const urls = (msg?.attachments ?? [])
    .filter((a) => a?.type === 'image' && a.url)
    .map((a) => String(a.url))
    .slice(0, max);

  if (!urls.length) return [];

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
      out.push({ data: buf.toString('base64'), mediaType: mime, name: `qq-${msg.messageId || 'img'}-${i + 1}` });
    } catch (e) {
      log(`图片下载出错：${e?.message ?? e}`);
    }
  }
  return out;
}

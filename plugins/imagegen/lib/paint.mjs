/**
 * 画作库：扩展自己目录下的 `out/`
 * ==============================
 *
 * 为什么是「文件名即元数据」而不是一个 index.json：
 *   · 面板只读一个 JSON、模型只看列表，两边都不需要额外的索引层；
 *   · 用户（或主人）直接进文件夹手动删、手动改名，索引立刻就和现实对不上；
 *     按目录现算永远是对的。代价是几千张图会慢，但一个人一天画不了那么多。
 *
 * 文件名形如 `20261114-031501-一只橘猫.png`：时间在前，字典序就是时间序，
 * 排序不用读 mtime；提示词在里面，面板上直接当说明用。
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, normalize, relative } from 'node:path';

import { sniffMime } from './net.mjs';

/** 只认这几种：宿主发图（`<<image:>>`）也只认这些。 */
const EXT_OF_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' };
const IMG_EXT = new Set(Object.values(EXT_OF_MIME).map((e) => `.${e}`));

/** 文件名里能留什么：去掉路径分隔符、Windows 保留字符、控制字符和空白。 */
function slugOf(prompt, max = 20) {
  const s = String(prompt ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\s]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return Array.from(s).slice(0, max).join('') || '图';
}

const pad = (n) => String(n).padStart(2, '0');

/** `20261114-031501`：本地时间，不进文件名时区信息（就一台机器用）。 */
export function stampOf(now = new Date()) {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** 文件名 → { at, prompt }。认不出格式的（用户手动塞进来的）就用文件时间。 */
export function metaOf(file, { dir = '' } = {}) {
  const base = String(file ?? '').replace(/\.[^.]+$/, '');
  const m = /^(\d{8})-(\d{6})-(.*)$/.exec(base);
  if (!m) {
    let at = 0;
    try { at = dir ? statSync(join(dir, file)).mtimeMs : 0; } catch { /* 没了就 0 */ }
    return { at, prompt: '' };
  }
  const [, ymd, hms, tail] = m;
  const at = new Date(
    Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)),
    Number(hms.slice(0, 2)), Number(hms.slice(2, 4)), Number(hms.slice(4, 6)),
  ).getTime();
  return { at: Number.isFinite(at) ? at : 0, prompt: tail || '' };
}

/** 只接受本目录下的纯文件名：挡 `../`、绝对路径、盘符、NUL。 */
export function safeName(dir, name) {
  const s = String(name ?? '').trim();
  if (!s || s !== basename(s) || isAbsolute(s) || s.includes('\u0000')) return '';
  const full = normalize(join(dir, s));
  if (relative(dir, full).startsWith('..') || relative(dir, full).includes(':')) return '';
  return IMG_EXT.has(extname(s).toLowerCase()) ? s : '';
}

/**
 * 存一张画。
 *
 * 存失败**不抛**：图已经在内存里了，发出去才是主人要的结果；
 * 存不下来顶多是「画作库里没有这张」，不该连带把这次生图判成失败。
 * 返回 `''` 表示没存下，调用方据此决定还要不要给路径。
 */
export function savePainting({ dir, buf, prompt, now = new Date() }) {
  try {
    const mime = sniffMime(buf);
    const ext = EXT_OF_MIME[mime];
    if (!ext) return '';
    mkdirSync(dir, { recursive: true });
    const stamp = stampOf(now);
    const slug = slugOf(prompt);
    let file = `${stamp}-${slug}.${ext}`;
    /** 同一秒画两张同提示词的图：加序号，别覆盖前一张 */
    for (let i = 2; existsSync(join(dir, file)) && i < 100; i += 1) file = `${stamp}-${slug}-${i}.${ext}`;
    writeFileSync(join(dir, file), buf);
    return file;
  } catch {
    return '';
  }
}

/**
 * 最近画的几张。`limit` 夹在 1–50：面板一次也显示不了更多。
 * 0 / 负数 / 非数字一律当没填，用默认 20 —— 「要 0 条」这种请求按默认处理更不容易出错。
 */
export function listPaintings({ dir, limit = 20 } = {}) {
  const raw = Number(limit);
  const n = Number.isFinite(raw) && raw > 0 ? Math.min(50, Math.round(raw)) : 20;
  let names = [];
  try {
    names = readdirSync(dir).filter((f) => IMG_EXT.has(extname(f).toLowerCase()));
  } catch {
    return { items: [], total: 0, limit: n };
  }
  const all = [];
  for (const file of names) {
    try {
      const st = statSync(join(dir, file));
      if (!st.isFile()) continue;
      const meta = metaOf(file, { dir });
      all.push({ file, bytes: st.size, at: meta.at || st.mtimeMs, prompt: meta.prompt });
    } catch { /* 读不到就跳过：一个坏文件不该让整页空掉 */ }
  }
  all.sort((a, b) => b.at - a.at);
  return { items: all.slice(0, n), total: all.length, limit: n };
}

/** 这张图在本机的完整路径；不合法或不存在返回空串。 */
export function pathOf(dir, name) {
  const file = safeName(dir, name);
  if (!file) return '';
  const full = join(dir, file);
  return existsSync(full) ? full : '';
}

/**
 * 把 `#1` / `1` / `最新` / `20261114-031501-猫.png` 解析成一张画。
 *
 * 编号是「最近的第几张」：`#1` 永远是最新那张。只在最近 50 张里找——
 * 和面板显示的范围一致，免得模型用一个没在列表里出现过的编号。
 * 不合法返回 null，**不抛**：调用方要据此给「没找到」而不是崩。
 */
export function resolveRef({ dir, ref, limit = 50 } = {}) {
  const s = String(ref ?? '').trim();
  if (!s) return null;
  const { items } = listPaintings({ dir, limit });
  const alias = /^(latest|last|newest|最新|最近|上一张|刚才那张|刚画的|画作)$/i.test(s);
  const num = /^#?(\d{1,2})$/.exec(s);
  let hit = null;
  if (alias) hit = items[0] ?? null;
  else if (num) hit = items[Number(num[1]) - 1] ?? null;
  else {
    const file = safeName(dir, s);
    if (file) hit = items.find((it) => it.file === file) ?? null;
  }
  if (!hit) return null;
  return { ...hit, path: pathOf(dir, hit.file) };
}

/** 删一张。 */
export function removePainting(dir, name) {
  const file = safeName(dir, name);
  if (!file) return { ok: false, message: '文件名不对' };
  const full = join(dir, file);
  if (!existsSync(full)) return { ok: false, message: '这张已经不在了' };
  try {
    unlinkSync(full);
    return { ok: true, message: '删掉了', file };
  } catch (e) {
    return { ok: false, message: `删不掉：${e?.message ?? e}` };
  }
}

/** 人话字节数：面板/工具结果里 1.8MB 比 1887436 好读。 */
export function bytesText(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)}MB`;
  if (v >= 1024) return `${Math.round(v / 1024)}KB`;
  return `${v}B`;
}

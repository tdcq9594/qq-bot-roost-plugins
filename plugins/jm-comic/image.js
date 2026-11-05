// jm-comic 图像处理：竖切还原 + 转 JPEG。
//
// 为什么用 ffmpeg 而不是图像库：
//   · JM 的 CDN 主要给 webp，Node 内置解不了；
//   · 插件市场要求「零依赖优先」，装 sharp 要下几十 MB 的原生二进制；
//   · 还原只是「把画面切成 N 条横带、倒着拼回去」，ffmpeg 的 crop + vstack 正好能表达。
// 缺点：需要 ffmpeg（与 media-vision 同一套，找不到时插件会明确提示，不会静默出错）。
//
// 切块数 N 的算法逐字对齐 jmcomic 的 JmImageTool.get_num_by_url：
// ⚠️ filename 必须是**去掉扩展名**的文件名（'00001'）——带扩展名算出来的 N 是另一个值，
//    结果是「还原」反而把本来正确的图弄花。

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const SCRAMBLE_220980 = 220980;
export const SCRAMBLE_268850 = 268850;
export const SCRAMBLE_421926 = 421926;

const md5hex = (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');

/** 去掉扩展名的文件名（等价 jmcomic 的 of_file_name(url, True)）。 */
export function filenameStem(name) {
  return path.basename(String(name ?? '')).replace(/\.[a-zA-Z0-9]{2,5}$/, '');
}

/**
 * 切块数 N；N <= 0 表示这张图没被打乱。
 * @param {number} scrambleId 站点返回的 scramble_id
 * @param {number|string} albumId 本子 ID（不是单章 ID）
 * @param {string} fileName 图片文件名，**必须能取出去掉扩展名的 stem**
 */
export function segmentationNum(scrambleId, albumId, fileName) {
  const sid = Number(scrambleId) || 0;
  const aid = Number(albumId);
  if (sid <= 0 || !Number.isFinite(aid) || aid < sid) return 0;
  if (aid < SCRAMBLE_268850) return 10;
  const x = aid < SCRAMBLE_421926 ? 10 : 8;
  const stem = filenameStem(fileName);
  const last = md5hex(`${aid}${stem}`).slice(-1);
  return (last.charCodeAt(0) % x) * 2 + 2;
}

// ───────────────────────── ffmpeg 探测 ─────────────────────────

function commonPaths() {
  const list = [];
  for (const drive of ['C', 'D', 'E', 'F']) {
    list.push(`${drive}:/ffmpeg/bin/ffmpeg.exe`, `${drive}:/ffmpeg/ffmpeg.exe`);
  }
  list.push(
    'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
    'C:/Program Files (x86)/ffmpeg/bin/ffmpeg.exe',
    'C:/ProgramData/chocolatey/bin/ffmpeg.exe',
  );
  if (process.env.LOCALAPPDATA) list.push(`${process.env.LOCALAPPDATA}/Microsoft/WinGet/Links/ffmpeg.exe`);
  if (process.env.USERPROFILE) list.push(`${process.env.USERPROFILE}/scoop/shims/ffmpeg.exe`);
  list.push('/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/snap/bin/ffmpeg');
  return list;
}

const FFMPEG_RETRY_MS = 60_000;
let ffCache = null; // { at, value }

async function canRun(exe) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const child = spawn(exe, ['-version'], { windowsHide: true });
      child.on('error', () => finish(false));
      child.on('close', (code) => finish(code === 0));
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish(false);
      }, 5000).unref?.();
    } catch {
      finish(false);
    }
  });
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 找 ffmpeg / ffprobe。顺序：配置路径 → PATH → 常见安装位置。
 * 成功长期缓存，失败只缓存 60 秒（用户可能刚装好，不该一直判死）。
 */
export async function findFfmpeg(explicit = '') {
  const now = Date.now();
  if (ffCache && (ffCache.value.found || now - ffCache.at < FFMPEG_RETRY_MS)) return ffCache.value;

  const tried = [];
  const candidates = [];
  const conf = String(explicit || '').trim();
  if (conf) {
    candidates.push(conf, path.join(conf, 'ffmpeg.exe'), path.join(conf, 'ffmpeg'));
  }
  candidates.push('ffmpeg', 'ffmpeg.exe', ...commonPaths());

  for (const cand of candidates) {
    if (cand === 'ffmpeg' || cand === 'ffmpeg.exe') {
      if (await canRun(cand)) {
        const value = { found: true, ffmpeg: cand, ffprobe: await guessProbe(cand), note: '' };
        ffCache = { at: now, value };
        return value;
      }
      tried.push(`${cand}（不可用）`);
      continue;
    }
    if (!(await exists(cand))) {
      tried.push(`${cand}（不存在）`);
      continue;
    }
    if (await canRun(cand)) {
      const value = { found: true, ffmpeg: cand, ffprobe: await guessProbe(cand), note: '' };
      ffCache = { at: now, value };
      return value;
    }
    tried.push(`${cand}（运行失败）`);
  }

  const value = {
    found: false,
    ffmpeg: '',
    ffprobe: '',
    note: `没找到可用的 ffmpeg：${tried.slice(0, 3).join('；')}`,
  };
  ffCache = { at: now, value };
  return value;
}

async function guessProbe(ffmpegExe) {
  const dir = path.dirname(ffmpegExe);
  if (dir && dir !== '.') {
    const name = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
    const p = path.join(dir, name);
    if (await exists(p)) return p;
  }
  return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
}

export function resetFfmpegCache() {
  ffCache = null;
}

export function ffmpegHint(found) {
  if (found?.found) return 'ffmpeg 可用';
  return (
    '没有找到 ffmpeg —— 竖切还原和 PDF 都要用它。' +
    'Windows 去 gyan.dev 下 full 版解压到 C:/ffmpeg/bin（不用安装），或在设置里填 ffmpeg 的 bin 目录'
  );
}

// ───────────────────────── 执行 / 探测尺寸 ─────────────────────────

export function run(cmd, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      resolve(val);
    };
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (error) {
      finish({ ok: false, code: -1, stdout: '', stderr: '', error: `无法启动 ${cmd}：${error?.message ?? error}` });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, code: -1, stdout: out, stderr: err, error: `超时（${Math.round(timeoutMs / 1000)} 秒）` });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (c) => {
      out += c.toString('utf8');
      if (out.length > 200_000) out = out.slice(-100_000);
    });
    child.stderr?.on('data', (c) => {
      err += c.toString('utf8');
      if (err.length > 200_000) err = err.slice(-100_000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, code: -1, stdout: out, stderr: err, error: error?.message ?? String(error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, code, stdout: out, stderr: err, error: code === 0 ? '' : `ffmpeg 退出码 ${code}` });
    });
  });
}

/** 图片宽高：优先 ffprobe，没有就解析 `ffmpeg -i` 的 stderr。 */
export async function imageSize(file, ff, { timeoutMs = 20000 } = {}) {
  if (ff?.ffprobe) {
    const r = await run(
      ff.ffprobe,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', file],
      { timeoutMs },
    );
    const m = String(r.stdout || '').trim().match(/(\d+)x(\d+)/);
    if (r.ok && m) return { width: Number(m[1]), height: Number(m[2]) };
  }
  const r2 = await run(ff.ffmpeg, ['-hide_banner', '-i', file], { timeoutMs });
  const m2 = `${r2.stderr}`.match(/,\s(\d{2,5})x(\d{2,5})[\s,]/);
  if (m2) return { width: Number(m2[1]), height: Number(m2[2]) };
  return { width: 0, height: 0 };
}

/**
 * 生成 crop+vstack 的滤镜串，把竖切打乱的横带倒序拼回。
 * 第 i 条（在目标图里从上往下数）取源图从下往上数第 i 条；
 * 余数 over 加到最底下那一条上（与 jmcomic / Pillow 实现一致）。
 */
export function descrambleFilter(width, height, num) {
  const n = Math.max(0, Math.floor(Number(num) || 0));
  if (n <= 1 || !width || !height) return '';
  const move = Math.floor(height / n);
  if (move <= 0) return '';
  const over = height % n;

  const parts = [`[0:v]format=rgba,split=${n}` + Array.from({ length: n }, (_, i) => `[b${i}]`).join('')];
  const stack = [];
  for (let i = 0; i < n; i++) {
    const bandHeight = move + (i === 0 ? over : 0);
    const ySrc = height - move * (i + 1) - over;
    const safeY = Math.max(0, Math.min(height - bandHeight, ySrc));
    parts.push(`[b${i}]crop=${width}:${bandHeight}:0:${safeY}[c${i}]`);
    stack.push(`[c${i}]`);
  }
  parts.push(`${stack.join('')}vstack=inputs=${n}:shortest=1[out]`);
  return parts.join(';');
}

/**
 * 把一张原图转成 JPEG（可选还原竖切、可选缩放）。
 * @returns {Promise<{ok:boolean, file?:string, width?:number, height?:number, descrambled?:boolean, error?:string}>}
 */
export async function toJpeg({
  file,
  outFile,
  ff,
  num = 0,
  maxDim = 0,
  quality = 85,
  timeoutMs = 60000,
  log = () => {},
} = {}) {
  if (!ff?.found) return { ok: false, error: '没有 ffmpeg' };
  const q = Math.max(2, Math.min(31, Math.round((100 - Math.max(30, Math.min(95, quality))) / 2.4)));

  let filter = '';
  let width = 0;
  let height = 0;
  const wantDescramble = num > 1;

  if (wantDescramble) {
    const size = await imageSize(file, ff, { timeoutMs: Math.min(timeoutMs, 20000) });
    width = size.width;
    height = size.height;
    if (width > 0 && height > 0) {
      filter = descrambleFilter(width, height, num);
    } else {
      log(`读不出图片尺寸，跳过还原：${path.basename(file)}`);
    }
  }

  const tail = [];
  if (maxDim > 0) tail.push(`scale='min(${Math.round(maxDim)},iw)':-2`);
  tail.push('format=yuvj420p');

  const parts = [];
  if (filter) {
    // descrambleFilter 的输出已经以 [out] 结尾，从它接着往下接缩放/像素格式
    parts.push(filter, `[out]${tail.join(',')}[v]`);
  } else {
    parts.push(`[0:v]${tail.join(',')}[v]`);
  }
  const graph = parts.join(';');

  const args = [
    '-y', '-loglevel', 'error',
    '-i', file,
    '-filter_complex', graph,
    '-map', '[v]',
    '-frames:v', '1',
    '-q:v', String(q),
    outFile,
  ];

  const r = await run(ff.ffmpeg, args, { timeoutMs });
  if (!r.ok) {
    if (filter) {
      // 还原链失败就退回「只转码不还原」，至少让这本还能看
      log(`还原失败，改为只转码：${path.basename(file)} — ${(r.stderr || r.error || '').slice(0, 160)}`);
      return toJpeg({ file, outFile, ff, num: 0, maxDim, quality, timeoutMs, log });
    }
    return { ok: false, error: (r.stderr || r.error || 'ffmpeg 失败').slice(0, 200) };
  }

  try {
    const st = await fs.stat(outFile);
    if (st.size < 1024) return { ok: false, error: '输出文件过小，可能是坏图' };
    const size = await imageSize(outFile, ff, { timeoutMs: Math.min(timeoutMs, 15000) });
    return {
      ok: true,
      file: outFile,
      width: size.width,
      height: size.height,
      descrambled: Boolean(filter),
    };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** 读 JPEG 的宽高与分量数（PDF 里要写对 ColorSpace）。 */
export function jpegInfo(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return {
        height: buf.readUInt16BE(i + 5),
        width: buf.readUInt16BE(i + 7),
        components: buf[i + 9],
      };
    }
    i += 2 + len;
  }
  return null;
}

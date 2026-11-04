/**
 * 媒体预处理：把「视频 / 大图」变成模型真能看懂的图片。
 *
 * ── 这个文件为什么存在 ───────────────────────────────────────────────
 * 模型只能看图。QQ 消息里的视频（`content_type: video/mp4`）和几十兆的
 * 截图，原样交给下游只会得到一句「（发了一段视频）」——等于没看见。
 * 所以在消息进业务之前，把视频抽成几帧静图、把过大的图压成模型吃得下的
 * JPEG，再换掉附件列表，下游（ai-chat 那套 collectImages）就自然看见了。
 *
 * ── 为什么要 ffmpeg，而不是纯 JS ──────────────────────────────────────
 * 纯 JS 解 H.264/H.265 要拖一个 wasm 解码器进来（十几兆、还得配 WebCodecs），
 * 而 ffmpeg 几乎每台玩视频的机器上都有。装没装、装在哪做成可探测，
 * 探测不到就老实退回「看不了」，而不是把消息卡死。
 *
 * ── 两个已经踩过的坑 ──────────────────────────────────────────────────
 * 1. `-ss` 必须放在 `-i` **前面**（输入定位）：放后面是输出定位，得从第 0 秒
 *    解码到目标时间再全丢掉。10 分钟视频取 4 帧，差别是「秒级」和「卡住」。
 * 2. 抽帧不要用 `-vf fps=` 一把梭：那要顺序解码整段视频，等于把文件读完；
 *    逐帧 `-ss` 跳转只解码关键帧附近，快几十倍。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

/** 兜底上限，防止配置写飞了把磁盘吃光 */
const HARD_MAX_VIDEO_MB = 200;
const HARD_MAX_IMAGE_MB = 60;

/**
 * 跑一个外部命令。
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [o]
 * @param {number} [o.timeoutMs] 超时杀进程
 * @param {number} [o.maxBytes] stdout 上限（ffprobe 输出了错的东西时别把内存吃光）
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, code:number|null, error?:string}>}
 */
export function run(cmd, args, { timeoutMs = 20000, maxBytes = 1 << 20 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let child;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return finish({ ok: false, stdout: '', stderr: '', code: null, error: String(e?.message ?? e) });
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
      finish({ ok: false, stdout, stderr, code: null, error: '超时' });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { if (stdout.length < maxBytes) stdout += d; });
    child.stderr?.on('data', (d) => { if (stderr.length < maxBytes) stderr += d; });
    child.on('error', (e) => finish({ ok: false, stdout, stderr, code: null, error: String(e?.message ?? e) }));
    child.on('close', (code) => finish({ ok: code === 0, stdout, stderr, code }));
  });
}

/**
 * 找 ffmpeg。顺序：配置里写死的路径 → PATH 里的 ffmpeg → 常见安装位置。
 *
 * 成功结果长期缓存；**失败只缓存 60 秒**——用户可能刚装好，
 * 不该逼他重启整个框架才能生效。
 */
let ffCache = null;
let ffCheckedAt = 0;
const FF_RETRY_MS = 60_000;

/**
 * 常见的安装位置，纯属省事：装在这儿就不用手填路径。
 *
 * 每次现算而不是写成常量，是因为用户目录（LOCALAPPDATA / USERPROFILE）
 * 要按运行时的账号取；别人拿去用，账号名肯定不一样。
 */
function commonPaths() {
  const env = process.env;
  const home = env.USERPROFILE || env.HOME || '';
  const local = env.LOCALAPPDATA || (home ? `${home}/AppData/Local` : '');
  const list = [];
  for (const drive of ['C', 'D', 'E']) {
    list.push(`${drive}:/ffmpeg/bin/ffmpeg.exe`, `${drive}:/ffmpeg/ffmpeg.exe`);
  }
  list.push(
    'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
    'C:/Program Files (x86)/ffmpeg/bin/ffmpeg.exe',
    'C:/ProgramData/chocolatey/bin/ffmpeg.exe',
  );
  if (local) list.push(`${local}/Microsoft/WinGet/Links/ffmpeg.exe`);
  if (home) list.push(`${home}/scoop/shims/ffmpeg.exe`);
  // macOS / Linux（有人会把 roost 跑在别处）
  list.push('/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/snap/bin/ffmpeg');
  return list;
}

/**
 * @param {string} [explicit] 配置里的路径（可以是目录，也可以是可执行文件）
 * @returns {Promise<{ffmpeg:string, ffprobe:string}|null>}
 */
export async function findFfmpeg(explicit = '') {
  const want = String(explicit || '').trim();
  // 配置变过就重新探测（用户填了新路径）
  if (ffCache && ffCache.want === want && Date.now() - ffCheckedAt < FF_RETRY_MS) return ffCache.ok ? ffCache : null;
  if (ffCache && ffCache.want === want && ffCache.ok) return ffCache;

  const candidates = [];
  if (want) {
    const isExe = /\.exe$/i.test(want);
    candidates.push(isExe ? want : path.join(want, 'ffmpeg.exe'));
    candidates.push(isExe ? want : path.join(want, 'ffmpeg'));
  }
  candidates.push('ffmpeg', 'ffmpeg.exe', process.env.FFMPEG_PATH || '', ...commonPaths());

  for (const c of candidates) {
    if (!c) continue;
    // 写了绝对路径但文件不存在的话，先跳过——省一次 spawn 开销
    if (path.isAbsolute(c) && !fs.existsSync(c)) continue;
    const r = await run(c, ['-version'], { timeoutMs: 5000 });
    if (r.ok && /ffmpeg version/i.test(r.stdout + r.stderr)) {
      const probe = await probeExe(c);
      ffCache = { ok: true, want, ffmpeg: c, ffprobe: probe };
      ffCheckedAt = Date.now();
      return ffCache;
    }
  }
  ffCache = { ok: false, want, ffmpeg: '', ffprobe: '' };
  ffCheckedAt = Date.now();
  return null;
}

/** ffprobe 一般和 ffmpeg 同目录；找不到就返回空串（调用方会退回解析 stderr） */
async function probeExe(ffmpegPath) {
  const guess = path.isAbsolute(ffmpegPath)
    ? path.join(path.dirname(ffmpegPath), /\.exe$/i.test(ffmpegPath) ? 'ffprobe.exe' : 'ffprobe')
    : (/\.exe$/i.test(ffmpegPath) ? 'ffprobe.exe' : 'ffprobe');
  const cands = [guess, 'ffprobe', 'ffprobe.exe'].filter(Boolean);
  for (const c of cands) {
    if (path.isAbsolute(c) && !fs.existsSync(c)) continue;
    const r = await run(c, ['-version'], { timeoutMs: 5000 });
    if (r.ok) return c;
  }
  return '';
}

/** 测试 / 运维用：清掉探测缓存 */
export function resetFfmpegCache() {
  ffCache = null;
  ffCheckedAt = 0;
}

/**
 * 读视频信息：时长、宽高、有没有音轨。
 *
 * 没有 ffprobe 就退回 `ffmpeg -i` 的 stderr——那是唯一还能拿到时长的地方
 * （`Duration: 00:00:12.34`）。宁可笨一点，也别让「没 ffprobe」直接判死。
 *
 * @returns {Promise<{duration:number, width:number, height:number, hasAudio:boolean}>}
 */
export async function probeVideo(file, ffmpeg, ffprobe = '', timeoutMs = 15000) {
  const out = { duration: 0, width: 0, height: 0, hasAudio: false };
  if (ffprobe) {
    const r = await run(ffprobe, [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file,
    ], { timeoutMs });
    if (r.ok && r.stdout) {
      try {
        const j = JSON.parse(r.stdout);
        out.duration = Number(j?.format?.duration) || 0;
        const v = (j?.streams ?? []).find((s) => s?.codec_type === 'video');
        out.hasAudio = (j?.streams ?? []).some((s) => s?.codec_type === 'audio');
        if (v) {
          out.width = Number(v.width) || 0;
          out.height = Number(v.height) || 0;
          // 手机竖拍是「宽高 + rotate 元数据」，不转正的话描述会全是横的
          const rot = Number(v?.tags?.rotate) || 0;
          if (Math.abs(rot) === 90 || Math.abs(rot) === 270) {
            [out.width, out.height] = [out.height, out.width];
          }
        }
        if (out.duration > 0) return out;
      } catch { /* 落到下面的 stderr 解析 */ }
    }
  }
  if (ffmpeg) {
    const r = await run(ffmpeg, ['-hide_banner', '-i', file], { timeoutMs, maxBytes: 64 * 1024 });
    const text = `${r.stderr}\n${r.stdout}`;
    const m = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) out.duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    const s = text.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/);
    if (s) { out.width = Number(s[1]); out.height = Number(s[2]); }
    out.hasAudio = /Audio:/.test(text);
  }
  return out;
}

/**
 * 均匀取帧时间点。
 *
 * 只取 **5%~95%**：开头常是黑场或片头 logo，结尾常是黑场或字幕，
 * 两头都取等于白扔两帧。这是从 QQ Agent 那版抄来的经验，实测确实更值。
 */
export function frameTimes(duration, count) {
  const n = Math.max(1, Math.min(12, Math.round(Number(count) || 4)));
  const times = [];
  if (Number(duration) > 0) {
    for (let i = 0; i < n; i++) {
      const t = duration * (0.05 + 0.9 * (i / Math.max(1, n - 1)));
      times.push(Number(Math.max(0, t).toFixed(2)));
    }
  } else {
    // 时长未知（容器坏了 / 没有 ffprobe）：按 1s、3s、5s… 猜。
    // 短视频居多，猜错的代价只是画面重复，比「一帧都没有」强。
    for (let i = 0; i < n; i++) times.push(1 + i * 2);
  }
  return times;
}

/**
 * 逐帧抽图，写到 outDir。
 *
 * @param {object} o
 * @param {string} o.file 本地视频
 * @param {string} o.outDir
 * @param {string} o.ffmpeg
 * @param {number} [o.count]
 * @param {number} [o.maxWidth]
 * @param {number} [o.quality] JPEG qscale，2~31，越小越清晰
 * @param {number} [o.duration] 已知时长
 * @param {number} [o.timeoutMs] 单帧超时
 * @returns {Promise<{files:string[], times:number[], skipped:number}>}
 */
export async function extractFrames({
  file, outDir, ffmpeg, count = 4, maxWidth = 768, quality = 4, duration = 0, timeoutMs = 25000,
} = {}) {
  const files = [];
  const times = [];
  let skipped = 0;
  const points = frameTimes(duration, count);

  for (const t of points) {
    const dest = path.join(outDir, `f_${Date.now().toString(36)}_${Math.round(t * 1000)}.jpg`);
    // -ss 在 -i 之前：输入定位，直接跳到关键帧再解码
    const r = await run(ffmpeg, [
      '-y', '-loglevel', 'error',
      '-ss', String(t), '-i', file,
      '-frames:v', '1',
      '-vf', `scale='min(${Math.max(160, Math.round(maxWidth))},iw)':-2`,
      '-q:v', String(Math.max(2, Math.min(31, Math.round(quality)))),
      dest,
    ], { timeoutMs });
    try {
      const st = await fsp.stat(dest);
      if (st.size < 1024) throw new Error('太小');
      files.push(dest);
      times.push(t);
    } catch {
      // 单帧失败（超时 / 黑场 / 跳过头）不影响其它帧
      skipped += 1;
      try { await fsp.unlink(dest); } catch { /* 没生成过 */ }
    }
  }
  return { files, times, skipped };
}

/** 从文件头判图片格式；认不出返回空串 */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  if (buf.toString('ascii', 4, 8) === 'ftyp') return 'heic';
  return '';
}

/** 在流式下载时判断是不是视频容器（用来决定后缀，ffmpeg 其实按内容认） */
export function guessVideoExt(contentType = '') {
  const ct = String(contentType).toLowerCase();
  if (ct.includes('mp4')) return '.mp4';
  if (ct.includes('quicktime') || ct.includes('mov')) return '.mov';
  if (ct.includes('webm')) return '.webm';
  if (ct.includes('matroska')) return '.mkv';
  return '.mp4';
}

/**
 * 流式下载到文件，边下边数大小——超限立刻掐断。
 *
 * 为什么不用 `res.arrayBuffer()`：QQ 的视频动辄几十兆，
 * `arrayBuffer` 是先全下到内存再判断大小，超限时内存已经吃进去了。
 */
export async function downloadTo(url, dest, { maxBytes = 40 * 1024 * 1024, timeoutMs = 30000, headers = {} } = {}) {
  const ac = new AbortController();
  // 注意：定时器要留到正文读完再清，fetch 在响应头到达时就 resolve 了，
  // 正文不受 signal 约束（`arrayBuffer()` 才真正读）。这是 pixiv-pid 那次的教训。
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 roost media-vision', ...headers },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    if (total && total > maxBytes) throw new Error(`文件太大（${(total / 1048576).toFixed(1)}MB）`);
    const fh = await fsp.open(dest, 'w');
    let written = 0;
    try {
      for await (const chunk of res.body) {
        written += chunk.length;
        if (written > maxBytes) throw new Error(`下载超过上限 ${(maxBytes / 1048576).toFixed(0)}MB`);
        await fh.write(chunk);
      }
    } finally {
      await fh.close();
    }
    return { bytes: written, contentType: res.headers.get('content-type') || '' };
  } catch (e) {
    try { await fsp.unlink(dest); } catch { /* 可能没建出来 */ }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把一张图转成「模型友好」的 JPEG（缩放 + 压质量）。
 *
 * 什么时候用：格式模型不吃（bmp/heic）、或者体积超过下游上限
 * （ai-chat 那边是 2MB 一刀切，超了直接跳过＝看不见）。
 *
 * @returns {Promise<{ok:boolean, file?:string, error?:string}>}
 */
export async function normalizeImage({ file, outFile, ffmpeg, maxWidth = 1280, quality = 3, timeoutMs = 20000 }) {
  if (!ffmpeg) return { ok: false, error: '没有 ffmpeg' };
  const r = await run(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-i', file,
    '-frames:v', '1',
    '-vf', `scale='min(${Math.max(160, Math.round(maxWidth))},iw)':-2`,
    '-q:v', String(Math.max(2, Math.min(31, Math.round(quality)))),
    outFile,
  ], { timeoutMs });
  if (!r.ok) return { ok: false, error: (r.stderr || r.error || '转码失败').slice(0, 200) };
  try {
    const st = await fsp.stat(outFile);
    if (st.size < 512) return { ok: false, error: '转出来的图是空的' };
    return { ok: true, file: outFile };
  } catch {
    return { ok: false, error: '没有产出文件' };
  }
}

/** 建一个本次专用的临时目录（在插件 dataDir 下，方便清理） */
export async function makeTempDir(base) {
  const dir = path.join(base, 'tmp', `m${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** 删目录，出错也不叫（临时文件而已） */
export async function removeDir(dir) {
  if (!dir) return;
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch { /* 被占用就交给系统清理 */ }
}

/** 机器上有没有 ffmpeg —— 给面板和状态命令用的一句话结论 */
export function ffmpegHint(found) {
  if (found) return `ffmpeg 可用：${found.ffmpeg}`;
  return `没找到 ffmpeg，视频看不了。装好后在设置里填「ffmpeg 路径」，例如 ${commonPaths()[0] || 'ffmpeg'}`;
}

/** 平台默认临时根，只是给 fallback 用 */
export function defaultTmpRoot() {
  return path.join(os.tmpdir(), 'roost-media');
}

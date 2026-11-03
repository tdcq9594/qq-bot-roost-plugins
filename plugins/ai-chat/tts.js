/**
 * 音频 → QQ 能放的语音（silk）。
 *
 * **合成已经不在这个插件里了**：文字 → 音频由 dsh-roost 按用户配置的
 * provider 完成（OpenAI 兼容 / 本地 GPT-SoVITS / Edge），见 `host-tts.js`。
 * 这里只剩后半段：拿到的音频转成 QQ 官方要求的 **silk**。
 *
 * 为什么还要转：QQ 的语音消息只认 silk，而 TTS 服务给的是 mp3 或 wav。
 * 转换链是：
 *   mp3 → PCM（mpg123-decoder，WASM）
 *   wav → PCM（自己解析 RIFF，16bit PCM）
 *   PCM → silk（silk-wasm）
 *
 * 两个依赖都是**纯 JS/WASM**，不需要 Python、不需要 ffmpeg、不需要装服务。
 * 装法（在插件目录里）：
 *   npm i mpg123-decoder silk-wasm
 *
 * 没装怎么办：**降级发文字**，并且日志里说清楚缺哪个——
 * 不能让用户什么都没收到，也不能让他自己去猜。
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 太长的就不念了——语音条最长 60 秒，硬念会被截断，不如发文字 */
export const MAX_TTS_CHARS = 300;

/** 合成出来的 silk 保留多久。语音条是一次性的，留着只占磁盘 */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** 清理节流：一小时最多扫一次目录 */
const SWEEP_EVERY_MS = 60 * 60 * 1000;
let lastSweep = 0;

/**
 * 清掉过期的 silk。
 *
 * 为什么需要：每条语音都会留一个文件，聊得多的机器人一个月能攒出几百 MB，
 * 而这些文件发完就没用了。**只删自己写的 `tts-*.silk`**——
 * 目录是插件自己的，但宁可保守一点，也不要误删用户放进去的东西。
 */
function sweep(cacheDir) {
  const now = Date.now();
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  try {
    for (const name of readdirSync(cacheDir)) {
      if (!name.startsWith('tts-') || !name.endsWith('.silk')) continue;
      const file = join(cacheDir, name);
      try {
        if (now - statSync(file).mtimeMs > KEEP_MS) unlinkSync(file);
      } catch {}
    }
  } catch {}
}

let cached = null;

/**
 * 把两个转换依赖都加载进来。缺哪个就说哪个，别笼统说「语音不可用」。
 * @returns {Promise<{ok:true, libs:object} | {ok:false, missing:string[]}>}
 */
async function loadLibs() {
  if (cached) return cached;
  const missing = [];
  const libs = {};

  for (const [name, key] of [
    ['mpg123-decoder', 'mp3'],
    ['silk-wasm', 'silk'],
  ]) {
    try {
      libs[key] = await import(name);
    } catch {
      missing.push(name);
    }
  }

  cached = missing.length ? { ok: false, missing } : { ok: true, libs };
  return cached;
}

/**
 * 把任意声道混成单声道 s16le。
 *
 * 语音条只要单声道；直接取第一声道会让左右声道不同步的素材听起来缺一半。
 * @param {Float32Array[]} channelData
 * @param {number} frames
 * @returns {Int16Array}
 */
function toMono(channelData, frames) {
  const ch = channelData.length || 1;
  const pcm = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < ch; c++) sum += channelData[c]?.[i] ?? 0;
    const v = Math.max(-1, Math.min(1, sum / ch));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return pcm;
}

/**
 * 解析 WAV（RIFF）里的 PCM。
 *
 * 只收 **16bit 整数 PCM**：这是 GPT-SoVITS / 大多数本地 TTS 的默认输出。
 * 8bit、24bit、32bit float 一律明确拒绝——硬按 16bit 解读会得到一堆噪声，
 * 而「听起来像噪音」比「没有声音」更难排查。
 *
 * @returns {{pcm:Int16Array, sampleRate:number} | {error:string}}
 */
function decodeWav(buf) {
  if (buf.length < 44) return { error: 'wav 文件太短' };
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return { error: '不是 RIFF/WAVE' };
  }

  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size));
    }
    // 块按偶数字节对齐，奇数字节后面有一个填充字节
    offset = body + size + (size % 2);
  }

  if (!fmt || !data) return { error: 'wav 里没有 fmt/data 块' };
  if (fmt.format !== 1) return { error: `wav 编码不是整数 PCM（format=${fmt.format}）` };
  if (fmt.bits !== 16) return { error: `wav 位深是 ${fmt.bits}bit，只支持 16bit` };
  if (!fmt.channels || !fmt.sampleRate) return { error: 'wav 声道/采样率不合法' };

  const frames = Math.floor(data.length / 2 / fmt.channels);
  if (!frames) return { error: 'wav 里没有采样数据' };

  /**
   * 拷到一块新的 ArrayBuffer 再按 Int16 读。
   *
   * 不能直接 `new Int16Array(data.buffer, data.byteOffset, …)`：
   * `data` 是 Buffer 的切片，底层可能来自 Node 的共享内存池，
   * `byteOffset` 不保证是 2 的倍数——那样构造会抛 RangeError，
   * 而错误信息完全看不出是「对齐」问题。
   */
  const samples = frames * fmt.channels;
  const ab = new ArrayBuffer(samples * 2);
  new Uint8Array(ab).set(data.subarray(0, samples * 2));
  const interleaved = new Int16Array(ab);
  const channelData = [];
  for (let c = 0; c < fmt.channels; c++) {
    const one = new Float32Array(frames);
    for (let i = 0; i < frames; i++) one[i] = interleaved[i * fmt.channels + c] / 0x8000;
    channelData.push(one);
  }
  return { pcm: toMono(channelData, frames), sampleRate: fmt.sampleRate };
}

/**
 * 音频字节 → silk 文件。
 *
 * @param {Buffer|Uint8Array} bytes 上游返回的音频
 * @param {string} mime `audio/mpeg`、`audio/wav` …
 * @param {object} opts
 * @param {string} opts.cacheDir 临时文件放哪（插件传自己的目录）
 * @param {(m:string)=>void} [opts.log]
 * @returns {Promise<string|null>} silk 文件路径；失败返回 null（调用方退回发文字）
 */
export async function toSilk(bytes, mime, { cacheDir, log = () => {} } = {}) {
  if (!cacheDir) {
    log('没给 cacheDir，合成不了语音');
    return null;
  }

  const buf = Buffer.from(bytes ?? []);
  if (!buf.length) {
    log('上游返回了空音频');
    return null;
  }

  const kind = String(mime || '').toLowerCase();
  const isMp3 = kind.includes('mpeg') || kind.includes('mp3');
  const isWav = kind.includes('wav') || kind.includes('wave') || kind.includes('l16');
  if (!isMp3 && !isWav) {
    log(`上游返回的音频格式不认识（${kind || '没有 Content-Type'}），只支持 mp3 / wav`);
    return null;
  }

  const r = await loadLibs();
  if (!r.ok) {
    log(`语音不可用，缺依赖：${r.missing.join('、')}（在插件目录 npm i 一下）`);
    return null;
  }

  try {
    let pcm;
    let sampleRate;

    if (isMp3) {
      const { MPEGDecoder } = r.libs.mp3;
      const dec = new MPEGDecoder();
      await dec.ready;
      const { channelData, samplesDecoded, sampleRate: rate } = dec.decode(new Uint8Array(buf));
      dec.free?.();
      if (!samplesDecoded) {
        log('mp3 解码出来是空的');
        return null;
      }
      pcm = toMono(channelData, samplesDecoded);
      sampleRate = rate;
    } else {
      const wav = decodeWav(buf);
      if (wav.error) {
        log(`wav 解析失败：${wav.error}`);
        return null;
      }
      pcm = wav.pcm;
      sampleRate = wav.sampleRate;
    }

    const { encode } = r.libs.silk;
    const silk = await encode(new Uint8Array(pcm.buffer), sampleRate);

    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    sweep(cacheDir);
    const file = join(cacheDir, `tts-${randomUUID().slice(0, 8)}.silk`);
    const out = Buffer.from(silk.data ?? silk);
    writeFileSync(file, out);

    log(`转成 silk 了（${Math.round(out.length / 1024)}KB，${sampleRate}Hz）`);
    return file;
  } catch (e) {
    log(`转 silk 失败：${e?.message ?? e}`);
    return null;
  }
}

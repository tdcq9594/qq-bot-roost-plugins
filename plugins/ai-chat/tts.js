/**
 * 文字 → 语音（QQ 能放的 silk）。
 *
 * 为什么要绕这么大一圈：
 *   QQ 官方的语音消息要 **silk** 格式，而 TTS 出来的都是 mp3。
 *   所以管线是：文字 → mp3 → PCM → silk。
 *
 * 三个依赖都是**纯 JS/WASM**，不需要 Python、不需要 ffmpeg、不需要装服务：
 *   @andresaya/edge-tts  微软 Edge 的在线朗读（免费、不要 Key）
 *   mpg123-decoder       WASM 的 mp3 解码器 → PCM
 *   silk-wasm            腾讯 silk 编码器（QQ 用的就是它）
 *
 * 装法（在插件目录里）：
 *   npm i @andresaya/edge-tts mpg123-decoder silk-wasm
 *
 * 没装怎么办：**降级发文字**，并且日志里说清楚缺哪个——
 * 不能让用户什么都没收到，也不能让他自己去猜。
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 默认音色（微软的中文女声，最自然的一个） */
export const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

/** 太长的就不念了——语音条最长 60 秒，硬念会被截断，不如发文字 */
export const MAX_TTS_CHARS = 300;

let cached = null;

/**
 * 把三个依赖都加载进来。缺哪个就说哪个，别笼统说「TTS 不可用」。
 * @returns {Promise<{ok:true, libs:object} | {ok:false, missing:string[]}>}
 */
async function loadLibs() {
  if (cached) return cached;
  const missing = [];
  const libs = {};

  for (const [name, key] of [
    ['@andresaya/edge-tts', 'tts'],
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

/** 给面板/日志看的一句话状态 */
export async function ttsStatus() {
  const r = await loadLibs();
  return r.ok ? { ok: true, message: '可用' } : { ok: false, message: `缺依赖：${r.missing.join('、')}` };
}

/**
 * 合成一段语音。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.voice] 微软音色名
 * @param {string} opts.cacheDir 临时文件放哪（插件传自己的目录）
 * @param {(m:string)=>void} [opts.log]
 * @returns {Promise<string|null>} silk 文件路径；失败返回 null（调用方退回发文字）
 */
export async function synthesize(text, { voice = DEFAULT_VOICE, cacheDir, log = () => {} } = {}) {
  const say = String(text ?? '').trim();
  if (!say) return null;
  if (say.length > MAX_TTS_CHARS) {
    log(`文字太长（${say.length} 字），不合成语音`);
    return null;
  }
  if (!cacheDir) {
    log('没给 cacheDir，合成不了语音');
    return null;
  }

  const r = await loadLibs();
  if (!r.ok) {
    log(`语音不可用，缺依赖：${r.missing.join('、')}（在插件目录 npm i 一下）`);
    return null;
  }

  try {
    // ① 文字 → mp3
    const { EdgeTTS } = r.libs.tts;
    const tts = new EdgeTTS();
    await tts.synthesize(say, voice);
    const mp3Buf = Buffer.from(await tts.toBuffer());

    // ② mp3 → PCM（s16le）
    const { MPEGDecoder } = r.libs.mp3;
    const dec = new MPEGDecoder();
    await dec.ready;
    const { channelData, samplesDecoded, sampleRate } = dec.decode(new Uint8Array(mp3Buf));
    dec.free?.();

    if (!samplesDecoded) {
      log('mp3 解码出来是空的');
      return null;
    }

    // 多声道混成单声道——语音条只要单声道
    const ch = channelData.length;
    const pcm = new Int16Array(samplesDecoded);
    for (let i = 0; i < samplesDecoded; i++) {
      let sum = 0;
      for (let c = 0; c < ch; c++) sum += channelData[c][i] ?? 0;
      const v = Math.max(-1, Math.min(1, sum / ch));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }

    // ③ PCM → silk
    const { encode } = r.libs.silk;
    const silk = await encode(new Uint8Array(pcm.buffer), sampleRate);

    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    const file = join(cacheDir, `tts-${randomUUID().slice(0, 8)}.silk`);
    writeFileSync(file, Buffer.from(silk.data ?? silk));

    log(`合成好了：${say.slice(0, 20)}…（${Math.round((silk.data?.length ?? 0) / 1024)}KB）`);
    return file;
  } catch (e) {
    log(`语音合成失败：${e?.message ?? e}`);
    return null;
  }
}

/**
 * 让宿主（dsh-roost）合成语音，再把音频转成 QQ 的 silk。
 *
 * 为什么合成放在宿主：语音 provider 的密钥、地址、参考音频路径都该由
 * 「用户配置宿主」那一处管理，插件这边只当通道。宿主关掉语音时，
 * 这里连请求都不会发——**不配就是完全静默**，不报错、不占提示词。
 *
 * 协议（dsh-roost 的固定回环服务，不是面板的 `/roost/api/*`）：
 *   GET  /capabilities → { ok, tts: { enabled, configured, provider, reason } }
 *   POST /tts          → 二进制音频，Content-Type 指明格式
 */

import { toSilk, MAX_TTS_CHARS } from './tts.js';

/** 能力缓存的时长。每轮都问一次太浪费，而它只在用户改配置时才会变 */
const CAP_TTL_MS = 30_000;

/**
 * 能力缓存。**按 base+token 分键**：用户在面板里换了宿主地址或密钥，
 * 不该还拿旧结论（否则要等半分钟才生效，看起来像「改了没用」）。
 */
let capCache = { key: '', at: 0, ready: false };

function baseOf(c) {
  return String(c?.dshUrl || '').trim().replace(/\/+$/, '');
}

/**
 * 宿主地址是否可用（http/https）。
 *
 * 单独校验一次再发请求：地址是畸形串时 `fetch` 抛的 TypeError 是
 * `Failed to parse URL from <整条地址>`——那句话会原样进日志，
 * 而地址里可能带着内网主机名。先挡掉，日志只说「地址不合法」。
 */
function isHttpUrl(base) {
  if (!base) return false;
  try {
    const u = new URL(base);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function headersOf(c, extra) {
  const h = { ...extra };
  /**
   * 共享密钥是可选的：宿主 `server.token` 为空时它不校验。
   * 但配了就必须带——否则 `/capabilities` 和 `/tts` 都是 401，
   * 表现为「开了语音却没声音」，日志里只有一句 HTTP 401。
   */
  const token = String(c?.dshToken || '').trim();
  if (token) h['x-roost-token'] = token;
  return h;
}

/**
 * 宿主这边语音能不能用。
 *
 * 「能用」= 宿主开了语音 **且** 该 provider 的必填项配齐了。
 * 只判 `enabled` 不够：用户勾了启用却没填 baseUrl 时，
 * 让模型去说 `<<say>>` 只会换来一次失败的合成。
 *
 * @returns {Promise<boolean>} 任何异常都当「不可用」，绝不让聊天因此报错
 */
export async function hostTtsReady(c, { log = () => {}, force = false } = {}) {
  const base = baseOf(c);
  if (!base || !isHttpUrl(base)) return false;

  const key = `${base}|${c?.dshToken || ''}`;
  const now = Date.now();
  if (!force && capCache.key === key && now - capCache.at < CAP_TTL_MS) return capCache.ready;

  let ready = false;
  try {
    const res = await fetch(`${base}/capabilities`, {
      headers: headersOf(c),
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      const j = await res.json();
      ready = j?.ok === true && j?.tts?.enabled === true && j?.tts?.configured === true;
      if (j?.tts?.enabled === true && ready !== true && j?.tts?.reason) {
        log(`宿主语音没配齐：${j.tts.reason}`);
      }
    }
  } catch {
    // 宿主没开、超时、回的不是 JSON——都只是「这轮没有语音」
    ready = false;
  }

  capCache = { key, at: now, ready };
  return ready;
}

/**
 * 合成一句话，返回 silk 文件路径。
 *
 * @param {object} c 插件配置（要 `dshUrl` / `dshToken`）
 * @param {string} text 要念的内容
 * @param {object} opts
 * @param {string} opts.cacheDir silk 临时文件目录
 * @param {(m:string)=>void} [opts.log]
 * @returns {Promise<string|null>} 失败一律 null（调用方退回发文字）
 */
export async function synthesize(c, text, { cacheDir, log = () => {} } = {}) {
  const base = baseOf(c);
  if (!base) {
    log('没配 DSH 地址，合成不了语音');
    return null;
  }
  if (!isHttpUrl(base)) {
    log('DSH 地址不是合法的 http(s) 地址，合成不了语音');
    return null;
  }

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

  try {
    const res = await fetch(`${base}/tts`, {
      method: 'POST',
      headers: headersOf(c, { 'content-type': 'application/json' }),
      body: JSON.stringify({ text: say }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      /**
       * 错误信息只取宿主给的 `message`（它已经过滤过密钥和完整地址），
       * 不把响应体原样丢进日志——上游网关的报错里可能带 key。
       */
      let detail = '';
      try {
        detail = String((await res.json())?.message || '');
      } catch {}
      log(`宿主合成失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`);
      return null;
    }

    const mime = String(res.headers.get('content-type') || '').split(';')[0].trim();
    const bytes = Buffer.from(await res.arrayBuffer());
    return await toSilk(bytes, mime, { cacheDir, log });
  } catch (e) {
    log(`语音合成失败：${e?.message ?? e}`);
    return null;
  }
}

import { readFileSync } from 'node:fs';

/**
 * 看画面：抽几帧 → 交给宿主的 `llm.vision` → 拿回一段画面描述。
 *
 * 为什么绕宿主：DSH 的图片必须先经附件服务登记（`attachments.admitPromptContent`），
 * 模型适配层只认登记过的附件块。扩展进程里既没有 llm 也没有 attachments，
 * 自己拼请求一定失败。所以宿主开了 `/v1/llm.vision`（scope `agent:write`），
 * 扩展只负责抽帧和把 base64 递过去。
 *
 * 失败一律**不抛**：没 ffmpeg、模型看不了图、宿主 403 —— 都只是「这条没画面」，
 * 文字流程（标题/简介/字幕/热评）照旧。
 */

const MAX_FRAMES = 6;

/**
 * 抽帧时间点（秒）：跳过开头结尾各 5%，中间均匀铺开。
 *
 * 开头常是片头 / 黑帧，结尾常是黑屏，都不适合判断内容。
 *
 * @param {number} durationSec
 * @param {number} count
 * @returns {number[]}
 */
export function frameTimes(durationSec, count) {
  const d = Number(durationSec) || 0;
  if (!Number.isFinite(d) || !(d > 0)) return [];
  const n = Math.max(1, Math.min(MAX_FRAMES, Math.round(Number(count) || 3)));
  const out = [];
  for (let i = 0; i < n; i += 1) {
    /** n = 1 时取中点，否则 5% → 95% 均分 */
    const p = n === 1 ? 0.5 : 0.05 + (0.9 * i) / (n - 1);
    out.push(Math.min(Math.max(0, Math.round(d * p)), Math.max(0, Math.floor(d) - 1)));
  }
  return [...new Set(out)];
}

/**
 * 问宿主要一段画面描述。
 *
 * @param {{env?: object, prompt?: string, images?: {data:string,mediaType?:string}[], fetchImpl?: Function, timeoutMs?: number}} o
 * @returns {Promise<{ok:boolean, text?:string, why?:string}>}
 */
export async function askVision({
  env = process.env, prompt = '', images = [], fetchImpl = fetch, timeoutMs = 90_000,
} = {}) {
  const base = String(env?.ROOST_API_URL || '').replace(/\/+$/, '');
  const token = String(env?.ROOST_API_TOKEN || '');
  const extId = String(env?.ROOST_EXT_ID || '');
  if (!base || !token) return { ok: false, why: '没有 ROOST_API_URL / ROOST_API_TOKEN（手动跑扩展时正常）' };
  if (!Array.isArray(images) || !images.length) return { ok: false, why: '没有抽到帧' };

  try {
    const r = await fetchImpl(`${base}/llm.vision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        extId,
        prompt: String(prompt || '').slice(0, 2000),
        images: images.map((x) => ({ data: String(x?.data || ''), mediaType: String(x?.mediaType || 'image/jpeg') })),
        maxTokens: 600,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || j?.ok === false) {
      const why = String(j?.message || `HTTP ${r.status}`).slice(0, 200);
      return { ok: false, why };
    }
    const text = String(j?.text || '').trim();
    if (!text) return { ok: false, why: '模型没写出东西' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, why: String(e?.message ?? e).slice(0, 200) };
  }
}

/**
 * 一条视频的看画面流程：抽帧（复用 `shots.take`，顺带进图库）→ 读成 base64 → 问模型。
 *
 * @param {{v: object, info: object, shots: object, cfg: object, env: object, log?: Function, fetchImpl?: Function}} o
 * @returns {Promise<string>} 画面描述；任何一步失败都返回空串
 */
export async function lookAt({ v, info, shots, cfg, env, log = () => {}, fetchImpl = fetch } = {}) {
  if (!shots || typeof shots.take !== 'function') return '';
  const st = typeof shots.ffmpegStatus === 'function' ? shots.ffmpegStatus() : { ready: false };
  if (!st.ready) return '';

  /** 抽几张：面板上「刷一轮时顺手截几张」直接复用；0 就用 3 张 */
  const want = Math.max(1, Math.min(MAX_FRAMES, Number(cfg?.autoShotCount) || 3));
  const ats = frameTimes(info?.duration, want);
  if (!ats.length) return '';

  const images = [];
  for (const at of ats) {
    try {
      const r = await shots.take({ info, at });
      if (!r?.path) continue;
      images.push({ data: readFileSync(r.path).toString('base64'), mediaType: 'image/jpeg' });
    } catch (e) {
      log(`抽帧失败（第 ${at} 秒）：${e?.message ?? e}`);
    }
  }
  if (!images.length) return '';

  const title = String(v?.title || info?.title || '').slice(0, 60);
  const r = await askVision({
    env,
    fetchImpl,
    images,
    prompt: `这些截图来自视频《${title}》（UP主 ${String(v?.author || info?.author || '?').slice(0, 24)}，`
      + `时长 ${Math.round(Number(info?.duration) || 0)} 秒），按时间先后排列，分布在全片 5%~95%。`
      + '只写画面上确实能看到的东西：场景、人物、物体、动作、画面里的文字/字幕条/贴纸。'
      + '不要猜剧情，不要编造，不要发感想。用 3~6 句中文写。',
  });
  if (!r.ok) {
    log(`看画面跳过《${title}》：${r.why}`);
    return '';
  }
  return r.text;
}

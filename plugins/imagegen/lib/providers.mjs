/**
 * 生图接口：OpenAI 兼容、自定义、以及一条备用链
 * ============================================
 *
 * 三种接法的关系：
 *   ① `openai`：只要服务认 `/images/generations`（硅基流动、通义万相的兼容层、
 *      本地 ComfyUI 的 OpenAI 代理……）就能用。**默认走这条**，覆盖绝大多数场景。
 *   ② `custom`：什么都不兼容时的手工接法——URL 模板 + 参数表 + 从返回 JSON 里取图。
 *   ③ `fallbacks`：主接口失败后按顺序再试。按张收钱的服务偶尔 502，重试比让主人
 *      改配置快得多（同一条提示词，换个能用的接口画出来也是同一张画的意思）。
 *
 * 这里全部是纯函数 + 注入的 `fetchImpl`，测试不需要联网。
 */

import { PaintError } from './errors.mjs';
import { decodeDataUrl, fetchImage, sniffMime } from './net.mjs';

/** 把模板里的 `{占位符}` 替换掉；不认识的占位符原样留着（让服务端自己报错）。 */
export function fill(tpl, vars) {
  return String(tpl ?? '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

/** `1024x768` → { width: '1024', height: '768' }；认不出给两个空串。 */
export function dimsOf(size) {
  const m = /^(\d{3,5})x(\d{3,5})$/i.exec(String(size ?? '').trim());
  return m ? { width: m[1], height: m[2] } : { width: '', height: '' };
}

/** 按 `data.0.url` 这种点路径取值。 */
export function dotted(obj, path) {
  let cur = obj;
  for (const k of String(path ?? '').split('.').map((s) => s.trim()).filter(Boolean)) {
    if (cur === null || cur === undefined) return null;
    cur = cur[k];
  }
  return cur ?? null;
}

/**
 * 没配取值路径时，在返回的 JSON 里找个像图片的东西。
 *
 * 只认「data:image」和「http(s) 且像图片文件」两种字符串，**不猜任意字符串**
 * ——有的接口会把整个提示词回显在 JSON 里，猜错的结果是拿提示词当图片解码。
 */
export function findImage(obj, depth = 0) {
  if (depth > 6 || obj === null || obj === undefined) return null;
  if (typeof obj === 'string') {
    if (/^data:image\//i.test(obj)) return obj;
    if (/^https?:\/\//i.test(obj) && /\.(png|jpe?g|webp|gif|bmp)(\?|#|$)/i.test(obj)) return obj;
    return null;
  }
  if (Array.isArray(obj)) {
    for (const it of obj) {
      const r = findImage(it, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof obj === 'object') {
    for (const k of ['url', 'image', 'imageUrl', 'image_url', 'output', 'data', 'images', 'result', 'b64_json']) {
      if (k in obj) {
        const r = findImage(obj[k], depth + 1);
        if (r) return r;
      }
    }
    for (const v of Object.values(obj)) {
      const r = findImage(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

/**
 * 主地址可能被写成三种样子，都要能接：
 *   `https://api.x.com/v1`               → 拼 `/images/generations`
 *   `https://api.x.com/v1/`              → 同上（尾斜杠已去掉）
 *   `https://api.x.com/v1/images/generations` → 已经是完整接口，只把末段换成 edits
 *
 * 第三种很常见：面板上写「服务地址」时，一半人会直接把文档里的完整 URL 贴进来。
 * 不认它就会拼成 `.../generations/images/generations`，报 404 还查不出原因。
 */
export function endpointOf(baseUrl, mode) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  const tail = mode === 'edit' ? 'edits' : 'generations';
  if (/\/images\/(generations|edits)$/i.test(base)) return base.replace(/\/images\/(generations|edits)$/i, `/images/${tail}`);
  return `${base}/images/${tail}`;
}

/**
 * 自定义接口这一次要发什么（纯函数，方便单独测）。
 * @returns {{url:string, method:string, headers:object, body:string|undefined}}
 */
export function customRequest(cfg, prompt, image) {
  const cp = cfg?.custom ?? {};
  const method = String(cp.method ?? 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
  const { width, height } = dimsOf(cfg?.size);
  const raw = {
    prompt,
    model: cfg?.model ?? '',
    size: cfg?.size ?? '',
    width,
    height,
    image: image ? image.toString('base64') : '',
  };
  const enc = { ...raw, prompt: encodeURIComponent(raw.prompt), image: encodeURIComponent(raw.image) };
  const params = (Array.isArray(cp.params) ? cp.params : [])
    .map((p) => ({ key: String(p?.key ?? '').trim(), value: String(p?.value ?? '') }))
    .filter((p) => p.key);

  /**
   * 参考图必须有地方塞：地址模板或某个参数值里出现 `{image}` 才算支持。
   * 传了图却没地方放，等于让服务画一张和参考图无关的图，还不如直接拒绝。
   * 只检查 `#` 之前的部分：fragment 不会发给服务端。
   */
  const sent = method === 'POST' ? params.map((p) => p.value) : params.map((p) => p.value);
  if (image && ![String(cp.url ?? '').split('#')[0], ...sent].some((v) => String(v || '').includes('{image}'))) {
    throw new PaintError('这个自定义接口没有放参考图的位置', {
      hint: '在接口地址或某个参数值里写 {image}，否则把参考图关掉',
    });
  }

  let url = fill(cp.url, enc);
  if (method === 'GET' && params.length) {
    const q = params.map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(fill(p.value, raw))}`).join('&');
    url += (url.includes('?') ? '&' : '?') + q;
  }

  const headers = {};
  if (cfg?.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  let body;
  if (method === 'POST') {
    const obj = {};
    for (const p of params) obj[p.key] = fill(p.value, raw);
    if (cp.bodyType === 'form') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(obj).toString();
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(obj);
    }
  }
  return { url, method, headers, body };
}

/**
 * 按 OpenAI 的响应形状取图值。
 *
 * 单独抽出来是因为 `findImage` 的「猜」必须**不认裸 base64**：
 * 有的服务会把整段提示词回显在 JSON 里，把任意长字符串当 base64 解，
 * 结果是拿一堆乱码当图片存下来。而 OpenAI 协议的 `b64_json` 是明确的字段名，
 * 认得它就没有猜的成分。
 */
export function openAiValue(j) {
  const list = Array.isArray(j?.data) ? j.data : [];
  const item = list.find((x) => x && typeof x === 'object') || {};
  if (typeof item.b64_json === 'string' && item.b64_json) return item.b64_json;
  if (typeof item.b64 === 'string' && item.b64) return item.b64;
  if (typeof item.url === 'string' && item.url) return item.url;
  if (Array.isArray(j?.images) && typeof j.images[0] === 'string') return j.images[0];
  if (typeof j?.image === 'string' && j.image) return j.image;
  return null;
}

/**
 * 接口给的「地址 / base64」变成 Buffer。
 *
 * 这里接受**裸 base64**（没有 `data:image/...;base64,` 前缀）：OpenAI 协议的
 * `b64_json` 就是裸的，不少自定义接口照抄这个形状。判据是「只有 base64 字母表
 * 里的字符且足够长」，解出来不是图片会在 `assertImage` 那一关被拦住并说清原因。
 */
async function valueToBuffer(v, { fetchImpl } = {}) {
  const s = String(v ?? '').trim();
  if (!s) throw new PaintError('生图接口没有返回图片');
  const data = decodeDataUrl(s);
  if (data) return data;
  if (/^https?:\/\//i.test(s)) return fetchImage(s, { fetchImpl });
  /**
   * 裸 base64：光看字符串像不像不够（提示词也可能全是字母），
   * 解出来必须带图片魔数才算数 —— 这条判据让「猜错」变成「报错」而不是「存个坏文件」。
   */
  if (/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(s)) {
    const buf = Buffer.from(s, 'base64');
    if (buf.length && sniffMime(buf)) return buf;
  }
  throw new PaintError('接口返回的既不是图片地址也不是图片', { hint: '检查「返回值路径」填的是不是图片字段' });
}

/** HTTP 失败 → 面向用户的错误（带上服务端那句话，它通常比状态码有用）。 */
function httpError(status, j, what) {
  const msg = j?.error?.message || j?.message || j?.msg || `HTTP ${status}`;
  const hint = status === 401 || status === 403
    ? '密钥不对或没权限：面板里重填 API Key'
    : status === 429
      ? '被限流或余额不足，等一会儿或换个接口'
      : status >= 500
        ? `${what}自己出错了，过几分钟再试`
        : '';
  return new PaintError(`${what}返回 ${status}：${String(msg).slice(0, 200)}`, { hint, status });
}

/** 响应体 → 图片 Buffer。有些服务直接回图片字节（pollinations 那类）。 */
async function bufferOfResponse(r, { fetchImpl, responsePath, pick } = {}) {
  const type = String(r.headers?.get?.('content-type') ?? '');
  if (type.startsWith('image/')) {
    if (!r.ok) throw httpError(r.status, null, '生图接口');
    return Buffer.from(await r.arrayBuffer());
  }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw httpError(r.status, j, '生图接口');
  if (!j) throw new PaintError('生图接口没有返回图片', { hint: '对方返回的不是 JSON，也不是图片' });
  /**
   * 三级取图：明确的路径 → 协议自带的取图规则 → 在 JSON 里猜一个像图片的地址。
   * 顺序不能反：猜出来的东西一旦碰巧是个 URL，就会去下载一个和这张画无关的文件。
   */
  const picked = (responsePath ? dotted(j, responsePath) : null) || (pick ? pick(j) : null) || findImage(j);
  if (!picked) {
    throw new PaintError('生图接口没有返回图片地址', {
      hint: '看看接口文档里图片在哪个字段，把路径填到「返回值路径」（如 data.0.url）',
    });
  }
  return valueToBuffer(picked, { fetchImpl });
}

/** 校验「拿到的东西真的是图片」——不然后面存盘、发图全线失败，报错还指不到源头。 */
function assertImage(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new PaintError('生图接口返回了空内容');
  if (!sniffMime(buf)) {
    throw new PaintError(`接口返回的不是图片（前 8 字节：${buf.subarray(0, 8).toString('hex')}）`, {
      hint: '多半是地址填成了网页或错误页；也可能是这个接口要求先登录',
    });
  }
  return buf;
}

/**
 * OpenAI 兼容接口。
 *
 * `response_format` / `image_size` 不是每家都认（官方 OpenAI 自己就不认
 * `image_size`）。被拒时把这一个键去掉重发：**被拒的请求没出图，重发不多花钱**。
 * 这也是这里唯一的重试——真正的重试交给备用链，那里换的是整条链路。
 */
async function viaOpenAI(cfg, prompt, image, { fetchImpl, timeoutMs }) {
  const url = endpointOf(cfg.baseUrl, image ? 'edit' : 'generate');
  const headers = {};
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  let body;
  let requestBody;
  if (image) {
    /** 图生图走 `/images/edits`：官方协议是 multipart，不是 JSON */
    const form = new FormData();
    form.append('image', new Blob([image], { type: sniffMime(image) || 'image/png' }), `reference.${(sniffMime(image) || 'image/png').split('/')[1]}`);
    for (const [k, v] of Object.entries({ prompt, model: cfg.model, size: cfg.size })) form.append(k, v);
    requestBody = form;
  } else {
    body = { model: cfg.model, prompt, size: cfg.size, n: 1, response_format: 'b64_json', image_size: cfg.size };
    headers['content-type'] = 'application/json';
  }

  const droppable = ['response_format', 'image_size'];
  for (let attempt = 0; ; attempt += 1) {
    let r;
    try {
      r = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: requestBody ?? JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new PaintError(`连不上生图服务：${e?.message ?? e}`, {
        hint: '检查服务地址是否可达（本地服务要先把 ComfyUI / SD WebUI 打开）',
        cause: e,
      });
    }
    if (r.ok) return assertImage(await bufferOfResponse(r, { fetchImpl, pick: openAiValue }));

    const j = await r.json().catch(() => null);
    const message = String(j?.error?.message || j?.message || '');
    const bad = attempt < droppable.length && r.status === 400 && !image
      ? droppable.find((k) => k in (body ?? {}) && message.includes(k))
      : undefined;
    if (!bad) throw httpError(r.status, j, '生图服务');
    delete body[bad];
  }
}

/** 自定义接口。 */
async function viaCustom(cfg, prompt, image, { fetchImpl, timeoutMs }) {
  const req = customRequest(cfg, prompt, image);
  let r;
  try {
    r = await fetchImpl(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new PaintError(`连不上自定义生图接口：${e?.message ?? e}`, {
      hint: '检查接口地址；本地服务要先把服务打开',
      cause: e,
    });
  }
  return assertImage(await bufferOfResponse(r, { fetchImpl, responsePath: cfg.custom?.responsePath }));
}

/**
 * 画一张。
 *
 * @param {object} cfg 见 `lib/config.mjs`
 * @param {string} prompt
 * @param {{image?:Buffer|null}} [opts] 参考图（图生图）
 * @returns {Promise<{buf:Buffer, via:string, ms:number}>}
 */
export async function generate({ cfg, prompt, image = null, fetchImpl, log = () => {}, timeoutMs = 180_000 }) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  const started = Date.now();
  const run = (one) => (one.provider === 'custom' || cfg.provider === 'custom'
    ? viaCustom({ ...cfg, ...one }, prompt, image, { fetchImpl: doFetch, timeoutMs })
    : viaOpenAI({ ...cfg, ...one }, prompt, image, { fetchImpl: doFetch, timeoutMs }));

  const main = { baseUrl: cfg.baseUrl, model: cfg.model };
  let first;
  try {
    const buf = await run(main);
    return { buf, via: '主接口', ms: Date.now() - started };
  } catch (e) {
    first = e;
    log(`主接口失败：${e?.message ?? e}`);
  }

  const failures = [`主接口：${first?.message ?? first}`];
  for (const [i, one] of (cfg.fallbacks ?? []).entries()) {
    const where = `备用 ${i + 1}（${one.baseUrl}）`;
    try {
      const buf = await run(one);
      log(`${where}成功`);
      return { buf, via: where, ms: Date.now() - started, failures };
    } catch (e) {
      log(`${where}失败：${e?.message ?? e}`);
      failures.push(`${where}：${e?.message ?? e}`);
    }
  }

  throw new PaintError(`没画出来。${failures.join('；')}`, {
    hint: cfg.fallbacks?.length
      ? '主接口和备用接口都失败了，检查密钥 / 余额 / 地址'
      : '面板里检查地址、密钥、模型名；也可以加一两个备用接口',
    status: first?.status ?? 0,
    cause: first,
  });
}

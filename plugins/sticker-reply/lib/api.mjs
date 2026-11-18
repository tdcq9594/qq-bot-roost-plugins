/**
 * `/v1` 客户端。凭据由宿主在启动 MCP 子进程时注入；页面动作那边通过
 * `setApiEnv()` 写进来，两者存在 globalThis 上共用一份。
 */

const ENV_KEY = Symbol.for('sticker-reply.api.env');

function store() {
  if (!globalThis[ENV_KEY]) globalThis[ENV_KEY] = { root: '', token: '' };
  return globalThis[ENV_KEY];
}

export function setApiEnv({ root = '', token = '' } = {}) {
  const s = store();
  s.root = String(root || '');
  s.token = String(token || '');
}

function cfg() {
  const s = store();
  const root = s.root || process.env.ROOST_API_URL || '';
  const token = s.token || process.env.ROOST_API_TOKEN || '';
  return { root: String(root).replace(/\/+$/, ''), token: String(token) };
}

export function apiReady() {
  const { root, token } = cfg();
  return Boolean(root && token);
}

export function apiWhy() {
  const { root, token } = cfg();
  if (!root) return '宿主没给 ROOST_API_URL';
  if (!token) return '宿主没给 ROOST_API_TOKEN';
  return '';
}

/** `ROOST_API_URL` 本身带 `/v1`，路径也带，去一层免得拼成 `/v1/v1/...` */
export function resolveUrl(root, path) {
  let base = String(root || '').replace(/\/+$/, '');
  if (/\/v1$/i.test(base)) base = base.slice(0, -3);
  const p = String(path || '').startsWith('/') ? String(path) : `/${path}`;
  return base + p;
}

export async function api(path, { method = 'GET', body = null, timeoutMs = 15_000 } = {}) {
  const { root, token } = cfg();
  if (!root || !token) throw new Error(`扩展与宿主的连接不可用：${apiWhy()}`);
  const init = {
    method,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== null) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(resolveUrl(root, path), init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok || data?.ok === false) {
    const err = new Error(`${path} 失败：${data?.message || data?.error || `HTTP ${res.status}`}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * 跑一次独立模型判断。
 *
 * 用 `/v1/agent.new` 起**不持久化**的临时会话，`prompt?wait=1` 拿完整回复，
 * `finally` 里一定关掉 —— 不关的话宿主那边会一直挂着会话。
 */
export async function runModel(prompt, { timeoutMs = 10_000 } = {}) {
  let sessionId = '';
  try {
    const created = await api('/v1/agent.new', { method: 'POST', body: { persist: false }, timeoutMs: 5_000 });
    sessionId = String(created?.sessionId || created?.id || '');
    if (!sessionId) throw new Error('宿主没返回 sessionId');
    const out = await api('/v1/agent.prompt?wait=1', {
      method: 'POST',
      body: { sessionId, text: prompt },
      timeoutMs,
    });
    return String(out?.text || '');
  } finally {
    if (sessionId) await api('/v1/agent.close', { method: 'POST', body: { sessionId }, timeoutMs: 5_000 }).catch(() => {});
  }
}

/**
 * /v1 客户端：扩展调宿主接口。
 *
 * 两处入口，环境变量的来源不同，所以**不能只在模块加载时读一次**：
 *   · MCP 子进程：`ROOST_API_URL` / `ROOST_API_TOKEN` 由 ext-launcher 注入到 process.env
 *   · 面板动作（inprocess）：宿主把 env 作为参数传给 `createActions`，不在 process.env 里
 * 所以用 `setApiEnv()` 覆盖，读取时现取。
 */

/**
 * 凭据存在 **globalThis** 上，不是模块局部变量。
 *
 * 踩过的坑：入口用 `./lib/api.mjs?v=<版本>` 引入，而 `analyze.mjs` 内部写的是
 * `./api.mjs`（没带查询串）——Node 当成两个模块，`setApiEnv()` 只设进了其中一个，
 * 于是「状态页显示连接正常，一点分析就报宿主没给 ROOST_API_URL」。
 *
 * 放到 globalThis 上，谁设的、谁读的都只有一份。
 */
const ENV_KEY = Symbol.for('persona-grow.api.env');

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
  if (!token) return '宿主没给 ROOST_API_TOKEN（扩展可能还没被授权）';
  return '';
}

/**
 * 调一个端点。
 * @param {string} path 形如 `/v1/journal?chatId=x`
 * @param {{method?:string, body?:object, timeoutMs?:number}} opt
 */
/**
 * 拼出真正的地址。
 *
 * `ROOST_API_URL` 是**带 `/v1` 的**（`http://127.0.0.1:17321/v1`），而代码里写的路径
 * 也带 `/v1`（照文档抄的）。直接拼会变成 `/v1/v1/journal` → 宿主回
 * 「没有这个 /v1 端点」，看起来像端点被删了，其实是我们自己拼错。
 *
 * 所以统一在这里去掉一层：base 去掉尾部的 `/v1`，path 保证以 `/v1` 开头。
 */
export function resolveUrl(root, path) {
  let base = String(root || '').replace(/\/+$/, '');
  if (/\/v1$/i.test(base)) base = base.slice(0, -3);
  const p = String(path || '').startsWith('/') ? String(path) : `/${path}`;
  return base + p;
}

export async function api(path, { method = 'GET', body = null, timeoutMs = 60_000 } = {}) {
  const { root, token } = cfg();
  if (!root || !token) throw new Error(`扩展与宿主的连接不可用：${apiWhy()}`);
  const url = resolveUrl(root, path);
  const init = {
    method,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== null) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok || data?.ok === false) {
    const why = data?.message || data?.error || `HTTP ${res.status}`;
    const err = new Error(`${path} 失败：${why}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

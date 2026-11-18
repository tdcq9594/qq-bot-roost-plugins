/**
 * /v1 客户端：扩展 → 宿主接口。
 *
 * 两处入口环境变量来源不同，所以**不能只在模块加载时读一次**：
 *   · MCP 子进程：`ROOST_API_URL` / `ROOST_API_TOKEN` 由 ext-launcher 注入
 *   · 面板动作（inprocess）：宿主把 env 作为参数传给 `createActions`
 *
 * 凭据存 globalThis：inprocess 侧和 MCP 侧可能拿到**不同 URL 的模块实例**
 * （一个带 `?v=` 一个不带），存模块局部变量会变成两份。
 *
 * ## 凭据轮换
 *
 * 宿主换发令牌后，进程内动作工厂是**按入口 mtime 缓存**的，不会重建；而动作
 * 里存的是创建那一刻的 token。所以每次请求前都要重新读一遍 env（宿主会原地
 * 更新它），并且遇到 401 时回落到 `secrets/<id>.json` 再试一次——那条路上
 * 读到的永远是宿主刚写下的最新令牌。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENV_KEY = Symbol.for('persona-scope.api.env');

function store() {
  if (!globalThis[ENV_KEY]) globalThis[ENV_KEY] = { root: '', token: '', extId: '', launcherDir: '', env: null };
  return globalThis[ENV_KEY];
}

/**
 * 记下 env **引用**（不是快照）：宿主每次动作前原地更新同一个对象，
 * 读取时现取 `env.ROOST_API_TOKEN` 才能拿到轮换后的值。
 */
export function setApiEnv(env = {}) {
  const s = store();
  if (env && typeof env === 'object') s.env = env;
  if (env?.ROOST_API_URL) s.root = String(env.ROOST_API_URL);
  if (env?.ROOST_API_TOKEN) s.token = String(env.ROOST_API_TOKEN);
  if (env?.ROOST_EXT_ID) s.extId = String(env.ROOST_EXT_ID);
  if (env?.ROOST_LAUNCHER_DIR) s.launcherDir = String(env.ROOST_LAUNCHER_DIR);
}

/** 现读：env 引用优先（宿主会原地更新），其次是创建时记下的值，最后是 process.env */
function cfg() {
  const s = store();
  const live = s.env || {};
  const root = live.ROOST_API_URL || s.root || process.env.ROOST_API_URL || '';
  const token = live.ROOST_API_TOKEN || s.token || process.env.ROOST_API_TOKEN || '';
  const extId = live.ROOST_EXT_ID || s.extId || process.env.ROOST_EXT_ID || '';
  const launcherDir = live.ROOST_LAUNCHER_DIR || s.launcherDir || process.env.ROOST_LAUNCHER_DIR || '';
  return {
    root: String(root).replace(/\/+$/, ''),
    token: String(token),
    extId: String(extId),
    launcherDir: String(launcherDir) || join(homedir(), '.dsh', 'dsh-roost'),
  };
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

/** 从 secrets 目录读最新令牌：轮换后 env 可能是旧的，这条路上永远是新的 */
/** 本扩展的 id：以 plugin.json 为准，环境变量只在没读到清单时才用 */
function ownExtId() {
  if (OWN_ID) return OWN_ID;
  try {
    const j = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));
    return String(j?.id || '');
  } catch { return ''; }
}

/**
 * 令牌轮换后从 secrets 里取新的。
 *
 * **必须校验 extId**：它来自环境变量，一旦被污染（或宿主换了注入方式），
 * 这里就会读到**别的扩展**的令牌——带着别人的权限去调宿主。
 * 所以只有 `ROOST_EXT_ID` 与本扩展 id 一致时才读。
 */
let OWN_ID = '';

export function setOwnExtId(id) { OWN_ID = String(id || '').trim(); }

function tokenFromSecrets() {
  const { launcherDir, extId } = cfg();
  if (!launcherDir || !extId) return '';
  const own = ownExtId();
  if (!own) return '';
  if (extId !== own) {
    try { process.stderr.write(`[persona-scope] 忽略不匹配的扩展 id：${extId}（本扩展是 ${own}）\n`); } catch { /* 忽略 */ }
    return '';
  }
  try {
    const j = JSON.parse(readFileSync(join(launcherDir, 'secrets', `${own}.json`), 'utf8'));
    return String(j?.token || '');
  } catch { return ''; }
}

async function once(method, path, body, token) {
  const { root } = cfg();
  const opt = {
    method,
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  };
  if (body !== undefined) {
    opt.headers['content-type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  return fetch(root + path, opt);
}

/**
 * 调一个 /v1 端点。失败一律 throw 带可读原因。
 *
 * 401 时用 secrets 里的新令牌重试一次：宿主轮换凭据后，缓存的动作不会重建，
 * 不重试的话用户看到的是「突然全部失败」，而重启 DSH 才好——没必要。
 */
export async function call(method, path, body) {
  const { root, token } = cfg();
  if (!root || !token) throw new Error(`扩展与宿主的连接不可用：${apiWhy()}`);

  let res = await once(method, path, body, token);
  if (res.status === 401) {
    const fresh = tokenFromSecrets();
    if (fresh && fresh !== token) {
      setApiEnv({ ROOST_API_TOKEN: fresh });
      res = await once(method, path, body, fresh);
    }
  }

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 时按文本报错 */ }
  if (!res.ok || json?.ok === false) {
    const why = json?.message || json?.error || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(`宿主拒绝了这次请求（HTTP ${res.status}）：${why}`);
  }
  return json ?? {};
}

export const get = (path) => call('GET', path);
export const post = (path, body) => call('POST', path, body ?? {});

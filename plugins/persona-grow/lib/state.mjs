/**
 * 成长状态（扩展自持）。
 *
 * 以前这份数据由宿主 `persona-growth.js` 读写；宿主 1.3.3 把整块功能删了
 * （`/v1/persona-growth` 端点也没了），于是数据成了孤儿。现在扩展自己接管，
 * **文件路径与结构保持兼容**，昨天攒下的采样能直接接着用。
 *
 * 与旧版的关键差异：
 *   · 采样不再靠宿主每轮回调，改成分析时按需从 `/v1/journal` 拉最近对话
 *   · 落地不再是「往系统提示塞一段」，而是写一份人格文件 + 切会话（见 land.mjs）
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const STATE_DIR = String(process.env.ROOST_LAUNCHER_DIR || join(homedir(), '.dsh', 'dsh-roost'));
export const STATE_FILE = join(STATE_DIR, 'persona-growth.json');

export const DEFAULTS = {
  enabled: true,
  threshold: 25,      // 攒够多少轮对话分析一次
  maxEntries: 12,     // 最多保留几条成长条目
  maxChars: 1600,     // 写进人格文件的成长段上限
};

/**
 * 会话键。
 *
 * 旧版是 `[botId, kind, chatId]`，botId 群聊时是外接协议地址（换端口就换一份）。
 * 新版本地跑，用 `kind + chatId` 更稳，但**要能读旧键**——所以读的时候两种都认。
 */
export function growthKey({ kind = 'group', chatId = '' } = {}) {
  return JSON.stringify(['', kind || 'group', String(chatId || '')]);
}

export function keyCandidates({ kind, chatId }) {
  return [growthKey({ kind, chatId })];
}

function blank() {
  return {
    personaId: '',
    generation: 0,
    paused: false,
    total: 0,
    period: 0,
    lastAt: 0,
    nextRetryAt: 0,
    lastAnalysisAt: 0,
    lastError: '',
    entries: [],
    samples: [],
    seen: [],
    log: [],
  };
}

/**
 * 状态缓存挂在 globalThis 上，并且**按文件 mtime 失效**。
 *
 * 两个理由：
 *   · 同一个进程里可能有两个模块实例（`?v=` 那份和不带的），各存一份缓存就会
 *     互相覆盖 —— 页面动作与 MCP 都是这两份的持有者；
 *   · MCP 是**独立子进程**，它在别处改了文件之后，这边必须重新读，否则会拿
 *     旧快照整份写回去，把对方的修改冲掉（真机上复现过「页面存了群 A，
 *     MCP 重置群 B 后群 A 的成长没了」）。
 */
const CACHE_KEY = Symbol.for('persona-grow.state');

function fileMtime() {
  try { return statSync(STATE_FILE).mtimeMs; } catch { return 0; }
}

export function load() {
  const slot = globalThis[CACHE_KEY] || (globalThis[CACHE_KEY] = { at: -1, db: null });
  const at = fileMtime();
  if (slot.db && slot.at === at) return slot.db;
  let db;
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    db = {
      version: Number(parsed?.version) || 1,
      records: parsed?.records && typeof parsed.records === 'object' ? parsed.records : {},
      settings: { ...DEFAULTS, ...(parsed?.settings || {}) },
    };
  } catch {
    db = { version: 2, records: {}, settings: { ...DEFAULTS } };
  }
  slot.db = db;
  slot.at = at;
  return db;
}

/**
 * 读-改-写期间独占。
 *
 * 跨进程靠一个锁文件（`openSync(..., 'wx')`），拿不到就等；超时抛错而不是硬写——
 * 写坏一份状态文件比操作失败更难查。
 */
const LOCK_FILE = `${STATE_FILE}.lock`;

export async function withLock(fn, { timeoutMs = 3000, waitMs = 25 } = {}) {
  const started = Date.now();
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync(LOCK_FILE, 'wx');
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      // 陈旧锁：持有者崩了没删。超过 10 秒就强拆
      try {
        if (Date.now() - statSync(LOCK_FILE).mtimeMs > 10_000) unlinkSync(LOCK_FILE);
      } catch { /* 别人刚好删了 */ }
      if (Date.now() - started > timeoutMs) throw new Error('状态文件被占用（另一个进程正在写），请稍后重试');
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  try {
    return await fn();
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
  }
}

export function save() {
  const cache = globalThis[CACHE_KEY]?.db;
  if (!cache) return;
  const dir = dirname(STATE_FILE);
  mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_FILE}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 1), 'utf8');
  renameSync(tmp, STATE_FILE);
  const slot = globalThis[CACHE_KEY];
  if (slot) { slot.db = cache; slot.at = fileMtime(); }
}

export function recordOf({ kind, chatId }, { create = false } = {}) {
  const db = load();
  const key = growthKey({ kind, chatId });
  let rec = db.records[key];

  /**
   * 旧键迁移。
   *
   * 旧版由宿主按 `[botId, kind, chatId]` 建键，群聊那条的 botId 是外接协议地址
   * （`http://127.0.0.1:6807`）。换端口就是另一份，而且我们现在跑在扩展里、
   * 拿不到那个地址。所以按 `kind + chatId` 扫一遍认领：
   * **只认唯一一条**，多条同时命中就放弃（宁可重来，也不要串错群的历史）。
   *
   * 注意「空记录」也要尝试认领：新键可能在「上一次调用顺手建了个空壳」之后就存在了
   * （`noteLog` 会 create），那时按"记录存在就跳过"会把旧数据永远晾在旧键上 ——
   * 表现就是界面一直显示 0 轮，而文件里明明有数据。
   */
  const isEmpty = (r) => !r || (!(r.entries || []).length && !r.total);
  if (isEmpty(rec)) {
    const hits = Object.keys(db.records).filter((k) => {
      if (k === key) return false;
      try {
        const arr = JSON.parse(k);
        return Array.isArray(arr) && arr.length === 3
          && String(arr[1]) === String(kind || 'group')
          && String(arr[2]) === String(chatId || '');
      } catch { return false; }
    });
    const donor = hits.map((k) => db.records[k]).find((r) => r && !isEmpty(r));
    if (hits.length === 1 || (hits.length > 1 && hits.filter((k) => !isEmpty(db.records[k])).length === 1)) {
      if (donor) {
        db.records[key] = donor;
        for (const k of hits) delete db.records[k];
        rec = donor;
        save();
      }
    }
  }

  if (!rec && create) {
    rec = blank();
    db.records[key] = rec;
  }
  return rec || null;
}

export function settings() {
  return { ...DEFAULTS, ...(load().settings || {}) };
}

export function resetRecord({ kind, chatId }, label = '重置成长') {
  const db = load();
  const key = growthKey({ kind, chatId });
  const old = db.records[key] || blank();
  const next = blank();
  next.generation = (old.generation || 0) + 1;
  next.log = [...(old.log || []), { at: Date.now(), text: label }].slice(-20);
  db.records[key] = next;
  save();
  return next;
}

/** 状态快照（给工具和面板用，字段与旧版保持一致，前端不用改） */
export function status({ kind, chatId }) {
  const s = settings();
  const rec = recordOf({ kind, chatId }) || blank();
  return {
    enabled: s.enabled,
    chatId,
    kind,
    personaId: rec.personaId || '',
    paused: rec.paused === true,
    total: rec.total || 0,
    period: rec.period || 0,
    threshold: s.threshold,
    remaining: Math.max(0, s.threshold - (rec.period || 0)),
    lastAnalysisAt: rec.lastAnalysisAt || 0,
    lastError: rec.lastError || '',
    generation: rec.generation || 0,
    entries: (rec.entries || []).map(({ category, text, maturity, evidence, at }) => ({
      category, text, maturity, evidence, at,
    })),
    log: (rec.log || []).slice(-8),
  };
}

/**
 * 合并一次分析的产出：按正文去重、超出条数丢掉最老的、成熟度取高的。
 */
export function mergeEntries({ kind, chatId }, incoming = []) {
  const rec = recordOf({ kind, chatId }, { create: true });
  const s = settings();
  const byText = new Map((rec.entries || []).map((e) => [String(e.text || ''), e]));
  for (const raw of incoming) {
    const text = String(raw?.text ?? '').trim().slice(0, 200);
    if (!text) continue;
    const prev = byText.get(text);
    const next = {
      category: String(raw?.category ?? '习惯').slice(0, 20),
      text,
      maturity: Math.min(5, Math.max(1, Number(raw?.maturity) || 1)),
      evidence: String(raw?.evidence ?? '').slice(0, 120),
      at: Date.now(),
    };
    byText.set(text, prev ? { ...prev, maturity: Math.max(prev.maturity || 1, next.maturity), at: next.at } : next);
  }
  let list = [...byText.values()].sort((a, b) => (b.maturity || 0) - (a.maturity || 0));
  if (list.length > s.maxEntries) list = list.slice(0, s.maxEntries);
  rec.entries = list;
  rec.lastAnalysisAt = Date.now();
  rec.period = 0;
  save();
  return list;
}

/** 记住这个会话的基底人格（下次 land 用它当起点，而不是全局当前人格） */
export function setBase({ kind, chatId }, baseId) {
  const rec = recordOf({ kind, chatId }, { create: true });
  rec.baseId = String(baseId || '').slice(0, 200);
  save();
  return rec.baseId;
}

/** 这个会话记住的基底人格（没有就空） */
export function setBaseHash({ kind, chatId }, hash) {
  const rec = recordOf({ kind, chatId }, { create: true });
  rec.baseHash = String(hash || '').slice(0, 40);
  save();
  return rec.baseHash;
}

export function baseHashOf({ kind, chatId }) {
  const rec = recordOf({ kind, chatId });
  return String(rec?.baseHash || '');
}

export function baseOf({ kind, chatId }) {
  const rec = recordOf({ kind, chatId });
  return String(rec?.baseId || '');
}

export function noteLog({ kind, chatId }, text) {
  const rec = recordOf({ kind, chatId }, { create: true });
  rec.log = [...(rec.log || []), { at: Date.now(), text: String(text).slice(0, 200) }].slice(-20);
  save();
}

export function noteError({ kind, chatId }, message) {
  const rec = recordOf({ kind, chatId }, { create: true });
  rec.lastError = String(message ?? '').slice(0, 300);
  save();
}

/** 把成长条目渲染成一段人格文本（写进人格文件用） */
export function renderGrowth(entries = [], maxChars = 1600) {
  if (!entries.length) return '';
  const lines = entries.map((e) => `- 【${e.category || '习惯'}】${e.text}`);
  const head = '## 慢慢长出来的习惯\n（这些不是设定，是在真实对话里一点点形成的；**与原人格冲突时，以原人格为准**）\n';
  let out = head + lines.join('\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 8)}…（略）`;
  return out;
}

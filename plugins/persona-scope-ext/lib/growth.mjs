/**
 * 与人设增长扩展（`persona-grow`）的适配。
 *
 * ## 两者不冲突，但会「覆盖」
 *
 * | 扩展 | 写哪一层 | 优先级 |
 * |---|---|---|
 * | persona-grow（成长） | `persona.byChat[群]` | 低 |
 * | 本扩展（专属人设） | `persona.bySender[人]` | **高** |
 *
 * 宿主的解析顺序是 `bySender > byChat > current`。所以某人被绑定专属人格后，
 * 那个群的成长人格对他不生效；其他人照常。
 *
 * ## 为什么不能只看 `personaId`
 *
 * persona-grow 0.5.0 起，成长**落地**时会写 `baseId` / `baseHash` 并切会话，
 * 但记录里的 `personaId` **保持为空**（它不再是「派生人格 id」的持有者）。
 * 只看 `personaId` 会把已经生效的成长判成「没有成长」，于是提示漏报。
 *
 * 所以生效判定按三级回落：
 *   1. 记录里的 `personaId`（老版本）
 *   2. 宿主 `byChat[chatId]`（运行时真相，最可靠）
 *   3. 记录里的 `baseId`（0.5.0：说明它确实落地过）
 *
 * 只读、容错：对方的文件坏了返回 `error`，绝不影响本扩展。
 */

import {
  readFileSync, existsSync, copyFileSync, writeFileSync, renameSync, mkdirSync,
  openSync, closeSync, unlinkSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname as dirOf } from 'node:path';

const GROWTH_FILE = () =>
  join(String(process.env.ROOST_LAUNCHER_DIR || join(homedir(), '.dsh', 'dsh-roost')), 'persona-growth.json');

/** 成长状态里 `records` 的键是 `JSON.stringify([botId, kind, chatId])` */
function parseKey(k) {
  try {
    const arr = JSON.parse(k);
    return Array.isArray(arr) ? { botId: arr[0] || '', kind: arr[1] || '', chatId: arr[2] || '' } : null;
  } catch { return null; }
}

/**
 * 读成长扩展的现状。
 *
 * @param {object} byChat 宿主的「按群」人格映射（`persona.byChat`），用来确认运行时真相
 */
/** 这份人格是不是成长扩展生成的：标签或名字都对得上才算 */
export function isGrowthPersona(p = {}) {
  const tags = Array.isArray(p.tags) ? p.tags.map((x) => String(x)) : [];
  if (tags.includes('growth') || tags.includes('auto')) return true;
  const text = `${p.label || ''}${p.name || ''}${p.id || ''}`;
  return /（成长）|\(成长\)/.test(text);
}

/**
 * @param {object} byChat   宿主「按群」人格（运行时真相）
 * @param {Array}  personas 宿主人格清单（要 tags/label 才能认出成长人格）
 */
export function growthSnapshot(byChat = {}, personas = []) {
  const file = GROWTH_FILE();
  if (!existsSync(file)) return { installed: false, file, chats: [] };

  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const chats = Object.entries(j?.records || {}).map(([k, v]) => {
      const meta = parseKey(k) || {};
      const chatId = meta.chatId || '';
      const rec = v && typeof v === 'object' ? v : {};
      const rawEntries = Array.isArray(rec.entries) ? rec.entries : [];
      const entries = rawEntries.length;
      const samples = Array.isArray(rec.samples) ? rec.samples.length : 0;
      const inChat = String(byChat?.[chatId] || '');
      const baseId = String(rec.baseId || '');
      /**
       * 生效人格的三级回落。`inChat` 最可靠：那是宿主此刻真的在用的人格。
       * `baseId` 兜 0.5.0 那种「personaId 空着但确实落地过」的记录。
       */
      /**
       * 生效人格只认两处：宿主此刻用的（`byChat`），或记录里自报的 `personaId`。
       * **不再用 `baseId` 兜底** —— 那只是「落地过」的痕迹，不代表现在还在用；
       * 用户切回普通人格后它仍然存在，用它兜底就是误报的来源。
       */
      const personaId = inChat || String(rec.personaId || '');
      /** 这个 id 是不是成长人格：查清单，查不到就不认 */
      const row = (Array.isArray(personas) ? personas : []).find((x) => x && x.id === personaId);
      const grown = Boolean(personaId) && Boolean(row) && isGrowthPersona(row);
      return {
        chatId,
        kind: meta.kind || '',
        personaId,
        baseId,
        entries,
        rawEntries,
        samples,
        lastAnalysisAt: Number(rec.lastAnalysisAt) || 0,
        paused: rec.paused === true,
        /** 采样过（不代表已落地）：只用来展示，不参与「是否生效」判定 */
        sampled: samples > 0,
        /** 是否**正在**用成长人格：宿主此刻的人格必须真的是一份成长人格 */
        grown,
      };
    }).filter((r) => r.chatId);
    /** 有可用成长条目的群：页面「叠加成长」列表用它，和「当前正在用成长人格」不是一回事 */
    const pickable = chats.filter((c) => (c.entries || 0) > 0);
    return { installed: true, file, chats, pickable };
  } catch (e) {
    return { installed: true, file, chats: [], error: `成长状态读不出来：${e?.message ?? e}` };
  }
}

/**
 * 把「按人绑定」和「成长人格」放一起算影响面。
 *
 * 生效判据：**没暂停、且有成长迹象**（条目或采样）。不再强制要求 `personaId` 非空——
 * 那正是 0.5.0 漏报的原因。
 *
 * @param {object} bySender 本扩展的按人绑定（openid → 人格 id）
 * @param {object} growth   growthSnapshot() 的结果
 * @param {object} byChat   宿主的按群人格映射
 */
export function growthConflicts(bySender = {}, growth = {}, byChat = {}) {
  const chats = Array.isArray(growth.chats) ? growth.chats : [];
  const active = chats.filter((c) => !c.paused && c.grown);
  const bound = Object.keys(bySender || {});
  if (!active.length || !bound.length) {
    return { active, shadowed: [], note: '' };
  }
  /**
   * 精确到「哪个绑定者被哪个群的成长人格盖住」做不到：成长按群、绑定按人，
   * 宿主配置里没有「这个人常在哪几个群」的映射。所以只给**全局提示**，
   * 不编造对应关系。
   */
  const usingGrowth = active.filter((c) => String(byChat?.[c.chatId] || c.personaId || '')).length;
  return {
    active,
    shadowed: bound,
    note: `有 ${active.length} 个群在长养成${usingGrowth ? `（其中 ${usingGrowth} 个已切到成长人格）` : ''}；`
      + `被绑定的 ${bound.length} 个人在这些群里会使用专属人设（按人优先级高于按群）。`
      + '要让成长人格对他们生效，解绑即可。',
  };
}

/**
 * 把某个群的成长条目渲染成一段正文。
 *
 * 格式**照抄** persona-grow 的 `renderGrowth()`（同样的标题与条目样式），
 * 这样用户在两处看到的是同一种东西；也方便把两边的输出直接对照。
 *
 * 为什么必须指定群：成长是按群的（`persona.byChat`），把 A 群的习惯拼进 B 群的
 * 人设里等于串味。所以这里只读**指定的那一个群**，读不到就返回空串。
 */
export function growthBlockOf(chatId, { maxChars = 1600 } = {}) {
  const want = String(chatId || '').trim();
  if (!want) return { text: '', chatId: '', entries: 0 };
  const snap = growthSnapshot({}, []);
  const row = (snap.chats || []).find((c) => c.chatId === want || String(c.chatId).endsWith(want));
  if (!row) return { text: '', chatId: want, entries: 0, reason: '这个群还没有成长记录' };

  const entries = (row.rawEntries || []);
  if (!entries.length) return { text: '', chatId: want, entries: 0, reason: '这个群还没长出条目（只有采样）' };

  const lines = entries.map((e) => `- 【${e.category || '习惯'}】${e.text}`);
  const head = '## 慢慢长出来的习惯\n（这些不是设定，是在真实对话里一点点形成的；**与原人格冲突时，以原人格为准**）\n';
  let out = head + lines.join('\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 8)}…（略）`;
  return { text: out, chatId: want, entries: entries.length };
}

/** persona-grow 的锁文件（同一把锁，跨进程互斥） */
const growthLockFile = () => `${GROWTH_FILE()}.lock`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 拿 persona-grow 自己那把锁（`<state>.lock`，`openSync('wx')`）。
 * 用同一把锁才叫「遵循它的协议」——各锁各的等于没锁。
 */
async function withGrowthLock(fn, { timeoutMs = 3000 } = {}) {
  const file = growthLockFile();
  mkdirSync(dirOf(file), { recursive: true });
  const started = Date.now();
  let fd = null;
  for (;;) {
    try {
      fd = openSync(file, 'wx');
      break;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(file).mtimeMs > 10_000) unlinkSync(file);
      } catch { /* 刚好被别人删了 */ }
      if (Date.now() - started > timeoutMs) {
        throw Object.assign(new Error('成长状态文件正被占用（persona-grow 正在写），请稍后重试'), { code: 'GROWTH_LOCKED' });
      }
      await sleep(25);
    }
  }
  try {
    return await fn();
  } finally {
    try { closeSync(fd); } catch { /* 已关 */ }
    try { unlinkSync(file); } catch { /* 已被接管 */ }
  }
}

const CHAT_ID_RE = /^[0-9A-Fa-f]{32}$/;

/**
 * 清除某个群的成长。
 *
 * 三条硬约束（都是验证报告打出来的）：
 *  1. **精确匹配**：只接受完整 32 位群 openid。以前用 `endsWith`，传 `"1"` 会把
 *     所有以 1 结尾的群一起清掉。
 *  2. **同一把锁**：和 persona-grow 共用 `<state>.lock`，它正在写时我们等，
 *     不然两边同时读改写会丢更新。
 *  3. **代际 +1**：清除前已经启动的分析，靠 `generation` 比对判废弃
 *     （persona-grow 的 `isStale()`）；不加代际，旧结果还能写回来。
 */
export async function clearGrowth(chatId) {
  const want = String(chatId || '').trim();
  if (!CHAT_ID_RE.test(want)) {
    throw Object.assign(
      new Error(`群 id 必须是完整的 32 位 openid（收到「${want.slice(0, 20)}」）——不做前缀或后缀匹配`),
      { code: 'BAD_CHAT_ID' },
    );
  }
  const file = GROWTH_FILE();
  if (!existsSync(file)) throw new Error('还没有成长数据（persona-grow 没装或还没长过）');

  return withGrowthLock(async () => {
    let raw;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`成长文件损坏，不能清（请先修好它）：${e?.message ?? e}`);
    }

    const records = raw?.records && typeof raw.records === 'object' ? raw.records : {};
    const hits = [];
    for (const [k, v] of Object.entries(records)) {
      const meta = parseKey(k) || {};
      if (String(meta.chatId || '') !== want) continue; // 精确匹配
      const rec = v && typeof v === 'object' ? v : {};
      const had = Array.isArray(rec.entries) ? rec.entries.length : 0;
      hits.push({ key: k, cleared: had });
      records[k] = {
        ...rec,
        /** 代际 +1：让「清除前启动、之后才返回」的分析结果作废 */
        generation: (Number(rec.generation) || 0) + 1,
        entries: [],
        samples: [],
        seen: [],
        total: 0,
        period: 0,
        lastAnalysisAt: 0,
        lastError: '',
        log: [...(Array.isArray(rec.log) ? rec.log.slice(-8) : []), { at: Date.now(), note: '由专属人设扩展清除' }],
      };
    }

    if (!hits.length) return { ok: true, chatId: want, cleared: 0, note: '这个群没有成长记录' };

    const backup = `${file}.bak-${Date.now()}`;
    try { copyFileSync(file, backup); } catch { /* 备份失败不阻塞 */ }
    const next = { ...raw, records };
    const tmp = `${file}.${Date.now()}.tmp`;
    mkdirSync(dirOf(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(next, null, 1), 'utf8');
    renameSync(tmp, file);

    const cleared = hits.reduce((n, h) => n + h.cleared, 0);
    return { ok: true, chatId: want, cleared, backup, note: `已清除该群成长（${cleared} 条），备份：${backup}` };
  });
}

/**
 * 成长引擎：页面动作与 MCP 工具共用这一份编排。
 *
 * 两边各写一遍的话，修正只会落到一边（`analyzeAuto` 那次就是这么漏的）。
 * 入口只负责「翻译参数」，判定与写入都在这里。
 *
 * 这里管的安全约束：
 *   · 预览（commit:false）不写任何状态
 *   · 分析期间被重置 → 结果作废（代际守卫）
 *   · 证据必须是**对话里真出现过**的片段；想改身份的提议拒收
 *   · 写操作只针对**当前活跃会话**，不接受外部随手传来的 chatId
 *   · 同一会话同时只跑一次分析（防止重复点击重复烧额度）
 *   · 进度按真实对话条数算，不再是个假进度
 */

import { analyzeAuto, fetchRecent, latestGroup, listGroupsNamed } from './analyze.mjs';
import { land, revert } from './land.mjs';
import {
  baseHashOf, baseOf, mergeEntries, noteError, noteLog, recordOf, resetRecord, setBase, setBaseHash, settings, status, withLock,
} from './state.mjs';

/** 想改身份 / 想盖掉原人格的措辞：一律拒收 */
const IDENTITY_PATTERNS = [
  /自称/, /我的名字/, /改名叫/, /叫作/, /你就是/, /从现在起你(是|叫)/,
  /忽略(之前|以上|原)/, /无视(之前|以上|原)/, /覆盖(原)?人格/, /取代(原)?人格/,
  /以本段为准/, /优先于(原)?人格/, /你不是/,
];

/** 这些分类可以留，其它一律归到「习惯」 */
const CATEGORIES = new Set(['口吻', '称呼', '习惯', '偏好', '情绪']);

/**
 * 把模型给的条目过滤一遍。**纯函数**，方便单测。
 *
 * @param {Array} entries 模型返回的原始条目
 * @param {Array} rows 本次分析用的对话（用来验证证据真实存在）
 */
export function sanitizeEntries(entries, rows = []) {
  const said = rows.map((r) => String(r?.text ?? '')).join('\n');
  const out = [];
  const dropped = [];

  for (const raw of Array.isArray(entries) ? entries : []) {
    const text = String(raw?.text ?? '').trim().slice(0, 120);
    if (!text) continue;

    if (IDENTITY_PATTERNS.some((re) => re.test(text))) {
      dropped.push({ text, why: '想改身份或盖掉原人格' });
      continue;
    }

    // 证据必须是真实出现过的片段；太短（<3 字）说明不了什么，直接丢
    const ev = String(raw?.evidence ?? '').trim().slice(0, 40);
    if (!ev || ev.length < 3 || !said.includes(ev)) {
      dropped.push({ text, why: ev ? '证据在对话里找不到' : '没有证据' });
      continue;
    }

    const category = CATEGORIES.has(String(raw?.category ?? '')) ? raw.category : '习惯';
    const maturity = Math.min(5, Math.max(1, Number(raw?.maturity) || 1));
    out.push({ category, text, maturity, evidence: ev });
  }
  return { entries: out, dropped };
}

/**
 * 自动进度的口径：**按真实对话条数**算。
 *
 * 不叫「自动分析」是因为宿主没有每轮钩子，扩展拿不到逐轮回调 —— 分析必须有人触发。
 * 这里只是把「攒够多少条值得分析一次」如实算出来给人看。
 */
export function progressOf(rows = [], threshold = 25) {
  const period = rows.length;
  return { period, threshold, remaining: Math.max(0, threshold - period), ready: period >= threshold };
}

/** 代际守卫的判据：分析开始后被重置过，本次结果就不能写回 */
export function isStale(gen0, rec) {
  return Number(rec?.generation ?? 0) !== Number(gen0 ?? 0);
}

const targetOf = (chatId) => ({ chatId: String(chatId || ''), kind: 'group' });

/** 同一会话同时只跑一次分析 */
const running = new Set();

/**
 * 写操作用哪个会话：**只认「当前活跃」**。
 *
 * MCP 工具是模型在真实对话里调的，它把 chatId 写成别的群就能改别人的成长。
 * 这一层拿不到「本轮是否 @ 过」，所以退一步：写操作一律落在最近活跃的会话，
 * 传进来的 chatId 只有当它**就是**最近活跃那个时才被接受。
 */
export function resolveWritableTarget(asked = '') {
  const g = latestGroup();
  if (!g) throw new Error('没有可用的会话：最近没有任何群消息');
  const want = String(asked || '').trim();
  if (want && want !== g.chatId) {
    throw new Error(`只允许操作当前活跃会话（${g.chatId.slice(0, 8)}…），拒绝操作 ${want.slice(0, 8)}…`);
  }
  return { ...targetOf(g.chatId), name: g.name };
}

/** 读操作：给了就用给的，没给就回落到活跃会话 */
function resolveReadTarget(chatId = '') {
  const want = String(chatId || '').trim();
  if (want) return targetOf(want);
  return resolveWritableTarget('');
}

/** 状态 + 真实进度（只读，不写盘） */
export async function statusOf({ chatId = '' } = {}) {
  const t = resolveReadTarget(chatId);
  const s = settings();
  const base = status(t);

  let rows = [];
  try {
    rows = await fetchRecent(t.chatId, 60);
  } catch { /* 读不到就按 0 算 */ }

  const prog = progressOf(rows, s.threshold);
  return {
    ...base,
    baseId: baseOf(t),
    enabled: s.enabled,
    paused: Boolean(recordOf(t)?.paused),
    auto: prog,
    threshold: s.threshold,
    period: prog.period,
    remaining: prog.remaining,
  };
}

/**
 * 分析一次。
 *
 * @param {{chatId?:string, commit?:boolean}} opt
 *   commit=false 时**只返回提案，不写任何状态**（"预览"语义）
 */
export async function growNow({ chatId = '', commit = true } = {}) {
  const s = settings();
  if (!s.enabled) throw new Error('成长功能已关闭（persona-growth.json 的 settings.enabled=false）');

  const t = commit ? resolveWritableTarget(chatId) : resolveReadTarget(chatId);
  if (Boolean(recordOf(t)?.paused)) throw new Error('这个会话的成长已暂停，先恢复再分析');

  /**
   * 同一个会话同时只允许一次分析。
   *
   * 面板动作有 30 秒上限，模型慢的时候用户会以为没反应再点一次 ——
   * 两次分析各烧一次额度，还会互相覆盖条目。
   */
  if (running.has(t.chatId)) throw new Error('这个会话正在分析中，等它完成再点');
  running.add(t.chatId);
  try {
    return await growInner({ t, commit });
  } finally {
    running.delete(t.chatId);
  }
}

async function growInner({ t, commit }) {
  const rec0 = recordOf(t);
  const gen0 = rec0?.generation ?? 0;
  const hadEntries = (rec0?.entries || []).length > 0;

  noteLog(t, commit ? '触发分析' : '触发预览（不写入）');

  const out = await analyzeAuto({ chatId: t.chatId, existing: rec0?.entries || [] });
  if (out.skipped) return { ok: true, skipped: out.skipped, target: t, mode: out.mode };

  const clean = sanitizeEntries(out.entries, out.rowsData || []);

  if (commit) {
    let discarded = false;
    await withLock(async () => {
      const rec = recordOf(t) || {};
      /**
       * 代际守卫：分析是异步的（要调模型），期间用户可能点了重置。
       * 不判这一下，旧分析完成时会把条目写回去，还顺手把会话切回成长人格。
       */
      if (isStale(gen0, rec)) { discarded = true; return; }
      if (clean.entries.length) mergeEntries(t, clean.entries);
    });
    if (discarded) throw new Error('分析期间成长被重置，本次结果已丢弃');
  }

  const after = status(t);
  const result = {
    ok: true,
    mode: out.mode,
    added: commit ? clean.entries.length : 0,
    proposed: clean.entries.length,
    dropped: clean.dropped,
    entries: after.entries,
    target: t,
  };

  if (!commit) return { ...result, preview: true };

  /**
   * 没有新增也要接回已有成长。
   *
   * 场景：用户切回原人格（临时停用）后点了分析，这次却没提炼出新东西 ——
   * 不重新落地的话，会话就永远停在原人格上，界面上却显示「有条目」。
   */
  if (clean.entries.length || hadEntries) {
    const landed = await land({
      chatId: t.chatId,
      kind: t.kind,
      entries: after.entries,
      stateBase: baseOf(t),
      stateBaseHash: baseHashOf(t),
    });
    setBase(t, landed.baseId);
    setBaseHash(t, landed.baseHash);
    noteLog(t, `已切换人格 → ${landed.personaId}`);
    return { ...result, committed: true, personaId: landed.personaId, baseId: landed.baseId, rebased: landed.rebased };
  }

  return { ...result, committed: false, note: '这次没有足够证据，未新增条目' };
}

/** 清空并切回原人格 */
export async function resetChat({ chatId = '' } = {}) {
  const t = resolveWritableTarget(chatId);
  const rec = await withLock(async () => resetRecord(t, '重置成长'));
  try {
    const r = await revert({ chatId: t.chatId, stateBase: baseOf(t) });
    return { ok: true, generation: rec.generation, personaId: r.personaId, target: t };
  } catch (e) {
    noteError(t, e?.message ?? String(e));
    return { ok: false, message: `成长已清空，但切回原人格失败：${e?.message ?? e}`, generation: rec.generation };
  }
}

export { listGroupsNamed };

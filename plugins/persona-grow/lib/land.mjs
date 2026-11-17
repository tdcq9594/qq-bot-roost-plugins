/**
 * 落地：把成长结果变成**能看见、能手动调、能一键还原**的东西。
 *
 * 旧版是把成长段塞进系统提示（宿主内部 order 906）。宿主删掉那块之后，
 * 我们改成写一份**派生人格文件**再把这个会话切过去：
 *
 *   基人格（人的原始设定）
 *     └─ + 成长段 → 另存为 `<基人格>-grow-<会话指纹>`
 *                    └─ session.configure 切过去
 *
 * 好处：面板上看得见、能直接编辑、删掉就还原；而且**永远不碰基人格文件**，
 * 用户手写的设定不会被程序覆盖。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { api } from './api.mjs';
import { renderGrowth, settings } from './state.mjs';

const STATE_DIR = String(process.env.ROOST_LAUNCHER_DIR || join(homedir(), '.dsh', 'dsh-roost'));

/**
 * 人格索引：**走 /v1/personas**，不读宿主私有 config.json。
 *
 * 以前直接 `readFileSync(config.json)` 取 `persona.current` / `persona.byChat`：
 * 那是宿主的私有文件格式，字段一改这边就断，而且面板那边还有 `bySender`
 * 这类更高的优先级层我们看不到。`GET /v1/personas` 已经把
 * `current` / `byChat` / `bySender` / `effective` 一起返回了。
 *
 * 缓存 5 秒：一次落地里会连着算 base / derived，不必每次都打接口。
 */
let personaIndex = null;

export async function refreshPersonaIndex({ force = false } = {}) {
  if (!force && personaIndex && Date.now() - personaIndex.at < 5000) return personaIndex;
  const r = await api('/v1/personas');
  personaIndex = {
    current: String(r?.current || '').trim(),
    byChat: r?.byChat && typeof r.byChat === 'object' ? r.byChat : {},
    bySender: r?.bySender && typeof r.bySender === 'object' ? r.bySender : {},
    at: Date.now(),
  };
  return personaIndex;
}

/** 测试注入用；线上由 refreshPersonaIndex 填 */
export function __setPersonaIndex(idx) {
  personaIndex = idx ? { current: '', byChat: {}, bySender: {}, at: Date.now(), ...idx } : null;
}

function idxOf() {
  return personaIndex || { current: '', byChat: {}, bySender: {} };
}

/** 当前全局人格 id */
export function currentPersonaId() {
  return String(idxOf().current || '').trim();
}

/** 这个会话在面板里被指定的人格（没有就空） */
export function chatPersonaId(chatId) {
  return String(idxOf().byChat?.[chatId] || '').trim();
}

const DERIVED_RE = /-grow-[0-9a-f]{6}$/;

/**
 * 这一轮该拿哪份人格当**基底**。
 *
 * 三个来源按优先级：会话指定 > 全局当前 > 状态里记的原始基底。
 *
 * 关键是「会话指定」：用户在面板里把群切到 `genki` 之后，如果我们还按全局
 * `llmm` 重建，就会把群**悄悄切回** `llmm-grow-*`，用户的选择被覆盖掉。
 * 而如果切到的正是我们自己派生出来的（`xxx-grow-ab12cd`），要剥回原始基底，
 * 否则会滚成 `llmm-grow-ab12cd-grow-ab12cd`。
 */
export function resolveBase({ chatId = '', stateBase = '' } = {}) {
  const picked = chatPersonaId(chatId);
  if (picked && !DERIVED_RE.test(picked)) return picked;
  if (picked && DERIVED_RE.test(picked)) {
    return String(stateBase || '').trim() || picked.replace(DERIVED_RE, '');
  }
  const global = currentPersonaId();
  if (global && !DERIVED_RE.test(global)) return global;
  return String(stateBase || '').trim() || global.replace(DERIVED_RE, '');
}


/**
 * 这个会话是不是**已经切回原人格**了。
 *
 * 用途：把「在面板里切回原人格」解释成「放弃成长」。
 * 判据要严——只在「当前生效的人格 == 我们记录过的基底」时才算，
 * 用户换到第三个人格（genki）不算放弃，那是换底座，下次分析会以 genki 重建。
 */
export function isAbandoned({ chatId = '', stateBase = '' } = {}) {
  const base = String(stateBase || '').trim();
  if (!base) return false;
  const now = chatPersonaId(chatId) || currentPersonaId();
  if (!now) return false;
  if (DERIVED_RE.test(now)) return false;   // 还挂在派生人格上，没放弃
  return now === base;
}

/** 成长段的标题（用来定位替换区间） */
export const GROWTH_HEAD = '## 慢慢长出来的习惯';

/**
 * 只替换成长段，**保留用户在别处的手改**。
 *
 * 以前是无条件 `base + 新成长段` 覆盖整份文件：用户在面板里给派生人格补两句
 * 设定，下一次分析就全被抹掉——这正是「手动改过的东西被程序吃掉」那类问题。
 *
 * 规则：找到成长段标题 → 替换到**下一个二级标题之前**（没有就替换到结尾）；
 * 找不到标题就追加在末尾。
 */
export function mergeGrowth(existing, block) {
  const text = String(existing || '');
  const next = String(block || '').trim();
  if (!next) return text;
  const start = text.indexOf(GROWTH_HEAD);
  if (start < 0) return `${text.trimEnd()}\n\n${next}\n`;

  const afterHead = text.slice(start + GROWTH_HEAD.length);
  const rel = afterHead.search(/\n## (?!慢慢长出来的习惯)/);
  const end = rel >= 0 ? start + GROWTH_HEAD.length + rel : text.length;
  return `${text.slice(0, start)}${next}${text.slice(end)}`;
}

/** 派生人格 id：同一会话始终同一个，方便幂等覆盖 */
export function derivedIdOf(baseId, chatId) {
  const fp = createHash('sha1').update(String(chatId)).digest('hex').slice(0, 6);
  return `${baseId}-grow-${fp}`;
}

export async function readBase(baseId) {
  const r = await api(`/v1/personas/read?id=${encodeURIComponent(baseId)}`);
  return String(r?.raw ?? r?.text ?? '');
}

/**
 * 写派生人格并切过去。
 *
 * @returns {{personaId:string, chars:number, switched:boolean}}
 */
export async function land({ chatId, kind = 'group', baseId = '', entries = [], stateBase = '', stateBaseHash = '' }) {
  await refreshPersonaIndex().catch(() => {});
  const base = String(baseId || resolveBase({ chatId, stateBase }) || '').trim();
  if (!base) throw new Error('读不到基底人格 id（面板里没设，config.json 的 persona.current 也是空）');

  const s = settings();
  const growth = renderGrowth(entries, s.maxChars);
  if (!growth) throw new Error('还没有成长条目，先分析一次');

  const id = derivedIdOf(base, chatId);

  /**
   * 基底文本：优先拿**上一轮我们已经派生出来的那份**，再在其上只替换成长段。
   *
   * 直接拿基底文件重拼的话，用户在面板里给派生人格补的内容会被整份覆盖。
   * 派生文件不存在（第一次、或被删了）才回到基底本体。
   */
  const baseText = await readBase(base);

  /**
   * 基底更新要传播：记下基底的指纹，变了就**以新基底重建**。
   *
   * 不这么做的话，用户后来改了原人格文件，派生人格里还留着旧版本 ——
   * 界面上看着"人格更新了"，实际这个群用的还是老设定。
   */
  const hash = createHash('sha1').update(baseText).digest('hex').slice(0, 12);
  const prevHash = String(stateBaseHash || '');
  const baseChanged = Boolean(prevHash) && prevHash !== hash;

  let existing = '';
  if (!baseChanged) {
    try { existing = await readBase(id); } catch { existing = ''; }
  }
  const source = (existing.trim() && !baseChanged) ? existing : baseText;
  const raw = mergeGrowth(source, growth);

  await api('/v1/personas/create', {
    method: 'POST',
    body: { id, raw, overwrite: true, label: `${base}（成长）`, tags: ['auto', 'growth'] },
  });

  try {
    await api('/v1/session.configure', { method: 'POST', body: { chatId, persona: id } });
  } catch (e) {
    // 人格写成功了但没切过去：如实报，别假装成功
    throw new Error(`人格已写入「${id}」，但切换会话失败：${e?.message ?? e}`);
  }

  return { personaId: id, baseId: base, baseHash: hash, chars: raw.length, switched: true, kind, baseChanged, merged: Boolean(existing.trim()), rebased: baseChanged };
}

/** 还原：把这个会话切回基人格（派生文件保留，方便下轮覆盖） */
export async function revert({ chatId, baseId = '', stateBase = '' }) {
  await refreshPersonaIndex().catch(() => {});
  const base = String(baseId || resolveBase({ chatId, stateBase }) || '').trim();
  if (!base) throw new Error('读不到基底人格 id');
  await api('/v1/session.configure', { method: 'POST', body: { chatId, persona: base } });
  return { personaId: base };
}

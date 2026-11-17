/**
 * 分析一次：拉最近对话 → 让模型提炼「慢慢形成的习惯」→ 返回条目。
 *
 * 模型调用走 `/v1/agent.new` + `/v1/agent.prompt?wait=1` + `/v1/agent.close`。
 * 用**独立干净会话**是刻意的：成长分析不该带进 QQ 会话的历史，也不该污染她的上下文。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

import { api } from './api.mjs';

const STATE_DIR = String(process.env.ROOST_LAUNCHER_DIR || join(homedir(), '.dsh', 'dsh-roost'));

/** 从 Roost 的 groups.json 里挑「最近活跃」的群（工具没给 chatId 时兜底） */
export function latestGroup() {
  /**
   * 这里读的是 Roost 自己的 `groups.json`。
   *
   * 宿主的 `/v1` 没有暴露「群列表 + 最后活跃时间」，而「当前活跃会话」
   * 是写操作的唯一安全边界（见 engine 的 resolveWritableTarget），
   * 只能从这里拿 `lastActiveAt`。群名本来也不需要它——名字走 `/v1/group/info`。
   */
  try {
    const p = join(STATE_DIR, 'roost', 'data', 'bots', 'main', 'groups.json');
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const rows = Object.entries(j || {}).map(([id, v]) => ({
      chatId: String(v?.groupOpenid || id),
      name: String(v?.name || v?.groupName || ''),
      lastActiveAt: Number(v?.lastActiveAt) || 0,
    }));
    rows.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return rows[0] || null;
  } catch {
    return null;
  }
}

/**
 * 群名缓存。
 *
 * Roost 的 `groups.json` **只存 openid**（连 `note` 都是空的），从来没有群名，
 * 所以面板上只能显示「未命名」。名字只能问宿主：`GET /v1/group/info?groupId=`
 * 会返回官方群名（真机实测「十人握尺」）。
 *
 * 但那是**一次上游调用**，每开一次面板敲一遍太浪费，所以按 12 小时缓存到文件；
 * 「刷新」按钮会强制重取。
 */
const NAMES_FILE = join(STATE_DIR, 'persona-grow-names.json');
const NAME_TTL = 12 * 60 * 60 * 1000;

let names = null;
function loadNames() {
  if (names) return names;
  try {
    const j = JSON.parse(readFileSync(NAMES_FILE, 'utf8'));
    names = j && typeof j === 'object' ? j : {};
  } catch {
    names = {};
  }
  return names;
}

function saveNames() {
  try {
    mkdirSync(dirname(NAMES_FILE), { recursive: true });
    writeFileSync(NAMES_FILE, JSON.stringify(names || {}, null, 1), 'utf8');
  } catch { /* 缓存写不进去不影响主流程 */ }
}

function groupsRows() {
  /**
   * 这里读的是 Roost 自己的 `groups.json`。
   *
   * 宿主的 `/v1` 没有暴露「群列表 + 最后活跃时间」，而「当前活跃会话」
   * 是写操作的唯一安全边界（见 engine 的 resolveWritableTarget），
   * 只能从这里拿 `lastActiveAt`。群名本来也不需要它——名字走 `/v1/group/info`。
   */
  try {
    const p = join(STATE_DIR, 'roost', 'data', 'bots', 'main', 'groups.json');
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return Object.entries(j || {}).map(([id, v]) => ({
      chatId: String(v?.groupOpenid || id),
      lastActiveAt: Number(v?.lastActiveAt) || 0,
    })).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  } catch {
    return [];
  }
}

/** 同步版本：只读缓存，不联网（MCP 工具在真机上要秒回） */
export function listGroups() {
  const cache = loadNames();
  return groupsRows().map((g) => ({ ...g, name: String(cache[g.chatId]?.name || '') }));
}

/**
 * 异步版本：缓存过期就现问宿主，拿不到就退回缓存里的旧名字。
 * 单个群失败不影响其它群——面板上少一个名字，比整页报错好。
 */
export async function listGroupsNamed({ force = false } = {}) {
  const cache = loadNames();
  const now = Date.now();
  const rows = groupsRows();
  let dirty = false;

  const out = [];
  for (const g of rows) {
    const hit = cache[g.chatId];
    const fresh = hit && hit.name && now - (hit.at || 0) < NAME_TTL;
    if (!force && fresh) {
      out.push({ ...g, name: hit.name });
      continue;
    }
    let name = hit?.name || '';
    try {
      const r = await api(`/v1/group/info?groupId=${encodeURIComponent(g.chatId)}`);
      const got = String(r?.name || '').trim();
      if (got) {
        name = got;
        cache[g.chatId] = { name, at: now };
        dirty = true;
      }
    } catch {
      // 保留旧名字；没有就空着，页面会显示「未命名」
    }
    out.push({ ...g, name });
  }
  if (dirty) saveNames();
  return out;
}

/** 拉最近对话（journal 只留 7 天，超出查不到是正常的） */
export async function fetchRecent(chatId, limit = 40) {
  const r = await api(`/v1/journal?chatId=${encodeURIComponent(chatId)}&limit=${Math.min(Math.max(limit, 5), 60)}`);
  const items = Array.isArray(r?.items) ? r.items : [];
  return items
    .filter((x) => x && String(x.text || '').trim())
    .map((x) => ({
      // `id` 必须留着：它以 `:bot` 结尾表示这句是**她自己说的**，
      // 本地分析全靠这个区分「她的话」和「别人的话」。丢了就一条也算不出来。
      id: String(x.id || ''),
      at: Number(x.at) || 0,
      text: String(x.text).trim(),
    }));
}

const PROMPT = (lines, existing) => `你在帮一个 QQ 机器人观察「她在真实对话里慢慢变成了什么样」。

下面是她最近的真实对话（按时间顺序，一行一句）：

${lines.map((l) => `- ${l}`).join('\n')}

${existing.length ? `她已经形成的习惯（别重复造新的同类项，可以提升成熟度）：\n${existing.map((e) => `- 【${e.category}】${e.text}（成熟度 ${e.maturity}）`).join('\n')}\n` : ''}
请提炼出 0~4 条**在这个对话里反复出现的、可观察的行为倾向**。要求：
- 只写对话里真有证据的，没有就返回空数组，不要编
- 每条是一个短句（不超过 30 字），描述「她怎么说话/怎么做事」
- category 从这些里选：口吻、称呼、习惯、偏好、情绪
- maturity 1~5，重复出现得越多越高
- evidence 引用最多 20 字的原文片段

只输出 JSON，不要解释、不要代码块：
{"entries":[{"category":"口吻","text":"……","maturity":2,"evidence":"……"}]}`;

function parseJson(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

/**
 * 跑一次分析，返回 { entries, raw, modelText }
 */
export async function analyze({ chatId, existing = [], limit = 40, timeoutMs = 20_000 }) {
  const rows = await fetchRecent(chatId, limit);
  if (rows.length < 3) {
    return { entries: [], raw: '', modelText: '', skipped: `最近对话只有 ${rows.length} 条，样本不足` };
  }

  // 正文里带发送者就更好读；这里只取正文，避免把 openid 塞给模型
  const lines = rows.slice(-limit).map((r) => r.text.replace(/\s+/g, ' ').slice(0, 120));

  /**
   * 20 秒的来由：面板动作由宿主 `runInProcessAction` 执行，默认 `timeoutMs: 30_000`
   * 且调用点没传更大的值。模型超时给 20s，留 10s 给本地兜底 + 落地，
   * 这样面板不会出现「动作超过 30 秒没返回」而其实现还在后台跑（用户重复点＝重复花额度）。
   */
  let sessionId = '';
  try {
    const created = await api('/v1/agent.new', { method: 'POST', body: { persist: false } });
    sessionId = String(created?.sessionId || created?.id || '');
    if (!sessionId) throw new Error('宿主没返回 sessionId');

    const out = await api(`/v1/agent.prompt?wait=1`, {
      method: 'POST',
      body: { sessionId, text: PROMPT(lines, existing) },
      timeoutMs,
    });
    const modelText = String(out?.text || '');
    const parsed = parseJson(modelText);
    if (!parsed) {
      // 模型吐了不是 JSON 的东西：明确报出去，让上层退回本地分析
      throw new Error(`模型返回的不是合法 JSON（前 60 字：${modelText.slice(0, 60)}）`);
    }
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return { entries, raw: parsed, modelText, rows: rows.length, rowsData: rows };
  } finally {
    if (sessionId) {
      await api('/v1/agent.close', { method: 'POST', body: { sessionId } }).catch(() => {});
    }
  }
}

/**
 * 本地分析（不调用模型）。
 *
 * 为什么要有这条兜底：`/v1/agent.prompt` 走的是宿主默认模型，而宿主的
 * `model.effort`（推理强度）是**全局**的。真机上就撞到过
 * `provider "sta" model "[gemini-3.8-flash]" does not support reasoning effort "low"` ——
 * 那不是本扩展能改的配置（令牌没有 `config:write`），于是整条链路会永远失败。
 *
 * 兜底只做「能从字面数出来」的东西：口癖、颜文字、句尾、句式倾向。
 * 质量不如模型，但**零额度、零依赖、任何模型配置下都能跑**。
 *
 * journal 的 id 以 `:bot` 结尾表示这是她自己的发言（见 /v1/journal 的返回），
 * 用它把「她说的」和「别人说的」分开。
 */
export function analyzeLocal(rows = []) {
  const bot = [];
  const others = [];
  for (const r of rows) {
    const t = String(r?.text ?? '').trim();
    if (!t) continue;
    if (/:bot$/.test(String(r?.id ?? ''))) bot.push(t);
    else others.push(t);
  }
  // 她自己的话太少就没法看习惯；`<skip>` 是她的「不接话」标记，不参与
  const say = bot.filter((t) => t && t !== '<skip>');
  if (say.length < 4) {
    return { entries: [], mode: 'local', rowsData: rows, skipped: `她在这个会话里只说了 ${say.length} 句，样本不足` };
  }

  const entries = [];
  const ratio = (n) => n / say.length;

  // ① 颜文字 / 括号表情
  const kao = say.filter((t) => /[（(][^（）()\n]{1,24}[)）]/.test(t)).length;
  if (ratio(kao) >= 0.25) {
    entries.push({
      category: '口吻',
      text: '说话爱带颜文字或括号表情',
      maturity: ratio(kao) >= 0.5 ? 3 : 2,
      evidence: say.find((t) => /[（(][^（）()\n]{1,24}[)）]/.test(t))?.slice(0, 20) || '',
    });
  }

  // ② 句尾语气词
  const tails = new Map();
  const PARTICLES = ['呀', '啦', '嘛', '哦', '呢', '吧', '啊', '喔', '咯'];
  for (const t of say) {
    const m = /([呀啦嘛哦呢吧啊喔咯])[。！？!?~～…）)]*$/.exec(t);
    if (m) tails.set(m[1], (tails.get(m[1]) || 0) + 1);
  }
  const topTail = [...tails.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topTail && ratio(topTail[1]) >= 0.25) {
    entries.push({
      category: '口吻',
      text: `句尾常带「${topTail[0]}」`,
      maturity: ratio(topTail[1]) >= 0.45 ? 3 : 2,
      evidence: say.find((t) => t.endsWith(topTail[0]))?.slice(0, 20) || '',
    });
  }

  // ③ 反问倾向
  const ask = say.filter((t) => /[？?]/.test(t)).length;
  if (ratio(ask) >= 0.3) {
    entries.push({
      category: '习惯',
      text: '常反问一句，把话头递回给对方',
      maturity: ratio(ask) >= 0.5 ? 3 : 2,
      evidence: say.find((t) => /[？?]/.test(t))?.slice(0, 20) || '',
    });
  }

  // ④ 句子长短
  const avg = say.reduce((n, t) => n + t.length, 0) / say.length;
  if (avg >= 45) {
    entries.push({ category: '习惯', text: '回话偏长，喜欢把话说完整', maturity: 2, evidence: `平均 ${Math.round(avg)} 字` });
  } else if (avg <= 12) {
    entries.push({ category: '习惯', text: '回话偏短，能一句说完就不多说', maturity: 2, evidence: `平均 ${Math.round(avg)} 字` });
  }

  // ⑤ 高频短语（3~5 字，至少出现在 3 句里）
  const count = new Map();
  for (const t of say) {
    const seen = new Set();
    for (let n = 3; n <= 5; n += 1) {
      for (let i = 0; i + n <= t.length; i += 1) {
        const w = t.slice(i, i + n);
        /**
         * 只要纯汉字候选。
         *
         * 不过滤的话颜文字碎片会被当成口头禅——真机上就抓到过「•́ω」这种，
         * 它出现在好几条表情里，统计上确实是高频片段，但对人格毫无意义。
         */
        if (!/^[\u4e00-\u9fa5]{3,5}$/.test(w)) continue;
        if (seen.has(w)) continue;
        seen.add(w);
        count.set(w, (count.get(w) || 0) + 1);
      }
    }
  }
  const topWord = [...count.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1])[0];
  if (topWord) {
    entries.push({ category: '习惯', text: `口头禅是「${topWord[0]}」`, maturity: 2, evidence: `出现在 ${topWord[1]} 句里` });
  }

  return { entries, mode: 'local', rows: rows.length, rowsData: rows, botLines: say.length, others: others.length };
}

/**
 * 先用模型，失败就退回本地。
 *
 * 不把失败直接抛给用户：模型不支持某一档推理强度是**环境问题**，
 * 而「记下她的口癖」这件事本地算得出来——能出一部分结果，比整条功能不可用强。
 */
export async function analyzeAuto({ chatId, existing = [], limit = 40, timeoutMs = 20_000 }) {
  const rows = await fetchRecent(chatId, limit);
  if (rows.length < 3) {
    return { entries: [], mode: 'none', skipped: `最近对话只有 ${rows.length} 条，样本不足` };
  }
  try {
    const out = await analyze({ chatId, existing, limit, timeoutMs });
    return { ...out, mode: 'model' };
  } catch (e) {
    const local = analyzeLocal(rows);
    return { ...local, modelError: String(e?.message ?? e).slice(0, 200) };
  }
}

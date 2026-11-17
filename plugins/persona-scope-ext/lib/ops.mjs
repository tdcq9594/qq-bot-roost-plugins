/**
 * 业务层：卡片 / 预设 / 应用 / 绑定。
 *
 * ## 两套概念，别混
 *
 *   · **人设卡 + 预设** = 素材（扩展自己存，可编辑、可停用）
 *   · **人格** = 产物（宿主的人格库，模型最终读到的就是它）
 *
 * 「应用」= 把卡片正文 + 启用的预设拼成一份人格正文，写进人格库（`personas.create`），
 * 需要的话再顺手把某个人绑上去（`session.configure`）。
 *
 * ## 与 Roost 插件版的差异
 *
 * 插件版的预设支持 `when` 正则，按**这一轮说的话**决定命中与否。扩展没有每轮钩子
 * （它只在面板点击或模型调工具时执行），所以这里只做**静态预设**：启用的全部拼上。
 * 这一点在页面上明确写出来，不假装支持。
 */

import { randomUUID, createHash } from 'node:crypto';

import { get, post } from './api.mjs';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadState, mutate, stateFile } from './state.mjs';
import { readPluginState, writePluginState, mergeItems } from './interop.mjs';
import { growthSnapshot, growthConflicts, growthBlockOf, clearGrowth } from './growth.mjs';
import { buildVars, renderPersonaText } from './template.mjs';

const OPENID_RE = /^[0-9A-Fa-f]{32}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** 拼出来的人格 id 前缀：一眼能看出这份人格是扩展生成的 */
const GEN_PREFIX = 'scope-';

/** 宿主人格 id 的硬上限（`personas.js` 的 `safeId` 截到 60；超了会被拒） */
const MAX_PERSONA_ID = 60;

/** 短哈希：只在「可读 id 放不下」时用 */
function shortHash(text, hex = 16) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, hex);
}

/**
 * 生成人格 id —— 必须同时满足：
 *
 *   1. **≤ 60 字符**（宿主上限，超了 `personas/create` 直接 400）
 *   2. **不同人、不同群都不碰撞**（碰撞 = 覆盖别人正在用的正文）
 *   3. **同人同卡同群幂等**（重复应用是更新，不是新建）
 *
 * 这是「专属人设」，所以 **发送者必须进 id**。以前只有卡片和群，
 * 同一张卡给两个人用会得到同一个 id，第二个人的称呼会覆盖第一个人的正文。
 *
 * 拼法（长的那部分才压缩）：
 *
 *   `scope-<卡片>[-g<群哈希8>]-<完整发送者openid>`
 *
 * - **发送者用完整 openid**：它是「专属」的唯一标识，截断就会串人
 * - 群用 8 位哈希（32 位空间）：同一个人 + 同一张卡下才需要区分群，量很小
 * - 卡片放不下时换成 `h<8位哈希>`，保证总长不超 60
 */
export function genPersonaId({ cardId = '', chatId = '', senderId = '' } = {}) {
  const card = String(cardId || '').trim();
  const chat = String(chatId || '').trim().toUpperCase();
  const sender = String(senderId || '').trim().toUpperCase();

  // 没有发送者：保持旧规则（用于兼容既有 id 与「只生成不绑定」的场景）
  if (!sender) {
    const tail = chat ? `-grow-${chat}` : '';
    const readable = `${GEN_PREFIX}${card}${tail}`;
    if (readable.length <= MAX_PERSONA_ID) return readable;
    const hashed = `${GEN_PREFIX}${shortHash(card)}${tail}`;
    if (hashed.length <= MAX_PERSONA_ID) return hashed;
    return `${GEN_PREFIX}${shortHash(`${card}|${chat}`, 24)}`;
  }

  const chatPart = chat ? `-g${shortHash(chat, 8)}` : '';
  const budget = MAX_PERSONA_ID - GEN_PREFIX.length - 1 - sender.length - chatPart.length;
  const cardPart = card.length <= budget ? card : `h${shortHash(card, 8)}`;
  const id = `${GEN_PREFIX}${cardPart}${chatPart}-${sender}`;
  if (id.length <= MAX_PERSONA_ID) return id;
  // 极端：发送者本身特别长，退回全哈希
  return `${GEN_PREFIX}${shortHash(`${card}|${chat}|${sender}`, 24)}`;
}

export function checkOpenid(raw) {
  const v = String(raw ?? '').trim();
  if (!v) throw new Error('要给发送者 openid（在群里发 /人设 我是谁 可以查到）');
  if (BAD_KEYS.has(v)) throw new Error('openid 不合法');
  if (!OPENID_RE.test(v)) throw new Error(`openid 必须是 32 位十六进制，收到「${v.slice(0, 40)}」`);
  return v.toUpperCase();
}

const pick = (state, kind, id) => (state[kind] ?? []).find((x) => x.id === id) || null;

/* ── 素材 CRUD ───────────────────────────────────────────── */

export function listAll() {
  const st = loadState();
  return {
    ok: true,
    file: stateFile(),
    cards: st.cards.map((c) => ({ ...c, chars: c.text.length })),
    presets: st.presets.map((p) => ({ ...p, chars: p.text.length })),
  };
}

/** 与 Roost 插件的互通状态：哪边有配置、能不能导 */
export function interopStatus() {
  const r = readPluginState();
  return r.ok
    ? { ok: true, pluginPath: r.path, pluginCards: r.cards.length, pluginPresets: r.presets.length }
    : { ok: false, reason: r.reason };
}

/**
 * 从 Roost 插件导入（合并，不覆盖本地独有的）。
 * @param {object} p
 * @param {boolean} [p.replace] true = 用插件的覆盖本地（本地独有的仍保留）
 */
export async function importFromPlugin({ replace = false } = {}) {
  const r = readPluginState();
  if (!r.ok) throw new Error(r.reason);

  const { saved, result } = await mutate((st) => {
    /**
     * 覆盖方向：
     *   · 默认     → 只补本地缺失（`override:false`），导入不悄悄覆盖本地改动；
     *   · replace  → 同 id 用插件版本覆盖本地。
     * 以前写反了：`replace:true` 反而让本地赢，与说明相反。
     */
    const opt = { override: replace === true };
    const cards = mergeItems(st.cards, r.cards, opt).items;
    const presets = mergeItems(st.presets, r.presets, opt).items;
    return { next: { ...st, cards, presets }, result: { cards: cards.length, presets: presets.length, from: r.path } };
  });
  return {
    ok: true,
    ...result,
    counts: { cards: saved.cards.length, presets: saved.presets.length },
    note: `已从插件导入（${result.cards} 张卡 / ${result.presets} 条预设）`,
  };
}

/**
 * Roost 面板端口：只信框架自己写的 `ports.json`。
 *
 * 读不到就**返回 null，绝不猜 8080** —— 8080 太常见（Steam 的 CEF 调试口也在用），
 * 猜错会把「启用插件」「写配置」这类写请求打到别人家的服务上。
 */
function roostPort() {
  try {
    const root = String(process.env.ROOST_LAUNCHER_DIR || join(homedir(), '.dsh', 'dsh-roost'));
    const j = JSON.parse(readFileSync(join(root, 'roost', 'data', 'ports.json'), 'utf8'));
    const p = Number(j?.roost?.actual) || Number(j?.roost?.want) || 0;
    return p > 0 ? p : null;
  } catch { return null; }
}

/** 面板访问密钥（框架 `config/bot.json` 的 `webui.accessKey`，没设就是空） */
function panelKey() {
  try {
    const root = String(process.env.ROOST_LAUNCHER_DIR || join(homedir(), '.dsh', 'dsh-roost'));
    const j = JSON.parse(readFileSync(join(root, 'roost', 'config', 'bot.json'), 'utf8'));
    return String(j?.webui?.accessKey || j?.webui?.token || '');
  } catch { return ''; }
}

/**
 * 调面板的写接口。
 *
 * 两个坑都在这一个函数里堵掉：
 *   · 端口缺失 → 直接放弃（不猜）
 *   · 面板设了 accessKey → 带上 `X-Access-Key`，否则必然 401
 * 失败时把 **HTTP 状态**带回给调用方，而不是吞成 false。
 */
async function panelCall(path, { method = 'POST', body = {} } = {}) {
  const port = roostPort();
  if (!port) return { ok: false, status: 0, reason: '读不到 Roost 面板端口（ports.json），请在面板里手动操作' };
  const key = panelKey();
  const headers = { 'content-type': 'application/json' };
  if (key) headers['x-access-key'] = key;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json().catch(() => null);
    return {
      ok: res.ok && j?.ok !== false,
      status: res.status,
      json: j,
      reason: res.ok ? (j?.ok === false ? '面板返回失败' : '') : `面板返回 HTTP ${res.status}${res.status === 401 ? '（访问密钥不匹配）' : ''}`,
    };
  } catch (e) {
    return { ok: false, status: 0, reason: `面板连不上：${e?.message ?? e}` };
  }
}

/**
 * 让运行中的 Roost 插件重新读配置。
 *
 * 不这么做的话：我们写盘成功，但插件的 `ctx.config` 还是旧内存副本；
 * 用户随后在插件面板点一次「保存」，整份配置就从旧副本写回，**刚导出的卡片被冲掉**。
 */
/**
 * 「每轮提示词注入」渠道。
 *
 * 扩展没有每轮钩子，真正每轮往消息里加东西的是 Roost 插件 persona-scope。
 * 所以这里做的是**把渠道接上**：导出卡片/预设到插件配置 → 启用插件 → 重载，
 * 之后插件就会按自己的规则（含 `{{if}}` 条件预设）每轮注入。
 */
export async function enableInjectionChannel() {
  const r = await exportToPlugin();
  const q = r.botId ? `?bot=${encodeURIComponent(r.botId)}` : '';

  /**
   * **两个开关是两件事**：框架「启用插件」（加载它）和插件配置里的 `enabled`
   * （它内部 `if (!c.enabled) return` 的闸门）。只打开前者，注入照样被跳过。
   */
  const cfg = await panelCall(`/api/plugins/persona-scope/config${q}`, {
    method: 'PUT',
    body: { enabled: true },
  });
  const configEnabled = Boolean(cfg.ok && (cfg.json?.config?.enabled === true || cfg.json?.ok === true));

  const en = await panelCall(`/api/plugins/persona-scope/enable${q}`, { method: 'POST', body: {} });
  const enabled = Boolean(en.ok);

  const done = enabled && configEnabled;
  const why = (!cfg.ok && cfg.reason) || (!en.ok && en.reason) || '';
  return {
    ok: true,
    ...r,
    pluginEnabled: enabled,
    configEnabled,
    note: done
      ? '已开启每轮注入：卡片与预设同步到 Roost 插件，框架开关与插件内 enabled 都已打开'
      : enabled && !configEnabled
        ? `插件已被框架加载，但插件内部的「启用」没能改成功（${cfg.reason || '未知原因'}）——请到插件设置里勾上「启用」，否则它仍会跳过注入`
        : `卡片与预设已同步到插件，但没能自动启用${why ? `：${why}` : ''}——请到面板的插件列表里手动启用「rp人设」`,
  };
}

async function reloadPlugin(botId = '') {
  /**
   * **必须带 `?bot=`**：Roost 面板用 `pickRuntime(url)` 选机器人，不带就永远落到
   * `runtimes[0]`。多只鸟时会出现「写的是第二只的配置、重载的是第一只」——
   * 目标那只的插件内存还是旧的，用户下一次保存就把导出冲掉。
   */
  const q = botId ? `?bot=${encodeURIComponent(botId)}` : '';
  const r = await panelCall(`/api/plugins/persona-scope/reload${q}`, { method: 'POST', body: {} });
  return r.ok;
}

/** 导出到 Roost 插件配置（只改 cards / presets，其他设置原样保留） */
export async function exportToPlugin() {
  const st = loadState();
  const r = writePluginState(st);
  if (!r.ok) throw new Error(r.reason);
  const reloaded = await reloadPlugin(r.botId);
  return {
    ok: true,
    ...r,
    reloaded,
    reloadedBot: r.botId || '',
    note: reloaded
      ? `已写入${r.botId ? `机器人「${r.botId}」的` : ''}插件配置并让插件重新读取：${r.cards} 张卡 / ${r.presets} 条预设`
      : `已写入${r.botId ? `机器人「${r.botId}」的` : ''}插件配置：${r.cards} 张卡 / ${r.presets} 条预设（插件没能在运行中重载，建议在面板点一次重载，否则它下次保存会覆盖这次导出）`,
  };
}

/**
 * 扫一遍宿主人格库里带 `{{…}}` 的人格。
 *
 * 这类人格会让 DSH 的提示词渲染失败 **整轮没有回复**，而且没有任何报错——
 * 用户只看到「不说话了」。所以状态页要主动报出来，并提供一键修复。
 */
export async function scanBrokenPersonas() {
  const st = await statusOf({});
  const broken = [];
  for (const p of st.personas || []) {
    try {
      const d = await get(`/personas/read?id=${encodeURIComponent(p.id)}`);
      if (/\{\{/.test(String(d.raw || ''))) broken.push({ id: p.id, label: p.label || p.id });
    } catch { /* 单个读不出来不影响整体 */ }
  }
  return { ok: true, total: (st.personas || []).length, broken };
}

/**
 * 修复：把带占位符的人格渲染成纯文本写回去。
 *
 * 渲染规则与建卡时一致（`{{user}}` 在这里固定成「你」——人格是给模型看的第二人称，
 * 且这份人格可能被整个群共用，不能绑死在某一个 openid 上）。
 * 写前由宿主自己留备份（`personas/.backup`）。
 */
export async function repairPersonas({ dryRun = true, userId = '' } = {}) {
  const { broken } = await scanBrokenPersonas();
  if (!broken.length) return { ok: true, fixed: 0, items: [], note: '没有发现带占位符的人格' };

  const items = [];
  for (const p of broken) {
    try {
      const d = await get(`/personas/read?id=${encodeURIComponent(p.id)}`);
      const rendered = renderPersonaText(String(d.raw || ''), buildVars({
        user: '你',
        char: p.label || p.id,
        userId,
      }));
      if (!dryRun) {
        await post('/personas/save', { id: p.id, raw: rendered.text });
      }
      items.push({ id: p.id, label: p.label, before: String(d.raw || '').length, after: rendered.text.length, unknown: rendered.unknown });
    } catch (e) {
      items.push({ id: p.id, label: p.label, error: String(e?.message ?? e) });
    }
  }
  const fixed = items.filter((x) => !x.error).length;
  return {
    ok: true,
    fixed,
    dryRun,
    items,
    note: dryRun ? `将修复 ${fixed} 份人格（未写入）` : `已修复 ${fixed} 份人格`,
  };
}

/** 清除某个群的成长（改写 persona-grow 的状态文件，带备份） */
export function clearGrowthOf({ chatId } = {}) {
  return clearGrowth(chatId);
}

/** 成长扩展适配：只读快照 + 影响面提示 */
export function growthInfo({ bySender = {}, byChat = {}, personas = [] } = {}) {
  const snap = growthSnapshot(byChat, personas);
  const c = growthConflicts(bySender, snap, byChat);
  return { ...snap, ...c };
}

export async function saveCard({ id = '', name = '', text = '', enabled = true, growth } = {}) {
  const { saved, result } = await mutate((st) => {
    const wantId = String(id || '').trim();
    const item = {
      id: wantId && !BAD_KEYS.has(wantId) ? wantId : undefined,
      name,
      text,
      enabled: enabled !== false,
      /** 没传 `growth`（undefined）就保留原值：页面漏传不该把已有开关重置成 false */
      ...(growth === undefined ? {} : { growth: growth === true }),
    };
    const idx = wantId ? st.cards.findIndex((c) => c.id === wantId) : -1;
    if (idx >= 0) {
      st.cards[idx] = { ...st.cards[idx], ...item, id: st.cards[idx].id };
    } else {
      // 注意：这里要**整体展开** item。逐个列字段漏掉新增的（比如 growth）会静默失效。
      st.cards.push({ ...item, id: item.id || `card-${randomUUID().slice(0, 8)}` });
    }
    return { next: st, result: { id: (idx >= 0 ? st.cards[idx].id : st.cards.at(-1)?.id) } };
  });
  return { ok: true, cards: saved.cards.map((c) => ({ ...c, chars: c.text.length })), id: result.id };
}

export async function removeCard({ id } = {}) {
  const { saved, result } = await mutate((st) => {
    const before = st.cards.length;
    st.cards = st.cards.filter((c) => c.id !== String(id ?? ''));
    return { next: st, result: { removed: before - st.cards.length } };
  });
  return { ok: true, removed: result.removed, cards: saved.cards.map((c) => ({ ...c, chars: c.text.length })) };
}

export async function savePreset({ id = '', name = '', text = '', enabled = true } = {}) {
  const { saved } = await mutate((st) => {
    const wantId = String(id || '').trim();
    const idx = wantId ? st.presets.findIndex((p) => p.id === wantId) : -1;
    const body = { name, text, enabled: enabled !== false };
    if (idx >= 0) {
      st.presets[idx] = { ...st.presets[idx], ...body };
    } else {
      st.presets.push({ id: wantId || `preset-${randomUUID().slice(0, 8)}`, ...body });
    }
    return { next: st };
  });
  return { ok: true, presets: saved.presets.map((p) => ({ ...p, chars: p.text.length })) };
}

export async function removePreset({ id } = {}) {
  const { saved, result } = await mutate((st) => {
    const before = st.presets.length;
    st.presets = st.presets.filter((p) => p.id !== String(id ?? ''));
    return { next: st, result: { removed: before - st.presets.length } };
  });
  return { ok: true, removed: result.removed, presets: saved.presets.map((p) => ({ ...p, chars: p.text.length })) };
}

/* ── 拼装 ────────────────────────────────────────────────── */

/**
 * 卡片正文 + 启用的预设 → 最终人格正文。
 *
 * 顺序：卡片在前、预设在后。预设是「约束/风格」，压在卡片后面更贴合当轮。
 */
export function composeRaw({ card, presets = [], vars = {}, openid = '' } = {}) {
  const head = String(card?.text ?? '').trim();
  const tail = presets
    .filter((p) => p && p.enabled !== false && String(p.text ?? '').trim())
    .map((p) => String(p.text).trim())
    .join('\n\n');
  const raw = [head, tail].filter(Boolean).join('\n\n');

  /**
   * 占位符必须在这里就渲染掉：人格正文会进 DSH 的系统提示，
   * 而那边解析到没注册的 `{{user}}` 会让**整段渲染失败**（就是用户报的错）。
   */
  const rendered = renderPersonaText(raw, buildVars({
    user: String(vars.user || (openid ? `对方` : '对方')),
    char: card?.name || '',
    userId: openid,
  }));
  return { text: rendered.text, unknown: rendered.unknown, conditions: rendered.conditions };
}

/** 预览：不发写请求，让用户看清楚会生成什么 */
export function previewOf({ cardId, growthChatId = '', openid = '', userLabel = '', senderId = '' } = {}) {
  const st = loadState();
  const card = pick(st, 'cards', String(cardId ?? '').trim());
  if (!card) throw new Error('没找到这张人设卡');
  const composed = composeRaw({
    card,
    presets: st.presets,
    vars: { user: String(userLabel || '').trim() },
    openid: String(openid || '').trim(),
  });
  let raw = composed.text;

  /**
   * 与人设成长的兼容：把**指定那个群**的成长条目叠在预设后面。
   *
   * 只读 persona-grow 的数据，不写它——它自己还在长，两边各写一份必然打架。
   * 叠加后这份人格的 id 带 `-grow` 后缀，一眼能看出是「卡片 + 成长」。
   */
  /**
   * 成长叠加由**卡片自己**决定（`card.growth`），群可以显式选，也可以自动挑：
   * 只有一个群在长时直接用，多个群时要求用户选（不猜，猜错就是串味）。
   */
  let growth = { text: '', entries: 0, chatId: '', reason: '' };
  const wantGrowth = card.growth === true || Boolean(growthChatId);
  if (wantGrowth) {
    let target = String(growthChatId || '').trim();
    if (!target) {
      const snap = growthSnapshot({}, []);
      const grown = (snap.chats || []).filter((c) => (c.entries || 0) > 0);
      if (grown.length === 1) target = grown[0].chatId;
      else if (grown.length > 1) {
        growth.reason = '这张卡要求叠加成长，但有多个群在长——请在「叠加成长」里选一个群';
      } else {
        growth.reason = '这张卡要求叠加成长，但目前还没有任何群长出条目';
      }
    }
    if (target) {
      growth = { ...growthBlockOf(target), reason: '' };
      if (growth.text) raw = `${raw}\n\n${growth.text}`;
    }
  }
  /** 卡片要求成长但拿不到目标群 → 交给调用方决定（apply 会拒绝，预览只提示） */
  const needsGrowthChat = wantGrowth && !growth.text;

  return {
    ok: true,
    id: genPersonaId({ cardId: card.id, chatId: growth.text ? growth.chatId : '', senderId: String(senderId || openid || '').trim() }),
    label: card.name + (growth.text ? '（含成长）' : ''),
    needsGrowthChat,
    chars: raw.length,
    raw,
    usedPresets: st.presets.filter((p) => p.enabled !== false && p.text.trim()).map((p) => p.name),
    unknownVars: composed.unknown,
    strippedConditions: composed.conditions,
    userName: String(userLabel || '').trim() || '对方',
    growthEntries: growth.entries,
    growthChatId: growth.chatId,
    growthNote: growth.reason || '',
  };
}

/* ── 落地：写人格 + 绑定 ─────────────────────────────────── */

/**
 * 把一张卡片应用出去。
 *
 * @param {object} p
 * @param {string} p.cardId  要应用的人设卡
 * @param {string} [p.openid] 顺带绑给谁（留空只写人格、不绑）
 * @param {string} [p.personaId] 自定义人格 id（默认 scope-<卡片id>）
 */
export async function applyCard({ cardId = '', openid = '', personaId = '', growthChatId = '', userLabel = '' } = {}) {
  /**
   * **先把所有本地输入校验完，再发第一个写请求。**
   *
   * 之前是「先 personas/create（overwrite:true）再校验 openid」：openid 填错时
   * 函数确实报错了，但原先绑定者正在用的那份人格正文已经被覆盖掉了 ——
   * 用户看到的是「报错」，实际已经改了别人的设定。
   */
  const pv = previewOf({ cardId, growthChatId, openid, userLabel, senderId: openid });
  /**
   * 卡片要求叠加成长，但群没定下来（多个群在长）→ **拒绝执行**。
   * 以前只把警告放在预览字段里，应用仍会静默生成一份不含成长的人格并绑上去，
   * 用户以为「成长叠加了」，实际没有。
   */
  if (pv.needsGrowthChat) {
    throw Object.assign(
      new Error(pv.growthNote || '这张卡要求叠加成长，请先在「叠加成长」里选一个群'),
      { code: 'GROWTH_CHAT_REQUIRED' },
    );
  }
  const id = String(personaId || pv.id).trim();
  if (!id) throw new Error('人格 id 不能为空');
  if (BAD_KEYS.has(id)) throw new Error('人格 id 不合法');
  const senderId = openid ? checkOpenid(openid) : '';

  await post('/personas/create', {
    id,
    label: pv.label,
    raw: pv.raw,
    overwrite: true, // 同一张卡重复应用就是更新，不该报 409
  });

  if (!senderId) {
    return {
      ok: true,
      personaId: id,
      label: pv.label,
      chars: pv.chars,
      presets: pv.usedPresets,
      growthEntries: pv.growthEntries || 0,
      bound: '',
      partial: false,
      note: `已生成人格「${pv.label}」（${pv.chars} 字${pv.growthEntries ? `，含 ${pv.growthEntries} 条成长` : ''}），还没绑人`,
    };
  }

  /**
   * 人格已经写成功了 —— 绑定再失败也不能说「整体失败」，
   * 否则用户会去重试，重复覆盖。这里如实报告「已生成、绑定失败」。
   */
  try {
    await post('/session.configure', { senderId, persona: id });
  } catch (e) {
    return {
      ok: false,
      partial: true,
      personaId: id,
      label: pv.label,
      chars: pv.chars,
      presets: pv.usedPresets,
      growthEntries: pv.growthEntries || 0,
      bound: '',
      message: `人格「${pv.label}」已生成，但绑定失败：${e?.message ?? e}。绑定修好后可以再点一次，不会丢东西`,
    };
  }

  return {
    ok: true,
    personaId: id,
    label: pv.label,
    chars: pv.chars,
    presets: pv.usedPresets,
    growthEntries: pv.growthEntries || 0,
    bound: senderId,
    partial: false,
    note: `已生成人格「${pv.label}」（${pv.chars} 字${pv.growthEntries ? `，含 ${pv.growthEntries} 条成长` : ''}）并绑给 ${senderId.slice(0, 8)}…`,
  };
}

/* ── 宿主人格库 ─────────────────────────────────────────── */

export async function statusOf({ chatId = '', senderId = '' } = {}) {
  const q = new URLSearchParams();
  if (chatId) q.set('chatId', chatId);
  if (senderId) q.set('senderId', senderId);
  const suffix = q.toString() ? `?${q}` : '';
  const d = await get(`/personas${suffix}`);
  return {
    current: d.current || '',
    effective: d.effective || '',
    byChat: d.byChat || {},
    bySender: d.bySender || {},
    personas: Array.isArray(d.rows) ? d.rows : [],
  };
}

export async function bind({ openid, persona } = {}) {
  const senderId = checkOpenid(openid);
  const want = String(persona ?? '').trim();
  if (!want) throw new Error('要指定绑哪个人格');
  if (BAD_KEYS.has(want)) throw new Error('人格 id 不合法');

  const st = await statusOf({ senderId });
  if (!st.personas.some((p) => p.id === want)) {
    const ids = st.personas.map((p) => p.id).slice(0, 12).join('、') || '（一个都没有）';
    throw new Error(`没有「${want}」这个人格。现有：${ids}`);
  }

  await post('/session.configure', { senderId, persona: want });
  const after = await statusOf({ senderId });
  return {
    ok: true,
    senderId,
    persona: want,
    effective: after.effective,
    label: after.personas.find((p) => p.id === want)?.label || want,
    note: `已把 ${senderId.slice(0, 8)}… 绑到「${want}」——他走到哪个群都用这一套，别人不受影响`,
  };
}

export async function unbind({ openid } = {}) {
  const senderId = checkOpenid(openid);
  await post('/session.configure', { senderId, clear: ['persona'] });
  const after = await statusOf({ senderId });
  return {
    ok: true,
    senderId,
    effective: after.effective,
    note: `已解绑 ${senderId.slice(0, 8)}…，他回到默认人格（${after.effective || 'default'}）`,
  };
}

export async function readPersona({ id } = {}) {
  const want = String(id ?? '').trim();
  if (!want) throw new Error('要指定人格 id');
  const d = await get(`/personas/read?id=${encodeURIComponent(want)}`);
  return { ok: true, id: want, raw: String(d.raw ?? ''), chars: Number(d.chars) || 0 };
}

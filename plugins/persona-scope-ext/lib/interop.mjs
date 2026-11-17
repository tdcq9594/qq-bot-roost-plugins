/**
 * 与 Roost 插件 `persona-scope` 的卡片 / 预设互通。
 *
 * ## 两边的字段差异（这是唯一需要翻译的地方）
 *
 * | 概念 | 插件配置 | 本扩展 |
 * |---|---|---|
 * | 卡片正文 | `text` | `text` |
 * | 卡片生效名单 | `targets`（openid 列表串） | 没有（扩展是「绑给人」） |
 * | 预设正文 | `content` | `text` |
 * | 预设角色 | `role`（system/user/assistant） | 没有（一律拼进正文） |
 * | 预设条件 | `when`（正则） | 没有（静态） |
 * | 启用 | `enabled` | `enabled` |
 *
 * 翻译原则：
 *   · **导入**时把 `content` → `text`，同时把 `role` / `when` / `targets` 原样
 *     留在 `_plugin` 字段里。这样导出回去时不会丢信息——用户可能两个都装，
 *     插件那边的条件预设不该被扩展「洗掉」。
 *   · **导出**时优先用 `_plugin` 里的原始字段，没有才按默认值补。
 *   · 合并按 `id`（没有则按 `name`）——重复导入不会翻倍。
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const str = (v, max = 40_000) => String(v ?? '').slice(0, max);
const uid = (p) => `${p}-${Math.random().toString(36).slice(2, 10)}`;

/** Roost 侧插件配置可能出现的位置（多只鸟时取最近修改的那份） */
export function pluginConfigCandidates() {
  const root = String(process.env.ROOST_LAUNCHER_DIR || join(homedir(), '.dsh', 'dsh-roost'));
  const bots = join(root, 'roost', 'config', 'bots');
  if (!existsSync(bots)) return [];
  const out = [];
  for (const bot of readdirSync(bots)) {
    const p = join(bots, bot, 'plugins', 'persona-scope.json');
    if (existsSync(p)) out.push(p);
  }
  return out;
}

/** 从 `.../config/bots/<botId>/plugins/persona-scope.json` 里取出机器人 id */
export function botIdOf(path) {
  const m = /[\\/]bots[\\/]([^\\/]+)[\\/]plugins[\\/]persona-scope\.json$/.exec(String(path || ''));
  return m ? m[1] : '';
}

export function findPluginConfig() {
  const list = pluginConfigCandidates();
  if (!list.length) return { ok: false, reason: '没找到 Roost 插件 persona-scope 的配置（那边没装？）', paths: [], bots: [] };
  /** 按修改时间倒序：用户刚在面板上改的那份就是最新的。
   *  （以前这里用 `require`，ESM 里根本没有 —— 异常被 catch 吞掉，排序静默失效。）*/
  const mtimeOf = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
  list.sort((a, b) => mtimeOf(b) - mtimeOf(a));
  /** 多只鸟时把全部候选带上：调用方要据此判断「这次到底改了哪只」 */
  return { ok: true, path: list[0], botId: botIdOf(list[0]), paths: list, bots: list.map((p) => ({ path: p, botId: botIdOf(p) })) };
}

/** 插件配置 → 本扩展的素材格式 */
export function fromPluginConfig(raw) {
  const cards = (Array.isArray(raw?.cards) ? raw.cards : []).map((c) => ({
    id: String(c?.id || '').trim() || uid('card'),
    name: str(c?.name, 60).trim() || '未命名人设卡',
    text: str(c?.text),
    enabled: c?.enabled !== false,
    _plugin: { targets: String(c?.targets ?? '') },
  }));
  const presets = (Array.isArray(raw?.presets) ? raw.presets : []).map((p) => ({
    id: String(p?.id || '').trim() || uid('preset'),
    name: str(p?.name, 60).trim() || '未命名预设',
    text: str(p?.content ?? p?.text),
    enabled: p?.enabled !== false,
    _plugin: { role: String(p?.role ?? 'system'), when: String(p?.when ?? '') },
  }));
  return { cards, presets };
}

/** 本扩展素材 → 插件配置里的数组（保留 `_plugin` 里的原始字段） */
export function toPluginArrays(state) {
  const cards = (state?.cards ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    text: c.text,
    ...(c._plugin?.targets ? { targets: c._plugin.targets } : {}),
    enabled: c.enabled !== false,
  }));
  const presets = (state?.presets ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    content: p.text,
    role: p._plugin?.role || 'system',
    ...(p._plugin?.when ? { when: p._plugin.when } : {}),
    enabled: p.enabled !== false,
  }));
  return { cards, presets };
}

/**
 * 按 id（无则 name）合并。
 *
 * `override` 决定同 id 时听谁的：
 *   · false（默认）= 只补本地缺失，本地已有的**不动**（导入不该悄悄覆盖本地改动）
 *   · true         = 用 incoming 覆盖本地（`replace:true`）
 */
export function mergeItems(local, incoming, { override = true } = {}) {
  const keyOf = (x) => String(x.id || x.name || '').trim();
  const map = new Map((local || []).map((x) => [keyOf(x), x]));
  let added = 0;
  let updated = 0;
  for (const item of incoming || []) {
    const k = keyOf(item);
    if (!k) continue;
    if (map.has(k)) {
      if (override) { map.set(k, { ...map.get(k), ...item }); updated += 1; }
    }
    else { map.set(k, item); added += 1; }
  }
  return { items: [...map.values()], added, updated };
}

function atomicWrite(file, text) {
  const tmp = `${file}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

/**
 * 导入：读插件配置，合并进本地素材（合并预览由调用方决定是否落盘）。
 */
export function readPluginState() {
  const hit = findPluginConfig();
  if (!hit.ok) return { ok: false, reason: hit.reason };
  try {
    const raw = JSON.parse(readFileSync(hit.path, 'utf8'));
    return { ok: true, path: hit.path, botId: hit.botId, bots: hit.bots, raw, ...fromPluginConfig(raw) };
  } catch (e) {
    return { ok: false, reason: `插件配置读不出来：${e?.message ?? e}`, path: hit.path };
  }
}

/**
 * 导出：写回插件配置。
 *
 * 两条规矩：
 *   1. 只改 `cards` / `presets` 两个键，**其余字段原样保留**（targets / maxChars /
 *      全局名单等是插件自己的设置，扩展不该碰）；
 *   2. **按 id 合并，不删除插件独有的条目**。整份覆盖会把用户在插件面板里建的
 *      卡直接删掉——那些卡可能还没导入过这边。要删插件里的卡，去插件面板删。
 *
 * 写前留一份 `.bak`。
 */
export function writePluginState(state, { path = '' } = {}) {
  const hit = path ? { ok: true, path } : findPluginConfig();
  if (!hit.ok) return { ok: false, reason: hit.reason };

  /**
   * 文件**存在但解析不了** → 直接失败，一个字节都不写。
   * 以前这里吞掉异常当成空对象，导出只写 cards/presets，
   * 于是 maxChars / targets 这些设置被「成功导出」顺手抹掉了。
   */
  let raw = {};
  if (existsSync(hit.path)) {
    try {
      raw = JSON.parse(readFileSync(hit.path, 'utf8'));
    } catch (e) {
      return {
        ok: false,
        reason: `插件配置损坏，没有写入（避免丢掉其他设置）：${hit.path}（${e?.message ?? e}）`,
        path: hit.path,
        corrupt: true,
      };
    }
  }

  const { cards: mine, presets: minePresets } = toPluginArrays(state);
  /** 合并：同 id 用这边的版本，插件独有的保留 */
  const mergePlugin = (theirs, mineList) => {
    const keyOf = (x) => String(x?.id || x?.name || '').trim();
    const map = new Map((theirs || []).map((x) => [keyOf(x), x]));
    for (const x of mineList) {
      const k = keyOf(x);
      if (!k) continue;
      map.set(k, { ...(map.get(k) || {}), ...x });
    }
    return [...map.values()];
  };
  const cards = mergePlugin(Array.isArray(raw?.cards) ? raw.cards : [], mine);
  const presets = mergePlugin(Array.isArray(raw?.presets) ? raw.presets : [], minePresets);
  const next = { ...raw, cards, presets };

  try {
    copyFileSync(hit.path, `${hit.path}.bak-${Date.now()}`);
  } catch { /* 首次导出没有原文件，正常 */ }

  atomicWrite(hit.path, `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, path: hit.path, botId: hit.botId, cards: cards.length, presets: presets.length, merged: true };
}

export { dirname };

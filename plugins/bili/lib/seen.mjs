/**
 * 「她已经看过什么」的账本（跨重启）
 * ============================================================
 *
 * 对齐 aurabot `duty.js` 的 `s.seen = [...seen].slice(-500)`：那边把看过的
 * BV 号落盘到 `dataDir('bili.json')`，`filterVideos(list, { seen })` 在
 * **候选阶段**就把它们剔掉；重启、换会话、换实例都还算数。
 *
 * 我们以前只在 `feed.mjs` 里留了个内存 `recently`：
 *   · 进程内动作每次点按钮都新建 `createActions()` → 实例一换就清空；
 *   · 宿主/MCP 重启更是一次归零。
 * 所以「连刷几轮不重复」只在同一个 feed 实例里成立，主人看到的却是
 * 「怎么又是这一批」。
 *
 * ## 为什么单独一个文件，不塞进 `history.json`
 *
 * `history.json` 是给面板看的「她刷过什么」：按 天 + bvid + kind 去重、
 * 只留 60 条、带感想文本。seen 要的是**纯 BV 序列**、留 500 条、
 * 只用来做集合判断，混在一起会被面板的展示规则悄悄改掉。
 *
 * ## 落盘位置
 *
 * 写调用方传进来的 `dir`（运行时扩展目录，`HERE`），**不是仓库里的插件
 * 目录**。市场索引 `build-index.mjs` 按整个插件目录算 sha256，往开发目录
 * 里多写一个 JSON 会让 `--check` 变脏。`dir` 为空时退化成纯内存，
 * 供测试和无盘环境使用。
 *
 * 另外记一份 `nextKeywords`：她在值班会话末尾顺手给出「下轮想搜什么」，
 * 下一轮 `feed.tick()` 拿它去 `api.search()`。这样不用为挑关键词再开
 * 一轮模型、也不会多出一个侧栏窗口（见 `ai-duty.mjs` / `self-browse.mjs`）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SEEN_FILE = 'seen.json';
export const KEEP = 500;
const KW_KEEP = 3;

/** 关键词收窄：模型可能给一整句话，拿去搜会 0 结果 */
export function parseKeywords(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list
    .map((x) => String(x ?? '').trim().replace(/\s+/g, ' '))
    .filter((x) => x && x.length <= 24))].slice(0, KW_KEEP);
}

export function createSeenStore({ dir = '', keep = KEEP, log = () => {} } = {}) {
  const cap = Math.max(10, Number(keep) || KEEP);
  const file = () => join(dir, SEEN_FILE);
  /** `dir` 为空时用的内存副本，语义和落盘完全一致 */
  let mem = { seen: [], nextKeywords: [] };

  function read() {
    if (!dir) {
      return { seen: mem.seen.map((x) => ({ ...x })), nextKeywords: [...mem.nextKeywords] };
    }
    try {
      const j = JSON.parse(readFileSync(file(), 'utf8'));
      const rows = Array.isArray(j?.seen)
        ? j.seen.filter((x) => x && typeof x === 'object' && String(x.bvid || '').trim())
        : [];
      return {
        seen: rows.slice(0, cap).map((x) => ({
          bvid: String(x.bvid).trim(),
          title: String(x.title ?? '').slice(0, 120),
          at: Number(x.at) || 0,
        })),
        nextKeywords: parseKeywords(j?.nextKeywords),
      };
    } catch {
      /** 文件不存在 / 写坏都当空表，别让一轮刷不下去 */
      return { seen: [], nextKeywords: [] };
    }
  }

  function write(next) {
    mem = { seen: next.seen.map((x) => ({ ...x })), nextKeywords: [...next.nextKeywords] };
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file()}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ at: Date.now(), ...next }, null, 0)}\n`, 'utf8');
      renameSync(tmp, file());
    } catch (e) {
      log(`看过记录写盘失败（不影响这一轮）：${e?.message ?? e}`);
    }
  }

  return {
    /** 每次都重读：进程内动作会新建实例，不能用创建那一刻的快照覆盖别人刚写的 */
    state: read,

    has(bvid) {
      const key = String(bvid ?? '').trim();
      return Boolean(key) && read().seen.some((x) => x.bvid === key);
    },

    size: () => read().seen.length,

    /** 最近看过的标题，喂给模型让它「别和刚才重复」 */
    recentTitles(n = 6) {
      return read().seen.slice(0, Math.max(0, Number(n) || 0))
        .map((x) => x.title).filter(Boolean);
    },

    nextKeywords: () => read().nextKeywords,

    setNextKeywords(list) {
      const cur = read();
      write({ ...cur, nextKeywords: parseKeywords(list) });
    },

    /**
     * 记下这一轮真的给过她的视频。
     *
     * 新看的排最前（最新）、旧的按原顺序往后挪，超过 500 条丢最久的。
     * 重读再合并，避免两个 feed 实例各自覆盖。
     */
    add(items, { now = Date.now() } = {}) {
      const cur = read();
      const incoming = (Array.isArray(items) ? items : [items])
        .map((v) => ({
          bvid: String(v?.bvid ?? '').trim(),
          title: String(v?.title ?? '').slice(0, 120),
          at: Number(now) || Date.now(),
        }))
        .filter((x) => x.bvid);
      if (!incoming.length) return cur;
      const added = new Set(incoming.map((x) => x.bvid));
      const rest = cur.seen.filter((x) => !added.has(x.bvid));
      const seen = [...incoming].reverse().concat(rest).slice(0, cap);
      write({ ...cur, seen });
      return { ...cur, seen };
    },
  };
}

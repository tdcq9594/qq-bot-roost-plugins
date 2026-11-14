/**
 * 今日计数（刷了几轮 / 抽了几张 / 评论几条）
 * ============================================================
 *
 * 面板上「ta 刷过什么」那一块要的就是这几个数。存法很朴素：写进
 * `ui-data.json` 的 `meta.stats`，跨天自动清零。
 *
 * 为什么不做更"正式"的账本：这些数字只用来给人一个大致印象（今天动了几次），
 * 不需要精确对账。真正的投递记录在宿主的账本里（`ledger.sqlite`），
 * 这里再存一份完整的只会让两边对不上。
 *
 * **两个进程都会调它**（宿主里的按钮动作、MCP 子进程的定时刷），
 * 所以是「读磁盘 → 加 → 写回」。一轮一次，冲突概率可以忽略；
 * 真要严格，得让宿主做唯一写入方，那是另一套设计。
 */

import { readFileSync } from 'node:fs';

/** 本地日期键（按机器时区，不用 UTC——"今天"对用户来说就是本地日期） */
function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 计数的字段。`replies` 是「有人回 ta」的条数，`recent` 是最近刷到的标题 */
const FIELDS = ['rounds', 'shots', 'comments', 'likes', 'danmaku', 'replies'];

/** 空的一天 */
export function emptyStats(now = new Date()) {
  const s = { day: dayKey(now) };
  for (const k of FIELDS) s[k] = 0;
  return s;
}

/**
 * 把 `ui-data.json` 里的 stats 读出来并归一到「今天」。
 *
 * @param {string} file `ui.file()`
 * @returns {object} 一定是今天的那份（跨天时是全新的零值）
 */
export function readStats(file, now = new Date()) {
  let cur = null;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    cur = j?.meta?.stats;
  } catch { /* 还没有数据文件：当作空 */ }
  if (!cur || cur.day !== dayKey(now)) return emptyStats(now);
  const out = { day: cur.day };
  for (const k of FIELDS) out[k] = Math.max(0, Number(cur[k]) || 0);
  return out;
}

/**
 * 给某几项加数字，写回面板数据。
 *
 * @param {{setMeta: Function, file: Function}} ui `createUiData()` 的实例
 * @param {Record<string, number>} patch 例如 `{ rounds: 1 }`
 * @param {Date} [now]
 * @returns {object} 加完之后的完整 stats
 */
export function bumpStats(ui, patch = {}, now = new Date()) {
  const next = readStats(ui.file(), now);
  for (const [k, v] of Object.entries(patch)) {
    if (!FIELDS.includes(k)) continue;
    next[k] = Math.max(0, (Number(next[k]) || 0) + (Number(v) || 0));
  }
  try {
    ui.setMeta({ stats: next });
  } catch { /* 写盘失败只影响面板上的数字，不影响功能 */ }
  return next;
}

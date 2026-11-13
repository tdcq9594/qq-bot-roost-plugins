/**
 * 当日配额（本地小账本）
 * ======================
 *
 * 生图是**按张收钱**的：模型抽风时连画十张，账单是真的。
 * 每日上限只解决「别一夜之间花光」，所以账本极小：`{ day, count }` 一个文件。
 *
 * 两个细节值得写下来：
 *   1. **先扣后画**。工具调用是并发进来的（server 的行循环不等上一个 handle
 *      结束），先查后扣会让两次调用同时通过检查。先扣，画失败再退回。
 *   2. **跨天自动归零**。按本地日期字符串比，别用时间差——用户改系统时间、
 *      或者隔了一天再打开，时间差算法会给出奇怪的余量。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STATE_FILE = 'state.json';

/** 本地日期 `2026-11-14`（不用 toISOString：那是 UTC，凌晨会算成昨天） */
export function dayOf(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function readRaw(dir) {
  try {
    const j = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

function writeRaw(dir, obj) {
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, STATE_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(obj)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch { /* 记账失败不该拦住生图：配额是省钱的手段，不是目的 */ }
}

/** 今天已经画了几张。 */
export function countToday(dir, now = new Date()) {
  const raw = readRaw(dir);
  return raw.day === dayOf(now) ? Math.max(0, Number(raw.count) || 0) : 0;
}

/**
 * 占一个名额。`limit <= 0` 表示不限（只记账）。
 *
 * @returns {{ok:boolean, count:number, left:number, limit:number}}
 */
export function spend(dir, { limit = 0, now = new Date() } = {}) {
  const day = dayOf(now);
  const raw = readRaw(dir);
  const count = raw.day === day ? Math.max(0, Number(raw.count) || 0) : 0;
  if (limit > 0 && count >= limit) {
    return { ok: false, count, left: 0, limit };
  }
  const next = count + 1;
  writeRaw(dir, { ...raw, day, count: next });
  return { ok: true, count: next, left: limit > 0 ? Math.max(0, limit - next) : -1, limit };
}

/** 画失败了把名额退回去：失败不该占主人的额度。 */
export function refund(dir, { now = new Date() } = {}) {
  const day = dayOf(now);
  const raw = readRaw(dir);
  if (raw.day !== day) return;
  writeRaw(dir, { ...raw, day, count: Math.max(0, Math.round(Number(raw.count) || 0) - 1) });
}

/**
 * 当日配额（本地小账本）
 * ======================
 *
 * 生图是**按张收钱**的：模型抽风时连画十张，账单是真的。
 * 每日上限只解决「别一夜之间花光」，所以账本极小：`{ day, count }` 一个文件。
 *
 * 三个细节值得写下来：
 *   1. **先扣后画**。工具调用是并发进来的（server 的行循环不等上一个 handle
 *      结束），先查后扣会让两次调用同时通过检查。先扣，画失败再退回。
 *   2. **跨天自动归零**。按本地日期字符串比，别用时间差——用户改系统时间、
 *      或者隔了一天再打开，时间差算法会给出奇怪的余量。
 *   3. **跨进程锁**（0.2 新增）。0.1 只有 MCP 子进程一个写者，Node 单线程里
 *      同步的「读-改-写」天然不交错；0.2 多了宿主进程内的面板按钮，两个进程
 *      会同时 spend 同一份 state.json。对抗测试实测 3 进程 barrier、limit=1，
 *      12/12 轮三个进程都拿到名额 —— 就是三张图、三次钱。
 *      `tmp + rename` 只保证单次写原子，护不住这三步，必须整段加锁。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { withFileLock } from './lock.mjs';

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

/** 所有读-改-写都走同一把锁，锁名与账本文件名绑定 */
function locked(dir, fn, log) {
  return withFileLock(dir, STATE_FILE, fn, { log });
}

/**
 * 今天已经画了几张。**只读，故意不加锁**：
 * `writeRaw` 是 tmp + rename，读到的永远是完整文件，差一张也不影响展示；
 * 而 `withFileLock` 会 `mkdirSync(dir)`，加锁会让「只跑了自检、根本没画图」
 * 也凭空在插件目录里建出 `out/` 空目录（开发仓里看着就像多了个产物目录）。
 * `spend` / `refund` 这两处真正会写的仍然加锁。
 */
export function countToday(dir, now = new Date()) {
  const raw = readRaw(dir);
  return raw.day === dayOf(now) ? Math.max(0, Number(raw.count) || 0) : 0;
}

/**
 * 占一个名额。`limit <= 0` 表示不限（只记账）。
 *
 * @returns {{ok:boolean, count:number, left:number, limit:number}}
 */
export function spend(dir, { limit = 0, now = new Date(), log = () => {} } = {}) {
  return locked(dir, () => {
    const day = dayOf(now);
    const raw = readRaw(dir);
    const count = raw.day === day ? Math.max(0, Number(raw.count) || 0) : 0;
    if (limit > 0 && count >= limit) {
      return { ok: false, count, left: 0, limit };
    }
    const next = count + 1;
    writeRaw(dir, { ...raw, day, count: next });
    return { ok: true, count: next, left: limit > 0 ? Math.max(0, limit - next) : -1, limit };
  }, log);
}

/** 画失败了把名额退回去：失败不该占主人的额度。 */
export function refund(dir, { now = new Date(), log = () => {} } = {}) {
  locked(dir, () => {
    const day = dayOf(now);
    const raw = readRaw(dir);
    if (raw.day !== day) return;
    writeRaw(dir, { ...raw, day, count: Math.max(0, Math.round(Number(raw.count) || 0) - 1) });
  }, log);
}

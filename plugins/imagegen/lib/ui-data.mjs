/**
 * 面板数据（0.2）
 * ==============
 *
 * 宿主读扩展目录里的 `ui-data.json`，按 `plugin.json` 的 `ui.view.fields`
 * 白名单渲染，并把 `meta` 透传给扩展自己的页面。两条硬约束：
 *
 *   1. **rows 只写白名单字段**，字段名必须和 `ui.view.fields` 一一对应；
 *   2. **meta 只放标量**（数组会被 `String()` 掉，图库数组另写 `gallery.json`）。
 *
 * 0.2 有**两个进程**会写这个文件：MCP 子进程（模型画图）和宿主进程内的
 * 面板动作（点按钮测试生图）。所以「读 → 合并 → 写」整段要跨进程加锁，
 * 否则两个进程各自读到旧 meta、各自整份覆盖，对方刚写的状态就没了。
 * 对抗测试还实测到 Windows 上 `renameSync` 覆盖被另一进程读着的目标会
 * 抛 EPERM，所以写盘本身也带几次短重试。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bytesText } from './paint.mjs';
import { sleepSync, withFileLock } from './lock.mjs';

export const UI_FILE = 'ui-data.json';

const pad = (n) => String(n).padStart(2, '0');

/** 时间写成 `11-14 03:15`：面板一行放得下，跨年也不至于看不懂。 */
export function whenText(ms) {
  const n = Number(ms) || 0;
  if (!n) return '';
  const d = new Date(n);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 画作列表 → 面板行。
 * 字段名必须和 `plugin.json` 的 `ui.view.fields` 一一对应，由测试守住。
 */
export function rowsOf(items = []) {
  const list = Array.isArray(items) ? items : [];
  return list.map((it) => ({
    prompt: String(it?.prompt ?? '').slice(0, 120) || '(没记提示词)',
    when: whenText(it?.at),
    size: bytesText(it?.bytes),
    file: String(it?.file ?? '').slice(0, 120),
  }));
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function createUiData({ dir, log = () => {} } = {}) {
  const file = () => join(dir, UI_FILE);

  /** 读不到 / 半截文件都当空：面板没数据不该让扩展起不来 */
  function read() {
    try {
      const j = JSON.parse(readFileSync(file(), 'utf8'));
      if (!isObj(j)) return { rows: [], meta: {} };
      return {
        rows: Array.isArray(j.rows) ? j.rows : [],
        meta: isObj(j.meta) ? j.meta : {},
      };
    } catch {
      return { rows: [], meta: {} };
    }
  }

  /**
   * 先写临时文件再 rename：面板随时可能来读，不能让它读到半截 JSON。
   * Windows 上目标文件被别的进程读着时 rename 会 EPERM，短重试几次即可。
   */
  function writeRaw(rows, meta) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const tmp = `${file()}.${process.pid}.${attempt}.tmp`;
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(tmp, `${JSON.stringify({ updatedAt: Date.now(), rows, meta }, null, 0)}\n`, 'utf8');
        renameSync(tmp, file());
        return true;
      } catch (e) {
        const retryable = ['EPERM', 'EACCES', 'EBUSY'].includes(e?.code);
        if (!retryable || attempt === 2) {
          log(`面板数据写盘失败：${e?.message ?? e}`);
          return false;
        }
        sleepSync(5 + attempt * 10);
      } finally {
        /** EPERM 失败时 tmp 还留着；每轮都回收，别在扩展目录里攒垃圾 */
        try { unlinkSync(tmp); } catch { /* rename 成功后本来就不在了 */ }
      }
    }
    return false;
  }

  /** 所有读-改-写共用一把锁，锁名与文件名绑定 */
  const locked = (fn) => withFileLock(dir, UI_FILE, fn, { log });

  return {
    file,
    read,
    /** 整份写 rows，meta 保留磁盘上那份（另一进程可能刚写过） */
    write(rows = []) {
      return locked(() => writeRaw(rows, read().meta));
    },
    /**
     * 只改自己这几个状态字段，其余保留。
     * `patch` 只接标量：传对象/数组会被宿主透传时 `String()` 掉，
     * 看着像写进去了、页面上却是一坨 `[object Object]`。
     */
    setMeta(patch = {}) {
      if (!isObj(patch)) return false;
      return locked(() => {
        const cur = read();
        const next = { ...cur.meta };
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) continue;
          if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) next[k] = v;
          else next[k] = String(v);
        }
        return writeRaw(cur.rows, next);
      });
    },
    /**
     * 从画作列表写一份（零额外请求）。
     *
     * 默认**空列表不覆盖**：目录读失败时 `listPaintings()` 也返回空数组，
     * 直接写会把面板清空。删光最后一张是明确动作，调用方传
     * `{ allowEmpty: true }` 才真的写空。
     */
    fromGallery(items = [], { allowEmpty = false } = {}) {
      return locked(() => {
        const rows = rowsOf(items);
        if (!rows.length && !allowEmpty) return false;
        const ok = writeRaw(rows, read().meta);
        if (ok) log(`面板数据已更新：${rows.length} 条`);
        return ok;
      });
    },
  };
}

/**
 * 面板数据文件（6.1 声明式界面）
 * ============================
 *
 * 宿主的面板不执行扩展代码，只读扩展目录里的一个 JSON（`ui-data.json`）
 * 并按 `plugin.json` 里声明的字段白名单渲染。所以这个文件是**唯一**的
 * 「扩展 → 面板」通道，写的时候要守两条：
 *
 *   1. **只写白名单里的字段**。多写没用（宿主会丢掉），但会让人误以为
 *      那些字段生效了。
 *   2. **只写标量**。宿主会把对象/数组清空——想表达「多个标签」就拼成
 *      `"热门 · 游戏"` 这样的字符串，别塞数组。
 *
 * ## 什么时候写
 *
 * 默认两个时机，都**不额外发请求**：
 *   · 进程启动后，拉一次热门（面板第一次打开就有东西看）；
 *   · 每次 `hot` 工具被调用之后，把刚拉到的那一份写下来。
 *
 * 0.3 的可选定时刷（默认关）也会写一次，同样复用刚拉到的那一份。
 * 之所以默认关：MCP server 是长驻进程，定时抓等于装了扩展就一直在
 * 打 B 站接口，412 是迟早的事，而用户一天可能根本不打开面板。
 */

import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const UI_FILE = 'ui-data.json';

/** 播放量写成「195.4万」这种，面板上比 1954321 好读 */
function playText(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)}亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1)}万`;
  return String(v);
}

/** 时长 mm:ss / h:mm:ss */
function durText(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`;
}

/**
 * 把热门池收敛成面板能渲染的行。
 *
 * 字段名与 `plugin.json` 的 `ui.view.fields` **必须一一对应**，
 * 改一边就要改另一边（没有自动校验，两边都在这个目录里，改的时候看一眼）。
 */
export function rowsOf(items = []) {
  const list = Array.isArray(items) ? items : [];
  return list.map((v) => ({
    title: String(v?.title ?? '').slice(0, 120),
    author: String(v?.author ?? '').slice(0, 40),
    playText: playText(v?.play),
    durText: durText(v?.duration),
    area: String(v?.tname ?? ''),
    cover: String(v?.cover ?? ''),
    url: v?.bvid ? `https://www.bilibili.com/video/${v.bvid}` : '',
    at: Number(v?.pubdate) || 0,
  }));
}

export function createUiData({ dir, log = () => {} } = {}) {
  const file = () => join(dir, UI_FILE);

  /**
   * 写盘：先写临时文件再 rename。
   * 面板随时可能来读，直接覆盖会读到半截 JSON（那时面板显示「数据文件不是
   * 合法 JSON」，看起来像扩展坏了）。
   */
  function write(rows) {
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file()}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ updatedAt: Date.now(), rows }, null, 0)}\n`, 'utf8');
      renameSync(tmp, file());
      log(`面板数据已更新：${rows.length} 条`);
      return true;
    } catch (e) {
      log(`面板数据写盘失败：${e?.message || e}`);
      return false;
    }
  }

  return {
    /** 从已拉到的热门池写一份（零额外请求） */
    fromPool(items) {
      const rows = rowsOf(items);
      /** 空池不覆盖旧数据：一次失败不该把面板清空 */
      if (!rows.length) return false;
      return write(rows);
    },
    write,
    file,
  };
}

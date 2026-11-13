/**
 * 面板数据（6.1 声明式界面）
 * ========================
 *
 * 宿主的面板**不执行扩展代码**，只读扩展目录里的 `ui-data.json`，
 * 再按 `plugin.json` 的 `ui.view.fields` 白名单渲染。所以这个文件是
 * 唯一的「扩展 → 面板」通道，两条硬约束：
 *
 *   1. **只写白名单里的字段**（多写的会被宿主丢掉，但会让人以为生效了）；
 *   2. **只写标量**（对象/数组会被清空）。
 *
 * 图片字段（`type: 'image'`）只收 http(s) 地址，宿主不会去读本地文件——
 * 所以画作缩略图这一版**放不上面板**，只能显示文件名/提示词/时间。
 * 想让面板显示缩略图得宿主补一个「扩展目录文件」路由，那是另一件事（见 README）。
 *
 * ## 什么时候写
 *
 * 只在**画完一张 / 删掉一张之后**写，不额外发请求、不定时轮询。
 * 面板没打开时也照写：文件很小，写完就不管了。
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bytesText } from './paint.mjs';

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
 *
 * 字段名必须和 `plugin.json` 的 `ui.view.fields` 一一对应，
 * 由 `test/ui-data.mjs` 里的断言守住（改一边不改另一边会让面板空白）。
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

export function createUiData({ dir, log = () => {} } = {}) {
  const file = () => join(dir, UI_FILE);

  /** 先写临时文件再 rename：面板随时可能来读，不能让它读到半截 JSON。 */
  function write(rows) {
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file()}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ updatedAt: Date.now(), rows }, null, 0)}\n`, 'utf8');
      renameSync(tmp, file());
      log(`面板数据已更新：${rows.length} 条`);
      return true;
    } catch (e) {
      log(`面板数据写盘失败：${e?.message ?? e}`);
      return false;
    }
  }

  return {
    /** 从画作列表写一份（零额外请求） */
    fromGallery(items) {
      const rows = rowsOf(items);
      /** 空列表不覆盖：删光了才该变空，读失败不该把面板清空 */
      if (!rows.length) return false;
      return write(rows);
    },
    write,
    file,
  };
}

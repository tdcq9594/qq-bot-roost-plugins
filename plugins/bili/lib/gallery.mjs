/**
 * 截图库
 * ============================================================
 *
 * 刷一轮时自动抽的帧、以及手动 `shot` 抽的帧都落在扩展的 `shots/` 下，
 * 文件名是 `<BV号>-<秒数>.jpg`。面板按这个约定扫目录生成缩略图墙——
 * 不额外维护索引文件：多一份索引就多一处不一致（删了图忘了改索引、
 * 索引写坏了图还在），而扫几十个文件是微秒级的事。
 *
 * 两个刻意的约束：
 *   · **只认这个命名规则**，别把用户丢进同目录的其它文件算进来；
 *   · 缩略图走 `/ext-pages`，所以路径必须能在扩展目录内解析到
 *     （`shots/xxx.jpg`），这也是截图默认落在扩展目录的原因。
 */

import { mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** `BV1xx411c7mD-30.jpg` → `{ bvid, at }` */
const NAME_RE = /^(BV[0-9A-Za-z]{10})-(\d+)\.jpg$/;

/**
 * 列出图库里的截图，新的在前。
 *
 * @param {{dir: string, limit?: number}} o
 * @returns {{items: Array<{file:string,bvid:string,at:number,bytes:number,takenAt:number}>, total:number}}
 */
export function listShots({ dir, limit = 60 } = {}) {
  const root = String(dir || '').trim();
  if (!root) return { items: [], total: 0 };

  let names = [];
  try {
    names = readdirSync(root);
  } catch {
    /** 目录还没有：第一次装、还没抽过帧，不是错误 */
    return { items: [], total: 0 };
  }

  const all = [];
  for (const name of names) {
    const m = NAME_RE.exec(name);
    if (!m) continue;
    try {
      const st = statSync(join(root, name));
      if (!st.isFile() || st.size < 500) continue;
      all.push({
        /** 相对扩展目录的路径：页面直接拼到 `/ext-pages` 上 */
        file: `shots/${name}`,
        bvid: m[1],
        at: Number(m[2]),
        bytes: st.size,
        takenAt: st.mtimeMs,
      });
    } catch { /* 正好被清理掉：跳过 */ }
  }

  all.sort((a, b) => b.takenAt - a.takenAt);
  return { items: all.slice(0, Math.max(1, Math.min(300, Number(limit) || 60))), total: all.length };
}

/**
 * 图库里现在有多少张（面板上的「n / 上限」用它）。
 *
 * **复用 `listShots`**，不要自己数文件名：那些「名字对、文件是半截」的
 * 也要排除（写盘中断、磁盘满都会留下几百字节的坏图），否则列表里显示 8 张、
 * 标题写 9 张，用户只会觉得哪里不对。
 */
export function countShots({ dir } = {}) {
  return listShots({ dir, limit: 300 }).total;
}

/**
 * 写一份 `shots/index.json` 给面板读。
 *
 * 为什么要这份索引：宿主透传的 meta 只支持**一层标量对象**，数组会被
 * `String()` 掉。图库是几十条记录，塞不进 meta；而页面又不能自己列目录。
 * 所以由扩展在抽帧后顺手写一份清单。
 *
 * 它是**派生数据**：写失败、过期、被删掉都不影响主流程——面板上少几张图而已，
 * 下一次抽帧会重写。
 */
export function writeIndex({ dir, limit = 60 } = {}) {
  const root = String(dir || '').trim();
  if (!root) return false;
  const { items, total } = listShots({ dir: root, limit });
  try {
    mkdirSync(root, { recursive: true });
    const tmp = join(root, 'index.json.tmp');
    writeFileSync(tmp, `${JSON.stringify({ updatedAt: Date.now(), total, items }, null, 0)}\n`, 'utf8');
    /** 先写临时文件再改名：面板随时可能来读，别让它读到半截 JSON */
    renameSync(tmp, join(root, 'index.json'));
    return true;
  } catch {
    return false;
  }
}

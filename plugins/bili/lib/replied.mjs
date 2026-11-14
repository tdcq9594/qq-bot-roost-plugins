import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'replied.json';

/**
 * 「已经回过的评论」名单。
 *
 * 为什么必须存盘：她每轮都会看到同一批「有人回了你」，不记下来的话
 * 同一句话会被回十遍。`replies.json` 里那份 `seen` 是给**面板未读**用的，
 * 语义不同（看过 ≠ 回过），所以分开存，互不干扰。
 *
 * 只留最近 `limit` 条：B 站评论 id 是数字串，几百条足够覆盖「还在对话」的窗口。
 *
 * @param {{dir?: string, limit?: number, log?: Function}} [o]
 */
export function createRepliedStore({ dir = '', limit = 300, log = () => {} } = {}) {
  const root = String(dir || '').trim();
  const max = Math.max(20, Math.min(2000, Math.round(Number(limit) || 300)));
  const file = () => join(root, FILE);

  function read() {
    if (!root) return [];
    try {
      const j = JSON.parse(readFileSync(file(), 'utf8'));
      return Array.isArray(j?.ids) ? j.ids.filter((x) => typeof x === 'string') : [];
    } catch {
      /** 没有文件 / 文件坏了：从空开始，不抛 */
      return [];
    }
  }

  let ids = read();

  return {
    has(id) {
      return ids.includes(String(id ?? '').trim());
    },
    /** 记一条；返回是否真的新增 */
    add(id) {
      const v = String(id ?? '').trim();
      if (!v || ids.includes(v)) return false;
      ids = [...ids, v].slice(-max);
      try {
        const tmp = `${file()}.tmp`;
        /** 先写临时文件再改名：面板随时可能来读，别让它读到半截 JSON */
        writeFileSync(tmp, `${JSON.stringify({ ids }, null, 0)}\n`, 'utf8');
        renameSync(tmp, file());
      } catch (e) {
        log(`记「已回复」失败（不影响这次回复）：${e?.message ?? e}`);
      }
      return true;
    },
    all: () => ids.slice(),
    /** 测试用：清空内存与文件 */
    _reset() {
      ids = [];
      try { writeFileSync(file(), '{"ids":[]}\n', 'utf8'); } catch { /* 忽略 */ }
    },
  };
}

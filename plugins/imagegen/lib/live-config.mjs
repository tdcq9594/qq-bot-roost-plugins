/**
 * 配置热读（0.2，照 bili 扩展的同一套做法）
 * =========================================
 *
 * 面板改设置时，宿主写的是它自己那两个文件，**不会**重启这个 MCP 子进程
 * （受管块里的静态 `mcp-<id>` 条目不受 `mcpManager.restart()` 治理）。
 * 只读启动那一刻注入的 `ROOST_EXT_CONFIG`，表现就是「改了设置没反应，
 * 得重启 DSH」——0.1 的 README 里把这写成已知限制，其实是能修的。
 *
 *   `<数据目录>/extensions/<id>/config.json`   非敏感值（values 本体）
 *   `<数据目录>/secrets/<id>.config.json`      敏感值（`{ apiKey: '...' }`）
 *
 * 这两份文件的格式本来就是「面板读什么、扩展就读什么」，读文件是微秒级，
 * 还能靠 mtime 跳过没变的情况。比新增一个 HTTP 端点轻得多。
 *
 * 代价是与宿主的存储布局耦合了：所以每一处失败都**静默保留旧值**，
 * 布局变了顶多回到「要重启才能改设置」的老行为，不会把扩展弄挂。
 *
 * @param {{dataDir?: string, id?: string, apply: (values:object|null, secrets:object|null) => void}} o
 * @returns {() => boolean} `refresh()`：真的读到变化了返回 true
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function createLiveConfig({ dataDir = '', id = '', apply } = {}) {
  const root = String(dataDir || '').trim();
  const extId = String(id || '').trim();
  if (!root || !extId || typeof apply !== 'function') return () => false;

  const cfgFile = join(root, 'extensions', extId, 'config.json');
  const secFile = join(root, 'secrets', `${extId}.config.json`);

  /** 两份文件各自的 mtime：没变就不解析、不回调 */
  let cfgMtime = -1;
  let secMtime = -1;

  const mtimeOf = (f) => {
    try {
      return statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  };

  return function refresh() {
    let changed = false;
    let values = null;
    let secrets = null;

    const cm = mtimeOf(cfgFile);
    if (cm && cm !== cfgMtime) {
      try {
        const j = JSON.parse(readFileSync(cfgFile, 'utf8'));
        /** 正常形态就是 values 本体；也容忍 `{values:{...}}` 这种包了一层的写法 */
        const v = j && typeof j === 'object' && j.values && typeof j.values === 'object' ? j.values : j;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          values = v;
          cfgMtime = cm;
          changed = true;
        }
      } catch { /* 半截文件 / 被清空：保留旧值，下次再试 */ }
    }

    const sm = mtimeOf(secFile);
    if (sm && sm !== secMtime) {
      try {
        const j = JSON.parse(readFileSync(secFile, 'utf8'));
        if (j && typeof j === 'object' && !Array.isArray(j)) {
          secrets = j;
          secMtime = sm;
          changed = true;
        }
      } catch { /* 同上 */ }
    }

    if (changed) {
      try {
        apply(values, secrets);
      } catch {
        /** 回调自己出错不该让动作失败：配置退回旧值而已 */
        return false;
      }
    }
    return changed;
  };
}

/**
 * 配置热读（0.6）
 * ==============
 *
 * 面板上改设置，走的是「宿主保存 → 注入 env → 重启子进程」这条路。
 * 问题是**重启大概率失败**：受管块里的静态 `mcp-<id>` 条目不受
 * `mcpManager.restart()` 治理，宿主只能回一句「重启 DSH 后生效」。
 * 于是用户看到的就是「改了设置没反应」。
 *
 * 这里换一条路：直接读宿主保存的那两个文件。
 *
 *   `<数据目录>/extensions/<id>/config.json`   非敏感值（就是 values 本体）
 *   `<数据目录>/secrets/<id>.config.json`      敏感值（`{ cookie: '...' }`）
 *
 * 为什么不新增一个 HTTP 端点：宿主每存一次都要重新鉴权、扩展每次动作
 * 都要发一次本机请求，而这两个文件的格式本来就是「面板读什么、
 * 扩展就读什么」。读文件是微秒级，还能靠 mtime 直接跳过没变的情况。
 *
 * 代价是与宿主的存储布局耦合了。所以这里的每一处失败都**静默保留旧值**：
 * 布局变了顶多是「回到要重启才能改设置」的老行为，不会把扩展弄挂。
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {{dataDir?: string, id?: string, apply: (values:object, secrets:object) => void}} o
 * @returns {() => boolean} `refresh()`：真的读到变化了返回 true
 */
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

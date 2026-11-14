/**
 * ffmpeg 的定位（共享依赖）
 * ============================================================
 *
 * `shot` 抽帧要 ffmpeg。它**不再装在扩展自己的目录里**——扩展目录会被市场
 * 更新整体覆盖，卸载时还会被删，而且同一个 `ffmpeg` 别的功能（语音转码、
 * 图片处理）也要用，每个扩展各备一份 62 MB 没有意义。
 *
 * 现在装一份在宿主：`<dataDir>/deps/`，由面板的「装 ffmpeg」按钮触发。
 * 扩展这边只做两件事：**找到它**、**报状态**。
 *
 * 查找顺序：
 *
 *   1. 用户在设置里手填的路径（`ffmpegPath`）——最优先，尊重手动选择；
 *   2. 宿主共享目录 `ROOST_DEPS_DIR`；
 *   3. 旧位置：扩展自己的 `deps/`（0.5.x 装过的人不用重下）。
 *
 * 为什么不能只看 `require.resolve`：`@ffmpeg-installer/ffmpeg` 主包只有
 * 24 KB 胶水代码，62 MB 的 `ffmpeg.exe` 在同版本的平台子包
 * （`@ffmpeg-installer/win32-x64`）里。`--omit=optional`、杀毒隔离、装到
 * 一半断电，都会留下「主包在、二进制没了」的半坏状态——只 resolve 主包
 * 会报「已安装」，然后用户点抽帧时才炸。所以一律以**可执行文件在不在**为准。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 旧位置（0.5.x 装在扩展目录里）；现在只读不写 */
export const LEGACY_DEPS_DIR = 'deps';

/** 平台子包目录名；平台不认识就返回空串 */
function platformDir() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') return `win32-${arch}`;
  if (process.platform === 'darwin') return `darwin-${arch}`;
  if (process.platform === 'linux') return `linux-${arch}`;
  return '';
}

/** 在某个 deps 目录里找 ffmpeg 可执行文件；没有返回空串 */
function findIn(depsDir) {
  const plat = platformDir();
  if (!depsDir || !plat) return '';
  const base = join(depsDir, 'node_modules', '@ffmpeg-installer', plat);
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const p = join(base, exe);
  return existsSync(p) ? p : '';
}

/**
 * 宿主的共享依赖目录。
 *
 * `ROOST_DEPS_DIR` 是受管块新注入的；老受管块里没有这个键时，退回
 * `ROOST_LAUNCHER_DIR`（它指向宿主数据目录）拼一个 —— 这样「没重新安装
 * 受管块」的存量用户也能立刻用上共享目录，不必先去点一次重装。
 */
export function sharedDepsDir() {
  const direct = String(process.env.ROOST_DEPS_DIR || '').trim();
  if (direct) return direct;
  const data = String(process.env.ROOST_LAUNCHER_DIR || '').trim();
  return data ? join(data, 'deps') : '';
}

/**
 * 解析出可用的 ffmpeg 路径；都没有返回空串。
 *
 * @param {{root?: string, configured?: string}} [o]
 *   `root` 扩展目录（用于找旧位置），`configured` 用户手填的路径
 */
export function resolveFfmpeg({ root = '', configured = '' } = {}) {
  const manual = String(configured || '').trim();
  if (manual) {
    /** 手填的可能是「deps 目录」也可能是「ffmpeg 可执行文件」，两种都认 */
    const asDir = findIn(manual);
    if (asDir) return asDir;
    if (existsSync(manual)) return manual;
  }
  const shared = findIn(sharedDepsDir());
  if (shared) return shared;
  return root ? findIn(join(root, LEGACY_DEPS_DIR)) : '';
}

/**
 * 给面板看的状态。
 *
 * `dir` 用来在界面上告诉用户「装到哪了」——共享依赖最怕的就是
 * 「以为装在扩展里、其实装到宿主」这种认知错位。
 */
export function ffmpegState({ root = '', configured = '' } = {}) {
  const path = resolveFfmpeg({ root, configured });
  return {
    ready: Boolean(path),
    path,
    dir: sharedDepsDir(),
    legacy: Boolean(!path && root && findIn(join(root, LEGACY_DEPS_DIR))),
    configured: Boolean(String(configured || '').trim()),
  };
}

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
 * 三种来源，优先级从高到低：
 *   1. 调用方显式传入（**进程内动作走这条**：`ui/main.mjs` 跑在宿主进程里，
 *      `ROOST_DEPS_DIR` 是注入给 MCP 子进程的，宿主自己的 `process.env` 里没有）；
 *   2. `ROOST_DEPS_DIR`——MCP 子进程的标准来源；
 *   3. `ROOST_LAUNCHER_DIR`（指向宿主数据目录）拼一个——老受管块没有新键时的回退。
 */
export function sharedDepsDir(explicit = '') {
  const first = depsCandidates(explicit)[0];
  return first || '';
}

/**
 * 共享依赖目录的**候选列表**，按可信度排序。
 *
 * 为什么不是一个路径：这三条来源都可能过期。
 *   · 受管块里的 `ROOST_DEPS_DIR` 是**渲染那一刻**算出来的——用户后来改了
 *     宿主数据目录（`DSH_ROOST_DATA`），受管块里还是旧路径；
 *   · `ROOST_LAUNCHER_DIR` 指向宿主数据目录，跟着受管块一起过期；
 *   · 进程内动作由宿主每次现传（最可信）。
 *
 * 所以调用方要**逐个试**，谁下面真有 ffmpeg 就用谁。只取第一个非空值，
 * 等于把「路径过期」变成「明明装好了却说没装」。
 *
 * @param {string} [explicit] 调用方显式给的目录（宿主会传最新的那个）
 * @returns {string[]} 去重后的候选，可能为空
 */
export function depsCandidates(explicit = '') {
  const out = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  push(explicit);
  push(process.env.ROOST_DEPS_DIR);
  const data = String(process.env.ROOST_LAUNCHER_DIR || '').trim();
  if (data) push(join(data, 'deps'));
  return out;
}

/**
 * 解析出可用的 ffmpeg 路径；都没有返回空串。
 *
 * @param {{root?: string, configured?: string, depsDir?: string}} [o]
 *   `root` 扩展目录（用于找旧位置），`configured` 用户手填的路径，
 *   `depsDir` 显式指定共享目录
 */
export function resolveFfmpeg({ root = '', configured = '', depsDir = '' } = {}) {
  const manual = String(configured || '').trim();
  if (manual) {
    /** 手填的可能是「deps 目录」也可能是「ffmpeg 可执行文件」，两种都认 */
    const asDir = findIn(manual);
    if (asDir) return asDir;
    if (existsSync(manual)) return manual;
  }
  /** 逐个候选试：谁下面真有 ffmpeg 就用谁（见 depsCandidates 的注释） */
  for (const dir of depsCandidates(depsDir)) {
    const hit = findIn(dir);
    if (hit) return hit;
  }
  return root ? findIn(join(root, LEGACY_DEPS_DIR)) : '';
}

/**
 * 给面板看的状态。
 *
 * `dir` 用来在界面上告诉用户「装到哪了」——共享依赖最怕的就是
 * 「以为装在扩展里、其实装到宿主」这种认知错位。
 */
export function ffmpegState({ root = '', configured = '', depsDir = '' } = {}) {
  const path = resolveFfmpeg({ root, configured, depsDir });
  /** `dir` 要显示**真正用了哪个**，不能显示候选里的第一个（那可能是过期路径） */
  const used = path
    ? (depsCandidates(depsDir).find((d) => findIn(d)) || sharedDepsDir(depsDir))
    : sharedDepsDir(depsDir);
  return {
    ready: Boolean(path),
    path,
    dir: used,
    legacy: Boolean(!path && root && findIn(join(root, LEGACY_DEPS_DIR))),
    configured: Boolean(String(configured || '').trim()),
  };
}

/**
 * 扩展自带的 ffmpeg（一键安装）
 * ============================================================
 *
 * `shot` 抽帧要 ffmpeg。让用户自己去装、再回来填路径，是这条链路上最烦的
 * 一步；框架那边已经有「一键装 `@ffmpeg-installer/ffmpeg`」的先例，
 * 这里做同一件事，只是把包装进**扩展自己的 `deps/`**，不碰系统环境。
 *
 * 两个注意点：
 *
 *   1. 主包只有 24 KB 胶水代码，62 MB 的 `ffmpeg.exe` 在同版本的平台子包里
 *      （`@ffmpeg-installer/win32-x64`）。所以「装没装」以**可执行文件在不在**
 *      为准，不能只看 `require.resolve`。
 *   2. `deps/` 在扩展目录里，会和 `ui-data.json` 一起被算进市场索引的 sha256。
 *      `build-index.mjs` 已经排除运行时产物，这里把目录名固定成 `deps`，
 *      由构建脚本按名字跳过（见脚本里的 `IGNORE_DIRS`）。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

export const DEPS_DIR = 'deps';
const PKG = '@ffmpeg-installer/ffmpeg';

/** 平台子包目录名；平台不认识就返回空串 */
function platformDir() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') return `win32-${arch}`;
  if (process.platform === 'darwin') return `darwin-${arch}`;
  if (process.platform === 'linux') return `linux-${arch}`;
  return '';
}

/** 装好之后 ffmpeg 可执行文件的绝对路径；没装 / 平台不支持返回空串 */
export function bundledFfmpeg(root) {
  const plat = platformDir();
  if (!root || !plat) return '';
  const base = join(root, DEPS_DIR, 'node_modules', '@ffmpeg-installer', plat);
  for (const exe of process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg']) {
    const p = join(base, exe);
    if (existsSync(p)) return p;
  }
  return '';
}

/**
 * 一键安装。串行由调用方保证（按钮连点会被动作队列的去重挡掉）。
 *
 * 返回 `{ ok, path?, message }`，不抛：装失败要把原因原样带给面板。
 */
export function installFfmpeg(root, { log = () => {}, timeoutMs = 300_000 } = {}) {
  if (!root) return Promise.resolve({ ok: false, message: '没有扩展目录' });
  const already = bundledFfmpeg(root);
  if (already) return Promise.resolve({ ok: true, path: already, message: '已经装好了' });

  const dir = join(root, DEPS_DIR);
  try {
    mkdirSync(dir, { recursive: true });
    /** npm 需要一个 package.json 才能当项目目录用；没有就补一个最小的 */
    const pkgFile = join(dir, 'package.json');
    if (!existsSync(pkgFile)) {
      writeFileSync(pkgFile, `${JSON.stringify({ name: 'bili-deps', private: true, version: '1.0.0' }, null, 2)}\n`, 'utf8');
    }
  } catch (e) {
    return Promise.resolve({ ok: false, message: `建目录失败：${e?.message ?? e}` });
  }

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  log(`开始安装 ${PKG}（约 62 MB，首次会慢一点）`);
  return new Promise((resolve) => {
    execFile(
      npm,
      ['install', PKG, '--no-audit', '--no-fund', '--loglevel=error'],
      { cwd: dir, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          const why = String(stderr || err.message || '').trim().slice(0, 400);
          log(`安装失败：${why}`);
          return resolve({ ok: false, message: `安装失败：${why || '未知原因'}` });
        }
        const bin = bundledFfmpeg(root);
        if (!bin) {
          return resolve({ ok: false, message: '装完了但没找到 ffmpeg 可执行文件（平台子包可能没装上）' });
        }
        log(`ffmpeg 已就绪：${bin}`);
        resolve({ ok: true, path: bin, message: '装好了' });
      },
    );
  });
}

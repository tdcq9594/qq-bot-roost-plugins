/**
 * 共用底座：路径、原子写、跨进程锁、读取小工具。
 *
 * 数据目录按 DSH 的数据根来算，**不硬编码用户名**：
 *   宿主注入 ROOST_LAUNCHER_DIR（`~/.dsh/dsh-roost`）→ 上一级就是 `~/.dsh`
 *   拿不到就退回 `os.homedir()/.dsh`
 * 最终数据落在 `<DSH数据目录>/extension-data/sticker-reply/`。
 */

import {
  readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync,
  openSync, closeSync, unlinkSync, readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

/**
 * 扩展代码目录（本文件在 `<ext>/lib/` 下）。
 *
 * **必须用 `fileURLToPath`**：`new URL(...).pathname` 是百分号转义的，
 * 用户名里有中文时整段路径会变成 `%E5%BC%A0…` 这样的转义串，于是内置图目录
 * 一个文件都扫不到（真机上装完就是"14 张图一张都不显示"）。
 */
export const EXT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** DSH 数据根 */
export function dshDataDir() {
  if (process.env.STICKER_REPLY_DATA_DIR) return process.env.STICKER_REPLY_DATA_DIR;
  const launcher = String(process.env.ROOST_LAUNCHER_DIR || '').trim();
  if (launcher) return dirname(launcher); // ~/.dsh/dsh-roost → ~/.dsh
  return join(homedir(), '.dsh');
}

/** 扩展自己的数据目录（标注、配置、运行记录） */
export function dataDir() {
  const d = join(dshDataDir(), 'extension-data', 'sticker-reply');
  mkdirSync(d, { recursive: true });
  return d;
}

export const PATHS = {
  get annotations() { return join(dataDir(), 'annotations.json'); },
  get settings() { return join(dataDir(), 'settings.json'); },
  get usage() { return join(dataDir(), 'recent.json'); },
  get last() { return join(dataDir(), 'last.json'); },
  get lock() { return join(dataDir(), '.write.lock'); },
};

export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** 原子写：先写临时文件再 rename，避免读到半个 JSON */
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  renameSync(tmp, file);
}

/**
 * 跨进程写锁。
 *
 * 管理页面（宿主进程内）与 MCP 子进程会同时写标注文件，没有锁就会互相覆盖。
 * 锁文件超过 10 秒视为持有者已崩，强制拆除。
 */
export async function withLock(fn, { timeoutMs = 3000, waitMs = 25 } = {}) {
  const file = PATHS.lock;
  const started = Date.now();
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync(file, 'wx');
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(file).mtimeMs > 10_000) unlinkSync(file);
      } catch { /* 别人刚删掉 */ }
      if (Date.now() - started > timeoutMs) throw new Error('标注文件正被另一个进程写入，请稍后重试');
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  try {
    return await fn();
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(file); } catch { /* ignore */ }
  }
}

/** 该扩展内置的默认图片目录 */
export const DEFAULT_DIR = join(EXT_ROOT, 'assets', 'default');

/** 支持的图片扩展名 */
export const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

export function isImageFile(name = '') {
  const m = /\.[^.]+$/.exec(String(name));
  return Boolean(m) && IMAGE_EXT.has(m[0].toLowerCase());
}

/** 列出目录：跳过符号链接与不可读项；一层子目录 */
export function listImageFiles(dir) {
  const out = [];
  const push = (d, file) => {
    const full = join(d, file);
    try {
      const st = statSync(full);
      if (!st.isFile()) return;
      out.push({ path: full, size: st.size, mtime: st.mtimeMs });
    } catch { /* 读不到就跳过 */ }
  };
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    if (e.isFile() && isImageFile(e.name)) { push(dir, e.name); continue; }
    if (!e.isDirectory()) continue;
    // 只下钻一层
    let sub;
    try { sub = readdirSync(join(dir, e.name), { withFileTypes: true }); } catch { continue; }
    for (const s of sub) {
      if (s.isSymbolicLink() || !s.isFile()) continue;
      if (isImageFile(s.name)) push(join(dir, e.name), s.name);
    }
  }
  return out;
}

export function exists(p) {
  try { return existsSync(p); } catch { return false; }
}

/** 导出图库：受管清单 + 不覆盖用户文件。 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { api } from './api.mjs';
import { dataDir, readJson, withLock, writeJson } from './shared.mjs';
import { listAnnotated, loadSettings, sha256Of } from './store.mjs';

const OWNER = 'sticker-reply';
export const libraryDir = () => join(dataDir(), 'library');
const manifestPath = () => join(libraryDir(), '.sticker-reply.json');
const validFile = (name) => typeof name === 'string' && name === basename(name) && !/[\\/]/.test(name) && !name.startsWith('.');
const clean = (value) => String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/g, '').trim();

export function exportName(image) {
  const label = [image.name, ...(image.tags || []).slice(0, 4)].map(clean).filter(Boolean).join('_');
  return `${(label || '表情').slice(0, 62)}_${image.id.slice(0, 12)}${extname(image.path).toLowerCase()}`;
}

function manifest() {
  const old = readJson(manifestPath(), null);
  return old?.owner === OWNER && Array.isArray(old.files) ? old : null;
}

export function libraryStatus() {
  const old = manifest();
  return { directory: libraryDir(), published: Boolean(old), count: old?.files?.length || 0, exportedAt: old?.at || null };
}

function assertRegularOrMissing(file) {
  try {
    const s = lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink()) throw new Error('导出目标不是普通文件');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

/** 同名但内容不同时，退一个不冲突的新名字（保留用户文件，也不丢这张图） */
function altName(file, taken) {
  const ext = extname(file);
  const stem = file.slice(0, -ext.length);
  for (let i = 1; i < 100; i += 1) {
    const next = `${stem}_${i}${ext}`;
    if (!taken.has(next) && !existsSync(join(libraryDir(), next))) return next;
  }
  return '';
}

/**
 * 导出已标注且启用的图片。
 *
 * 三条硬规矩：
 *   1. 只覆盖**自己清单登记过、且内容仍是上次写的那份**的文件；
 *   2. 目录里非受管的同名文件、或用户替换过的副本，一律保留，改用备用名导出；
 *   3. 每种冲突都记进 `conflicts` 让页面显示，不静默跳过。
 */
export async function exportLibrary() {
  return withLock(async () => {
    const dir = libraryDir();
    mkdirSync(dir, { recursive: true });
    const dirStat = lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('导出目录必须是普通目录');

    const settings = loadSettings();
    const scan = listAnnotated(settings);
    const images = settings.enabled === false
      ? []
      : scan.images.filter((i) => !i.missing && i.enabled !== false && String(i.meaning || '').trim());

    const old = manifest();
    const managed = new Map((old?.files || []).map((f) => [f.file, f.id]));
    const files = [];
    const conflicts = [];
    const taken = new Set();

    for (const image of images) {
      if (sha256Of(image.path) !== image.id) {
        conflicts.push({ file: exportName(image), reason: '来源已改变，请重新扫描' });
        continue;
      }
      const desired = exportName(image);
      if (!validFile(desired)) { conflicts.push({ file: image.file, reason: '导出名称不合法' }); continue; }

      /**
       * 选目标名：**每一轮都重新校验**。
       *
       * 只校验一次是不够的——换成备用名之后，那个名字本身也可能被用户占着/改过，
       * 于是"换个名字再覆盖"照样毁用户文件（预检报告第 1 条的第二段就是这样复现的）。
       * 因此这里循环：只要目标被占用且不是"我们写的、且内容没被改"，就再退一个名字。
       */
      const targetOf = (name) => join(dir, name);
      const exists = (name) => existsSync(join(dir, name));
      const contentOf = (name) => (exists(name) ? sha256Of(join(dir, name)) : '');

      let file = desired;
      let chosen = '';
      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (!exists(file)) { chosen = file; break; }
        const recorded = managed.get(file);
        const now = contentOf(file);
        if (recorded === image.id && now === recorded) { chosen = file; break; } // 自己的、没被改过
        const why = recorded === undefined
          ? '目录里已有同名文件（非本扩展导出），保留原文件'
          : now !== recorded
            ? '用户替换过这个副本，保留用户文件'
            : '同名文件内容不符，保留原文件';
        const alt = altName(file, new Set([...taken, ...managed.keys()]));
        conflicts.push({ file, reason: why, usedName: alt || '' });
        if (!alt) break;
        file = alt;
      }
      if (!chosen) continue;
      file = chosen;

      const target = targetOf(file);
      assertRegularOrMissing(target);
      if (!existsSync(target) || sha256Of(target) !== image.id) {
        const tmp = join(dir, `.${randomUUID()}.tmp`);
        try { copyFileSync(image.path, tmp); renameSync(tmp, target); }
        finally { if (existsSync(tmp)) unlinkSync(tmp); }
      }
      taken.add(file);
      files.push({ id: image.id, file });
    }

    // 清理：只删"清单登记 + 内容仍一致"的旧副本
    const keep = new Set(files.map((f) => f.file));
    const removed = [];
    for (const entry of old?.files || []) {
      if (!validFile(entry.file) || keep.has(entry.file)) continue;
      const p = join(dir, entry.file);
      assertRegularOrMissing(p);
      if (existsSync(p) && sha256Of(p) === entry.id) { unlinkSync(p); removed.push(entry.file); }
    }

    writeJson(manifestPath(), { owner: OWNER, version: 1, at: Date.now(), files });
    return { ...libraryStatus(), removed, conflicts, errors: scan.errors };
  });
}

export async function syncPublishedLibrary() {
  return manifest() ? exportLibrary() : libraryStatus();
}

export function dependencyState(values = {}, directory = libraryDir()) {
  const raw = values['stickers.dir'];
  const roots = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String).filter(Boolean);
  const normalize = (p) => {
    const result = resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? result.toLowerCase() : result;
  };
  const enabled = values['stickers.enabled'] === true;
  const configured = roots.some((p) => normalize(p) === normalize(directory));
  return { available: true, enabled, configured, roots, directory, ready: enabled && configured };
}

export function connectionState(hostState, { extensionEnabled, exportedCount }) {
  return {
    ...hostState,
    hostReady: hostState.ready === true,
    extensionEnabled,
    exportedCount,
    ready: hostState.ready === true && extensionEnabled === true && exportedCount > 0,
  };
}

/** 实际存在的受管副本数量（清单登记但被删掉的不算） */
export function exportedCount() {
  return (manifest()?.files || []).filter((entry) => {
    if (!validFile(entry.file)) return false;
    try {
      const s = lstatSync(join(libraryDir(), entry.file));
      return s.isFile() && !s.isSymbolicLink();
    } catch { return false; }
  }).length;
}

export async function checkBuiltinDependency() {
  try {
    const r = await api('/v1/config?keys=stickers.enabled,stickers.dir', { timeoutMs: 3000 });
    if (!r.values || !Object.hasOwn(r.values, 'stickers.enabled')) throw new Error('宿主未返回内置表情开关');
    return connectionState(dependencyState(r.values), {
      extensionEnabled: loadSettings().enabled !== false,
      exportedCount: exportedCount(),
    });
  } catch (e) {
    return {
      available: false, enabled: null, configured: null, ready: false,
      directory: libraryDir(), error: String(e.message || e),
    };
  }
}

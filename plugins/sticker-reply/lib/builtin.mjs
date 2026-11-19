/** 导出图库：受管清单 + 不覆盖用户文件。 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { api } from './api.mjs';
import { EXT_ROOT, dataDir, readJson, withLock, writeJson } from './shared.mjs';
import { listAnnotated, loadSettings, sha256Of } from './store.mjs';

const OWNER = 'sticker-reply';
/**
 * 图库目录：设置里有绝对路径就用它，否则用默认位置。
 *
 * 直接修改设置只影响以后的导出；面板保存目录会调用 migrateLibrary
 * 迁移清单登记且未被修改的副本，用户文件保留。
 */
export const DEFAULT_LIBRARY = () => join(dataDir(), 'library');

/** 同一目录的路径别名，Windows 上忽略大小写；已有目录解析物理路径。 */
function pathIdentity(value) {
  let full = resolve(value);
  try { full = realpathSync(full); } catch { /* 新目录尚未创建 */ }
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

export function libraryDir() {
  const custom = String(loadSettings().libraryDir || '').trim();
  return custom || DEFAULT_LIBRARY();
}

/** 校验用户填的目录：必须是绝对路径，且不能落在扩展代码目录里 */
export function checkLibraryDir(raw) {
  const value = String(raw || '').trim();
  if (!value) return { ok: true, dir: '' };
  if (!isAbsolute(value)) return { ok: false, reason: '要填绝对路径，例如 D:\\表情图库' };
  const resolved = resolve(value);
  const key = pathIdentity(resolved);
  const codeRoot = pathIdentity(EXT_ROOT);
  if (key === codeRoot || key.startsWith(`${codeRoot}${sep}`)) {
    return { ok: false, reason: '不能放在扩展自己的代码目录里（升级会覆盖）' };
  }
  return { ok: true, dir: resolved };
}
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
function altNameIn(dir, file, taken = new Set()) {
  const ext = extname(file);
  const stem = file.slice(0, -ext.length);
  for (let i = 1; i < 100; i += 1) {
    const next = `${stem}_${i}${ext}`;
    if (!taken.has(next) && !existsSync(join(dir, next))) return next;
  }
  return '';
}

const altName = (file, taken) => altNameIn(libraryDir(), file, taken);

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

/**
 * 把旧图库目录里**我们自己导出的副本**搬到新目录。
 *
 * 三条边界：
 *   · 只搬清单登记过、且内容仍是上次写的那份（用户改过的留在原地）；
 *   · 新目录已有受管同内容副本 → 删除源副本，视为已迁移；未受管文件不接管；
 *   · 目标同名但内容不同 → 换备用名，绝不覆盖。
 * 旧目录里的其它文件（用户自己放的）一个都不动；旧目录空了才删。
 */
export async function migrateLibrary(from, to) {
  const srcDir = String(from || '').trim();
  const dstDir = String(to || '').trim();
  const empty = { moved: 0, alreadyThere: 0, leftBehind: [], conflicts: [], removedOldDir: false, reason: '' };
  if (!srcDir || !dstDir) return { ...empty, reason: '没有旧目录或新目录' };
  if (pathIdentity(srcDir) === pathIdentity(dstDir)) return { ...empty, reason: '目录没变' };

  const man = readJson(join(srcDir, '.sticker-reply.json'), null);
  if (!man || man.owner !== OWNER || !Array.isArray(man.files)) {
    return { ...empty, reason: '旧目录里没有本扩展的导出清单，不做迁移' };
  }
  mkdirSync(dstDir, { recursive: true });

  const out = { ...empty, conflicts: [], leftBehind: [] };
  const targetManifest = readJson(join(dstDir, '.sticker-reply.json'), null);
  const kept = new Map();
  if (targetManifest?.owner === OWNER && Array.isArray(targetManifest.files)) {
    for (const entry of targetManifest.files) {
      if (!validFile(entry.file)) continue;
      const file = join(dstDir, entry.file);
      assertRegularOrMissing(file);
      if (existsSync(file) && sha256Of(file) === entry.id) kept.set(entry.file, { id: entry.id, file: entry.file });
    }
  }
  for (const entry of man.files) {
    if (!validFile(entry.file)) continue;
    const srcFile = join(srcDir, entry.file);
    if (!existsSync(srcFile)) continue;
    const now = sha256Of(srcFile);
    if (now !== entry.id) { out.leftBehind.push({ file: entry.file, why: '内容被改过，留在原目录' }); continue; }

    let name = entry.file;
    const dstFile = () => join(dstDir, name);
    if (existsSync(dstFile())) {
      if (kept.get(name)?.id === entry.id && sha256Of(dstFile()) === entry.id) {
        unlinkSync(srcFile);
        out.alreadyThere += 1;
        continue;
      }
      const alt = altNameIn(dstDir, name);
      if (!alt) { out.conflicts.push({ file: name, reason: '新目录同名且无备用名' }); out.leftBehind.push({ file: name, why: '没搬' }); continue; }
      out.conflicts.push({ file: name, reason: '新目录已有同名文件', usedName: alt });
      name = alt;
    }
    // 跨盘时 rename 会失败，统一用 复制+删除
    copyFileSync(srcFile, dstFile());
    unlinkSync(srcFile);
    out.moved += 1;
    kept.set(name, { id: entry.id, file: name });
  }

  writeJson(join(dstDir, '.sticker-reply.json'), { owner: OWNER, version: 1, at: Date.now(), files: [...kept.values()] });
  try { unlinkSync(join(srcDir, '.sticker-reply.json')); } catch { /* 没有就算了 */ }
  try {
    if (readdirSync(srcDir).length === 0) { rmSync(srcDir, { recursive: true, force: true }); out.removedOldDir = true; }
  } catch { /* 删不掉就留着 */ }
  return out;
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

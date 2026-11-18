/**
 * 图片扫描 + 标注存储。
 *
 * 身份用**内容 SHA-256**：同一张图改名、移动、出现在两个目录里都还是同一份标注；
 * 内容变了就是新图片。标注存两份：用户覆盖（annotations.json）+ 默认标注（代码里），
 * 读取时合并 —— 默认标注升级只补用户没改过的字段。
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  DEFAULT_DIR, PATHS, listImageFiles, readJson, writeJson, withLock,
} from './shared.mjs';
import { DEFAULT_ANNOTATIONS, DEFAULT_SETTINGS } from './defaults.mjs';

/** 内容哈希缓存：path+mtime+size 没变就复用 */
const hashCache = new Map();

export function sha256Of(file) {
  let st;
  try { st = statSync(file); } catch { return ''; }
  const key = `${file}|${st.mtimeMs}|${st.size}`;
  const hit = hashCache.get(key);
  if (hit) return hit;
  try {
    const id = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (hashCache.size > 500) hashCache.clear();
    hashCache.set(key, id);
    return id;
  } catch {
    return '';
  }
}

export function loadSettings() {
  const raw = readJson(PATHS.settings, {}) || {};
  const out = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(raw)) {
    if (k in DEFAULT_SETTINGS && v !== undefined && v !== null) out[k] = v;
  }
  out.threshold = Math.min(1, Math.max(0.1, Number(out.threshold) || 0.8));
  out.maxCandidates = Math.min(64, Math.max(1, Number(out.maxCandidates) || 24));
  out.timeoutMs = Math.min(30_000, Math.max(1000, Number(out.timeoutMs) || 10_000));
  out.repeatWindow = Math.min(10, Math.max(0, Number(out.repeatWindow) || 3));
  out.scanIntervalMs = Math.min(300_000, Math.max(2000, Number(out.scanIntervalMs) || 15_000));
  out.extraDir = String(out.extraDir || '').trim();
  return out;
}

export function saveSettings(patch) {
  const cur = loadSettings();
  const next = { ...cur, ...patch };
  writeJson(PATHS.settings, next);
  return next;
}

/**
 * 默认标注**只对内置资源生效**。
 *
 * 以前只按文件名查：外部目录里一张同名但内容不同的图会继承内置图的名字、含义
 * 和"启用"状态，直接混进选图集合。现在把「文件名 → 内置内容哈希」钉住，
 * 内容对不上就不给默认标注。
 */
let builtinIndex = null;

function builtinHashIndex() {
  if (builtinIndex) return builtinIndex;
  const map = new Map();
  for (const name of Object.keys(DEFAULT_ANNOTATIONS)) {
    const id = sha256Of(join(DEFAULT_DIR, name));
    if (id) map.set(name, id);
  }
  builtinIndex = map;
  return map;
}

function defaultOf(image) {
  const name = basename(image?.path || '');
  const def = DEFAULT_ANNOTATIONS[name];
  if (!def) return null;
  return builtinHashIndex().get(name) === image?.id ? def : null;
}

/**
 * 扫描所有来源。
 *
 * @returns {{images: Array, errors: Array, scannedAt: number}}
 */
export function scanAll(settings = loadSettings()) {
  const errors = [];
  const seen = new Map(); // id → {id, path, sources[]}
  const sources = [{ key: 'default', dir: DEFAULT_DIR, label: '内置库' }];
  if (settings.extraDir) sources.push({ key: 'user', dir: settings.extraDir, label: '自定义目录' });

  for (const src of sources) {
    const files = listImageFiles(src.dir);
    if (!files.length && src.key === 'user') {
      errors.push({ source: src.label, dir: src.dir, reason: '目录不存在或里面没有图片' });
      continue;
    }
    for (const f of files) {
      const id = sha256Of(f.path);
      if (!id) {
        errors.push({ source: src.label, dir: f.path, reason: '读不出内容（可能没有权限）' });
        continue;
      }
      const hit = seen.get(id);
      if (hit) {
        if (!hit.sources.includes(src.key)) hit.sources.push(src.key);
        continue;
      }
      seen.set(id, { id, path: f.path, size: f.size, sources: [src.key], source: src.key, name: basename(f.path) });
    }
  }

  return { images: [...seen.values()], errors, scannedAt: Date.now() };
}

/**
 * 合并默认标注与用户覆盖。
 *
 * **显式清空要能生效**：只要用户在文件里写过这个字段（哪怕空串、空数组），
 * 就以用户值为准。以前用"非空"判断，含义清空后会回落默认值，等于清不掉。
 */
export function mergeAnnotation(image, userMap) {
  const user = userMap?.[image.id] || null;
  const def = defaultOf(image);
  const has = (field) => Boolean(user) && Object.prototype.hasOwnProperty.call(user, field);
  const pick = (field, fallback) => {
    if (has(field)) return user[field];
    if (def && def[field] !== undefined) return def[field];
    return fallback;
  };
  const tags = has('tags') && Array.isArray(user.tags)
    ? user.tags
    : (def && Array.isArray(def.tags) ? def.tags : []);

  return {
    id: image.id,
    path: image.path,
    file: image.name,
    sources: image.sources,
    size: image.size,
    missing: false,
    enabled: has('enabled') ? user.enabled !== false : (def ? true : Boolean(user?.enabled)),
    name: pick('name', image.name),
    meaning: pick('meaning', ''),
    tags,
    scenes: pick('scenes', ''),
    avoid: pick('avoid', ''),
    /** 标注来源：default = 内置默认；user = 用户编辑过；none = 未标注 */
    origin: user && Object.keys(user).length ? 'user' : (def ? 'default' : 'none'),
  };
}

/** 已标注但文件不见了：保留一行，供"来源失效"筛选查看与清理 */
function missingRow(id, ann) {
  return {
    id,
    path: '',
    file: String(ann?.name || '(来源已失效)'),
    sources: [],
    size: 0,
    missing: true,
    enabled: false,
    name: String(ann?.name || '(来源已失效)'),
    meaning: String(ann?.meaning || ''),
    tags: Array.isArray(ann?.tags) ? ann.tags : [],
    scenes: String(ann?.scenes || ''),
    avoid: String(ann?.avoid || ''),
    origin: 'user',
  };
}

export function loadUserMap() {
  const raw = readJson(PATHS.annotations, null);
  if (!raw || typeof raw !== 'object') return { version: 1, images: {} };
  return { version: Number(raw.version) || 1, images: raw.images && typeof raw.images === 'object' ? raw.images : {} };
}

/**
 * 读标注，**区分"没有文件"和"文件坏了"**。
 *
 * 写路径必须知道这两者：文件坏了还照常写，会把用户原标注整份覆盖掉，
 * 连修复的机会都没有。坏文件先备份成 `.corrupt-<时间戳>.json` 再重建。
 */
export function loadUserMapStrict() {
  let text = '';
  try {
    text = readFileSync(PATHS.annotations, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { map: { version: 1, images: {} }, corrupt: false, backupPath: '' };
    throw e;
  }
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('结构不是对象');
    if (!raw.images || typeof raw.images !== 'object' || Array.isArray(raw.images)) throw new Error('images 不是对象');
    if (Number(raw.version ?? 1) !== 1) throw new Error('不支持的标注版本');
    return {
      map: { version: 1, images: raw.images },
      corrupt: false,
      backupPath: '',
    };
  } catch {
    const backupPath = `${PATHS.annotations}.corrupt-${Date.now()}-${randomUUID()}.json`;
    writeFileSync(backupPath, text, { encoding: 'utf8', flag: 'wx' });
    return { map: { version: 1, images: {} }, corrupt: true, backupPath };
  }
}

/** 写操作：加锁 + 重新读 + 合并 + 原子写（避免页面与 MCP 互相覆盖） */
export async function mutateAnnotations(mutator) {
  return withLock(async () => {
    const { map: cur, corrupt, backupPath } = loadUserMapStrict();
    const next = await mutator({ ...cur, images: { ...cur.images } });
    writeJson(PATHS.annotations, next || cur);
    return { corruptRebuilt: corrupt, backupPath };
  });
}

/** 扫描 + 合并标注，得到页面与判断共用的一份视图 */
export function listAnnotated(settings = loadSettings()) {
  const scan = scanAll(settings);
  const userMap = loadUserMap().images;
  const images = scan.images
    .map((img) => mergeAnnotation(img, userMap))
    .sort((a, b) => a.file.localeCompare(b.file));

  // 已标注但扫描不到的：补成"来源失效"行，否则页面那个筛选永远是空的
  const present = new Set(images.map((i) => i.id));
  const missing = Object.entries(userMap)
    .filter(([id]) => !present.has(id))
    .map(([id, ann]) => missingRow(id, ann))
    .sort((a, b) => a.file.localeCompare(b.file));

  return { images: [...images, ...missing], errors: scan.errors, scannedAt: scan.scannedAt, missing };
}

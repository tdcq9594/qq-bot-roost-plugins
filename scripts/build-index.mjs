#!/usr/bin/env node
/**
 * 生成 / 校验插件市场索引
 * =========================
 *
 *   node scripts/build-index.mjs            # 重算并写回 index.json
 *   node scripts/build-index.mjs --check    # 只校验，不写；不一致退出码 1
 *
 * 为什么插件仓库要自带一份：索引里的 `sha256` 必须和插件目录的真实内容
 * 对得上，否则用户装的时候校验失败——那是我们自己的错，不该让用户撞上。
 * 以前这一步是手改的：改了插件忘了重算哈希、加了插件忘了加条目、
 * 插件删了索引里还留着，都是这么来的。
 *
 * 框架仓库里也有一个 `scripts/build-market-index.mjs`，两个的**合并规则
 * 必须一致**，否则谁跑一次都会把对方写的内容改一遍。改动时两边一起改。
 *
 * 哈希算法和框架的 `src/hashdir.js` 是同一套（那边是权威实现）：
 * 按相对路径排序，逐个喂 `路径 \0 大小 \0 内容 \0`，最后取 sha256；
 * 文本文件的 CRLF 先归一成 LF（Windows 检出和 GitHub 打的 tarball
 * 换行符不同，不归一两边永远对不上）。
 * 这里没有 import 框架的代码，因为插件仓库要能单独 clone 下来就能跑。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGINS = path.join(ROOT, 'plugins');
const TARGET = path.join(ROOT, 'index.json');

const checkOnly = process.argv.includes('--check');

/* ------------------------------------------------------------------ */
/* 目录哈希（与框架 src/hashdir.js 同一套算法）                        */
/* ------------------------------------------------------------------ */

/** 不参与哈希的东西：依赖目录、缓存、VCS/IDE 元数据（每台机器都不一样） */
const SKIP_DIRS = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.git', '.idea', '.vscode']);
const SKIP_FILES = new Set(['.deps.json', '.DS_Store', 'Thumbs.db']);

/** 文本文件 CRLF 折成 LF；二进制原样（判定依据同 git：有没有 NUL 字节） */
function normalize(buf) {
  if (buf.includes(0)) return buf;
  if (!buf.includes(0x0d)) return buf;
  return Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

async function collect(root) {
  const out = [];
  const walk = async (dir, prefix) => {
    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (it.isDirectory()) {
        if (SKIP_DIRS.has(it.name)) continue;
        await walk(path.join(dir, it.name), prefix ? `${prefix}/${it.name}` : it.name);
      } else if (it.isFile()) {
        if (SKIP_FILES.has(it.name)) continue;
        out.push(prefix ? `${prefix}/${it.name}` : it.name);
      }
      // 符号链接一律跳过：可能指向仓库外，内容不稳定
    }
  };
  await walk(root, '');
  return out.sort();
}

async function hashDir(dir) {
  const files = await collect(dir);
  const h = crypto.createHash('sha256');
  for (const rel of files) {
    const buf = normalize(await fs.readFile(path.join(dir, rel)));
    h.update(rel);
    h.update('\0');
    h.update(String(buf.length));
    h.update('\0');
    h.update(buf);
    h.update('\0');
  }
  return h.digest('hex');
}

/* ------------------------------------------------------------------ */
/* 读插件元信息                                                        */
/* ------------------------------------------------------------------ */

/**
 * 从 index.js 里读一个字符串字面量字段。
 *
 * **不 import 插件代码**：只是为了拿几个元信息，没必要执行一份第三方
 * 逻辑（顶层语句可能有副作用），而且 `import()` 依赖 Node 的模块自动探测，
 * 换个 Node 版本就可能失败。
 *
 * 代价是只认字面量：`version: VERSION` 读不到。这和 `check-versions.mjs`
 * 是同一套规则——CI 本来就要求版本号写成字面量，两边一致才不会出现
 * 「检查过了但索引生成不了」。
 */
function field(src, key) {
  const re = new RegExp(`^\\s*${key}:\\s*['"\`]([^'"\`]*)['"\`]`, 'm');
  return src.match(re)?.[1] ?? '';
}

async function readMeta(dir) {
  // 外部插件（python / go / exec）：plugin.json
  const manifest = path.join(dir, 'plugin.json');
  const hasManifest = await fs.access(manifest).then(() => true, () => false);
  if (hasManifest) {
    const raw = JSON.parse(await fs.readFile(manifest, 'utf8'));
    if (!raw.id) throw new Error('plugin.json 里没有 id');
    return {
      id: String(raw.id),
      name: raw.name ?? raw.id,
      version: raw.version ? String(raw.version) : '',
      description: raw.shortDesc ?? raw.description ?? '',
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      frameworkVersion: raw.frameworkVersion ?? '',
      runtime: raw.runtime ?? 'python',
    };
  }

  // 内建插件：index.js 的默认导出
  const entry = path.join(dir, 'index.js');
  const src = await fs.readFile(entry, 'utf8');
  const id = field(src, 'id');
  if (!id) throw new Error('index.js 里读不到 id（要写成 `id: \'xxx\'` 字面量）');
  return {
    id,
    name: field(src, 'name') || id,
    version: field(src, 'version'),
    description: field(src, 'description'),
    tags: [],
    frameworkVersion: field(src, 'frameworkVersion'),
    runtime: 'node',
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * 和已有索引**按 id 合并**，不整份覆盖。
 *
 * 索引里的字段分两类：
 *   1. 结构字段（id / version / path / runtime / sha256 / frameworkVersion）
 *      —— 必须与仓库一致，否则装错版本、找不到目录、校验对不上，一律以磁盘为准。
 *   2. 展示字段（name / description / tags / author / commands / addedAt /
 *      credits）—— 手写的，往往比代码里的短描述更完整（比如 kun 的
 *      「24 个命令」）。脚本不该改文案，只给新插件补默认值。
 *
 * 早期版本是整份覆盖，结果跑一次「更新索引」就把 tags 清空、把描述里的
 * 补充说明抹掉，看起来像升级，实际是数据丢失。
 */
const STRUCT_FIELDS = ['id', 'version', 'path', 'runtime', 'sha256', 'frameworkVersion'];

async function build() {
  let dirs;
  try {
    dirs = await fs.readdir(PLUGINS, { withFileTypes: true });
  } catch {
    console.log('没有 plugins/ 目录，跳过');
    return null;
  }

  const found = [];
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') continue;
    const sub = path.join(PLUGINS, d.name);
    let meta;
    try {
      meta = await readMeta(sub);
    } catch (e) {
      console.error(`✗ ${d.name}: ${e.message}`);
      throw new Error(`${d.name} 读不出元信息`);
    }
    if (!meta.version) throw new Error(`${d.name} 读不到 version（要写成字面量）`);
    if (meta.id !== d.name) {
      console.warn(`  ${d.name}: 声明的 id 是 ${meta.id}，与目录名不一致（以目录名为准）`);
      meta.id = d.name;
    }
    found.push({ ...meta, path: `plugins/${d.name}`, sha256: await hashDir(sub) });
  }
  found.sort((a, b) => a.id.localeCompare(b.id));

  // 旧索引：保留手写字段与 repo/branch/schema
  let prev = { plugins: [] };
  let prevEol = '\n';
  try {
    const raw = await fs.readFile(TARGET, 'utf8');
    prev = JSON.parse(raw);
    if (raw.includes('\r\n')) prevEol = '\r\n';
  } catch {
    /* 第一次生成 */
  }
  const prevById = new Map((prev.plugins ?? []).map((p) => [p.id, p]));

  const merged = found.map((p) => {
    const old = prevById.get(p.id);
    if (!old) return p; // 新插件：全量写入
    const out = { ...old };
    for (const k of STRUCT_FIELDS) {
      if (p[k] !== undefined && p[k] !== '') out[k] = p[k];
    }
    return out;
  });

  return {
    out: {
      ...(prev.schema ? { schema: prev.schema } : {}),
      ...(prev.repo ? { repo: prev.repo } : {}),
      branch: prev.branch ?? 'main',
      updated: new Date().toISOString().slice(0, 10),
      plugins: merged,
    },
    prev,
    prevEol,
  };
}

/** 只比「脚本该管的部分」：忽略 updated（天天在变）和字段顺序 */
function diff(prev, next) {
  const problems = [];
  const byId = new Map((prev.plugins ?? []).map((p) => [p.id, p]));
  for (const p of next.plugins) {
    const old = byId.get(p.id);
    if (!old) {
      problems.push(`${p.id}: 索引里没有这个插件`);
      continue;
    }
    byId.delete(p.id);
    for (const k of STRUCT_FIELDS) {
      const a = old[k] ?? '';
      const b = p[k] ?? '';
      if (String(a) !== String(b)) problems.push(`${p.id}: ${k} 索引里是 ${a || '(空)'}，实际是 ${b || '(空)'}`);
    }
  }
  for (const id of byId.keys()) problems.push(`${id}: 索引里有，但 plugins/ 下已经没有这个目录`);
  return problems;
}

const result = await build();
if (!result) process.exit(0);

if (checkOnly) {
  const problems = diff(result.prev, result.out);
  if (problems.length) {
    console.error('索引和插件目录对不上：');
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error('\n跑 node scripts/build-index.mjs 重新生成。');
    process.exit(1);
  }
  console.log(`✓ 索引一致（${result.out.plugins.length} 个插件）`);
  process.exit(0);
}

await fs.writeFile(TARGET, `${JSON.stringify(result.out, null, 2)}\n`.replace(/\n/g, result.prevEol), 'utf8');
console.log(`已生成 ${path.relative(ROOT, TARGET)}`);
console.log(`  ${result.out.plugins.length} 个插件${result.out.repo ? `，repo=${result.out.repo}` : '（没有 repo，安装会失败）'}`);
for (const p of result.out.plugins) {
  console.log(`  - ${p.id} v${p.version}（${p.runtime}）${p.sha256 ? '' : '  ⚠ 无 sha256'}`);
}

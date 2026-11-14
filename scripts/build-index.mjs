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
import { hashDir } from './hashdir.mjs';
import { signIndex, resolveKeyPath } from './sign-index.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGINS = path.join(ROOT, 'plugins');
const TARGET = path.join(ROOT, 'index.json');

const checkOnly = process.argv.includes('--check');

/* ------------------------------------------------------------------ */
/* 目录哈希：见 ./hashdir.mjs（与框架 src/hashdir.js 同一套算法）      */
/* 一致性由 test/hash-consistency.mjs 守卫。                           */
/* ------------------------------------------------------------------ */

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
    /**
     * `kind: "dsh-extension"` 的条目是 **DSH 扩展**（标准 MCP server），
     * 不是框架插件。两者共用 `plugin.json`，但运行形态完全不同：
     *
     *   · 扩展由 DSH 按受管块 spawn，没有 `index.js`、没有 `version` 契约；
     *   · 框架侧绝不能按默认 `runtime:'python'` 去拉子进程 —— 那会启动一个
     *     不存在的 python 进程，表现是「装上了但一点反应都没有」。
     *
     * 所以扩展**显式**给 `runtime:'mcp'`，框架的 market / loader 见到 kind
     * 就跳过（6.2 的两道过滤）。存量插件没有 kind，产出与之前逐字节一致。
     */
    const isExt = raw.kind === 'dsh-extension';
    return {
      id: String(raw.id),
      name: raw.name ?? raw.id,
      version: raw.version ? String(raw.version) : '',
      description: raw.shortDesc ?? raw.description ?? '',
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      frameworkVersion: raw.frameworkVersion ?? '',
      ...(isExt ? { kind: 'dsh-extension', runtime: 'mcp' } : { runtime: raw.runtime ?? 'python' }),
      /**
       * 权限分级的**原始声明**（2026-11-14）。
       *
       * 只把作者要的 scope / 要接管的内置能力 / 运行形态写进索引，等级本身
       * 由宿主 `ext-tier.js` 实时推导 —— 索引里存一个 `permissionTier` 等于
       * 让作者自己填等级，签名也防不住虚标。这些字段受 index.json.sig 保护，
       * 市场卡片和安装确认都从它们算风险。
       */
      ...(isExt && Array.isArray(raw.scopes) ? { scopes: raw.scopes.map(String) } : {}),
      ...(isExt && Array.isArray(raw.overrides) ? { overrides: raw.overrides.map(String) } : {}),
      ...(isExt && typeof raw.form === 'string' && raw.form ? { form: raw.form } : {}),
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
 *      其中 `author` 一律写插件作者本人：社区投稿写 PR 发起人的 GitHub 用户名，
 *      维护者不占署名（签名链只约束「索引由谁的私钥签」，不约束这个字段）。
 *
 * 早期版本是整份覆盖，结果跑一次「更新索引」就把 tags 清空、把描述里的
 * 补充说明抹掉，看起来像升级，实际是数据丢失。
 */
/**
 * 结构字段：磁盘能算出来、索引里可能过期的那些。
 *
 * `kind` 也要在列 —— 它决定下游怎么处理这个条目（插件 vs 扩展）。
 * 不写进来的话，扩展条目从插件改回来时旧 `kind` 会留在索引里，
 * 框架侧一直当扩展跳过。存量插件没有 `kind`，`merged` 不写入，
 * 产出与之前逐字节一致。
 */
const STRUCT_FIELDS = [
  'id', 'version', 'path', 'runtime', 'sha256', 'frameworkVersion', 'kind',
  /** 权限声明：改了 plugin.json 忘了重建索引，--check 必须能拦住 */
  'scopes', 'overrides', 'form',
];

/**
 * 插件分级。
 *
 * **这是我们的判断，不是插件的自述**，所以放在仓库根目录的 `verified.json` 里，
 * 由这个脚本灌进索引——插件自己写的 `verified` 字段一律不认。
 *
 * 三档：
 *   official  官方维护（我们自己写的、跟着框架一起发）
 *   reviewed  我们复核过内容（看过代码、试过跑）
 *   self      作者自证（作者说他是谁，我们没核）
 * 没列出 = 未验证，索引里不写这个键。
 *
 * **签名是另一回事**：签名是「这份索引没被改过」的全体属性，
 * 所有签名插件都落同一个状态，不能当成档位。
 */
const VERIFIED_LEVELS = ['official', 'reviewed', 'self'];

/** 读分级表；文件不存在就当成「一个都没验证」 */
async function readVerified() {
  try {
    const j = JSON.parse(await fs.readFile(path.join(ROOT, 'verified.json'), 'utf8'));
    const out = new Map();
    for (const [id, lv] of Object.entries(j)) {
      if (id.startsWith('_')) continue; // _doc 这类说明字段
      if (!VERIFIED_LEVELS.includes(lv)) {
        throw new Error(`verified.json：${id} 的等级「${lv}」不认识（只认 ${VERIFIED_LEVELS.join(' / ')}）`);
      }
      out.set(id, lv);
    }
    return out;
  } catch (e) {
    if (e.code === 'ENOENT') return new Map();
    throw e;
  }
}

async function build() {
  let dirs;
  try {
    dirs = await fs.readdir(PLUGINS, { withFileTypes: true });
  } catch {
    console.log('没有 plugins/ 目录，跳过');
    return null;
  }

  const verified = await readVerified();

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
    /**
     * 版本号契约只对**框架插件**成立：市场按 version 判更新。
     * 扩展没有 version，更新判定走索引的 `sha256`（6.2 的安装器），
     * 所以这里按 kind 分叉，否则扩展一入库就会被判成「读不到 version」。
     */
    if (!meta.version && meta.kind !== 'dsh-extension') {
      throw new Error(`${d.name} 读不到 version（要写成字面量）`);
    }
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

  const merged = found
    .map((p) => {
      const old = prevById.get(p.id);
      const out = old ? { ...old } : { ...p }; // 新插件：全量写入
      if (old) {
        for (const k of STRUCT_FIELDS) {
          if (p[k] !== undefined && p[k] !== '') out[k] = p[k];
        }
      }
      /**
       * 清空判据必须看**磁盘实读的 `p`**，不能看合并结果 `out`。
       * `out` 里旧值还在（`{...old}`），`if (!out.kind)` 恒假 —— 上一版就错在这里：
       * 扩展改回普通插件后 `kind` 永久残留，框架侧一直跳过它，`--check` 也发现不了。
       */
      if (p.kind === undefined) delete out.kind;
      if (!p.version) delete out.version;
      /** 权限声明同样不能继承旧值：扩展删掉一个敏感 scope 必须能降档 */
      for (const k of ['scopes', 'overrides', 'form']) {
        if (p[k] === undefined) delete out[k];
      }
      return out;
    })
    .map((p) => {
      /**
       * `frameworkVersion` 是可选的（插件可以不声明最低框架版本）。
       * 空值一律删掉——否则老插件留着 `""`、新插件干脆没这个键，
       * 同一份索引里出现两种「没有」，读起来容易误以为漏了字段。
       */
      if (!p.frameworkVersion) delete p.frameworkVersion;
      /**
       * `verified` 以 `verified.json` 为准，**不继承旧索引里的值**：
       * 降级（official → self）必须能生效，靠 `{...old}` 是改不掉的。
       */
      const lv = verified.get(p.id);
      if (lv) p.verified = lv;
      else delete p.verified;
      return p;
    });

  // 分级表里有、但插件目录已经没了 —— 提醒一句，别让它悄悄烂在那儿
  for (const id of verified.keys()) {
    if (!merged.some((p) => p.id === id)) console.warn(`  verified.json 里的 ${id} 已经不在 plugins/ 下`);
  }

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
    /**
     * `verified` 也要比。
     *
     * 它不是结构字段（不来自插件目录，来自 `verified.json`），但同样是
     * "脚本能算出来、索引里可能过期"的东西。漏掉它的话，改了分级表忘了
     * 重跑 `build-index`，CI 一路绿灯，线上索引还是旧等级——
     * 用户看到的是「官方维护」，而我们其实已经把它降级了。
     */
    for (const k of [...STRUCT_FIELDS, 'verified']) {
      const a = old[k] ?? '';
      const b = p[k] ?? '';
      /** scopes / overrides 是数组，String() 会把 ['a','b'] 和 ['a,b'] 混为一谈 */
      const sa = typeof a === 'object' ? JSON.stringify(a) : String(a);
      const sb = typeof b === 'object' ? JSON.stringify(b) : String(b);
      if (sa !== sb) problems.push(`${p.id}: ${k} 索引里是 ${sa || '(空)'}，实际是 ${sb || '(空)'}`);
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

/**
 * **先决定能不能签名，再动磁盘。**
 *
 * 以前是先写 json、再签名。没私钥时只更新了 json、`.sig` 还是旧的——
 * 索引变了签名没变，CI 的验签必红；开了安全校验的用户更是整个市场被拦，
 * 一个插件都装不上。而它只打一行「未签名」，看上去一切正常。
 *
 * 2026-11-02 就这么坏了一次：私钥在 `bot/keys/`，这儿默认找
 * `qq-bot-roost-plugins/keys/`，目录不存在 → 静默跳过签名。
 *
 * 所以规矩改成：**已经签过名的仓库，没私钥就不许改索引**（退出码 1，
 * 一个字节都不写）。本地开发、还没签过名的仓库不受影响。
 */
const keyPath = resolveKeyPath(process.argv.slice(2));
const sigPath = `${TARGET}.sig`;
const signed = await fs.access(sigPath).then(
  () => true,
  () => false,
);
if (!keyPath && signed) {
  console.error('✗ 这个仓库的 index.json 是签过名的，但没找到私钥，拒绝改写。');
  console.error('  私钥默认在 keys/trust-private.pem，或用 ROOST_TRUST_KEY / --key 指定。');
  console.error('  真要不带签名地重算（等于弄坏现有签名），先删掉 index.json.sig。');
  process.exit(1);
}

await fs.writeFile(TARGET, `${JSON.stringify(result.out, null, 2)}\n`.replace(/\n/g, result.prevEol), 'utf8');

if (keyPath) {
  signIndex(TARGET, keyPath);
  console.log('  已签名 → index.json.sig');
} else {
  console.log('  （未签名：这个仓库还没有 .sig，不当发布产物用）');
}

console.log(`已生成 ${path.relative(ROOT, TARGET)}`);
console.log(`  ${result.out.plugins.length} 个插件${result.out.repo ? `，repo=${result.out.repo}` : '（没有 repo，安装会失败）'}`);
for (const p of result.out.plugins) {
  console.log(`  - ${p.id}${p.version ? ` v${p.version}` : ''}（${p.runtime}）${p.sha256 ? '' : '  ⚠ 无 sha256'}`);
}

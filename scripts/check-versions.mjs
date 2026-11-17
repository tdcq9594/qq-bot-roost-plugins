/**
 * 插件版本号检查
 * =================
 *
 * 防的是这件事：**改了插件内容但忘了升 version**。
 *
 * 为什么这很严重：市场判断「有没有新版」只比版本号
 * （`detectUpdates` 里 `compareVersion(cur, latest) < 0`）。
 * 版本没变，装了旧版的人永远收不到更新——而且他不知道自己错过了什么。
 *
 * 已经踩过两次：ai-chat 的 1.1.0 改过两轮（/ai 格式、模型名+思考模式），
 * dice 的 1.1.0 加了骰子战绩页，都没升版本号。
 *
 * 两道闸，各管一段：
 *
 *   1. **内容变了没升版**：拿 `git diff <基准> -- plugins/<id>` 看目录动没动，
 *      动了但 version 没变就报错。它只看「一次改动」，所以基准一旦取成
 *      `HEAD~1`，一次推多个 commit 时中间那些就被跳过了。
 *
 *   2. **已发布的「版本号 → 内容」不许改**（2026-11-17 补）：扫基准那份
 *      `index.json`，把每个 `id@version` 的 sha256 拎出来，和当前的比。
 *      同一个 `id@version` 的 sha256 变了 = 这个版本号已经发出去过、内容
 *      却被换掉了。**这道闸不看提交数**，批量推送、合并、变基都绕不过去，
 *      而且不需要 git tag（我们仓库没有 tag）。
 *
 * 第 2 道闸是补出来的，因为第 1 道漏过实锤：翻 index.json 的 160 次提交，
 * 有 16 个非扩展 `id@version` 出现过多个不同 sha256，其中 group-admin@1.1.0
 * 换过 4 次内容、dice@1.2.0 换过 2 次，当时版本号一直没动。
 *
 * **扩展（`kind: 'dsh-extension'`）不参与这两道闸**：它们的更新判定走索引里的
 * `sha256`（安装器每次比对目录哈希），版本号不承载「已发布」语义，改内容
 * 不升版是合法的。判据见 `isExtension`。
 *
 * 用法：
 *   node scripts/check-versions.mjs               对比 origin/main 和工作区（本地用）
 *   node scripts/check-versions.mjs --base <ref>  指定基准（CI 用）
 *
 * 退出码：0 = 没问题，1 = 有插件改了内容但没升版本
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGINS = path.join(ROOT, 'plugins');

const args = process.argv.slice(2);
const baseArg = args.indexOf('--base');

/**
 * 基准怎么取。
 *
 * 本地默认 `origin/main` —— 它代表「已经发出去的那份」，比 `HEAD` 有用：
 * `HEAD` 只看得见「还没提交的改动」，提完再查就永远是绿的。
 *
 * CI 三条路各自传什么见 `.github/workflows/ci.yml`：PR 传目标分支，
 * push 传 `github.event.before`（这次推送之前的那一版，正好是「已发布」），
 * 新分支/取不到时退回 `HEAD`（等于只做语法级检查，不误报）。
 */
const BASE = baseArg >= 0
  ? args[baseArg + 1]
  : (git('rev-parse', '--verify', '--quiet', 'origin/main') ? 'origin/main' : 'HEAD');

/** 跑 git，失败返回空串（比如插件仓库第一次提交时没有 HEAD~1） */
function git(...a) {
  try {
    // stderr 丢掉：`git show HEAD:某个不存在的文件` 会往 stderr 吐 fatal，
    // 那在「这个插件以前是 python 版」的场合是正常的，不该刷屏
    return execFileSync('git', a, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * 是不是 DSH 扩展。
 *
 * 扩展没有 `plugins/<id>/index.js`，也没有 version 契约 —— 更新判定走索引里
 * 的 `sha256`（dsh-roost 的安装器每次对比目录哈希）。硬套「改了内容必须升
 * version」会让每个扩展一提交就红，所以这里显式跳过。
 */
function isExtension(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    return j?.kind === 'dsh-extension';
  } catch {
    return false;
  }
}

/** 从插件目录里读 version。python 插件看 plugin.json，node 看 index.js */
function readVersion(dir) {
  // node：index.js 里的 version: '1.2.3'
  try {
    const s = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
    const m = s.match(/^\s*version:\s*['"]([^'"]+)['"]/m);
    if (m) return m[1];
  } catch {
    /* 没有 index.js，可能是 python 插件 */
  }
  // python / 外部：plugin.json 里的 version
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    if (j.version) return String(j.version);
  } catch {
    /* 都没有 */
  }
  return null;
}

/**
 * 把一份索引压成 `id@version → sha256`。
 *
 * 扩展跳过：它们改内容不升版是合法的（更新判定走 sha256），压进来必然误报。
 * 没有 sha256 或没有 version 的条目也跳过——那不是「已发布的内容版本」，比不了。
 */
function indexTriples(raw) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  const m = new Map();
  for (const p of j?.plugins ?? []) {
    if (!p?.id || !p.version || !p.sha256) continue;
    if (p.kind === 'dsh-extension') continue;
    m.set(`${p.id}@${p.version}`, String(p.sha256).toLowerCase());
  }
  return m;
}

/** 基准那一版 `index.json`。基准取不到（新分支、根本身没有这个文件）返回 null。 */
function publishedTriples(ref) {
  return indexTriples(git('show', `${ref}:index.json`));
}

/** 当前工作区的 `index.json`。 */
function currentTriples() {
  try {
    return indexTriples(fs.readFileSync(path.join(ROOT, 'index.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 这个插件目录里有哪些文件（相对路径，排序后用于比对内容） */
function listFiles(dir, out = [], prefix = '') {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '__pycache__') continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) listFiles(path.join(dir, e.name), out, rel);
    else out.push(rel);
  }
  return out.sort();
}

const problems = [];
const checked = [];

let ids = [];
try {
  ids = fs
    .readdirSync(PLUGINS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name);
} catch {
  console.log('没有 plugins/ 目录，跳过');
  process.exit(0);
}

for (const id of ids) {
  const dir = path.join(PLUGINS, id);
  /** 扩展不参与版本号检查（判据见 `isExtension`）。 */
  if (isExtension(dir)) {
    checked.push({ id, ver: null, changed: false, skipped: 'dsh-extension' });
    continue;
  }
  const ver = readVersion(dir);
  if (!ver) {
    problems.push({ id, why: '读不到 version（index.js 或 plugin.json 里都没有）' });
    continue;
  }

  // 和 base 比，这个目录有没有改动
  const changed = git('diff', '--name-only', BASE, '--', `plugins/${id}`);
  if (!changed) {
    checked.push({ id, ver, changed: false });
    continue;
  }

  // 内容改了，那版本号动过没有
  const oldIdx = git('show', `${BASE}:plugins/${id}/index.js`);
  const oldJson = git('show', `${BASE}:plugins/${id}/plugin.json`);
  let oldVer = null;
  if (oldIdx) oldVer = oldIdx.match(/^\s*version:\s*['"]([^'"]+)['"]/m)?.[1] ?? null;
  if (!oldVer && oldJson) {
    try {
      oldVer = JSON.parse(oldJson).version ?? null;
    } catch {
      /* 老版本 JSON 坏了就算了 */
    }
  }

  if (oldVer && oldVer === ver) {
    problems.push({
      id,
      why: `内容改了但版本没变（还是 ${ver}），装了旧版的人收不到更新`,
    });
  } else {
    checked.push({ id, ver, changed: true, from: oldVer });
  }
}

/**
 * 第二道闸：已发布的「版本号 → 内容」不许改。
 *
 * 和上面那道的关键区别是**不看提交数**。上面用 `git diff <基准> -- plugins/<id>`
 * 只能回答「相对基准，这个目录动过吗」，所以基准取成 `HEAD~1` 时，一次推
 * 6 个 commit 就只看得见最后 1 个。这道闸换成「同一份版本号的 sha256 变了没有」，
 * 基准多远都拦得住。
 *
 * 拦不住的情况只有一种：改内容 **且** 忘了重新生成索引——那时当前索引里的
 * sha256 还是旧的，两道闸都看不见。那一段由 `build-index.mjs --check` 负责
 * （索引与磁盘不一致就红），CI 里那一步排在前面。
 */
const published = publishedTriples(BASE);
const current = currentTriples();
if (published && current) {
  for (const [key, was] of published) {
    const now = current.get(key);
    if (now && now !== was) {
      problems.push({
        id: key,
        why:
          `这个版本号已经发过，但内容被换掉了` +
          `（已发布 sha256 ${was.slice(0, 12)}…，现在 ${now.slice(0, 12)}…）` +
          `——装了这个版本的人收不到更新，请升 version`,
      });
    }
  }
}

console.log(`检查 ${ids.length} 个插件（基准 ${BASE}）`);
for (const c of checked) {
  if (c.changed) console.log(`  ✓ ${c.id}  ${c.from ?? '?'} → ${c.ver}`);
}
if (published) console.log(`  · 已发布内容版本 ${published.size} 个，逐个比过 sha256`);
else console.log(`  · 基准里没有 index.json，跳过「已发布内容不可变」检查`);

if (!problems.length) {
  console.log('OK：改了内容的插件都升了版本');
  process.exit(0);
}

console.error(`\n有 ${problems.length} 处需要处理：\n`);
for (const p of problems) console.error(`  ✗ ${p.id}  ${p.why}`);
console.error(
  '\n怎么改：改内容就顺手把 version 加一。' +
    '\n  · 修 bug / 改文案 → patch（1.2.0 → 1.2.1）' +
    '\n  · 加功能 / 加配置项 → minor（1.2.0 → 1.3.0）' +
    '\n  市场只比版本号，不升版就等于没发。\n',
);
process.exit(1);
console.error(
  '\n怎么改：改内容就顺手把 version 加一。' +
    '\n  · 修 bug / 改文案 → patch（1.2.0 → 1.2.1）' +
    '\n  · 加功能 / 加配置项 → minor（1.2.0 → 1.3.0）' +
    '\n  市场只比版本号，不升版就等于没发。\n',
);
process.exit(1);

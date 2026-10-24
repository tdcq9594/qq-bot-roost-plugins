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
 * 用法：
 *   node scripts/check-versions.mjs              对比 HEAD 和工作区（提交前用）
 *   node scripts/check-versions.mjs --base HEAD~1 对比两个 commit（CI 用）
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
const BASE = baseArg >= 0 ? args[baseArg + 1] : 'HEAD';

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

console.log(`检查 ${ids.length} 个插件（基准 ${BASE}）`);
for (const c of checked) {
  if (c.changed) console.log(`  ✓ ${c.id}  ${c.from ?? '?'} → ${c.ver}`);
}

if (!problems.length) {
  console.log('OK：改了内容的插件都升了版本');
  process.exit(0);
}

console.error(`\n有 ${problems.length} 个插件需要处理：\n`);
for (const p of problems) console.error(`  ✗ ${p.id}  ${p.why}`);
console.error(
  '\n怎么改：改内容就顺手把 version 加一。' +
    '\n  · 修 bug / 改文案 → patch（1.2.0 → 1.2.1）' +
    '\n  · 加功能 / 加配置项 → minor（1.2.0 → 1.3.0）' +
    '\n  市场只比版本号，不升版就等于没发。\n',
);
process.exit(1);

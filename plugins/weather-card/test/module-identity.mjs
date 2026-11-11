// 模块身份与清单契约：锁死「每个 lib 模块只有一个实例」和几个易回归的约定。
//
// ⚠️ 这些测试必须用**与 index.js 完全相同的 specifier** 去 import。
// 带不带 `?v=` 在 ESM 里是两个模块实例，用错会造成「测试打桩无效、
// 请求照样真发出去」这种极难排查的假象。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '..');
const LIB_DIR = path.join(PLUGIN_DIR, 'lib');
const TEST_DIR = path.join(PLUGIN_DIR, 'test');

const read = (p) => fs.readFileSync(path.join(PLUGIN_DIR, p), 'utf8');

/** 抓出所有相对 import 的 specifier（单引号、双引号都认） */
function relImports(src) {
  const out = [];
  const re = /from\s+['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

test('相对 import 一律不带查询串（含 index.js、lib/*.js、test/*.mjs）', () => {
  const files = [
    'index.js',
    ...fs.readdirSync(LIB_DIR).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`),
    ...fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.mjs')).map((f) => `test/${f}`),
  ];
  const bad = [];
  for (const f of files) {
    for (const spec of relImports(read(f))) {
      // 查询串不同 = 不同模块实例：sources.js 里的 5 个缓存 Map 会分裂成两套，测试打桩也会失效
      if (spec.includes('?')) bad.push(`${f} → ${spec}`);
    }
  }
  assert.deepEqual(bad, [], `这些 import 带了查询串：\n${bad.join('\n')}`);
});

test('lib 内部只有单层依赖，没有悬空依赖与循环引用', () => {
  const graph = {};
  for (const f of fs.readdirSync(LIB_DIR).filter((x) => x.endsWith('.js'))) {
    graph[f] = relImports(read(`lib/${f}`))
      .filter((s) => s.startsWith('./'))
      .map((s) => s.replace('./', ''));
  }
  const seen = new Set();
  const walk = (name, stack) => {
    if (!(name in graph)) throw new Error(`悬空依赖：${[...stack, name].join(' → ')}（文件不存在）`);
    if (stack.includes(name)) throw new Error(`循环引用：${[...stack, name].join(' → ')}`);
    if (seen.has(name)) return;
    for (const dep of graph[name]) walk(dep, [...stack, name]);
    seen.add(name);
  };
  for (const n of Object.keys(graph)) walk(n, []);
  assert.ok(true);
});

test('每个 lib 模块拿到的都是同一个实例（index.js 与测试解析到同一 URL 与同一导出对象）', async () => {
  const indexUrl = pathToFileURL(path.join(PLUGIN_DIR, 'index.js')).href;
  const indexMod = await import('../index.js');
  const sourcesMod = await import('../lib/sources.js');
  const cardMod = await import('../lib/card.js');

  // 1) index.js 里写的相对路径按 indexUrl 解析出的真实 URL，必须与测试里 '../lib/xxx.js' 完全相同
  for (const spec of relImports(read('index.js'))) {
    const fromIndex = new URL(spec, indexUrl).href;
    const baseName = path.posix.basename(spec);
    const fromTest = import.meta.resolve(`../lib/${baseName}`);
    assert.equal(fromIndex, fromTest, `${spec} 在 index 与 test 两侧解析出的 URL 不一致`);
  }

  // 2) index.js 转发出的函数引用与测试直接从 lib 拿到的必须是同一个函数引用（===）
  assert.equal(indexMod.internals.describe, sourcesMod.describe, 'sources.js 导出实例分叉');
  assert.equal(indexMod.internals.rangeText, cardMod.rangeText, 'card.js 导出实例分叉');
});

test('frameworkVersion 覆盖 registerTool 的引入版本（0.8.6）', async () => {
  const { default: plugin } = await import(pathToFileURL(path.join(PLUGIN_DIR, 'index.js')).href);
  // RELEASE_NOTES: v0.8.6 才引入 ctx.registerTool。声明低了会「装上了但 AI 不会查天气」且无报错。
  assert.match(plugin.frameworkVersion, />=0\.8\.\d+/);
  const minor = Number(/>=0\.(\d+)\./.exec(plugin.frameworkVersion)?.[1] || 0);
  assert.ok(minor >= 8, `frameworkVersion=${plugin.frameworkVersion} 低于 registerTool 的 0.8.6`);
});

test('版本号两处一致', async () => {
  const { default: plugin, VERSION } = await import(pathToFileURL(path.join(PLUGIN_DIR, 'index.js')).href);
  assert.equal(plugin.version, VERSION);
});

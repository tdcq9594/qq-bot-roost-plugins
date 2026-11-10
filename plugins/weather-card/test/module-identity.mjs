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

const read = (p) => fs.readFileSync(path.join(PLUGIN_DIR, p), 'utf8');

/** 抓出所有相对 import 的 specifier */
function relImports(src) {
  const out = [];
  const re = /from\s+'(\.[^']+)'/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

test('相对 import 一律不带查询串（否则同一模块会被实例化两份）', () => {
  const files = ['index.js', ...fs.readdirSync(LIB_DIR).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`)];
  const bad = [];
  for (const f of files) {
    for (const spec of relImports(read(f))) {
      // 查询串不同 = 不同模块实例：sources.js 里的 5 个缓存 Map 会分裂成两套
      if (spec.includes('?')) bad.push(`${f} → ${spec}`);
    }
  }
  assert.deepEqual(bad, [], `这些 import 带了查询串：\n${bad.join('\n')}`);
});

test('lib 内部只有单层依赖，没有循环引用', () => {
  const graph = {};
  for (const f of fs.readdirSync(LIB_DIR).filter((x) => x.endsWith('.js'))) {
    graph[f] = relImports(read(`lib/${f}`))
      .filter((s) => s.startsWith('./'))
      .map((s) => s.replace('./', ''));
  }
  const seen = new Set();
  const walk = (name, stack) => {
    if (stack.includes(name)) throw new Error(`循环引用：${[...stack, name].join(' → ')}`);
    if (seen.has(name)) return;
    for (const dep of graph[name] || []) walk(dep, [...stack, name]);
    seen.add(name);
  };
  for (const n of Object.keys(graph)) walk(n, []);
  assert.ok(true);
});

test('每个 lib 模块拿到的都是同一个实例（index 与测试共用 specifier）', async () => {
  const viaTest = await import(pathToFileURL(path.join(LIB_DIR, 'sources.js')).href);
  // 换一个「看起来等价」的 specifier：必须指向同一实例，否则就是分叉了
  const again = await import(pathToFileURL(path.join(LIB_DIR, 'sources.js')).href);
  assert.equal(viaTest, again, '同一路径必须解析到同一模块实例');
  // 缓存工厂必须是同一份状态（能互相看见）
  viaTest.resetSourceCaches();
  await assert.doesNotReject(async () => viaTest.getSource('wttr'));
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

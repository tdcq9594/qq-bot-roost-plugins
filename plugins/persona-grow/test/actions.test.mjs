/**
 * 面板动作的**调用**冒烟测试。
 *
 * 为什么需要这一层：`node --check` 只查语法，查不出「用了没 import 的名字」。
 * 真机上就踩过——`actions.mjs` 里写 `analyzeAuto(...)`，import 那行还是旧的
 * `analyze`，于是页面一点就抛 `analyzeAuto is not defined`。
 *
 * 这里的做法：**把每个动作真的调一遍**，只断言「不会抛 ReferenceError」。
 * 没有 API 凭据时它们应当走正常错误分支（返回 ok:false + 一句人话），
 * 那正好证明函数体里的名字都解析得开。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 状态目录指到临时目录。
 *
 * 不隔离的话，`restore` 那条用例会**写到真实状态文件**里——
 * 真机上就因此冒出过一条假的「最近错误：宿主没给 ROOST_API_URL」，
 * 而那是测试造出来的，用户看到只会以为插件坏了。
 */
process.env.ROOST_LAUNCHER_DIR = mkdtempSync(join(tmpdir(), 'grow-actions-'));
delete process.env.ROOST_API_URL;
delete process.env.ROOST_API_TOKEN;

/**
 * 入口文件名从 plugin.json 读，不写死。
 *
 * 宿主的进程内模块按 URL 缓存（`import()` 同一路径永远返回旧模块），
 * 所以每次改完代码都要换一个入口文件名才能生效——写死名字的话，
 * 每次改名测试就跟着红一次。
 */
const MANIFEST = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));
const ENTRY = MANIFEST.ui.entry;
const { createActions } = await import(new URL(`../${ENTRY}`, import.meta.url));

const CHAT = '44DE039E7B5FF07C7A770B4890644F97';

const noApi = () => createActions({ env: {}, log: () => {} });

test('四个动作都导出成函数', () => {
  const a = noApi();
  for (const k of ['list', 'status', 'grow', 'restore']) {
    assert.equal(typeof a[k], 'function', `缺动作 ${k}`);
  }
});

test('没有凭据时，动作返回人话而不是 ReferenceError', async () => {
  const a = noApi();

  const list = await a.list({});
  assert.equal(list.ok, true, 'list 不依赖 API，应当成功');

  const status = await a.status({ chatId: CHAT });
  assert.equal(status.ok, true);
  assert.match(String(status.data.api || ''), /ROOST_API/, '应当说明缺哪一项凭据');

  const grow = await a.grow({ chatId: CHAT });
  assert.equal(grow.ok, false);
  assert.match(String(grow.message), /连接不可用/, `实际：${grow.message}`);
  assert.ok(!/is not defined/.test(String(grow.message)), '不能是未定义标识符');

  const restore = await a.restore({ chatId: CHAT });
  // restore 会先清状态再尝试切人格；没有凭据时切人格失败，但不应崩
  assert.equal(typeof restore.ok, 'boolean');
  assert.ok(!/is not defined/.test(String(restore.message)));
});

test('没选会话时给出明确提示，而不是内部错误', async () => {
  const a = noApi();
  const r = await a.status({});
  assert.equal(r.ok, false);
  // 现在没给 chatId 会回落到「最近活跃群」；临时目录里没有群数据，于是给出明确拒绝
  assert.match(String(r.message), /没有可用的会话|选一个会话/);
});

test('模块里所有 lib 导出名都能解析（静态扫描 import 与使用）', async () => {
  const files = [`../${ENTRY}`, '../server.mjs'];
  for (const f of files) {
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL(f, import.meta.url), 'utf8'));
    // 收集 import 进来的名字
    const imported = new Set();
    // 静态 import
    for (const m of src.matchAll(/import\s+\{([^}]+)\}\s+from/g)) {
      for (const name of m[1].split(',')) imported.add(name.trim().split(/\s+as\s+/).pop().trim());
    }
    // 动态 import 的解构：`const { a, b } = await import(...)`（入口用带 ?v= 的写法）
    for (const m of src.matchAll(/const\s+\{([^}]+)\}\s*=\s*await\s+import\(/g)) {
      for (const name of m[1].split(',')) imported.add(name.trim().split(/\s*:\s*/).pop().trim());
    }
    // `const st = await import(...)` 这种整包引入
    for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\(/g)) {
      imported.add(`@ns:${m[1]}`);
    }
    // 检查源码里出现的、形如 lib 函数名的调用是否都 import 了
    const suspects = ['analyze', 'analyzeAuto', 'analyzeLocal', 'land', 'revert', 'mergeEntries', 'status', 'resetRecord', 'recordOf', 'noteLog', 'noteError', 'listGroups', 'latestGroup', 'setApiEnv', 'apiReady', 'apiWhy', 'renderGrowth'];
    for (const name of suspects) {
      const used = new RegExp(`\\b${name}\\s*\\(`).test(src);
      const byNamespace = [...imported].some((k) => k.startsWith('@ns:') && new RegExp(`\\b${k.slice(4)}\\.${name}\\s*\\(`).test(src));
      if (used && !byNamespace && !imported.has(name) && !new RegExp(`function\\s+${name}\\b`).test(src) && !new RegExp(`const\\s+${name}\\s*=`).test(src)) {
        assert.fail(`${f} 用了 ${name}() 但没 import`);
      }
    }
  }
});

test('切回原人格只是临时停用：条目不会被清空', async () => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  /**
   * 必须和入口用**同一个模块实例**。
   *
   * 入口用 `./lib/state.mjs?v=<版本>` 引入；这里若写成不带查询串的 '../lib/state.mjs'，
   * Node 会当成另一个模块——它有自己的 `cache`，`load()` 只读一次文件。
   * 于是「测试写了文件、动作读的还是旧缓存」，表现为条目数恒为 0。
   */
  const st = await import(`../lib/state.mjs?v=${MANIFEST.version}`);
  const CHAT = '44DE039E7B5FF07C7A770B4890644F97';
  const t = { chatId: CHAT, kind: 'group' };

  // 造两条成长条目 + 记下基底
  st.mergeEntries(t, [
    { category: '口吻', text: '爱用颜文字', maturity: 3 },
    { category: '习惯', text: '常反问', maturity: 2 },
  ]);
  st.setBase(t, 'llmm');

  // 面板里切回原人格
  writeFileSync(join(process.env.ROOST_LAUNCHER_DIR, 'config.json'),
    JSON.stringify({ persona: { current: 'llmm', byChat: { [CHAT]: 'llmm' } } }), 'utf8');

  const r = await createActions({ env: {} }).status({ chatId: CHAT });
  assert.equal(r.ok, true);
  assert.equal(r.data.entries.length, 2, '条目必须原样还在');
  assert.equal(r.data.abandoned, undefined, '不该再有放弃标记');
});

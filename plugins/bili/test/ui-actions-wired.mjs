/**
 * 面板按钮「点了没反应」的守门测试
 * ============================================================
 *
 * 这个 bug 已经犯过一次：「看看有没有人回 ta」按钮在 `ui/index.html` 里
 * 调 `act('check_replies')`，但 `plugin.json` 的 `ui.actions` 里没声明，
 * 宿主直接回 400「没有声明动作」——页面上只闪一下，看起来像没点上。
 *
 * 一个按钮要真的能点，三处必须同时存在：
 *
 *   1. 页面里调用了这个动作名（`act('...')`）；
 *   2. `plugin.json` 的 `ui.actions` 声明了它（宿主按白名单放行）；
 *   3. `ui/main.mjs` 里有同名实现（`runtime: inprocess` 直接调函数）。
 *
 * 少任何一处都不会报错，只是点了没反应。所以这里把三处对齐做成断言。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('..', import.meta.url));

const html = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../ui/main.mjs', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));

/** 面板里所有 `act('名字'` 的调用（含 silent 那一批） */
function calledActions() {
  const out = new Set();
  for (const m of html.matchAll(/act\('([a-z][a-z0-9_]*)'/g)) out.add(m[1]);
  return out;
}

/** 声明过的动作 id */
function declaredActions() {
  const list = manifest?.ui?.actions;
  assert.ok(Array.isArray(list) && list.length, 'plugin.json 必须声明 ui.actions');
  return new Set(list.map((a) => String(a?.id ?? '')));
}

/** 在 ui/main.mjs 里找同名方法（对象字面量里的 `async xxx(` / `xxx(`） */
function implemented(name) {
  const re = new RegExp(`^\\s+(?:async\\s+)?${name}\\s*\\(`, 'm');
  return re.test(main);
}

test('面板调用的每个动作都在 plugin.json 里声明过', () => {
  const declared = declaredActions();
  const missing = [...calledActions()].filter((n) => !declared.has(n));
  assert.deepEqual(missing, [], `这些按钮点了会 400（没有声明动作）：${missing.join(', ')}`);
});

test('声明过的每个动作都有实现', () => {
  const missing = [...declaredActions()].filter((n) => !implemented(n));
  assert.deepEqual(missing, [], `这些动作声明了但 ui/main.mjs 里没有：${missing.join(', ')}`);
});

test('每个按钮的 id 都能在页面里找到，且绑了事件', () => {
  /**
   * 只查**有动作的按钮**：设置项那一堆开关是 `renderSettings()` 动态生成的，
   * id 由字段名拼出来，不在这份静态 HTML 里。
   */
  const declared = declaredActions();
  const staticIds = new Set(
    [...html.matchAll(/<button[^>]*id="([^"]+)"/g)].map((m) => m[1]),
  );
  /** 这些 id 在 HTML 里出现，并且 onclick / 事件委托里也能找到 */
  for (const id of staticIds) {
    const wired = html.includes(`#${id}'`) || html.includes(`#${id}"`) || html.includes(`id === '${id}'`);
    assert.ok(wired, `按钮 #${id} 没有任何绑定`);
  }
  /** 声明了动作的按钮，页面上应该确实有个入口（否则用户根本点不到） */
  const actBtns = [...declared].filter((n) => n !== 'qr_cancel');
  assert.ok(actBtns.length >= 5, '动作太少，多半是声明被删了');
});

test('ui.main.mjs 导出了 createActions，按钮走进程内执行', () => {
  assert.match(main, /export function createActions/, '入口函数名要改的话，宿主那边也得改');
  assert.equal(manifest?.ui?.runtime, 'inprocess', '按钮走进程内执行，不该再排队');
  assert.equal(manifest?.ui?.entry, 'ui/main.mjs');
});

/**
 * 「现在刷一轮」必须强制开独立会话。
 *
 * 犯过一次：手动刷和定时刷共用 selfBrowse.run()，而它开头有一句
 * `if (!cfg.aiDecide) return`——开关默认关，于是点一百次都只拉数据，
 * 面板上「没反应、没开刷 B 站会话」。对齐 aurabot 的 `run({force:true})`
 * 以后，手动入口必须显式传 force，开关只管后台定时刷。
 *
 * 这里用静态断言守住，因为真跑一轮要建会话、等模型，不适合做单测。
 */
test('feed_now 用 force 绕过 aiDecide，手动刷一定会开会话', () => {
  assert.match(
    main,
    /** 实参里有 feed.items()，[^)]* 会被它的右括号截断，所以按语句匹配 */
    /selfBrowse\.run\([^;]*?\{\s*force:\s*true\s*\}\s*\)/,
    'feed_now 必须给 selfBrowse.run 传 { force: true }，否则开关一关按钮就哑了',
  );
  /** 提示里得说清「开关不管手动刷」，不然用户还会以为要去设置里开开关 */
  assert.match(JSON.stringify(manifest), /手动点「现在刷一轮」不受这个开关影响/,
    'aiDecide 的说明要写明手动刷不受它影响');
});

test('插件目录里没有漏掉的 check_replies 类问题：act 名字都能对上实现', () => {
  /** 这条是 1 的补集，单独写出来是为了失败信息更直白 */
  const declared = declaredActions();
  for (const name of calledActions()) {
    assert.ok(declared.has(name), `act('${name}') 没有对应声明`);
    assert.ok(implemented(name), `act('${name}') 没有对应实现`);
  }
  assert.ok(HERE.includes('bili'), '路径基准应该是扩展根目录');
});

// 第四轮验证报告：7 类问题
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const G1 = 'A'.repeat(31) + '1';
const G2 = 'B'.repeat(31) + '1';

function fakeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ps6-'));
  process.env.ROOST_LAUNCHER_DIR = root;
  const cfgDir = join(root, 'roost', 'config', 'bots', 'main', 'plugins');
  mkdirSync(cfgDir, { recursive: true });
  // 面板端口：真实实现只信 ports.json，所以测试夹具也得给一份
  mkdirSync(join(root, 'roost', 'data'), { recursive: true });
  writeFileSync(join(root, 'roost', 'data', 'ports.json'), JSON.stringify({ roost: { want: 8080, actual: 18080 } }), 'utf8');
  writeFileSync(join(cfgDir, 'persona-scope.json'), JSON.stringify({ cards: [], presets: [] }), 'utf8');
  return root;
}

const load = async (tag) => ({
  ops: await import(`../lib/ops.mjs?t=${tag}`),
  growth: await import(`../lib/growth.mjs?t=${tag}`),
});

const writeGrowth = (root, map) => writeFileSync(join(root, 'persona-growth.json'), JSON.stringify({
  version: 1,
  records: Object.fromEntries(Object.entries(map).map(([chatId, entries]) => [
    JSON.stringify(['', 'group', chatId]),
    { generation: 0, personaId: '', paused: false, entries, samples: [], total: entries.length, period: entries.length, lastAnalysisAt: 1, log: [] },
  ])),
}), 'utf8');

const E = (t) => [{ category: '口癖', text: t }];

/* 1. 不同群不能共用人格 id */

test('同一张卡叠加不同群 → 人格 id 不同，不会互相覆盖', async () => {
  const root = fakeRoot();
  writeGrowth(root, { [G1]: E('群一习惯'), [G2]: E('群二习惯') });
  const { ops } = await load('m1');
  await ops.saveCard({ name: '卡', text: '正文', growth: true });
  const cardId = ops.listAll().cards[0].id;

  const a = ops.previewOf({ cardId, growthChatId: G1 });
  const b = ops.previewOf({ cardId, growthChatId: G2 });
  assert.notEqual(a.id, b.id, '不同群必须得到不同 id');
  assert.match(a.id, /-grow-/);

  // 同卡同群仍然幂等
  const a2 = ops.previewOf({ cardId, growthChatId: G1 });
  assert.equal(a.id, a2.id, '同卡同群应当幂等');
});

test('不叠加成长时 id 不带后缀（保持旧行为）', async () => {
  fakeRoot();
  const { ops } = await load('m1b');
  await ops.saveCard({ name: '卡', text: '正文' });
  const pv = ops.previewOf({ cardId: ops.listAll().cards[0].id });
  assert.ok(!pv.id.includes('-grow'), pv.id);
});

/* 2. 清除必须精确匹配 */

test('清除只接受完整群 id，"1" 这种短串直接拒绝', async () => {
  const root = fakeRoot();
  writeGrowth(root, { [G1]: E('a'), [G2]: E('b') });
  const { growth } = await load('m2');

  await assert.rejects(() => growth.clearGrowth('1'), /32 位 openid/);
  const after = JSON.parse(readFileSync(join(root, 'persona-growth.json'), 'utf8'));
  assert.equal(after.records[JSON.stringify(['', 'group', G1])].entries.length, 1, '不该被动过');
  assert.equal(after.records[JSON.stringify(['', 'group', G2])].entries.length, 1);
});

test('清除完整 id 时只清那一个群', async () => {
  const root = fakeRoot();
  writeGrowth(root, { [G1]: E('a'), [G2]: E('b') });
  const { growth } = await load('m2b');
  const r = await growth.clearGrowth(G1);
  assert.equal(r.cleared, 1);
  const after = JSON.parse(readFileSync(join(root, 'persona-growth.json'), 'utf8'));
  assert.equal(after.records[JSON.stringify(['', 'group', G1])].entries.length, 0);
  assert.equal(after.records[JSON.stringify(['', 'group', G2])].entries.length, 1);
});

/* 3. 清除要遵循锁与代际 */

test('清除会把 generation +1（作废清除前启动的分析）', async () => {
  const root = fakeRoot();
  writeGrowth(root, { [G1]: E('a') });
  const { growth } = await load('m3');
  const before = JSON.parse(readFileSync(join(root, 'persona-growth.json'), 'utf8'));
  const gen0 = before.records[JSON.stringify(['', 'group', G1])].generation;
  await growth.clearGrowth(G1);
  const after = JSON.parse(readFileSync(join(root, 'persona-growth.json'), 'utf8'));
  assert.equal(after.records[JSON.stringify(['', 'group', G1])].generation, gen0 + 1);
});

test('成长扩展持锁时，清除会等待并最终报超时而不是硬写', async () => {
  const root = fakeRoot();
  writeGrowth(root, { [G1]: E('a') });
  const { growth } = await load('m4');
  // 模拟 persona-grow 正在写：占住同一把锁
  const lock = join(root, 'persona-growth.json.lock');
  writeFileSync(lock, '{"pid":1}', 'utf8');

  const before = readFileSync(join(root, 'persona-growth.json'), 'utf8');
  await assert.rejects(() => growth.clearGrowth(G1), /正被占用/);
  assert.equal(readFileSync(join(root, 'persona-growth.json'), 'utf8'), before, '锁在时不能写');
  // 清理锁，确认释放后能正常清
  const { unlinkSync } = await import('node:fs');
  unlinkSync(lock);
});

/* 4. 入口要把 byChat / personas 传下去 */

test('页面动作与 MCP 的 growth 数据包含生效判定所需的群与人格', async () => {
  const actions = readFileSync(new URL('../actions.mjs', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  for (const [name, src] of [['actions', actions], ['server', server]]) {
    assert.match(src, /byChat:\s*host\.byChat/, `${name} 没传 byChat`);
    assert.match(src, /personas:\s*host\.personas/, `${name} 没传 personas`);
  }
});

test('growthSnapshot 的 pickable 覆盖「有条目但没在用」的群', async () => {
  const root = fakeRoot();
  writeGrowth(root, { [G1]: E('a') });
  const { growth } = await load('m5');
  const snap = growth.growthSnapshot({}, []);
  assert.equal(snap.pickable.length, 1, '有條目就应当可选');
  assert.equal(snap.chats.length, 1);
});

/* 5. 卡片勾选必须提交、且不被保存重置 */

test('页面保存时提交 growth 勾选值', () => {
  const page = readFileSync(new URL('../page.html', import.meta.url), 'utf8');
  assert.match(page, /act\('saveCard',\s*\{[^}]*growth:/, '保存请求没带 growth');
});

test('业务层：不传 growth 时保留原值，不重置为 false', async () => {
  fakeRoot();
  const { ops } = await load('m6');
  const saved = await ops.saveCard({ name: '卡', text: '正文', growth: true });
  const id = saved.id || ops.listAll().cards[0].id;
  assert.equal(ops.listAll().cards[0].growth, true);

  // 模拟页面只改名字、不带 growth
  await ops.saveCard({ id, name: '改名', text: '正文' });
  assert.equal(ops.listAll().cards[0].growth, true, '不该被重置');
});

/* 6. 多群歧义时必须拒绝应用 */

test('卡片要求成长但群未定 → apply 拒绝，不写人格不绑定', async () => {
  const root = fakeRoot();
  writeGrowth(root, { [G1]: E('a'), [G2]: E('b') });
  const { ops } = await load('m7');
  await ops.saveCard({ name: '卡', text: '正文', growth: true });
  const cardId = ops.listAll().cards[0].id;

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => { calls.push(String(url)); return new Response('{"ok":true}', { status: 200 }); };
  try {
    await assert.rejects(
      () => ops.applyCard({ cardId, openid: 'C'.repeat(32) }),
      /叠加成长|选一个群/,
    );
    assert.equal(calls.filter((u) => u.includes('/personas/create')).length, 0, '不该写人格');
    assert.equal(calls.filter((u) => u.includes('/session.configure')).length, 0, '不该绑定');
  } finally { globalThis.fetch = realFetch; }
});

/* 7. 一键注入要同时打开插件内部开关 */

test('一键注入会写插件配置的 enabled 并区分两个开关', async () => {
  fakeRoot();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    calls.push({ url: String(url), method: opt?.method, body: opt?.body });
    if (String(url).includes('/config')) {
      return new Response(JSON.stringify({ ok: true, config: { enabled: true } }), { status: 200 });
    }
    return new Response('{"ok":true}', { status: 200 });
  };
  try {
    const { ops } = await load('m8');
    await ops.saveCard({ name: '卡', text: '正文' });
    const r = await ops.enableInjectionChannel();
    assert.equal(r.configEnabled, true, '应当写插件配置');
    assert.equal(r.pluginEnabled, true);
    const put = calls.find((c) => c.url.includes('/config'));
    assert.equal(put?.method, 'PUT');
    assert.match(String(put?.body || ''), /"enabled":true/);
    assert.match(r.note, /每轮注入/);
  } finally { globalThis.fetch = realFetch; }
});

test('只打开框架开关时，不能宣称注入已开启', async () => {
  fakeRoot();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/config')) return new Response('{"ok":false}', { status: 400 });
    return new Response('{"ok":true}', { status: 200 });
  };
  try {
    const { ops } = await load('m9');
    await ops.saveCard({ name: '卡', text: '正文' });
    const r = await ops.enableInjectionChannel();
    assert.equal(r.configEnabled, false);
    assert.match(r.note, /插件内部的「启用」没能改成功/);
  } finally { globalThis.fetch = realFetch; }
});

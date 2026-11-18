// 卡片成长开关 / 清除成长 / 每轮注入渠道
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ps5-'));
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

const GROW = (root, entries, chatId = 'GROUP1') => writeFileSync(join(root, 'persona-growth.json'), JSON.stringify({
  version: 1,
  records: {
    [JSON.stringify(['', 'group', chatId])]: {
      personaId: '', baseId: 'llmm', paused: false, entries, samples: [{ id: 's' }], lastAnalysisAt: 9, log: [],
    },
  },
}), 'utf8');

const ENTRIES = [{ category: '口癖', text: '会加「嘛」' }];
const FULL_G1 = 'A'.repeat(31) + '1';
const FULL_G2 = 'B'.repeat(31) + '2';

/* 1. 卡片开关 */

test('卡片默认不受成长影响；勾上后才叠加', async () => {
  const root = fakeRoot();
  GROW(root, ENTRIES);
  const { ops } = await load('k1');

  await ops.saveCard({ name: '不叠', text: '正文' });
  const off = ops.listAll().cards[0];
  assert.equal(off.growth, false, '默认应当是 false');
  const pvOff = ops.previewOf({ cardId: off.id });
  assert.equal(pvOff.growthEntries, 0);
  assert.ok(!pvOff.raw.includes('慢慢长出来的习惯'));

  await ops.saveCard({ id: off.id, name: '不叠', text: '正文', growth: true });
  assert.equal(ops.listAll().cards[0].growth, true);
  const pvOn = ops.previewOf({ cardId: off.id });
  assert.equal(pvOn.growthEntries, 1, '勾上之后应当自动挑到唯一在长的群');
  assert.ok(pvOn.raw.includes('会加「嘛」'));
});

test('多个群在长且没指定群时，要求用户选而不是乱猜', async () => {
  const root = fakeRoot();
  writeFileSync(join(root, 'persona-growth.json'), JSON.stringify({
    version: 1,
    records: {
      [JSON.stringify(['', 'group', FULL_G1])]: { personaId: '', paused: false, entries: ENTRIES },
      [JSON.stringify(['', 'group', FULL_G2])]: { personaId: '', paused: false, entries: ENTRIES },
    },
  }), 'utf8');
  const { ops } = await load('k2');
  await ops.saveCard({ name: '卡', text: '正文', growth: true });
  const pv = ops.previewOf({ cardId: ops.listAll().cards[0].id });
  assert.equal(pv.growthEntries, 0);
  assert.match(pv.growthNote, /选一个群/);
});

/* 2. 清除成长 */

test('清除成长：条目与采样归零，留备份，其他群不动', async () => {
  const root = fakeRoot();
  writeFileSync(join(root, 'persona-growth.json'), JSON.stringify({
    version: 1,
    records: {
      [JSON.stringify(['', 'group', FULL_G1])]: { personaId: '', paused: false, entries: ENTRIES, samples: [{ id: 's' }], total: 5, period: 5, lastAnalysisAt: 9, log: [] },
      [JSON.stringify(['', 'group', FULL_G2])]: { personaId: '', paused: false, entries: ENTRIES, samples: [{ id: 't' }], total: 3, period: 3, lastAnalysisAt: 8, log: [] },
    },
  }), 'utf8');

  const { ops } = await load('k3');
  const r = await ops.clearGrowthOf({ chatId: FULL_G1 });
  assert.equal(r.ok, true);
  assert.equal(r.cleared, 1);

  const after = JSON.parse(readFileSync(join(root, 'persona-growth.json'), 'utf8'));
  const g1 = after.records[[JSON.stringify(['', 'group', FULL_G1])]];
  const g2 = after.records[[JSON.stringify(['', 'group', FULL_G2])]];
  assert.deepEqual(g1.entries, []);
  assert.deepEqual(g1.samples, []);
  assert.equal(g1.total, 0);
  assert.equal(g1.lastAnalysisAt, 0);
  assert.equal(g2.entries.length, 1, '其他群不能被清');

  // 有备份
  assert.ok(readdirSync(root).some((n) => n.includes('.bak-')), '应当留备份');
});

test('没有成长文件时清除会明确报错，而不是假装成功', async () => {
  fakeRoot();
  const { growth } = await load('k4');
  await assert.rejects(() => growth.clearGrowth(FULL_G1), /还没有成长数据/);
});

/* 3. 每轮注入渠道 */

test('开启注入：导出到插件 + 启用插件', async () => {
  fakeRoot();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    calls.push({ url: String(url), method: opt?.method });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const { ops } = await load('k5');
    await ops.saveCard({ name: '卡', text: '正文' });
    const r = await ops.enableInjectionChannel();
    assert.equal(r.ok, true);
    assert.equal(r.pluginEnabled, true);
    assert.ok(calls.some((c) => c.url.includes('/api/plugins/persona-scope/enable')), '没发启用请求');
    assert.ok(calls.some((c) => c.url.includes('/reload')), '没发重载请求');
    assert.match(r.note, /每轮注入/);
  } finally { globalThis.fetch = realFetch; }
});

test('启用失败时给出可操作提示', async () => {
  fakeRoot();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const { ops } = await load('k6');
    await ops.saveCard({ name: '卡', text: '正文' });
    const r = await ops.enableInjectionChannel();
    assert.equal(r.pluginEnabled, false);
    assert.match(r.note, /手动启用/);
  } finally { globalThis.fetch = realFetch; }
});

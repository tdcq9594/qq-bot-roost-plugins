// 第三轮验证报告：4 项剩余问题
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeRoot(bots = ['main']) {
  const root = mkdtempSync(join(tmpdir(), 'ps3-'));
  for (const bot of bots) {
    mkdirSync(join(root, 'roost', 'data'), { recursive: true });
    writeFileSync(join(root, 'roost', 'data', 'ports.json'), JSON.stringify({ roost: { want: 8080, actual: 18080 } }), 'utf8');
    const dir = join(root, 'roost', 'config', 'bots', bot, 'plugins');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'persona-scope.json'), JSON.stringify({ cards: [], presets: [], maxChars: 4900 }, null, 2), 'utf8');
  }
  process.env.ROOST_LAUNCHER_DIR = root;
  return root;
}

const load = async (tag) => ({
  interop: await import(`../lib/interop.mjs?t=${tag}`),
  ops: await import(`../lib/ops.mjs?t=${tag}`),
  growth: await import(`../lib/growth.mjs?t=${tag}`),
});

/* ── P1：多机器人时重载要带对 bot ────────────────────── */

test('多机器人：写入哪只就重载哪只（URL 带 ?bot=）', async () => {
  const root = fakeRoot(['main', 'second']);
  const second = join(root, 'roost/config/bots/second/plugins/persona-scope.json');
  await new Promise((r) => setTimeout(r, 25));
  writeFileSync(second, JSON.stringify({ cards: [], presets: [] }), 'utf8'); // 让它成为最新

  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const { ops } = await load('c1');
    await ops.saveCard({ name: '卡', text: 'x' });
    const r = await ops.exportToPlugin();

    assert.equal(r.botId, 'second', `写错了机器人：${r.botId}`);
    assert.equal(r.reloadedBot, 'second');
    assert.ok(seen.some((u) => u.includes('/api/plugins/persona-scope/reload?bot=second')),
      `重载没带对 bot：${seen.join(', ')}`);
    assert.match(r.note, /second/);
  } finally { globalThis.fetch = realFetch; }
});

test('单机器人：botId 也要正确解析出来', async () => {
  fakeRoot(['main']);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  try {
    const { ops } = await load('c1b');
    await ops.saveCard({ name: '卡', text: 'x' });
    const r = await ops.exportToPlugin();
    assert.equal(r.botId, 'main');
    assert.equal(r.reloaded, true);
  } finally { globalThis.fetch = realFetch; }
});

/* ── P2：成长误报 ────────────────────────────────────── */

const PERSONAS = [
  { id: 'llmm', label: '妈妈', tags: [] },
  { id: 'g-1', label: 'llmm（成长）', tags: ['auto', 'growth'] },
];

test('只有采样、尚未落地 → 不算「正在使用成长人格」', async () => {
  const root = fakeRoot();
  writeFileSync(join(root, 'persona-growth.json'), JSON.stringify({
    version: 1,
    records: { '["","group","G1"]': { personaId: '', baseId: '', paused: false, entries: [], samples: [{ id: 's1' }] } },
  }), 'utf8');

  const { growth } = await load('c2');
  const snap = growth.growthSnapshot({}, PERSONAS);
  const c = growth.growthConflicts({ AAA: 'x' }, snap, {});
  assert.equal(c.active.length, 0, '仅采样不该算生效');
});

test('已切回普通人格 → 不算成长（即使记录里有 baseId）', async () => {
  const root = fakeRoot();
  writeFileSync(join(root, 'persona-growth.json'), JSON.stringify({
    version: 1,
    records: { '["","group","G1"]': { personaId: '', baseId: 'llmm', paused: false, entries: [{ text: 'x' }], samples: [] } },
  }), 'utf8');

  const { growth } = await load('c3');
  // 宿主此刻该群用的是普通人格
  const snap = growth.growthSnapshot({ G1: 'llmm' }, PERSONAS);
  const c = growth.growthConflicts({ AAA: 'x' }, snap, { G1: 'llmm' });
  assert.equal(c.active.length, 0, 'baseId 有值不代表还在用');
});

test('宿主已切到成长人格 → 算生效', async () => {
  const root = fakeRoot();
  writeFileSync(join(root, 'persona-growth.json'), JSON.stringify({
    version: 1,
    records: { '["","group","G1"]': { personaId: '', baseId: 'llmm', paused: false, entries: [{ text: 'x' }], samples: [{ id: 's' }] } },
  }), 'utf8');

  const { growth } = await load('c4');
  const snap = growth.growthSnapshot({ G1: 'g-1' }, PERSONAS);
  const c = growth.growthConflicts({ AAA: 'x' }, snap, { G1: 'g-1' });
  assert.equal(c.active.length, 1);
  assert.equal(c.active[0].personaId, 'g-1');
  assert.match(c.note, /解绑/);
});

test('人格清单里查不到该 id → 不误报', async () => {
  const root = fakeRoot();
  writeFileSync(join(root, 'persona-growth.json'), JSON.stringify({
    version: 1,
    records: { '["","group","G1"]': { personaId: 'ghost', paused: false, entries: [{ text: 'x' }] } },
  }), 'utf8');

  const { growth } = await load('c5');
  const snap = growth.growthSnapshot({}, PERSONAS);
  assert.equal(growth.growthConflicts({ AAA: 'x' }, snap, {}).active.length, 0);
});

/* ── P2：页面删卡后不能空选 ─────────────────────────── */

test('删掉选中的卡后，下拉框退到第一张而不是空', () => {
  const html = readFileSync(new URL('../page.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.match(script, /if \(!sel\.value && state\.cards\.length\) sel\.value = state\.cards\[0\]\.id;/);
  assert.match(script, /if \(!sel\.value && state\.presets\.length\) sel\.value = state\.presets\[0\]\.id;/);
});

/* ── P2：导入确认文案与真实行为一致 ─────────────────── */

test('导入确认框文案说明的是「保留本地」而不是「插件覆盖」', () => {
  const html = readFileSync(new URL('../page.html', import.meta.url), 'utf8');
  const line = html.split('\n').find((l) => l.includes("confirm('从 Roost 插件导入"));
  assert.ok(line, '没找到确认框');
  assert.match(line, /保留本地版本/);
  assert.ok(!/会被插件的版本覆盖/.test(line), '旧文案还在');
});

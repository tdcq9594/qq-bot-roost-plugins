// 人格占位符：检测与修复（这类人格会让整轮没有回复）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ps10-'));
  process.env.ROOST_LAUNCHER_DIR = root;
  return root;
}

const load = async (tag) => {
  const { setApiEnv } = await import('../lib/api.mjs');
  setApiEnv({ ROOST_API_URL: 'http://fixture.invalid/v1', ROOST_API_TOKEN: 't' });
  return { ops: await import(`../lib/ops.mjs?t=${tag}`) };
};

/** 假的宿主人格库 */
let realFetch = null;

function stubHost({ personas }) {
  const calls = [];
  if (!realFetch) realFetch = globalThis.fetch;   // 保留原生 fetch，测完要还回去
  const store = new Map(personas.map((p) => [p.id, p.raw]));
  globalThis.fetch = async (url, opt) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/v1/, '');
    calls.push({ path, method: opt?.method || 'GET', body: opt?.body ? JSON.parse(opt.body) : null });
    const reply = (o) => new Response(JSON.stringify(o), { status: 200 });

    if (path === '/personas') {
      return reply({
        ok: true, current: 'default', effective: 'default', byChat: {}, bySender: {},
        rows: personas.map((p) => ({ id: p.id, label: p.label, tags: [], chars: store.get(p.id).length })),
      });
    }
    if (path === '/personas/read') {
      const id = u.searchParams.get('id');
      return reply({ ok: true, id, raw: store.get(id) ?? '', chars: (store.get(id) ?? '').length });
    }
    if (path === '/personas/save') {
      const { id, raw } = JSON.parse(opt.body);
      store.set(id, raw);
      return reply({ ok: true });
    }
    return reply({ ok: true });
  };
  return { calls, store };
}

test('扫出带占位符的人格', async () => {
  fakeRoot();
  const host = stubHost({
    personas: [
      { id: 'good', label: '好的', raw: '纯文本人格' },
      { id: 'bad', label: '爱莉安娜', raw: '目前是 {{user}} 的恋人' },
    ],
  });
  try {
    const { ops } = await load('pb1');
    const r = await ops.scanBrokenPersonas();
    assert.equal(r.total, 2);
    assert.deepEqual(r.broken.map((x) => x.id), ['bad']);
  } finally { globalThis.fetch = realFetch; }
});

test('修复会把占位符渲染成纯文本（{{user}} → 你）', async () => {
  fakeRoot();
  const host = stubHost({
    personas: [{ id: 'bad', label: '爱莉安娜', raw: '# 角色\n目前是 {{user}} 的恋人，自称 {{char}}。\n{{if /x/}}A{{else}}B{{end}}' }],
  });
  try {
    const { ops } = await load('pb2');
    const r = await ops.repairPersonas({ dryRun: false });
    assert.equal(r.fixed, 1);

    const saved = host.store.get('bad');
    assert.ok(!/\{\{/.test(saved), `还留着占位符：${saved}`);
    assert.match(saved, /目前是 你 的恋人/);
    assert.match(saved, /自称 爱莉安娜/);
    assert.match(saved, /B/);
  } finally { globalThis.fetch = realFetch; }
});

test('默认就是 dryRun：不传参数不会落盘', async () => {
  fakeRoot();
  const host = stubHost({ personas: [{ id: 'bad', label: 'x', raw: '{{user}}' }] });
  try {
    const { ops } = await load('pb0');
    const r = await ops.repairPersonas({});
    assert.equal(r.dryRun, true, '默认应当是只报告');
    assert.equal(host.store.get('bad'), '{{user}}', '默认不该写');
  } finally { globalThis.fetch = realFetch; }
});

test('dryRun 只报告不写', async () => {
  fakeRoot();
  const host = stubHost({ personas: [{ id: 'bad', label: 'x', raw: '{{user}}' }] });
  try {
    const { ops } = await load('pb3');
    const r = await ops.repairPersonas({ dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.fixed, 1);
    assert.equal(host.store.get('bad'), '{{user}}', 'dryRun 不该写');
    assert.ok(!host.calls.some((c) => c.path === '/personas/save'));
  } finally { globalThis.fetch = realFetch; }
});

test('没有坏人格时安静返回', async () => {
  fakeRoot();
  stubHost({ personas: [{ id: 'ok', label: 'ok', raw: '正常' }] });
  try {
    const { ops } = await load('pb4');
    const r = await ops.repairPersonas({});
    assert.equal(r.fixed, 0);
    assert.match(r.note, /没有发现/);
  } finally { globalThis.fetch = realFetch; }
});

test('页面有告警条与修复按钮', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../page.html', import.meta.url), 'utf8');
  assert.match(page, /id="brokenWarn"/);
  assert.match(page, /id="btnRepair"/);
  assert.match(page, /repairPersonas/);
});

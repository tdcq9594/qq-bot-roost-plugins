// 针对验证报告的回归测试：每个 case 对应一个已复现的问题
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 每个用例一个独立状态目录：patch 掉 ROOST_LAUNCHER_DIR 再动态 import */
function freshDir() {
  const d = mkdtempSync(join(tmpdir(), 'ps-state-'));
  process.env.ROOST_LAUNCHER_DIR = d;
  return d;
}

const load = async (tag) => ({
  state: await import(`../lib/state.mjs?t=${tag}`),
  ops: await import(`../lib/ops.mjs?t=${tag}`),
  actions: await import(`../actions.mjs?t=${tag}`),
});

/** 假的 /v1 宿主：只实现本扩展用到的三条，记录调用顺序 */
function stubHost() {
  const calls = [];
  const personas = [{ id: 'p-existing', label: '已有', chars: 10 }];
  globalThis.fetch = async (url, opt) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/v1/, '');
    const body = opt?.body ? JSON.parse(opt.body) : null;
    calls.push({ path, method: opt?.method || 'GET', body });
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status });

    if (path === '/personas' && (!opt?.method || opt.method === 'GET')) {
      return reply({ ok: true, current: 'p-existing', effective: 'p-existing', byChat: {}, bySender: {}, rows: personas });
    }
    if (path === '/personas/create') return reply({ ok: true });
    if (path === '/session.configure') return reply({ ok: true });
    if (path === '/personas/read') return reply({ ok: true, raw: '正文', chars: 2 });
    return reply({ ok: false, message: `未桩：${path}` }, 404);
  };
  return calls;
}

/* ── 问题 1：返回必须带 data 信封 ───────────────────────── */

test('动作返回值带 data 信封（否则页面拿到 null）', async () => {
  freshDir();
  stubHost();
  const { actions } = await load('a1');
  const act = actions.createActions({ env: { ROOST_API_URL: 'http://fixture.invalid/v1', ROOST_API_TOKEN: 't' } });

  const st = await act.status({});
  assert.equal(st.ok, true);
  assert.ok(st.data, '必须带 data');
  assert.ok(Array.isArray(st.data.cards), 'data.cards 要在信封里');
  assert.ok(Array.isArray(st.data.personas), '宿主人格要在信封里');

  await act.saveCard({ name: '测试卡', text: '正文' });
  const pv = await act.preview({ cardId: (await act.status({})).data.cards[0].id });
  assert.equal(pv.ok, true);
  assert.ok(pv.data?.raw?.includes('正文'), `预览正文丢了：${JSON.stringify(pv)}`);
});

/* ── 问题 2：页面用到的动作必须在清单里 ─────────────────── */

test('页面调用的动作全部在 ui.actions 里', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));
  const page = readFileSync(new URL('../page.html', import.meta.url), 'utf8');
  const used = [...page.matchAll(/act\('([a-zA-Z]+)'/g)].map((m) => m[1]);
  const declared = new Set(manifest.ui.actions.map((a) => a.id));
  const missing = [...new Set(used)].filter((a) => !declared.has(a));
  assert.deepEqual(missing, [], `清单缺：${missing.join(', ')}`);

  // 导出也要齐全
  freshDir();
  const { actions } = await load('a2');
  const impl = actions.createActions({ env: {} });
  const noImpl = [...declared].filter((id) => typeof impl[id] !== 'function');
  assert.deepEqual(noImpl, [], `清单声明了但没实现：${noImpl.join(', ')}`);
});

/* ── 问题 4：openid 错误时不能写人格 ───────────────────── */

test('openid 非法时不发任何写请求', async () => {
  freshDir();
  const calls = stubHost();
  const { actions } = await load('a4');
  const act = actions.createActions({ env: { ROOST_API_URL: 'http://fixture.invalid/v1', ROOST_API_TOKEN: 't' } });

  await act.saveCard({ name: '卡', text: '正文' });
  const cardId = (await act.status({})).data.cards[0].id;

  calls.length = 0;
  const r = await act.apply({ cardId, openid: 'not-an-openid' });
  assert.equal(r.ok, false);
  assert.equal(calls.filter((c) => c.path === '/personas/create').length, 0, '不该写人格');
  assert.equal(calls.filter((c) => c.path === '/session.configure').length, 0);
});

/* ── 问题 5：并发保存不能丢更新 ────────────────────────── */

test('两个进程同时保存，两张卡都在', async () => {
  const dir = freshDir();
  const worker = fileURLToPath(new URL('./support/state-write-worker.mjs', import.meta.url));
  const runOne = (name) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [worker, name], {
      env: { ...process.env, ROOST_LAUNCHER_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`worker exit ${code}: ${err || out}`))));
  });

  await Promise.all([runOne('甲卡'), runOne('乙卡')]);

  const file = join(dir, 'persona-scope-ext.json');
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const names = j.cards.map((c) => c.name).sort();
  assert.deepEqual(names, ['乙卡', '甲卡'].sort(), `丢了一次更新：${JSON.stringify(names)}`);
});

/* ── 问题 6：损坏文件不能被静默覆盖 ────────────────────── */

test('素材文件损坏时报错并保留备份，不写空库', async () => {
  const dir = freshDir();
  const file = join(dir, 'persona-scope-ext.json');
  writeFileSync(file, '{"cards":[{"id":"a","name":"原卡","text":"x"}],"presets":[', 'utf8'); // 尾部坏掉

  const { actions } = await load('a6');
  const act = actions.createActions({ env: {} });
  const r = await act.status({});
  assert.equal(r.ok, false, '应当报错而不是返回空库');
  assert.match(r.message, /损坏|备份/);

  assert.equal(existsSync(file), true, '坏文件要留在原位，避免被空库覆盖');
  const backups = readdirSync(dir).filter((n) => n.includes('.corrupt-'));
  assert.equal(backups.length, 1, `应保留一份备份，实际：${backups.join(',')}`);
  assert.match(readFileSync(join(dir, backups[0]), 'utf8'), /原卡/, '备份里要能找回原数据');

  // 再保存一次：不能把原数据变成空库
  const w = await act.savePreset({ name: '新预设', text: 'y' });
  assert.equal(w.ok, false, '损坏状态下保存也要被拒，避免二次覆盖');
});

/* ── 问题 7：宿主换发令牌后要能自愈 ────────────────────── */

test('401 时回落到 secrets 里的新令牌重试一次', async () => {
  const dir = freshDir();
  // secrets 里放一个「新」令牌
  mkdirSync(join(dir, 'secrets'), { recursive: true });
  writeFileSync(join(dir, 'secrets', 'persona-scope-ext.json'), JSON.stringify({ token: 'NEW-TOKEN' }), 'utf8');

  const seen = [];
  globalThis.fetch = async (url, opt) => {
    seen.push(opt?.headers?.authorization);
    if (opt?.headers?.authorization === 'Bearer OLD-TOKEN') {
      return new Response(JSON.stringify({ ok: false, message: 'unauthorized' }), { status: 401 });
    }
    return new Response(JSON.stringify({ ok: true, current: 'x', effective: 'x', byChat: {}, bySender: {}, rows: [] }), { status: 200 });
  };

  const { actions } = await load('a7');
  const act = actions.createActions({
    env: { ROOST_API_URL: 'http://fixture.invalid/v1', ROOST_API_TOKEN: 'OLD-TOKEN', ROOST_EXT_ID: 'persona-scope-ext', ROOST_LAUNCHER_DIR: dir },
  });
  const r = await act.status({});
  assert.equal(r.ok, true, `应当用新令牌自愈：${JSON.stringify(r)}`);
  // 状态查询现在还会顺带扫一遍坏人格，所以只校验**前两次**（旧 → 401 → 新）
  assert.deepEqual(seen.slice(0, 2), ['Bearer OLD-TOKEN', 'Bearer NEW-TOKEN'], `调用序列不对：${seen.join(' → ')}`);
  assert.ok(seen.slice(2).every((x) => x === 'Bearer NEW-TOKEN'), `重试后不该再用旧令牌：${seen.join(' → ')}`);
});

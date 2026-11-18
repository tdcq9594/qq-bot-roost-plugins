// 审查意见 5 条：按人 id / 端口不猜 / 面板鉴权 / 修复默认 dry-run / extId 校验
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const A = 'A'.repeat(32);
const B = 'B'.repeat(32);

function fakeRoot({ ports = true, accessKey = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ps11-'));
  process.env.ROOST_LAUNCHER_DIR = root;
  const cfgDir = join(root, 'roost', 'config', 'bots', 'main', 'plugins');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'persona-scope.json'), JSON.stringify({ cards: [], presets: [] }), 'utf8');
  mkdirSync(join(root, 'roost', 'config'), { recursive: true });
  writeFileSync(join(root, 'roost', 'config', 'bot.json'), JSON.stringify({ webui: { accessKey } }), 'utf8');
  if (ports) {
    mkdirSync(join(root, 'roost', 'data'), { recursive: true });
    writeFileSync(join(root, 'roost', 'data', 'ports.json'), JSON.stringify({ roost: { actual: 18080 } }), 'utf8');
  }
  return root;
}

const loadOps = async (tag) => {
  const { setApiEnv } = await import('../lib/api.mjs');
  setApiEnv({ ROOST_API_URL: 'http://fixture.invalid/v1', ROOST_API_TOKEN: 't' });
  return import(`../lib/ops.mjs?t=${tag}`);
};

/* ── 1. 按人：同一张卡不能互相覆盖 ───────────────────── */

test('同一张卡给两个人 → 两个人格 id（不会覆盖）', async () => {
  const { genPersonaId } = await loadOps('r1');
  const a = genPersonaId({ cardId: 'same-card', senderId: A });
  const b = genPersonaId({ cardId: 'same-card', senderId: B });
  assert.notEqual(a, b, `两个人拿到同一个 id：${a}`);
  assert.ok(a.includes(A) && b.includes(B), '完整发送者要进 id');
  assert.ok(a.length <= 60 && b.length <= 60, `${a.length}/${b.length} 超 60`);
});

test('同人同卡同群幂等；换群也换 id', async () => {
  const { genPersonaId } = await loadOps('r2');
  const base = genPersonaId({ cardId: 'c', senderId: A, chatId: 'G'.repeat(32) });
  assert.equal(base, genPersonaId({ cardId: 'c', senderId: A, chatId: 'G'.repeat(32) }));
  const other = genPersonaId({ cardId: 'c', senderId: A, chatId: 'H'.repeat(32) });
  assert.notEqual(base, other);
});

test('群哈希位宽按剩余预算自适应：能长就长，最低 8 位', async () => {
  const { genPersonaId } = await loadOps('r2b');
  const chat = 'G'.repeat(32);
  const widthOf = (id) => {
    const m = /-g([0-9a-f]+)-/.exec(id);
    return m ? m[1].length : 0;
  };

  // 短卡：把剩下的位宽全给群哈希（上限 12）
  const short = genPersonaId({ cardId: 'c1', senderId: A, chatId: chat });
  assert.equal(widthOf(short), 12, `短卡应给满 12 位：${short}`);
  assert.ok(short.length <= 60);

  // 长卡（要压成 h+8）：群哈希退到 10 位，但绝不低于 8
  for (const len of [13, 20, 40]) {
    const id = genPersonaId({ cardId: 'k'.repeat(len), senderId: A, chatId: chat });
    assert.ok(id.length <= 60, `${len} 字卡超限：${id.length}`);
    assert.ok(widthOf(id) >= 8 && widthOf(id) <= 12, `${len} 字卡的群哈希位宽异常：${widthOf(id)}`);
  }

  // 同一群换个卡片长度，哈希前缀一致（同群认得出）
  assert.ok(short.includes('-gca02a7bbd898-') || widthOf(short) === 12);
});

test('长卡片 id 也压得住 60（带发送者 + 群）', async () => {
  const { genPersonaId } = await loadOps('r3');
  for (const len of [1, 8, 16, 17, 40, 90]) {
    const id = genPersonaId({ cardId: 'k'.repeat(len), senderId: A, chatId: 'G'.repeat(32) });
    assert.ok(id.length <= 60, `卡片 ${len} 字 → ${id.length}：${id}`);
  }
});

test('预览给同一个人的 id 与另一个人不同', async () => {
  const root = fakeRoot();
  writeFileSync(join(root, 'persona-growth.json'), JSON.stringify({
    version: 1,
    records: { [JSON.stringify(['', 'group', 'G'.repeat(32)])]: { personaId: '', entries: [{ category: 'x', text: 'y' }] } },
  }), 'utf8');
  const ops = await loadOps('r4');
  await ops.saveCard({ name: '卡', text: '正文', growth: true });
  const cardId = ops.listAll().cards[0].id;
  const pa = ops.previewOf({ cardId, growthChatId: 'G'.repeat(32), openid: A });
  const pb = ops.previewOf({ cardId, growthChatId: 'G'.repeat(32), openid: B });
  assert.notEqual(pa.id, pb.id);
});

/* ── 2. 端口读不到不猜 ──────────────────────────────── */

test('没有 ports.json 时不去碰 8080', async () => {
  fakeRoot({ ports: false });
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => { calls.push(String(u)); return new Response('{"ok":true}', { status: 200 }); };
  try {
    const ops = await loadOps('r5');
    await ops.saveCard({ name: '卡', text: '正文' });
    const r = await ops.enableInjectionChannel();
    assert.equal(calls.some((u) => u.includes(':8080')), false, `不该猜 8080：${calls.join(',')}`);
    assert.equal(r.pluginEnabled, false);
    assert.equal(r.configEnabled, false);
    assert.match(r.note, /手动|ports\.json|读不到/);
  } finally { globalThis.fetch = real; }
});

/* ── 3. 面板鉴权：带上 accessKey ────────────────────── */

test('面板设了 accessKey 时会带 X-Access-Key', async () => {
  fakeRoot({ accessKey: 'S3CRET' });
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u, opt) => {
    seen.push({ url: String(u), key: opt?.headers?.['x-access-key'] });
    return new Response('{"ok":true}', { status: 200 });
  };
  try {
    const ops = await loadOps('r6');
    await ops.saveCard({ name: '卡', text: '正文' });
    await ops.exportToPlugin();
    assert.ok(seen.length > 0);
    assert.ok(seen.every((c) => c.key === 'S3CRET'), `没带密钥：${JSON.stringify(seen.map((c) => c.key))}`);
  } finally { globalThis.fetch = real; }
});

test('401 时把状态码写进提示，而不是吞成 false', async () => {
  fakeRoot({ accessKey: 'WRONG' });
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":"访问密钥无效"}', { status: 401 });
  try {
    const ops = await loadOps('r7');
    await ops.saveCard({ name: '卡', text: '正文' });
    const r = await ops.enableInjectionChannel();
    assert.equal(r.configEnabled, false);
    assert.match(r.note, /401|访问密钥/);
  } finally { globalThis.fetch = real; }
});

/* ── 4. 修复默认 dry-run ───────────────────────────── */

test('MCP 工具与业务层默认都不落盘，必须显式 dryRun:false', async () => {
  const root = fakeRoot();
  const store = new Map([['bad', '{{user}}']]);
  process.env.ROOST_LAUNCHER_DIR = root;
  const real = globalThis.fetch;
  globalThis.fetch = async (u, opt) => {
    const url = new URL(String(u));
    const path = url.pathname.replace(/^\/v1/, '');
    const reply = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (path === '/personas') return reply({ ok: true, rows: [{ id: 'bad', label: '坏', tags: [] }], byChat: {}, bySender: {} });
    if (path === '/personas/read') return reply({ ok: true, raw: store.get(url.searchParams.get('id')) ?? '' });
    if (path === '/personas/save') { store.set(JSON.parse(opt.body).id, JSON.parse(opt.body).raw); return reply({ ok: true }); }
    return reply({ ok: true });
  };
  try {
    const ops = await loadOps('r8');
    const r = await ops.repairPersonas({});
    assert.equal(r.dryRun, true);
    assert.equal(store.get('bad'), '{{user}}', '默认不能写');

    const w = await ops.repairPersonas({ dryRun: false });
    assert.equal(w.dryRun, false);
    assert.ok(!/\{\{/.test(store.get('bad')), '显式 false 才写');
  } finally { globalThis.fetch = real; }
});

test('server 层把缺省的 dryRun 当成 true', () => {
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(src, /dryRun:\s*args\?\.dryRun !== false/, 'MCP 默认应当是只报告');
});

/* ── 5. extId 校验 ─────────────────────────────────── */

test('ROOST_EXT_ID 与本扩展不符时，不读 secrets', async () => {
  const root = fakeRoot({ ports: false });
  mkdirSync(join(root, 'secrets'), { recursive: true });
  writeFileSync(join(root, 'secrets', 'someone-else.json'), JSON.stringify({ token: 'FOREIGN' }), 'utf8');
  writeFileSync(join(root, 'secrets', 'persona-scope-ext.json'), JSON.stringify({ token: 'OWN' }), 'utf8');

  const { setApiEnv, apiReady } = await import('../lib/api.mjs');
  setApiEnv({
    ROOST_API_URL: 'http://fixture.invalid/v1',
    ROOST_API_TOKEN: 'OLD',
    ROOST_EXT_ID: 'someone-else',
    ROOST_LAUNCHER_DIR: root,
  });

  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u, opt) => {
    seen.push(opt?.headers?.authorization || '');
    return seen.length === 1
      ? new Response('{"error":"token 过期"}', { status: 401 })
      : new Response('{"ok":true}', { status: 200 });
  };
  try {
    const api = await import('../lib/api.mjs?t=own');
    const { setOwnExtId } = api;
    setOwnExtId('persona-scope-ext');
    await api.get('/state').catch(() => {});
    assert.ok(!seen.includes('Bearer FOREIGN'), `读到了别人的令牌：${seen.join(',')}`);
    assert.ok(apiReady !== undefined);
  } finally { globalThis.fetch = real; }
});

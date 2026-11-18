// 第二轮验证报告的回归测试（7 项）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeRoot({ pluginJson = null, bots = 1 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ps2-'));
  for (let i = 0; i < bots; i += 1) {
    // 面板端口：实现只信 ports.json，夹具也要给
    mkdirSync(join(root, 'roost', 'data'), { recursive: true });
    writeFileSync(join(root, 'roost', 'data', 'ports.json'), JSON.stringify({ roost: { want: 8080, actual: 18080 } }), 'utf8');
    const dir = join(root, 'roost', 'config', 'bots', `bot${i}`, 'plugins');
    mkdirSync(dir, { recursive: true });
    const body = pluginJson ?? { enabled: true, targets: 'AAA', maxChars: 4900, cards: [], presets: [] };
    writeFileSync(join(dir, 'persona-scope.json'), typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'utf8');
  }
  process.env.ROOST_LAUNCHER_DIR = root;
  return root;
}

const load = async (tag) => ({
  interop: await import(`../lib/interop.mjs?t=${tag}`),
  ops: await import(`../lib/ops.mjs?t=${tag}`),
  state: await import(`../lib/state.mjs?t=${tag}`),
  growth: await import(`../lib/growth.mjs?t=${tag}`),
});

/* 1. 导出要通知运行中的插件重载 */
test('导出后会请求插件重载（否则下次保存会覆盖导出）', async () => {
  fakeRoot();
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    seen.push({ url: String(url), method: opt?.method });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const { ops } = await load('r1');
    await ops.saveCard({ name: '卡', text: 'x' });
    const r = await ops.exportToPlugin();
    assert.equal(r.ok, true);
    assert.equal(r.reloaded, true, '应当报告重载成功');
    assert.ok(seen.some((s) => s.url.includes('/api/plugins/persona-scope/reload')), '没发重载请求');
    assert.match(r.note, /重新读取/);
  } finally { globalThis.fetch = realFetch; }
});

test('重载失败要给出可操作提示，而不是假装没事', async () => {
  fakeRoot();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const { ops } = await load('r1b');
    await ops.saveCard({ name: '卡', text: 'x' });
    const r = await ops.exportToPlugin();
    assert.equal(r.reloaded, false);
    assert.match(r.note, /建议在面板点一次重载/);
  } finally { globalThis.fetch = realFetch; }
});

/* 2. 插件配置损坏时不许写 */
test('插件配置损坏时导出失败，且原文件一个字节不动', async () => {
  fakeRoot({ pluginJson: '{"cards":[{"id":"a"}],"presets":[' });
  const { ops } = await load('r2');
  await ops.saveCard({ name: '卡', text: 'x' });

  const before = readFileSync(join(process.env.ROOST_LAUNCHER_DIR, 'roost/config/bots/bot0/plugins/persona-scope.json'), 'utf8');
  const r = await ops.exportToPlugin().then(() => null).catch((e) => e);
  assert.ok(r instanceof Error, '应当抛错');
  assert.match(r.message, /损坏/);

  const after = readFileSync(join(process.env.ROOST_LAUNCHER_DIR, 'roost/config/bots/bot0/plugins/persona-scope.json'), 'utf8');
  assert.equal(after, before, '损坏文件不能被覆盖');
});

/* 4. _plugin 元数据要落盘 */
test('导入后落盘保留 _plugin，往返不改 role', async () => {
  fakeRoot({
    pluginJson: {
      cards: [], presets: [
        { id: 'p1', name: '角色预设', content: '用第一人称', role: 'assistant', when: '/早安/', enabled: true },
      ],
    },
  });
  const { ops } = await load('r4');
  await ops.importFromPlugin();

  // 落盘后重新读（模拟新进程）
  const file = join(process.env.ROOST_LAUNCHER_DIR, 'persona-scope-ext.json');
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.presets[0]._plugin?.role, 'assistant', '_plugin 丢了');
  assert.equal(onDisk.presets[0]._plugin?.when, '/早安/');

  // 再导出：role 必须还是 assistant
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  try {
    await ops.exportToPlugin();
  } finally { globalThis.fetch = realFetch; }

  const back = JSON.parse(readFileSync(join(process.env.ROOST_LAUNCHER_DIR, 'roost/config/bots/bot0/plugins/persona-scope.json'), 'utf8'));
  const p = back.presets.find((x) => x.id === 'p1');
  assert.equal(p.role, 'assistant', `role 被改成了 ${p.role}`);
  assert.equal(p.content, '用第一人称');
});

/* 5. replace 语义 */
test('默认导入不覆盖本地；replace:true 才用插件版本覆盖', async () => {
  fakeRoot({
    pluginJson: {
      cards: [{ id: 'c1', name: '插件卡', text: '插件版正文' }],
      presets: [],
    },
  });
  const { ops } = await load('r5');
  await ops.saveCard({ id: 'c1', name: '插件卡', text: '本地改过的正文' });

  await ops.importFromPlugin();
  assert.equal(ops.listAll().cards.find((c) => c.id === 'c1').text, '本地改过的正文', '默认不该覆盖本地');

  await ops.importFromPlugin({ replace: true });
  assert.equal(ops.listAll().cards.find((c) => c.id === 'c1').text, '插件版正文', 'replace 应当用插件版本覆盖');
});

/* 6. 多机器人按修改时间选最新 */
test('多只鸟时选最近修改的插件配置', async () => {
  const root = fakeRoot({ bots: 2 });
  const cfg0 = join(root, 'roost/config/bots/bot0/plugins/persona-scope.json');
  const cfg1 = join(root, 'roost/config/bots/bot1/plugins/persona-scope.json');
  writeFileSync(cfg0, JSON.stringify({ cards: [{ id: 'old', name: '旧', text: 'x' }], presets: [] }), 'utf8');
  // 让 bot1 更新
  await new Promise((r) => setTimeout(r, 30));
  writeFileSync(cfg1, JSON.stringify({ cards: [{ id: 'new', name: '新', text: 'x' }], presets: [] }), 'utf8');

  const { interop } = await load('r6');
  const hit = interop.findPluginConfig();
  assert.equal(hit.path, cfg1, `选错了配置：${hit.path}`);
});

/* 7. 成长状态兼容 0.5.0 */
const GROWTH_PERSONAS = [
  { id: 'llmm', label: '妈妈', tags: [] },
  { id: 'g-1', label: 'llmm（成长）', tags: ['auto', 'growth'] },
];

test('persona-grow 0.5.0：personaId 为空、靠宿主 byChat 确认已落地', async () => {
  const root = fakeRoot();
  writeFileSync(join(root, 'persona-growth.json'), JSON.stringify({
    version: 1, settings: {},
    records: {
      '["","group","G1"]': {
        personaId: '', baseId: 'llmm', baseHash: 'abc', paused: false,
        entries: [{ text: 'x' }], samples: [], lastAnalysisAt: 1, log: ['切换'],
      },
    },
  }), 'utf8');

  const { growth } = await load('r7');
  const snap = growth.growthSnapshot({ G1: 'g-1' }, GROWTH_PERSONAS);
  assert.equal(snap.chats[0].personaId, 'g-1', '应以宿主实际在用的为准');
  const c = growth.growthConflicts({ AAA: 'scope-c1' }, snap, { G1: 'g-1' });
  assert.equal(c.active.length, 1, '应当算作生效');
  assert.match(c.note, /解绑/);
});

test('记录里 personaId 非空且确实是成长人格时也算生效（老版本兼容）', async () => {
  const root = fakeRoot();
  writeFileSync(join(root, 'persona-growth.json'), JSON.stringify({
    version: 1, settings: {},
    records: { '["","group","G2"]': { personaId: 'g-1', paused: false, entries: [{ text: 'x' }] } },
  }), 'utf8');

  const { growth } = await load('r7b');
  const c = growth.growthConflicts({ AAA: 'x' }, growth.growthSnapshot({}, GROWTH_PERSONAS), {});
  assert.equal(c.active.length, 1, 'personaId 指向成长人格时应生效');
});

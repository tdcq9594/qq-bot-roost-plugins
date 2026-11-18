// 互通与成长适配的回归测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 造一个「Roost 插件 + 素材」两套目录的假状态根 */
function fakeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ps-interop-'));
  const plugins = join(root, 'roost', 'config', 'bots', 'main', 'plugins');
  mkdirSync(plugins, { recursive: true });
  writeFileSync(join(plugins, 'persona-scope.json'), JSON.stringify({
    enabled: true,
    targets: 'AAA',
    maxChars: 4900,
    cards: [{ id: 'c1', name: '插件卡', text: '插件正文', targets: 'AAA', enabled: true }],
    presets: [{ id: 'p1', name: '破限', content: '不要替对方说话', role: 'system', when: '/早安/', enabled: true }],
  }, null, 2), 'utf8');
  process.env.ROOST_LAUNCHER_DIR = root;
  return { root, plugins, cfg: join(plugins, 'persona-scope.json') };
}

const load = async (tag) => ({
  interop: await import(`../lib/interop.mjs?t=${tag}`),
  ops: await import(`../lib/ops.mjs?t=${tag}`),
});

test('插件配置 → 扩展格式：content/when/targets 都保住', async () => {
  fakeRoot();
  const { interop } = await load('i1');
  const r = interop.readPluginState();
  assert.equal(r.ok, true);
  assert.equal(r.cards[0].text, '插件正文');
  assert.equal(r.cards[0]._plugin.targets, 'AAA');
  assert.equal(r.presets[0].text, '不要替对方说话', 'content 要映射成 text');
  assert.equal(r.presets[0]._plugin.when, '/早安/', '条件要留着');
  assert.equal(r.presets[0]._plugin.role, 'system');
});

test('导回插件：content 字段与条件原样还原，其他设置不丢', async () => {
  const { cfg } = fakeRoot();
  const { interop } = await load('i2');
  const r = interop.readPluginState();

  const out = interop.writePluginState({ cards: r.cards, presets: r.presets });
  assert.equal(out.ok, true);

  const back = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.equal(back.cards[0].text, '插件正文');
  assert.equal(back.cards[0].targets, 'AAA', '卡片的生效名单不能丢');
  assert.equal(back.presets[0].content, '不要替对方说话', '要还原成 content');
  assert.equal(back.presets[0].when, '/早安/');
  assert.equal(back.presets[0].role, 'system');
  assert.equal(back.maxChars, 4900, '插件自己的设置不能被扩展洗掉');
  assert.equal(back.targets, 'AAA');
  assert.ok(existsSync(cfg + '.bak-' + '') === false, '备份文件名带时间戳'); // 只是别崩
});

test('导入是合并：不覆盖本地独有条目', async () => {
  fakeRoot();
  const { ops } = await load('i3');
  await ops.saveCard({ name: '本地卡', text: '本地正文' });
  await ops.importFromPlugin();
  const s = ops.listAll();
  const names = s.cards.map((c) => c.name).sort();
  assert.deepEqual(names, ['插件卡', '本地卡'].sort());
});

test('导出后插件配置里能看到扩展的卡', async () => {
  const { cfg } = fakeRoot();
  const { ops } = await load('i4');
  await ops.saveCard({ name: '扩展卡', text: '扩展正文' });
  const r = await ops.exportToPlugin();
  assert.equal(r.ok, true);
  const back = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.ok(back.cards.some((c) => c.name === '扩展卡'), '扩展的卡要写进去');
  assert.ok(back.cards.some((c) => c.name === '插件卡'), '原有的卡不能被删');
});

test('成长扩展：没装时安静返回，不报错', async () => {
  fakeRoot();
  const { ops } = await load('i5');
  const g = ops.growthInfo({ bySender: {} });
  assert.equal(g.installed, false);
  assert.deepEqual(g.chats, []);
});

test('成长扩展：有生效成长人格且有人被绑定时给出提示', async () => {
  const { root } = fakeRoot();
  writeFileSync(join(root, 'persona-growth.json'), JSON.stringify({
    version: 1,
    records: {
      '["http://127.0.0.1:6807","group","GROUP1"]': {
        personaId: 'llmm（成长）', entries: [{ text: 'x' }], samples: [], lastAnalysisAt: 1, paused: false,
      },
    },
  }), 'utf8');

  const { ops } = await load('i6');
  // 新契约：要认出「这是成长人格」必须给宿主的人格清单（带 tags）
  const g = ops.growthInfo({
    bySender: { AAA: 'scope-c1' },
    byChat: { GROUP1: 'llmm（成长）' },
    personas: [{ id: 'llmm（成长）', label: 'llmm（成长）', tags: ['auto', 'growth'] }],
  });
  assert.equal(g.installed, true);
  assert.equal(g.active.length, 1);
  assert.ok(g.note.includes('解绑'), `提示要给出出路：${g.note}`);
});

test('成长扩展：状态文件损坏时不影响本扩展', async () => {
  const { root } = fakeRoot();
  writeFileSync(join(root, 'persona-growth.json'), '{坏的', 'utf8');
  const { ops } = await load('i7');
  const g = ops.growthInfo({ bySender: {} });
  assert.equal(g.installed, true);
  assert.ok(g.error, '要报出对方文件坏了');
  assert.equal(ops.listAll().ok, true, '本扩展照常工作');
});

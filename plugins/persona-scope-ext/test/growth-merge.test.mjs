// 成长叠加：专属人设 + 该群成长条目
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ps4-'));
  process.env.ROOST_LAUNCHER_DIR = root;
  return root;
}

const load = async (tag) => ({
  ops: await import(`../lib/ops.mjs?t=${tag}`),
  growth: await import(`../lib/growth.mjs?t=${tag}`),
});

function writeGrowth(root, entries, chatId = 'GROUP1') {
  writeFileSync(join(root, 'persona-growth.json'), JSON.stringify({
    version: 1,
    records: {
      [JSON.stringify(['', 'group', chatId])]: {
        personaId: '', baseId: 'llmm', paused: false,
        entries, samples: [], lastAnalysisAt: 1,
      },
    },
  }), 'utf8');
}

const ENTRIES = [
  { category: '口癖', text: '偶尔会加「嘛」' },
  { category: '习惯', text: '被夸会先否认再道谢' },
];

test('不选群时，拼装结果与原来一致（不带成长段）', async () => {
  const root = fakeRoot();
  writeGrowth(root, ENTRIES);
  const { ops } = await load('g1');
  await ops.saveCard({ name: '卡', text: '角色正文' });

  const pv = ops.previewOf({ cardId: ops.listAll().cards[0].id });
  assert.equal(pv.growthEntries, 0);
  assert.ok(!pv.raw.includes('慢慢长出来的习惯'));
  assert.equal(pv.id.startsWith('scope-'), true);
  assert.ok(!/-grow-[0-9A-Za-z]+$/.test(pv.id));
});

test('选了群：成长条目叠在预设后面，id 带 -grow', async () => {
  const root = fakeRoot();
  writeGrowth(root, ENTRIES, 'GROUP1');
  const { ops } = await load('g2');
  await ops.saveCard({ name: '卡', text: '角色正文' });
  await ops.savePreset({ name: '破限', text: '不要替对方说话' });

  const cardId = ops.listAll().cards[0].id;
  const pv = ops.previewOf({ cardId, growthChatId: 'GROUP1' });

  assert.equal(pv.growthEntries, 2);
  assert.match(pv.id, /-grow-[0-9A-Za-z]+$/);
  assert.match(pv.label, /含成长/);

  // 顺序：卡片 → 预设 → 成长
  const iCard = pv.raw.indexOf('角色正文');
  const iPreset = pv.raw.indexOf('不要替对方说话');
  const iGrow = pv.raw.indexOf('慢慢长出来的习惯');
  assert.ok(iCard >= 0 && iPreset > iCard && iGrow > iPreset, `顺序不对：${pv.raw.slice(0, 120)}`);
  assert.ok(pv.raw.includes('【口癖】偶尔会加「嘛」'));
});

test('指定群里没有成长条目时，安静退回「不叠加」', async () => {
  const root = fakeRoot();
  writeGrowth(root, [], 'GROUP1');
  const { ops } = await load('g3');
  await ops.saveCard({ name: '卡', text: '正文' });
  const pv = ops.previewOf({ cardId: ops.listAll().cards[0].id, growthChatId: 'GROUP1' });
  assert.equal(pv.growthEntries, 0);
  assert.ok(!/-grow-[0-9A-Za-z]+$/.test(pv.id));
  assert.ok(!pv.raw.includes('慢慢长出来的习惯'));
});

test('只叠加指定群，不跨群串味', async () => {
  const root = fakeRoot();
  writeFileSync(join(root, 'persona-growth.json'), JSON.stringify({
    version: 1,
    records: {
      '["","group","GROUP1"]': { personaId: '', paused: false, entries: [{ category: '口癖', text: 'A群的口癖' }] },
      '["","group","GROUP2"]': { personaId: '', paused: false, entries: [{ category: '口癖', text: 'B群的口癖' }] },
    },
  }), 'utf8');
  const { ops } = await load('g4');
  await ops.saveCard({ name: '卡', text: '正文' });
  const cardId = ops.listAll().cards[0].id;

  const a = ops.previewOf({ cardId, growthChatId: 'GROUP1' });
  assert.ok(a.raw.includes('A群的口癖'));
  assert.ok(!a.raw.includes('B群的口癖'), '不能把别的群的习惯拼进来');
});

test('成长段有长度上限，不会撑爆人格', async () => {
  const root = fakeRoot();
  const many = Array.from({ length: 200 }, (_, i) => ({ category: '习惯', text: `第 ${i} 条习惯，写得比较长一点以便触发截断` }));
  writeGrowth(root, many, 'GROUP1');
  const { growth } = await load('g5');
  const b = growth.growthBlockOf('GROUP1', { maxChars: 500 });
  assert.ok(b.text.length <= 520, `没截断：${b.text.length}`);
  assert.match(b.text, /略/);
});

test('成长文件损坏时不抛错，退回空段', async () => {
  const root = fakeRoot();
  writeFileSync(join(root, 'persona-growth.json'), '{坏的', 'utf8');
  const { growth } = await load('g6');
  const b = growth.growthBlockOf('GROUP1');
  assert.equal(b.text, '');
  assert.equal(b.entries, 0);
});

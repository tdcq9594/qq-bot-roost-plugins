// 人格 id 的长度与唯一性（宿主上限 60 字符）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ps8-'));
  process.env.ROOST_LAUNCHER_DIR = root;
  return root;
}

const load = async (tag) => ({ ops: await import(`../lib/ops.mjs?t=${tag}`) });

const CHAT = 'A'.repeat(32);
const CHAT2 = 'A'.repeat(31) + '1';

const writeGrowth = (root, chats) => writeFileSync(join(root, 'persona-growth.json'), JSON.stringify({
  version: 1,
  records: Object.fromEntries(chats.map((c) => [
    JSON.stringify(['', 'group', c]),
    { generation: 0, personaId: '', paused: false, entries: [{ category: 'x', text: '条目' }], samples: [] },
  ])),
}), 'utf8');

/* 1. 长度 */

test('任何长度的卡片 id，生成的人格 id 都不超过 60 字符', async () => {
  const { ops } = await load('p1');
  for (const len of [1, 8, 16, 17, 20, 40, 54, 55, 80, 200]) {
    const cardId = 'k'.repeat(len);
    for (const chatId of ['', CHAT, 'D'.repeat(64)]) {
      const id = ops.genPersonaId({ cardId, chatId });
      assert.ok(id.length <= 60, `卡片 ${len} 字 + 群 ${chatId.length} 字 → ${id.length} 字符：${id}`);
    }
  }
});

test('17 字卡片 + 完整群号：不再超限（报告里的失败用例）', async () => {
  const { ops } = await load('p2');
  const id = ops.genPersonaId({ cardId: 'k'.repeat(17), chatId: CHAT });
  assert.ok(id.length <= 60, `仍然超限：${id.length}`);
  assert.match(id, /-grow-A{32}$/, '群号要完整保留');
});

/* 2. 唯一性 */

test('不同群生成不同 id（含哈希退化的场景）', async () => {
  const { ops } = await load('p3');
  for (const len of [8, 17, 40]) {
    const cardId = 'k'.repeat(len);
    const a = ops.genPersonaId({ cardId, chatId: CHAT });
    const b = ops.genPersonaId({ cardId, chatId: CHAT2 });
    assert.notEqual(a, b, `卡片 ${len} 字时两个群撞了：${a}`);
  }
});

test('不同卡片生成不同 id（含哈希退化）', async () => {
  const { ops } = await load('p4');
  const a = ops.genPersonaId({ cardId: 'k'.repeat(17) + '-alpha', chatId: CHAT });
  const b = ops.genPersonaId({ cardId: 'k'.repeat(17) + '-beta', chatId: CHAT });
  assert.notEqual(a, b, `撞了：${a}`);
});

test('同卡同群幂等', async () => {
  const { ops } = await load('p5');
  const cardId = 'k'.repeat(17);
  assert.equal(ops.genPersonaId({ cardId, chatId: CHAT }), ops.genPersonaId({ cardId, chatId: CHAT }));
});

test('不叠加成长时不带 -grow 后缀', async () => {
  const { ops } = await load('p6');
  const id = ops.genPersonaId({ cardId: 'card-abc', chatId: '' });
  assert.equal(id, 'scope-card-abc');
});

/* 3. 端到端：预览给的 id 能直接用于建人格 */

test('长卡片 id + 成长：预览 id 合法且带群号', async () => {
  const root = fakeRoot();
  writeGrowth(root, [CHAT]);
  const { ops } = await load('p7');
  await ops.saveCard({ id: 'k'.repeat(17), name: '长卡', text: '正文', growth: true });
  const pv = ops.previewOf({ cardId: 'k'.repeat(17), growthChatId: CHAT });

  assert.ok(pv.id.length <= 60, `预览 id 超限：${pv.id.length}`);
  assert.ok(pv.id.endsWith(CHAT));
  assert.ok(pv.growthEntries > 0);
});

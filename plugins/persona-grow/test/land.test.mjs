// 人格切换的交叉场景：确认不会覆盖用户的选择、不会吃掉手改
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'grow-land-'));
process.env.ROOST_LAUNCHER_DIR = dir;

const { mergeGrowth, resolveBase, derivedIdOf, GROWTH_HEAD, __setPersonaIndex } = await import('../lib/land.mjs');

const CHAT = '44DE039E7B5FF07C7A770B4890644F97';

/**
 * 人格索引现在来自 `GET /v1/personas`，不再读宿主私有 config.json。
 * 测试用 `__setPersonaIndex` 直接注入，避免耦合文件格式。
 */
function setPersonas({ current = '', byChat = {} } = {}) {
  __setPersonaIndex({ current, byChat, bySender: {} });
}

/* ── 合并：保留用户手改 ─────────────────────────────────── */

test('第一次落地：没有成长段就追加在末尾', () => {
  const out = mergeGrowth('我是基础人格。', `${GROWTH_HEAD}\n- 【口吻】爱用颜文字`);
  assert.ok(out.startsWith('我是基础人格。'));
  assert.ok(out.includes('爱用颜文字'));
});

test('再次落地：只替换成长段，前面的手改保留', () => {
  const existing = '我是基础人格。\n\n用户手加的一句设定。\n\n' + `${GROWTH_HEAD}\n- 【旧】旧的条目`;
  const out = mergeGrowth(existing, `${GROWTH_HEAD}\n- 【新】新的条目`);
  assert.ok(out.includes('用户手加的一句设定'), '用户手改不能被吃掉');
  assert.ok(out.includes('新的条目'));
  assert.ok(!out.includes('旧的条目'), '旧成长段要被替换');
});

test('成长段后面还有用户自己的章节：那一节要保留', () => {
  const existing = `基础\n\n${GROWTH_HEAD}\n- 【旧】旧条目\n\n## 我自己加的一节\n这里是手写内容`;
  const out = mergeGrowth(existing, `${GROWTH_HEAD}\n- 【新】新条目`);
  assert.ok(out.includes('## 我自己加的一节'));
  assert.ok(out.includes('这里是手写内容'));
  assert.ok(out.includes('新条目'));
});

test('成长段在中间时不会吞掉后面的章节', () => {
  const existing = `A\n\n${GROWTH_HEAD}\n- x\n\n## 后面\nB`;
  const out = mergeGrowth(existing, `${GROWTH_HEAD}\n- y`);
  const after = out.slice(out.indexOf('## 后面'));
  assert.ok(after.includes('B'), `后面那节被误改：${out}`);
});

/* ── 基底解析：面板里换了人设怎么办 ─────────────────────── */

test('面板把这个群切到 genki：底座应该是 genki，不是全局 llmm', () => {
  setPersonas({ current: 'llmm', byChat: { [CHAT]: 'genki' } });
  assert.equal(resolveBase({ chatId: CHAT }), 'genki');
});

test('面板切到我们派生的人格：要剥回原始基底，不能套娃', () => {
  const derived = derivedIdOf('genki', CHAT);
  setPersonas({ current: 'llmm', byChat: { [CHAT]: derived } });
  assert.equal(resolveBase({ chatId: CHAT }), 'genki', '不能变成 genki-grow-x-grow-y');
});

test('会话没指定：回落全局当前人格', () => {
  setPersonas({ current: 'llmm', byChat: {} });
  assert.equal(resolveBase({ chatId: CHAT }), 'llmm');
});

test('状态里记着基底时优先用它（面板被清空也不丢）', () => {
  setPersonas({ current: '', byChat: {} });
  assert.equal(resolveBase({ chatId: CHAT, stateBase: 'helper' }), 'helper');
});

test('全局当前本身就是派生人格：剥回状态里的基底', () => {
  const derived = derivedIdOf('llmm', CHAT);
  setPersonas({ current: derived, byChat: {} });
  assert.equal(resolveBase({ chatId: CHAT, stateBase: 'llmm' }), 'llmm');
});

test('派生 id 稳定且带会话指纹', () => {
  const a = derivedIdOf('llmm', CHAT);
  assert.match(a, /^llmm-grow-[0-9a-f]{6}$/);
  assert.equal(a, derivedIdOf('llmm', CHAT));
  assert.notEqual(a, derivedIdOf('llmm', 'OTHER'));
});

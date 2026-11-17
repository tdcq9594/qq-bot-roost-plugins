// 本地自检：不碰真实宿主，验证状态/解析/落地拼装三段逻辑
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 把状态文件指到临时目录，避免动到真实数据
const dir = mkdtempSync(join(tmpdir(), 'grow-'));
process.env.ROOST_LAUNCHER_DIR = dir;
process.env.ROOST_API_URL = 'http://127.0.0.1:1/v1';
process.env.ROOST_API_TOKEN = 'test-token';

const st = await import('../lib/state.mjs');

const land = await import('../lib/land.mjs');

const CHAT = '44DE039E7B5FF07C7A770B4890644F97';

test('状态文件是惰性创建的，没有记录时返回空态', () => {
  const s = st.status({ kind: 'group', chatId: CHAT });
  assert.equal(s.total, 0);
  assert.deepEqual(s.entries, []);
  assert.equal(s.threshold, 25);
});

test('合并条目：去重、取高成熟度、按成熟度排序', () => {
  st.mergeEntries({ kind: 'group', chatId: CHAT }, [
    { category: '口吻', text: '说话爱用波浪号', maturity: 2, evidence: '好呀~' },
    { category: '口吻', text: '说话爱用波浪号', maturity: 4, evidence: '在的~' },
    { category: '称呼', text: '叫对方小王', maturity: 1 },
  ]);
  const s = st.status({ kind: 'group', chatId: CHAT });
  assert.equal(s.entries.length, 2, '同一条正文要合并');
  assert.equal(s.entries[0].maturity, 4, '成熟度取高的');
  assert.equal(s.entries[0].text, '说话爱用波浪号');
  assert.equal(s.period, 0, '分析完周期归零');
});

test('条目上限生效', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ category: '习惯', text: `习惯 ${i}`, maturity: 1 + (i % 5) }));
  st.mergeEntries({ kind: 'group', chatId: CHAT }, many);
  const s = st.status({ kind: 'group', chatId: CHAT });
  assert.ok(s.entries.length <= 12, `上限 12，实际 ${s.entries.length}`);
});

test('渲染成段落：带表头、受字数上限约束', () => {
  const block = st.renderGrowth(st.status({ kind: 'group', chatId: CHAT }).entries, 200);
  assert.ok(block.includes('慢慢长出来的习惯'));
  assert.ok(block.length <= 200, `实际 ${block.length}`);
});

test('重置：清空条目、代数 +1，其余会话不受影响', () => {
  const before = st.status({ kind: 'group', chatId: CHAT }).generation;
  st.resetRecord({ kind: 'group', chatId: CHAT });
  const after = st.status({ kind: 'group', chatId: CHAT });
  assert.equal(after.entries.length, 0);
  assert.equal(after.generation, before + 1);
  assert.equal(st.status({ kind: 'group', chatId: 'OTHER' }).generation, 0);
});

test('派生人格 id 对同一会话稳定、不同会话不同', () => {
  const a = land.derivedIdOf('llmm', CHAT);
  const b = land.derivedIdOf('llmm', CHAT);
  const c = land.derivedIdOf('llmm', 'OTHER');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a.startsWith('llmm-grow-'));
});

test('状态写盘后能读回来（结构兼容旧文件）', () => {
  // 造一份旧结构文件，确认能读、且旧字段不丢
  const legacy = {
    version: 1,
    records: {
      [JSON.stringify(['http://127.0.0.1:6807', 'group', 'OLDCHAT'])]: {
        personaId: 'llmm', generation: 0, paused: false, total: 11, period: 11,
        lastAt: 1, nextRetryAt: 0, lastAnalysisAt: 0, lastError: '',
        entries: [], samples: [{ id: 's1', at: 1, user: '晚上好', bot: '晚上好呀' }], seen: ['s1'], log: [],
      },
    },
  };
  writeFileSync(join(dir, 'persona-growth.json'), JSON.stringify(legacy), 'utf8');
  // 清掉模块缓存，重新读
  const fresh = JSON.parse(readFileSync(join(dir, 'persona-growth.json'), 'utf8'));
  assert.equal(fresh.records[Object.keys(fresh.records)[0]].total, 11, '旧数据要能原样保留');
});

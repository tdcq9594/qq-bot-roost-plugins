// 第五轮：指纹碰撞 / MCP 清除 await / 文案
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function fakeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ps7-'));
  process.env.ROOST_LAUNCHER_DIR = root;
  return root;
}

const load = async (tag) => ({
  ops: await import(`../lib/ops.mjs?t=${tag}`),
  growth: await import(`../lib/growth.mjs?t=${tag}`),
});

const writeGrowth = (root, map) => writeFileSync(join(root, 'persona-growth.json'), JSON.stringify({
  version: 1,
  records: Object.fromEntries(Object.entries(map).map(([chatId, entries]) => [
    JSON.stringify(['', 'group', chatId]),
    { generation: 0, personaId: '', paused: false, entries, samples: [], total: 1, period: 1, lastAnalysisAt: 1, log: [] },
  ])),
}), 'utf8');

/* 1. 曾经碰撞的两个群号必须产出不同 id */

test('31 个 C + "0" 与 31 个 C + "1" 不再碰撞', async () => {
  const root = fakeRoot();
  const A = 'C'.repeat(31) + '0';
  const B = 'C'.repeat(31) + '1';
  writeGrowth(root, { [A]: [{ category: '口癖', text: 'A 群习惯' }], [B]: [{ category: '口癖', text: 'B 群习惯' }] });
  const { ops } = await load('n1');
  await ops.saveCard({ name: '同卡', text: '正文', growth: true });
  const cardId = ops.listAll().cards[0].id;

  const a = ops.previewOf({ cardId, growthChatId: A });
  const b = ops.previewOf({ cardId, growthChatId: B });
  assert.notEqual(a.id, b.id, `仍然碰撞：${a.id} / ${b.id}`);
  assert.ok(a.id.includes(A), 'id 里应当能看到完整群号');
  assert.ok(a.raw.includes('A 群习惯'));
  assert.ok(!a.raw.includes('B 群习惯'));
});

test('同卡同群仍然幂等（重复应用是更新，不是新建）', async () => {
  const root = fakeRoot();
  const A = 'D'.repeat(32);
  writeGrowth(root, { [A]: [{ category: '口癖', text: 'x' }] });
  const { ops } = await load('n2');
  await ops.saveCard({ name: '卡', text: '正文', growth: true });
  const cardId = ops.listAll().cards[0].id;
  assert.equal(ops.previewOf({ cardId, growthChatId: A }).id, ops.previewOf({ cardId, growthChatId: A }).id);
});

/* 2. MCP 清除必须 await */

test('MCP 清除返回真实结果，而不是空对象', async () => {
  const root = fakeRoot();
  const A = 'E'.repeat(32);
  writeGrowth(root, { [A]: [{ category: '口癖', text: 'x' }] });
  const extDir = fileURLToPath(new URL('..', import.meta.url));

  const out = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(extDir, 'server.mjs')], {
      env: { ...process.env, ROOST_LAUNCHER_DIR: root, ROOST_API_URL: 'http://fixture.invalid/v1', ROOST_API_TOKEN: 't' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; });
    p.stderr.on('data', (d) => { buf += d; });
    p.on('close', () => resolve(buf));
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'persona_scope_clear_growth', arguments: { chatId: A } } })}\n`);
    setTimeout(() => p.stdin.end(), 300);
    setTimeout(() => reject(new Error('超时')), 8000);
  });

  const line = out.split('\n').find((l) => l.includes('"id":1'));
  assert.ok(line, `没有响应：${out.slice(0, 200)}`);
  const res = JSON.parse(line);
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.ok, true, `清除失败：${JSON.stringify(payload)}`);
  assert.equal(payload.cleared, 1, `结果被吞了：${JSON.stringify(payload)}`);
  assert.ok(payload.backup, '应当有备份路径');
});

test('MCP 清除非法群号时返回错误而不是让进程崩掉', async () => {
  const root = fakeRoot();
  writeGrowth(root, { ['F'.repeat(32)]: [{ category: '口癖', text: 'x' }] });
  const extDir = fileURLToPath(new URL('..', import.meta.url));

  const { out, code } = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(extDir, 'server.mjs')], {
      env: { ...process.env, ROOST_LAUNCHER_DIR: root, ROOST_API_URL: 'http://fixture.invalid/v1', ROOST_API_TOKEN: 't' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; });
    p.stderr.on('data', (d) => { buf += d; });
    p.on('close', (c) => resolve({ out: buf, code: c }));
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'persona_scope_clear_growth', arguments: { chatId: '1' } } })}\n`);
    setTimeout(() => p.stdin.end(), 300);
    setTimeout(() => reject(new Error('超时')), 8000);
  });

  const line = out.split('\n').find((l) => l.includes('"id":2'));
  assert.ok(line, `没有响应：${out.slice(0, 200)}`);
  const res = JSON.parse(line);
  assert.equal(res.result.isError, true, '应当标成错误');
  assert.match(res.result.content[0].text, /32 位/);
  assert.equal(code, 0, `进程不该非正常退出（code=${code}）：${out.slice(0, 200)}`);
});

/* 3. 文案 */

test('预设示例文案已改：去ai味 / 可提示词注入', () => {
  const page = readFileSync(new URL('../page.html', import.meta.url), 'utf8');
  assert.match(page, /预设名（比如：去ai味）/);
  assert.match(page, /预设正文（可提示词注入）/);
  assert.ok(!/比如：破限/.test(page), '旧示例还在');
});

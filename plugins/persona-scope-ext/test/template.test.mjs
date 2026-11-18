// 占位符渲染：{{user}} 等不再原样进人格（否则宿主提示词渲染会报错）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ps9-'));
  process.env.ROOST_LAUNCHER_DIR = root;
  return root;
}

const load = async (tag) => ({
  tpl: await import(`../lib/template.mjs?t=${tag}`),
  ops: await import(`../lib/ops.mjs?t=${tag}`),
});

const OWNER = 'A'.repeat(32);

/* 1. 基本替换 */

test('{{user}} / {{char}} / {{userId}} 正确替换', async () => {
  const { tpl } = await load('t2');
  const vars = tpl.buildVars({ user: '小王', char: '爱莉安娜', userId: OWNER });
  const r = tpl.renderPersonaText('{{char}} 是 {{user}} 的恋人，id={{userId}}', vars);
  assert.equal(r.text, `爱莉安娜 是 小王 的恋人，id=${OWNER}`);
  assert.deepEqual(r.unknown, []);
});

test('没给称呼时退回「对方」', async () => {
  const { tpl } = await load('t3');
  const r = tpl.renderPersonaText('你是 {{user}} 的恋人', tpl.buildVars({}));
  assert.match(r.text, /对方\s*的恋人/);
});

/* 2. 不留下任何花括号（这是报错的根因） */

test('未知占位符被删掉并报告，输出里不剩花括号', async () => {
  const { tpl } = await load('t4');
  const r = tpl.renderPersonaText('你好 {{nickname}}，{{user}}', tpl.buildVars({ user: '小王' }));
  assert.ok(!r.text.includes('{{'), `还有花括号：${r.text}`);
  assert.deepEqual(r.unknown, ['nickname']);
  assert.match(r.text, /小王/);
});

test('{{if}} 走 else 分支（静态人格没有「当句话」）', async () => {
  const { tpl } = await load('t5');
  const r = tpl.renderPersonaText('{{if /早安/}}晨间语气{{else}}平常语气{{end}}', tpl.buildVars({}));
  assert.equal(r.text, '平常语气');
  assert.equal(r.conditions, 1);
});

test('{{if}} 没有 else 时整段消失', async () => {
  const { tpl } = await load('t6');
  const r = tpl.renderPersonaText('甲{{if /早安/}}晨间{{end}}乙', tpl.buildVars({}));
  assert.equal(r.text, '甲乙');
});

test('嵌套与未闭合的花括号都不会残留', async () => {
  const { tpl } = await load('t7');
  const r1 = tpl.renderPersonaText('{{if /a/}}A{{if /b/}}B{{else}}b{{end}}{{end}}', tpl.buildVars({}));
  assert.ok(!r1.text.includes('{{'), r1.text);
  const r2 = tpl.renderPersonaText('前半 {{if /a/}}没闭合', tpl.buildVars({}));
  assert.ok(!r2.text.includes('{{'), r2.text);
});

/* 3. 端到端：预览与生成都不带占位符 */

test('预览：卡片含 {{user}} 时输出是纯文本，且记录未知变量', async () => {
  const root = fakeRoot();
  const { ops } = await load('t8');
  await ops.saveCard({
    name: '爱莉安娜',
    text: '# 角色\n{{char}} 目前是 {{user}} 的恋人。\n语气：{{foo}}',
  });
  const cardId = ops.listAll().cards[0].id;

  const pv = ops.previewOf({ cardId, openid: OWNER, userLabel: '小王' });
  assert.ok(!/\{\{|\}\}/.test(pv.raw), `输出里还有占位符：${pv.raw}`);
  assert.match(pv.raw, /爱莉安娜 目前是 小王 的恋人/);
  assert.deepEqual(pv.unknownVars, ['foo']);
  assert.equal(pv.userName, '小王');
});

test('预览：没填称呼时用「对方」，且 openid 只用于 {{userId}}', async () => {
  const root = fakeRoot();
  const { ops } = await load('t9');
  await ops.saveCard({ name: '卡', text: '你是 {{user}} 的恋人；id={{userId}}' });
  const pv = ops.previewOf({ cardId: ops.listAll().cards[0].id, openid: OWNER });
  assert.match(pv.raw, /你是\s*对方\s*的恋人/);
  assert.match(pv.raw, new RegExp(OWNER));
  assert.equal(pv.userName, '对方');
});

test('生成的正文里不含花括号（避免宿主提示词渲染失败）', async () => {
  const root = fakeRoot();
  const { ops } = await load('t10');
  // 需要 API 凭据，否则 applyCard 在建人格前就被拦下
  const { setApiEnv } = await import('../lib/api.mjs');
  // 注意：setApiEnv 读的是 ROOST_* 键名（和宿主注入的 env 一致）
  setApiEnv({ ROOST_API_URL: 'http://fixture.invalid/v1', ROOST_API_TOKEN: 't' });
  await ops.saveCard({ name: '卡', text: '{{user}} 的专属，{{when}} 生效' });

  let sent = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    if (String(url).includes('/personas/create')) sent = JSON.parse(opt.body);
    return new Response('{"ok":true}', { status: 200 });
  };
  try {
    await ops.applyCard({ cardId: ops.listAll().cards[0].id, openid: OWNER, userLabel: '小王' });
    assert.ok(sent, '没发建人格请求');
    assert.ok(!/\{\{|\}\}/.test(sent.raw), `写进去的正文还有占位符：${sent.raw}`);
    assert.match(sent.raw, /小王\s*的专属/);
  } finally { globalThis.fetch = realFetch; }
});

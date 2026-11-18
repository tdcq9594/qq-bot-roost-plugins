// 宿主 1.3.13 之后的兼容性：旧规则绑定提示
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

// 可选：指定 dsh-roost 源码/安装目录，未指定时跳过宿主源码契约检查。
const HOST_DIR = process.env.ROOST_HOST_DIR || '';

test('legacyBindings：只有指向旧规则 scope- 人格的才提示', async () => {
  const ops = await import('../lib/ops.mjs?t=lg1');
  const A = 'A'.repeat(32);
  const rows = ops.legacyBindings({
    bySender: {
      [A]: 'scope-arianna',                       // 旧规则：不带发送者
      [A.replace(/A/g, 'B')]: `scope-card-1-${A.replace(/A/g, 'B')}`, // 新规则
      [A.replace(/A/g, 'C')]: 'llmm',             // 用户自制人格，不管
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].personaId, 'scope-arianna');
  assert.equal(rows[0].openid, A);
});

test('legacyBindings：新规则的 id 一个都不报', async () => {
  const ops = await import('../lib/ops.mjs?t=lg2');
  const A = 'D'.repeat(32);
  const id = ops.genPersonaId({ cardId: 'card-1', senderId: A });
  assert.deepEqual(ops.legacyBindings({ bySender: { [A]: id } }), []);
});

test('页面会显示旧绑定提示', () => {
  const page = readFileSync(new URL('../page.html', import.meta.url), 'utf8');
  assert.match(page, /id="legacyHint"/);
  assert.match(page, /再点一次「生成并绑定」/);
});

/* ── 宿主侧的接口契约（升级后仍然成立） ─────────────── */

const apiV1 = `${HOST_DIR}/src/api-v1.js`;

test('宿主仍然提供我们用到的 /v1 端点', { skip: !existsSync(apiV1) }, () => {
  const src = readFileSync(apiV1, 'utf8');
  for (const ep of ['POST /v1/session.configure', 'GET /v1/personas', 'POST /v1/personas/create', 'POST /v1/personas/save']) {
    assert.ok(src.includes(ep), `宿主缺少端点：${ep}`);
  }
});

test('宿主仍然支持按人指定人格（senderId → bySender）', { skip: !existsSync(apiV1) }, () => {
  const src = readFileSync(`${HOST_DIR}/src/ext-persona.js`, 'utf8');
  assert.ok(src.includes('bySender[senderId]'), '按人写入不见了');
  assert.match(src, /senderId/, '参数不支持 senderId');
});

test('人格 id 上限仍是 60（我们的长度预算依赖它）', { skip: !existsSync(`${HOST_DIR}/src/personas.js`) }, () => {
  const src = readFileSync(`${HOST_DIR}/src/personas.js`, 'utf8');
  assert.ok(src.includes('.slice(0, 60)'), '上限变了，id 预算要重算');
});

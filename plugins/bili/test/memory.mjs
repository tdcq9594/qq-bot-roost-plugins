/**
 * 扩展记忆：只在真投递后记，写不进去不影响推送。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createExtMemory } from '../lib/memory.mjs';

test('没有令牌时直接说不可用，不发请求', async () => {
  let called = 0;
  const m = createExtMemory({}, { fetchImpl: async () => { called += 1; return {}; } });
  assert.equal(m.available, false);
  const r = await m.remember('推过一条');
  assert.equal(r.ok, false);
  assert.match(r.why, /ROOST_API_URL/);
  assert.equal(called, 0, '没配置就别白跑一次请求');
});

test('记一条：POST /memory/ext.add，带 Bearer，extId 由宿主从令牌取', async () => {
  const calls = [];
  const m = createExtMemory(
    { ROOST_API_URL: 'http://127.0.0.1:1/v1', ROOST_API_TOKEN: 'tk' },
    { fetchImpl: async (url, opt) => { calls.push([url, opt]); return { ok: true, status: 200, json: async () => ({ ok: true }) }; } },
  );
  assert.equal(m.available, true);
  const r = await m.remember('推过《测试》');
  assert.equal(r.ok, true);
  assert.equal(calls[0][0], 'http://127.0.0.1:1/v1/memory/ext.add');
  assert.equal(calls[0][1].headers.authorization, 'Bearer tk');
  assert.equal(JSON.parse(calls[0][1].body).fact, '推过《测试》');
  /** 请求体里不能自报 extId：宿主只认令牌 */
  assert.equal('extId' in JSON.parse(calls[0][1].body), false);
});

test('宿主拒绝（没给 memory:write）时静默返回失败，不抛', async () => {
  const m = createExtMemory(
    { ROOST_API_URL: 'http://127.0.0.1:1/v1', ROOST_API_TOKEN: 'tk' },
    { fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ ok: false, message: 'forbidden' }) }) },
  );
  const r = await m.remember('x');
  assert.equal(r.ok, false);
  assert.match(r.why, /forbidden|403/);
});

test('网络炸了也不抛', async () => {
  const m = createExtMemory(
    { ROOST_API_URL: 'http://127.0.0.1:1/v1', ROOST_API_TOKEN: 'tk' },
    { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } },
  );
  const r = await m.remember('x');
  assert.equal(r.ok, false);
  assert.match(r.why, /ECONNREFUSED/);
});

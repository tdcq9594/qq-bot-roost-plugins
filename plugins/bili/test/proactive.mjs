import test from 'node:test';
import assert from 'node:assert/strict';
import { createProactiveClient } from '../lib/proactive.mjs';

/** 0.3 那条「发不了消息」的边界，0.4 换成投素材；这里只验 HTTP 契约。 */
test('没有 API 地址 / 令牌时说清原因，不抛异常', async () => {
  const c = createProactiveClient({}, { fetchImpl: async () => { throw new Error('不该发请求'); } });
  assert.equal(c.available, false);
  const r = await c.submit({ text: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.why, /ROOST_API_URL/);
});

test('submit 打到 /v1/proactive/submit，带 Bearer 与素材字段', async () => {
  const calls = [];
  const c = createProactiveClient(
    { ROOST_API_URL: 'http://127.0.0.1:3000/v1/', ROOST_API_TOKEN: 'tok' },
    {
      fetchImpl: async (url, opts) => {
        calls.push({ url, opts, body: JSON.parse(opts.body) });
        return { ok: true, status: 200, json: async () => ({ ok: true, id: 'abc', delivery: { sent: 1 }, retry: false }) };
      },
    },
  );
  assert.equal(c.available, true);
  const r = await c.submit({
    cause: '刷到好视频', key: 'BV1ZAWM61Evb', text: '《测试》', target: 'group:123456', approve: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/v1/proactive/submit', 'base 已带 /v1，不能再拼一遍');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer tok');
  assert.equal(calls[0].body.target, 'group:123456');
  assert.equal(calls[0].body.approve, true);
  assert.equal(r.ok, true);
  assert.equal(r.id, 'abc');
  assert.equal(r.delivery.sent, 1);
});

test('宿主拒绝 / 网络异常都变成可读原因，不让定时刷整轮崩', async () => {
  const denied = createProactiveClient(
    { ROOST_API_URL: 'http://x/v1', ROOST_API_TOKEN: 't' },
    { fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ ok: false, message: '缺少 scope：proactive:write' }) }) },
  );
  const r = await denied.submit({ text: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.why, /proactive:write/);

  const broken = createProactiveClient(
    { ROOST_API_URL: 'http://x/v1', ROOST_API_TOKEN: 't' },
    { fetchImpl: async () => { throw new Error('连接被拒'); } },
  );
  assert.match((await broken.submit({ text: 'x' })).why, /连接被拒/);
});

test('门闸没过时把 retry 传回来，扩展据此退避而不是当失败', async () => {
  const c = createProactiveClient(
    { ROOST_API_URL: 'http://x/v1', ROOST_API_TOKEN: 't' },
    { fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, id: 'q1', retry: true, delivery: { sent: 0, why: '免打扰' } }) }) },
  );
  const r = await c.submit({ text: 'x' });
  assert.equal(r.retry, true);
  assert.equal(r.delivery.sent, 0);
});

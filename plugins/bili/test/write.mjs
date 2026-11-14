import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriteApi, withMention } from '../lib/write.mjs';

const COOKIE = 'SESSDATA=abc; bili_jct=csrf123; DedeUserID=1';
const T = new Date('2026-11-14T10:00:00+08:00').getTime();

function fakeFetch(calls, code = 0) {
  return async (url, opts) => {
    calls.push({ url, body: String(opts?.body || ''), headers: opts?.headers || {} });
    return { ok: true, status: 200, json: async () => ({ code, message: code ? '风控' : '' }) };
  };
}

test('试运行默认开：一个请求都不发，但返回成功', async () => {
  const calls = [];
  const w = createWriteApi({
    getCookie: () => COOKIE, fetchImpl: fakeFetch(calls),
    dryRunOf: () => true, now: () => T,
  });
  const r = await w.comment(123, '挺好看');
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(calls.length, 0, '试运行不许真打 B 站');
});

test('Cookie 里没有 bili_jct 当场拒，别拿残缺登录态去撞 -111', async () => {
  const w = createWriteApi({
    getCookie: () => 'SESSDATA=abc', fetchImpl: fakeFetch([]),
    dryRunOf: () => false, now: () => T,
  });
  await assert.rejects(() => w.like(1), /bili_jct/);
});

test('真发时带 csrf / cookie / referer，三个动作各走对的接口', async () => {
  const calls = [];
  const w = createWriteApi({
    getCookie: () => COOKIE, fetchImpl: fakeFetch(calls),
    dryRunOf: () => false, now: () => T,
  });
  await w.comment(999, '《测试》不错');
  await w.like(999);
  await w.danmaku(888, '好看', 2000);
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /reply\/add/);
  assert.match(calls[0].body, /csrf=csrf123/);
  assert.match(calls[0].body, /oid=999/);
  assert.match(calls[1].url, /archive\/like/);
  assert.match(calls[2].url, /dm\/post/);
  assert.match(calls[2].body, /oid=888/);
  assert.equal(calls[0].headers.cookie, COOKIE);
  assert.match(calls[0].headers.referer, /bilibili\.com/);
});

test('撞到风控码就当天暂停，后面的动作直接跳过', async () => {
  const calls = [];
  const w = createWriteApi({
    getCookie: () => COOKIE, fetchImpl: fakeFetch(calls, -352),
    dryRunOf: () => false, now: () => T,
  });
  await assert.rejects(() => w.comment(1, 'x'), /风控/);
  assert.match(w.state().paused, /风控/);
  const r = await w.like(1);
  assert.equal(r.skipped, true);
  assert.equal(calls.length, 1, '暂停后不该再撞接口');
});

test('跨天自动解除暂停', async () => {
  let now = T;
  const w = createWriteApi({
    getCookie: () => COOKIE, fetchImpl: fakeFetch([], -509),
    dryRunOf: () => false, now: () => now,
  });
  await assert.rejects(() => w.like(1), /限流/);
  assert.ok(w.state().paused);
  now += 24 * 3600_000;
  assert.equal(w.state().paused, '');
});

/* ---------------- @ 主人 ---------------- */

test('withMention：末尾加 @昵称，已有就不重复，超长整体截断', () => {
  assert.equal(withMention('这猫真懒', '小明'), '这猫真懒 @小明');
  assert.equal(withMention('这猫真懒 @小明', '小明'), '这猫真懒 @小明', '她自己写了就别再加一遍');
  assert.equal(withMention('  好  ', ''), '好', '没填昵称就原样返回');
  /** 评论上限 200 字：整条截断，不能把 @ 截掉 */
  const long = withMention('x'.repeat(300), '小明');
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('@小明'));
});

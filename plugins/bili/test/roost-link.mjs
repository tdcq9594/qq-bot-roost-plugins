/**
 * 直连客户端 & 「现在分享」直发
 * =============================
 *
 * 守的是三条线上踩过的坑：
 *  1. 分享不能再投素材通道（会开一次模型、常回 <<skip>>）；
 *  2. 不能把「请求没报错」当「发出去了」，要认框架回的消息 id；
 *  3. `target:"owner"` 由宿主解析，扩展不许自己拿主人 openid。
 *
 * 不联网：fetch 全是桩。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRoostLink } from '../lib/roost-link.mjs';

const HERE = join(fileURLToPath(new URL('..', import.meta.url)));
const main = readFileSync(join(HERE, 'ui/main.mjs'), 'utf8');
const manifest = JSON.parse(readFileSync(join(HERE, 'plugin.json'), 'utf8'));
const html = readFileSync(join(HERE, 'ui/index.html'), 'utf8');

const ENV = { ROOST_API_URL: 'http://127.0.0.1:1/v1', ROOST_API_TOKEN: 't' };

const CARD = {
  title: '标题', description: '描述',
  url: 'https://www.bilibili.com/video/BV1ZAWM61Evb',
  picUrl: 'https://i0.hdslb.com/cover.jpg',
};

function fetchStub(handler) {
  return async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    return { ok: true, status: 200, json: async () => await handler({ url, body, init }) };
  };
}

// ---------------------------------------------------------------- 客户端

test('sendCard 走 /v1/roost.call 的 msg.send，target 是 owner 别名', async () => {
  let seen = null;
  const link = createRoostLink(ENV, {
    fetchImpl: fetchStub(({ url, body }) => {
      seen = { url, body };
      return { ok: true, method: 'msg.send', data: { msgId: 'm-1' } };
    }),
  });
  const r = await link.sendCard(CARD);
  assert.equal(r.ok, true);
  assert.equal(r.id, 'm-1');
  assert.match(seen.url, /\/roost\.call$/);
  assert.equal(seen.body.method, 'msg.send');
  assert.equal(seen.body.params.target, 'owner');
  assert.deepEqual(seen.body.params.card, CARD);
  assert.equal('chatId' in seen.body.params, false, '扩展不该自报主人 openid');
});

test('框架没回消息 id 就是没发出去，不能报成功', async () => {
  const link = createRoostLink(ENV, {
    fetchImpl: fetchStub(() => ({ ok: true, method: 'msg.send', data: {} })),
  });
  const r = await link.sendCard(CARD);
  assert.equal(r.ok, false);
  assert.match(r.why, /没回消息 id/);
});

test('宿主返回 403 / 令牌缺失 / 网络错误都要如实回失败', async () => {
  const denied = createRoostLink(ENV, {
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ ok: false, message: '缺少 scope' }) }),
  });
  assert.match((await denied.sendCard(CARD)).why, /缺少 scope/);

  const noToken = createRoostLink({}, {});
  assert.equal(noToken.available, false);
  assert.match((await noToken.sendCard(CARD)).why, /没注入/);

  const broken = createRoostLink(ENV, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.match((await broken.sendCard(CARD)).why, /ECONNREFUSED/);
});

test('pending（平台审核中）也算投出去了，但要标记出来', async () => {
  const link = createRoostLink(ENV, {
    fetchImpl: fetchStub(() => ({ ok: true, data: { pending: true } })),
  });
  const r = await link.sendCard(CARD);
  assert.equal(r.ok, true);
  assert.equal(r.pending, true);
});

test('capabilities 走 GET 且带令牌', async () => {
  let auth = '';
  const link = createRoostLink(ENV, {
    fetchImpl: async (url, init) => {
      auth = init?.headers?.authorization ?? '';
      return { ok: true, json: async () => ({ ok: true, tools: [], readonly: [], send: ['msg.send'] }) };
    },
  });
  const r = await link.capabilities();
  assert.equal(r.ok, true);
  assert.match(auth, /^Bearer /);
});

// ---------------------------------------------------------------- 守门

test('现在分享走直连协议直发：不投素材通道、不经过模型', () => {
  assert.match(main, /roostLink\.sendCard\(card\)/, 'test_share 必须走直发');
  const body = main.slice(main.indexOf('async test_share('), main.indexOf('async ffmpeg_state('));
  assert.doesNotMatch(body, /proactive\.submit\(/, '分享不能再投 /v1/proactive/submit（会拉起主动搭话模型）');
  assert.doesNotMatch(body, /selfBrowse|agent\.new|llm\.vision/, '分享不该跑模型');
  assert.match(body, /cardOf\(v\)/, '卡片要用现成数据拼，不让模型凑字段');
});

test('成功判据是框架回的 id，不是「入队成功」', () => {
  const body = main.slice(main.indexOf('async test_share('), main.indexOf('async ffmpeg_state('));
  assert.match(body, /if \(!r\.ok\) return \{ ok: false/, '没发出去不能报成功');
  assert.match(body, /bumpStats\(ui, \{ shares: 1 \}\)/, '只有真发了才计一次分享');
});

test('清单声明 message:write，按钮文案改成「现在分享」', () => {
  assert.ok(manifest.scopes.includes('message:write'), '直发要 message:write scope');
  assert.match(html, /id="act-share"[^>]*>现在分享</, '按钮文案要与语义一致');
  assert.match(JSON.stringify(manifest), /现在分享/);
});

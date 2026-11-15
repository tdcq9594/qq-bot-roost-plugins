#!/usr/bin/env node
/**
 * 0.2 的 provider 层：上游错误分类 + 失败自动切换开关 + 超时注入
 *
 *   node test/providers2.mjs
 *
 * 假 fetch，不联网、不花钱。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hintOf, generate } from '../lib/providers.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 3)]);
const B64 = PNG.toString('base64');

function jsonResponse(j, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => j,
  };
}

function okFetch() {
  return async () => jsonResponse({ data: [{ b64_json: B64 }] });
}

const cfg0 = (over = {}) => ({
  provider: 'openai',
  baseUrl: 'https://main.test/v1',
  apiKey: 'sk',
  model: 'm1',
  size: '1024x1024',
  fallbacks: [{ baseUrl: 'https://bak.test/v1', model: 'm2' }],
  fallbackEnabled: true,
  timeoutSec: 120,
  ...over,
});

test('hintOf：按上游点名的东西给具体修法，别一律归成「接口出错」', () => {
  assert.match(hintOf(402, 'insufficient balance'), /余额/);
  assert.match(hintOf(402, '额度不足'), /充值/);
  assert.match(hintOf(429, 'rate limit exceeded'), /限流/);
  assert.match(hintOf(400, 'content policy violation'), /内容审核/);
  assert.match(hintOf(400, 'sensitive content blocked'), /换个说法/);
  /** 参考图张数上限：照搬 aurabot beta `serviceError()` 的两条判据 */
  assert.match(hintOf(400, 'at most 2 images are allowed'), /最多支持 2 张/);
  assert.match(hintOf(422, '最多支持 3 张参考图'), /最多支持 3 张/);
  assert.match(hintOf(400, 'only one input image is supported'), /只支持一张/);
  assert.match(hintOf(400, 'unsupported image edits'), /参考图/);
  assert.match(hintOf(400, 'invalid size'), /尺寸/);
  assert.match(hintOf(404, 'model not found'), /模型名/);
  assert.match(hintOf(401, ''), /API Key/);
  assert.match(hintOf(404, 'not found'), /服务地址/);
  assert.match(hintOf(502, 'bad gateway'), /过几分钟/);
  assert.equal(hintOf(418, 'teapot'), '');
});

test('hintOf 真的接进 HTTP 错误：余额不足的 400 会带充值提示', async () => {
  const fetchImpl = async () => jsonResponse({ error: { message: 'insufficient balance' } }, 400);
  await assert.rejects(
    () => generate({ cfg: cfg0({ fallbacks: [], fallbackEnabled: false }), prompt: '猫', fetchImpl }),
    (e) => {
      assert.match(e.message, /没画出来/);
      assert.match(e.message, /insufficient balance/, '上游原话要带回来，别丢信息');
      assert.match(e.cause?.hint ?? '', /余额|充值/, 'httpError 的 hint 要真的用上 hintOf');
      assert.match(e.hint, /面板里检查地址/);
      return true;
    },
  );
});

test('fallbackEnabled=false：主接口挂了也不打备用链，且说清是开关关着', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return jsonResponse({ error: { message: 'oops' } }, 500);
    return okFetch()(url);  // 备用本来是能成功的
  };
  const cfg = cfg0({ fallbackEnabled: false });
  await assert.rejects(
    () => generate({ cfg, prompt: '猫', fetchImpl }),
    (e) => {
      assert.match(e.hint, /失败自动切换.*关着的/);
      return true;
    },
  );
  assert.equal(calls.length, 1, '关了自动切换就不该再打备用');
  assert.ok(!calls.some((u) => u.includes('bak.test')));
});

test('fallbackEnabled=true：主接口 500 后走备用，via 标出走的是哪条', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return jsonResponse({ error: { message: 'oops' } }, 500);
    return okFetch()(url);
  };
  const r = await generate({ cfg: cfg0(), prompt: '猫', fetchImpl });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('bak.test'));
  assert.match(r.via, /备用 1/);
  assert.equal(r.buf.length, PNG.length);
});

test('没写 fallbackEnabled 的老配置仍默认走备用链（向后兼容）', async () => {
  const cfg = cfg0();
  delete cfg.fallbackEnabled;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return jsonResponse({ error: { message: 'oops' } }, 500);
    return okFetch()(url);
  };
  const r = await generate({ cfg, prompt: '猫', fetchImpl });
  assert.match(r.via, /备用 1/);
});

test('timeoutSec 转成请求超时：每次 fetch 都带 AbortSignal', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push(opts?.signal); return okFetch()(url); };
  await generate({ cfg: cfg0({ fallbacks: [], timeoutSec: 30 }), prompt: '猫', fetchImpl });
  assert.equal(seen.length, 1);
  assert.ok(seen[0] instanceof AbortSignal, '没给 signal 就是无限等，CDN 慢的时候会挂死');
});

test('接口直接回图片字节（image/*）也有 20MB 闸，别只给 fetchImage 加', async () => {
  const huge = Buffer.alloc(21 * 1024 * 1024, 7);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => huge.buffer.slice(huge.byteOffset, huge.byteOffset + huge.byteLength),
  });
  await assert.rejects(
    () => generate({ cfg: cfg0({ fallbacks: [] }), prompt: '猫', fetchImpl }),
    (e) => {
      assert.match(e.message, /没画出来/);
      assert.match(e.cause?.message ?? e.message, /太大|20MB/);
      return true;
    },
  );
});

test('timeoutMs 显式注入优先于配置（面板按钮夹到 120 秒靠这条）', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push(opts?.signal); return okFetch()(url); };
  await generate({ cfg: cfg0({ fallbacks: [], timeoutSec: 180 }), prompt: '猫', fetchImpl, timeoutMs: 5000 });
  assert.ok(seen[0] instanceof AbortSignal);
  assert.equal(seen[0].aborted, false);
});

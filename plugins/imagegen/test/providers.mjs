#!/usr/bin/env node
/**
 * 接口层：三种接法的请求形状与降级（假 fetch，不联网）
 *
 *   node test/providers.mjs
 *
 * 这里断言的是「发出去的东西」和「拿回来的东西」，两边都容易悄悄错：
 *   · 请求形状错了（比如把 base64 请求写成默认 URL 返回）→ 接口回 400，看起来像密钥问题；
 *   · 响应解析错了（拿提示词当图片）→ 存下一堆坏文件，等到发图时才炸。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PaintError } from '../lib/errors.mjs';
import { customRequest, dimsOf, endpointOf, findImage, generate } from '../lib/providers.mjs';
import { sniffMime } from '../lib/net.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
const b64 = PNG.toString('base64');

/** 最小 Response 替身：只实现代码真用到的几个成员。 */
function resp(status, { json, bytes, type = 'application/json' } = {}) {
  const headers = new Map([['content-type', type]]);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null },
    async json() {
      if (json === undefined) throw new Error('not json');
      return json;
    },
    async arrayBuffer() {
      /**
       * 必须按 `byteOffset` 切：`Buffer.concat` / `allocUnsafe` 拿到的是
       * 共享内存池里的一段视图，直接 `.buffer` 会带上别人的字节。
       */
      const b = bytes ?? Buffer.alloc(0);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    },
  };
}

const cfgOf = (over = {}) => ({
  provider: 'openai',
  baseUrl: 'https://api.test/v1',
  apiKey: 'sk-test',
  model: 'm1',
  size: '1024x1024',
  stylePrompt: '',
  img2img: true,
  custom: { url: '', method: 'POST', params: [], bodyType: 'json', responsePath: '' },
  fallbacks: [],
  ...over,
});

test('endpointOf：根地址 / 尾斜杠 / 完整地址三种写法都对', () => {
  assert.equal(endpointOf('https://a/v1', 'generate'), 'https://a/v1/images/generations');
  assert.equal(endpointOf('https://a/v1/', 'generate'), 'https://a/v1/images/generations');
  assert.equal(endpointOf('https://a/v1/images/generations', 'generate'), 'https://a/v1/images/generations');
  assert.equal(endpointOf('https://a/v1/images/generations', 'edit'), 'https://a/v1/images/edits');
  assert.equal(endpointOf('https://a/v1/images/edits', 'generate'), 'https://a/v1/images/generations');
});

test('dimsOf：认得出就拆宽高，认不出给两个空串', () => {
  assert.deepEqual(dimsOf('1024x768'), { width: '1024', height: '768' });
  assert.deepEqual(dimsOf('1024'), { width: '', height: '' });
});

test('OpenAI 兼容：请求带 model/prompt/size，b64 直接解码', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return resp(200, { json: { data: [{ b64_json: b64 }] } });
  };
  const out = await generate({ cfg: cfgOf(), prompt: '一只猫', fetchImpl });
  assert.equal(out.via, '主接口');
  assert.equal(sniffMime(out.buf), 'image/png');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.test/v1/images/generations');
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.model, 'm1');
  assert.equal(body.prompt, '一只猫');
  assert.equal(body.size, '1024x1024');
  assert.equal(body.n, 1);
  assert.equal(seen[0].init.headers.authorization, 'Bearer sk-test');
});

test('OpenAI 兼容：返回 URL 时下载回来（而不是当成 base64 解）', async () => {
  const fetchImpl = async (url) => {
    if (url.startsWith('https://api.test')) return resp(200, { json: { data: [{ url: 'https://cdn.test/a.png' }] } });
    return resp(200, { bytes: PNG, type: 'image/png' });
  };
  const out = await generate({ cfg: cfgOf(), prompt: '猫', fetchImpl });
  assert.equal(out.buf.length, PNG.length);
});

test('OpenAI 兼容：response_format 被拒（400 且点名）→ 去掉它重发一次', async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if ('response_format' in body) {
      return resp(400, { json: { error: { message: 'Unsupported parameter: response_format' } } });
    }
    return resp(200, { json: { data: [{ b64_json: b64 }] } });
  };
  const out = await generate({ cfg: cfgOf(), prompt: '猫', fetchImpl });
  assert.equal(bodies.length, 2);
  assert.ok('response_format' in bodies[0]);
  assert.ok(!('response_format' in bodies[1]));
  assert.equal(sniffMime(out.buf), 'image/png');
});

test('OpenAI 兼容：别的 400 不重试（重试也不会成功，还多花一次钱）', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return resp(400, { json: { error: { message: 'prompt 违规' } } });
  };
  await assert.rejects(() => generate({ cfg: cfgOf(), prompt: 'x', fetchImpl }), (e) => {
    assert.ok(e instanceof PaintError);
    assert.match(e.message, /400/);
    assert.match(e.message, /prompt 违规/);
    return true;
  });
  assert.equal(calls, 1);
});

test('OpenAI 兼容：返回 HTML 错误页 → 明确说「不是图片」', async () => {
  const fetchImpl = async () => resp(200, { bytes: Buffer.from('<!doctype html><html>'), type: 'image/png' });
  await assert.rejects(() => generate({ cfg: cfgOf(), prompt: 'x', fetchImpl }), /不是图片/);
});

test('连不上（fetch 抛）→ 说清是网络问题，并提示本地服务要先打开', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(() => generate({ cfg: cfgOf(), prompt: 'x', fetchImpl }), (e) => {
    assert.match(e.message, /连不上/);
    assert.match(e.hint, /本地服务|地址/);
    return true;
  });
});

test('自定义 GET：占位符进地址、参数拼成 query、按 responsePath 取图', async () => {
  const cfg = cfgOf({
    provider: 'custom',
    apiKey: '',
    custom: {
      url: 'https://draw.test/api?q={prompt}&w={width}',
      method: 'GET',
      params: [{ key: 'n', value: '1' }],
      bodyType: 'json',
      responsePath: 'result.image',
    },
  });
  let seenUrl = '';
  const fetchImpl = async (url) => {
    seenUrl = url;
    return resp(200, { json: { result: { image: `data:image/png;base64,${b64}` } } });
  };
  const out = await generate({ cfg, prompt: '一只 猫', fetchImpl });
  assert.match(seenUrl, /^https:\/\/draw\.test\/api\?q=/);
  assert.match(seenUrl, /%E4%B8%80%E5%8F%AA%20%E7%8C%AB/);
  assert.match(seenUrl, /w=1024/);
  assert.match(seenUrl, /n=1/);
  assert.equal(sniffMime(out.buf), 'image/png');
});

test('自定义 POST 表单：content-type 与 body 都要对', async () => {
  const cfg = cfgOf({
    provider: 'custom',
    custom: {
      url: 'https://draw.test/api',
      method: 'POST',
      params: [{ key: 'text', value: '{prompt}' }, { key: 'size', value: '{width}x{height}' }],
      bodyType: 'form',
      responsePath: 'data.0.b64_json',
    },
  });
  let init = null;
  const fetchImpl = async (_url, i) => {
    init = i;
    return resp(200, { json: { data: [{ b64_json: b64 }] } });
  };
  await generate({ cfg, prompt: '猫', fetchImpl });
  assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(init.body, `text=${encodeURIComponent('猫')}&size=1024x1024`);
});

test('自定义接口：给了参考图却没有 {image} 位置 → 当场拒，不发请求', async () => {
  const cfg = cfgOf({
    provider: 'custom',
    custom: { url: 'https://draw.test/api', method: 'POST', params: [{ key: 'prompt', value: '{prompt}' }], bodyType: 'json', responsePath: '' },
  });
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return resp(200, { json: {} }); };
  await assert.rejects(() => generate({ cfg, prompt: '猫', image: PNG, fetchImpl }), /参考图/);
  assert.equal(calls, 0);
  /** 带上 {image} 就能发 */
  const ok = customRequest({ ...cfg, custom: { ...cfg.custom, params: [{ key: 'img', value: '{image}' }] } }, '猫', PNG);
  assert.match(ok.body, /"img":"iVBOR/);
});

test('备用链：主接口 502 → 换备用接口，结果里说清走的哪条', async () => {
  const cfg = cfgOf({ fallbacks: [{ baseUrl: 'https://b.test/v1', model: 'm2' }] });
  const hits = [];
  const fetchImpl = async (url, init) => {
    hits.push(url);
    if (url.startsWith('https://api.test')) return resp(502, { json: { error: { message: 'bad gateway' } } });
    assert.equal(JSON.parse(init.body).model, 'm2');
    return resp(200, { json: { data: [{ b64_json: b64 }] } });
  };
  const out = await generate({ cfg, prompt: '猫', fetchImpl });
  assert.equal(hits.length, 2);
  assert.match(out.via, /备用 1/);
  assert.equal(sniffMime(out.buf), 'image/png');
});

test('备用链全挂：错误里既有主接口也有备用，方便一眼看出是不是同一个原因', async () => {
  const cfg = cfgOf({ fallbacks: [{ baseUrl: 'https://b.test/v1', model: 'm2' }] });
  const fetchImpl = async () => resp(500, { json: { error: { message: 'boom' } } });
  await assert.rejects(() => generate({ cfg, prompt: '猫', fetchImpl }), (e) => {
    assert.match(e.message, /主接口/);
    assert.match(e.message, /备用 1/);
    assert.match(e.hint, /备用接口/);
    return true;
  });
});

test('findImage：只在明确的图片字段里找，不把提示词回显当图', () => {
  assert.equal(findImage({ prompt: 'a.png 这种字符串不是图' }), null);
  assert.equal(findImage({ data: [{ url: 'https://cdn/a.jpeg' }] }), 'https://cdn/a.jpeg');
  assert.equal(findImage({ nested: { image: 'data:image/png;base64,AAA' } }), 'data:image/png;base64,AAA');
  assert.equal(findImage({ a: 'https://x/a.html' }), null);
});

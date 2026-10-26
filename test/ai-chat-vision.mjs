/**
 * 图片下载的测试。用假 fetch，不联网。
 *
 * 重点测三件事：只认图片格式、超限跳过、失败不连累整轮。
 * 跑法：node test/ai-chat-vision.mjs
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, '..', 'plugins', 'ai-chat');

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}${detail ? '  ' + detail : ''}`);
  }
};

const { collectImages, guessMime, MAX_IMAGES } = await import(pathToFileURL(path.join(PLUGIN, 'vision.js')));

/** 假 fetch：按 URL 返回不同的东西 */
function fakeFetch(map) {
  return async (url) => {
    const v = map[String(url)];
    if (v === undefined) return { ok: false, status: 404, headers: new Map() };
    if (v instanceof Error) throw v;
    const buf = Buffer.from(v.body);
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? v.type || '' : null) },
      arrayBuffer: async () => buf,
    };
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);

const msgWith = (urls) => ({
  messageId: 'm1',
  attachments: urls.map((url) => ({ type: 'image', url })),
});

/* ---------------- 正常路径 ---------------- */

{
  globalThis.fetch = fakeFetch({
    'https://a/1.png': { body: PNG, type: 'image/png' },
    'https://a/2.jpg': { body: JPG, type: 'image/jpeg' },
  });

  const out = await collectImages(msgWith(['https://a/1.png', 'https://a/2.jpg']));
  ok('图片: 下载了两张', out.length === 2);
  ok('图片: 带 mediaType', out[0].mediaType === 'image/png' && out[1].mediaType === 'image/jpeg');
  ok('图片: 转成 base64', typeof out[0].data === 'string' && out[0].data.length > 0);
  ok('图片: 带名字', /^qq-m1-1$/.test(out[0].name), out[0].name);
}

/* ---------------- 只认图片 ---------------- */

{
  globalThis.fetch = fakeFetch({
    'https://a/x.txt': { body: 'hello', type: 'text/plain' },
  });
  const out = await collectImages(msgWith(['https://a/x.txt']));
  ok('图片: 非图片格式被拒', out.length === 0);
}

/* ---------------- 超过单张大小上限 ---------------- */

{
  const big = Buffer.alloc(3 * 1024 * 1024, 1);
  big[0] = 0x89;
  big[1] = 0x50;
  globalThis.fetch = fakeFetch({ 'https://a/big.png': { body: big, type: 'image/png' } });
  const logs = [];
  const out = await collectImages(msgWith(['https://a/big.png']), { log: (m) => logs.push(m) });
  ok('图片: 太大的跳过', out.length === 0);
  ok('图片: 跳过时有日志', logs.length === 1 && /太大/.test(logs[0]), logs[0] || '');
}

/* ---------------- 一张失败不影响另一张 ---------------- */

{
  globalThis.fetch = fakeFetch({
    'https://a/ok.png': { body: PNG, type: 'image/png' },
    'https://a/bad.png': new Error('network down'),
  });
  const out = await collectImages(msgWith(['https://a/bad.png', 'https://a/ok.png']));
  ok('图片: 挂了一张，另一张照样能用', out.length === 1 && out[0].mediaType === 'image/png');
}

/* ---------------- 张数上限 ---------------- */

{
  const urls = Array.from({ length: 8 }, (_, i) => `https://a/${i}.png`);
  const map = {};
  for (const u of urls) map[u] = { body: PNG, type: 'image/png' };
  globalThis.fetch = fakeFetch(map);

  const out = await collectImages(msgWith(urls));
  ok('图片: 默认最多看 4 张', out.length === MAX_IMAGES, String(out.length));

  const few = await collectImages(msgWith(urls), { max: 2 });
  ok('图片: max 参数生效', few.length === 2);
}

/* ---------------- 没有图 / 不是图 ---------------- */

{
  ok('图片: 没图返回空数组', (await collectImages({ attachments: [] })).length === 0);
  ok('图片: 只有语音也不处理', (await collectImages({ attachments: [{ type: 'voice', asrText: 'x' }] })).length === 0);
}

/* ---------------- mime 猜测 ---------------- */

{
  ok('mime: 认 PNG 头', guessMime(PNG, '') === 'image/png');
  ok('mime: 认 JPEG 头', guessMime(JPG, '') === 'image/jpeg');
  ok('mime: content-type 优先', guessMime(Buffer.from('x'), 'image/webp') === 'image/webp');
  ok('mime: 认不出来返回空', guessMime(Buffer.from('hello'), 'text/plain') === '');
}

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.log('失败项:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exitCode = 1;
}

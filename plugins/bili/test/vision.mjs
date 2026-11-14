/**
 * 看画面：抽帧时间点 + 调宿主 /llm.vision 的边界。
 *
 * 这里最关键的是「失败不能拖累刷一轮」——没 ffmpeg / 模型看不了图 /
 * 宿主 403，都只应该让这条视频退回文字，而不是抛出去把整轮废掉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { askVision, frameTimes, lookAt } from '../lib/vision.mjs';

test('frameTimes：跳过首尾各 5%，均匀铺开，去重', () => {
  assert.deepEqual(frameTimes(0, 4), [], '没时长就没有时间点');
  assert.deepEqual(frameTimes(100, 1), [50], '只取一帧时取中点');
  const t3 = frameTimes(100, 3);
  assert.equal(t3.length, 3);
  assert.equal(t3[0], 5, '开头 5%');
  assert.equal(t3.at(-1), 95, '结尾 95%');
  /** 极短视频：不越界到「等于时长」 */
  const short = frameTimes(2, 6);
  assert.ok(short.every((x) => x < 2), '时间点必须小于时长');
  assert.ok(frameTimes(100, 99).length <= 6, '最多 6 帧');
});

test('askVision：没令牌 / 没图就不发请求', async () => {
  let called = 0;
  const r = await askVision({ env: {}, images: [{ data: 'x' }], fetchImpl: async () => { called += 1; } });
  assert.equal(r.ok, false);
  assert.match(r.why, /ROOST_API_URL/);
  assert.equal(called, 0);

  const r2 = await askVision({ env: { ROOST_API_URL: 'http://x/v1', ROOST_API_TOKEN: 't' }, images: [] });
  assert.equal(r2.ok, false);
  assert.match(r2.why, /没有抽到帧/);
});

test('askVision：POST /llm.vision，带 Bearer 和 extId，返回文本', async () => {
  const calls = [];
  const r = await askVision({
    env: { ROOST_API_URL: 'http://127.0.0.1:1/v1', ROOST_API_TOKEN: 'tk', ROOST_EXT_ID: 'bili' },
    prompt: '看看这个',
    images: [{ data: 'AAAA', mediaType: 'image/jpeg' }],
    fetchImpl: async (url, opt) => {
      calls.push([url, opt]);
      return { ok: true, status: 200, json: async () => ({ ok: true, text: '一只猫在窗台上' }) };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.text, '一只猫在窗台上');
  assert.equal(calls[0][0], 'http://127.0.0.1:1/v1/llm.vision');
  assert.equal(calls[0][1].headers.authorization, 'Bearer tk');
  const body = JSON.parse(calls[0][1].body);
  assert.equal(body.extId, 'bili');
  assert.equal(body.images.length, 1);
});

test('askVision：宿主拒绝（403 / 模型看不了图）把原因带回来，不抛', async () => {
  const r = await askVision({
    env: { ROOST_API_URL: 'http://127.0.0.1:1/v1', ROOST_API_TOKEN: 'tk' },
    images: [{ data: 'AAAA' }],
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ ok: false, message: '当前模型（x）不支持图片输入' }) }),
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /不支持图片输入/);
});

test('lookAt：没 ffmpeg 直接返回空串，不抽帧也不调模型', async () => {
  let taken = 0;
  let asked = 0;
  const out = await lookAt({
    v: { bvid: 'BV1xx411c7mD' },
    info: { duration: 60, cid: 1 },
    shots: { ffmpegStatus: () => ({ ready: false }), take: async () => { taken += 1; return { path: '' }; } },
    cfg: { autoShotCount: 3 },
    env: {},
    fetchImpl: async () => { asked += 1; },
  });
  assert.equal(out, '');
  assert.equal(taken, 0);
  assert.equal(asked, 0);
});

test('lookAt：抽到帧才去问模型，描述原样带回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-vision-'));
  try {
    const fps = [];
    for (let i = 0; i < 3; i += 1) {
      const f = join(dir, `f${i}.jpg`);
      writeFileSync(f, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      fps.push(f);
    }
    let n = 0;
    let asked = 0;
    const out = await lookAt({
      v: { bvid: 'BV1xx411c7mD', title: '猫', author: 'up' },
      info: { duration: 60, cid: 1, title: '猫' },
      shots: { ffmpegStatus: () => ({ ready: true }), take: async () => ({ path: fps[n++] }) },
      cfg: { autoShotCount: 3 },
      env: { ROOST_API_URL: 'http://127.0.0.1:1/v1', ROOST_API_TOKEN: 'tk' },
      fetchImpl: async () => {
        asked += 1;
        return { ok: true, status: 200, json: async () => ({ ok: true, text: '橘猫在打盹' }) };
      },
    });
    assert.equal(out, '橘猫在打盹');
    assert.equal(n, 3, '按 autoShotCount 抽三帧');
    assert.equal(asked, 1, '只问一次模型');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lookAt：模型拒绝时返回空串（退回文字），不抛', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-vision-'));
  try {
    const f = join(dir, 'f.jpg');
    writeFileSync(f, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const out = await lookAt({
      v: { bvid: 'BV1xx411c7mD' },
      info: { duration: 30, cid: 1 },
      shots: { ffmpegStatus: () => ({ ready: true }), take: async () => ({ path: f }) },
      cfg: { autoShotCount: 1 },
      env: { ROOST_API_URL: 'http://127.0.0.1:1/v1', ROOST_API_TOKEN: 'tk' },
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ ok: false, message: '模型报错' }) }),
    });
    assert.equal(out, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 抽帧：不真起 ffmpeg、不联网。spawn 与 ffmpeg 探测都注入假实现。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createShots, grabFrame, pickStream, safeStreamUrl } from '../lib/shots.mjs';
import { BiliError } from '../lib/api.mjs';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(700, 1), Buffer.from([0xff, 0xd9])]);

/** 假 spawn：下一拍往 stdout 吐一张 JPEG 再 close(0)。 */
function fakeSpawn() {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = () => {};
  process.nextTick(() => {
    p.stdout.emit('data', JPEG);
    p.emit('close', 0);
  });
  return p;
}

/** 必须 await fn：同步版会在异步用例还没跑完时就把临时目录删掉。 */
async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bili-shots-test-'));
  try { return await fn(dir); }
  finally { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 系统回收 */ } }
}

const INFO = { bvid: 'BV1ZAWM61Evb', cid: 123, duration: 100, title: '一只猫' };
const api = {
  async playurl() {
    return { video: [{ codecs: 'avc1.640032', width: 640, height: 360, bandwidth: 500, baseUrl: 'https://upos-sz-mirrorali.bilivideo.com/v.mp4' }], durl: [] };
  },
};

test('流地址白名单：只认 https 公网，内网页一律挡', () => {
  assert.equal(safeStreamUrl('https://upos-sz-mirrorali.bilivideo.com/v.mp4').startsWith('https://'), true);
  for (const u of [
    'http://a.bilibili.com/v.mp4', 'https://127.0.0.1/v.mp4',
    'https://192.168.1.2/v.mp4', 'https://172.16.0.1/v.mp4',
    'https://10.1.2.3/v.mp4', 'https://localhost/v.mp4', 'not a url',
  ]) assert.equal(safeStreamUrl(u), '', u);
});

test('挑流：H.264 优先、带宽最低，没 DASH 就退回 durl', () => {
  const pu = {
    video: [
      { codecs: 'hev1.1.6', baseUrl: 'https://a.hdslb.com/hevc.m4s', bandwidth: 100, width: 1080, height: 1920 },
      { codecs: 'avc1.640032', baseUrl: 'https://a.hdslb.com/hi.m4s', bandwidth: 900, width: 1080, height: 1920 },
      { codecs: 'avc1.64001f', baseUrl: 'https://a.hdslb.com/low.m4s', bandwidth: 300, width: 640, height: 360 },
      { codecs: 'avc1.64001f', baseUrl: 'http://a.hdslb.com/plain.m4s', bandwidth: 1, width: 640, height: 360 },
    ],
    durl: [],
  };
  assert.equal(pickStream(pu), 'https://a.hdslb.com/low.m4s');
  assert.equal(pickStream({ video: [], durl: [{ url: '//a.hdslb.com/x.mp4' }] }), '', '协议相对地址也不收');
  assert.equal(pickStream({ video: [], durl: [{ url: 'https://a.hdslb.com/x.mp4' }] }), 'https://a.hdslb.com/x.mp4');
});

test('grabFrame：只认 JPEG 魔数，超时/非 0 退出都返回 null', async () => {
  assert.ok(await grabFrame('ffmpeg', 'https://a.hdslb.com/v.mp4', 3, { spawnImpl: fakeSpawn, timeoutMs: 1000 }));
  const bad = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => {};
    process.nextTick(() => { p.stdout.emit('data', Buffer.from('not an image')); p.emit('close', 0); });
    return p;
  };
  assert.equal(await grabFrame('ffmpeg', 'https://a.hdslb.com/v.mp4', 3, { spawnImpl: bad, timeoutMs: 1000 }), null);
  const hang = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => {};
    return p;
  };
  assert.equal(await grabFrame('ffmpeg', 'https://a.hdslb.com/v.mp4', 3, { spawnImpl: hang, timeoutMs: 30 }), null);
});

test('take：存下文件、返回绝对路径和 <<image-alone:>>，清理只删自己命名的旧图', async () => {
  await withDir(async (dir) => {
    const shots = createShots({
      dir, keep: 2, width: 512, api, spawnImpl: fakeSpawn,
      probeImpl: () => true,
    });
    writeFileSync(join(dir, 'BV1ZAWM61Evb-1.jpg'), 'old');
    writeFileSync(join(dir, 'BV1ZAWM61Evb-2.jpg'), 'old');
    writeFileSync(join(dir, '我的照片.jpg'), '别删');

    const r = await shots.take({ info: INFO, at: 12 });
    assert.ok(existsSync(r.path), '文件真写下来了');
    assert.ok(r.path.startsWith(dir));
    assert.match(r.text, /<<image-alone: .+\.jpg>>/);
    assert.ok(r.text.includes(r.path), '模型要能拿到完整路径');
    assert.equal((readdirSync(dir).filter((f) => /\.jpg$/.test(f))).length, 3, '留 2 张自己的 + 用户那张');
    assert.ok(existsSync(join(dir, '我的照片.jpg')), '别删用户放在同目录的文件');
  });
});

test('take：没 ffmpeg / 没 cid / 拿不到流都给人话原因，不抛裸错', async () => {
  await withDir(async (dir) => {
    const noFfmpeg = createShots({ dir, api, spawnImpl: fakeSpawn, probeImpl: () => false });
    await assert.rejects(() => noFfmpeg.take({ info: INFO, at: 1 }), (e) => e instanceof BiliError && /ffmpeg/.test(e.message) && Boolean(e.hint));

    const noStream = createShots({ dir, api: { async playurl() { return { video: [], durl: [] }; } }, spawnImpl: fakeSpawn, probeImpl: () => true });
    await assert.rejects(() => noStream.take({ info: INFO, at: 1 }), (e) => e instanceof BiliError && /播放流/.test(e.message));

    const ok = createShots({ dir, api, spawnImpl: fakeSpawn, probeImpl: () => true });
    await assert.rejects(() => ok.take({ info: { ...INFO, cid: 0 }, at: 1 }), (e) => e instanceof BiliError && /cid/.test(e.message));
  });
});

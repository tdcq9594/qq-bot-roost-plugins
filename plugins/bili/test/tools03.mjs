// 0.3 三个新工具在 toolbox 边界的行为：不联网、不真起 ffmpeg。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createToolbox } from '../lib/tools.mjs';
import { BiliError } from '../lib/api.mjs';

const VIEW = {
  bvid: 'BV1ZAWM61Evb', aid: 1, cid: 2,
  title: '一只猫', desc: '窗台上打盹', author: '兔总裁s',
  play: 1_954_000, pubdate: 0, duration: 100, tname: '动画',
  cover: 'https://i0.hdslb.com/bfs/archive/cover.jpg',
};
const POOL = Array.from({ length: 5 }, (_, i) => ({ ...VIEW, bvid: `BV000000000${i}`, title: `视频 ${i}` }));

function make({ feed = null, shots = null, over = {} } = {}) {
  const calls = [];
  const api = {
    async hot() { calls.push(['hot']); return POOL; },
    async weekly() { return { number: 1, name: '', subject: '', items: POOL }; },
    async search() { return POOL; },
    async view() { calls.push(['view']); return VIEW; },
    async account() { return { isLogin: false }; },
    async subtitle() { return { text: '', lang: '' }; },
    async comments() { return []; },
    async danmaku() { return []; },
    async resolveShort() { calls.push(['resolveShort']); return 'BV1ZAWM61Evb'; },
    async bangumi() { return {}; },
    async up() { return { name: 'u', mid: 1, items: [] }; },
    ...over,
  };
  const box = createToolbox({ api, config: {}, feed, shots });
  return { box, calls };
}

test('card：调一次 view，返回可原样抄的标记串', async () => {
  const { box, calls } = make();
  const text = await box.call('card', { link: 'BV1ZAWM61Evb' });
  assert.match(text, /<<card: 一只猫\|窗台上打盹\|https:\/\/www\.bilibili\.com\/video\/BV1ZAWM61Evb\|https:\/\//);
  assert.match(text, /原样写进你的回复/);
  assert.deepEqual(calls, [['view']]);
});

test('card：b23 短链先跳一次；番剧 / 未知参数当场拒', async () => {
  const { box, calls } = make();
  await box.call('card', { link: 'https://b23.tv/abc' });
  assert.deepEqual(calls, [['resolveShort'], ['view']]);
  await assert.rejects(() => box.call('card', { link: 'ep12345' }), (e) => e instanceof BiliError && /番剧/.test(e.message));
  await assert.rejects(() => box.call('card', { link: 'BV1ZAWM61Evb', promt: 'x' }), (e) => e instanceof BiliError && /不认识的参数/.test(e.message));
});

test('shot：默认抽全片 10% 处，显式 at 原样传；没装截图依赖就给原因', async () => {
  const seen = [];
  const shots = { async take({ info, at }) { seen.push(at); return { path: 'C:/tmp/a.jpg', text: `<<image-alone: C:/tmp/a.jpg>>（${info.bvid}）` }; } };
  const { box } = make({ shots });
  const text = await box.call('shot', { link: 'BV1ZAWM61Evb' });
  assert.equal(seen[0], 10);
  assert.match(text, /<<image-alone: /);
  await box.call('shot', { link: 'BV1ZAWM61Evb', at: 30 });
  assert.equal(seen[1], 30);
  await assert.rejects(() => box.call('shot', { link: 'BV1ZAWM61Evb', at: '三十' }), (e) => e instanceof BiliError);

  const bare = make();
  await assert.rejects(() => bare.box.call('shot', { link: 'BV1ZAWM61Evb' }), (e) => e instanceof BiliError && /没启用截图/.test(e.message));
});

test('feed：没开定时刷给可操作提示，开了就把最近一批列出来', async () => {
  const off = make();
  assert.match(await off.box.call('feed', {}), /定时刷没开/);

  const feed = {
    enabled: true,
    state: () => ({ enabled: true, minutes: 30, activeHours: '9-23', at: Date.now(), items: POOL.length, error: '' }),
    items: () => POOL,
  };
  const on = make({ feed });
  const text = await on.box.call('feed', { limit: 2 });
  assert.match(text, /最近一次定时刷/);
  assert.match(text, /视频 0/);
  assert.doesNotMatch(text, /视频 4/, 'limit=2 只能给两条');
  await assert.rejects(() => on.box.call('feed', { limt: 2 }), (e) => e instanceof BiliError && /不认识的参数/.test(e.message));
});

test('setPool：定时刷喂进来的池子被 hot 直接复用，不再打 B 站', async () => {
  const { box, calls } = make();
  assert.equal(box.setPool(POOL), true);
  const text = await box.call('hot', { limit: 2 });
  assert.match(text, /视频 0/);
  assert.deepEqual(calls, [], '刚刷完不该再请求一次');
  assert.equal(box.setPool([]), false);
});

/* ---------------- 0.10.1：模型自己写评论 / 点赞 ---------------- */

function makeWritable({ dryRun = false, fail = '' } = {}) {
  const seen = [];
  const write = {
    async comment(aid, text) {
      seen.push(['comment', aid, text]);
      if (fail) return { ok: false, why: fail };
      return { ok: true, dryRun };
    },
    async like(aid) {
      seen.push(['like', aid]);
      if (fail) return { ok: false, why: fail };
      return { ok: true, dryRun };
    },
  };
  const api = {
    async view() { return VIEW; },
    async resolveShort() { return 'BV1ZAWM61Evb'; },
  };
  return { box: createToolbox({ api, config: {}, write }), seen };
}

test('comment：把模型写的那句原样发出去，不套模板', async () => {
  const { box, seen } = makeWritable();
  const text = await box.call('comment', { link: 'BV1ZAWM61Evb', text: '这只猫跟我家的一样懒' });
  assert.deepEqual(seen, [['comment', 1, '这只猫跟我家的一样懒']]);
  assert.match(text, /已在《一只猫》下发了评论/);
  assert.match(text, /这只猫跟我家的一样懒/);
});

test('comment：试运行时如实说没发出去，但仍把话复述一遍', async () => {
  const { box } = makeWritable({ dryRun: true });
  const text = await box.call('comment', { link: 'BV1ZAWM61Evb', text: '好' });
  assert.match(text, /试运行/);
  assert.match(text, /本来要在《一只猫》下评论「好」/);
});

test('comment：空文案 / 写层拒绝都要说清原因', async () => {
  const { box } = makeWritable();
  await assert.rejects(() => box.call('comment', { link: 'BV1ZAWM61Evb', text: '   ' }), /空的/);

  const bad = makeWritable({ fail: '今日写操作额度用完了' });
  await assert.rejects(() => bad.box.call('comment', { link: 'BV1ZAWM61Evb', text: 'x' }), /额度/);
});

test('like：走 write 层，试运行如实返回', async () => {
  const { box, seen } = makeWritable();
  const text = await box.call('like', { link: 'BV1ZAWM61Evb' });
  assert.deepEqual(seen, [['like', 1]]);
  assert.match(text, /已给《一只猫》点赞/);

  const dry = makeWritable({ dryRun: true });
  assert.match(await dry.box.call('like', { link: 'BV1ZAWM61Evb' }), /试运行/);
});

test('没接 write 时明确拒绝，不假装成功', async () => {
  const box = createToolbox({ api: { async view() { return VIEW; } }, config: {} });
  await assert.rejects(() => box.call('like', { link: 'BV1ZAWM61Evb' }), /写动作没接上/);
});

// 定时刷：默认关、三道闸、只预热不推送。全部用假 api / 假定时器，不联网。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inActiveHours, parseActiveHours, readConfig, secretEnv } from '../lib/config.mjs';
import { createFeed, createHostState, filterItems, MIN_FEED_MINUTES } from '../lib/feed.mjs';
import { createSeenStore } from '../lib/seen.mjs';

/**
 * 必须 `await fn(dir)`：同步 `finally` 会在异步回调跑完之前就把目录删掉，
 * 于是落盘的 seen 文件读不到，表现为「跨实例去重没生效」的假失败。
 */
async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bili-feed-'));
  try { return await fn(dir); }
  finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 系统回收 */ } }
}

const POOL = Array.from({ length: 5 }, (_, i) => ({ bvid: `BV${i}`, title: `视频 ${i}` }));

const hour = (h) => new Date(2026, 10, 14, h, 30, 0);

function make(over = {}) {
  const fresh = [];
  const api = { async hot() { return POOL; }, state: () => ({ pausedUntil: 0 }), ...over.api };
  const feed = createFeed({
    cfg: { feedIntervalMin: 30, feedActiveHours: '', hotPoolSize: 20 },
    api,
    hostState: async () => ({ ok: true, mood: { valence: 0.1 } }),
    onFresh: (items) => fresh.push(items),
    ...over,
  });
  return { feed, fresh };
}

test('活跃时段：白天、跨午夜、非法格式按全天', () => {
  assert.deepEqual(parseActiveHours('9-23'), { start: 9, end: 23 });
  assert.deepEqual(parseActiveHours('22～6'), { start: 22, end: 6 });
  assert.equal(parseActiveHours('随便写'), null);
  assert.equal(inActiveHours('9-23', hour(8)), false);
  assert.equal(inActiveHours('9-23', hour(9)), true);
  assert.equal(inActiveHours('9-23', hour(23)), false);
  assert.equal(inActiveHours('22-6', hour(23)), true);
  assert.equal(inActiveHours('22-6', hour(3)), true);
  assert.equal(inActiveHours('22-6', hour(12)), false);
  assert.equal(inActiveHours('', hour(3)), true, '没填 = 全天');
});

test('配置：默认关，secret Cookie 只从 env 来', () => {
  const env = {
    ROOST_EXT_CONFIG: JSON.stringify({ feedIntervalMin: 30, feedActiveHours: '9-23', feedIntervalMin_bad: 1 }),
    [secretEnv('cookie')]: 'SESSDATA=abc; bili_jct=xyz',
  };
  const c = readConfig(env);
  assert.equal(secretEnv('cookie'), 'ROOST_EXT_SECRET_COOKIE');
  assert.equal(c.feedIntervalMin, 30);
  assert.equal(c.feedActiveHours, '9-23');
  assert.equal(c.cookie, 'SESSDATA=abc; bili_jct=xyz');
  assert.equal(c.shotDir, '');
  assert.equal(readConfig({}).feedIntervalMin, 0, '装了扩展就一直打接口是不行的，默认必须关');
  assert.equal(readConfig({ ROOST_EXT_CONFIG: '{坏' }).defaultLimit, 6, '配置坏了不该让扩展起不来');
});

test('createFeed：0 / 10 分钟都不启动，15 分钟起才排定时器', () => {
  const timers = [];
  const fakeInterval = (fn, ms) => { timers.push(ms); const t = { unref() { t.unrefed = true; } }; return t; };
  const off = createFeed({ cfg: { feedIntervalMin: 10 }, api: {}, intervalImpl: fakeInterval });
  assert.equal(off.enabled, false);
  assert.equal(off.start(), false);
  assert.equal(timers.length, 0);

  const { feed } = make({ intervalImpl: fakeInterval });
  assert.equal(feed.enabled, true);
  assert.equal(feed.start(), true);
  assert.equal(timers[0], 30 * 60_000);
  assert.equal(feed.start(), false, '别重复挂两个定时器');
  assert.equal(MIN_FEED_MINUTES, 15);
});

test('tick 成功：拉一次热门，喂给 onFresh，记下时间和条数', async () => {
  const { feed, fresh } = make({ now: () => 1_700_000_000_000 });
  const r = await feed.tick('测试');
  assert.equal(r.ok, true);
  assert.equal(r.count, POOL.length);
  assert.equal(fresh.length, 1);
  assert.equal(feed.items().length, POOL.length);
  assert.equal(feed.state().at, 1_700_000_000_000);
  assert.equal(feed.state().count, POOL.length);
  assert.deepEqual(feed.state().hostMood, { valence: 0.1 });
});

test('tick 的三道闸：不在时段 / 宿主没在线 / B 站风控退避', async () => {
  let called = 0;
  const hot = async () => { called += 1; return POOL; };

  const quiet = createFeed({
    cfg: { feedIntervalMin: 30, feedActiveHours: '9-23' },
    api: { hot, state: () => ({ pausedUntil: 0 }) },
    hostState: async () => ({ ok: true }),
    now: () => hour(3).getTime(),
  });
  const r = await quiet.tick();
  assert.equal(r.ok, false);
  assert.match(r.why, /不在活跃时段/);
  assert.equal(called, 0, '半夜不该打 B 站');

  const offline = createFeed({
    cfg: { feedIntervalMin: 30, feedActiveHours: '' },
    api: { hot, state: () => ({ pausedUntil: 0 }) },
    hostState: async () => ({ ok: false, why: '宿主没起来' }),
  });
  assert.equal((await offline.tick()).ok, false);
  assert.equal(called, 0, '宿主没在线就别白打 B 站');

  const paused = createFeed({
    cfg: { feedIntervalMin: 30, feedActiveHours: '' },
    api: { hot, state: () => ({ pausedUntil: Date.now() + 60_000 }) },
    hostState: async () => ({ ok: true }),
  });
  assert.equal((await paused.tick()).ok, false);
  assert.equal(called, 0, '412 退避期继续撞只会加重风控');
});

test('seed：启动预热那批只填内存，不额外发请求', () => {
  const { feed, fresh } = make();
  assert.equal(feed.seed(POOL, '预热'), true);
  assert.equal(feed.items().length, POOL.length);
  assert.equal(feed.state().reason, '预热');
  assert.equal(fresh.length, 0, 'seed 不走 onFresh');
  assert.equal(feed.seed([]), false);
});

test('createHostState：没 env 时给原因，401 / 非 200 都不算在线', async () => {
  const none = await createHostState({})();
  assert.equal(none.ok, false);
  assert.match(none.why, /ROOST_API_URL/);
  const ok = await createHostState({ ROOST_API_URL: 'http://127.0.0.1:1/v1/', ROOST_API_TOKEN: 't' })({
    fetchImpl: async () => ({ status: 200, async json() { return { ok: true, mood: {} }; } }),
  });
  assert.equal(ok.ok, true);
  const denied = await createHostState({ ROOST_API_URL: 'http://127.0.0.1:1/v1', ROOST_API_TOKEN: 't' })({
    fetchImpl: async () => ({ status: 401, async json() { return { ok: false }; } }),
  });
  assert.equal(denied.ok, false);
});

// ---------------------------------------------------------------------------
// 配置热读之后：间隔 / 总开关改了要能立刻重排定时器
// ---------------------------------------------------------------------------

test('syncTimer：改间隔会重起定时器，关掉会停', () => {
  const timers = [];
  const cleared = [];
  const cfg = { enabled: true, feedIntervalMin: 30, hotPoolSize: 5, feedActiveHours: '' };
  const feed = createFeed({
    cfg,
    api: { hot: async () => [], state: () => ({ pausedUntil: 0 }) },
    intervalImpl: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; },
    clearImpl: (t) => { cleared.push(t); },
  });

  assert.equal(feed.start(), true);
  assert.equal(timers.at(-1).ms, 30 * 60_000, '先按 30 分钟起');

  /** 同一个 timer 不变：syncTimer 不该无脑重建 */
  assert.equal(feed.syncTimer(), false);

  cfg.feedIntervalMin = 60;
  assert.equal(feed.syncTimer(), true, '间隔变了要重起');
  assert.equal(timers.at(-1).ms, 60 * 60_000);
  assert.equal(cleared.length, 1, '旧定时器要被清掉，否则两份同时在跑');

  /** 低于下限等于关：定时器必须停掉 */
  cfg.feedIntervalMin = 5;
  assert.equal(feed.syncTimer(), true);
  assert.equal(cleared.length, 2);
  assert.equal(feed.enabled, false);
  assert.equal(feed.minutes, 5);
});

test('tick 之前会先跑 beforeTick（用来热读配置）', async () => {
  let refreshed = 0;
  const feed = createFeed({
    cfg: { enabled: true, feedIntervalMin: 30, hotPoolSize: 5, feedActiveHours: '' },
    api: { hot: async () => [{ bvid: 'BV1xx411c7mD' }], state: () => ({}) },
    hostState: async () => ({ ok: true }),
    beforeTick: async () => { refreshed += 1; },
  });
  await feed.tick('手动');
  assert.equal(refreshed, 1);
});

// ---------------------------------------------------------------------------
// 一轮的筛子（对齐 aurabot 那页的播放量 / 只看最近 / 一轮几个 / 每日上限）
// ---------------------------------------------------------------------------

test('filterItems：播放量门槛与新鲜度，0 表示不限', () => {
  const now = Date.UTC(2026, 10, 14);
  const day = 86_400_000;
  const list = [
    { bvid: 'BV1', play: 100, pubdate: Math.floor(now / 1000) },          // 新，播放少
    { bvid: 'BV2', play: 900000, pubdate: Math.floor((now - 30 * day) / 1000) }, // 老，播放多
    { bvid: 'BV3', play: 900000, pubdate: Math.floor(now / 1000) },       // 新，播放多
    { bvid: 'BV4', play: 500, pubdate: 0 },                                // 没有发布时间
  ];
  assert.equal(filterItems(list, { now }).length, 4, '都不限时全都留');
  assert.deepEqual(filterItems(list, { minViews: 1000, now }).map((v) => v.bvid), ['BV2', 'BV3']);
  /** `pubdate` 是秒，`now` 是毫秒：换算错了这条会全空 */
  assert.deepEqual(filterItems(list, { maxAgeDays: 7, now }).map((v) => v.bvid), ['BV1', 'BV3', 'BV4']);
  assert.deepEqual(
    filterItems(list, { minViews: 1000, maxAgeDays: 7, now }).map((v) => v.bvid),
    ['BV3'],
  );
});

test('每日上限只拦定时刷，手动不受限', async () => {
  const cfg = { enabled: true, feedIntervalMin: 30, hotPoolSize: 5, feedActiveHours: '', feedMaxRunsPerDay: 2 };
  let runs = 2;
  const feed = createFeed({
    cfg,
    api: { hot: async () => [{ bvid: 'BV1xx411c7mD', play: 1, pubdate: Math.floor(Date.now() / 1000) }], state: () => ({}) },
    hostState: async () => ({ ok: true }),
    runsToday: () => runs,
  });

  const auto = await feed.tick('定时');
  assert.equal(auto.ok, false);
  assert.match(auto.why, /到上限/);

  /** 手动是用户明确要的，不该被上限挡 */
  runs = 2;
  const manual = await feed.tick('手动');
  assert.equal(manual.ok, true);
});

test('一轮看几个：筛完再截断', async () => {
  const now = Math.floor(Date.now() / 1000);
  const many = Array.from({ length: 10 }, (_, i) => ({ bvid: `BV1xx411c7m${'ABCDEFGHIJ'[i]}`, play: 1000, pubdate: now }));
  let seen = 0;
  const feed = createFeed({
    cfg: { enabled: true, feedIntervalMin: 30, hotPoolSize: 20, feedActiveHours: '', feedPerRun: 3 },
    api: { hot: async () => many, state: () => ({}) },
    hostState: async () => ({ ok: true }),
    onFresh: (items) => { seen = items.length; },
  });
  const r = await feed.tick('手动');
  assert.equal(r.ok, true);
  assert.equal(r.count, 3);
  assert.equal(seen, 3, 'onFresh 拿到的也应该是截断后的');
});

test('连着刷几轮：热门榜没变也要换一批，不能每轮都是同样几条', async () => {
  const pool = Array.from({ length: 10 }, (_, i) => ({ bvid: `BV${String(i).padStart(2, '0')}`, title: `视频 ${i}` }));
  const feed = createFeed({
    cfg: { enabled: true, feedIntervalMin: 30, hotPoolSize: 20, feedActiveHours: '', feedPerRun: 3 },
    api: { hot: async () => pool, state: () => ({}) },
    hostState: async () => ({ ok: true }),
  });
  await feed.tick('手动');
  const a = feed.items().map((v) => v.bvid);
  await feed.tick('手动');
  const b = feed.items().map((v) => v.bvid);
  await feed.tick('手动');
  const c = feed.items().map((v) => v.bvid);
  assert.equal(a.length, 3);
  assert.equal(a.filter((x) => b.includes(x)).length, 0, '第二轮不能和第一轮撞车');
  assert.equal(c.filter((x) => a.includes(x) || b.includes(x)).length, 0, '第三轮也得是没给过的');
  /** 转完一圈允许从头再来，别因为记住了全部就把热门池锁死 */
  await feed.tick('手动');
  const d = feed.items().map((v) => v.bvid);
  assert.equal(d.length, 3);
});

test('筛得太严时明确报错，不是静默返回 0 条', async () => {
  const feed = createFeed({
    cfg: { enabled: true, feedIntervalMin: 30, hotPoolSize: 5, feedActiveHours: '', feedMinViews: 9_999_999 },
    api: { hot: async () => [{ bvid: 'BV1xx411c7mD', play: 1, pubdate: 0 }], state: () => ({}) },
    hostState: async () => ({ ok: true }),
  });
  const r = await feed.tick('手动');
  assert.equal(r.ok, false);
  assert.match(r.why, /筛得太严/);
});

/* ---------------------------------------------------------------- *
 * 2026-11-14 对齐 aurabot duty.js 的四方面：
 *   ① seen 落盘跨实例 ② 候选阶段排除已看
 *   ③ 关键词 search 为主（热门只补缺口） ④ 按来源轮流取
 * ---------------------------------------------------------------- */

test('关键词走 search(keyword,{limit})：以前把对象当关键词，方向一直没生效', async () => {
  const calls = [];
  const feed = createFeed({
    cfg: { feedActiveHours: '', feedPerRun: 3, feedKeywords: '猫咪\n做菜', hotPages: 1 },
    api: {
      hot: async () => [{ bvid: 'BVHOT1', title: '热门' }],
      search: async (kw, opts) => { calls.push([kw, opts]); return [{ bvid: `BV_${kw}`, title: kw }]; },
      state: () => ({}),
    },
    hostState: async () => ({ ok: true }),
  });
  const r = await feed.tick('手动');
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], '猫咪', '第一个参数必须是字符串关键词');
  assert.deepEqual(calls[0][1], { limit: 4 });
});

test('按来源轮流取：一轮里搜索词和热门各占，不整轮都是同一类', async () => {
  const feed = createFeed({
    cfg: { feedActiveHours: '', feedPerRun: 4, feedKeywords: '猫咪', hotPages: 1 },
    api: {
      hot: async () => ['h1', 'h2', 'h3', 'h4'].map((i) => ({ bvid: `BVH${i}`, title: i })),
      search: async () => ['s1', 's2', 's3', 's4'].map((i) => ({ bvid: `BVS${i}`, title: i })),
      state: () => ({}),
    },
    hostState: async () => ({ ok: true }),
  });
  await feed.tick('手动');
  assert.equal(feed.items().length, 4);
  assert.equal(new Set(feed.items().map((v) => String(v.src))).size, 2);
});

test('seen 落盘：换一个 feed 实例仍不重复给同一批', async () => withDir(async (dir) => {
  const pool = Array.from({ length: 6 }, (_, i) => ({ bvid: `BV${i}`, title: `视频${i}` }));
  const api = { hot: async () => pool, state: () => ({}) };
  const mk = () => createFeed({
    cfg: { feedActiveHours: '', feedPerRun: 3, hotPages: 1 },
    api, hostState: async () => ({ ok: true }),
    seen: createSeenStore({ dir }),
  });
  const a = mk();
  await a.tick('手动');
  const b = mk();
  await b.tick('手动');
  const A = a.items().map((v) => v.bvid);
  const B = b.items().map((v) => v.bvid);
  assert.equal(A.length, 3);
  assert.equal(A.filter((x) => B.includes(x)).length, 0, '新实例读到落盘 seen');
}));

test('她上一轮给的关键词进下一轮搜索；关掉开关就不读', async () => withDir(async (dir) => {
  const seen = createSeenStore({ dir });
  seen.setNextKeywords(['折纸', '观鸟']);
  const calls = [];
  const mk = (smart) => createFeed({
    cfg: { feedActiveHours: '', feedPerRun: 2, hotPages: 1, feedSmartKeywords: smart },
    api: {
      hot: async () => [{ bvid: 'BVHOT1', title: '热门' }],
      search: async (kw) => { calls.push(kw); return []; },
      state: () => ({}),
    },
    hostState: async () => ({ ok: true }),
    seen,
  });
  await mk(true).tick('手动');
  assert.deepEqual(calls, ['折纸', '观鸟']);
  calls.length = 0;
  await mk(false).tick('手动');
  assert.deepEqual(calls, [], '关掉「让她挑下一轮想看的」就不该用模型给的词');
}));

test('热门翻页：pn=1/2 都拉，候选池比只翻第一页大', async () => {
  const pns = [];
  const feed = createFeed({
    cfg: { feedActiveHours: '', feedPerRun: 4, hotPages: 2 },
    api: {
      hot: async ({ pn }) => { pns.push(pn); return [{ bvid: `BVHOT${pn}`, title: `热门${pn}` }]; },
      state: () => ({}),
    },
    hostState: async () => ({ ok: true }),
  });
  await feed.tick('手动');
  assert.deepEqual(pns, [1, 2]);
  assert.equal(feed.items().length, 2, '两个不同 BV 都该进候选');
});

test('候选全看过时按最久没看的借几条，手动按钮不空手', async () => withDir(async (dir) => {
  const seen = createSeenStore({ dir });
  const pool = [0, 1, 2].map((i) => ({ bvid: `BV${i}`, title: `视频${i}` }));
  seen.add(pool);
  const feed = createFeed({
    cfg: { feedActiveHours: '', feedPerRun: 2, hotPages: 1 },
    api: { hot: async () => pool, state: () => ({}) },
    hostState: async () => ({ ok: true }),
    seen,
  });
  const r = await feed.tick('手动');
  assert.equal(r.ok, true, 'aurabot 会回「没搜到」，但面板手动点了不该空手');
  assert.equal(feed.items().length, 2);
  assert.equal(feed.state().reused, 2);
  assert.deepEqual(feed.items().map((v) => v.bvid), ['BV0', 'BV1'], '优先借最久没看的');
}));

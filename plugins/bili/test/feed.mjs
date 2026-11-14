// 定时刷：默认关、三道闸、只预热不推送。全部用假 api / 假定时器，不联网。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inActiveHours, parseActiveHours, readConfig, secretEnv } from '../lib/config.mjs';
import { createFeed, createHostState, MIN_FEED_MINUTES } from '../lib/feed.mjs';

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

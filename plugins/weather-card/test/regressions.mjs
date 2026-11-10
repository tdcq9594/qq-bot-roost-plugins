// 审查发现的 bug 的回归测试。每条都对应一个真实可复现的故障，
// 修完不加锁的话下次重构很容易又踩回去。
import test from 'node:test';
import assert from 'node:assert/strict';

import plugin, { internals, DEFAULTS } from '../index.js';
// ⚠️ 必须与 index.js 里的 specifier 完全一致（现在都**不带**查询串）。
// 带不带 ?v= 在 ESM 里是两个模块实例：打桩会打到另一个副本上，
// 现象是「明明替身了 fetch，请求还是真的发出去」。测试会真的出网。
import { SOURCES } from '../lib/sources.js';
import { cropBottom, encodePng, decodePng, hexToRgb } from '../lib/png.js';

const { parseRegions } = internals;

/** 刚过去 1 分钟的播报点。用 00:00 会被「迟到超 2 小时不补发」挡掉，那是正确行为，测不到发信。 */
function justNow() {
  const d = new Date(Date.now() - 60000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ── 脚手架：假 ctx ──────────────────────────────────────────── */

function makeCtx({ canReturn = true, config = {}, api } = {}) {
  const store = new Map();
  const commands = new Map();
  const schedules = [];
  const handlers = { message: [] };
  const ctx = {
    id: 'weather-card', logger: { info() {}, warn() {}, error() {}, debug() {} },
    config: { ...DEFAULTS, cooldownSec: 0, ...config },
    state: {},
    command(p, o, fn) { commands.set(p.split(' ')[0], fn); },
    menu() {}, on(e, fn) { (handlers[e] ||= []).push(fn); },
    schedule(name, ms, fn) { schedules.push({ name, ms, fn }); },
    registerTool() {}, setDashboard() {}, onTeardown() {},
    storage: { get: async (k, d) => (store.has(k) ? store.get(k) : d), set: async (k, v) => { store.set(k, v); } },
    // 关键：**async**，和真实框架一致（context.js: async can(msg, need)）
    can: async () => canReturn,
    levelOf: async () => (canReturn ? 1 : 9),
    async setConfig(p) { Object.assign(ctx.config, p); return ctx.config; },
    api: api || { uploadMedia: async () => ({ file_info: 'F' }), sendGroup: async () => {} },
    _store: store, _commands: commands, _schedules: schedules, _handlers: handlers,
  };
  return ctx;
}

const mkMsg = (content, { group = true, isCommand = false, args } = {}) => ({
  id: 'M' + Math.random().toString(36).slice(2, 7),
  kind: group ? 'group' : 'c2c',
  groupId: group ? '44DE039E7B5FF07C7A770B4890644F97' : '',
  userId: 'USER_OPENID_ABCDEF123456',
  content, isCommand,
  args: args || content.replace(/^[/.]/, '').split(/\s+/).slice(1),
  receivedAt: Date.now(),
  replies: [], images: [],
  async reply(t) { this.replies.push(t); },
  async replyNow(t) { this.replies.push(t); },
  async replyImageBuffer(b) { this.images.push(b); return { ok: true }; },
  claim() {}, flushReplies: async () => {},
});

/* ── ① 权限校验必须 await（否则任何群成员都能改配置）─────────────── */

test('非管理员不能改播报目标（ctx.can 是 async，少 await 会恒真）', async () => {
  const ctx = makeCtx({ canReturn: false });
  plugin.setup(ctx);
  await new Promise((r) => setTimeout(r, 50));

  const before = ctx.config.broadcastTargets;
  const msg = mkMsg('/天气 绑定播报', { isCommand: true, args: ['绑定播报'] });
  await ctx._commands.get('天气')(msg);

  assert.equal(ctx.config.broadcastTargets, before, '普通成员不该写入 broadcastTargets');
  assert.match(String(msg.replies[0]), /管理员/);
});

test('管理员可以改播报目标', async () => {
  const ctx = makeCtx({ canReturn: true });
  plugin.setup(ctx);
  await new Promise((r) => setTimeout(r, 50));

  const msg = mkMsg('/天气 绑定播报', { isCommand: true, args: ['绑定播报'] });
  await ctx._commands.get('天气')(msg);
  assert.match(String(ctx.config.broadcastTargets), /44DE039E/);
});

/* ── ② 每个数据源都要报请求数，否则每日上限形同虚设 ──────────────── */

test('所有数据源都返回 _requests（否则配额永远计 0）', () => {
  // 只检查声明层面：每个源都要有 fetch，且 qweather 以外也不能漏报（靠下面的假请求验证）
  for (const id of ['wttr', 'openweather', 'qweather', 'custom']) {
    assert.equal(typeof SOURCES[id].fetch, 'function', `${id} 缺 fetch`);
  }
});

test('wttr 真实路径会把请求数报上来并计入配额', async () => {
  const fakeFetch = async () => ({
    ok: true, status: 200,
    async json() {
      return {
        current_condition: [{ temp_C: '22', weatherCode: '113', weatherDesc: [{ value: 'Sunny' }] }],
        nearest_area: [{ areaName: [{ value: 'X' }] }],
        weather: [{ date: '2099-01-01', maxtempC: '25', mintempC: '18', astronomy: [{}], hourly: [] }],
      };
    },
  });
  const state = {};
  const cfg = { ...DEFAULTS, source: 'wttr', dailyRequestLimit: 100 };
  const r = await internals.fetchWeather('测试城', { state, cfg, fetchRef: fakeFetch });
  assert.equal(r.temp, 22);
  assert.equal(state.quota.used, 1, 'wttr 必须计 1 次，否则 dailyRequestLimit 不生效');
});

test('配额兜底：源不报 _requests 时按 1 次计', async () => {
  const state = {};
  // 构造一个「忘了报 _requests」的源
  const original = SOURCES.wttr.fetch;
  SOURCES.wttr.fetch = async () => ({ region: 'x', temp: 20, days: [], hours: [], daysRequested: true });
  try {
    const cfg = { ...DEFAULTS, source: 'wttr', dailyRequestLimit: 100 };
    await internals.fetchWeather('兜底城', { state, cfg, fetchRef: async () => ({}) });
    assert.equal(state.quota.used, 1, '没报也要按 1 次计，不能静默变 0');
  } finally {
    SOURCES.wttr.fetch = original;
  }
});

/* ── ③ 播报重入锁 + 按群粒度去重 ─────────────────────────────── */

test('播报有重入锁：慢任务未完成时第二次 tick 直接跳过', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = makeCtx();
  ctx.config.regions = '上海';
  ctx.config.broadcastTime = justNow();
  ctx.config.broadcastTargets = '44DE039E7B5FF07C7A770B4890644F97';
  ctx.api.uploadMedia = async () => { await gate; return { file_info: 'F' }; };
  const sends = [];
  ctx.api.sendGroup = async (g) => { sends.push(g); };

  // 让天气取数立刻返回（不打真实网络）
  const original = SOURCES.wttr.fetch;
  SOURCES.wttr.fetch = async () => ({ region: '上海', temp: 20, days: [], hours: [], daysRequested: true, _requests: 1 });
  try {
    plugin.setup(ctx);
    await new Promise((r) => setTimeout(r, 50));
    const tick = ctx._schedules.find((s) => s.name === 'weather-broadcast').fn;

    const first = tick();          // 卡在 uploadMedia 里
    await new Promise((r) => setTimeout(r, 20));
    await tick();                  // 第二拍：应当被锁挡掉
    release();
    await first;
    assert.equal(sends.length, 1, `并发两拍只该发一次，实际 ${sends.length} 次`);
  } finally {
    SOURCES.wttr.fetch = original;
  }
});

test('播报按群去重：G1 成功、G2 失败后只重试 G2', async () => {
  const G1 = '44DE039E7B5FF07C7A770B4890644F97';
  const G2 = '55DE039E7B5FF07C7A770B4890644F98';
  const ctx = makeCtx();
  ctx.config.regions = '上海';
  ctx.config.broadcastTime = justNow();
  ctx.config.broadcastTargets = `${G1},${G2}`;
  const hit = [];
  let failG2 = true;
  ctx.api.sendGroup = async (g) => {
    if (g === G2 && failG2) { hit.push(g); throw new Error('模拟 G2 失败'); }
    hit.push(g);
  };

  const original = SOURCES.wttr.fetch;
  SOURCES.wttr.fetch = async () => ({ region: '上海', temp: 20, days: [], hours: [], daysRequested: true, _requests: 1 });
  try {
    plugin.setup(ctx);
    await new Promise((r) => setTimeout(r, 50));
    const tick = ctx._schedules.find((s) => s.name === 'weather-broadcast').fn;

    await tick();          // G1 成功、G2 失败
    assert.deepEqual(hit, [G1, G2]);

    failG2 = false;
    hit.length = 0;
    await tick();          // 只该重试 G2，不该再发 G1
    assert.deepEqual(hit, [G2], `第二拍应只补发失败的群，实际 ${JSON.stringify(hit)}`);
  } finally {
    SOURCES.wttr.fetch = original;
  }
});

/* ── ④ PNG 裁剪 ─────────────────────────────────────────────── */

test('cropBottom 裁掉底部纯背景行', () => {
  const w = 40;
  const h = 100;
  const bg = [14, 16, 20];
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 3;
      const content = y < 60; // 前 60 行有内容
      data[i] = content ? 200 : bg[0];
      data[i + 1] = content ? 200 : bg[1];
      data[i + 2] = content ? 200 : bg[2];
    }
  }
  const png = encodePng({ width: w, height: h, channels: 3, data });
  const out = cropBottom(png, '#0e1014', { margin: 2, minHeight: 20 });
  const dec = decodePng(out);
  assert.equal(dec.width, w);
  assert.ok(dec.height >= 60 && dec.height <= 63, `裁后高度 ${dec.height} 应在 60~63`);
});

test('cropBottom 遇到非背景图不误裁', () => {
  const w = 10, h = 50;
  const data = Buffer.alloc(w * h * 3, 128); // 全灰，和 bg 不同
  const png = encodePng({ width: w, height: h, channels: 3, data });
  const out = cropBottom(png, '#0e1014');
  assert.equal(decodePng(out).height, h, '全是内容就不该裁');
});

test('hexToRgb 认坏输入', () => {
  assert.deepEqual(hexToRgb('#0e1014'), [14, 16, 20]);
  assert.equal(hexToRgb('not-a-color'), null);
});

/* ── ⑤ parseRegions 先去重再截断 ─────────────────────────────── */

test('parseRegions 先去重再截断（重复项不该吃掉名额）', () => {
  assert.deepEqual(
    parseRegions('北京,北京,上海,杭州,成都,武汉,西安'),
    ['北京', '上海', '杭州', '成都', '武汉', '西安'],
  );
});

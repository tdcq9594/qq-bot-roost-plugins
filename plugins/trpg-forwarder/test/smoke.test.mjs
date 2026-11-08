// trpg-forwarder 冒烟测试：不连 QQ、不连 dsh-trpg，用最小夹具把插件跑起来。
//
// 验证的是「桥」本身的确定性部分：
//   · 清单字段能被市场索引脚本读到（version 必须字面量、description ≤60 字）
//   · 中间件该放行的放行、该接的接（未开团时通用命令不能被吞）
//   · 上行先落盘再投递（Outbox），投递成功才出队
//   · 下行 /send 的令牌校验与幂等
//   · teardown 把定时器清干净
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import plugin, { internals } from '../index.js';

const { DEFAULTS, VERSION } = internals;

/* ── 事件循环保活 ─────────────────────────────────────────────────────
 * 插件里的定时器都 unref()（不该拦住机器人进程退出，这是对的），于是断言
 * 过程中很可能只剩 unref 句柄。Node 22 的 node:test 在事件循环空掉时会判定
 * 「Promise resolution is still pending but the event loop has already
 * resolved」，把用例整组 cancel —— 本地 Node 24 全绿、CI 的 Node 22 全红。
 */
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

/* ── 假的 dsh-trpg ───────────────────────────────────────────────────── */

const dsh = { running: false, healthy: true, received: [] };
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (u.includes('/trpg/health')) {
      return dsh.healthy ? { ok: true, status: 200, json: async () => ({ ok: true }) } : { ok: false, status: 503 };
    }
    if (u.includes('/trpg/state')) {
      return { ok: true, status: 200, json: async () => ({ running: dsh.running }) };
    }
    if (u.includes('/trpg/event') && method === 'POST') {
      dsh.received.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

/* ── 最小 ctx 夹具 ───────────────────────────────────────────────────── */

function makeCtx(config = {}) {
  const store = new Map();
  const middlewares = [];
  const routes = new Map();
  const menus = [];
  const disposers = [];
  const pushed = [];
  const ctx = {
    id: 'trpg-forwarder',
    prefix: '/',
    config,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    storage: {
      async get(k, d = null) {
        return store.has(k) ? store.get(k) : d;
      },
      async set(k, v) {
        store.set(k, v);
        return v;
      },
      async update(k, fn) {
        const v = await fn(store.has(k) ? store.get(k) : null);
        store.set(k, v);
        return v;
      },
    },
    menu(title, items) {
      menus.push({ title, items });
    },
    use(name, fn) {
      middlewares.push({ name, fn });
    },
    registerRoute(method, pattern, handler) {
      routes.set(`${method} ${pattern}`, handler);
    },
    onTeardown(fn) {
      disposers.push(fn);
    },
    async levelOf() {
      return 1;
    },
    async push(chatId, text) {
      pushed.push({ chatId, text });
    },
    api: {
      sent: [],
      sentC2C: [],
      async sendGroup(groupId, opts) {
        ctx.api.sent.push({ groupId, opts });
      },
      async sendC2C(openid, opts) {
        ctx.api.sentC2C.push({ openid, opts });
      },
    },
    async setConfig(patch) {
      Object.assign(config, patch);
      return config;
    },
    __store: store,
    __middlewares: middlewares,
    __routes: routes,
    __menus: menus,
    __pushed: pushed,
    __teardown() {
      for (const fn of disposers.splice(0)) fn();
    },
  };
  return ctx;
}

function makeMsg(text, over = {}) {
  const msg = {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'group',
    content: text,
    groupId: 'G1',
    groupUin: 'G1',
    userId: 'u1',
    uin: '10001',
    userName: '小明',
    receivedAt: Date.now(),
    replies: [],
    async replyNow(t) {
      msg.replies.push(String(t));
    },
    ...over,
  };
  return msg;
}

/** 跑一次中间件；返回是否放行（调了 next）。 */
async function runMw(ctx, msg) {
  const mw = ctx.__middlewares.find((m) => m.name === 'trpg-forward').fn;
  let released = false;
  const next = async () => {
    released = true;
  };
  await mw({ msg, cfg: {} }, next);
  return released;
}

const settle = () => new Promise((r) => setTimeout(r, 20));

/* ── 清单字段 ─────────────────────────────────────────────────────────── */

test('清单 version 是字面量，索引脚本读得到', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const m = src.match(/^\s*version:\s*['"]([^'"]+)['"]/m);
  assert.ok(m, "export default 里必须写 version: 'x.y.z' 字面量——引用常量会让 build-index.mjs 读不到");
  assert.equal(m[1], plugin.version);
  assert.equal(plugin.version, VERSION);
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
});

test('市场描述是单行、不超过 60 字', () => {
  assert.ok(!plugin.description.includes('\n'), 'description 必须是单行：build-index 会原样灌进索引');
  assert.ok(plugin.description.length <= 60, `description 有 ${plugin.description.length} 字`);
  assert.match(plugin.id, /^[a-z0-9-]+$/);
  assert.equal(plugin.id, 'trpg-forwarder');
});

test('不预置共享令牌（写死密码等于给本机任何进程发通行证）', () => {
  assert.equal(DEFAULTS.token, '');
  assert.equal(plugin.config.token.default, '');
});

/* ── 注册面 ───────────────────────────────────────────────────────────── */

test('setup 注册菜单、中间件、/send 路由，并能干净 teardown', async () => {
  const ctx = makeCtx({ token: 't0k3n' });
  plugin.setup(ctx);

  assert.equal(ctx.__middlewares.length, 1);
  assert.equal(ctx.__middlewares[0].name, 'trpg-forward');
  assert.ok(ctx.__routes.has('POST /send'));
  assert.ok(ctx.__menus.some((m) => m.title === '跑团转发'), '必须有菜单，否则用户看不见怎么玩');

  ctx.__teardown();
});

/* ── 中间件：放行 / 拦截 ──────────────────────────────────────────────── */

test('非群消息、机器人消息、空文本都放行', async () => {
  const ctx = makeCtx({ token: 't0k3n' });
  plugin.setup(ctx);

  assert.equal(await runMw(ctx, makeMsg('随便说说', { kind: 'c2c' })), true);
  assert.equal(await runMw(ctx, makeMsg('我是一条机器人消息', { raw: { author: { bot: true } } })), true);
  assert.equal(await runMw(ctx, makeMsg('   ')), true);

  ctx.__teardown();
});

test('没开团的群里，通用命令 /help 必须放行（不能把别人命令吞掉）', async () => {
  const ctx = makeCtx({ token: 't0k3n' });
  dsh.running = false;
  plugin.setup(ctx);

  for (const cmd of ['/help', '/status', '/roll 3d6', '/r 1d100', '/?']) {
    assert.equal(await runMw(ctx, makeMsg(cmd)), true, `${cmd} 不该被转发器拦下`);
  }
  // 普通闲聊当然也放行
  assert.equal(await runMw(ctx, makeMsg('今天天气不错')), true);

  ctx.__teardown();
});

test('没开团的群里，TRPG 专属命令仍然接住并投递', async () => {
  const ctx = makeCtx({ token: 't0k3n' });
  dsh.running = false;
  dsh.received.length = 0;
  plugin.setup(ctx);

  const msg = makeMsg('/st 亚瑟 hp12 san65');
  assert.equal(await runMw(ctx, msg), false, 'TRPG 命令不该放行给别的插件');
  await settle();

  assert.ok(dsh.received.length >= 1, '应该投递到 dsh-trpg');
  assert.match(dsh.received[0].text, /\/st 亚瑟/);
  assert.equal(await ctx.storage.get('trpg:outbox', []).then((l) => l.length), 0, '投递成功后 Outbox 要清空');

  ctx.__teardown();
});

test('probeState 关（默认）：/trpg start 记过的群，普通发言也归守密人', async () => {
  const ctx = makeCtx({ token: 't0k3n' });
  dsh.running = false; // 远端状态不重要：默认关着探测，只看本地名单
  dsh.received.length = 0;
  plugin.setup(ctx);

  // 先开团，本地名单记下这个群
  await runMw(ctx, makeMsg('/trpg start'));
  await settle();

  const msg = makeMsg('我拿铁丝去撬抽屉');
  assert.equal(await runMw(ctx, msg), false, '开团中普通发言要被接住');
  await settle();
  assert.ok(dsh.received.some((e) => /铁丝/.test(e.text)), '行动要投递给 dsh-trpg');

  ctx.__teardown();
});

test('probeState 关（默认）：/trpg pause 之后普通发言交回普通聊天', async () => {
  const ctx = makeCtx({ token: 't0k3n' });
  dsh.running = false;
  plugin.setup(ctx);

  await runMw(ctx, makeMsg('/trpg start'));
  await settle();
  await runMw(ctx, makeMsg('/trpg pause'));
  await settle();

  assert.equal(await runMw(ctx, makeMsg('随便聊两句')), true, '暂停后不能继续吞消息，否则 ai-chat 收不到');

  ctx.__teardown();
});

test('probeState 打开时以 dsh-trpg 的 /trpg/state 为准', async () => {
  const ctx = makeCtx({ token: 't0k3n', probeState: true });
  dsh.running = true;
  dsh.received.length = 0;
  plugin.setup(ctx);

  const msg = makeMsg('我推开门走进去');
  assert.equal(await runMw(ctx, msg), false, '远端说在跑团，普通发言要被接住');
  await settle();
  assert.ok(dsh.received.some((e) => /推开门/.test(e.text)));

  ctx.__teardown();
  dsh.running = false;
});

test('probeState 关时不会去打 /trpg/state（旧版 dsh-trpg 在这个端点上会崩宿主）', async () => {
  const ctx = makeCtx({ token: 't0k3n' });
  let stateHits = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/trpg/state')) stateHits += 1;
    return saved(url, init);
  };
  plugin.setup(ctx);
  await runMw(ctx, makeMsg('/st 亚瑟 hp12'));
  await settle();
  assert.equal(stateHits, 0, 'probeState 关闭时一个 /trpg/state 请求都不该发');
  globalThis.fetch = saved;
  ctx.__teardown();
});

test('dsh-trpg 不可达时，命令进 Outbox 而不是丢消息', async () => {
  const ctx = makeCtx({ token: 't0k3n' });
  dsh.running = false;
  dsh.received.length = 0;
  dsh.healthy = false;
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503 });

  plugin.setup(ctx);
  const msg = makeMsg('/trpg start');
  await runMw(ctx, msg);
  await settle();

  const outbox = await ctx.storage.get('trpg:outbox', []);
  assert.equal(outbox.length, 1, '投递失败的事件必须留在 Outbox 里等重试');
  assert.equal(outbox[0].text, '/trpg start');

  globalThis.fetch = saved;
  dsh.healthy = true;
  ctx.__teardown();
});

/* ── 下行 /send ───────────────────────────────────────────────────────── */

test('/send：令牌不对返回 403，令牌对才直发群聊', async () => {
  const ctx = makeCtx({ token: 't0k3n' });
  plugin.setup(ctx);
  const handler = ctx.__routes.get('POST /send');
  const call = (body) =>
    handler({
      body,
      json: (code, obj) => ({ code, obj }),
    });

  const bad = await call({ token: 'wrong', groupId: 'G1', content: '你好' });
  assert.equal(bad.code, 403);

  const good = await call({ token: 't0k3n', groupId: 'G1', content: '骰点：侦查 45' });
  assert.equal(good.code, 200);
  assert.equal(ctx.api.sent.length, 1);
  assert.equal(ctx.api.sent[0].groupId, 'G1');

  ctx.__teardown();
});

test('/send：同一 requestId 重复投递不再发第二遍', async () => {
  const ctx = makeCtx({ token: 't0k3n' });
  plugin.setup(ctx);
  const handler = ctx.__routes.get('POST /send');
  const call = (body) => handler({ body, json: (code, obj) => ({ code, obj }) });

  const body = { token: 't0k3n', groupId: 'G1', content: '第二段剧情', requestId: 'req-1' };
  const first = await call(body);
  const second = await call(body);

  assert.equal(first.code, 200);
  assert.equal(second.code, 200);
  assert.equal(second.obj.dup, true, '重复的 requestId 应该判重');
  assert.equal(ctx.api.sent.length, 1, '幂等键命中时不该再发一次');

  ctx.__teardown();
});

test('/send：缺 groupId、空内容、非文本都被拒绝', async () => {
  const ctx = makeCtx({ token: 't0k3n' });
  plugin.setup(ctx);
  const handler = ctx.__routes.get('POST /send');
  const call = (body) => handler({ body, json: (code, obj) => ({ code, obj }) });

  assert.equal((await call({ token: 't0k3n', content: 'x' })).code, 400);
  assert.equal((await call({ token: 't0k3n', groupId: 'G1', content: '   ' })).code, 400);
  assert.equal((await call({ token: 't0k3n', groupId: 'G1', content: 'x', type: 'image' })).code, 400);
  assert.equal(ctx.api.sent.length, 0);

  ctx.__teardown();
});

test('令牌为空时下行直接拒绝（不预置弱口令）', async () => {
  const ctx = makeCtx({});
  plugin.setup(ctx);
  const handler = ctx.__routes.get('POST /send');
  const res = await handler({
    body: { token: '', groupId: 'G1', content: 'hi' },
    json: (code, obj) => ({ code, obj }),
  });
  assert.equal(res.code, 403);
  ctx.__teardown();
});

/* ── 中文命令与单聊（0.6.x 新增） ─────────────────────────────────────── */

test('没开团的群里，中文通用命令也放行', async () => {
  const ctx = makeCtx({ token: 't0k3n' });
  dsh.running = false;
  plugin.setup(ctx);

  for (const cmd of ['/帮助', '/指令', '/状态', '/骰 1d100', '/卡', '/记录']) {
    assert.equal(await runMw(ctx, makeMsg(cmd)), true, `${cmd} 不该被转发器拦下`);
  }

  ctx.__teardown();
});

test('中文 TRPG 命令仍然接住并投递', async () => {
  const ctx = makeCtx({ token: 't0k3n' });
  dsh.running = false;
  dsh.received.length = 0;
  plugin.setup(ctx);

  assert.equal(await runMw(ctx, makeMsg('/开始')), false, '中文开团命令要被接住');
  await settle();
  assert.ok(dsh.received.some((e) => /\/开始/.test(e.text)));

  ctx.__teardown();
});

test('单聊消息也接（以前只认 group，私聊指令全被当普通聊天）', async () => {
  const ctx = makeCtx({ token: 't0k3n' });
  dsh.running = false;
  dsh.received.length = 0;
  plugin.setup(ctx);

  // 私聊里开团：会话键必须是这个人的 openid，不能是空串
  const startDm = makeMsg('/trpg start', { kind: 'c2c', userId: 'u9', groupId: undefined, groupUin: undefined });
  assert.equal(await runMw(ctx, startDm), false, '私聊里的命令也要被接住');
  await settle();

  const dm = makeMsg('我推门进去', { kind: 'c2c', userId: 'u9', groupId: undefined, groupUin: undefined });
  assert.equal(await runMw(ctx, dm), false, '开团后单聊发言也要归守密人');
  await settle();
  const evt = dsh.received.find((e) => e.direct === true);
  assert.ok(evt, '单聊事件要带 direct 标记');
  assert.equal(evt.groupId, 'u9', '单聊用对方 openid 当会话键');

  ctx.__teardown();
});

/* ── /send 的输入校验（0.6.x 新增） ───────────────────────────────────── */

test('/send：内容超过 4000 字返回 413', async () => {
  const ctx = makeCtx({ token: 't0k3n' });
  plugin.setup(ctx);
  const handler = ctx.__routes.get('POST /send');
  const res = await handler({
    body: { token: 't0k3n', groupId: 'G1', content: 'x'.repeat(4001) },
    json: (code, obj) => ({ code, obj }),
  });
  assert.equal(res.code, 413);
  assert.equal(res.obj.limit, 4000);
  assert.equal(ctx.api.sent.length, 0);

  ctx.__teardown();
});

test('/send：atOpenid 里的引号等字符被剥掉（防标签闭合注入）', async () => {
  const ctx = makeCtx({ token: 't0k3n' });
  plugin.setup(ctx);
  const handler = ctx.__routes.get('POST /send');
  await handler({
    body: { token: 't0k3n', groupId: 'G1', content: '你好', atOpenid: 'abc" onerror="x" 123' },
    json: (code, obj) => ({ code, obj }),
  });
  const opts = ctx.api.sent[0]?.opts || {};
  const content = String(opts.content ?? '');
  // 标签本身带引号是正常的；要确认的是 at 值里不再有可闭合标签的字符
  const m = content.match(/<qqbot-at-user id="([^"]*)" \/>/);
  assert.ok(m, `@ 标签没拼出来：${content.slice(0, 60)}`);
  assert.equal(m[1], 'abconerrorx123', '引号/空格/斜杠都要被剥掉');

  ctx.__teardown();
});

test('/send：一分钟内超过 30 条返回 429（令牌泄露不等于无限刷屏）', async () => {
  const ctx = makeCtx({ token: 't0k3n' });
  plugin.setup(ctx);
  const handler = ctx.__routes.get('POST /send');
  let last = null;
  for (let i = 0; i < 31; i += 1) {
    last = await handler({
      body: { token: 't0k3n', groupId: 'G1', content: `第 ${i} 条` },
      json: (code, obj) => ({ code, obj }),
    });
  }
  assert.equal(last.code, 429);
  assert.equal(last.obj.error, 'rate_limited');

  ctx.__teardown();
});

test('/send：direct=true 走 sendC2C，不走 sendGroup', async () => {
  const ctx = makeCtx({ token: 't0k3n' });
  plugin.setup(ctx);
  const handler = ctx.__routes.get('POST /send');
  const res = await handler({
    body: { token: 't0k3n', groupId: 'openid-1', direct: true, content: '私聊回一句' },
    json: (code, obj) => ({ code, obj }),
  });
  assert.equal(res.code, 200);
  assert.equal(ctx.api.sentC2C.length, 1, '单聊必须走 sendC2C');
  assert.equal(ctx.api.sendGroup ? ctx.api.sent.length : 0, 0);

  ctx.__teardown();
});

/* ── 令牌互同步端点（0.6.x 新增） ─────────────────────────────────────── */

test('PATCH /config：旧令牌不对就拒绝，对了才改', async () => {
  const ctx = makeCtx({ token: 'old-token' });
  plugin.setup(ctx);
  const handler = ctx.__routes.get('PATCH /config');
  const call = (body) => handler({ body, json: (code, obj) => ({ code, obj }) });

  assert.equal((await call({ from: 'wrong', token: 'new-token' })).code, 403);
  const ok = await call({ from: 'old-token', token: 'new-token' });
  assert.equal(ok.code, 200);
  assert.equal(ok.obj.tokenConfigured, true);

  ctx.__teardown();
});

test('GET /token：把当前共享令牌交出去（路由本身在框架鉴权之后）', async () => {
  const ctx = makeCtx({ token: 'share-me' });
  plugin.setup(ctx);
  const handler = ctx.__routes.get('GET /token');
  const res = await handler({ json: (code, obj) => ({ code, obj }) });
  assert.equal(res.code, 200);
  assert.equal(res.obj.token, 'share-me');
  assert.equal(res.obj.configured, true);

  ctx.__teardown();
});

/**
 * ai-chat 主动发送接口（`POST /r/send`）的出口测试。
 *
 * 为什么单独一个文件：这条路由是 **dsh-roost 主动搭话的唯一通道**——
 * 持有 QQ 连接的是 ai-chat，不是 dsh-roost。以前它直连
 * `ctx.api.sendGroup` / `ctx.api.sendC2C`，把框架 outbound 的
 * 每秒限速、主动消息额度记账（20/分 + 1000/天）、离线判断、审核识别
 * **全部绕开**了。现在必须走 `ctx.push`。
 *
 * 这里断言的就是「不许改回去」：push 被调用、api 一次都没被调用。
 *
 *   node test/ai-chat-send.mjs
 *   ROOST_FRAMEWORK=/path/to/qq-bot-roost node test/ai-chat-send.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRAMEWORK = process.env.ROOST_FRAMEWORK
  ? path.resolve(process.env.ROOST_FRAMEWORK)
  : path.resolve(HERE, '../../bot');

const { makeCtx } = await import(
  pathToFileURL(path.join(FRAMEWORK, 'src/plugin/testkit.js')).href
);
const { runRoute } = await import(
  pathToFileURL(path.join(FRAMEWORK, 'src/plugin/routes.js')).href
);

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

const plugin = (await import('./../plugins/ai-chat/index.js')).default;

/* ---------------- 可变的桩 ---------------- */

/** push 的返回；改成 { pending: true } 就模拟「进审核」 */
let pushResult = { id: 'p-1' };
/** push 抛什么；null 表示不抛 */
let pushError = null;
const pushed = [];
const direct = [];
const reachCalls = [];
const silenced = [];
let reachVerdict = null; // { verdict:'no', reason:'reach:not-friend' } 时拦下

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-aichat-send-'));

const ctx = makeCtx({
  id: 'ai-chat',
  // 指向连不上的地址，任何意外的真实请求都会立刻失败而不是打到真服务
  config: { dshUrl: 'http://127.0.0.1:1', publicUrl: 'http://127.0.0.1:1' },
  dataDir,
});

const routes = [];
ctx.registerRoute = (method, p, handler) => {
  routes.push({ method, path: p, handler });
  return null;
};

ctx.push = async (target, text, opts) => {
  pushed.push({ target, text, opts });
  if (pushError) throw pushError;
  return pushResult;
};

/**
 * 直发桩。**正常情况下它一次都不该被调用**——被调用了就说明有人
 * 把出口改回 `ctx.api` 了，额度记账又变回半真。
 */
ctx.api = {
  sendGroup: async (t, b) => {
    direct.push({ scene: 'group', target: t, body: b });
    return { id: 'direct' };
  },
  sendC2C: async (t, b) => {
    direct.push({ scene: 'c2c', target: t, body: b });
    return { id: 'direct' };
  },
};

/**
 * 闸的桩。`silence` 是这条路由唯一会写的东西——
 * 她可以说「让我静静」，但说不出来「把整只鸟停掉」。
 */
ctx.gate = {
  silence: async (chatId, ms) => {
    silenced.push({ chatId, ms });
    return { chatId, until: Date.now() + ms };
  },
  check: () => ({ ok: true, reasons: [] }),
  peek: () => ({ global: { paused: false }, bot: { paused: false } }),
  pauseChat: async (chatId, paused) => ({ chatId, paused }),
};

ctx.reach = {
  canC2C: async (openid) => {
    reachCalls.push({ fn: 'canC2C', openid });
    return reachVerdict ?? { verdict: 'yes' };
  },
  canGroupPush: async (gid) => {
    reachCalls.push({ fn: 'canGroupPush', gid });
    return reachVerdict ?? { verdict: 'yes' };
  },
  noteSendOk: async (o) => {
    reachCalls.push({ fn: 'noteSendOk', ...o });
    return true;
  },
  noteSendError: async (o) => {
    reachCalls.push({ fn: 'noteSendError', ...o });
    return true;
  },
};

await plugin.setup(ctx);

const hit = routes.find((r) => r.method === 'POST' && r.path === '/send');
ok('注册了 POST /send 路由', Boolean(hit), hit ? '' : `实际注册: ${routes.map((r) => `${r.method} ${r.path}`).join(', ')}`);

const send = async (body) =>
  runRoute({ handler: hit.handler, params: {} }, { body, method: 'POST' });

const reset = () => {
  pushed.length = 0;
  direct.length = 0;
  reachCalls.length = 0;
  silenced.length = 0;
  reachVerdict = null;
  pushResult = { id: 'p-1' };
  pushError = null;
};

/* ---------------- 1. 群主动 ---------------- */

reset();
{
  const r = await send({ scene: 'group', target: 'g-openid', text: '该说句话了' });
  ok('群主动: 走 ctx.push', pushed.length === 1, `push ${pushed.length} 次`);
  ok('群主动: 直连 api 一次都没调', direct.length === 0, direct.map((d) => d.scene).join(','));
  ok('群主动: kind 传 group', pushed[0]?.opts?.kind === 'group', String(pushed[0]?.opts?.kind));
  ok('群主动: target/text 原样透传', pushed[0]?.target === 'g-openid' && pushed[0]?.text === '该说句话了');
  ok('群主动: 返回 ok', r.data?.ok === true && r.code === 200, JSON.stringify(r.data));
  ok('群主动: 带 msg id', r.data?.id === 'p-1', String(r.data?.id));
  ok('群主动: 先问群推送授权', reachCalls.some((c) => c.fn === 'canGroupPush'));
}

/* ---------------- 2. 私聊主动 ---------------- */

reset();
{
  const r = await send({ scene: 'c2c', target: 'u-openid', text: '在吗' });
  ok('私聊主动: 走 ctx.push', pushed.length === 1 && direct.length === 0);
  ok('私聊主动: kind 传 c2c', pushed[0]?.opts?.kind === 'c2c', String(pushed[0]?.opts?.kind));
  ok('私聊主动: 先问好友关系', reachCalls.some((c) => c.fn === 'canC2C'));
  ok('私聊主动: 成功后回写可达', reachCalls.some((c) => c.fn === 'noteSendOk' && c.openid === 'u-openid'));
  ok('私聊主动: 返回 ok', r.data?.ok === true);
}

/* ---------------- 3. 审核中（304023） ---------------- */

reset();
pushResult = { id: 'p-2', pending: true };
{
  const r = await send({ scene: 'group', target: 'g-openid', text: '这句要审核' });
  ok('审核中: 仍算 ok（不是失败）', r.data?.ok === true);
  ok('审核中: 明确标出 pending', r.data?.pending === true, JSON.stringify(r.data));
}

/* ---------------- 4. 额度用完（outbound 的 SendError） ---------------- */

reset();
{
  const e = new Error('这个会话今天的主动消息额度已用完（1000 条/天）');
  e.name = 'SendError';
  e.code = 'quota';
  pushError = e;
  const r = await send({ scene: 'group', target: 'g-openid', text: 'x' });
  ok('额度用完: 回 ok:false', r.data?.ok === false);
  ok('额度用完: 带出 code=quota', r.data?.code === 'quota', String(r.data?.code));
  ok('额度用完: 人话直接透给调用方', String(r.data?.message).includes('额度'), String(r.data?.message).slice(0, 30));
  ok('额度用完: 不改可达性（跟这个人无关）', !reachCalls.some((c) => c.fn === 'noteSendError'));
}

/* ---------------- 5. 无好友关系（40054004） ---------------- */

reset();
{
  const e = new Error('no friend');
  e.qqCode = 40054004;
  pushError = e;
  const r = await send({ scene: 'c2c', target: 'u-stranger', text: 'x' });
  ok('无好友: 回 ok:false', r.data?.ok === false);
  ok('无好友: 带出 qqCode', r.data?.qqCode === 40054004, String(r.data?.qqCode));
  ok(
    '无好友: 回写可达性',
    reachCalls.some((c) => c.fn === 'noteSendError' && c.qqCode === 40054004 && c.openid === 'u-stranger'),
  );
}

/* ---------------- 6. 可达性判定为「不能」 ---------------- */

reset();
reachVerdict = { verdict: 'no', reason: 'reach:not-friend' };
{
  const r = await send({ scene: 'c2c', target: 'u-stranger', text: 'x' });
  ok('不可达: 直接拒，不浪费一次请求', pushed.length === 0 && direct.length === 0);
  ok('不可达: 回 ok:false 带 reason', r.data?.ok === false && r.data?.reason === 'reach:not-friend');
  ok('不可达: 说清是没加好友', String(r.data?.message).includes('好友'), String(r.data?.message));
}

reset();
reachVerdict = { verdict: 'unknown' };
{
  const r = await send({ scene: 'c2c', target: 'u-unknown', text: 'x' });
  ok('可达性未知: 一律放行', pushed.length === 1 && r.data?.ok === true);
}

/* ---------------- 7. 静默 ---------------- */

/**
 * `<<silence:2h>>` 是唯一一个会改变运行状态的标记，而主动搭话这条路上
 * 它的标记**已经被 speakup 摘掉了**，时长只能靠 `silenceMs` 单独传。
 * 两条来源都要认，否则「她在主动搭话时要求安静」这件事永远不生效。
 */

reset();
{
  const r = await send({ scene: 'c2c', target: 'u-sil', text: '让我静静 <<silence:2h>>' });
  ok('静默: 标记不会漏给用户', pushed[0]?.text === '让我静静', JSON.stringify(pushed[0]?.text));
  ok('静默: 从正文里解析出的时长生效', silenced[0]?.ms === 7_200_000, String(silenced[0]?.ms));
  ok('静默: 仍然算发送成功', r.data?.ok === true);
}

reset();
{
  // 只带静默、没有正文：合法，不发消息但静默生效
  const r = await send({ scene: 'c2c', target: 'u-sil', text: '<<silence:30m>>' });
  ok('静默: 只有标记时不发消息', pushed.length === 0 && direct.length === 0);
  ok('静默: 只有标记时静默仍然生效', silenced[0]?.ms === 1_800_000, String(silenced[0]?.ms));
  ok('静默: 回 silentOnly 而不是失败', r.data?.ok === true && r.data?.silentOnly === true, JSON.stringify(r.data));
}

reset();
{
  // speakup 摘掉标记后单独传的时长
  const r = await send({ scene: 'c2c', target: 'u-sil', text: '好', silenceMs: 3_600_000 });
  ok('静默: silenceMs 字段生效', silenced[0]?.ms === 3_600_000, String(silenced[0]?.ms));
  ok('静默: 正文照常发出去', pushed[0]?.text === '好');
  ok('静默: 返回 ok', r.data?.ok === true);
}

reset();
{
  // 没正文也没静默：才是真的没内容
  const r = await send({ scene: 'c2c', target: 'u-sil', text: '<<remember: 记一下>>' });
  ok('静默: 只剩无关标记时判为空', r.data?.ok === false, JSON.stringify(r.data));
  ok('静默: 判空时不发消息', pushed.length === 0);
}

reset();
{
  // 上限：调用方传一个离谱的值也不能变成永久静默
  await send({ scene: 'c2c', target: 'u-sil', text: '好', silenceMs: 999 * 86_400_000 });
  ok('静默: silenceMs 有 30 天上限', silenced[0]?.ms === 30 * 86_400_000, String(silenced[0]?.ms));
}

/* ---------------- 7. 入参校验 ---------------- */

reset();
{
  const a = await send({ scene: 'group', target: '', text: 'x' });
  ok('校验: 缺 target 拒掉', a.data?.ok === false && pushed.length === 0);
  const b = await send({ scene: 'group', target: 'g', text: '' });
  ok('校验: 缺 text 拒掉', b.data?.ok === false && pushed.length === 0);
  const c = await send({ scene: 'group', target: 'g', text: 'x'.repeat(2001) });
  ok('校验: 超 2000 字拒掉', c.data?.ok === false && pushed.length === 0);
  ok('校验: 被拒时一次都没发', pushed.length === 0 && direct.length === 0);
}

await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.log('失败项: ' + fails.join('、'));
  process.exit(1);
}

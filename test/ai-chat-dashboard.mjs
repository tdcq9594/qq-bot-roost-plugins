/**
 * ai-chat「运行数据」计数
 * ======================
 *
 * 这些计数是纯增量的可观测性，不该改变任何接话行为。这个测试用最小假 ctx
 * 驱动 `setup()`，拿到 `ctx.on('message', handle)` 注册的处理函数，喂几种
 * 会被挡下的消息，再从 `dashboard()` 读回数字。
 *
 * 为什么值得单独一个文件：`paceSt.busy` 静默丢消息、规则门拒消息、配额挡消息
 * 以前连日志都没有（debug 关着时），排查「群里说了 184 句、日记只有 24 轮」
 * 只能靠猜。计数本身要是没接上，面板就是一片 0，比没有更误导。
 *
 * 跑法：
 *   node test/ai-chat-dashboard.mjs
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = path.join(HERE, '..', 'plugins', 'ai-chat', 'index.js');
const plugin = (await import(pathToFileURL(P))).default;

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

const noop = () => {};
const handlers = {};
/** 可变配置：`conf()` 每次现读，测试靠换它切场景 */
const cfg = {
  decide: 'mention',
  dshUrl: 'http://127.0.0.1:17321',
  mergeWaitSec: 0,
  cooldownSec: 0,
  maxRepliesPerMin: 3,
  debug: false,
};
const ctx = new Proxy({}, {
  get(_t, k) {
    if (k === 'config') return cfg;
    if (k === 'storage') return { get: async () => null, set: async () => {} };
    if (k === 'logger') return { info: noop, debug: noop, warn: noop, error: noop };
    if (k === 'on') return (ev, fn) => { handlers[ev] = fn; };
    if (k === 'onTeardown' || k === 'registerRoute') return noop;
    if (k === 'schedule') return () => ({ cancel: noop });
    if (k === 'gate') return () => Promise.resolve(true);
    if (k === 'levelOf') return () => 'member';
    if (k === 'levelName') return () => '成员';
    if (k === 'isOwner') return () => false;
    return () => Promise.resolve({});
  },
});

const msg = (o = {}) => ({
  kind: 'group',
  chatId: 'g1',
  userId: 'u1',
  userName: '甲',
  content: '在吗',
  mentioned: false,
  addressed: false,
  attachments: [],
  author: {},
  reply: async () => ({}),
  ...o,
});

const val = (d, label) => d.metrics.find((m) => m.label === label)?.value;

/* ---------------- 接口形状 ---------------- */

ok('dashboard 存在', typeof plugin.dashboard === 'function');
const d0 = plugin.dashboard();
ok('返回 metrics 数组', Array.isArray(d0.metrics) && d0.metrics.length >= 6, `${d0.metrics?.length} 项`);
ok('每项都有 label / value', d0.metrics.every((m) => typeof m.label === 'string' && typeof m.value === 'number'));
ok('note 带统计起点和拒绝原因', /统计起点/.test(d0.note) && /拒绝原因 Top/.test(d0.note));

/* ---------------- setup 与计数落点 ---------------- */

let setupErr = '';
try {
  await plugin.setup.call(plugin, ctx);
} catch (e) {
  setupErr = e.message;
}
ok('没有 storage 也能起得来（写不进去不该拖垮插件）', !setupErr, setupErr);
ok('注册了 message 处理函数', typeof handlers.message === 'function');

if (typeof handlers.message !== 'function') {
  console.log(`\n${pass}/${pass + fails.length} 通过`);
  process.exit(1);
}

const before = plugin.dashboard();

// mention 模式：普通消息应该被规则门挡下
await handlers.message(msg());
await handlers.message(msg({ content: '又一句' }));
const d1 = plugin.dashboard();
ok('看到消息计数增长', val(d1, '看到消息') === val(before, '看到消息') + 2,
  `${val(before, '看到消息')} → ${val(d1, '看到消息')}`);
ok('规则挡掉计数增长', val(d1, '规则挡掉') === val(before, '规则挡掉') + 2,
  `${val(before, '规则挡掉')} → ${val(d1, '规则挡掉')}`);
ok('拒绝原因写进 note', /只在被 @ 时回复/.test(d1.note), d1.note.split('\n').at(-1));

// 别的插件接过了 → claimed
await handlers.message(msg({ claimedBy: 'echo' }));
const d2 = plugin.dashboard();
ok('别的插件接了计数增长', val(d2, '别的插件接了') === val(d1, '别的插件接了') + 1);

// 对方是机器人 → bots
/** `isFromBot` 认的是 `msg.isBot` 或 `msg.raw.author.bot`（decide.js:77），不是 `msg.author` */
await handlers.message(msg({ isBot: true }));
const d3 = plugin.dashboard();
ok('机器人消息单独计（不占规则门）', val(d3, '规则挡掉') === val(d2, '规则挡掉'));

// 没连上 DSH：真 @ 也会在提示一句后返回，不该算「转发给 DSH」
cfg.dshUrl = '';
await handlers.message(msg({ mentioned: true }));
const d4 = plugin.dashboard();
ok('没连上 DSH 不算转发', val(d4, '转发给 DSH') === val(before, '转发给 DSH'));
cfg.dshUrl = 'http://127.0.0.1:17321';

// 计数不该改变结果：同样的消息再喂一次，只是数字 +1
const d5 = plugin.dashboard();
await handlers.message(msg());
const d6 = plugin.dashboard();
ok('计数不改变行为（同样消息仍被同样挡下）',
  val(d6, '规则挡掉') === val(d5, '规则挡掉') + 1 && val(d6, '转发给 DSH') === val(d5, '转发给 DSH'));

ok('每个分支都有计数，分母可复算（未归类 = 0）', val(d6, '未归类') === 0, `未归类=${val(d6, '未归类')}`);
ok('面板列全了 bots / noDsh / 调用失败 / 忙态等到',
  ['机器人消息', '没连上 DSH', '调用失败', '忙态等到', '未归类']
    .every((l) => d6.metrics.some((m) => m.label === l)));

/* ---------------- 落盘恢复竞态 ---------------- */

/**
 * `ctx.storage.get` 是 async（要 await readFile）。从 setup 到磁盘读回之间
 * 若已进过消息，直接拿存档覆盖模块级 `dash` 会把这批增量整个抹掉。
 *
 * 这里用手动 resolve 的 Promise 精确复现：恢复挂起期间先累计 3 条，
 * 再返回一份旧存档，检查增量有没有被加回去。
 * 用 `?race=` 重新 import 是必要的——`dashLoaded` 是模块级变量。
 */
{
  let resolveGet;
  const delayed = new Promise((r) => { resolveGet = r; });
  const handlers2 = {};
  const cfg2 = { ...cfg, decide: 'mention', dshUrl: 'http://127.0.0.1:17321' };
  const ctx2 = new Proxy({}, {
    get(_t, k) {
      if (k === 'config') return cfg2;
      if (k === 'storage') return { get: () => delayed, set: async () => {} };
      if (k === 'logger') return { info: noop, debug: noop, warn: noop, error: noop };
      if (k === 'on') return (ev, fn) => { handlers2[ev] = fn; };
      if (k === 'onTeardown' || k === 'registerRoute') return noop;
      if (k === 'schedule') return () => ({ cancel: noop });
      if (k === 'gate') return () => Promise.resolve(true);
      if (k === 'levelOf') return () => 'member';
      if (k === 'levelName') return () => '成员';
      if (k === 'isOwner') return () => false;
      return () => Promise.resolve({});
    },
  });
  const fresh = (await import(`${pathToFileURL(P).href}?race=${Date.now()}`)).default;
  await fresh.setup.call(fresh, ctx2);

  for (let i = 0; i < 3; i++) await handlers2.message(msg({ content: `第 ${i} 句` }));
  /** 再喂一条机器人消息：它的 `bots` 列是这次新增的，旧存档里必然没有 */
  await handlers2.message(msg({ isBot: true }));
  const mid = fresh.dashboard();
  ok('恢复挂起期间计数正常', val(mid, '看到消息') === 4, `seen=${val(mid, '看到消息')}`);
  ok('窗口内的新列有值', val(mid, '机器人消息') === 1, `bots=${val(mid, '机器人消息')}`);

  /** 故意不给 `bots` / `failed` 等新列：真实升级时旧存档就是这样 */
  resolveGet({ seen: 100, forwarded: 50, ruleBlocked: 50, reasons: { '旧原因': 9 }, since: Date.now() - 86400000 });
  /** .then(...).catch(...) 要排空微任务队列 */
  await new Promise((r) => setImmediate(r));
  const d = fresh.dashboard();
  ok('恢复不抹掉窗口内增量（seen 累加而非覆盖）', val(d, '看到消息') === 104, `seen=${val(d, '看到消息')}`);
  ok('规则挡掉也累加', val(d, '规则挡掉') === 53, `ruleBlocked=${val(d, '规则挡掉')}`);
  ok('旧存档缺的新列不翻倍', val(d, '机器人消息') === 1, `bots=${val(d, '机器人消息')}（翻倍会是 2）`);
  ok('缺键场景分母仍自洽', val(d, '未归类') === 0, `未归类=${val(d, '未归类')}`);
  ok('窗口内的拒绝原因没被顶掉', /只在被 @ 时回复/.test(d.note) && /旧原因/.test(d.note), d.note.split('\n').slice(-2).join(' | '));
}

console.log(`\n${pass}/${pass + fails.length} 通过${fails.length ? `，失败：${fails.join('、')}` : ''}`);
if (fails.length) process.exit(1);

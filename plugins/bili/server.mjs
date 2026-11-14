#!/usr/bin/env node
/**
 * bili —— 刷 B 站（标准 MCP server，stdio，零依赖）
 * ================================================
 *
 * 协议只有四件事：`initialize` / `tools/list` / `tools/call` / `ping`。
 * 其它一律标准错误。**日志全部走 stderr**：stdout 是 JSON-RPC 通道，
 * 往里打一行中文就会把整条连接搞坏（这是 MCP server 最常见的翻车点）。
 *
 * 手动联调（不经宿主）：
 *   node server.mjs --call hot '{"limit":3}'
 *   node server.mjs --call video '{"link":"BV1xx"}'
 *   node server.mjs --call feed '{}'
 *   node server.mjs --call card '{"link":"BV1xx"}'
 *   node server.mjs --call shot '{"link":"BV1xx","at":30}'
 *   node server.mjs --list
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { BiliError, createBiliApi } from './lib/api.mjs';
import { createToolbox } from './lib/tools.mjs';
import { createUiData } from './lib/ui-data.mjs';
import { readConfig } from './lib/config.mjs';
import { createFeed, createHostState } from './lib/feed.mjs';
import { createShots } from './lib/shots.mjs';
import { createProactiveClient } from './lib/proactive.mjs';
import { createWriteApi } from './lib/write.mjs';
import { createPush } from './lib/push.mjs';
import { createUiActions } from './lib/ui-actions.mjs';
import { resolveFfmpeg, ffmpegState, sharedDepsDir } from './lib/ffmpeg.mjs';
import { createQrLogin } from './lib/qr-login.mjs';
import { createLiveConfig } from './lib/live-config.mjs';
import { createAutoShot } from './lib/auto-shot.mjs';
import { bumpStats, readStats } from './lib/stats.mjs';
import { countShots } from './lib/gallery.mjs';

const SERVER = { name: 'bili', version: '0.9.0' };
const log = (m) => process.stderr.write(`[bili] ${m}\n`);
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

/**
 * 可调设置：宿主把面板里保存的**非敏感**值拼成 JSON 放在 `ROOST_EXT_CONFIG`。
 * 解析失败按空配置继续 —— 配置坏了不该让扩展起不来。
 */
/**
 * 0.3：配置收在 `lib/config.mjs`（纯函数，测试直接喂假 env）。
 * 标了 `secret` 的 Cookie 走 `ROOST_EXT_SECRET_COOKIE`，不在这个 JSON 里。
 */
const cfg = readConfig(process.env);

/**
 * 扩展自己的目录。用 `fileURLToPath` 而不是 `URL.pathname`：
 * 后者在 Windows 上给 `/C:/...`，而且中文路径会被百分号编码。
 */
const HERE = fileURLToPath(new URL('.', import.meta.url));

/** 面板数据（6.1 声明式界面）：宿主只读这个 JSON，不执行这里的任何代码。 */
const ui = createUiData({ dir: HERE, log });

/** 登录态：面板 secret 优先，兼容 0.2 的 cookie.txt（见 api.mjs 的 cookieText）。 */
const api = createBiliApi({ log, getCookie: () => cfg.cookie });

/**
 * 0.4 定时刷：除了预热缓存和面板，还按开关投素材 / 抽帧 / 跑写动作。
 * `onFresh` 引用 `box` 和 `push`，两者又都要拿 `feed`/`shots` ——
 * 用 `let` 解掉这个环，回调在定时器起来之后才会被调用。
 */
let box = null;
let push = null;

/** 素材通道与写动作都由宿主/配置注入，手动 `--call` 时缺令牌是正常状态 */
const submit = createProactiveClient(process.env);
const write = createWriteApi({
  getCookie: () => cfg.cookie,
  dryRunOf: () => cfg.writeDryRun !== false,
  log,
});

/**
 * 配置热读：面板保存设置后，宿主写的是它自己那两个文件，**不会**重启我们
 * （受管块里的静态条目不受 `mcpManager.restart()` 治理）。所以每次动作 /
 * 每一轮定时刷之前，直接从磁盘把最新值读回来覆盖 `cfg`。
 *
 * `cfg` 是 const 对象，靠 `Object.assign` 原地改——所有 `() => cfg.xxx`
 * 的闭包（getCookie、dryRunOf 等）因此立刻看到新值，不用重建 api。
 */
let feed = null;
const refreshConfig = createLiveConfig({
  dataDir: process.env.ROOST_LAUNCHER_DIR,
  id: process.env.ROOST_EXT_ID,
  apply(values, secrets) {
    const env = { ...process.env };
    if (values) env.ROOST_EXT_CONFIG = JSON.stringify(values);
    Object.assign(cfg, readConfig(env));
    /**
     * 磁盘上的 secret 是用户最后保存的那份：面板里清空 Cookie 也要能生效，
     * 所以「有这个键」就覆盖（包括空串），不能写成 `if (secrets.cookie)`。
     */
    if (secrets && Object.prototype.hasOwnProperty.call(secrets, 'cookie')) {
      cfg.cookie = String(secrets.cookie || '');
    }
    /** 刷的频率 / 总开关改了，定时器要跟着改，否则等于没生效 */
    try { feed?.syncTimer(); } catch { /* 定时器重排失败不影响当前动作 */ }
  },
});

feed = createFeed({
  cfg,
  api,
  hostState: createHostState(process.env),
  beforeTick: async () => { refreshConfig(); },
  onFresh: (items) => {
    box?.setPool(items);
    ui.fromPool(items);
    /** 定时刷也算「今天刷了一轮」；面板上的数字靠它 */
    bumpStats(ui, { rounds: 1 });
    syncMeta();
    /** 抽帧慢（每个要一次 view + 一次 ffmpeg），不能阻塞这一轮的收尾 */
    setTimeout(() => { void autoShotTask(items); }, 0);
    /** 推送失败不该让「这一轮刷成功了」变红，单独吞掉并记进 push.state() */
    if (push) void push.onFresh(items, '定时').catch((e) => log(`推送这一轮失败：${e?.message ?? e}`));
  },
  log,
});

const shots = createShots({
  dir: cfg.shotDir, keep: cfg.shotKeep, width: cfg.shotWidth, here: HERE,
  /**
   * 传函数而不是值：ffmpeg 装在宿主共享目录，用户在面板点「装 ffmpeg」之后
   * 扩展进程不会重启；算死的值会让「装好了还报没装」，只能靠重启才好。
   */
  ffmpegPath: () => resolveFfmpeg({ root: HERE, configured: cfg.ffmpegPath }), api, log,
});

push = createPush({ cfg, api, shots, submit, write, log });
box = createToolbox({ api, log, config: cfg, feed, shots, push });

/** 扫码登录：headless 浏览器出码，拿到 cookie 就写 cookie.txt */
/** `depsDir` 里如果有 `qrcode` 就用它生成二维码，没有则退回内置编码器 */
const qr = createQrLogin({ root: HERE, log, depsDir: sharedDepsDir() });

function stopQrTimer() {
  if (qrTimer) clearInterval(qrTimer);
  qrTimer = null;
}

async function qrTick() {
  try {
    const r = await qr.poll();
    lastQr = { state: r.state, message: String(r.message || ''), at: Date.now() };
    syncMeta();
    if (r.state !== 'waiting') stopQrTimer();
  } catch (e) {
    log('扫码轮询失败：' + (e?.message ?? e));
  }
}

/* ------------------------------------------------------------------ */
/* 面板运行状态（0.5.1）                                              */
/* ------------------------------------------------------------------ */

/** 最近一次「检查登录」/「发弹幕」的结果，面板下次刷新就能看到 */
let lastAccount = null;
let lastQr = null;
let qrTimer = null;
let lastDanmaku = null;

/** 从链接或 BV 号里抠出 BV 号（面板只让填一行，不逼用户分开填） */
const bvOf = (s) => {
  const m = String(s || '').match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : '';
};

function metaOf() {
  const fs = feed.state();
  const ps = push.state();
  return {
    account: lastAccount
      ? { isLogin: Boolean(lastAccount.isLogin), uname: String(lastAccount.uname || '') }
      : null,
    feed: {
      enabled: Boolean(fs.enabled),
      minutes: Number(fs.minutes) || 0,
      lastAt: Number(fs.at) || 0,
      count: Number(fs.count) || 0,
      reason: String(fs.reason || ''),
      error: String(fs.error || ''),
      activeHours: String(fs.activeHours || ''),
    },
    push: {
      pushed: Number(ps.today?.pushed) || 0,
      pushLimit: Number(ps.today?.pushLimit) || 0,
      writes: Number(ps.today?.writes) || 0,
      writeLimit: Number(ps.today?.writeLimit) || 0,
      channel: Boolean(ps.channel),
      last: ps.last
        ? { at: Number(ps.last.at) || 0, picked: Number(ps.last.picked) || 0, delivered: Number(ps.last.delivered) || 0, reason: String(ps.last.reason || '') }
        : null,
    },
    write: { paused: String(write.state()?.paused || '') },
    /** 今日计数（刷了几轮 / 截了几张 / 评论几条），跨天由 readStats 自动清零 */
    stats: readStats(ui.file()),
    gallery: { count: countShots({ dir: shots.dir }), limit: Number(cfg.shotKeep) || 60 },
    qr: lastQr,
    /**
     * ffmpeg 装在**宿主**的共享目录（`<数据目录>/deps`），不是扩展目录：
     * 扩展只负责找到它、报状态，安装由面板的「装 ffmpeg」走宿主 op。
     */
    ffmpeg: ffmpegState({ root: HERE, configured: cfg.ffmpegPath }),
    danmaku: lastDanmaku,
  };
}

/** 自动抽帧（开关在 `cfg.autoShot`，默认关）：定时刷也走同一条路 */
const autoShotTask = createAutoShot({ api, shots, ui, config: cfg, log });

/** 状态写盘失败不影响任何功能，面板少一块信息而已 */
function syncMeta() {
  try { ui.setMeta(metaOf()); } catch (e) { log(`面板状态写盘失败：${e?.message ?? e}`); }
}

/**
 * 面板按钮的动作处理（0.5）。
 *
 * 宿主只把动作名排队，这里取走执行；动作名与 `plugin.json` 的 `ui.actions`
 * 一一对应。取动作是读即消费 —— 失败一次不重放（「现在刷一轮」重试三次
 * 就是连刷三轮）。
 */
const uiActions = createUiActions({
  env: process.env,
  log,
  handlers: {
    async refresh_hot() {
      await box.call('hot', { limit: 8 });
      const pool = box.hotPool();
      ui.fromPool(pool);
      feed.seed(pool, '手动刷新');
    },
    async feed_now() {
      const r = await feed.tick('手动');
      if (!r?.ok) log(`手动刷一轮没有完成：${r?.why ?? '未知原因'}`);
    },
    async check_login() {
      lastAccount = await api.account();
      log(lastAccount?.isLogin ? `登录态正常：${lastAccount.uname}` : '没有登录（只能看，不能评论）');
      syncMeta();
    },
    /**
     * 弹幕：先查一遍视频（拿 cid / 时长），不发送。
     * 面板上「检查视频」按钮走这里，结果写进 state 供页面回显。
     */
    async danmaku_inspect(payload) {
      const bvid = bvOf(payload?.bvid || payload?.link);
      if (!bvid) throw new Error('没认出 BV 号（支持 BV 号或 B 站链接）');
      const v = await api.view({ bvid });
      lastDanmaku = {
        bvid: v.bvid, title: v.title, cid: v.cid, duration: v.duration,
        at: Date.now(), ok: null, dryRun: false, message: `《${v.title}》· ${v.duration} 秒`,
      };
      syncMeta();
    },
    /** 扫码登录：起 headless 浏览器出码，之后每 2 秒查一次 cookie */
    async qr_start() {
      const r = await qr.start();
      lastQr = { state: r.state, message: String(r.message || ''), at: Date.now() };
      syncMeta();
      if (!r.ok) throw new Error(r.message || '出码失败');
      stopQrTimer();
      qrTimer = setInterval(() => { void qrTick(); }, 2000);
      qrTimer.unref?.();
    },
    /** 关闭扫码浮层：杀掉浏览器、删掉二维码 */
    async qr_cancel() {
      qr.cancel();
      stopQrTimer();
      lastQr = { state: 'cancelled', message: '', at: Date.now() };
      syncMeta();
    },
    /** 查一次 ffmpeg 在哪（装由宿主的共享依赖面板负责，扩展不自己装） */
    async ffmpeg_state() {
      syncMeta();
      return ffmpegState({ root: HERE, configured: cfg.ffmpegPath });
    },
    /** 真发弹幕：走 write 层（默认试运行、每日上限、风控当天暂停都在那里） */
    async danmaku_send(payload) {
      const bvid = bvOf(payload?.bvid || payload?.link);
      const text = String(payload?.text || '').trim().slice(0, 100);
      if (!bvid) throw new Error('没认出 BV 号');
      if (!text) throw new Error('弹幕文字是空的');
      const v = await api.view({ bvid });
      const seconds = Math.max(0, Number(payload?.seconds) || 0);
      const r = await write.danmaku(v.cid, text, seconds * 1000);
      lastDanmaku = {
        bvid: v.bvid, title: v.title, cid: v.cid, duration: v.duration,
        text, seconds, at: Date.now(), ok: true, dryRun: Boolean(r?.dryRun),
        message: r?.dryRun ? '试运行：没有真的发出去（关掉 writeDryRun 才会发）' : '已提交到 B 站',
      };
      syncMeta();
    },
  },
});

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg ?? {};

  // 通知（没有 id）不回复。DSH 会发 notifications/initialized，别当错误回。
  if (id === undefined || id === null) {
    if (method && !String(method).startsWith('notifications/')) log(`忽略通知 ${method}`);
    return;
  }

  if (method === 'initialize') {
    return ok(id, {
      // 回客户端请求的版本：官方客户端会按自己那版握手，写死会把新客户端挡回去。
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER,
    });
  }

  if (method === 'ping') return ok(id, {});

  if (method === 'tools/list') return ok(id, { tools: box.tools });

  if (method === 'tools/call') {
    /** 模型这一下用的必须是面板上刚存的配置（Cookie、开关、额度都算） */
    refreshConfig();
    const name = String(params?.name ?? '');
    try {
      const text = await box.call(name, params?.arguments ?? {});
      /** 刚拉过热门就顺手把面板数据 / feed 缓存刷新一下：零额外请求 */
      if (name === 'hot') {
        const pool = box.hotPool();
        ui.fromPool(pool);
        feed.seed(pool, 'hot');
        syncMeta();
      }
      return ok(id, { content: [{ type: 'text', text: String(text) }] });
    } catch (e) {
      // 业务错误用 isError 而不是 JSON-RPC error：协议层没坏，是这次调用没成，
      // 模型能读到原因并自己决定怎么跟人解释。
      const message = e instanceof BiliError
        ? `${e.message}${e.hint ? `（${e.hint}）` : ''}`
        : `扩展出错了：${e?.message ?? e}`;
      log(`工具 ${name} 失败：${message}`);
      return ok(id, { content: [{ type: 'text', text: message }], isError: true });
    }
  }

  return fail(id, -32601, `没有方法 ${method}`);
}

/* ------------------------------------------------------------------ */
/* 手动调用模式                                                        */
/* ------------------------------------------------------------------ */

async function cli(argv) {
  if (argv.includes('--list')) {
    for (const t of box.tools) console.log(`${t.name}\t${t.description.slice(0, 60)}…`);
    return;
  }
  const i = argv.indexOf('--call');
  if (i < 0) {
    console.error('用法：node server.mjs [--list | --call <tool> <json>]');
    process.exitCode = 2;
    return;
  }
  const name = argv[i + 1];
  let args = {};
  try {
    args = JSON.parse(argv[i + 2] ?? '{}');
  } catch {
    console.error('参数不是合法 JSON');
    process.exitCode = 2;
    return;
  }
  try {
    const text = await box.call(name, args);
    console.log(text);
    console.error(`\n[${Buffer.byteLength(String(text), 'utf8')} 字节]`);
  } catch (e) {
    console.error(`失败：${e?.message ?? e}${e?.hint ? `（${e.hint}）` : ''}`);
    process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ */
/* stdio 主循环                                                        */
/* ------------------------------------------------------------------ */

function serve() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // 坏行忽略：真实 server 也不该因为一行垃圾就退出。
        log('收到一行不是 JSON 的输入，已忽略');
        continue;
      }
      handle(msg).catch((e) => {
        log(`处理 ${msg?.method} 出错：${e?.message ?? e}`);
        if (msg?.id !== undefined) fail(msg.id, -32603, `内部错误：${e?.message ?? e}`);
      });
    }
  });
  process.stdin.on('end', () => process.exit(0));
  // 宿主关掉管道时别抛 EPIPE 栈。
  process.stdout.on('error', () => process.exit(0));
  refreshConfig();
  if (feed.enabled) feed.start();
  /** 面板按钮的轮询：没有宿主地址/令牌时（手动 --call）自动不启动 */
  if (uiActions.start()) log('面板动作通道已接上（每 2 秒取一次）');
  log(`就绪（${box.tools.length} 个工具，定时刷${feed.enabled ? `每 ${feed.minutes} 分钟` : '关闭'}）`);

  /**
   * 启动后预热一次面板数据。
   *
   * 放在 `setTimeout` 里、并且吞掉所有错误：这一步失败了不该影响协议握手，
   * 面板那边只会显示「还没有数据文件」，点一下工具就补上了。
   *
   * 0.3：预热那一批顺手喂给 `feed`，这样定时刷的第一个周期还没到时，
   * `feed` 工具也不会空着；**不额外发请求**（这是 0.2 就定下的规矩）。
   */
  setTimeout(() => {
    box.call('hot', { limit: 8 })
      .then(() => {
        const pool = box.hotPool();
        ui.fromPool(pool);
        feed.seed(pool);
        syncMeta();
      })
      .catch((e) => log(`预热面板数据失败（不影响使用）：${e?.message ?? e}`));
  }, 1200).unref?.();
}

const argv = process.argv.slice(2);
if (argv.length) cli(argv).catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
else serve();

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
import { createWriteApi, withMention } from './lib/write.mjs';
import { createPush } from './lib/push.mjs';
import { createUiActions } from './lib/ui-actions.mjs';
import { resolveFfmpeg, ffmpegState, sharedDepsDir } from './lib/ffmpeg.mjs';
import { createQrLogin } from './lib/qr-login.mjs';
import { createLiveConfig } from './lib/live-config.mjs';
import { createExtMemory } from './lib/memory.mjs';
import { createPending } from './lib/pending.mjs';
import { createBrowseSession, materialOfVideos } from './lib/ai-duty.mjs';
import { createRepliedStore } from './lib/replied.mjs';
import { lookAt } from './lib/vision.mjs';
import { createAutoShot } from './lib/auto-shot.mjs';
import { bumpStats, readStats } from './lib/stats.mjs';
import { countShots } from './lib/gallery.mjs';

const SERVER = { name: 'bili', version: '0.11.5' };
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

/** 刷到但模型还没看过的一批：模型下次调 feed 时接手（它才是决定者） */
const pending = createPending({ dir: HERE, log });

feed = createFeed({
  cfg,
  api,
  hostState: createHostState(process.env),
  beforeTick: async () => { refreshConfig(); },
  /** 每日轮数上限用：`stats.rounds` 由 onFresh 里的 bumpStats 累加 */
  runsToday: () => readStats(ui.file()).rounds,
  onFresh: (items) => {
    box?.setPool(items);
    ui.fromPool(items);
    /** 定时刷也算「今天刷了一轮」；面板上的数字靠它 */
    bumpStats(ui, { rounds: 1 });
    /**
     * 记进待处理队列：定时刷的时候没有模型在场，只能先存着。
     * 模型下次调 `feed` 工具时会看到「有 N 条还没看过」，自己决定做什么。
     */
    pending.add(items);
    /** 开了「让她自己看」就走独立会话；关着就留在待处理队列 */
    setTimeout(() => { void aiDecideTask(items); }, 0);
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

/** 宿主记忆：推成功记一笔，下次别推同一条（写不进去不影响推送） */
const memory = createExtMemory(process.env);
push = createPush({ cfg, api, shots, submit, write, memory, log });
/** `write` 直通给模型：它在对话里写的评论/点赞不该再套模板 */
box = createToolbox({ api, log, config: cfg, feed, shots, push, write, pending });

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

/**
 * 让她自己看这轮刷到的（`cfg.aiDecide`，默认关）。
 *
 * 开一个独立会话，把材料投进去，拿回她的决定（感受 / 评论 / 分享 / 记忆），
 * 这里照着执行。执行边界都在这一侧：试运行、每日额度、风控暂停全由
 * `write` / `submit` 把关，她只能"表达意图"。
 *
 * 每轮一次模型调用，所以默认关；关着的时候结果会进 `pending` 队列，
 * 等她下次调 `feed` 工具时接手。
 */
/** 「已经回过的评论」：每轮都会看到同一批「有人回了你」，不记下来会回十遍 */
const replied = createRepliedStore({ dir: HERE, log });

const aiDuty = createBrowseSession(process.env, { log });
let aiBusy = false;

async function aiDecideTask(items) {
  if (!cfg.aiDecide) return;
  if (aiBusy) return;
  if (!Array.isArray(items) || !items.length) return;
  aiBusy = true;
  try {
    /**
     * 有人回了她吗？
     *
     * 取最近的一批，**过滤掉她已经回过的**（`replied`）——B 站会把同一条回复
     * 一直留在消息列表里，不去重就是每轮回一遍同一句话。
     */
    let replies = [];
    try {
      const list = await api.replyFeed({ limit: 15 });
      replies = list.filter((x) => x.id && x.root && !replied.has(x.id));
    } catch (e) {
      log(`查「有人回了她」失败（不影响这一轮）：${e?.message ?? e}`);
    }

    /**
     * 看画面（`vision`）：只对本轮前两条抽帧 + 让模型描述，描述并进材料。
     *
     * 只做两条是因为每条要抽 3~6 帧、再跑一次模型——一轮做十条会让「刷一轮」
     * 从几秒变成几分钟。抽帧写进图库，面板「截图库」也能看到。
     */
    const descriptions = new Map();
    if (cfg.vision) {
      for (const v of items.slice(0, 2)) {
        const bvid = String(v?.bvid ?? '');
        if (!bvid) continue;
        try {
          const info = await api.view({ bvid });
          const d = await lookAt({ v, info, shots, cfg, env: process.env, log });
          if (d) descriptions.set(bvid, d);
        } catch (e) {
          log(`看画面失败 ${bvid}（不影响这一轮）：${e?.message ?? e}`);
        }
      }
      if (descriptions.size) log(`看画面：${descriptions.size} 条有了画面描述`);
    }

    const r = await aiDuty.decide(materialOfVideos(items, { descriptions }), { replies });
    if (!r.ok) {
      log(`她这轮没看成：${r.why}`);
      /** 没看成也把材料留在待处理队列里，别丢 */
      pending.add(items);
      return;
    }
    /** 视频可以一条都不评论，但「有人回了她」仍然要处理，所以不能在这里直接 return */
    if (!r.items.length && !(r.replies || []).length) {
      log('她这轮看完，什么都没想做');
      return;
    }

    const byBvid = new Map(items.map((v) => [String(v?.bvid ?? ''), v]));
    const feelings = [];
    for (const d of r.items) {
      const v = byBvid.get(d.bvid);
      if (!v) continue;
      if (d.feeling) feelings.push({ bvid: d.bvid, title: String(v.title ?? ''), text: d.feeling, at: Date.now() });

      /**
       * 评论和弹幕：**话是她自己写的**，这里只负责发。
       *
       * 两个开关各管一条出口：`autoComment` / `autoDanmaku` 关着就不发——
       * 她可以想，但主人没允许这条出口。一次 `view` 同时拿 aid 和 cid，
       * 别为了评论、弹幕各查一遍热门接口。
       */
      if (d.comment || d.danmaku) {
        let info = null;
        try {
          info = await api.view({ bvid: d.bvid });
        } catch (e) {
          log(`她想对 ${d.bvid} 说话但拿不到视频信息：${e?.message ?? e}`);
        }
        const aid = Number(info?.aid) || 0;
        const cid = Number(info?.cid) || 0;
        const dur = Math.max(1, Math.floor(Number(info?.duration) || 0));

        if (d.comment && cfg.autoComment && aid) {
          try {
            const w = await write.comment(aid, withMention(d.comment, cfg.ownerName));
            if (w?.ok && !w.dryRun) bumpStats(ui, { comments: 1 });
          } catch (e) {
            log(`她想评论 ${d.bvid} 但没发出去：${e?.message ?? e}`);
          }
        }
        if (d.danmaku && cfg.autoDanmaku && cid) {
          try {
            /** 1/3 处：开头常有片头，结尾可能没画面 */
            const at = Math.max(1, Math.floor(dur / 3));
            const w = await write.danmaku(cid, d.danmaku, at * 1000);
            if (w?.ok && !w.dryRun) bumpStats(ui, { danmaku: 1 });
          } catch (e) {
            log(`她想发弹幕 ${d.bvid} 但没发出去：${e?.message ?? e}`);
          }
        }
      }
      /** 分享：她写的那句直接当素材投，宿主会让主人看到 */
      if (d.share) {
        try {
          await submit.submit({ cause: '她刷 B 站看到的', key: `${d.bvid}|owner`, text: d.share, target: 'owner' });
          bumpStats(ui, { shares: 1 });
        } catch (e) {
          log(`她想分享 ${d.bvid} 但没投出去：${e?.message ?? e}`);
        }
      }
      if (d.remember && memory?.available) {
        await memory.remember(d.remember);
      }
    }
    /**
     * 回别人回她的评论。
     *
     * 只认**材料里给过的那几条 id**：模型有时会编 id，拿它对不上就直接跳过——
     * 否则可能回到别的视频、别的楼层去。楼层信息（oid/root/parent）也全用
     * 扩展这边查到的，绝不采信模型。
     */
    let replyN = 0;
    for (const rep of r.replies || []) {
      if (!cfg.autoComment) break;
      const src = replies.find((x) => String(x.id) === String(rep.id));
      if (!src) continue;
      try {
        const w = await write.comment(Number(src.oid) || 0, withMention(rep.text, cfg.ownerName), {
          root: Number(src.root) || 0,
          parent: Number(src.parent) || 0,
        });
        if (w?.ok) {
          replied.add(src.id);
          replyN += 1;
          if (!w.dryRun) bumpStats(ui, { replies: 1 });
        }
      } catch (e) {
        log(`她想回 ${src.id} 但没发出去：${e?.message ?? e}`);
      }
    }

    if (feelings.length) ui.setMeta({ ai: { lastAt: Date.now(), count: feelings.length, top: feelings[0].text, title: feelings[0].title } });
    log(`她看完了这一轮：${feelings.length} 句感受，${r.items.filter((x) => x.comment).length} 条评论，`
      + `${r.items.filter((x) => x.danmaku).length} 条弹幕，${replyN} 条回复，${r.items.filter((x) => x.share).length} 条分享`);
  } catch (e) {
    log(`她自己刷 B 站失败（不影响这一轮）：${e?.message ?? e}`);
  } finally {
    aiBusy = false;
  }
}

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

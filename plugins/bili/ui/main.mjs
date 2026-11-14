/**
 * 进程内动作（`ui.runtime: "inprocess"`）
 * ============================================================
 *
 * 这个文件由**宿主进程** import，不是 MCP server 的一部分。宿主调它的
 * `createActions()`，拿到一组函数直接绑到面板按钮上——点一下就是一次
 * 普通函数调用，没有队列、没有轮询、返回值立刻回到页面。
 *
 * **面板上的每个按钮都在这里实现**。之前只放了三个「一次调用就能完成」
 * 的动作，其余的（刷一轮、发弹幕、扫码）留在 MCP 侧走队列——表现就是
 * 点了显示「已提交，等扩展处理」，要等子进程来取，慢且看起来像没反应。
 *
 * 两个容易踩的点：
 *
 *   1. **`config` / `secrets` 是活引用**，不是快照。宿主每次点击前会原地
 *      更新它们（见 `ext-inprocess.js` 的 `ctxOf`）。所以这里读配置要写
 *      `config.xxx`，**不要**在 `createActions()` 里把值抠出来存成局部变量
 *      —— 那样面板上改了设置，按钮用的还是旧值。
 *   2. **状态写盘用 `setMeta()` 合并**。MCP 子进程也在写同一份
 *      `ui-data.json`（定时刷、推送额度），直接覆盖会把对方字段抹掉。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBiliApi } from '../lib/api.mjs';
import { createUiData } from '../lib/ui-data.mjs';
import { createFeed } from '../lib/feed.mjs';
import { createWriteApi } from '../lib/write.mjs';
import { createQrLogin } from '../lib/qr-login.mjs';
import { createShots } from '../lib/shots.mjs';
import { bumpStats, readStats } from '../lib/stats.mjs';
import { countShots } from '../lib/gallery.mjs';
import { createAutoShot } from '../lib/auto-shot.mjs';
import { createPending } from '../lib/pending.mjs';
import { createProactiveClient } from '../lib/proactive.mjs';
import { createRoostLink } from '../lib/roost-link.mjs';
import { cardOf } from '../lib/card.mjs';
import { ffmpegState, resolveFfmpeg, sharedDepsDir } from '../lib/ffmpeg.mjs';
import { createSelfBrowse } from '../lib/self-browse.mjs';
import { createHistory } from '../lib/history.mjs';
import { createRepliedStore } from '../lib/replied.mjs';
import { createExtMemory } from '../lib/memory.mjs';

/** `ui/main.mjs` 的上一级就是扩展根目录（ui/ 的父目录） */
const HERE = fileURLToPath(new URL('..', import.meta.url));

/** 从链接或 BV 号里抠出 BV 号（面板只让填一行，不逼用户分开填） */
const bvOf = (s) => {
  const m = String(s || '').match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : '';
};

/**
 * @param {{ config?: object, secrets?: object, log?: Function, id?: string }} ctx
 * @returns {Record<string, (payload?: object) => Promise<{ok:boolean,message:string,data?:any}>>}
 */
export function createActions({ config = {}, secrets = {}, env = {}, log = () => {} } = {}) {
  /**
   * Cookie 有两个来源：
   *   · 面板「B 站 Cookie」存的 secret（宿主在这里把明文递进来了）；
   *   · 扫码写的 `cookie.txt`。
   * 谁新用谁——用户手动粘完发现没生效、又去扫码，这两种情况都得对。
   */
  const cookieFromFile = () => {
    try {
      return readFileSync(join(HERE, 'cookie.txt'), 'utf8').split(/\r?\n/)[0].trim();
    } catch {
      return '';
    }
  };
  const getCookie = () => {
    const fromPanel = String(secrets?.cookie || '').trim();
    return fromPanel || cookieFromFile();
  };

  const api = createBiliApi({ log, getCookie });
  const ui = createUiData({ dir: HERE, log });

  /**
   * 进度状态顺手写进面板数据。
   *
   * 只写自己这几个字段：`feed` / `push` / `write` 归 MCP 子进程，
   * 这边乱写会把它们覆盖掉（`setMeta` 是合并，所以只传自己那份就够）。
   */
  const setMeta = (patch) => ui.setMeta(patch);

  /**
   * 刷一轮：`hostState` 直接给「在线」。
   *
   * 这个检查本来是防「宿主挂了还去刷」；我们现在**就在宿主进程里**，
   * 再发一次本机请求去问「宿主在不在」是纯浪费。
   */
  const feed = createFeed({
    cfg: config,
    api,
    hostState: async () => ({ ok: true }),
    /** 每日轮数上限用；`config` 是活引用，改了上限立刻按新值判断 */
    runsToday: () => readStats(ui.file()).rounds,
    onFresh: (items) => {
      ui.fromPool(items);
      setMeta({ feed: feedPatch('手动') });
    },
    log,
  });

  /**
   * 只写「这一轮刷的结果」，**不写 `enabled` / `minutes`**。
   *
   * 那两个是定时器的性质，归 MCP 子进程；这里写会被覆盖成进程内的快照
   * （进程内这个 feed 实例根本没启动定时器，永远是「关着」），
   * 表现为点一次「现在刷一轮」，「定时刷」那格就闪成关。
   */
  function feedPatch(fallbackReason = '') {
    const s = feed.state();
    return {
      lastAt: Number(s.at) || 0,
      count: Number(s.count) || 0,
      reason: String(s.reason || fallbackReason),
      error: String(s.error || ''),
    };
  }

  /** 写动作层：`dryRunOf` 现读配置，改了开关立刻生效 */
  const write = createWriteApi({
    getCookie,
    dryRunOf: () => config.writeDryRun !== false,
    log,
  });

  /**
   * 抽帧。默认落 `<扩展>/shots/`，面板才能通过 `/ext-pages` 取到缩略图。
   * `ffmpegPath` 传函数：装完 ffmpeg 不用重启扩展就能抽。
   */
  const shots = createShots({
    dir: '', keep: Number(config.shotKeep) || 60, width: 512,
    here: HERE,
    ffmpegPath: () => resolveFfmpeg({ root: HERE, configured: config.ffmpegPath, depsDir: env.ROOST_DEPS_DIR }),
    api, log,
  });

  /** 刷到但模型还没看过的一批（进程内刷也记一份，模型下次调 feed 接手） */
  const pending = createPending({ dir: HERE, log });

  /** 主动素材通道：定时刷的自动推送还走它（由模型决定要不要说） */
  const proactive = createProactiveClient(env || process.env, {});

  /** 直连协议转发：面板「测试分享」用它直接发卡片，不跑模型 */
  const roostLink = createRoostLink(env || process.env, {});

  /** 「ta 刷过什么」的账本：和 MCP 子进程共用同一个文件、同一套合并规则 */
  const history = createHistory({ dir: HERE, log });

  /** 「已经回过的评论」：面板手动查回复时也要用它，别把回过的又列出来 */
  const replied = createRepliedStore({ dir: HERE, log });

  /** 宿主记忆：她看到的「主人的口味」写这里，两个进程共用一套 */
  const memory = createExtMemory(env || process.env, {});

  /**
   * 她自己看这一轮 —— **和定时刷同一个实现**。
   *
   * 宿主会在每次点击前把 `/v1` 的地址与令牌原地塞进 `env`
   * （见 `host.js` 的 `inprocessApiEnv`），所以这里能建独立会话。
   * 拿不到令牌时 `available` 是 false，`run()` 会明确回一句
   * 「没有 API 令牌」，不会静默变成「没反应」。
   */
  const selfBrowse = createSelfBrowse({
    api, shots, cfg: config, write, submit: proactive, memory, replied, history, pending,
    bump: (patch) => bumpStats(ui, patch),
    setMeta: (patch) => setMeta(patch),
    env: env || process.env,
    log,
  });

  /** 图库计数写进 meta，面板标题上的「n / 上限」用它 */
  function syncGalleryMeta() {
    setMeta({ gallery: { count: countShots({ dir: shots.dir }), limit: Number(config.shotKeep) || 60 } });
  }

  /**
   * 刷完一轮顺手抽几帧（面板「截图库」的数据来源）。
   * 逻辑在 `lib/auto-shot.mjs`：MCP 子进程的定时刷也要用它，两边必须同一套。
   */
  const autoShot = createAutoShot({ api, shots, ui, config, log });

  /**
   * 谁回了 ta（B 站「收到的回复」）。
   *
   * 结果写 `replies.json`：回复列表是数组，而宿主透传的 `meta` 只认一层
   * 标量——塞进去会被 `String()` 成 "[object Object]"。页面单独取这个文件。
   */
  const repliesFile = () => join(HERE, 'replies.json');

  function writeReplies(next) {
    try {
      const tmp = `${repliesFile()}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 0)}\n`, 'utf8');
      renameSync(tmp, repliesFile());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 扫码登录。
   *
   * 懒建：`createActions()` 只在文件变动时执行一次，但用户可能从没点过扫码，
   * 没必要在第一次打开面板时就准备一个浏览器工厂。
   */
  let qr = null;
  let qrTimer = null;
  const stopQrTimer = () => {
    if (qrTimer) clearInterval(qrTimer);
    qrTimer = null;
  };
  const qrState = (state, message = '') => ({ state, message: String(message || ''), at: Date.now() });

  return {
    async refresh_hot() {
      const items = await api.hot({ ps: Number(config.hotPoolSize) || 20 });
      const list = Array.isArray(items) ? items : [];
      if (!list.length) return { ok: false, message: '热门池是空的，稍后再试' };
      ui.fromPool(list);
      /** 首屏就要显示「截图库 n / 上限」，不等到一次刷一轮 */
      syncGalleryMeta();
      return { ok: true, message: `已刷新 ${list.length} 条`, data: { count: list.length } };
    },

    async check_login() {
      const a = await api.account();
      const logged = Boolean(a?.isLogin);
      const account = { isLogin: logged, uname: String(a?.uname || '') };
      setMeta({ account });
      return {
        ok: true,
        message: logged ? `已登录：${a.uname}` : '没登录（只能看，不能评论）',
        data: account,
      };
    },

    /** 刷一轮：走 feed 的 tick，和定时刷同一套逻辑（风控退避、活跃时段都在里面） */
    async feed_now() {
      const r = await feed.tick('手动');
      const patch = feedPatch('手动');
      setMeta({ feed: patch });
      if (!r?.ok) return { ok: false, message: String(r?.why || '这一轮没刷成'), data: patch };

      bumpStats(ui, { rounds: 1 });
      pending.add(feed.items());
      /** 「顺手截几张」= 0 就是不截（它会让「刷一轮」多等几秒） */
      const shotWant = Math.max(0, Math.min(10, Number(config.autoShotCount) || 0));
      const shotN = shotWant ? await autoShot(feed.items()) : 0;
      if (!shotWant) syncGalleryMeta();

      /**
       * **让她自己看这一轮**。
       *
       * 这是「ta 刷过什么」有没有内容的分界：只拉数据的话，面板上只有一行
       * 「刷到 N 条」，看不见她看了什么、想了什么。定时刷那边一直是这么做的
       * （`server.mjs` 的 onFresh），手动刷以前没做，所以两个入口行为不一致。
       *
       * **`force: true`**：用户明确点了这个按钮，就一定要开独立会话让她看，
       * 不受「让她自己看这一轮」开关影响（那个开关只管后台定时刷）。
       * 之前少了它，开关默认关 → 点一百次都只拉数据 → 面板上「没反应、
       * 没开刷 B 站会话」。对齐 aurabot 的 `bili.run({ force: true })`。
       *
       * 会等模型（最长 90 秒），前端按钮期间显示「她正在看…」。
       */
      const ai = await selfBrowse.run(feed.items(), { force: true });

      const bits = [`刷到 ${r.count} 条`];
      if (shotN) bits.push(`顺手截了 ${shotN} 张`);
      if (ai.ok) bits.push(ai.watched ? `她看了 ${ai.watched} 条` : '她看完没想说什么');
      else bits.push(`她自己看那步没成：${String(ai.why || '未知原因').slice(0, 60)}`);
      return {
        ok: true,
        message: bits.join('，'),
        data: { ...patch, shots: shotN, watched: Number(ai.watched) || 0 },
      };
    },

    /**
     * 「看看有没有人回 ta」。
     *
     * 之前在面板上声明了按钮却没声明动作，宿主直接回 400「没有声明动作」，
     * 点了**一点反应都没有**——这就是那批「点了没反应」的按钮之一。
     *
     * 只读：拉 B 站「收到的回复」，落一份 `replies.json` 给面板渲染。
     * 不写 `replied` 记录（那表示「已经回过」，查一遍不等于回过）。
     */
    async check_replies() {
      if (!getCookie()) {
        return { ok: false, message: '还没登录 B 站：先扫码或者粘 Cookie，否则查不到回复' };
      }
      const list = await api.replyFeed({ limit: 20 });
      const items = Array.isArray(list) ? list : [];
      const fresh = items.filter((x) => x.id && !replied.has(x.id));
      writeReplies({ seen: items.map((x) => x.id), items, at: Date.now() });
      setMeta({ replies: { at: Date.now(), unread: fresh.length, total: items.length } });
      return {
        ok: true,
        message: items.length
          ? `查到 ${items.length} 条回复${fresh.length ? `，其中 ${fresh.length} 条还没回` : '（都回过了）'}`
          : '还没有人回 ta',
        data: { total: items.length, unread: fresh.length },
      };
    },

    /**
     * 弹幕：先查一遍视频（拿 cid / 时长），不发送。
     * 面板上「检查视频」按钮走这里，结果写进 meta 供页面回显。
     */
    async danmaku_inspect(payload) {
      const bvid = bvOf(payload?.bvid || payload?.link);
      if (!bvid) return { ok: false, message: '没认出 BV 号（支持 BV 号或 B 站链接）' };
      const v = await api.view({ bvid });
      const dm = {
        bvid: v.bvid, title: v.title, cid: v.cid, duration: v.duration,
        at: Date.now(), ok: null, dryRun: false, message: `《${v.title}》· ${v.duration} 秒`,
      };
      setMeta({ danmaku: dm });
      return { ok: true, message: dm.message, data: dm };
    },

    /** 真发弹幕：走 write 层（默认试运行、每日上限、风控当天暂停都在那里） */
    async danmaku_send(payload) {
      const bvid = bvOf(payload?.bvid || payload?.link);
      const text = String(payload?.text || '').trim().slice(0, 100);
      if (!bvid) return { ok: false, message: '没认出 BV 号' };
      if (!text) return { ok: false, message: '弹幕文字是空的' };
      const v = await api.view({ bvid });
      const seconds = Math.max(0, Number(payload?.seconds) || 0);
      const r = await write.danmaku(v.cid, text, seconds * 1000);
      const dm = {
        bvid: v.bvid, title: v.title, cid: v.cid, duration: v.duration,
        text, seconds, at: Date.now(), ok: true, dryRun: Boolean(r?.dryRun),
        message: r?.dryRun ? '试运行：没有真的发出去（关掉 writeDryRun 才会发）' : '已提交到 B 站',
      };
      setMeta({ danmaku: dm });
      return { ok: true, message: dm.message, data: dm };
    },

    /** 扫码登录：起 headless 浏览器出码，之后每 2 秒查一次 cookie */
    async qr_start() {
      qr = qr || createQrLogin({ root: HERE, log, depsDir: sharedDepsDir(env.ROOST_DEPS_DIR) });
      const r = await qr.start();
      setMeta({ qr: qrState(r.state, r.message) });
      if (!r.ok) return { ok: false, message: String(r.message || '出码失败') };
      stopQrTimer();
      qrTimer = setInterval(() => {
        void (async () => {
          try {
            const p = await qr.poll();
            setMeta({ qr: qrState(p.state, p.message) });
            if (p.state !== 'waiting') stopQrTimer();
          } catch (e) {
            log(`扫码轮询失败：${e?.message ?? e}`);
          }
        })();
      }, 2000);
      /** 不因为这个定时器把宿主的事件循环钉住 */
      qrTimer.unref?.();
      return { ok: true, message: '二维码已生成，用手机 B 站扫一下' };
    },

    /** 关闭扫码浮层：杀掉浏览器、删掉二维码 */
    async qr_cancel() {
      qr?.cancel();
      stopQrTimer();
      setMeta({ qr: qrState('cancelled') });
      return { ok: true, message: '已取消扫码' };
    },

    /**
     * 测试分享：**自动挑最新一条，生成卡片，直接发给主人，不经过模型**。
     *
     * 以前走 `/v1/proactive/submit`（素材通道）：宿主入队后立刻开一次主动搭话
     * 模型调用让「她」写措辞，而模型当时根本没看到视频素材，结果常是
     * `<<skip>>` —— 钱花了、什么都没发出去，面板却因为「入队成功」报已发送。
     *
     * 分享一张官方卡片不需要模型写字：标题/描述/链接/封面扩展早就拼好了。
     * 现在走宿主代理的直连协议 `msg.send`（`/v1/roost.call`），`target:"owner"`
     * 由宿主解析，点一下就到主人私聊。成功判据是框架真的回了消息 id。
     */
    async test_share(payload) {
      if (!roostLink.available) {
        return { ok: false, message: '宿主没给直连协议令牌，发不了卡片（手动跑扩展时正常）' };
      }
      /** 优先用指定的 BV，其次最近一条（最新），再没有就现拉一条热门 */
      let v = null;
      const want = String(payload?.bvid || '').trim();
      const pool = feed.items() || [];
      if (want) v = pool.find((x) => x.bvid === want) || null;
      if (!v) v = pool[0] || null;
      if (!v) {
        try {
          const hot = await api.hot({ ps: 5 });
          v = Array.isArray(hot) ? hot[0] : null;
        } catch (e) {
          return { ok: false, message: '还没有刷到过视频，现拉热门也失败了：' + (e?.message ?? e) };
        }
      }
      if (!v) return { ok: false, message: '还没有视频可分享，先点「现在刷一轮」' };

      /** 卡片四个字段都用现成数据拼；没封面的视频发不了官方图文卡片 */
      let card;
      try {
        ({ card } = cardOf(v));
      } catch (e) {
        return { ok: false, message: '这张卡片拼不出来：' + (e?.message ?? e) };
      }
      const r = await roostLink.sendCard(card);
      if (!r.ok) return { ok: false, message: '没发出去：' + String(r.why || '未知原因') };

      bumpStats(ui, { shares: 1 });
      setMeta({ share: { lastAt: Date.now(), title: String(v.title || ''), bvid: String(v.bvid || ''), id: r.id } });
      return {
        ok: true,
        message: `已把《${String(v.title || v.bvid).slice(0, 24)}》直接发给主人${r.pending ? '（平台审核中）' : ''}`,
        data: { id: r.id, bvid: v.bvid, direct: true },
      };
    },

    /** 页面想知道 ffmpeg 现在有没有，不用等一次动作 */
    async ffmpeg_state() {
      /** `env.ROOST_DEPS_DIR` 由宿主传进来：它是给子进程的变量，宿主 env 里没有 */
      const s = ffmpegState({ root: HERE, configured: config.ffmpegPath, depsDir: env.ROOST_DEPS_DIR });
      setMeta({ ffmpeg: { ready: s.ready, path: s.path, dir: s.dir } });
      return { ok: true, message: s.ready ? '可用（宿主共享目录）' : '没装', data: s };
    },
  };
}

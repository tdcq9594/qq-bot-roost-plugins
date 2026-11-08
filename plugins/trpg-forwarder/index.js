// trpg-forwarder —— 跑团用的「极薄转发器」（Roost 侧）
//
// ── 它只做两件事 ──────────────────────────────────────────────────────────
//   ① 上行：把群消息原样丢给 dsh-trpg（fire & forget，立刻 200，绝不挂起）
//   ② 下行：暴露 POST /api/plugins/trpg-forwarder/r/send，让 dsh-trpg 随时直发群聊
//
// 为什么不让 dsh-trpg 自己去打腾讯接口：Roost 的 `outbound.js` 已经替我们
// 维护了「同一个 msg_id 的 msg_seq 递增（1→5）」「被动窗口过期自动降级主动」
// 「主动消息每日额度」这些坑。两个进程各管一套序号，腾讯会直接拒发。
//
// ── 和设计稿的一处偏差（有意）────────────────────────────────────────────
// 设计要求「先写 SQLite Outbox 再投递」。这里用的是 `ctx.storage`（Roost 给插件
// 的原子 JSON 存档）——同样是落盘、同样是先写后发，但不用让一个 60 行的转发器
// 背一套 SQLite schema。真到了「单群每秒几十条」的量级再换也不迟。
/**
 * 插件版本。
 *
 * `export default` 里的 `version` 必须写成**字面量**：scripts/check-versions.mjs
 * 和 scripts/build-index.mjs 都用正则读源码，引用常量读不到 → 索引写不进版本号、
 * CI 判红。升版本要同步改两处，`test/smoke.test.mjs` 会断言一致。
 */
const VERSION = '0.6.5';

const DEFAULTS = {
  enabled: true,
  dshUrl: 'http://127.0.0.1:17322',
  // 不给默认值：写死的共享密钥等于给「任何本机进程」发通行证。
  // 空值时上下行都会拒绝，面板里必须自己填一个（与 dsh-trpg 的 config.json 一致）。
  token: '',
  botId: 'main',
  timeoutMs: 3000,
  maxAttempts: 6,
  logReply: true,
};

export default {
  id: 'trpg-forwarder',
  name: '跑团转发器',
  version: '0.6.5', // 必须是字面量，与上面的 VERSION 同步
  shortDesc: '把群消息桥给本机的 dsh-trpg，再把它的骰子与剧情直发回群',
  // 市场列表只读这一行，硬要求「一句话、不超过 60 字」；多行长文会让插件市场
  // 里糊一大段说明（build-index.mjs 会原样灌进索引）。详细说明留在 README。
  description: '把群消息桥给本机 dsh-trpg，再把骰点与剧情直发回群；单独装它不会回复',
  icon: '🎲',
  frameworkVersion: '>=1.0.0',
  supportPlatforms: ['group'],
  priority: 60,

  config: {
    enabled: { type: 'boolean', default: true, desc: '总开关。关掉后不转发、也不接受下行发送' },
    dshUrl: {
      type: 'text',
      default: 'http://127.0.0.1:17322',
      label: 'dsh-trpg 地址',
      desc: 'dsh-trpg 监听的本地端口，默认 17322',
      placeholder: 'http://127.0.0.1:17322',
    },
    token: {
      type: 'string',
      default: '',
      label: '共享令牌',
      desc: '两个本地端点双向鉴权用，必须和 dsh-trpg 的 config.json 里一致。留空则上下行都拒绝（不预置弱口令）',
      placeholder: '自己定一个长随机串，两边填一样',
    },
    botId: {
      type: 'text',
      default: 'main',
      label: '机器人 id',
      desc: '多机器人时用来区分群会话属于哪只鸟',
    },
    timeoutMs: { type: 'number', default: 3000, min: 500, max: 30000, label: '投递超时（毫秒）' },
    maxAttempts: { type: 'number', default: 6, min: 1, max: 20, label: '最多重试次数' },
    logReply: { type: 'boolean', default: true, desc: 'dsh-trpg 每次直发后写一条 debug 日志' },
    probeState: {
      type: 'boolean',
      default: false,
      desc: '是否向 dsh-trpg 查询群状态（旧版 dsh-trpg 会在该端点上崩宿主，默认关闭）',
    },
  },

  setup(ctx) {
    const log = ctx.logger;

    /**
     * 恒定时间字符串比较。
     *
     * 本地回环、风险本来很低，但比较函数本身不该成为可计时侧信道；
     * 框架里已有 safeEqual 的先例（src/web/server.js），这里对齐。
     * 长度不同也走完整轮循环，不提前 return。
     */
    function safeEqual(a, b) {
      const x = Buffer.from(String(a), 'utf8');
      const y = Buffer.from(String(b), 'utf8');
      const len = Math.max(x.length, y.length);
      let diff = x.length ^ y.length;
      for (let i = 0; i < len; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
      return diff === 0;
    }
    const conf = () => {
      const raw = ctx.config || {};
      const pick = (k) => {
        const v = raw[k] && typeof raw[k] === 'object' && 'default' in raw[k] ? raw[k].default : raw[k];
        return v === undefined || v === null || v === '' ? DEFAULTS[k] : v;
      };
      return {
        enabled: pick('enabled') !== false,
        dshUrl: String(pick('dshUrl')).replace(/\/+$/, ''),
        token: String(pick('token')),
        botId: String(pick('botId')),
        timeoutMs: Number(pick('timeoutMs')) || 3000,
        maxAttempts: Number(pick('maxAttempts')) || 6,
        logReply: pick('logReply') !== false,
        probeState: pick('probeState') === true,
      };
    };

    /* ── 上行：Outbox（先落盘，再投递，失败指数退避）───────────────── */

    const OUTBOX_KEY = 'trpg:outbox';
    const SENT_KEY = 'trpg:sent'; // requestId 幂等表（下行）
    let flushing = false;
    let flushAgain = false;
    let retryTimer = null;
    let offlineNotifiedAt = 0;

    /** ctx.storage 是异步的（返回 Promise）——统一包一层，避免再踩同步假设 */
    const storeGet = (k, d) => Promise.resolve(ctx.storage.get(k, d));
    const storeSet = (k, v) => Promise.resolve(ctx.storage.set(k, v));

    let outboxChain = Promise.resolve();
    const withOutbox = (fn) => {
      outboxChain = outboxChain.then(fn).catch((e) => log.warn(`Outbox 处理失败：${e?.message || e}`));
      return outboxChain;
    };

    const readOutbox = async () => {
      const v = await storeGet(OUTBOX_KEY, []);
      return Array.isArray(v) ? v : [];
    };
    const writeOutbox = (list) => storeSet(OUTBOX_KEY, list.slice(-200));

    async function enqueue(evt) {
      return withOutbox(async () => {
        const list = await readOutbox();
        if (list.some((e) => e.eventId === evt.eventId)) return;
        list.push(evt);
        await writeOutbox(list);
      });
    }

    async function postEvent(evt) {
      const c = conf();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), c.timeoutMs);
      try {
        const res = await fetch(`${c.dshUrl}/trpg/event`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-trpg-token': c.token },
          body: JSON.stringify(evt),
          signal: ctrl.signal,
        });
        if (!res.ok) log.warn(`投递被拒 HTTP ${res.status}（${evt.text?.slice(0, 16)}）`);
        return res.ok;
      } catch (error) {
        log.warn(`投递失败：${error?.message || error}（${evt.text?.slice(0, 16)}）`);
        return false;
      } finally {
        clearTimeout(timer);
      }
    }

    async function probeHealth() {
      const c = conf();
      try {
        const res = await fetch(`${c.dshUrl}/trpg/health`, {
          headers: { 'x-trpg-token': c.token },
          signal: AbortSignal.timeout(1500),
        });
        return res.ok;
      } catch {
        return false;
      }
    }

    function scheduleRetry(delayMs) {
      if (retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        flushOutbox().catch(() => {});
      }, delayMs);
      retryTimer.unref?.();
    }

    async function flushOutbox() {
      if (flushing) { flushAgain = true; return; }
      flushing = true;
      try {
        for (;;) {
          const list = await readOutbox();
          if (!list.length) break;
          const evt = list[0];
          const ok = await postEvent(evt);
          if (!ok) {
            const attempts = (evt.attempts || 0) + 1;
            const delay = Math.min(16000, 1000 * 2 ** (attempts - 1));
            await withOutbox(async () => {
              const cur = await readOutbox();
              if (!cur.length || cur[0].eventId !== evt.eventId) return;
              if (attempts >= conf().maxAttempts) {
                log.warn(`投递失败已达上限，丢弃事件 ${evt.eventId.slice(0, 12)}（${evt.text?.slice(0, 20)}）`);
                cur.shift();
              } else {
                cur[0] = { ...cur[0], attempts };
              }
              await writeOutbox(cur);
            });
            const healthy = await probeHealth();
            if (!healthy && Date.now() - offlineNotifiedAt > 60000) {
              offlineNotifiedAt = Date.now();
              notifyOffline(evt);
            }
            scheduleRetry(delay);
            return;
          }
          await withOutbox(async () => {
            const cur = await readOutbox();
            if (cur.length && cur[0].eventId === evt.eventId) cur.shift();
            await writeOutbox(cur);
          });
          log.info(`已投递 ${evt.eventId.slice(0, 12)}（${evt.text?.slice(0, 16)}）`);
        }
      } finally {
        flushing = false;
        if (flushAgain) {
          flushAgain = false;
          setTimeout(() => flushOutbox().catch(() => {}), 0);
        }
      }
    }

    /**
     * 投递失败时的兜底提示。
     *
     * 这是 probeState 关着（默认）时**唯一**会告诉用户「另一半不在」的地方，
     * 所以文案必须点明缺的是 DSH 侧插件，而不只是「离线」。
     * 由 flushOutbox 在「投递失败 + 健康探测失败」时调用，每分钟最多一次。
     */
    function notifyOffline(evt) {
      const text = [
        '⚠️ 找不到守密人：DSH 侧的 dsh-trpg 插件没在响应。',
        '本插件只是桥，需要配合它才能跑团（骰点、叙事、角色卡都在那边）。',
        '这条已暂存，恢复后自动补结算。',
      ].join('\n');
      const msg = recentMsgs.get(evt.msgId)?.msg;
      const send = msg?.replyNow ? msg.replyNow(text) : ctx.push?.(evt.groupId, text);
      /**
       * B-5：失败不能静默。
       * 以前 `.catch(() => {})` 把「这条没发出去」彻底吞掉，
       * 群里看起来像机器人没反应，日志里也什么都没有。
       */
      Promise.resolve(send).catch((e) => log.warn(`离线提示没发出去：${e?.message || e}`));
    }

    /* ── 下行：/send（幂等 + 复用 Roost 的 msg_seq 与降级逻辑）──────── */

    const sent = new Map();
    const recentMsgs = new Map(); // msgId -> { msg, at }
    const MSG_TTL = 5 * 60 * 1000;

    const prune = () => {
      const now = Date.now();
      for (const [id, v] of recentMsgs) if (now - v.at > MSG_TTL) recentMsgs.delete(id);
      for (const [id, at] of sent) if (now - at > 10 * 60 * 1000) sent.delete(id);
    };
    const pruneTimer = setInterval(prune, 60000);
    pruneTimer.unref?.();

    /**
     * B-4：下行限速。
     * 令牌一旦泄露，没有限速就是无限刷屏机。窗口内超过阈值直接 429，
     * 让上游（dsh-trpg）自己退避，而不是把群冲了。
     */
    const sendHits = [];
    const SEND_WINDOW_MS = 60000;
    const SEND_MAX = 30;
    function sendRateLimited() {
      const now = Date.now();
      while (sendHits.length && now - sendHits[0] > SEND_WINDOW_MS) sendHits.shift();
      if (sendHits.length >= SEND_MAX) return true;
      sendHits.push(now);
      return false;
    }

    /**
     * 让 DSH 侧能把共享令牌推过来（`PATCH /config`）。
     *
     * 以前这里只有 /send，DSH 改完令牌去同步会 404「接口不存在」——
     * 两边令牌不一致，群里就没反应，而报错文案看起来像「Roost 坏了」。
     *
     * 鉴权：请求体带 `from`（当前令牌）或面板访问密钥都行。
     * 本地回环 + 旧令牌自证，够用了；没配令牌时（首次）直接放行。
     */
    ctx.registerRoute('PATCH', '/config', async ({ body, json }) => {
      const c = conf();
      const b = body && typeof body === 'object' ? body : {};
      if (c.token) {
        const from = String(b.from || '');
        if (!safeEqual(from, c.token)) {
          return json(403, { ok: false, error: 'bad_token', message: 'from 与当前共享令牌不一致' });
        }
      }
      const next = {};
      if (typeof b.token === 'string' && b.token.trim()) next.token = b.token.trim();
      if (!Object.keys(next).length) return json(400, { ok: false, error: 'nothing_to_update' });
      try {
        await ctx.setConfig(next);
        return json(200, { ok: true, tokenConfigured: Boolean(conf().token) });
      } catch (e) {
        return json(500, { ok: false, error: String(e?.message || e) });
      }
    });

    /**
     * 把当前令牌交给 DSH 侧（`GET /r/token`）。
     *
     * 反向同步用：用户在 Roost 面板改了令牌之后，DSH 那边并不知道，
     * 于是转发器用新令牌投递、DSH 用旧令牌校验 —— 一律 403，群里没反应。
     * DSH 定期来这里拉一次就能自己跟上。
     *
     * 只回环可读（framework 的路由本身只监听本地），
     * 面板设了访问密钥时要求带上 `x-access-key`。
     */
    ctx.registerRoute('GET', '/token', async ({ json }) => {
      /**
       * 注意：registerRoute 的 handler 只有 { query, body, method }，
       * **拿不到 req / headers**（框架的明确设计），所以这里没法校验请求头。
       * 这个路由本身只监听回环，且只回一个本来就存在 config.json 里的值，
       * 暴露面没有增加 —— 真机多用户场景请改用操作系统级权限隔离。
       */
      const c = conf();
      return json(200, { ok: true, token: String(c.token || ''), configured: Boolean(c.token) });
    });

    /**
     * 重载。DSH 改完令牌会顺带调一下，这里只需要回 ok ——
     * 配置是每次 `conf()` 现读的，本来就不需要真的重载。
     */
    ctx.registerRoute('POST', '/reload', async ({ json }) => {
      return json(200, { ok: true, reloaded: false, note: '配置实时读取，无需重载' });
    });

    ctx.registerRoute('POST', '/send', async ({ body, json }) => {
      const c = conf();
      if (!c.enabled) return json(503, { ok: false, error: 'forwarder_disabled' });
      const b = body && typeof body === 'object' ? body : {};
      /**
       * 令牌走 **body**，不是请求头。
       *
       * 这里踩过一次坑：`ctx.registerRoute` 的 handler 拿到的是纯数据
       * `{ query, body, method }`（src/web/server.js:3400），**没有 req，
       * 也没有 headers** —— 插件拿不到裸 req/res 是框架的明确设计。
       * 所以写 `req.headers[...]` 会在每次调用时抛 `req is not defined`，
       * 表现成 /send 一律 500，群里一句回复都没有（2026-11-08 15:40 就是这样）。
       */
      const givenToken = String(b.token || '');
      if (!c.token || !safeEqual(givenToken, c.token)) {
        return json(403, { ok: false, error: 'bad_token' });
      }
      const requestId = String(b.requestId || '');
      const sentList = await readSent();
      if (requestId && (sent.has(requestId) || sentList.includes(requestId))) {
        return json(200, { ok: true, dup: true });
      }
      if (sendRateLimited()) return json(429, { ok: false, error: 'rate_limited', windowMs: SEND_WINDOW_MS, max: SEND_MAX });
      const groupId = String(b.groupId || '');
      if (!groupId) return json(400, { ok: false, error: 'missing_groupId' });
      if (String(b.type || 'text') !== 'text') {
        // v0.1 只放文本：图片/语音要走上传与缓存，等文本链路跑顺了再加
        return json(400, { ok: false, error: 'unsupported_type' });
      }

      const text = String(b.content ?? '');
      if (!text.trim()) return json(400, { ok: false, error: 'empty_content' });
      /**
       * B-2：单条上限。
       * 没有上限时，持令牌的一次调用就能灌几百 KB 进群（还会被 QQ 截断成半张卡）。
       * 4000 字≈官方单条上限，超出直接拒，让上游自己切段。
       */
      if (text.length > 4000) {
        return json(413, { ok: false, error: 'content_too_long', limit: 4000, length: text.length });
      }
      /**
       * B-1：atOpenid 是**不可信输入**。
       * 以前直接拼进 `<qqbot-at-user id="${at}" />`，带个引号就能闭合标签、
       * 往群里塞任意 markdown/HTML。openid 的字符集是固定的，直接白名单过滤。
       */
      const at = String(b.atOpenid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
      const markdown = b.markdown === true || Boolean(at);
      // @ 人只有 markdown 消息能渲染，纯文本会把标签原样露出来
      const content = at ? `<qqbot-at-user id="${at}" />\n${text}` : text;

      const entry = recentMsgs.get(String(b.replyMsgId || ''));
      try {
        if (entry?.msg?.replyNow) {
          // 走 Roost 的被动回复链：msg_seq 递增、窗口过期降级、投递账本都在里面
          await entry.msg.replyNow(content, {
            ...(markdown ? { markdown: true } : {}),
            ...(requestId ? { requestId } : {}),
          });
        } else {
          /**
           * 载体找不到了（进程重启/超过 5 分钟）：直接打接口，按主动消息走额度。
           * 单聊必须走 sendC2C —— 拿 sendGroup 发单聊 openid 会 400「群不存在」。
           */
          const sender = b.direct ? ctx.api.sendC2C : ctx.api.sendGroup;
          await sender(groupId, {
            msgId: String(b.replyMsgId || '') || undefined,
            content,
            ...(markdown ? { markdown: true } : {}),
          });
        }
        if (requestId) {
          sent.set(requestId, Date.now());
          const list = await readSent();
          list.push(requestId);
          await storeSet(SENT_KEY, list.slice(-500));
        }
        if (c.logReply) log.debug(`直发成功 ${requestId || '(无幂等键)'} → ${String(text).slice(0, 24)}`);
        return json(200, { ok: true });
      } catch (error) {
        const msgText = String(error?.message || error);
        // 5 次上限：把错误码带回去，让 dsh-trpg 换下一个 msgId（它手里有池子）
        const code = /最多回复/.test(msgText) ? 'seq_exhausted' : 'send_failed';
        log.warn(`直发失败（${code}）：${msgText}`);
        return json(200, { ok: false, error: code, message: msgText });
      }
    });

    async function readSent() {
      const v = await storeGet(SENT_KEY, []);
      return Array.isArray(v) ? v : [];
    }

    /* ── 消息入口 ─────────────────────────────────────────────────────── */

    function isBotMessage(msg) {
      return Boolean(msg?.raw?.author?.bot || msg?.raw?.author?.is_bot);
    }

    /* ── 消息入口：中间件（命令类消息必须在这里拦）────────────────────── */

    /**
     * 为什么不是 ctx.on('message')：内核把「以 / 开头的消息」当命令处理，
     * 没注册过 /trpg 就直接回「没有这个命令」，**根本不会走到监听器**。
     * 实测 2026-11-07 19:58：用户发 /trpg start，群里只看到「没有这个命令」。
     * 中间件在分发之前跑，接住后不调 next()，内核就当这条没发生。
     */
    /**
     * 命令白名单。
     *
     * **必须和 dsh-trpg 的 `CN_ALIASES` 同步** —— 这里没有的命令，
     * 中间件根本不会转给 dsh-trpg，会被当成普通聊天交给 ai-chat。
     * 之前加了 30 个中文命令却只在 DSH 侧实现，结果群里发 /开始 一条都到不了，
     * 表现得像「插件没反应」。
     */
    const TRPG_CMDS = new Set([
      // 英文（原样保留）
      'trpg', 'st', 'status', 'pc', 'ra', 'r', 'roll', 'sc', 'jrrp', 'luck', 'tactic',
      'afk', 'go', 'undo', 'note', 'help', '?', 'setcoc',
      // 中文：开局与进度
      '开始', '开局', '继续', '暂停', '结束', '结团', '重开', '重置', '模组', '状态', '团',
      // 中文：角色卡
      '录卡', '建卡', '角色卡', '卡', '切换角色', '解绑',
      // 中文：检定与骰子
      '检定', '骰', '掷骰', '理智', '疯狂', '幸运', '房规',
      // 中文：其他
      '撤销', '记录', '战术', '暂离', '帮助', '指令',
    ]);

    /**
     * 通用命令：**没开团的群**里绝不能吞。
     *
     * `help` / `status` / `roll` / `r` / `?` 每个机器人都有一份（内核自带 status，
     * 骰娘、帮助插件也都抢这几个词）。开团时它们是 dsh-trpg 的命令，归它；
     * 没开团时用户发 `/help` 却什么都收不到，看起来就是这个插件把机器人搞坏了。
     * 收录要求里「命令名全局唯一、别用 help/status 这类通用词」防的正是这件事。
     */
    /**
     * 中文命令里同样有一批「谁都想用」的词。
     *
     * `TRPG_CMDS` 加了 30 个中文命令之后，这里必须一起扩 —— 否则没开团的群里
     * 群友发 `/帮助` `/状态` `/骰` 会被转发器接走，投给 dsh-trpg；
     * dsh-trpg 没在跑、或者根本没装，这条消息就石沉大海，看起来像机器人坏了。
     * 开团之后它们照旧归守密人（走 running === true 那条分支），不影响跑团。
     */
    const GENERIC_CMDS = new Set([
      'status', 'roll', 'r', 'help', '?',
      // 中文通用词：别的插件（骰娘、帮助、管理）也抢这些
      '帮助', '指令', '状态', '卡', '骰', '记录',
    ]);

    /**
     * 本地「这个群开过团」的名单（落 ctx.storage，重启不清）。
     *
     * 为什么需要它：dsh-trpg 升级后要等 DSH 重启才会暴露 /trpg/state。
     * 那段时间探测是 404，如果直接当成「没在跑团」，跑团群的每句行动都会被
     * 放行给别的插件 —— 表现就是「发什么都没人回」。
     */
    const STARTED_KEY = 'trpg:started';
    const startedGroups = new Set();
    /**
     * 名单同样要异步读（ctx.storage 返回 Promise）。
     * 不 await 的话启动瞬间名单是空的，跑团群里第一条消息会被当成普通闲聊放行。
     */
    const startedReady = storeGet(STARTED_KEY, []).then((v) => {
      if (Array.isArray(v)) for (const k of v) startedGroups.add(k);
    }).catch(() => {});
    const rememberStarted = async (key, on) => {
      if (on) startedGroups.add(key); else startedGroups.delete(key);
      await storeSet(STARTED_KEY, [...startedGroups]);
    };

    /** 问 dsh-trpg 这个群是不是在跑团（本地 HTTP，1ms 级）。 */
    async function trpgState(msg) {
      const c = conf();
      const group = String(msg.groupUin || msg.groupId || '');
      try {
        const res = await fetch(`${c.dshUrl}/trpg/state?group=${encodeURIComponent(group)}`, {
          headers: { 'x-trpg-token': c.token },
          signal: AbortSignal.timeout(500),
        });
        if (!res.ok) return null;
        const j = await res.json();
        return Boolean(j?.running);
      } catch {
        return null; // 守密人离线：命令照样进 Outbox，非命令放行给普通聊天
      }
    }

    const stateCache = new Map(); // group -> { at, running, probed }
    /**
     * 返回 `{ running, probed }`，不只是布尔。
     *
     * 为什么要把 `probed` 也传出去：调用点要区分「确认没在跑团」和「问不到」
     * —— 问不到时得告诉用户缺的是 DSH 侧插件，而不是让他以为网络抖了。
     * 早先这里只 return `running`，调用点还在读 `probed`，等于每次命中命令
     * 都会抛 ReferenceError（`probed is not defined`），报错还被中间件吞掉。
     */
    async function stateCached(key, msg) {
      const c = conf();

      /**
       * `probeState` 关着（默认）时**不发**那个请求。
       *
       * 这条以前是空开关：配置读进来了，但 stateCached 无条件探测。后果是
       * 每个活跃群每 5 秒打一次 /trpg/state —— 而旧版 dsh-trpg 在这个端点上
       * 会让宿主 fatal 退出（2026-11-07 连崩三次）。等于默认配置就在做那件
       * 最危险的事，而且频率比手动触发高得多。
       *
       * 关掉时只信本地名单（/trpg start 记、/trpg pause|end 清）。
       * `probed` 给 null 表示「没问过」，另用 `skipped` 与「问了但失败」
       * 区分 —— 否则下游会把每条命令都当成「守密人不见了」而误报。
       */
      if (!c.probeState) {
        return { at: Date.now(), running: startedGroups.has(key), probed: null, skipped: true };
      }

      const hit = stateCache.get(key);
      if (hit && Date.now() - hit.at < 5000) return hit;
      const probed = await trpgState(msg);
      const entry = { at: Date.now(), running: probed === true, probed, skipped: false };
      stateCache.set(key, entry);
      return entry;
    }

    /**
     * 中间件签名是 `(mctx, next)`：框架文档里它叫 `ctx`（内容 { msg, cfg, commandEntry }），
     * 但这里已经有插件的 `ctx`（下面要用 ctx.levelOf），同名会把它遮住，
     * 所以参数取名 mctx，语义完全一样。
     */
    ctx.use('trpg-forward', async (mctx, next) => {
      const msg = mctx?.msg;
      const c = conf();
      /**
       * 群聊和单聊都要接（`group` / `c2c`）。
       * 以前只认 group，私聊发 /开始 直接 return next()，
       * 于是那条消息被当成普通聊天交给 ai-chat —— 表现就是「私聊里指令无效」。
       */
      if (!c.enabled || !msg || (msg.kind !== 'group' && msg.kind !== 'c2c') || isBotMessage(msg)) return next();
      const isDirect = msg.kind === 'c2c';
      const text = String(msg.content ?? '').trim();
      if (!text) return next();

      // . 和 / 都算命令前缀（.r 3d6 是骰娘插件的老习惯，群里更顺手）
      const isCmd = text.startsWith('/') || text.startsWith('.');
      const cmd = isCmd ? text.slice(1).split(/\s+/)[0].toLowerCase() : '';
      await startedReady;
      const known = isCmd && TRPG_CMDS.has(cmd);
      /**
       * 会话键：群聊用群号，单聊用对方 openid。
       *
       * 单聊时 `groupId` / `groupUin` 都是空的，直接用会把 stateKey 拼成空串 ——
       * 于是所有私聊共用一个「开团名单」条目，A 在私聊开团、B 的私聊也跟着进跑团模式。
       * 事件里的 `groupId` 也是同一个键（下面 event 那段），两处必须一致。
       */
      const stateKey = isDirect
        ? String(msg.userId || '')
        : String(msg.groupUin || msg.groupId || '');
      /**
       * 这个群在不在跑团，由 stateCached 一处决定：
       *   · probeState 关（默认）→ 只看本地名单，零网络请求
       *   · probeState 开         → 问 dsh-trpg 的 /trpg/state（5 秒缓存）
       * 开着的好处是「别的入口改了状态」（比如面板上暂停）也能立刻感知；
       * 代价是多一次本地往返，且旧版 dsh-trpg 在该端点上不稳。
       */
      const state = await stateCached(stateKey, msg);
      const running = state.running;

      // 跑团中的群：所有非命令发言都归守密人；命令只接我们认识的
      // 没在跑团的群：只接 TRPG 命令，其余全部放行（普通聊天不受影响）
      // 开团中的群：所有非命令发言都归守密人，命令只接我们认识的
      // 没开团的群：只接 TRPG 专属命令；通用命令（help/status/roll…）一律放行，
      //             否则用户发 /help 会被吞掉，看起来像机器人坏了
      const handle = running === true ? !isCmd || known : known && !GENERIC_CMDS.has(cmd);
      if (!handle) return next();

      recentMsgs.set(String(msg.id), { msg, at: Date.now() });
      const event = {
        eventId: String(msg.id || `${msg.receivedAt}-${Math.random().toString(36).slice(2, 8)}`),
        botId: c.botId,
        // 单聊没有群：用对方 openid 当会话键，DSH 那边一视同仁地存 session
        groupId: isDirect ? String(msg.userId || '') : msg.groupId,
        direct: isDirect,
        groupUin: msg.groupUin || '',
        userId: msg.userId,
        userUin: msg.uin || '',
        userAliases: Array.isArray(msg.userAliases) ? msg.userAliases : [],
        nickname: msg.userName || '',
        groupName: msg.groupName || '',
        roleLevel: await ctx.levelOf(msg).catch(() => 9999),
        msgId: String(msg.id || ''),
        text,
        timestamp: Number(msg.receivedAt) || Date.now(),
        attempts: 0,
      };

      // /trpg start|pause 决定这个群要不要按跑团处理（探测不可用时靠它兜底）
      if (isCmd && cmd === 'trpg') {
        const sub = text.slice(1).split(/\s+/)[1] || '';
        if (sub === 'start' || sub === 'load') { await rememberStarted(stateKey, true); stateCache.delete(stateKey); }
        if (sub === 'pause' || sub === 'end' || sub === 'stop') { await rememberStarted(stateKey, false); stateCache.delete(stateKey); }
      }

      // 先落盘再投递：进程在这一步之后挂掉，重启还能补投
      await enqueue(event);
      flushOutbox().catch(() => {});

      if (!state.skipped && state.probed === null && known) {
        /**
         * 探测失败 = DSH 侧没起来。这里要说清楚**缺的是什么**，
         * 否则用户只会看到「守密人离线」，以为是网络抖动，反复重试。
         */
        msg.replyNow?.(
          [
            '⚠️ 找不到守密人：DSH 侧的 dsh-trpg 插件没在响应。',
            '本插件只是桥，需要配合它才能跑团（骰点、叙事、角色卡都在那边）。',
            `检查：浏览器打开 ${c.dshUrl}/trpg/health 应返回 {"ok":true}`,
            '这条指令已暂存，恢复后会自动补结算。',
          ].join('\n'),
        ).catch?.(() => {});
      }
      // 不调 next()：内核不再回「没有这个命令」，也不会让别的插件抢答
    });

    ctx.menu('跑团转发', [
      { text: '⚠️ 需要配合 DSH 插件 dsh-trpg', desc: '本插件只是桥：单独启用不会有任何回复。骰点、守密人、角色卡都在 DSH 侧' },
      { text: '本插件无命令', desc: '它只做上下行转发；玩家指令（/st /ra /go …）由 dsh-trpg 解析' },
      { text: `下行端点：/api/plugins/${ctx.id}/r/send`, desc: 'dsh-trpg 通过它实时播报骰子与剧情' },
    ]);

    const outboxTimer = setInterval(() => {
      readOutbox()
        .then((list) => {
          if (!list.length) return null;
          log.info(`Outbox 兜底扫描：${list.length} 条待投`);
          return flushOutbox();
        })
        .catch((e) => log.warn(`兜底刷新失败：${e?.message || e}`));
    }, 10000);
    outboxTimer.unref?.();

    ctx.onTeardown(() => {
      clearInterval(outboxTimer);
      clearInterval(pruneTimer);
      if (retryTimer) clearTimeout(retryTimer);
      sent.clear();
      recentMsgs.clear();
    });

    log.info(
      `跑团转发器已加载 v${VERSION}｜上行 ${conf().dshUrl}/trpg/event｜下行 /r/send` +
        `｜令牌${conf().token ? '已配置' : '为空（请与 dsh-trpg 对齐）'}`,
    );

    /**
     * 启动自检：确认「另一半」在线。
     *
     * 这个插件单独启用时**什么都不会发生** —— 骰点、守密人叙事、角色卡全在
     * DSH 侧的 dsh-trpg 里。用户装了一个没反应，最常见的原因就是只装了一半，
     * 所以这里主动探一次并说清楚，而不是等他去翻文档。
     */
    if (conf().enabled) {
      probeHealth().then((ok) => {
        if (ok) {
          log.info(`另一半在线：dsh-trpg 已响应 ${conf().dshUrl}`);
          return;
        }
        log.warn(
          [
            '⚠️ 找不到 DSH 侧插件 dsh-trpg（探测 ' + conf().dshUrl + '/trpg/health 失败）',
            '   本插件只负责「桥」，单独启用不会有任何回复：',
            '   · 骰点 / 守密人叙事 / 角色卡 → 都在 DSH 插件 dsh-trpg 里',
            '   · 装好 dsh-trpg 后，两边「共享令牌」要保持一致',
            '   · dsh-trpg 的默认端口是 17322，改了端口就把上面「dsh-trpg 地址」一起改',
          ].join('\n'),
        );
      }).catch(() => {});
    }
  },
};

export const internals = { DEFAULTS, VERSION };

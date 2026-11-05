/**
 * AI 对话（v3，从头重写）
 * ====================
 *
 * 跟 1.x 的根本区别：**没有指令**。
 *
 * 1.x 是「@机器人 /ai 问题」——用户得先知道有 `/ai` 这回事，
 * 还得记得 @ 一下。群友看到的是一个「要按规程使用」的机器。
 *
 * 3.x 改成「它就在群里待着」：
 *   · 群里每条消息它都看得见（需要开放平台开「接收所有消息」）
 *   · 它自己判断这条该不该接话，不该接就一声不吭
 *   · 不占用任何指令前缀，不会跟别的插件抢 `/xxx`
 *
 * 为什么不怕吵到别人，靠三层：
 *   1. **规则门**（decide.js，0 成本）：冷却、每分钟配额、忽略词、
 *      别的插件的指令——大部分消息在这一层就挡掉了
 *   2. **模型判断**：剩下的交给模型，不该接就输出 `<skip>`
 *   3. **硬锁**：同一个群同时只跑一轮，不会因为群里刷屏就并发一堆请求
 *
 * 别的插件的指令为什么不用自己过滤：内核在分派阶段就把命令交给
 * 对应插件并 `return` 了，监听器根本收不到。这是框架给的，不是我们算的。
 *
 * 记忆和人设也没有指令——模型自己在回复里带 `<<remember: 内容>>` 这类标记，
 * 插件解析执行后把标记摘掉。用户说「记住我住在杭州」就行。
 */

import { createAdapter } from './adapter/index.js';
import { createBridge } from './adapter/bridge.js';
import { buildUserContent } from './inbound.js';
import { sendReply, sendMedia, buildKeyboard } from './outbound.js';
import { shouldConsider, isSkip, stripSkip, takeRetract, parseActions, parseDuration, parseButton, textOf, isFromBot, SKIP_MARK, DEFAULT_IGNORE } from './decide.js';
import { ChatStore, PaceStore } from './session.js';
import { createMerger } from './merge.js';
import { collectImages } from './vision.js';
/**
 * 语音合成走宿主（dsh-roost）：
 *   · 合成、provider、密钥全在宿主配置里，插件只负责转 silk 和发送
 *   · 宿主没开语音 → 这里什么都不做，连提示词都不给模型
 */
import { hostTtsReady, synthesize } from './host-tts.js';

/** 一次请求最多等多久 */
const DEFAULT_TIMEOUT_SEC = 90;

/**
 * 宿主一次最多回几段（`qq_send` 逐段发）。
 *
 * 宿主管自己的上限（`dsh-roost` 的 `qqTools.maxParts`，默认 3），
 * 这里只是**兜底硬顶**——webhook 那类宿主万一一次塞几十段，
 * 不能让它把群刷爆。QQ 被动回复上限按场景取（群聊 5 次 / 单聊 4 次）。
 */
const MAX_SEGMENTS = 5;

/**
 * 同一条用户消息能被动回几次：**群聊 5、单聊 4**。
 *
 * 框架 `bot/src/outbound.js` 的 `PASSIVE_MAX_REPLIES` 已是这个口径，按 kind
 * 精确拦截（超了抛 40034128 或降级成主动消息）。这里以前一律拿 `MAX_SEGMENTS`
 * 当预算，单聊就多算一格：本地以为还有一格、框架已到上限，最后一格静默降级，
 * 白烧当天主动额度，群里没 `group_push` 时直接失败，表现是「最后一张图丢了」。
 *
 * `MAX_SEGMENTS` 继续保留：它是**段数硬顶**兼这里的群聊默认值，别删。
 * 预算一律走 `maxSegmentsOf(msg)`，不要在别处直接引用那个常量。
 */
const PASSIVE_REPLY_MAX = { group: MAX_SEGMENTS, c2c: 4 };

/** 按消息场景取被动回复预算；未知场景按群聊兜底 */
export function maxSegmentsOf(msg) {
  const kind = String(msg?.kind ?? '');
  return PASSIVE_REPLY_MAX[kind] ?? PASSIVE_REPLY_MAX.group;
}

/**
 * 框架等级 → 档位。
 *
 *   0 主人 / 1 管理员 / 2 群管 / 3 助手 / 其余（含 9999 NO_PERM）= 普通成员
 *
 * 为什么写死数字而不看 `levelName()` 的中文名：0-3 的语义在内核
 * `levels.js` 里是固定的（「插件只能读不能改」），而中文文案改一个字，
 * 按名字判断就会全部落到 member —— 那种错误不会报，只会静默降权。
 *
 * **2026-11-05 之前的版本是 `lv <= 1 ? 'admin' : 'member'`**，
 * 把群管（2）和助手（3）一起折进了普通成员，主人在框架里特意配的等级
 * 到 QQ 这边等于没配。
 */
function bucketOfLevel(lv) {
  /**
   * 空串 / null 必须先挡：`Number('')` 和 `Number(null)` 都是 0，
   * 而 0 是主人。当前两个调用点都在 `Number.isFinite(lv)` 之后才进来，
   * 所以现在碰不到——但这条判断留着，别让以后有人直接调它时 fail-open。
   * 负数同理：不是合法等级，按「认不出来」处理。
   */
  if (lv === null || lv === undefined || lv === '') return '';
  if (typeof lv !== 'number' && typeof lv !== 'string') return '';
  const n = Number(lv);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n <= 0) return 'owner';
  if (n <= 1) return 'admin';
  if (n <= 2) return 'manager';
  if (n <= 3) return 'helper';
  return 'member';
}

/**
 * 「她怎么不理人」的可观测性计数。
 *
 * 全是**只增不改的计数**，不参与任何判断——加计数不改变接话行为。
 * 以前 `paceSt.busy` 静默丢消息、规则门拒消息、配额挡消息都没有痕迹，
 * 排查「群里说了 184 句、日记只有 24 轮」只能靠猜。
 *
 * 模块级变量：`dashboard()` 是同步的、拿不到 ctx（框架只传插件对象），
 * 所以数字只能挂在这里；落盘由 `setup()` 里注入的 `dashSave` 负责。
 */
const dash = {
  seen: 0,          // 进入 handle 的消息（分母）
  forwarded: 0,     // 真正跑了一轮模型
  ruleBlocked: 0,   // shouldConsider 拒（mention/窗口/空/指令前缀）
  quotaBlocked: 0,  // 每分钟配额用满
  moodBlocked: 0,   // 社交意愿低
  busyDropped: 0,   // 等上一轮超时，仍然丢
  busyWaited: 0,    // 等上一轮跑完后正常继续（不是丢，不进分母）
  claimed: 0,       // 别的插件接过
  merged: 0,        // 合并窗口里被并进别的批次（不算丢）
  bots: 0,          // 对方是机器人
  noDsh: 0,         // 没连上 DSH
  failed: 0,        // 进了一轮但模型调用抛错
  reasons: {},      // 拒绝原因 → 次数
  since: Date.now(),
};
let dashSave = null;
let dashLoaded = false;

/** 把带动态数字的原因收敛成一类，否则「冷却还剩 7 秒」会占掉一行 */
function normReason(r) {
  const t = String(r || '未说明');
  if (/每分钟最多/.test(t)) return '每分钟配额用满';
  if (/^以「/.test(t)) return '像别的插件的指令（前缀）';
  if (/冷却中/.test(t)) return '冷却中（攒着）';
  if (/窗口/.test(t)) return '不在 @ 之后的窗口内';
  return t;
}

function bump(k, reason) {
  if (k in dash && typeof dash[k] === 'number') dash[k] += 1;
  if (reason) {
    const r = normReason(reason);
    dash.reasons[r] = (dash.reasons[r] || 0) + 1;
  }
  /** 10 秒节流由 dashSave 内部管；这里不管成功失败，写不进去不影响接话 */
  dashSave?.();
}

export default {
  id: 'ai-chat',
  name: 'AI 对话',
  version: '4.4.3',
  description: '群里说什么都看得见，自己判断该不该接话；不占用任何指令前缀',
  /**
   * 4.3.22 起读 `msg.groupName`（群名不再退成发送者昵称）。
   * 那个字段是框架 v0.9.10 才加的——**先发框架再发这个插件**，
   * 否则群标题会一直是空，只能落到宿主的「群 xxxxxx」兜底。
   *
   * 4.4.1 起读 `msg.uin` / `msg.userAliases`（QQ号与 openid 的对照），
   * 那是 v0.9.12 才有的。老框架上这些字段是空的，插件会自动退回
   * 「只认 openid」的老行为，不会崩——但号码相关的功能也就不生效。
   */
  frameworkVersion: '>=0.9.12',

  /**
   * 监听器优先级：**排最后**。
   *
   * 框架按 priority 从高到低跑监听器。别的插件（回声、养鲲、群管）
   * 先跑，命中关键词就 `msg.claim()` 认领这条消息，我就收不到了——
   * 这样「别的插件的功能调用」天然不会被 AI 抢答，不用自己维护一份忽略词表。
   */
  priority: -100,

  config: {

    decide: {
      type: 'select',
      default: 'ai',
      options: [
        { value: 'ai', label: 'AI 自己判断（读全量消息）' },
        { value: 'mention', label: '只有被 @ 时说话' },
        { value: 'window', label: '@ 之后一段时间内都接话' },
      ],
      label: '什么时候接话',
      /**
       * 三个模式的边界要写清，否则用户分不出「只在被 @」和「@ 之后一段时间」：
       *
       *   · `ai`      —— 每条都看一眼，模型决定接不接（最贵、最自然）；
       *   · `mention` —— 只有真 @ / 回复才接，其余一律不理（最省）；
       *   · `window`  —— @ 一次之后 `windowMin` 分钟内所有消息都接，
       *                  过了窗口回到「不理」。
       *
       * 为什么单开一个 `window`：框架本来就有「免 @ 窗口」（@ 一次或发命令后
       * 180 秒内都算被叫，见 `message.js` 的 `addressed`）。它以前**隐式**作用于
       * 所有模式，于是设了「只在被 @」也会被它绕过——线上真实反馈。
       * 现在把它变成显式选项，时长也交给人配。
       */
      desc: '「AI 自己判断」= 每条都看一眼，该接才接；'
        + '「只有被 @ 时」= 其余一律不理，最省；'
        + '「@ 之后一段时间」= 叫一次之后那段时间内接着聊，过点恢复安静（时长见下一项）',
    },
    windowMin: {
      type: 'number',
      default: 3,
      min: 1,
      max: 120,
      label: '「@ 之后」窗口（分钟）',
      desc: '只在「@ 之后一段时间内都接话」模式下生效。@ 或回复一次，接下来这么多分钟内她继续接话',
    },
    cooldownSec: {
      type: 'number',
      default: 20,
      min: 0,
      max: 600,
      label: '接话冷却（秒）',
      desc: '回过一次之后，这么多秒内不再主动接话。防止它跟着群里刷屏',
    },
    mergeWaitSec: {
      type: 'number',
      default: 1.5,
      min: 0,
      max: 10,
      label: '合并等待（秒）',
      desc: '对方发完一条后等这么久没新消息，才当作「说完了」一起回。设 0 关闭合并',
    },
    mergeMaxSec: {
      type: 'number',
      default: 6,
      min: 1,
      max: 30,
      label: '合并上限（秒）',
      desc: '对方一直发也最多等这么久，从第一条算。防止有人刷屏时它永远不回',
    },
    maxRepliesPerMin: {
      type: 'number',
      default: 3,
      min: 0,
      max: 30,
      label: '每分钟最多接几条',
      desc: '每个会话的主动接话上限，0 表示不限。被 @ 时不受这个限制',
    },
    ignoreWords: {
      type: 'json',
      default: DEFAULT_IGNORE,
      label: '忽略这些开头',
      desc: '以这些字符开头的消息一律不理，填 JSON 数组。默认 ["/"]——别的插件的指令本来也到不了这里，这是第二道保险',
    },

    /**
     * 人设不在这里了。
     *
     * 以前有三个配置项：`systemPrompt`（人设）、`groupPrompt`（群聊追加）、
     * `directPrompt`（私聊追加）。它们和 dsh-roost 的 `personas/*.md`
     * 是两份人设，同时注入会打架。
     *
     * 现在人设只归 dsh-roost 一处：人格文件 + 按群覆盖。
     * 这个插件只管收发和「该不该接」。
     */

    historyLimit: {
      type: 'number',
      default: 10,
      min: 1,
      max: 50,
      label: '记住几轮对话',
      desc: '1 轮 = 一问一答。越大越费 token',
    },
    idleTimeoutMin: {
      type: 'number',
      default: 30,
      min: 1,
      max: 1440,
      label: '闲置多久忘掉上下文（分钟）',
      desc: '群里很久没人说话就把上下文回收，省内存也避免拿很久以前的话当上下文',
    },


    markdown: {
      type: 'boolean',
      default: true,
      label: 'Markdown 消息',
      desc: '用 QQ 的 markdown 消息类型发回复，标题/列表/加粗能真的渲染。发不出去会自动退回纯文本',
    },
    seeImages: {
      type: 'boolean',
      default: true,
      label: '让它看得见图',
      desc: '把群里发的图片下载下来交给模型（不是只给一个网址）。关掉能省不少 token',
    },
    maxImages: {
      type: 'number',
      default: 4,
      min: 0,
      max: 8,
      label: '一次最多看几张图',
      desc: '一张图几百到几千 token，太多了会撑爆上下文。0 等于不看',
    },
    timeoutSec: {
      type: 'number',
      default: DEFAULT_TIMEOUT_SEC,
      min: 5,
      max: 300,
      label: '超时（秒）',
      desc: '模型这么久没回就放弃，别让用户干等',
    },

    dshUrl: {
      type: 'text',
      default: 'http://127.0.0.1:17321',
      label: 'DSH 地址',
      desc: 'dsh 适配器用，指向 dsh-roost 插件。装了 DSH 一般不用改',
      placeholder: 'http://127.0.0.1:17321',
    },
    /**
     * 宿主的共享密钥（`dsh-roost` 的 `server.token`）。
     *
     * 宿主没设密钥时留空即可。设了就必须两边一致：`/inbound`、`/capabilities`、
     * `/tts` 都会带这个头，缺了就是 401，而现象只是「突然不回话了」。
     * 正常情况下由 dsh-roost 在同步地址时一起写进来，不用手填。
     */
    dshToken: {
      type: 'string',
      default: '',
      label: '共享密钥',
      desc: '和 dsh-roost 的 server.token 一致。宿主没设就留空；一般由 dsh-roost 自动同步',
    },
    publicUrl: {
      type: 'text',
      default: 'http://127.0.0.1:8080',
      label: '面板地址',
      desc: '宿主回话时要能访问到本插件，所以填**宿主能访问到的**面板地址。同机填 127.0.0.1，跨机填内网 IP',
      placeholder: 'http://127.0.0.1:8080',
    },

    debug: {
      type: 'boolean',
      default: false,
      label: '调试日志',
      desc: '在日志里打印每轮耗时、token 消耗，以及「这条为什么没接」',
    },

    answerBots: {
      type: 'boolean',
      default: false,
      label: '接机器人的话',
      desc: '默认不接。群里有第二个 AI 时，两边会互相读、互相回，一句能滚成十几轮停不下来。除非你就是要看它俩聊，别开',
    },
  },

  /** @param {object} ctx Roost 插件上下文 */
  /**
   * 面板「设置 → 运行数据」页。框架通过 `/api/plugins/dashboard` 一次性收走，
   * 前端按 `metrics` + `note` 排版——不用改框架，也不用改前端。
   *
   * 意图：把「为什么没搭话」从猜变成看数字。尤其 `busyDropped`，
   * 它是全链路里唯一**连日志都没有**的丢弃点（debug 关着时）。
   */
  dashboard() {
    const top = Object.entries(dash.reasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([r, n]) => `${r}  ${n}`)
      .join('\n');
    const lost = dash.ruleBlocked + dash.quotaBlocked + dash.moodBlocked + dash.busyDropped;
    /** 每个 return / 异常分支都有对应计数，这里才减得干净（负数说明漏计，别夹掉） */
    const unaccounted = dash.seen - dash.forwarded - dash.failed - lost
      - dash.claimed - dash.merged - dash.bots - dash.noDsh;
    return {
      metrics: [
        { label: '看到消息', value: dash.seen, unit: '条', hint: '进入判定的入站消息（分母）' },
        { label: '转发给 DSH', value: dash.forwarded, unit: '条', hint: '真的跑了一轮模型' },
        { label: '规则挡掉', value: dash.ruleBlocked, unit: '条', hint: '只在被 @ / 窗口 / 空消息 / 指令前缀' },
        { label: '配额挡掉', value: dash.quotaBlocked, unit: '条', hint: '每分钟最多 N 条用满' },
        { label: '忙态丢掉', value: dash.busyDropped, unit: '条', hint: '等上一轮超时才丢，正常应很少' },
        { label: '忙态等到', value: dash.busyWaited, unit: '条', hint: '等上一轮跑完后正常继续，不是丢' },
        { label: '情绪闸门', value: dash.moodBlocked, unit: '条', hint: '社交意愿低，只接明确被叫的' },
        { label: '别的插件接了', value: dash.claimed, unit: '条' },
        { label: '合并进批次', value: dash.merged, unit: '条', hint: '不是丢，被并进同一轮' },
        { label: '机器人消息', value: dash.bots, unit: '条' },
        { label: '没连上 DSH', value: dash.noDsh, unit: '条' },
        { label: '调用失败', value: dash.failed, unit: '条', hint: '进了一轮，模型没跑成' },
        { label: '未归类', value: unaccounted, unit: '条', hint: '正常应为 0；负数说明有重复计数' },
      ],
      note:
        `统计起点：${new Date(dash.since).toLocaleString('zh-CN', { hour12: false })}（会落盘，重启不清零）\n\n` +
        `拒绝原因 Top：\n${top || '（还没有被挡的消息）'}`,
    };
  },

  setup(ctx) {
    /**
     * 启动时打一行能力标记。
     *
     * 为什么需要：框架的插件热重载只给**入口文件**加 `?t=` 时间戳绕 ESM 缓存
     * （`src/plugin/loader.js` 的 `const url = ...?t=${Date.now()}`），
     * `outbound.js` / `adapter/*.js` 这些子模块仍然走缓存。
     * 结果是「面板点重载」会得到**新入口 + 旧子模块**，多段发送就静默失效，
     * 而且从外面完全看不出来。这行日志用来一眼判断跑的是哪份代码：
     * 有「多段直发」，说明子模块是新的。
     */
    ctx.logger.info(`[ai-chat] 已加载 ${this?.version ?? '?'}（多段直发：segs + immediate）`);

    /**
     * 运行数据落盘。`dashboard()` 拿不到 ctx，所以数字在模块级 `dash` 上；
     * 这里把上次的读回来、之后按 10 秒节流写回，重启不清零。
     *
     * 全链路 try/catch：`ctx.storage` 在某些老框架版本里可能没有，
     * 计数是增强功能，绝不能因为写不进去就让整个插件起不来。
     */
    if (!dashLoaded) {
      dashLoaded = true;
      /**
       * 恢复开始前的基线。
       *
       * `ctx.storage.get` 是 **async**（要 `await fs.readFile`），从 setup
       * 到磁盘读回之间确实可能已经进过消息。那时 `bump()` 已经把数加上了，
       * 直接拿存档覆盖 `dash` 会把这批增量整个抹掉——表现为「刚启动那几句
       * 不算数」，而且拒绝原因明细也一起被顶掉。
       *
       * 所以先记基线，恢复完再把「窗口内的增量」加回去。
       * `since` 不参与：它就是要用存档里的旧起点。
       */
      const dashBase = { ...dash, reasons: { ...dash.reasons } };
      try {
        Promise.resolve(ctx.storage?.get?.('dashboard', null))
          .then((u) => {
            if (!u || typeof u !== 'object') return;
            const delta = {};
            for (const [k, v] of Object.entries(dash)) {
              if (typeof v === 'number' && k !== 'since') delta[k] = v - (Number(dashBase[k]) || 0);
            }
            const deltaReasons = {};
            for (const [r, n] of Object.entries(dash.reasons)) {
              const d = n - (Number(dashBase.reasons[r]) || 0);
              if (d > 0) deltaReasons[r] = d;
            }
            for (const [k, v] of Object.entries(u)) {
              if (k === 'reasons' && v && typeof v === 'object') {
                dash.reasons = { ...v };
              } else if (typeof dash[k] === typeof v && typeof v !== 'object') {
                dash[k] = v;
              }
            }
            for (const [k, d] of Object.entries(delta)) {
              if (typeof dash[k] !== 'number') continue;
              /**
               * 旧存档里**没有这个键**时（新增列 / 老版本存档，`failed` /
               * `bots` / `noDsh` 都是这次才加的），它没被上面的循环覆盖，
               * 仍留着窗口内的值。此时再 `+= delta` 会翻倍。
               * 缺键就先回到基线，再加增量。
               */
              if (!(k in u)) dash[k] = Number(dashBase[k]) || 0;
              dash[k] += d;
            }
            for (const [r, n] of Object.entries(deltaReasons)) {
              dash.reasons[r] = (Number(dash.reasons[r]) || 0) + n;
            }
          })
          .catch(() => {});
      } catch {}
    }
    let lastDashSave = 0;
    dashSave = () => {
      if (Date.now() - lastDashSave < 10_000) return;
      lastDashSave = Date.now();
      try {
        Promise.resolve(ctx.storage?.set?.('dashboard', { ...dash })).catch(() => {});
      } catch {}
    };

    const num = (v, def, min = 0) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= min ? n : def;
    };

    /** 配置每次现读：面板改完立刻生效，不用重启 */
    const conf = () => {
      const c = ctx.config ?? {};
      return {
        decide: ['mention', 'window'].includes(c.decide) ? c.decide : 'ai',
        windowMin: num(c.windowMin, 3, 1),
        cooldownSec: num(c.cooldownSec, 20),
        mergeWaitSec: num(c.mergeWaitSec, 1.5, 0),
        mergeMaxSec: num(c.mergeMaxSec, 6, 1),
        seeImages: c.seeImages !== false,
        maxImages: num(c.maxImages, 4, 0),
        dshToken: String(c.dshToken || '').trim(),
        maxRepliesPerMin: num(c.maxRepliesPerMin, 3),
        ignoreWords: Array.isArray(c.ignoreWords) ? c.ignoreWords.map(String).filter(Boolean) : DEFAULT_IGNORE,
        markdown: c.markdown !== false,
        timeoutSec: num(c.timeoutSec, DEFAULT_TIMEOUT_SEC, 5),
        dshUrl: String(c.dshUrl ?? 'http://127.0.0.1:17321').trim().replace(/\/+$/, ''),
        publicUrl: String(c.publicUrl ?? 'http://127.0.0.1:8080').trim().replace(/\/+$/, ''),
        debug: Boolean(c.debug),
        answerBots: Boolean(c.answerBots),
      };
    };

    /**
     * 每个会话最近发出去的那条消息 id。
     *
     * 用来支持 `<<retract>>`：模型说错了，把**上一条**收回来。
     * 只留一条（撤回只针对刚发的那条），不存历史。
     */
    const lastSent = new Map();

    /**
     * 情绪低潮缓存。
     *
     * 为什么要缓存：每来一条消息都去问一次 dsh-roost 太浪费，
     * 而情绪本来就是个慢变量（半衰期 4 小时），60 秒的陈旧完全可以接受。
     *
     * 拿到之后只做一件事：**社交意愿低的时候，只接明确叫它的**。
     * 这是「情绪影响行为」的第一处耦合——不做的话情绪就只是个装饰。
     *
     * 阈值 0.4 要跟 dsh-roost 的 `mood.js` 的 `LOW` 对齐。
     * 以前这里是 0.3，而那边衰减的落点是 0.5——**数学上永远到不了 0.3**，
     * 这个闸门从上线起就没触发过一次。0.4 是「衰减够不到、但一次明确的
     * 负面反馈就能跨过去」的位置，才是它该有的灵敏度。
     */
    const LOW_SOCIABILITY = 0.4;
    let moodCache = { at: 0, low: false };
    async function isLowMood() {
      if (Date.now() - moodCache.at < 60_000) return moodCache.low;
      const base = String(conf().dshUrl || '').replace(/\/+$/, '');
      if (!base) return false;
      try {
        const res = await fetch(`${base}/roost/api/mood`);
        const j = await res.json();
        moodCache = { at: Date.now(), low: Number(j?.sociability ?? 1) < LOW_SOCIABILITY };
      } catch {
        moodCache = { at: Date.now(), low: false }; // 问不到就当正常，别让它不说话
      }
      return moodCache.low;
    }

    /**
     * 互动事件：面板 / 按钮点击。
     *
     * 分工：ai-chat 是通道层，负责**鉴权 + 转发**；真正的操作由 dsh-roost 执行。
     * 为什么在这层鉴权：`sender` 和权限档位只有通道层拿得到。
     *
     * 鉴权规则：**主人(0) / 管理(1)** 才能改设置。
     * 消息反馈（点赞点踩，type 13）谁都能做——那是表达态度，不是改配置。
     *
     * 失败处理：**群里绝不回「你没权限」**（当众打脸 + 刷屏），静默丢弃只记日志。
     */
    ctx.on?.('INTERACTION_CREATE', async (d) => {
      const t = Number(d?.type ?? d?.data?.type ?? 0);

      // 13 = 消息反馈（点赞/点踩）→ 喂情绪系统。
      // **不鉴权**：这是表达态度，谁都能点。这是「被对待的反馈」最直接的来源。
      if (t === 13) {
        const opt = String(d?.data?.resolved?.feedback_opt ?? '');
        const base13 = String(conf().dshUrl || '').replace(/\/+$/, '');
        if (base13 && opt) {
          try {
            await fetch(`${base13}/roost/api/mood`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ feedback: opt }),
            });
            ctx.logger.info(`[ai-chat] 反馈 ${opt} 已记进情绪`);
          } catch (e) {
            ctx.logger.warn(`[ai-chat] 反馈转发失败：${e?.message ?? e}`);
          }
        }
        return;
      }

      /**
       * 18 / 19 = 用户 / 群授权。**不鉴权**——授权是用户处置自己的权利，
       * 谁点都算数。但必须记下来：`group_push` 是群主动消息的硬前置，
       * 没这条记录，C7 群聊主动根本发不出去。
       */
      if (t === 18 || t === 19) {
        const authz = d?.data?.resolved?.authorize_data ?? {};
        const base = String(conf().dshUrl || '').replace(/\/+$/, '');
        if (!base) return;
        try {
          await fetch(`${base}/roost/api/authz`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              type: t,
              scope: String(authz.scope ?? ''),
              optScene: String(authz.opt_scene ?? ''),
              chatId: d?.group_openid || d?.user_openid || '',
            }),
          });
          ctx.logger.info(`[ai-chat] 授权记录 ${authz.scope ?? '?'}（type ${t}）`);
        } catch (e) {
          ctx.logger.warn(`[ai-chat] 授权记录失败：${e?.message ?? e}`);
        }
        return;
      }

      // 14 = 用户清空会话。等价于「清上下文」，但要鉴权（群级影响）
      if (t === 14) {
        const openid14 = d?.group_member_openid || d?.user_openid || '';
        const ok14 = (() => {
          try {
            return Boolean(ctx.isOwner?.(openid14));
          } catch {
            return false;
          }
        })();
        if (!ok14) {
          ctx.logger.info('[ai-chat] 清空会话被拒（非主人）');
          return;
        }
        const base14 = String(conf().dshUrl || '').replace(/\/+$/, '');
        if (!base14) return;
        try {
          await fetch(`${base14}/roost/api/quick`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              op: 'context.clear',
              chatId: d?.group_openid || d?.user_openid || '',
              actor: { openid: openid14, bucket: 'owner' },
            }),
          });
          ctx.logger.info('[ai-chat] 会话已清空');
        } catch (e) {
          ctx.logger.warn(`[ai-chat] 清空会话失败：${e?.message ?? e}`);
        }
        return;
      }

      // 只有 11（消息按钮）和 12（快捷菜单）走快捷操作
      if (t !== 11 && t !== 12) return;

      const raw = String(d?.data?.resolved?.button_data ?? '');
      if (!raw) return;

      // 约定格式：`op|arg`，比如 `persona.set|毒舌群友`、`memory.list|`
      const [op, ...rest] = raw.split('|');
      const arg = rest.join('|');

      const openid = d?.group_member_openid || d?.user_openid || '';
      const chatId = d?.group_openid || d?.user_openid || '';
      const kind = d?.group_openid ? 'group' : 'c2c';

      let bucket = 'unknown';
      try {
        if (ctx.isOwner?.(openid)) {
          bucket = 'owner';
        } else {
          const lv = await ctx.levelOf?.({ userId: openid, kind, groupId: d?.group_openid || '', raw: d });
          // 用返回值判空：拿不到等级时 `bucketOfLevel` 返回空串，保持上面的 unknown（最严）
          const b = bucketOfLevel(lv);
          if (b) bucket = b;
        }
      } catch {
        /* 拿不到权限就按最严处理 */
      }

      if (bucket !== 'owner' && bucket !== 'admin') {
        ctx.logger.info(`[ai-chat] 快捷操作被拒（${bucket}）：${op}`);
        return;
      }

      const base = String(conf().dshUrl || '').replace(/\/+$/, '');
      if (!base) return;
      try {
        const res = await fetch(`${base}/roost/api/quick`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op, arg, chatId, actor: { openid, bucket } }),
        });
        const j = await res.json().catch(() => ({}));
        ctx.logger.info(`[ai-chat] 快捷 ${op} → ${j.ok ? 'ok' : j.message || res.status}`);
      } catch (e) {
        ctx.logger.warn(`[ai-chat] 快捷转发失败：${e?.message ?? e}`);
      }
    });

    const store = new ChatStore({
      historyLimit: num(ctx.config.historyLimit, 10, 1),
      idleMs: num(ctx.config.idleTimeoutMin, 30, 1) * 60_000,
    });
    /**
     * 主动发消息的接口：`POST /api/plugins/ai-chat/r/send`
     *
     * 为什么要开这个口子：**主动消息只能由持有 QQ 连接的一方发**。
     * DSH 那边（dsh-roost 的主动搭话）算出了「该说句话了」，但它没有 api，发不出去。
     *
     * 发送走 `ctx.push`（即框架的 outbound），**不能直连 `ctx.api`**。
     * 以前这里是 `ctx.api.sendGroup/sendC2C` 直发，把 outbound 整个绕开了：
     * 每秒限速、主动消息额度（20 条/分钟 + 1000 条/天）、离线判断、
     * 审核识别全都不参与——dsh-roost 的主动搭话一路裸奔，只靠它自己的
     * `maxPerDay: 3` 兜着，换个调用方就没有任何保护。
     */
    /**
     * 取邻文（阶段 4 的桥 2）：`GET /r/context?aroundId=&before=&after=`
     *
     * dsh-roost 那边只存了 `eventId`，要拿回原文和前后文只能回到这边来问——
     * 事件账本在框架侧（A 侧），它看不到。
     *
     * **只读，而且不返回 `payload`**：dsh-roost 要的是「那句话说了什么」，
     * 整包报文对它没用，只会让这条跨进程通道变成数据外泄面。
     *
     * 找不到不代表出错：events 只留 7 天，更早的记忆里 `evidence` 还有快照。
     */
    ctx.registerRoute?.('GET', '/context', async ({ query }) => {
      const aroundId = String(query?.aroundId ?? '').trim();
      if (!aroundId) return { ok: false, message: '缺 aroundId' };
      if (!ctx.ledger) return { ok: false, message: '当前环境没有事件账本' };

      const row = ctx.ledger.get(aroundId);
      if (!row) {
        return {
          ok: false,
          gone: true,
          message: '找不到这条事件——可能超过保留期（默认 7 天）被滚动删了，证据快照还在记忆里',
        };
      }

      const clamp = (v, d) => Math.min(10, Math.max(0, Number(v ?? d)));
      const items = ctx.ledger.timeline({
        chatId: row.chat_id,
        anchorSeq: row.seq,
        before: clamp(query?.before, 2),
        after: clamp(query?.after, 2),
      });

      return {
        ok: true,
        anchor: { id: row.id, seq: row.seq, at: row.at, chatId: row.chat_id },
        // timeline 自带 role: 'hit' | 'neighbor'
        items,
      };
    });

    /**
     * 查投递终态（阶段 5 的桥 3）：`GET /r/delivery?requestId=`
     *
     * 为什么需要这条桥：主动消息进审核（304023）时宿主拿到的是「待审核」，
     * 而审核事件（`MESSAGE_AUDIT_PASS` / `REJECT`）到的是**框架侧**。
     * 宿主不能靠等推送，只能下次写记忆前来问一次终态。
     *
     * 用 query 而不是 `/delivery/:id`：现有 `registerRoute` 都是固定路径，
     * 路径参数要改路由匹配，为一个查询接口不值。
     *
     * **查的是「整条」，不是「某一块」。** 超过 1800 字的回复会被切成几块，
     * 每块一个幂等键（`base#1`、`base#2`…）。只报第一块的状态会撒谎：
     * 第 2 块审核被驳了，这里还回 `sent`。所以走 `family` 聚合，
     * 单块时它的结果和 `get` 完全一样。
     */
    ctx.registerRoute?.('GET', '/delivery', async ({ query }) => {
      const rid = String(query?.requestId ?? '').trim();
      if (!rid) return { ok: false, message: '缺 requestId' };
      const fam = ctx.delivery?.family?.(rid) ?? null;
      if (!fam) {
        /**
         * 旧框架没有 `family`（升级前只认精确 id）时退回 `get`。
         * 报错文案照旧——不能因为框架老就说「查不到」，那会让人以为是自己的 id 错了。
         */
        const row = ctx.delivery?.get?.(rid);
        if (!row) {
          return { ok: false, gone: true, message: '没有这条投递记录（可能没开账本，或者 id 不对）' };
        }
        return {
          ok: true,
          state: row.state,
          msgId: row.msg_id || '',
          code: row.code || '',
          attempts: Number(row.attempts || 0),
          at: Number(row.settled_at || row.created_at || 0),
          parts: 1,
        };
      }
      return {
        ok: true,
        state: fam.state,              // pending / sent / audited / failed / unknown
        msgId: fam.msgId,
        code: fam.code,
        attempts: fam.attempts,
        at: fam.at,
        /** 这条逻辑消息被切成了几块。`sent` 要所有块都 `sent` 才算 */
        parts: fam.parts,
      };
    });

    ctx.registerRoute?.('POST', '/send', async ({ body }) => {
      const b = body ?? {};
      const scene = b.scene === 'group' ? 'group' : 'c2c';
      const target = String(b.target ?? '').trim();
      /** 幂等键：调用方（dsh-roost 的 qq_send）给，没有就照旧发一次 */
      const reqId = String(b.requestId ?? '').trim().slice(0, 120);

      /**
       * 主动消息的文本也是模型写的，所以同样要过一遍 `parseActions`：
       *   · 标记不能漏到用户眼前（`<<remember:>>` 这种以前漏过）；
       *   · `<<silence:2h>>` 在这里也要生效——主动搭话时她说「让我静静」
       *     同样得算数，不能只有被动回复那条路认。
       *
       * `silenceMs` 是给 dsh-roost 的 speakup 留的显式入口：
       * 它那边的 `raw.replace(/<<[^>]*>>/g, '')` 会先把标记全摘掉，
       * 所以时长只能单独传过来，不能指望文本里还留着。
       */
      const { text, actions } = parseActions(String(b.text ?? '').trim());
      const silMs = parseDuration(
        actions.find((a) => a.type === 'silence')?.value ?? '',
      );

      if (!target) return { ok: false, message: '缺 target（群 openid 或用户 openid）' };

      const extraMs = Math.min(Math.max(0, Number(b.silenceMs) || 0), 30 * 86_400_000);
      /**
       * **只带静默、没有正文是合法的。**
       * `<<silence:2h>>` 单独出现就是「我要安静，没什么要说的」——
       * 这时候既不该发一条空消息，也不该当成错误拒掉。
       */
      if (!text && silMs <= 0 && extraMs <= 0) {
        return { ok: false, message: '摘掉动作标记后没有内容可发' };
      }
      if (text.length > 2000) return { ok: false, message: '太长了，主动消息别超过 2000 字' };

      // 静默先设，即使后面发送失败也该生效（她决定的是「别说话」，不是「发完这条再说」）
      if (silMs > 0 && ctx.gate?.silence) {
        await ctx.gate.silence(target, silMs);
        ctx.logger.info(`[ai-chat] 主动消息里带了静默 ${Math.round(silMs / 60_000)} 分钟 · ${target.slice(0, 8)}`);
      }
      if (extraMs > 0 && ctx.gate?.silence) {
        await ctx.gate.silence(target, extraMs);
        ctx.logger.info(`[ai-chat] 按调用方要求静默 ${Math.round(extraMs / 60_000)} 分钟 · ${target.slice(0, 8)}`);
      }

      // 只设了静默，没有要说的话
      if (!text) return { ok: true, scene, target, id: '', pending: false, silentOnly: true };

      /**
       * 主动消息之前先问可达性。
       *
       * 官方**没有查好友的接口**，状态只能靠事件维护（框架 `src/reach.js`）。
       * 两层要分别判：`reach:not-friend` 是没加好友，`reach:push-off` 是
       * 加了好友但用户在资料卡里关掉了主动推送——后者最容易漏。
       *
       * **`unknown` 一律放行**：未知是「不知道」，不是「不行」。
       * 群里聊过的人很可能早就加了好友，只是还没私聊过；
       * 把未知当不可，会让主动搭话永远开不了口。
       *
       * `ctx.reach` 不存在时（旧框架）跳过检查，不拦。
       */
      if (scene === 'c2c') {
        const v = await ctx.reach?.canC2C?.(target);
        if (v?.verdict === 'no') {
          return {
            ok: false,
            reason: v.reason,
            message: v.reason === 'reach:push-off' ? '对方关闭了主动消息推送' : '对方没有加机器人好友',
          };
        }
      } else {
        const v = await ctx.reach?.canGroupPush?.(target);
        if (v?.verdict === 'no') {
          return { ok: false, reason: v.reason, message: '群管理员关闭了机器人的主动消息推送' };
        }
      }

      /**
       * 出口统一走 `ctx.push`。老框架没有这个方法的极端情况才退回 `ctx.api`，
       * 而且要**打日志**——静默退回等于额度账本又变回半真。
       */
      let send;
      if (typeof ctx.push === 'function') {
        /**
         * `requestId` 是投递账本的幂等键（阶段 5）。调用方给了就一路带到
         * `outbound.send`——同一个 id 再发一次不会重复，直接回上次的结果。
         */
        send = (t, txt) => ctx.push(t, txt, { kind: scene, requestId: reqId });
      } else {
        ctx.logger.warn('[ai-chat] 框架没有 ctx.push，主动消息绕过 outbound 直发（额度记账不生效），请升级框架');
        send = (t, txt) => (scene === 'group'
          ? ctx.api.sendGroup(t, { content: txt, msgType: 0 })
          : ctx.api.sendC2C(t, { content: txt, msgType: 0 }));
      }

      try {
        const r = await send(target, text);
        // 发成功 = 反证可达（他确实能收到）
        if (scene === 'c2c') await ctx.reach?.noteSendOk?.({ openid: target });
        ctx.logger.info(`[ai-chat] 主动发了 ${text.length} 字到 ${scene}:${target.slice(0, 8)}`);
        /**
         * `pending` = 主动消息进了审核（官方 304023）。
         * **既不是失败，也不是已送达**：调用方不能据此写「我说过」，
         * 否则审核不通过就变成她坚称自己说过一句没人看见的话。
         * 真正的状态判定留给投递账本（`docs/地基三块方案.md` 阶段 5）。
         */
        return { ok: true, scene, target, id: r?.id ?? '', pending: Boolean(r?.pending) };
      } catch (e) {
        ctx.logger.warn(`[ai-chat] 主动发消息失败：${e?.message ?? e}`);
        /**
         * 按 QQ 业务错误码回写可达性，下次就不用再试：
         *   40054004 无好友关系  → is_friend = 0
         *   40054013 用户拒收消息 → c2c_push = 0
         * 其它码（频控/内容违规/审核）不改状态，见 `reach.js` 的 noteSendError。
         *
         * outbound 自己判出来的错误（离线/超窗/额度）没有 `qqCode`，
         * 只是记一次失败时间，不动三态——那三种都跟「这个人能不能收到」无关。
         */
        if (scene === 'c2c' && e?.qqCode) {
          await ctx.reach?.noteSendError?.({ openid: target, qqCode: e.qqCode });
        }
        return {
          ok: false,
          code: e?.code ?? '', // offline / expired / quota / rate / api
          qqCode: e?.qqCode ?? 0,
          message: e?.message ?? String(e),
        };
      }
    });

    /** 消息合并：连着发的几句话攒成一段再回 */
    const merger = createMerger({
      waitSec: num(ctx.config.mergeWaitSec, 1.5, 0),
      maxSec: num(ctx.config.mergeMaxSec, 6, 1),
    });

    const pace = new PaceStore({
      cooldownSec: num(ctx.config.cooldownSec, 20),
      maxRepliesPerMin: num(ctx.config.maxRepliesPerMin, 3),
    });

    /**
     * 宿主回话通道。webhook / dsh 适配器用它等宿主把话说完；
     * 这条路由给宿主回调回话用，平时是空闲的。
     */
    const bridge = createBridge({ log: (m) => ctx.logger.warn(`[ai-chat] ${m}`) });

    /**
     * 健康检查：`GET /r/status`
     *
     * 为什么补这一条：dsh-roost 的 `channel.ping()` 一直在打 `/r/status`，
     * 而这边从来没注册过——404 被吞掉之后，那个方法就变成了「永远回
     * `{ok:false}`」的死代码。留着它是因为它要回答的问题是真的
     * （「ai-chat 到底在不在、用的是哪个模型」），只是以前没人答。
     *
     * 注册位置必须在 `bridge` 之后：`pending` 要读它的真实大小。
     * 写成 `ctx.bridge` 会永远是 0——那个字段不存在，可选链会把它
     * 悄悄吞掉，看起来一切正常。
     *
     * **不返回版本号**：版本号的真源是 `index.json`，在这里再写一份
     * 迟早会两边不一致，而不一致比没有更糟。
     */
    ctx.registerRoute?.('GET', '/status', async () => ({
      ok: true,
      plugin: 'ai-chat',
      /**
       * 有没有在跑的待回话事件。>0 说明插件正等着宿主把话说完——
       * 「她半天不回」时这是第一个要看的东西：卡在这边还是卡在宿主那边。
       */
      pending: bridge.size,
      /**
       * 宿主地址。**不报模型名**：模型是 DSH 那边选的，ai-chat 根本不知道，
       * 报一个自己猜的值比不报更糟（排查时会照着假答案往下走）。
       */
      dshUrl: conf().dshUrl,
    }));

    ctx.registerRoute('POST', '/reply', async ({ body, json }) => {
      const r = bridge.handleReply(body ?? {});
      return json(r.code, r.body);
    });
    ctx.onTeardown(() => {
      bridge.dispose();
      // 卸载时把还在攒的消息放出去，别让等着的 handler 永远挂着
      merger.flushAll();
    });

    /* ---------------- 适配器 ---------------- */

    let adapter = null;
    function getAdapter() {
      const c = conf();
      // 只剩 dsh 一个适配器了，不用再比对名字
      if (!adapter) {
        adapter = createAdapter({
          conf,
          bridge,
          publicUrl: () => conf().publicUrl,
          log: (m) => ctx.logger.info(`[ai-chat] ${m}`),
        });
      }
      return adapter;
    }

    async function callModel(messages, opts = {}) {
      return getAdapter().chat({ messages, ...opts });
    }

    /* ---------------- 说话人的权限 ---------------- */

    /**
     * 这一句是谁说的、什么权限。只给宿主用。
     *
     * **算不准就返回 null**——宿主拿不到权限信息时会按「身份不明」处理，
     * 只给聊天能力。错报成「普通成员」更危险：宿主可能因此放开工具。
     */
    async function senderInfo(msg) {
      try {
        if (ctx.isOwner?.(msg.userId)) {
          return { bucket: 'owner', level: 0, role: ctx.levelName?.(0) ?? '主人' };
        }
        const lv = await ctx.levelOf?.(msg);
        if (Number.isFinite(lv)) {
          return {
            // 四档：0 主人 / 1 管理员 / 2 群管 / 3 助手，其余是普通成员
            bucket: bucketOfLevel(lv),
            level: lv,
            role: ctx.levelName?.(lv) ?? '',
          };
        }
      } catch {
        // 权限查不出来就当不知道，别猜
      }
      return null;
    }

    /* ---------------- 提示词 ---------------- */

    /**
     * 拼 system。
     *
     * 三层：全局人设 → 场景人设 → 这个会话自己的（人设 + 记忆）。
     * `force` 为假时再追加一段「判断要不要接话」——只在需要它自己判断时才说，
     * 被 @ 时说这段反而会让它犹豫。
     */
    /**
     * @param {object} msg
     * @param {object} c 配置
     * @param {boolean} force 被 @ / 回复（不用判断要不要接）
     * @param {boolean} [ttsOn] 宿主那边语音能不能用。只有能用才把 `<<say>>` 给模型——
     *   给了却合成不出来，等于教它说一句用户永远听不到的话。
     */
    async function systemMessage(msg, c, force, ttsOn = false) {
      // 人设和记忆都由 dsh-roost 注入，这里只拼「动作标记」的契约
      const parts = [];

      if (!force) {
        parts.push(
          [
            '【判断要不要接话】',
            '这是群里的普通聊天，不一定在跟你说话。**大多数时候你不该接**。',
            `不需要你回应时（别人互相聊、自言自语、跟你无关、只是在说「哈哈哈」），只输出 ${SKIP_MARK}，不要输出任何别的内容。`,
            '确实该你说话时才回答，并且尽量短。',
          ].join('\n'),
        );
      }

      /**
       * 【你能发什么】——这一段必须写，而且要写清楚。
       *
       * 模型不会自己发现「我在 QQ 里能发按钮」。
       * 不告诉它，它就永远只发纯文本，官方接口这些能力全浪费了。
       */
      parts.push(
        [
          '【你能发什么】',
          '这个 QQ 机器人走的是**官方接口**，比一般机器人能做得多：',
          '· Markdown 真渲染：标题（##）、列表、加粗、代码块、引用块都能显示出来',
          '· 真按钮：用户能点的按钮',
          '· 图片和语音',
          '所以需要排版的时候放心用 Markdown；需要给用户几个选项时用按钮，别让人手打。',
        ].join('\n'),
      );

      /**
       * 告诉它「能收到什么」。
       *
       * 不写这段的后果（2026-11-03 实测）：用户发语音，官方 ASR 把转写
       * 放在正文里了，模型却回「我只看到『发了条语音』这几个字」——
       * 它把附件说明当成了全部内容，然后复读「我收不到语音」。
       * 这属于**对自身能力的误解**，只能靠提示词纠正。
       */
      parts.push(
        [
          '【你能收到什么】',
          '· 语音：官方会先把语音转成文字，你收到的就是那段文字。',
          '  转写不一定准（方言、太吵、说得太短都可能出错）。看不懂就直说没听清、请对方再说一遍，',
          '  **不要说自己收不到语音、看不到音频**——你收到的是文字，读它就行。',
          '· 图片：能直接看到图里的内容。正文里如果给了本地路径，说明这张图已经存下来了。',
        ].join('\n'),
      );

      parts.push(
        [
          '【动作标记】',
          /**
           * 记忆标记的**触发标准**。
           *
           * 以前这里只有一句「需要长期记住某件事」——什么算"需要"全凭模型猜，
           * 结果 214 条日记只落了 2 条事实（2026-10-31 实测）。抽取能力没问题
           * （合成输入召回 16/16），问题是**没人告诉它什么该记**。
           */
          '遇到下面这些，在回复里加 <<remember: 内容>>（跨群都记得）：',
          '  · 身份：他是谁、住哪、做什么、家里有谁',
          '  · 偏好：反复说喜欢或讨厌什么（一次性的玩笑不算）',
          '  · 习惯：他常怎么说话、什么时间出现',
          '  · 答应过的事：他说「下周给你答复」这种',
          '  例：<<remember: 主人住在杭州，养了一只柯基叫豆豆>>',
          '  例：<<remember: 他不喜欢被叫老板>>',
          '  不记：寒暄、一次性的吐槽、你自己的设定；手机号、身份证这类敏感信息也不要记。',
          '只想在这个群记住（梗、绰号）：加 <<remember-here: 内容>>',
          '要忘掉某件事：<<forget: 关键词>>',
          /**
           * 语义改口：同槽位取代只认字面相似（0.75），「住在杭州」→「搬到上海」
           * 这种它抓不到。模型知道自己在纠正哪句，所以给它一个显式入口。
           */
          '对方纠正以前说过的事（「我搬了」「不对，是…」）：<<replace: 旧说法 | 新说法>>',
          /**
           * Markdown 是**只有我们能做**的东西（OneBot 那边发不了真 Markdown），
           * 但滥用会像客服。规则一句话：信息密度高才上结构，日常说话说人话。
           */
          '需要列清单、做对比、贴代码/命令时，可以用 Markdown（列表、表格、代码块）——这个渠道能真渲染',
          '但日常聊天别用：一句话能说完的不要列表；表达情绪不要加粗，那看着像客服',
          /**
           * 文本链：官方支持的「嵌入交互」。**这是零指令的关键**——
           * 不用教用户记指令，直接把话替用户打好，他点一下就能发。
           */
          '想让人接话又不知道怎么开口时，可以把话替对方打好：<qqbot-cmd-input text="想说的话" />（只能私聊，群里不生效）',
          /**
           * @ 人：**教意图，不教语法**。
           *
           * 以前这里直接给了 `<qqbot-at-user id="他的 member_openid" />`，
           * 等于让模型手抄二十多位 openid——抄错一位官方不报错、只是没 @ 到人，
           * 线上根本看不出来。现在由宿主拼标签，模型只要说「@ 谁」。
           *
           * 群里每条消息头都会带 `[昵称 (openid)]`，需要 @ 刚才插话的人
           * 才把那个 id 填进来；@ 当前说话的人填 `sender` 就行。
           */
          '**群聊里默认不要 @ 人**：正常接话、闲聊、连续多轮对话都不 @，直接说话就行',
          '只有需要明确点名某个人（比如要专门回答 A 而不是接大家的话、或点名让某人注意）时才用发言工具的 at 参数（填 sender = 刚说话的人，或抄消息头括号里那串 id）',
          '**不要自己在正文里写 @ 的标签**——标签由宿主拼，你只说要 @ 谁',
          /**
           * 情绪标记：让情绪从"被动衰减"变成"有原因"。
           * 由宿主执行并摘掉，群里看不到这行标记。
           *
           * 三个轴的取值范围**必须写准**：valence 是 -1~1（正负两极），
           * energy / sociability 是 0~1（只有"多少"，没有负的）。
           * 以前这里含糊地写成"都是 -1~1 或 0~1"，模型就会给
           * `sociability=-0.5` 这种值——被 clamp 到 0 之后表现为"突然不理人"，
           * 面板上看就是"数值怪怪的"。
           */
          '你自己的情绪有变化时标一下：<<mood: valence=-0.3, reason=被凶了>>（valence 是 -1~1，energy 和 sociability 是 0~1，0.5 是平常；可以只写 reason）',
          '要改这个会话的人设：<<persona: 内容>>',
          '要清空这个会话的上下文：<<clear>>',
          '要发图片（表情包、画好的图）：<<image: 网址或本地路径>>',
          '要发语音：<<voice: 网址或本地路径>>',
          /**
           * `<<say>>` 只在宿主真的能合成时才教。
           *
           * 宿主语音默认关闭（`dsh-roost` 的 `tts.enabled`），而这一句是
           * 「你可以这样做」的许可。许可给了、能力没有，模型就会时不时
           * 输出一个被摘掉、用户什么也收不到的标记——比不说更糟。
           */
          ...(ttsOn ? ['想让你的话被念出来（语音条）：<<say: 要念的内容>>（会自动转成语音）'] : []),
          '要放按钮：<<button: 显示文字 | 点了之后发的话>>（一行最多两个，总共最多四个）',
          /**
           * 收尾**只在私聊给**。群里没有「聊完」这回事，一直有人说话，
           * 告诉它反而会到处收尾（宿主那边也会拒，但那是白费 token）。
           *
           * 状态归宿主（`dsh-roost/src/closing.js`）：这边只负责让它知道
           * 有这个动作，摘标记和落盘都在宿主。直连模式下没有觉醒机制，
           * 收尾本来也无处生效，摘干净就行。
           */
          ...(msg.kind === 'c2c'
            ? [
                '想给这段对话收个尾（对方说要睡了、要出门、话题自然聊完了）：<<close: 收在哪 | 下次怎么接>>',
                '  收尾不是道别，也不用特意说「那我先不打扰了」——它只是让她记住这段停在哪，下次接得上。',
                '  **对方还在问你问题时不要收尾**；没什么可收的就别写。',
              ]
            : []),
          '这些标记不会展示给用户，放在回复最后就行。不需要就不要写。',
        ].join('\n'),
      );

      const text = parts.join('\n\n');
      return text ? { role: 'system', content: text } : null;
    }

    /* ---------------- 动作标记 ---------------- */

    /** 执行模型要求的动作，返回给用户的确认话（没有就返回空串） */
    async function runActions(msg, actions) {
      if (!actions.length) return '';
      const done = new Set();

      for (const a of actions) {
        try {
          /**
           * 记忆和人设的标记**不在这里处理**——已经整体挪到 dsh-roost：
           *   · 情绪要调制记忆，两者必须同处一地
           *   · 抽取/摘要要调模型，ai-chat 4.0.0 之后调不了模型
           * 宿主会先摘掉这些标记再把干净文本回给我们，所以正常看不到它们。
           * 这里只留「清上下文」——那是纯本地的事。
           */
          if (a.type === 'clear') {
            store.reset(msg.chatId);
            done.add('上下文清了');
          } else if (a.type === 'silence') {
            /**
             * `<<silence:2h>>`：她自己决定安静一阵子。
             *
             * 这是唯一一个会**真的改变运行状态**的动作标记——别的标记改的是
             * 记忆或人设，这个会让机器人闭嘴。所以三个前提缺一不可：
             *   · 必须带时长（`parseDuration` 认不出来就是 0，直接不执行）；
             *   · 必须有上限（30 天，防 `9999h` 变成永久静默）；
             *   · 必须能自动到期（gate 存的是绝对时间戳，不靠定时器）。
             */
            const ms = parseDuration(a.value);
            if (ms > 0 && ctx.gate?.silence) {
              await ctx.gate.silence(msg.chatId, ms);
              done.add(`安静 ${a.value}`);
              ctx.logger.info(`[ai-chat] 她自己要求安静 ${a.value} · ${msg.chatId.slice(0, 8)}`);
            }
          }
        } catch (e) {
          ctx.logger.warn(`[ai-chat] 动作 ${a.type} 执行失败：${e.message}`);
        }
      }
      return done.size ? `${[...done].join('，')}。` : '';
    }

    /* ---------------- 主流程 ---------------- */

    /**
     * 收到一条消息。
     *
     * 这里会**一直 await 到回复发完**——因为 `msg.reply` 是攒到本次处理结束
     * 由内核合并发出的，提前 return 的话回复会留在缓冲里发不出去。
     */
    async function handle(msg) {
      const c = conf();
      bump('seen');

      /**
       * 机器人发的消息不接。
       *
       * 判据是官方的 `author.bot`，见 decide.js 的 `isFromBot`。
       * 判在**最前面**：这条消息连合并窗口、冷却、每分钟配额都不该进——
       * 机器人之间的对话会把人的额度吃光，人再说话就没额度了。
       *
       * 想让它俩聊就把「接机器人的话」打开（`answerBots`）。
       */
      if (!c.answerBots && isFromBot(msg)) {
        bump('bots', '对方是机器人');
        if (c.debug) {
          ctx.logger.debug(`[ai-chat] 不接（对方是机器人）：${String(msg.content).slice(0, 30)}`);
        }
        return;
      }

      /**
       * 这条已经被别的插件接了，别重复回答。
       *
       * 两种情况：
       *   · `claimedBy` —— 别的插件明确认领了（`msg.claim()` 或返回 true）
       *   · `replied`   —— 别的插件已经回过一句（我排最后，所以看得见）
       *
       * 第二道判断是必要的：有的老插件还没改造成认领模式，
       * 但它回过之后我再去接一句，群里就是两个人同时说话。
       */
      if (msg.claimedBy || msg.replied) {
        bump('claimed', '别的插件接过了');
        if (c.debug) ctx.logger.debug(`[ai-chat] 已被 ${msg.claimedBy || '别的插件'} 接过，不重复回答`);
        return;
      }

      const paceSt = pace.get(msg.chatId);
      const gate = shouldConsider(msg, c, paceSt);

      if (!gate.go) {
        /** 配额单独一类：它和「设了只在被 @ 时」是完全不同的两种原因 */
        const quota = /每分钟最多/.test(String(gate.reason));
        bump(quota ? 'quotaBlocked' : 'ruleBlocked', gate.reason);
        if (c.debug) ctx.logger.debug(`[ai-chat] 不接（${gate.reason}）：${String(msg.content).slice(0, 30)}`);
        return;
      }

      /**
       * 情绪闸门：社交意愿低的时候只接明确叫它的。
       *
       * 这是"有不想说的时候"的实现——比任何短句技巧都管用。
       * 被 @ / 被点名的（`gate.force`）不受影响：那是明确在叫它。
       */
      if (!gate.force && (await isLowMood())) {
        bump('moodBlocked', '社交意愿低');
        if (c.debug) ctx.logger.debug('[ai-chat] 不接（社交意愿低）');
        return;
      }

      /**
       * 没连上 DSH 时只在被明确叫到时提醒一句，否则静默——
       * 群聊里不该刷这个。
       *
       * 以前这里是「没配 API Key」，现在插件不直连模型了，
       * 缺的是 DSH 那边的地址（dsh-roost 没装 / 没启动）。
       */
      if (!c.dshUrl) {
        bump('noDsh', '没连上 DSH');
        if (gate.force) {
          await msg
            .reply(`还没连上 DSH。\n装一下 dsh-roost 插件，或者在设置里填 DSH 地址（默认 http://127.0.0.1:17321）。`)
            .catch(() => {});
        }
        return;
      }

      /**
       * 合并窗口：连着发的几句话攒成一段再回。
       *
       * 被 @ 的不等——那是在明确叫你，再等 1.5 秒就是迟钝。
       * 同一批里只有第一条会拿到 batch，其余返回 null 直接退出，
       * 否则三条消息会各跑一轮模型，等于没合并。
       */
      const batch = await merger.add({
        chatId: msg.chatId,
        msg,
        // 用 textOf：纯语音消息 content 是空的，ASR 结果在 attachments 里
        text: textOf(msg),
        name: msg.userName || '',
        // 多人合并时拼进正文，模型才能 @ 其中某个人（官方只认 openid）
        id: msg.userId || '',
        // QQ号：面板绑过才有。有它时正文里号码排在 openid 前面——
        // openid 换机器人就变，号码不变
        uin: msg.uin || '',
        // mergeWaitSec = 0 表示关闭合并，直接放行
        force: gate.force || c.mergeWaitSec === 0,
        // 冷却期攒着的消息，压到冷却结束再一起交
        delayMs: gate.cooldownLeftMs || 0,
      });
      if (!batch) {
        bump('merged', '合并进别的批次');
        return;
      }

      // 之后一律用批次里最后那条消息（msg_id 最新，回复窗口最稳）
      msg = batch.msg;

      // 攒的这段时间里，别的插件可能已经回了
      if (msg.claimedBy || msg.replied) {
        bump('claimed', '合并期间被别的插件接过了');
        return;
      }

      // 同一个会话同时只跑一轮：刷屏时不要并发一堆请求
      if (paceSt.busy) {
        /**
         * **等这一轮跑完，而不是把消息丢掉。**
         *
         * 真机实测（17:38:37–39 连发 5 条）：一轮耗时 4.2 秒，这 5 条全撞在
         * `paceSt.busy` 上被静默吃掉，连「上一条还在想」都不回，运行数据里
         * 「忙态丢掉」直接 +5。宿主侧的排队在**投递之后**，根本接不到这些消息。
         *
         * 三条边界：
         *   · 150ms 轮询，每轮都真的 sleep，不会自旋打满 CPU；
         *   · 上限 30 秒（远小于 QQ 的 180 秒被动回话窗口），等超时才算丢；
         *   · 多条同时等会自然串行：第一个同步拿到 `busy=true`，其余在下一个
         *     tick 看到仍旧忙，继续等下一轮，不会一起冲进模型。
         */
        const deadline = Date.now() + Math.min(30_000, (Number(c.timeoutSec) || 150) * 1000);
        while (paceSt.busy && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 150));
        }
        if (paceSt.busy) {
          bump('busyDropped', '等上一轮超时，仍然丢弃');
          if (c.debug) ctx.logger.debug(`[ai-chat] ${msg.chatId} 等上一轮超时，跳过`);
          return;
        }
        /** 只记「等过」，不占分母——这条消息接下来会正常计入某一类结果 */
        bump('busyWaited');
        if (c.debug) ctx.logger.debug(`[ai-chat] ${msg.chatId} 等上一轮结束，继续`);
        /** 等的这段时间里，别的插件可能已经回过话了 */
        if (msg.claimedBy || msg.replied) {
          bump('claimed', '等待期间被别的插件接过了');
          return;
        }
      }

      paceSt.busy = true;
      let s = null;
      let timer = null;
      /** 模型这一轮到底跑没跑成：用来防止 forwarded 和 failed 双计 */
      let modelRan = false;
      const started = Date.now();
      /**
       * 初始化必须自己有一层 try。
       *
       * 原来 `store.get()` 在**主 try 之外**，它一抛异常就绕过了 finally 里的
       * `paceSt.busy = false`——这个会话从此永久忙，后面每条都白等 30 秒再被丢，
       * 而且 `seen` 加了却不落任何结果类，面板分母会对不上。审校抓到的 P1。
       */
      try {
        paceSt.controller = new AbortController();
        s = store.get(msg.chatId);
      } catch (e) {
        paceSt.busy = false;
        paceSt.controller = null;
        bump('failed');
        ctx.logger.warn(`[ai-chat] 起轮失败：${e.message}`);
        return;
      }

      try {
        // 超时：到点直接中断，别让用户干等
        timer = setTimeout(() => {
          try {
            paceSt.controller.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
          } catch {}
        }, c.timeoutSec * 1000);
        timer.unref?.();

        /**
         * 语音能力：问宿主一次（30 秒缓存），决定要不要把 `<<say>>` 告诉模型。
         *
         * 放在拼 system 之前：这一轮的提示词和后面的发送必须用**同一个结论**，
         * 否则会出现「提示词里有 say、发送时却当成没开」。
         */
        const ttsOn = await hostTtsReady(c, { log: (m) => ctx.logger.info(`[ai-chat] ${m}`) });

        const sys = await systemMessage(msg, c, gate.force, ttsOn);

        /**
         * 下载图片给模型看（限张数限大小，任何一张失败都只是少看一张）。
         *
         * 同时**落一份到本地**：正文里给模型的是本地路径而不是 QQ 的 URL——
         * 那个 URL 有时效，模型拿它去 `<<image: url>>` 转发过一会儿就 404。
         *
         * `seeImages` 单独记一个布尔：关闭看图时 `images` 是空数组，
         * 但"没尝试下载"和"下载全失败"要给模型不同的说法。
         */
        /**
         * 附件要用**整批**的，不是最后一条的。
         *
         * 合并窗口里 `msg` 是最后一条（回复要挂它的 msg_id），而用户
         * 「先发图、再补一句话」时，图在前一条上——只看 `msg.attachments`
         * 就等于把图丢了。`batch.attachments` 是整批合并后的列表。
         */
        const attMsg = batch.attachments?.length
          ? { ...msg, attachments: batch.attachments }
          : msg;

        const seeImages = Boolean(c.seeImages && c.maxImages > 0);
        const images = seeImages
          ? await collectImages(attMsg, {
              max: c.maxImages,
              cacheDir: `${ctx.dataDir}/image-cache`,
              log: (m) => ctx.logger.warn(`[ai-chat] ${m}`),
            })
          : [];
        if (sys) {
          if (s.messages[0]?.role === 'system') s.messages[0] = sys;
          else s.messages.unshift(sys);
        } else if (s.messages[0]?.role === 'system') {
          s.messages.shift();
        }

        // 入站整形：语音 ASR、引用原文、合并转发、卡片都并进来
        // 合并过的批次用 batch.text（已带发言人），单条时两者等价
        s.messages.push({
          role: 'user',
          /**
           * `'off'` 而不是 `null`：关掉看图时模型必须知道"这张图我看不到"，
           * 否则它会照着 URL 编内容。`null` 留给结构化通道（`hostPayload`），
           * 那边图片另走 vision，不该下"看不到"的结论。
           */
          content: buildUserContent(attMsg, batch.text, { images: seeImages ? images : 'off' }),
        });
        store.trim(s);

        const { text, parts, requestIds = [], files = [], usage, model } = await callModel(s.messages, {
          signal: paceSt.controller.signal,
          /**
           * 宿主要用原始消息整形——**给整批附件的那个**，不是最后一条。
           *
           * 宿主拿 `msg` 去拼 `payload.rendered`，如果这里还是最后一条，
           * 那么「先发图、再补一句话」的批次在宿主侧看不到图：本地
           * `s.messages` 有图说明、`payload.images` 也有图块，唯独宿主
           * 自己渲染的那份正文里没有路径（2026-11-03 审查发现）。
           */
          msg: attMsg,
          chat: { kind: msg.kind, chatId: msg.chatId },
          // 权限档位给宿主，它据此决定给不给本地工具
          sender: await senderInfo(msg),
          /**
           * 把拼好的 system 一起送过去。
           *
           * DSH / webhook 这类宿主有自己的 persona，如果不把这份传过去，
           * 动作标记（skip / remember / image / button）的契约就丢了——
           * 模型根本不知道有这些标记可用。
           */
          system: sys?.content ?? '',
          // 图片块：宿主拿去做 image 内容块
          images,
          /**
           * 通道能力：宿主靠它判断能不能发只在 markdown 消息里生效的东西
           * （@ 人的 `<qqbot-at-user>` 标签）。关掉 markdown 的机器人在群里
           * 发标签只会把源码露出来，所以这个开关必须告诉宿主。
           */
          markdown: c.markdown,
          /**
           * 这一轮真正要交出去的正文。
           *
           * 合并窗口攒过几句时是 `batch.text`（多行、每行带发言人），
           * 只传 `msg.content` 会让宿主只看到最后一句——前几句等于没说过。
           */
          said: batch.text,
          batch,
        });

        /** 到这里才真跑过一轮模型：上面的 await 任一抛错都会进 catch，不计数 */
        bump('forwarded');
        modelRan = true;
        const { text: cleaned, actions } = parseActions(text);
        const confirm = await runActions(msg, actions);
        /**
         * 富媒体（图片 / 语音）单独发，不混进文本。
         * `let`：下面还要把分段 `qq_send` 参数里的动作并进来（见 segMedia）。
         */
        let media = actions.filter((a) => a.type === 'image' || a.type === 'voice');
        /**
         * 「把这句话念出来」的内容。
         *
         * **必须在这里取**：下面 `isSkip` 和「什么都没有就不发」两个早退都要看它。
         * 以前它在发送前才取，于是「正文留空、只想发语音」会被当成空回复直接丢掉，
         * 语音条永远发不出来——而且日志里看起来一切正常。
         *
         * 空值（`<<say:>>` / `<<say:   >>`）当没有：对象为真会绕过两个早退，
         * 结果记一条空回复、白占一次被动回复预算，实际什么都没发。
         */
        const say = actions.find((a) => a.type === 'say' && String(a.value ?? '').trim());
        /**
         * 模型写了 `<<file: 路径>>` 而不是调 `qq_send_file` 工具。
         *
         * 标记已经被 `parseActions` 摘掉了（不会漏到群里），但**文件也不会发**——
         * 路径校验只有宿主能做，这里没那个上下文。所以留一条 warn，
         * 否则「她说了要发文件、用户什么都没收到」在日志里连痕迹都没有。
         */
        const strayFiles = actions.filter((a) => a.type === 'file');
        if (strayFiles.length) {
          ctx.logger.warn(
            `[ai-chat] 模型写的是 <<file:>> 标记而不是工具，文件不会发出：${strayFiles.map((a) => a.value).join('、')}`,
          );
        }
        /** 可点击按钮——官方接口独有，hook 客户端那套发不出来 */
        const buttons = actions
          .filter((a) => a.type === 'button')
          .map((a) => parseButton(a.value))
          .filter(Boolean);

        /**
         * 不该接话：把这条用户消息**从上下文里撤掉**。
         *
         * 不撤的话，下次真说话时模型会看到一堆「自己没理的插话」，
         * 上下文全是噪音，而且它可能以为自己当时应该回答。
         *
         * **被 @ / 回复（force）时也要拦**：模型自己判断「这条不用回」是有效结论，
         * 把 `<skip>` 这几个字符原样发到群里是最糟的结果——以前只在「AI 自己判断」
         * 模式下检查，被叫到时模型一旦输出 `<skip>` 就会直接漏到群里。
         */
        if (isSkip(cleaned) && !confirm && !media.length && !files.length && !say) {
          if (s?.messages?.at(-1)?.role === 'user') s.messages.pop();
          // 被明确叫到却不吭声是反常的，留条 info 方便排查「@ 了没反应」
          if (gate.force) ctx.logger.info(`[ai-chat] ${msg.chatId.slice(0, 8)} 被叫但模型选择不回`);
          else if (c.debug) ctx.logger.debug(`[ai-chat] ${msg.chatId} 模型判断不接话`);
          return;
        }

        /**
         * 判定为「要回」时，正文里仍可能残留字面 `<skip>`
         * （模型会写「<skip> 不过这个问题我可以答」）。标记本身绝不能出现在群里。
         */
        const said = stripSkip(cleaned);

        /**
         * `<<retract>>`：模型想把**上一条**收回来（说错了、语气不对）。
         *
         * 顺序很关键：先记住「上一条是谁」，再发这条，发完才撤。
         * 群消息撤回窗口是 2 分钟，超了就不撤（撤了也白撤，还多一次请求）。
         *
         * 标记本身不能发出去，所以在拼正文**之前**就摘掉。
         * （以前是发出去之后再 `body = body.replace(...)`，而 body 是 const，
         *   模型一旦输出 `<<retract>>` 就抛 TypeError，整条回复变成报错。）
         */
        const { text: finalText, want: wantRetract } = takeRetract(said);
        const body = [finalText, confirm].filter(Boolean).join('\n\n');

        /**
         * 宿主分了几段说（`qq_send` 逐段发时才有）。
         *
         * 每段都过一遍 `stripSkip`：模型可能在工具参数里也写了 `<skip>`，
         * 而那个标记绝不能出现在群里。
         *
         * **还要过一遍 `parseActions`**：`<<mood:>>` / `<<remember:>>` 这类
         * 标记如果写在 `qq_send` 的参数里，宿主那边（dsh-roost）不一定拦得住，
         * 而这里直接按 `parts` 发原文——不摘就成了「标记原样出现在群里」。
         *
         * 以前这里只取 `.text`、把解析出来的 `actions` 丢了，于是「分两段说、
         * 第二段带图」时 `media` 为空，文字到了图一张都不发（日志连 sendMedia
         * 都没有）。现在把每段的动作也带下去交给 `segMedia` 统一收集。
         */
        /**
         * **幂等键必须在过滤之前和文本绑定**。
         *
         * `parts` 里可能有空串（宿主发了 `done:false` 但 text 为空），
         * 过滤后索引就错位了——`segs[1]` 会拿到本该属于空段的那个 id，
         * 于是「A 段发过了所以 B 段不发」。绑定在前、过滤在后，才错不了。
         */
        const paired =
          Array.isArray(parts) && parts.length > 1
            ? parts.map((p, i) => {
                const parsed = parseActions(stripSkip(String(p ?? '')));
                return {
                  text: parsed.text.trim(),
                  requestId: String(requestIds?.[i] ?? '').trim(),
                  actions: Array.isArray(parsed.actions) ? parsed.actions : [],
                };
              })
            : null;
        /**
         * 超过 `MAX_SEGMENTS` 的段**发不出去**，必须明确结算成失败。
         *
         * 不结算的话它们在账本里永远是 `pending`，重启后被 `recoverPending`
         * 转成 `unknown`——用户看到「结果未知」去核对，实际是「根本没发」。
         * **账本说了假话，比不记账更糟。**
         */
        const kept = paired ? paired.filter((x) => x.text).slice(0, MAX_SEGMENTS) : null;
        if (paired) {
          const dropped = paired.filter((x) => x.text).slice(MAX_SEGMENTS);
          for (const x of dropped) {
            if (x.requestId) ctx.delivery?.fail?.(x.requestId, 'truncated');
          }
          if (dropped.length) {
            ctx.logger.warn(`[ai-chat] 一轮最多 ${MAX_SEGMENTS} 段，${dropped.length} 段没发出去（已记失败）`);
          }
        }
        const segs = kept ? kept.map((x) => x.text) : null;
        /** 和 `segs` 一一对应；空串表示这一段没有幂等键 */
        const segIds = kept ? kept.map((x) => x.requestId) : [];
        /**
         * 分段里的富媒体动作并进 `media`。
         *
         * 必须在下面「什么都没有就不发」的早退判断**之前**定型：否则空 media
         * 直接 return，分段里的图片标记又白丢。只取被保留的段——被段数硬顶
         * 截断的段没发出去，它的图也不该发。
         */
        if (kept) {
          const segMedia = kept.flatMap(
            (x) => (x.actions || []).filter((a) => a.type === 'image' || a.type === 'voice'),
          );
          if (segMedia.length) media = media.concat(segMedia);
        }
        /**
         * 动作产生的补充话（比如「记下了」）跟着**最后一段**走。
         *
         * 放在这里而不是发送循环里：下面记上下文时要用到它，
         * 那时候各段必须已经是最终形态，否则上下文里少一句、
         * 下一轮模型就可能把同一句补充话再说一遍。
         */
        if (confirm && segs?.length) segs[segs.length - 1] += '\n\n' + confirm;
        // 既没话也没附件就不发；但要撤回上一条时还得往下走（撤回不靠这条文本）
        /**
         * 「只有语音」也算有内容。
         *
         * 不看 `ttsOn`：宿主没开语音时下面会把这句话**降级成文字**发出去。
         * 内容不该因为发不出语音就被吞掉——用户什么都没收到、上下文里却记着
         * 「我说过」，是这里最糟的一种失败。
         */
        if (!body && !segs?.length && !media.length && !files.length && !wantRetract && !say) return;

        /**
         * 上下文里记的是「**实际说出去的话**」。
         *
         * 多段时正文是空的（宿主用 `qq_send` 逐段发的），如果还按 `finalText` 记，
         * 模型下一轮会以为自己什么都没说，要么重复一遍、要么接不上。
         * 所以多段时把各段拼起来记。
         *
         * 只发语音时正文也是空的，这时记 `say` 的内容——那才是用户听到的话。
         */
        const spoken = segs?.length ? segs.join('\n') : (finalText || say?.value || '');
        const attachCount = media.length + files.length;
        s.messages.push({
          role: 'assistant',
          content: spoken || confirm || `（发了 ${attachCount} 个附件）`,
        });
        store.trim(s);
        s.rounds += 1;

        const prevSent = lastSent.get(msg.chatId);

        /**
         * 被动回复总次数预算：官方上限按场景取（群聊 5 / 单聊 4），见 `maxSegmentsOf(msg)`。
         *
         * **文本、图片、文件共用这一个预算**。以前这个变量只写在多段分支里，
         * 而媒体在分支外发——5 段文本 + 3 张图＝8 次请求，超出的部分
         * 框架会**静默降级成主动消息**（见 `src/outbound.js` 的 `downgrade`），
         * 白白消耗当天主动额度；群里没有 `group_push` 授权时是直接失败。
         *
         * 所以预算提到外面，后面每发一条都从同一个池子里扣。
         */
        let budget = maxSegmentsOf(msg);

        if (segs?.length) {
          /**
           * 多段回话：宿主用 `qq_send` 逐段发过（`done:false`），这里**逐条发出去**。
           *
           * 为什么不能交给 `planChunks`：它只在**超过 1800 字**时才切。
           * 而"分两段说"通常总共才十几个字，会被合并成一条——
           * 模型对"发几条"的控制就完全失效了，那 `qq_send` 调几次都一个样。
           *
           * 被动回复总次数预算：官方上限按场景取（群聊 5 / 单聊 4），见 `maxSegmentsOf(msg)`。
           * `MAX_SEGMENTS` 只限了段数，没限**每段再被切几块**——某段特别长时
           * `planChunks` 会再拆开，加起来就超过 5 次，框架这时会**静默降级成主动消息**
           * （见 `src/outbound.js` 的 `downgrade`），白白消耗当天主动额度。
           * 宁可少说一段，也不要偷偷烧额度。
           */
          ctx.logger.info(`[ai-chat] 分 ${segs.length} 段发（逐条独立消息）`);
          for (let i = 0; i < segs.length && budget > 0; i++) {
            const n = await sendReply(msg, segs[i], {
              markdown: c.markdown,
              /** 这一段的幂等键（阶段 5）。没有就空串，行为不变 */
              requestId: segIds[i] || '',
              /** 按钮只挂最后一段：挂前面的话，用户点完还得等后面几条才看到结果 */
              keyboard: i === segs.length - 1 && buttons.length ? buildKeyboard(buttons) : null,
              log: (m) => ctx.logger.warn(`[ai-chat] ${m}`),
              /**
               * **多段时不能流式。**
               *
               * 流式是「一条消息不断变长」（`replace` 模式），
               * 多段要的是「发几条独立消息」——语义冲突，只能二选一。
               */
              stream: false,
              /**
               * **必须绕过攒批。**
               *
               * 框架的 `msg.reply` 是攒到本次处理结束再由 `flushReplies()` 合并成一条的
               * （见 `src/message.js` 的 `replyBuf`）。多个插件各回一句时这是对的，
               * 但这里要的是「几条独立消息」——走 `reply` 的话循环发五段，
               * 用户只看到一条拼起来的，`qq_send` 调几次都一样。
               * `immediate` 内部改走 `msg.replyNow()`，立刻发。
               */
              immediate: true,
              onSent: (id) => {
                if (id) lastSent.set(msg.chatId, { id, at: Date.now() });
              },
            });
            // 没发出去也扣一格——失败大概率是同一原因，别接着试
            budget -= Math.max(1, n || 0);
          }
        } else if (body) {
          const n = await sendReply(msg, body, {
            markdown: c.markdown,
            /**
             * 单段路径：幂等键只给**这一条**。
             *
             * 单段时 `sendReply` 内部可能按 1800 字切成几块发出去，
             * 但那是**发送层**的事——语义上「一次 `qq_send` = 一段」，
             * 切成几块只是为了过长度限制。所以整条共用一个 id。
             */
            requestId: String(requestIds?.[0] ?? '').trim(),
            keyboard: buttons.length ? buildKeyboard(buttons) : null,
            log: (m) => ctx.logger.warn(`[ai-chat] ${m}`),
            // 私聊走流式（群聊没这个接口，框架内部会降级），带按钮时不流式
            stream: !buttons.length,
            // 记住这次发出去的 id，下一轮要撤的就是它
            onSent: (id) => {
              if (id) lastSent.set(msg.chatId, { id, at: Date.now() });
            },
          });
          /** 单段也可能被 `planChunks` 再切成几块，按实际发出去的条数扣预算 */
          budget -= Math.max(1, n || 0);
        }

        if (wantRetract && prevSent?.id && Date.now() - prevSent.at < 110_000) {
          try {
            await msg.retract?.(prevSent.id);
            ctx.logger.info(`[ai-chat] 撤回了上一条（${prevSent.id}）`);
          } catch (e) {
            ctx.logger.warn(`[ai-chat] 撤回失败：${e?.message ?? e}`);
          }
        }

        /**
         * 附件放最后发：`replyImage` / `replyFile` 都会先把攒着的文本 flush 掉，
         * 所以顺序天然是「先说一句，再上附件」。
         *
         * **预算分配上文件优先**（虽然发送顺序是图在前）。
         * 交付物比配图重要：正文 4 块 + 1 张图 + 1 个文件时，先挑图就会把
         * 最后一格吃掉，文件一个都发不出去——而宿主早在轮中就回了 `ok:true`、
         * 模型也跟人说了「发你了」。少一张图没人会怪，少一个文件就是事故。
         *
         * 两者**共用同一个 `budget`**（按 `maxSegmentsOf(msg)` 分场景取）。超了宁可少发，
         * 也不能让框架把剩下的偷偷降级成主动消息——那既烧当天额度，
         * 群里没有 `group_push` 授权时还会直接失败。
         */
        const fileRoom = Math.min(files.length, Math.max(0, budget));
        const mediaRoom = Math.max(0, budget - fileRoom);

        if (media.length) {
          if (mediaRoom <= 0) {
            ctx.logger.warn(`[ai-chat] 被动回复次数不够，${media.length} 个附件没发（给文件让位）`);
          } else {
            /**
             * 不预切：`sendMedia` 自己按「**发出去几个**」算上限。
             * 先切再过滤会让一条无效项白占一格（`[无扩展名, 图1, 图2]` 在
             * max=2 时只剩前两个，图2 被裁掉，用户少收一张还不报错）。
             */
            const sentN = await sendMedia(msg, media, {
              max: mediaRoom,
              log: (m) => ctx.logger.warn(`[ai-chat] ${m}`),
            });
            if (media.length > (sentN || 0)) {
              /**
               * 实际生效的上限是传进 sendMedia 的 `mediaRoom`。以前这里打印的是
               * `MAX_MEDIA`（未传 max 时的默认值），排查时会误以为附件是被 3 格
               * 硬顶裁掉的，方向全错。报真正生效的值与发出数量即可。
               */
              ctx.logger.warn(`[ai-chat] ${media.length - (sentN || 0)} 个附件没发出去（本次上限 ${mediaRoom} 格，发出 ${sentN || 0} 个）`);
            }
            /**
             * 按**占用过的次数**扣，不是「成功几个」。
             *
             * 框架的 `#nextSeq` 是**发请求之前**就自增并记账的（`api.js`），
             * 所以一次失败的尝试照样占掉一格。以前这里按成功数扣，
             * 图全失败时一格没扣，后面的文件继续发 → 撞
             * 「同一条消息最多回复 5 次」，报错却指向文件，排查方向全错。
             *
             * `Math.max(1, …)` 是兜底：真的发起了请求就至少扣一格。
             */
            budget -= Math.max(1, sentN || 0);
          }
        }

        /**
         * 文件（`qq_send_file` 挂上来的绝对路径）。
         *
         * 走 `msg.replyFile` —— 和图片同一条被动回复通道（`msg_type=7` 带 `msg_id`），
         * **不消耗主动额度**，群里也不需要 `group_push` 授权。
         * 直传 / 分片由框架按文件大小自己选（≤5MB 直传，>5MB 分片），这里不用管。
         */
        for (const f of files) {
          if (budget <= 0) {
            ctx.logger.warn(`[ai-chat] 被动回复次数用完，文件没发出去：${f}`);
            break;
          }
          /** 先扣再发：发失败也占了一次尝试，不该接着把预算耗在同一件事上 */
          budget -= 1;
          try {
            const r = await msg.replyFile?.(f, { local: true });
            if (r) ctx.logger.info(`[ai-chat] 文件已发：${f}`);
            else {
              /**
               * `replyFile` 失败时只回 null（框架内部已经 `log.error` 过原因），
               * 所以这里**别猜原因**。以前写的是「附件过多/被平台拒/超限」，
               * 而真实情况可能是上传成功、发消息时官方回 500「系统繁忙」——
               * 照那句文案去查「附件过多」会白查半天（2026-11-02 实际发生）。
               */
              ctx.logger.warn(
                `[ai-chat] 文件没发出去：${f}`
                + '（原因看同一时刻 message 的 ERROR 行；若是 5xx「系统繁忙」，隔几秒重发通常就好）',
              );
            }
          } catch (e) {
            ctx.logger.warn(`[ai-chat] 文件发送失败：${f} · ${e?.message ?? e}`);
          }
        }

        /**
         * 念一段话（语音条）。
         *
         * 合成在宿主（`POST /tts`，provider 由用户在 dsh-roost 里选），
         * 这里只做后半段：拿到的 mp3/wav → PCM → silk（QQ 只认 silk）。
         *
         * **语音条也吃同一份被动回复预算**：它是「同一句话的语音版」，
         * 排在文件之后。以前它在预算外，于是「4 块正文 + 1 图 + 语音」
         * 会打出第 6 次请求，被框架静默降级成主动消息。
         *
         * 失败分两种，都要有下文：
         *   · 正文已经发过（常见）→ 少了语音不影响对话，记一行 warn 就够
         *   · 正文是空的（只发语音）→ **把这句话当文字补发**，否则用户零输出，
         *     而上下文里已经记着「我说过」
         */
        if (say && budget > 0) {
          if (!ttsOn) {
            /**
             * 宿主没开语音（或这一轮的缓存说不可用），但模型还是写了 `<<say>>`
             * ——可能来自历史上下文。标记已经被摘掉，用户不会看到它；
             * 这里留一行 warn，免得「她明明说要念，怎么没声音」无从查起。
             */
            ctx.logger.warn('[ai-chat] 模型写了 <<say>>，但宿主语音没启用，这段没有语音');
            /** 纯语音（正文为空）时还得把话补发出去，否则用户什么都没收到 */
            if (!body && !segs?.length && budget > 0) {
              budget -= 1;
              await msg.reply(say.value).catch(() => {});
            }
          } else {
            budget -= 1;
            const file = await synthesize(c, say.value, {
              cacheDir: `${ctx.dataDir}/tts-cache`,
              log: (m) => ctx.logger.warn(`[ai-chat] ${m}`),
            });
            if (file) {
              await msg.replyVoice?.(file, { local: true });
            } else if (!body && !segs?.length && budget > 0) {
              /**
               * **合成失败时不能什么都不发。**
               *
               * 上面那句注释的前提是「文字已经发过了」——但纯语音路径下
               * 正文本来就是空的。这时静默跳过 = 用户零输出，而上下文里
               * 已经记了「我说过这句话」，模型下一轮会以为对方听到了。
               * 语音发不出去，就把同一句话当文字发出去。
               */
              budget -= 1;
              ctx.logger.warn('[ai-chat] 语音合成失败，改用文字发这句话');
              await msg.reply(say.value).catch(() => {});
            }
          }
        }

        // 只有「主动接话」才计入节奏，被 @ 的不占配额
        if (!gate.force) pace.markReply(msg.chatId);

        if (c.debug) {
          const tok = usage ? ` · ${usage.prompt_tokens}+${usage.completion_tokens} tok` : '';
          ctx.logger.info(
            `[ai-chat] ${msg.chatId.slice(0, 8)} ${model} ${Date.now() - started}ms${tok}${gate.force ? ' · 被叫' : ''}`,
          );
        }
      } catch (e) {
        /**
         * 只在**模型没跑成**时记 failed。
         *
         * `modelRan` 之后的发送环节（`emit` / `replyVoice`）也可能抛错，
         * 但那时这一轮确实跑过模型、已经计了 forwarded；再计 failed
         * 会让分母变负（seen - forwarded - failed = -1）。
         */
        if (!modelRan) bump('failed');
        const name = e?.name ?? '';
        if (name === 'AbortError') {
          if (c.debug) ctx.logger.info(`[ai-chat] ${msg.chatId} 已中断`);
        } else if (name === 'TimeoutError') {
          // 只在被明确叫到时才说「超时了」，否则安静点
          if (gate.force) await msg.reply(`模型 ${c.timeoutSec} 秒没回，先放弃了。`).catch(() => {});
        } else {
          const friendly = e?.message || '调用失败';
          ctx.logger.warn(`[ai-chat] 调用失败：${friendly}`);
          if (gate.force) await msg.reply(`出错了：${friendly}`).catch(() => {});
        }
        // 失败就把这轮的提问撤掉，免得下一轮带着「没答上的问题」继续
        if (s?.messages?.at(-1)?.role === 'user') s.messages.pop();
      } finally {
        if (timer) clearTimeout(timer);
        paceSt.busy = false;
        paceSt.controller = null;
        s.lastAt = Date.now();
      }
    }

    ctx.on('message', handle);

    /* ---------------- 定时清扫 ---------------- */

    ctx.schedule('ai-chat-sweep', 60_000, () => {
      pace.sweep();
      store.evictIdle();
    });
  },
};

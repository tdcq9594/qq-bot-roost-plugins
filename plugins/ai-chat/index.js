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
import { shouldConsider, isSkip, stripSkip, takeRetract, parseActions, parseButton, textOf, isFromBot, SKIP_MARK, DEFAULT_IGNORE } from './decide.js';
import { ChatStore, PaceStore } from './session.js';
import { createMerger } from './merge.js';
import { collectImages } from './vision.js';
import { synthesize, DEFAULT_VOICE } from './tts.js';

/** 一次请求最多等多久 */
const DEFAULT_TIMEOUT_SEC = 90;

/**
 * 宿主一次最多回几段（`qq_send` 逐段发）。
 *
 * 宿主管自己的上限（`dsh-roost` 的 `qqTools.maxParts`，默认 3），
 * 这里只是**兜底硬顶**——webhook 那类宿主万一一次塞几十段，
 * 不能让它把群刷爆。QQ 被动回复本身也只让回 5 次（msg_seq 1–5）。
 */
const MAX_SEGMENTS = 5;

export default {
  id: 'ai-chat',
  name: 'AI 对话',
  version: '4.3.5',
  description: '群里说什么都看得见，自己判断该不该接话；不占用任何指令前缀',
  frameworkVersion: '>=0.8.1',

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
        { value: 'mention', label: '只在被 @ 或回复时说话' },
      ],
      label: '什么时候接话',
      desc: '「AI 自己判断」= 群里每条消息都看一眼，该接才接；「只在被叫到时」= 其余消息完全不理，最省 token',
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
    ttsVoice: {
      type: 'string',
      default: '',
      label: '语音音色',
      desc: '填微软音色名就开启语音，例如 zh-CN-XiaoxiaoNeural（女）、zh-CN-YunxiNeural（男）。'
        + '留空 = 不合成语音。需要先在插件目录 npm i @andresaya/edge-tts mpg123-decoder silk-wasm',
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

    const num = (v, def, min = 0) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= min ? n : def;
    };

    /** 配置每次现读：面板改完立刻生效，不用重启 */
    const conf = () => {
      const c = ctx.config ?? {};
      return {
        decide: c.decide === 'mention' ? 'mention' : 'ai',
        cooldownSec: num(c.cooldownSec, 20),
        mergeWaitSec: num(c.mergeWaitSec, 1.5, 0),
        mergeMaxSec: num(c.mergeMaxSec, 6, 1),
        seeImages: c.seeImages !== false,
        maxImages: num(c.maxImages, 4, 0),
        ttsVoice: String(c.ttsVoice || '').trim(),
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
          if (Number.isFinite(lv)) bucket = lv <= 1 ? 'admin' : 'member';
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
     * 配额提醒：官方主动消息 **20 条/分钟、每群 1000 条/天**。
     * 限频的责任在调用方，这里只做基本校验。
     */
    ctx.registerRoute?.('POST', '/send', async ({ body }) => {
      const b = body ?? {};
      const scene = b.scene === 'group' ? 'group' : 'c2c';
      const target = String(b.target ?? '').trim();
      const text = String(b.text ?? '').trim();

      if (!target) return { ok: false, message: '缺 target（群 openid 或用户 openid）' };
      if (!text) return { ok: false, message: '缺 text' };
      if (text.length > 2000) return { ok: false, message: '太长了，主动消息别超过 2000 字' };

      try {
        const opts = { content: text, msgType: 0 };
        if (scene === 'group') await ctx.api.sendGroup(target, opts);
        else await ctx.api.sendC2C(target, opts);
        ctx.logger.info(`[ai-chat] 主动发了 ${text.length} 字到 ${scene}:${target.slice(0, 8)}`);
        return { ok: true, scene, target };
      } catch (e) {
        ctx.logger.warn(`[ai-chat] 主动发消息失败：${e?.message ?? e}`);
        return { ok: false, message: e?.message ?? String(e) };
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
            // 框架里 0 = 主人、1 = 管理员，数字越小权限越高
            bucket: lv <= 1 ? 'admin' : 'member',
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
    async function systemMessage(msg, c, force) {
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

      parts.push(
        [
          '【动作标记】',
          '需要长期记住某件事：在回复里加 <<remember: 内容>>（跨群都记得）',
          '只想在这个群记住（梗、绰号）：加 <<remember-here: 内容>>',
          '要忘掉某件事：<<forget: 关键词>>',
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
          '想 @ 群里某个人时，用发言工具的 at 参数（填 sender 就是刚说话的人，或者抄消息头括号里那串 id）',
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
          '想让你的话被念出来（语音条）：<<say: 要念的内容>>（会自动转成语音）',
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
        if (c.debug) ctx.logger.debug(`[ai-chat] 已被 ${msg.claimedBy || '别的插件'} 接过，不重复回答`);
        return;
      }

      const paceSt = pace.get(msg.chatId);
      const gate = shouldConsider(msg, c, paceSt);

      if (!gate.go) {
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
        // mergeWaitSec = 0 表示关闭合并，直接放行
        force: gate.force || c.mergeWaitSec === 0,
        // 冷却期攒着的消息，压到冷却结束再一起交
        delayMs: gate.cooldownLeftMs || 0,
      });
      if (!batch) return;

      // 之后一律用批次里最后那条消息（msg_id 最新，回复窗口最稳）
      msg = batch.msg;

      // 攒的这段时间里，别的插件可能已经回了
      if (msg.claimedBy || msg.replied) return;

      // 同一个会话同时只跑一轮：刷屏时不要并发一堆请求
      if (paceSt.busy) {
        if (c.debug) ctx.logger.debug(`[ai-chat] ${msg.chatId} 上一轮还没完，跳过`);
        return;
      }

      paceSt.busy = true;
      paceSt.controller = new AbortController();
      const s = store.get(msg.chatId);
      const started = Date.now();
      let timer = null;

      try {
        // 超时：到点直接中断，别让用户干等
        timer = setTimeout(() => {
          try {
            paceSt.controller.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
          } catch {}
        }, c.timeoutSec * 1000);
        timer.unref?.();

        const sys = await systemMessage(msg, c, gate.force);

        /** 下载图片给模型看（限张数限大小，任何一张失败都只是少看一张） */
        const images = c.seeImages && c.maxImages > 0
          ? await collectImages(msg, { max: c.maxImages, log: (m) => ctx.logger.warn(`[ai-chat] ${m}`) })
          : [];
        if (sys) {
          if (s.messages[0]?.role === 'system') s.messages[0] = sys;
          else s.messages.unshift(sys);
        } else if (s.messages[0]?.role === 'system') {
          s.messages.shift();
        }

        // 入站整形：语音 ASR、引用原文、合并转发、卡片都并进来
        // 合并过的批次用 batch.text（已带发言人），单条时两者等价
        s.messages.push({ role: 'user', content: buildUserContent(msg, batch.text) });
        store.trim(s);

        const { text, parts, usage, model } = await callModel(s.messages, {
          signal: paceSt.controller.signal,
          // 宿主要用原始消息整形
          msg,
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
        });

        const { text: cleaned, actions } = parseActions(text);
        const confirm = await runActions(msg, actions);
        /** 富媒体（图片 / 语音）单独发，不混进文本 */
        const media = actions.filter((a) => a.type === 'image' || a.type === 'voice');
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
        if (isSkip(cleaned) && !confirm && !media.length) {
          if (s.messages.at(-1)?.role === 'user') s.messages.pop();
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
         * 动作本身已经在上面对整段 `text` 解析时收集过了，这里只借用它的清理能力。
         */
        const segs =
          Array.isArray(parts) && parts.length > 1
            ? parts
                .map((p) => parseActions(stripSkip(String(p ?? ''))).text.trim())
                .filter(Boolean)
                .slice(0, MAX_SEGMENTS)
            : null;
        /**
         * 动作产生的补充话（比如「记下了」）跟着**最后一段**走。
         *
         * 放在这里而不是发送循环里：下面记上下文时要用到它，
         * 那时候各段必须已经是最终形态，否则上下文里少一句、
         * 下一轮模型就可能把同一句补充话再说一遍。
         */
        if (confirm && segs?.length) segs[segs.length - 1] += '\n\n' + confirm;
        // 既没话也没附件就不发；但要撤回上一条时还得往下走（撤回不靠这条文本）
        if (!body && !segs?.length && !media.length && !wantRetract) return;

        /**
         * 上下文里记的是「**实际说出去的话**」。
         *
         * 多段时正文是空的（宿主用 `qq_send` 逐段发的），如果还按 `finalText` 记，
         * 模型下一轮会以为自己什么都没说，要么重复一遍、要么接不上。
         * 所以多段时把各段拼起来记。
         */
        const spoken = segs?.length ? segs.join('\n') : finalText;
        s.messages.push({ role: 'assistant', content: spoken || confirm || `（发了 ${media.length} 个附件）` });
        store.trim(s);
        s.rounds += 1;

        const prevSent = lastSent.get(msg.chatId);

        if (segs?.length) {
          /**
           * 多段回话：宿主用 `qq_send` 逐段发过（`done:false`），这里**逐条发出去**。
           *
           * 为什么不能交给 `planChunks`：它只在**超过 1800 字**时才切。
           * 而"分两段说"通常总共才十几个字，会被合并成一条——
           * 模型对"发几条"的控制就完全失效了，那 `qq_send` 调几次都一个样。
           *
           * 被动回复总次数预算：官方「同一条消息最多回 5 次」（`msg_seq` 1–5）。
           * `MAX_SEGMENTS` 只限了段数，没限**每段再被切几块**——某段特别长时
           * `planChunks` 会再拆开，加起来就超过 5 次，框架这时会**静默降级成主动消息**
           * （见 `src/outbound.js` 的 `downgrade`），白白消耗当天主动额度。
           * 宁可少说一段，也不要偷偷烧额度。
           */
          let budget = MAX_SEGMENTS;
          ctx.logger.info(`[ai-chat] 分 ${segs.length} 段发（逐条独立消息）`);
          for (let i = 0; i < segs.length && budget > 0; i++) {
            const n = await sendReply(msg, segs[i], {
              markdown: c.markdown,
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
          await sendReply(msg, body, {
            markdown: c.markdown,
            keyboard: buttons.length ? buildKeyboard(buttons) : null,
            log: (m) => ctx.logger.warn(`[ai-chat] ${m}`),
            // 私聊走流式（群聊没这个接口，框架内部会降级），带按钮时不流式
            stream: !buttons.length,
            // 记住这次发出去的 id，下一轮要撤的就是它
            onSent: (id) => {
              if (id) lastSent.set(msg.chatId, { id, at: Date.now() });
            },
          });
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
         * 富媒体放最后发：`replyImage` 会先把攒着的文本 flush 掉，
         * 所以顺序天然是「先说一句，再上图」。
         */
        if (media.length) {
          await sendMedia(msg, media, { log: (m) => ctx.logger.warn(`[ai-chat] ${m}`) });
        }

        /**
         * 念一段话（语音条）。
         *
         * QQ 语音要 **silk**，TTS 出的是 mp3，所以中间转两道：
         * 文字 → mp3 → PCM → silk。全在 tts.js 里，纯 JS/WASM，不要 Python。
         *
         * 任何一步失败都只是「这条没有语音」——文字已经发过了，不影响对话。
         */
        const say = actions.find((a) => a.type === 'say');
        if (say && c.ttsVoice) {
          const file = await synthesize(say.value, {
            voice: c.ttsVoice,
            cacheDir: `${ctx.dataDir}/tts-cache`,
            log: (m) => ctx.logger.warn(`[ai-chat] ${m}`),
          });
          if (file) await msg.replyVoice?.(file, { local: true });
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
        if (s.messages.at(-1)?.role === 'user') s.messages.pop();
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

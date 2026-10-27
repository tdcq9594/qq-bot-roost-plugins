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
import { createProfile } from './profile.js';
import { shouldConsider, isSkip, parseActions, parseButton, textOf, SKIP_MARK, DEFAULT_IGNORE } from './decide.js';
import { ChatStore, PaceStore } from './session.js';
import { createMerger } from './merge.js';
import { collectImages } from './vision.js';
import { synthesize, DEFAULT_VOICE } from './tts.js';

/** 一次请求最多等多久 */
const DEFAULT_TIMEOUT_SEC = 90;

export default {
  id: 'ai-chat',
  name: 'AI 对话',
  version: '4.0.0',
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

    systemPrompt: {
      type: 'textarea',
      default:
        '你在一个 QQ 群里聊天。回答简短口语化，通常两三句话就够，别写长篇大论。' +
        '可以用 Markdown 排版，但别为了排版而排版。不确定的事直说不确定，不要编。',
      label: '人设',
      desc: '所有会话共用的系统提示词',
    },
    groupPrompt: {
      type: 'textarea',
      default: '',
      label: '群聊追加人设',
      desc: '只在群里生效，叠加在「人设」后面',
    },
    directPrompt: {
      type: 'textarea',
      default: '',
      label: '私聊追加人设',
      desc: '只在私聊生效，叠加在「人设」后面',
    },

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
  },

  /** @param {object} ctx Roost 插件上下文 */
  setup(ctx) {
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
        systemPrompt: String(c.systemPrompt ?? '').trim(),
        groupPrompt: String(c.groupPrompt ?? '').trim(),
        directPrompt: String(c.directPrompt ?? '').trim(),
        markdown: c.markdown !== false,
        timeoutSec: num(c.timeoutSec, DEFAULT_TIMEOUT_SEC, 5),
        dshUrl: String(c.dshUrl ?? 'http://127.0.0.1:17321').trim().replace(/\/+$/, ''),
        publicUrl: String(c.publicUrl ?? 'http://127.0.0.1:8080').trim().replace(/\/+$/, ''),
        debug: Boolean(c.debug),
      };
    };

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
    const profile = createProfile({ storage: ctx.storage });

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
      const extra = msg.kind === 'c2c' ? c.directPrompt : c.groupPrompt;
      const mine = await profile.systemExtra(msg.chatId);

      const parts = [c.systemPrompt, extra, mine].filter(Boolean);

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
          '需要长期记住某件事：在回复里加 <<remember: 内容>>',
          '要忘掉某件事：<<forget: 关键词>>',
          '要改这个会话的人设：<<persona: 内容>>',
          '要清空这个会话的上下文：<<clear>>',
          '要发图片（表情包、画好的图）：<<image: 网址或本地路径>>',
          '要发语音：<<voice: 网址或本地路径>>',
          '想让你的话被念出来（语音条）：<<say: 要念的内容>>（会自动转成语音）',
          '要放按钮：<<button: 显示文字 | 点了之后发的话>>（一行最多两个，总共最多四个）',
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
          if (a.type === 'remember' && a.value) {
            await profile.addFact(msg.chatId, a.value);
            done.add('记住了');
          } else if (a.type === 'forget' && a.value) {
            await profile.removeFact(msg.chatId, a.value);
            done.add('忘掉了');
          } else if (a.type === 'persona' && a.value) {
            await profile.setPersona(msg.chatId, a.value);
            done.add('人设改了');
          } else if (a.type === 'clear') {
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

        const { text, usage, model } = await callModel(s.messages, {
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
         */
        if (!gate.force && isSkip(cleaned) && !confirm && !media.length) {
          if (s.messages.at(-1)?.role === 'user') s.messages.pop();
          if (c.debug) ctx.logger.debug(`[ai-chat] ${msg.chatId} 模型判断不接话`);
          return;
        }

        const body = [cleaned, confirm].filter(Boolean).join('\n\n');
        // 既没话也没附件，就什么都不发
        if (!body && !media.length) return;

        s.messages.push({ role: 'assistant', content: cleaned || confirm || `（发了 ${media.length} 个附件）` });
        store.trim(s);
        s.rounds += 1;

        if (body) {
          await sendReply(msg, body, {
            markdown: c.markdown,
            keyboard: buttons.length ? buildKeyboard(buttons) : null,
            log: (m) => ctx.logger.warn(`[ai-chat] ${m}`),
          });
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

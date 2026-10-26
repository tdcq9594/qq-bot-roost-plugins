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

import { createAdapter, ADAPTER_OPTIONS } from './adapter/index.js';
import { createBridge } from './adapter/bridge.js';
import { buildUserContent } from './inbound.js';
import { sendReply } from './outbound.js';
import { createProfile } from './profile.js';
import { shouldConsider, isSkip, parseActions, SKIP_MARK, DEFAULT_IGNORE } from './decide.js';
import { ChatStore, PaceStore } from './session.js';

/** 一次请求最多等多久 */
const DEFAULT_TIMEOUT_SEC = 90;
const DEFAULT_MODEL = 'deepseek-flash';

/** 常用的模型别名，省得用户记全名 */
const MODEL_ALIAS = { flash: 'deepseek-flash', pro: 'deepseek-v4-pro' };
const aliasModel = (m) => MODEL_ALIAS[m] ?? m;

/** HTTP 错误翻成人话 */
function explainHttp(status, bodyText = '') {
  const detail = String(bodyText).slice(0, 160);
  if (status === 401 || status === 403) return 'API Key 不对或没有权限，去面板「插件 → AI 对话 → 设置」重新填';
  if (status === 402) return '账户余额不足，去服务商充值';
  if (status === 404) return '接口地址不对，检查 baseUrl 是不是漏了 /v1 或多写了路径';
  if (status === 429) return '请求太频繁被限流了，等几秒再试';
  if (status >= 500) return `服务商那边出错了（HTTP ${status}），稍后再试`;
  return `请求失败（HTTP ${status}）${detail ? `：${detail}` : ''}`;
}

export default {
  id: 'ai-chat',
  name: 'AI 对话',
  version: '3.0.0',
  description: '群里说什么都看得见，自己判断该不该接话；不占用任何指令前缀',
  frameworkVersion: '>=0.7.0',

  /** 面板上的「快速填入」。地址都是实测过的（不带 Key 返回 401 说明接口真实存在） */
  configPresets: [
    {
      name: 'DeepSeek',
      desc: '国内直连、便宜，日常聊天够用（deepseek-flash）',
      values: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
    },
    {
      name: 'DeepSeek Pro',
      desc: '能力更强、贵几倍，难一点的活用它（deepseek-v4-pro）',
      values: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' },
    },
    {
      name: 'Kimi',
      desc: '月之暗面，长文本强项',
      values: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    },
    {
      name: '通义千问',
      desc: '阿里云百炼，OpenAI 兼容模式',
      values: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    },
    {
      name: '智谱 GLM',
      desc: '有免费额度，适合先试水',
      values: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    },
    {
      name: '硅基流动',
      desc: '一个 Key 调很多开源模型，如 Qwen / Llama',
      values: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
    },
    {
      name: '本地 Ollama',
      desc: '本机跑，不要钱也不要网（先在 Ollama 里 pull 好模型）',
      values: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
    },
  ],

  config: {
    adapter: {
      type: 'select',
      default: 'openai',
      options: ADAPTER_OPTIONS,
      label: '适配器',
      desc: '这一轮交给谁去想。openai = 直连兼容端点（默认，装上就能用）；dsh = 交给 DeepSeek Harness，能用它的工具和记忆（需另装 dsh-roost）；webhook = 自建服务',
    },
    apiKey: {
      type: 'text',
      default: '',
      label: 'API 密钥',
      desc: 'openai 适配器必填。在服务商控制台创建，通常以 sk- 开头',
      placeholder: 'sk-...',
    },
    baseUrl: {
      type: 'text',
      default: 'https://api.deepseek.com',
      label: '接口地址',
      desc: 'OpenAI 兼容地址。不知道填什么就点上面的「快速填入」',
      placeholder: 'https://api.deepseek.com',
    },
    model: {
      type: 'text',
      default: 'deepseek-flash',
      label: '模型',
      desc: '服务商提供的模型名，以官网文档为准',
      placeholder: 'deepseek-flash',
    },

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

    maxTokens: {
      type: 'number',
      default: 1024,
      min: 1,
      max: 8192,
      label: '单条回复上限（token）',
      desc: '太小会被截断，太大会让它写长篇',
    },
    temperature: {
      type: 'number',
      default: 1,
      min: 0,
      max: 2,
      label: '发散程度',
      desc: '越小越稳，越大越活泼。开了「思考模式」时不生效',
    },
    thinking: {
      type: 'boolean',
      default: false,
      label: '思考模式',
      desc: '让模型先打草稿再回答，难题更准，但慢好几倍、还更费钱。群聊一般不用开',
    },
    reasoningEffort: {
      type: 'select',
      default: 'high',
      options: [
        { value: 'low', label: '低（快，省）' },
        { value: 'high', label: '高（默认）' },
        { value: 'max', label: '最高（最慢最贵）' },
      ],
      label: '思考强度',
      desc: '只在「思考模式」开启时有意义',
    },

    markdown: {
      type: 'boolean',
      default: true,
      label: 'Markdown 消息',
      desc: '用 QQ 的 markdown 消息类型发回复，标题/列表/加粗能真的渲染。发不出去会自动退回纯文本',
    },
    timeoutSec: {
      type: 'number',
      default: DEFAULT_TIMEOUT_SEC,
      min: 5,
      max: 300,
      label: '超时（秒）',
      desc: '模型这么久没回就放弃，别让用户干等',
    },

    hostUrl: {
      type: 'text',
      default: '',
      label: 'Webhook 地址',
      desc: 'webhook 适配器用。插件把消息 POST 到这个地址的 /inbound，并等你回调 /reply',
      placeholder: 'http://127.0.0.1:9000',
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
        adapter: String(c.adapter ?? 'openai'),
        apiKey: String(c.apiKey ?? '').trim(),
        baseUrl: String(c.baseUrl ?? 'https://api.deepseek.com').trim().replace(/\/+$/, ''),
        model: aliasModel(String(c.model ?? DEFAULT_MODEL).trim()),
        decide: c.decide === 'mention' ? 'mention' : 'ai',
        cooldownSec: num(c.cooldownSec, 20),
        maxRepliesPerMin: num(c.maxRepliesPerMin, 3),
        ignoreWords: Array.isArray(c.ignoreWords) ? c.ignoreWords.map(String).filter(Boolean) : DEFAULT_IGNORE,
        systemPrompt: String(c.systemPrompt ?? '').trim(),
        groupPrompt: String(c.groupPrompt ?? '').trim(),
        directPrompt: String(c.directPrompt ?? '').trim(),
        maxTokens: num(c.maxTokens, 1024, 1),
        temperature: Number.isFinite(Number(c.temperature)) ? Number(c.temperature) : 1,
        thinking: Boolean(c.thinking),
        reasoningEffort: ['low', 'high', 'max'].includes(c.reasoningEffort) ? c.reasoningEffort : 'high',
        markdown: c.markdown !== false,
        timeoutSec: num(c.timeoutSec, DEFAULT_TIMEOUT_SEC, 5),
        hostUrl: String(c.hostUrl ?? '').trim().replace(/\/+$/, ''),
        dshUrl: String(c.dshUrl ?? 'http://127.0.0.1:17321').trim().replace(/\/+$/, ''),
        publicUrl: String(c.publicUrl ?? 'http://127.0.0.1:8080').trim().replace(/\/+$/, ''),
        debug: Boolean(c.debug),
      };
    };

    const store = new ChatStore({
      historyLimit: num(ctx.config.historyLimit, 10, 1),
      idleMs: num(ctx.config.idleTimeoutMin, 30, 1) * 60_000,
    });
    const pace = new PaceStore({
      cooldownSec: num(ctx.config.cooldownSec, 20),
      maxRepliesPerMin: num(ctx.config.maxRepliesPerMin, 3),
    });

    /**
     * 宿主回话通道。webhook / dsh 适配器用它等宿主把话说完；
     * openai 适配器不走这条路，这条路由平时是空闲的。
     */
    const bridge = createBridge({ log: (m) => ctx.logger.warn(`[ai-chat] ${m}`) });
    const profile = createProfile({ storage: ctx.storage });

    ctx.registerRoute('POST', '/reply', async ({ body, json }) => {
      const r = bridge.handleReply(body ?? {});
      return json(r.code, r.body);
    });
    ctx.onTeardown(() => bridge.dispose());

    /* ---------------- 适配器 ---------------- */

    let adapter = null;
    function getAdapter() {
      const c = conf();
      if (!adapter || adapter.name !== c.adapter) {
        adapter = createAdapter({
          conf,
          explainHttp,
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

      parts.push(
        [
          '【动作标记】',
          '需要长期记住某件事：在回复里加 <<remember: 内容>>',
          '要忘掉某件事：<<forget: 关键词>>',
          '要改这个会话的人设：<<persona: 内容>>',
          '要清空这个会话的上下文：<<clear>>',
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
      const paceSt = pace.get(msg.chatId);
      const gate = shouldConsider(msg, c, paceSt);

      if (!gate.go) {
        if (c.debug) ctx.logger.debug(`[ai-chat] 不接（${gate.reason}）：${String(msg.content).slice(0, 30)}`);
        return;
      }

      // 同一个群同时只跑一轮：群里刷屏时不要并发一堆请求
      if (paceSt.busy) {
        if (c.debug) ctx.logger.debug(`[ai-chat] ${msg.chatId} 上一轮还没完，跳过`);
        return;
      }

      // 没配 Key 只在被明确叫到时提醒一句，否则静默——群聊里不该刷这个
      if (c.adapter === 'openai' && !c.apiKey) {
        if (gate.force) {
          await msg
            .reply(
              `还没配 API Key。\n去面板「插件 → ${ctx.name} → 设置」填上，DeepSeek 的 Key 在 platform.deepseek.com 申请。`,
            )
            .catch(() => {});
        }
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
        if (sys) {
          if (s.messages[0]?.role === 'system') s.messages[0] = sys;
          else s.messages.unshift(sys);
        } else if (s.messages[0]?.role === 'system') {
          s.messages.shift();
        }

        // 入站整形：语音 ASR、引用原文、合并转发、卡片都并进来
        s.messages.push({ role: 'user', content: buildUserContent(msg, msg.content) });
        store.trim(s);

        const { text, usage, model } = await callModel(s.messages, {
          signal: paceSt.controller.signal,
          model: c.model,
          msg,
          chat: { kind: msg.kind, chatId: msg.chatId },
        });

        const { text: cleaned, actions } = parseActions(text);
        const confirm = await runActions(msg, actions);

        /**
         * 不该接话：把这条用户消息**从上下文里撤掉**。
         *
         * 不撤的话，下次真说话时模型会看到一堆「自己没理的插话」，
         * 上下文全是噪音，而且它可能以为自己当时应该回答。
         */
        if (!gate.force && isSkip(cleaned) && !confirm) {
          if (s.messages.at(-1)?.role === 'user') s.messages.pop();
          if (c.debug) ctx.logger.debug(`[ai-chat] ${msg.chatId} 模型判断不接话`);
          return;
        }

        const body = [cleaned, confirm].filter(Boolean).join('\n\n');
        if (!body) return; // 只有动作、没有话要说

        s.messages.push({ role: 'assistant', content: cleaned || confirm });
        store.trim(s);
        s.rounds += 1;

        await sendReply(msg, body, {
          markdown: c.markdown,
          log: (m) => ctx.logger.warn(`[ai-chat] ${m}`),
        });

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

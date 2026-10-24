/**
 * AI 对话
 * ======
 *
 * 把大模型接进 QQ：群里 @机器人 说话、私聊直接说，都能对话。
 * 每个会话（群 / 私聊）各自一份上下文，互不串台。
 *
 * 移植自腾讯官方的 [dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot)，
 * 但**没有照搬它的架构**——它是 DSH 的插件，靠 DSH 的 agent loop 调模型；
 * 我们是独立框架，所以直接打 OpenAI 兼容的 `/chat/completions`。
 * 这样不绑定任何一家：DeepSeek、Kimi、通义、本地 Ollama 都只要改 baseUrl。
 *
 * 保留了哪些：每会话独立上下文、闲置回收、内置命令、访问控制、
 * 群聊 @ 触发 / 私聊直接触发、错误翻译成人话。
 *
 * 没做哪些，以及为什么：
 *   · 流式输出——QQ 群聊不支持，用户看到的只是最终那条消息，
 *     流式唯一的好处是「打字机效果」，为此引入 SSE 解析不值得。
 *   · 工具调用（agent loop）——我们是机器人框架不是 agent 运行时，
 *     真要做应该是「插件提供工具」，那是另一个量级的事。
 *   · 图片视觉理解——需要先下载 QQ 的图片（带鉴权的临时链接）、
 *     再调视觉模型，链路长且容易失效，等有人真需要再说。
 */
/** 一次请求最多等多久。超过就中断，别让用户干等 */
const DEFAULT_TIMEOUT_SEC = 90;

/**
 * 会话容器。
 *
 * 为什么放内存不落盘：上下文是「最近聊了什么」，重启后用户本来也该重新开始。
 * 落盘反而有隐私问题（聊天记录存本地）和写放大问题（每轮都写）。
 * 官方的 dsh-qqbot 也是内存 + 闲置回收，思路一致。
 */
class ChatStore {
  constructor({ historyLimit, idleMs }) {
    /** chatId -> { messages, lastAt, busy, controller, model, rounds } */
    this.map = new Map();
    this.historyLimit = historyLimit;
    this.idleMs = idleMs;
  }

  get(chatId) {
    let s = this.map.get(chatId);
    if (!s) {
      s = { messages: [], lastAt: Date.now(), busy: false, controller: null, model: '', rounds: 0 };
      this.map.set(chatId, s);
    }
    s.lastAt = Date.now();
    return s;
  }

  reset(chatId) {
    this.map.delete(chatId);
  }

  /**
   * 裁剪上下文。
   *
   * 保留 system（第 0 条，如果有）+ 最近 N 轮。按「条数」而不是「token 数」裁
   * 是有意的：数 token 要引依赖或写估算器，而 10 轮对话对绝大多数模型都安全。
   */
  trim(s) {
    const keep = Math.max(2, this.historyLimit * 2);
    if (s.messages.length <= keep) return;
    const hasSystem = s.messages[0]?.role === 'system';
    const sys = hasSystem ? [s.messages[0]] : [];
    const rest = hasSystem ? s.messages.slice(1) : s.messages;
    s.messages = [...sys, ...rest.slice(-keep)];
  }

  /** 回收闲置会话，返回清掉的个数 */
  evictIdle(now = Date.now()) {
    let n = 0;
    for (const [id, s] of this.map) {
      if (s.busy) continue; // 正在生成的不动
      if (now - s.lastAt > this.idleMs) {
        this.map.delete(id);
        n += 1;
      }
    }
    return n;
  }

  get size() {
    return this.map.size;
  }
}

/** 把 HTTP 状态码翻译成人话——AI 和人都看得懂的那种 */
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
  version: '1.1.0',
  description: '把大模型接进群聊和私聊，@机器人 就能对话，每会话独立上下文',
  frameworkVersion: '>=0.6.0',

  /**
   * 面板上的「快速填入」。
   *
   * 换服务商要同时改 baseUrl 和 model 两个字段，手输地址容易多写/漏写 `/v1`
   * （然后拿到一个 404，看着像服务商挂了）。这里把常见组合列出来，点一下填好。
   *
   * 地址都是实测过的（不带 Key 请求返回 401，说明接口真实存在）。
   * **模型名会变**：服务商上下架模型比改域名勤得多，所以 desc 里写清
   * 「以官网为准」，用户填完最好核对一眼。
   */
  configPresets: [
    {
      name: 'DeepSeek',
      desc: '国内直连、便宜，日常聊天够用',
      values: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
    },
    {
      name: 'DeepSeek 推理',
      desc: '带思维链，数学和代码更强，但更慢更贵',
      values: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-reasoner' },
    },
    {
      name: 'Kimi',
      desc: '月之暗面，长文本强项',
      values: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    },
    {
      name: '通义千问',
      desc: '阿里云百炼，OpenAI 兼容模式',
      values: {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-plus',
      },
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
      name: '火山方舟',
      desc: '字节豆包。model 要填「接入点 ID」或模型名，看控制台',
      values: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k' },
    },
    {
      name: '本地 Ollama',
      desc: '跑在自己电脑上，不花钱不出网。先 ollama pull 一个模型',
      values: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
    },
  ],

  config: {
    apiKey: {
      type: 'text',
      default: '',
      label: 'API 密钥',
      desc: '必填。在服务商控制台创建，通常以 sk- 开头。留空时对话不可用',
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
      default: 'deepseek-chat',
      label: '模型',
      desc: '服务商提供的模型名，以官网文档为准。也可以在群里发 /模型 临时换',
      placeholder: 'deepseek-chat',
    },
    systemPrompt: {
      type: 'text',
      default: '',
      label: '人设',
      desc: '所有会话共用的系统提示词。留空就是默认的助手风格',
      placeholder: '你是一个乐于助人的助手，回答简洁',
    },
    groupPrompt: {
      type: 'text',
      default: '',
      label: '群聊追加人设',
      desc: '只在群里生效，叠加在「人设」后面。比如「群里说话简短些」',
    },
    directPrompt: {
      type: 'text',
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
      desc: '1 轮 = 一问一答。越大越费 token，也越容易撞上下文上限',
    },
    idleTimeoutMin: {
      type: 'number',
      default: 30,
      min: 1,
      max: 1440,
      label: '闲置清空（分钟）',
      desc: '这么久没人说话就忘掉之前的对话。上下文只存内存，重启也会清空',
    },
    maxTokens: {
      type: 'number',
      default: 1024,
      min: 1,
      max: 32000,
      label: '单条回复上限（token）',
      desc: '太小会说到一半断掉，太大容易又臭又长还费钱',
    },
    temperature: {
      type: 'number',
      default: 1,
      min: 0,
      max: 2,
      label: '发散程度',
      desc: '0 最保守、每次回答都差不多；2 最跳脱。日常用 1 就行',
    },
    timeoutSec: {
      type: 'number',
      default: DEFAULT_TIMEOUT_SEC,
      min: 5,
      max: 600,
      label: '请求超时（秒）',
      desc: '超过就放弃这次回答。推理模型慢，可以调大',
    },
    access: {
      type: 'select',
      default: 'open',
      // 值是代码里判断的，label 是给人看的
      options: [
        { value: 'open', label: '谁都能用' },
        { value: 'allowlist', label: '只白名单里的会话' },
      ],
      label: '谁能用',
      desc: '选「只白名单」后，名单外的会话不响应、也不消耗 token',
    },
    allowList: {
      type: 'json',
      default: [],
      label: '白名单',
      desc: '填会话 id 的数组，如 ["群openid","用户openid"]。只有上面选了 allowlist 才生效',
    },
    debug: {
      type: 'boolean',
      default: false,
      label: '调试日志',
      desc: '在日志里打印每轮耗时和 token 消耗，排查慢/贵的时候用',
    },
  },

  /** @param {RoostCtx} ctx */
  setup(ctx) {
    const P = ctx.prefix;

    const num = (v, def, min = 0) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= min ? n : def;
    };

    const store = new ChatStore({
      historyLimit: num(ctx.config.historyLimit, 10, 1),
      idleMs: num(ctx.config.idleTimeoutMin, 30, 1) * 60_000,
    });

    /** 配置每次现读：面板改完立刻生效，不用重启 */
    const conf = () => ({
      apiKey: String(ctx.config.apiKey ?? '').trim(),
      baseUrl: String(ctx.config.baseUrl ?? 'https://api.deepseek.com').trim().replace(/\/+$/, ''),
      model: String(ctx.config.model ?? 'deepseek-chat').trim(),
      systemPrompt: String(ctx.config.systemPrompt ?? '').trim(),
      groupPrompt: String(ctx.config.groupPrompt ?? '').trim(),
      directPrompt: String(ctx.config.directPrompt ?? '').trim(),
      maxTokens: num(ctx.config.maxTokens, 1024, 1),
      temperature: Number.isFinite(Number(ctx.config.temperature))
        ? Number(ctx.config.temperature)
        : 1,
      timeoutSec: num(ctx.config.timeoutSec, DEFAULT_TIMEOUT_SEC, 5),
      access: ctx.config.access === 'allowlist' ? 'allowlist' : 'open',
      allowList: Array.isArray(ctx.config.allowList)
        ? ctx.config.allowList.map((x) => String(x).trim()).filter(Boolean)
        : [],
      debug: Boolean(ctx.config.debug),
    });

    /** 没配 Key 时统一走这句，别每个入口各写一遍 */
    const noKeyHint = () =>
      `还没配 API Key。\n去面板「插件 → ${ctx.name} → 设置」填上，` +
      `DeepSeek 的 Key 在 platform.deepseek.com 申请。`;

    const allowed = (chatId) => {
      const c = conf();
      if (c.access === 'open') return true;
      return c.allowList.includes(String(chatId));
    };

    /** 拼 system 消息：全局人设 + 场景人设 */
    function systemMessage(msg) {
      const c = conf();
      const extra = msg.kind === 'c2c' ? c.directPrompt : c.groupPrompt;
      const text = [c.systemPrompt, extra].filter(Boolean).join('\n\n');
      return text ? { role: 'system', content: text } : null;
    }

    /**
     * 真正调模型。
     *
     * 用 OpenAI 兼容格式而不是 DeepSeek 私有 SDK：零依赖，且换服务商只改 baseUrl。
     * `stream: false` 是有意的——QQ 群聊不支持流式，用户只看最终消息。
     */
    async function callModel(messages, { signal, model }) {
      const c = conf();
      const res = await fetch(`${c.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${c.apiKey}`,
        },
        body: JSON.stringify({
          model: model || c.model,
          messages,
          max_tokens: c.maxTokens,
          temperature: c.temperature,
          stream: false,
        }),
        signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(explainHttp(res.status, body));
      }

      const data = await res.json().catch(() => null);
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        // 有的服务商会把「内容被过滤」放在 finish_reason 里，一起说出来
        const reason = data?.choices?.[0]?.finish_reason;
        throw new Error(reason === 'content_filter' ? '回复被服务商的内容审核拦了' : '模型返回了空内容');
      }
      return {
        text: text.trim(),
        usage: data?.usage ?? null,
        model: data?.model || model || c.model,
      };
    }

    /**
     * 处理一条对话。
     *
     * 同一会话串行：正在生成时又来个问题，直接告诉用户在等，
     * 不排队——排队会让后一个问题的回答对不上上下文，反而更乱。
     */
    async function converse(msg, userText) {
      const c = conf();
      const s = store.get(msg.chatId);

      if (s.busy) {
        return msg.reply('上一条还在想，稍等一下。');
      }

      s.busy = true;
      s.controller = new AbortController();
      const started = Date.now();

      try {
        // 每轮重建 system，这样面板改人设立刻生效
        const sys = systemMessage(msg);
        if (sys) {
          if (s.messages[0]?.role === 'system') s.messages[0] = sys;
          else s.messages.unshift(sys);
        } else if (s.messages[0]?.role === 'system') {
          s.messages.shift();
        }

        s.messages.push({ role: 'user', content: userText });
        store.trim(s);

        const { text, usage, model } = await callModel(s.messages, {
          signal: s.controller.signal,
          model: s.model || c.model,
        });

        s.messages.push({ role: 'assistant', content: text });
        store.trim(s);
        s.rounds += 1;

        if (c.debug) {
          const tok = usage ? ` · ${usage.prompt_tokens}+${usage.completion_tokens} tok` : '';
          ctx.logger.info(`[ai-chat] ${msg.chatId.slice(0, 8)} ${model} ${Date.now() - started}ms${tok}`);
        }

        /**
         * 用 reply 而不是 replyNow：让它参与框架的合并。
         *
         * 群里可能同时有别的插件也想回这条消息（回声接关键词、骰子接指令），
         * 合并成一条并各自带上【插件名】标题，比连发好几条清爽得多。
         */
        await msg.reply(text);
      } catch (e) {
        // 用户主动 /停止 会走到这里，不算错误
        if (e?.name === 'AbortError') {
          await msg.reply('已停止。').catch(() => {});
        } else {
          const friendly = e?.name === 'TimeoutError'
            ? `模型 ${c.timeoutSec} 秒没回，先放弃了。可以发 ${P}停止 或重试。`
            : e.message || '调用失败';
          ctx.logger.warn(`[ai-chat] 调用失败：${friendly}`);
          await msg.reply(`出错了：${friendly}`).catch(() => {});
        }
        // 失败就把这轮的提问撤掉，免得下一轮带着「没答上的问题」继续
        if (s.messages.at(-1)?.role === 'user') s.messages.pop();
      } finally {
        s.busy = false;
        s.controller = null;
        s.lastAt = Date.now();
      }
    }

    /* ---------------- 对话入口 ---------------- */

    /**
     * 固定格式：`@机器人 /ai 内容`。
     *
     * 为什么不做「@ 了随便说就接」：
     *   · 群里 @ 一下往往只是提到机器人，不是要它回答——那样每句都得接，很吵
     *   · 免 @ 窗口（sticky）更糟，@ 过一次之后整个群几分钟内说什么都被吃掉
     *   · 有个明确的 `/ai`，用户知道自己什么时候在跟 AI 说话，不 @ 也不误触发
     *
     * **发给模型的是 `/ai` 后面的内容**，指令本身剔除。
     * 用 `args` 而不是 `msg.content` 就是这个道理：content 里带着 `/ai`，
     * 直接发过去模型会以为用户在让它执行命令，回答容易跑偏。
     */
    ctx.command('ai <内容...>', {
      desc: '和 AI 对话，后面跟你的问题',
      usage: `${P}ai 今天天气怎么样`,
    }, async (msg, { args }) => {
      // args 是 `/ai` 后面按空格切开的部分，拼回去就是用户想问的原文
      const text = String((args ?? []).join(' ') ?? '').trim();

      if (!text) {
        const lines = [
          '要问什么？格式是：',
          msg.kind === 'c2c' ? `  ${P}ai 你的问题` : `  @我 ${P}ai 你的问题`,
          '',
          `例：${P}ai 用一句话解释什么是递归`,
          `换个话题：${P}新会话`,
        ];
        return msg.reply(lines.join('\n'));
      }

      if (!allowed(msg.chatId)) {
        // 白名单外：不响应、不消耗 token。但明确说一句，
        // 否则用户以为机器人坏了
        return msg.reply('这个会话不在 AI 对话的白名单里。');
      }

      const c = conf();
      if (!c.apiKey) return msg.reply(noKeyHint());

      await converse(msg, text);
    });

    /* ---------------- 命令 ---------------- */

    ctx.command('新会话 [说明]', {
      desc: '清空当前对话的上下文，重新开始',
      usage: `${P}新会话`,
    }, async (msg) => {
      store.reset(msg.chatId);
      await msg.reply('上下文已清空，重新开始吧。');
    });

    // 常见的别名，用户凭直觉打的词都接住
    ctx.command('清空', { desc: '同「新会话」' }, async (msg) => {
      store.reset(msg.chatId);
      await msg.reply('上下文已清空，重新开始吧。');
    });

    ctx.command('重置', { desc: '同「新会话」' }, async (msg) => {
      store.reset(msg.chatId);
      await msg.reply('上下文已清空，重新开始吧。');
    });

    ctx.command('模型 [名字]', {
      desc: '查看或切换当前会话用的模型',
      usage: `${P}模型  ·  ${P}模型 deepseek-reasoner`,
    }, async (msg, { args }) => {
      const c = conf();
      const s = store.get(msg.chatId);
      const want = String(args?.[0] ?? '').trim();

      if (!want) {
        const cur = s.model || c.model;
        const hint = cur === c.model ? '' : `（默认是 ${c.model}）`;
        return msg.reply(`当前模型：${cur}${hint}\n换一个：${P}模型 deepseek-reasoner`);
      }
      /**
       * 校验模型名。
       *
       * 必须挡住 `../../etc/passwd` 这种——只写 `[A-Za-z0-9._:/-]` 是不够的，
       * 点、斜杠、横线都在允许集里，`..` 也能通过。所以额外要求：
       * 以字母数字开头、不含 `..`。
       *
       * 现在模型名只进请求体不进 URL，所以不是安全问题；但填错了要等
       * 服务商返回 400 才知道，不如在这里直接说清楚。
       */
      if (want.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(want) || want.includes('..')) {
        return msg.reply('模型名看着不对：要以字母或数字开头，不能有空格和 ..');
      }
      s.model = want;
      await msg.reply(`已切到 ${want}，只影响这个会话。发 ${P}新会话 可以重新开始。`);
    });

    ctx.command('停止', { desc: '中止正在生成的回答' }, async (msg) => {
      const s = store.map.get(msg.chatId);
      if (!s?.busy || !s.controller) return msg.reply('当前没有在生成的回答。');
      s.controller.abort();
      await msg.reply('正在停…');
    });

    ctx.command('对话状态', { desc: '看这个会话的上下文情况' }, async (msg) => {
      const c = conf();
      const s = store.map.get(msg.chatId);
      const rounds = s?.rounds ?? 0;
      const kept = s?.messages.filter((m) => m.role !== 'system').length ?? 0;
      const idleMin = Math.max(0, Math.round(((s?.lastAt ?? 0) + store.idleMs - Date.now()) / 60000));
      const lines = [
        `模型：${s?.model || c.model}`,
        `已对话 ${rounds} 轮，上下文里存着 ${kept} 条`,
        `正在生成：${s?.busy ? '是' : '否'}`,
        rounds ? `闲置 ${idleMin} 分钟后自动清空` : '还没开始对话',
        `全局共 ${store.size} 个活跃会话`,
      ];
      await msg.reply(lines.join('\n'));
    });

    ctx.command('AI帮助', { desc: 'AI 对话怎么用' }, async (msg) => {
      const c = conf();
      const lines = [
        '## AI 对话',
        '',
        '格式固定是「指令 + 你的问题」，指令本身不会发给 AI：',
        msg.kind === 'c2c' ? `  ${P}ai 你的问题` : `  @我 ${P}ai 你的问题`,
        `例：${P}ai 用一句话解释什么是递归`,
        '',
        '## 其它指令',
        `- ${P}新会话 —— 清空上下文重新开始`,
        `- ${P}模型 —— 看当前模型，${P}模型 deepseek-reasoner 换一个`,
        `- ${P}停止 —— 中止正在生成的回答`,
        `- ${P}对话状态 —— 看这个会话聊了几轮`,
        '',
        `当前模型：${c.model}`,
        `上下文：保留最近 ${store.historyLimit} 轮，闲置 ${Math.round(store.idleMs / 60000)} 分钟清空`,
      ];
      await msg.reply(lines.join('\n'));
    });

    ctx.menu('AI 对话', [
      { text: `${P}ai 问题`, desc: '固定格式，指令会被剔除，AI 只看到你的问题' },
      { text: `${P}新会话`, desc: '聊偏了就用这个清掉上下文' },
      { text: `${P}模型`, desc: '换模型，比如 deepseek-reasoner 更擅长推理' },
      { text: `${P}停止`, desc: '回答太长等不及了，中止它' },
    ]);

    /* ---------------- 后台维护 ---------------- */

    // 每分钟扫一次闲置会话。用 ctx.schedule，插件卸载时框架会自动清掉定时器
    ctx.schedule('ai-chat-evict', 60_000, () => {
      const n = store.evictIdle();
      if (n) ctx.logger.debug(`[ai-chat] 回收 ${n} 个闲置会话`);
    });

    if (!conf().apiKey) {
      ctx.logger.warn('[ai-chat] 还没配 API Key，对话功能不可用。去面板「插件 → AI 对话 → 设置」填上');
    }
  },
};

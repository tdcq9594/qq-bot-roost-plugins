/**
 * AI 原生对话（ai-native）
 * ======================
 *
 * 和 ai-chat 的区别只有一句话：**ai-chat 把「调模型」交给 DSH，这里直连。**
 *
 * 所以这个插件自己管三件事：
 *   1. 模型接入：OpenAI 兼容的 /chat/completions，可配多个服务商、按会话切换
 *   2. 人格：命名人格库（prompt + 开场对话），按会话绑定
 *   3. 记忆：短期上下文 + 旧对话摘要压缩 + 用户明确让它记的事实
 *
 * QQ 侧（收消息、图片、语音 ASR、回复/按钮/表情）框架已经给了，不重复造。
 *
 * 定位提醒：同一个群**不要**同时开 ai-chat 和 ai-native，两个都会接话。
 * 二选一，或者用优先级 + claim 把它们分开。
 */

import { createProviders } from './provider.js';
import { createMemory } from './memory.js';

const stats = { replied: 0, errors: 0, totalMs: 0, count: 0, lastModel: '' };

export default {
  id: 'ai-native',
  name: 'AI 原生对话',
  version: '0.5.0',
  description: '直连模型（OpenAI 兼容），带人格、多话题、长期记忆检索与工具调用；不依赖 DSH',
  shortDesc: '直连模型的群聊 AI：人格 + 记忆',
  frameworkVersion: '>=0.8.1',

  /**
   * 排最后：别的插件（群管、功能插件）先跑，命中就 claim，
   * 我们就收不到那条消息——不用自己维护忽略词表。
   */
  priority: -100,
  seeClaimed: false,

  config: {
    decide: {
      type: 'select',
      default: 'mention',
      options: [
        { value: 'mention', label: '只在被 @ / 回复时说话（省 token）' },
        { value: 'ai', label: 'AI 自己判断该不该接话（读全量消息，费 token）' },
      ],
      label: '什么时候接话',
      desc: '「AI 自己判断」会让每条消息都过一次模型，用之前想清楚成本',
    },
    cooldownSec: {
      type: 'number',
      default: 3,
      min: 0,
      max: 600,
      label: '冷却（秒）',
      desc: '同一会话两次回复的最小间隔',
    },
    minChars: {
      type: 'number',
      default: 1,
      min: 0,
      max: 100,
      label: '最短长度',
      desc: '太短的消息（如单个表情）不接',
    },
    historyTurns: {
      type: 'number',
      default: 12,
      min: 0,
      max: 100,
      label: '上下文轮数',
      desc: '带最近多少轮对话给模型',
    },
    compressAfterTurns: {
      type: 'number',
      default: 24,
      min: 4,
      max: 500,
      label: '压缩阈值（轮）',
      desc: '超过多少轮后，把旧对话压成摘要',
    },
    vision: {
      type: 'boolean',
      default: false,
      label: '图片交给模型',
      desc: '开启后下载图片转 base64 发给多模态模型（gpt-4o / qwen-vl 等）',
    },
    fallback: {
      type: 'boolean',
      default: true,
      label: '失败自动换服务商',
      desc: '主服务商出错（限流/超时/欠费）时，按列表顺序自动试下一个',
    },
    tools: {
      type: 'boolean',
      default: true,
      label: '允许模型调用工具',
      desc: '让模型能查时间、记事情、搜记忆、算数、随机抽（OpenAI function calling）',
    },
    maxToolRounds: {
      type: 'number',
      default: 4,
      min: 1,
      max: 8,
      label: '最多工具轮数',
      desc: '一次回复里最多连续调用几轮工具，防止死循环',
    },
    recall: {
      type: 'boolean',
      default: true,
      label: '按需检索记忆',
      desc: '记忆超过条数上限时，只把和当前消息相关的挑给模型；关掉则全部塞进提示词',
    },
    recallTop: {
      type: 'number',
      default: 8,
      min: 1,
      max: 50,
      label: '每轮最多带几条记忆',
      desc: '按相关度取前 N 条；记忆没超过这个数就全给',
    },
    providers: {
      type: 'json',
      default: [
        {
          id: 'default',
          name: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: '',
          model: 'deepseek-chat',
          maxTokens: 1024,
          temperature: 0.7,
        },
      ],
      label: '模型服务商',
      desc: 'OpenAI 兼容的 /chat/completions 列表；apiKey 明文存在本机配置里',
    },
    defaultProvider: {
      type: 'text',
      default: 'default',
      label: '默认服务商 id',
    },
    personas: {
      type: 'json',
      default: {
        默认: {
          prompt: '你是一个友善、简洁、有点幽默的群聊助手。回答要短，别长篇大论。',
          beginDialogs: [],
        },
      },
      label: '人格库',
      desc: '名称 → { prompt, beginDialogs }；beginDialogs 是开场示范对话（可选）',
    },
    defaultPersona: {
      type: 'text',
      default: '默认',
      label: '默认人格名称',
    },
    allowMemberConfig: {
      type: 'boolean',
      default: false,
      label: '允许成员切换模型/人格',
      desc: '关着时只有管理员能切换',
    },
  },

  dashboard() {
    return {
      metrics: [
        { label: '已回复', value: stats.replied, unit: '条' },
        {
          label: '平均耗时',
          value: stats.count ? Math.round(stats.totalMs / stats.count) : 0,
          unit: 'ms',
        },
        { label: '出错', value: stats.errors, unit: '次' },
      ],
      note: `最近模型：${stats.lastModel || '—'}`,
    };
  },

  /** @param {RoostCtx} ctx */
  setup(ctx) {
    /**
     * 读配置：运行时框架已把默认值展开成实际值；
     * 测试夹具则直接把 schema（{type,default}）传进来。
     * 统一兼容两种情况，省得测试时配置全是 undefined。
     */
    const conf = () => {
      const raw = ctx.config || {};
      const out = {};
      for (const [k, v] of Object.entries(raw)) {
        out[k] =
          v && typeof v === 'object' && !Array.isArray(v) && 'type' in v && 'default' in v
            ? v.default
            : v;
      }
      return out;
    };

    const providers = createProviders({
      conf,
      log: (...a) => ctx.logger.debug(...a),
    });
    const memory = createMemory({
      conf,
      storage: ctx.storage,
      state: ctx.state,
      providers,
      log: ctx.logger,
    });

    // 按会话的临时选择（内存：重载保留、重启丢；要长期就改默认配置）
    ctx.state.providerOverride ??= new Map();
    ctx.state.personaOverride ??= new Map();
    ctx.state.lastReply ??= new Map();
    ctx.state.busy ??= new Set();
    ctx.state.errHintAt ??= new Map();

    const personaList = () => {
      const raw = conf().personas;
      let obj = raw;
      if (typeof obj === 'string') {
        try {
          obj = JSON.parse(obj);
        } catch {
          obj = {};
        }
      }
      return obj && typeof obj === 'object' ? obj : {};
    };

    const personaFor = (chatId) => {
      const list = personaList();
      const override = ctx.state.personaOverride.get(chatId) || '';
      const name = override || conf().defaultPersona || Object.keys(list)[0] || '默认';
      const p = list[name] || list[conf().defaultPersona] || Object.values(list)[0] || {};
      return {
        name,
        prompt: String(p.prompt || ''),
        beginDialogs: Array.isArray(p.beginDialogs) ? p.beginDialogs : [],
      };
    };

    const providerFor = (chatId) =>
      ctx.state.providerOverride.get(chatId) || conf().defaultProvider;

    // ---------------- /ai 管理命令 ----------------
    ctx.command(
      'ai [子命令] [参数]',
      { desc: 'AI 助手：模型 / 人格 / 记忆 / 新对话' },
      async (msg) => {
        // msg.content 带命令前缀（如「/ai 模型」），先剥前缀和命令名；
        // 再用 content 而不是 args，保留「记住 我喜欢猫」里的空格原文。
        const prefix = String(ctx.prefix || '/');
        let body = String(msg.content || '').trim();
        if (body.startsWith(prefix)) body = body.slice(prefix.length).trim();
        const afterCmd = body.replace(/^ai\b\s*/i, '').trim();
        const m = afterCmd.match(/^(\S+)\s*([\s\S]*)$/);
        const sub = String(m?.[1] || '帮助').toLowerCase();
        const rest = String(m?.[2] || '').trim();
        const isAdmin = async () =>
          (await ctx.can(msg)) || ctx.isOwner(msg.userId) || conf().allowMemberConfig;

        if (sub === '模型' || sub === 'model') {
          const all = providers.list();
          if (!rest) {
            const cur = providerFor(msg.chatId);
            const lines = all.map(
              (p) => `${p.id === cur ? '▶ ' : '· '}${p.id}（${p.name} / ${p.model}）`,
            );
            return msg.reply(
              lines.length
                ? `可用模型：\n${lines.join('\n')}\n\n用 /ai 模型 <id> 切换`
                : '还没配置模型服务商',
            );
          }
          if (!(await isAdmin())) return msg.reply('切换模型需要管理员权限');
          const p = all.find((x) => x.id === rest);
          if (!p) return msg.reply(`没有「${rest}」这个服务商，用 /ai 模型 查看列表`);
          ctx.state.providerOverride.set(msg.chatId, p.id);
          return msg.reply(`本会话已切到：${p.id}（${p.name} / ${p.model}）`);
        }

        if (sub === '人格' || sub === 'persona') {
          const list = personaList();
          const names = Object.keys(list);
          if (!rest) {
            const cur = personaFor(msg.chatId).name;
            return msg.reply(
              names.length
                ? `可用人格：\n${names
                    .map((n) => `${n === cur ? '▶ ' : '· '}${n}`)
                    .join('\n')}\n\n用 /ai 人格 <名称> 切换`
                : '还没配置人格',
            );
          }
          if (!(await isAdmin())) return msg.reply('切换人格需要管理员权限');
          if (!list[rest]) return msg.reply(`没有「${rest}」这个人格，用 /ai 人格 查看列表`);
          ctx.state.personaOverride.set(msg.chatId, rest);
          return msg.reply(`本会话人格已切到：${rest}`);
        }

        if (sub === '对话' || sub === 'convs' || sub === 'conversations') {
          const c = await memory.convs(msg.chatId);
          const lines = [];
          for (const it of c.list) {
            const rounds = Math.ceil(memory.history(`${msg.chatId}#${it.id}`).length / 2);
            lines.push(`${it.id === c.current ? '▶ ' : '· '}${it.id}. ${it.title}（${rounds} 轮）`);
          }
          return msg.reply(
            `对话列表：\n${lines.join('\n')}\n\n` +
              '/ai 切换 <编号> 切过去\n/ai 新对话 [标题] 开一个\n/ai 删对话 <编号> 删掉',
          );
        }

        if (sub === '新对话' || sub === 'new') {
          const it = await memory.newConv(msg.chatId, rest);
          return msg.reply(
            `开了一个新对话：${it.id}. ${it.title}\n之前的对话还在，用 /ai 对话 能切回去。` +
              '（长期记忆是所有对话共用的）',
          );
        }

        if (sub === '切换' || sub === 'switch' || sub === 'use') {
          if (!rest) return msg.reply('用法：/ai 切换 <编号>，编号用 /ai 对话 看');
          const it = await memory.switchConv(msg.chatId, rest);
          if (!it) return msg.reply(`没有「${rest}」这个对话，用 /ai 对话 看看有哪些`);
          return msg.reply(`已切到：${it.id}. ${it.title}`);
        }

        if (sub === '删对话' || sub === 'delconv') {
          if (!rest) return msg.reply('用法：/ai 删对话 <编号>');
          const r = await memory.dropConv(msg.chatId, rest);
          if (!r) return msg.reply(`没有「${rest}」这个对话`);
          if (r.error) return msg.reply(r.error);
          return msg.reply(`删掉了「${r.removed.title}」，现在在 ${r.current} 号对话`);
        }

        if (sub === '重置') {
          const scope = await memory.scopeOf(msg.chatId);
          memory.reset(scope);
          await memory.clearSummary(scope);
          return msg.reply('这个对话的上下文已清空（长期记忆还在，要清用 /ai 记忆）');
        }

        if (sub === '记住' || sub === 'remember') {
          if (!rest) return msg.reply('用法：/ai 记住 我喜欢猫');
          const arr = await memory.addFact(msg.chatId, rest);
          return msg.reply(`记住了（现在共 ${arr.length} 条）`);
        }

        if (sub === '忘记' || sub === 'forget') {
          if (!rest) return msg.reply('用法：/ai 忘记 <关键词>');
          const r = await memory.removeFacts(msg.chatId, rest);
          return msg.reply(
            r.removed ? `忘了 ${r.removed} 条（剩 ${r.facts.length} 条）` : '没找到匹配的记忆',
          );
        }

        if (sub === '记忆' || sub === 'memory' || sub === '搜' || sub === 'search') {
          const sm = await memory.summary(await memory.scopeOf(msg.chatId));

          // 带关键词 → 检索；不带 → 全量列（太多就截断，免得刷屏）
          if (rest) {
            const hits = await memory.search(msg.chatId, rest, 10);
            const head = hits.length
              ? `匹配到 ${hits.length} 条：\n${hits.map((h) => `· ${h.text}`).join('\n')}`
              : '没找到相关的记忆';
            return msg.reply(sm ? `${head}\n\n【摘要】\n${sm}` : head);
          }

          const fs = await memory.facts(msg.chatId);
          const lines = [];
          if (sm) lines.push(`【摘要】\n${sm}`);
          if (fs.length) {
            const shown = fs.slice(-20);
            const more = fs.length > shown.length ? `\n… 还有 ${fs.length - shown.length} 条` : '';
            lines.push(`【事实】共 ${fs.length} 条\n${shown.map((f) => `· ${f}`).join('\n')}${more}`);
          }
          return msg.reply(
            lines.length
              ? `${lines.join('\n\n')}\n\n用 /ai 记忆 <关键词> 搜`
              : '这个会话还没有长期记忆',
          );
        }

        return msg.reply(
          'AI 助手用法：\n' +
            '/ai 模型 —— 查看 / 切换模型（管理员）\n' +
            '/ai 人格 —— 查看 / 切换人格（管理员）\n' +
            '/ai 对话 —— 话题列表 / 切换 / 新建\n' +
            '/ai 新对话 [标题] —— 开一个新话题\n' +
            '/ai 重置 —— 清空当前话题的上下文\n' +
            '/ai 记住 <内容> —— 让它记住\n' +
            '/ai 忘记 <关键词> —— 忘掉\n' +
            '/ai 记忆 [关键词] —— 看它记得什么 / 搜记忆',
        );
      },
    );

    // ---------------- 消息监听 ----------------
    ctx.on('message', async (msg) => {
      if (msg.isCommand) return;
      if (msg.claimedBy || msg.replied) return;

      const c = conf();
      const aiMode = c.decide === 'ai';
      if (!aiMode && !msg.addressed) return;

      const text = String(msg.content || '').trim();
      const asr = (msg.voices || [])
        .map((v) => v.asrText)
        .filter(Boolean)
        .join(' ')
        .trim();
      const fullText = [text, asr].filter(Boolean).join(' ').trim();
      const images = Array.isArray(msg.images) ? msg.images : [];
      if (!fullText && !images.length) return;
      if (fullText && fullText.length < (Number(c.minChars) || 0)) return;

      const now = Date.now();
      const last = ctx.state.lastReply.get(msg.chatId) || 0;
      if (now - last < (Number(c.cooldownSec) || 0) * 1000) return;
      if (ctx.state.busy.has(msg.chatId)) return;

      ctx.state.busy.add(msg.chatId);
      try {
        const persona = personaFor(msg.chatId);
        // 会话（群/私聊）→ 对话（话题）：上下文和摘要按对话隔离，人格与长期记忆按会话共享
        const scope = await memory.scopeOf(msg.chatId);
        const [recalled, summaryText] = await Promise.all([
          c.recall === false
            ? memory.facts(msg.chatId).then((list) => ({ list, total: list.length, truncated: false }))
            : memory.recall(msg.chatId, fullText),
          memory.summary(scope),
        ]);
        const system = memory.buildSystem({
          persona,
          factList: recalled.list,
          factTotal: recalled.total,
          summaryText,
          aiMode,
        });
        const history = memory
          .history(scope)
          .slice(-((Number(c.historyTurns) || 12) * 2));
        const userContent = await buildUserContent(fullText, images, c, ctx.logger);

        const messages = [
          { role: 'system', content: system },
          ...persona.beginDialogs,
          ...history,
          { role: 'user', content: userContent },
        ];

        // 工具调用循环：模型要工具就执行，把结果喂回去，直到它给最终回复
        const useTools = c.tools !== false;
        const tools = useTools ? TOOLS : undefined;
        const maxRounds = Math.max(1, Number(c.maxToolRounds) || 4);
        let r = null;
        for (let round = 0; round < maxRounds; round++) {
          r = await providers.chat({ messages, tools, providerId: providerFor(msg.chatId) });
          if (!r.toolCalls?.length) break;

          // 把 assistant 的 tool_calls 消息原样加回去（content 为空是正常的）
          messages.push({
            role: 'assistant',
            content: r.message?.content ?? null,
            tool_calls: r.toolCalls,
          });
          for (const tc of r.toolCalls) {
            let out;
            try {
              const args = JSON.parse(tc.function?.arguments || '{}');
              out = await runTool(tc.function?.name, args, { memory, chatId: msg.chatId });
            } catch (e) {
              out = `工具执行失败：${e.message}`;
            }
            messages.push({ role: 'tool', tool_call_id: tc.id, content: String(out) });
          }

          // 轮数用尽还没给最终回复：不带工具再要一次，逼它总结
          if (round === maxRounds - 1) {
            r = await providers.chat({ messages, providerId: providerFor(msg.chatId) });
          }
        }

        const answer = String(r?.text || '').trim();

        // AI 自己判断模式下，模型可能选择闭嘴
        if (aiMode && /^<skip>\s*$/i.test(answer)) {
          ctx.logger.debug(`模型选择不接话：${String(msg.chatId).slice(0, 8)}`);
          return;
        }
        if (!answer) {
          ctx.logger.warn('模型没有给出最终文本，跳过');
          return;
        }

        await msg.reply(answer);
        memory.addTurn(scope, fullText || '[图片]', answer);
        ctx.state.lastReply.set(msg.chatId, Date.now());

        stats.replied += 1;
        stats.totalMs += r.ms;
        stats.count += 1;
        stats.lastModel = r.model;
        ctx.logger.info(`${String(msg.chatId).slice(0, 8)} ${r.model} ${r.ms}ms`);

        // 后台压缩，不阻塞回复（reply 是攒着发的，等压缩会拖慢发送）
        memory.maybeCompress(scope, providerFor(msg.chatId)).catch(() => {});
      } catch (e) {
        stats.errors += 1;
        ctx.logger.error('AI 回复失败：', e.message);
        // 一分钟内只提示一次，别因为模型挂了刷屏
        const lastHint = ctx.state.errHintAt.get(msg.chatId) || 0;
        if (Date.now() - lastHint > 60_000) {
          ctx.state.errHintAt.set(msg.chatId, Date.now());
          await msg.reply(`AI 暂时不可用：${e.message}`).catch(() => {});
        }
      } finally {
        ctx.state.busy.delete(msg.chatId);
      }
    });

    ctx.menu('说明', [
      '直连模型，不依赖 DSH；每个会话独立的上下文与人格',
      '一个会话里可以开多个「对话」（话题），上下文互不干扰，长期记忆共用',
      '默认被 @ / 回复时说话，可在配置里改成「AI 自己判断」',
      '用 /ai 帮助 查看管理命令',
    ]);
  },

  teardown(ctx) {
    ctx.state.busy?.clear();
    ctx.state.lastReply?.clear();
  },
};

/**
 * 拼一条 user 消息的内容。
 * 没有图片 → 纯文本；有图片且开了 vision → 下载转 base64 的多模态格式；
 * 否则只标注数量。
 *
 * 为什么转 base64 而不是直接给 URL：QQ 的图片 CDN 地址很多服务商抓不到
 * （防盗链/内网），base64 最稳。太大（>5MB）或下载失败时回退成 URL。
 */
async function buildUserContent(text, images, c, log) {
  if (!images.length) return text;
  if (!c.vision) return `${text}\n[图片×${images.length}]`.trim();
  const parts = [{ type: 'text', text: text || '（请看图）' }];
  for (const img of images.slice(0, 4)) {
    const url = await toImageUrl(img, log);
    if (url) parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

/** 把一张附件转成 data URI；失败或过大就退回原始 URL */
async function toImageUrl(img, log) {
  const src = String(img?.url || '').trim();
  if (!src) return null;
  if (src.startsWith('data:')) return src;
  try {
    const res = await fetch(src, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return src;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) return src; // 太大就别塞请求体，交给模型自己抓
    const ct = img.contentType || res.headers.get('content-type') || 'image/jpeg';
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch (e) {
    log?.debug?.(`图片转 base64 失败，回退 URL：${e.message}`);
    return src;
  }
}

/* ---------------- 工具（OpenAI function calling） ---------------- */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: '获取当前日期和时间（中国时区）',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: '记住一件关于用户或本群的事，之后会一直记得',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要记住的内容' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget',
      description: '忘掉包含某关键词的记忆',
      parameters: {
        type: 'object',
        properties: { keyword: { type: 'string' } },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_memory',
      description: '在长期记忆里搜索',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calc',
      description: '计算一个算术表达式（只支持数字和 + - * / ( ) %）',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'random_pick',
      description: '从候选里随机选一个',
      parameters: {
        type: 'object',
        properties: { items: { type: 'array', items: { type: 'string' } } },
        required: ['items'],
      },
    },
  },
];

async function runTool(name, args, { memory, chatId }) {
  switch (name) {
    case 'get_time':
      return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    case 'remember': {
      if (!args?.text) return '缺少要记住的内容';
      const arr = await memory.addFact(chatId, args.text);
      return `已记住（现在共 ${arr.length} 条）`;
    }
    case 'forget': {
      if (!args?.keyword) return '缺少关键词';
      const r = await memory.removeFacts(chatId, args.keyword);
      return r.removed ? `忘了 ${r.removed} 条` : '没找到匹配的记忆';
    }
    case 'search_memory': {
      const q = String(args?.query || '').trim();
      if (!q) return '缺少搜索词';
      const hits = await memory.search(chatId, q, 5);
      return hits.length ? hits.map((h) => `· ${h.text}`).join('\n') : '没找到相关记忆';
    }
    case 'calc': {
      const expr = String(args?.expression || '').trim();
      if (!expr) return '缺少表达式';
      return String(safeCalc(expr));
    }
    case 'random_pick': {
      const items = Array.isArray(args?.items)
        ? args.items.filter((x) => typeof x === 'string' && x)
        : [];
      if (!items.length) return '候选为空';
      return items[Math.floor(Math.random() * items.length)];
    }
    default:
      return `没有这个工具：${name}`;
  }
}

/** 只允许数字和 + - * / ( ) % 的算术，避免 eval 注入 */
function safeCalc(expr) {
  const s = String(expr).replace(/\s+/g, '');
  if (!/^[0-9+\-*/().%]+$/.test(s) || s.length > 200) throw new Error('表达式不合法');
  // eslint-disable-next-line no-new-func
  const v = Function(`"use strict";return (${s})`)();
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('结果不是有效数字');
  return Math.round(v * 1e10) / 1e10;
}

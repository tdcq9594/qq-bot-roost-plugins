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
  version: '0.1.0',
  description: '直连模型（OpenAI 兼容），带人格、短期上下文与长期记忆；不依赖 DSH',
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
      desc: '开启后把图片 URL 直接发给模型（需多模态模型，如 gpt-4o / qwen-vl）',
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

        if (sub === '新对话' || sub === 'new' || sub === '重置') {
          memory.reset(msg.chatId);
          await memory.clearSummary(msg.chatId);
          return msg.reply('上下文已清空，我们重新开始～（长期记忆还在，要清用 /ai 记忆）');
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

        if (sub === '记忆' || sub === 'memory') {
          const fs = await memory.facts(msg.chatId);
          const sm = await memory.summary(msg.chatId);
          const lines = [];
          if (sm) lines.push(`【摘要】\n${sm}`);
          if (fs.length) lines.push(`【事实】\n${fs.map((f) => `· ${f}`).join('\n')}`);
          return msg.reply(lines.length ? lines.join('\n\n') : '这个会话还没有长期记忆');
        }

        return msg.reply(
          'AI 助手用法：\n' +
            '/ai 模型 —— 查看 / 切换模型（管理员）\n' +
            '/ai 人格 —— 查看 / 切换人格（管理员）\n' +
            '/ai 新对话 —— 清空上下文\n' +
            '/ai 记住 <内容> —— 让它记住\n' +
            '/ai 忘记 <关键词> —— 忘掉\n' +
            '/ai 记忆 —— 看看它记得什么',
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
        const [factList, summaryText] = await Promise.all([
          memory.facts(msg.chatId),
          memory.summary(msg.chatId),
        ]);
        const system = memory.buildSystem({ persona, factList, summaryText, aiMode });
        const history = memory
          .history(msg.chatId)
          .slice(-((Number(c.historyTurns) || 12) * 2));
        const userContent = buildUserContent(fullText, images, c);

        const messages = [
          { role: 'system', content: system },
          ...persona.beginDialogs,
          ...history,
          { role: 'user', content: userContent },
        ];

        const r = await providers.chat({
          messages,
          providerId: providerFor(msg.chatId),
        });

        // AI 自己判断模式下，模型可能选择闭嘴
        if (aiMode && /^<skip>\s*$/i.test(r.text)) {
          ctx.logger.debug(`模型选择不接话：${String(msg.chatId).slice(0, 8)}`);
          return;
        }

        await msg.reply(r.text);
        memory.addTurn(msg.chatId, fullText || '[图片]', r.text);
        ctx.state.lastReply.set(msg.chatId, Date.now());

        stats.replied += 1;
        stats.totalMs += r.ms;
        stats.count += 1;
        stats.lastModel = r.model;
        ctx.logger.info(`${String(msg.chatId).slice(0, 8)} ${r.model} ${r.ms}ms`);

        // 后台压缩，不阻塞回复（reply 是攒着发的，等压缩会拖慢发送）
        memory.maybeCompress(msg.chatId, providerFor(msg.chatId)).catch(() => {});
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
 * 没有图片 → 纯文本；有图片且开了 vision → OpenAI 多模态格式；否则只标注数量。
 */
function buildUserContent(text, images, c) {
  if (!images.length) return text;
  if (!c.vision) return `${text}\n[图片×${images.length}]`.trim();
  return [
    { type: 'text', text: text || '（请看图）' },
    ...images.slice(0, 4).map((img) => ({
      type: 'image_url',
      image_url: { url: img.url },
    })),
  ];
}

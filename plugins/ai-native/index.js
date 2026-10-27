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
import { createKnowledge } from './knowledge.js';
import { estimateTokens } from './text.js';

const stats = {
  replied: 0,
  errors: 0,
  totalMs: 0,
  count: 0,
  lastModel: '',
  calls: 0,
  inTokens: 0,
  outTokens: 0,
};

export default {
  id: 'ai-native',
  name: 'AI 原生对话',
  version: '0.8.0',
  description: '直连模型（OpenAI 兼容）：人格 + 多话题 + 三层记忆 + 知识库（可选向量）+ 工具调用，不依赖 DSH',
  shortDesc: '直连模型的群聊 AI：人格 + 三层记忆 + 知识库',
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
    timeoutSec: {
      type: 'number',
      default: 90,
      min: 10,
      max: 600,
      label: '一次回复的总时限（秒）',
      desc: '含工具调用的所有轮次。超时就放弃这一轮并释放会话，避免模型卡住后这个群再也不回',
    },
    maxQueue: {
      type: 'number',
      default: 3,
      min: 1,
      max: 20,
      label: '同一会话最多同时挂几条',
      desc: '含正在回复的那条。比如 3 = 1 条在回、2 条排队；再多就丢弃，避免刷屏时越排越久',
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
    maxContextTokens: {
      type: 'number',
      default: 0,
      min: 0,
      max: 200000,
      label: '上下文 token 预算',
      desc: '0 = 只按轮数限制；填了（如 6000）就按估算的 token 从旧往新裁，避免长消息撞窗口',
    },
    moodDecayHours: {
      type: 'number',
      default: 6,
      min: 0,
      max: 168,
      label: '情绪回平时长（小时）',
      desc: '模型给自己设的语气多久后自动回平；0 = 不衰减（不推荐，会一直一个脾气）',
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
    knowledge: {
      type: 'boolean',
      default: true,
      label: '启用知识库',
      desc: '自动检索数据目录下 knowledge/ 里的文档，命中片段随问题一起给模型',
    },
    autoConsolidate: {
      type: 'boolean',
      default: false,
      label: '定时自动整理',
      desc: '每隔一段时间把各会话最近的对话提炼成长期记忆（每个会话多一次模型调用）',
    },
    consolidateHours: {
      type: 'number',
      default: 12,
      min: 1,
      max: 720,
      label: '自动整理间隔（小时）',
      desc: 'autoConsolidate 打开时生效',
    },
    readFiles: {
      type: 'boolean',
      default: true,
      label: '读文本文件内容',
      desc: '群友发的 .txt/.md/.json 等纯文本会下载读进来；PDF/Word/Excel 读不了，只标文件名',
    },
    maxFileChars: {
      type: 'number',
      default: 4000,
      min: 0,
      max: 50000,
      label: '单个文件最多读多少字',
      desc: '0 = 不读内容，只标文件名',
    },
    knowledgeTop: {
      type: 'number',
      default: 3,
      min: 1,
      max: 8,
      label: '每轮最多带几段资料',
      desc: '命中的片段越多，提示词越长、越贵',
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
    embedding: {
      type: 'json',
      default: { model: '', baseUrl: '', apiKey: '', minScore: 0.35 },
      label: '向量检索（可选）',
      desc:
        '填了 model 就开：知识库除关键词外再叠一层向量检索，语义相近也能命中。' +
        'baseUrl / apiKey 留空则继承默认服务商。不填就一直走纯关键词，不产生额外费用。' +
        'minScore 是相似度下限（0~1），不同模型整体偏高或偏低，觉得乱命中就往上调。',
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
        { label: '模型调用', value: stats.calls, unit: '次' },
        { label: '输入 token', value: stats.inTokens, unit: '' },
        { label: '输出 token', value: stats.outTokens, unit: '' },
        { label: '出错', value: stats.errors, unit: '次' },
      ],
      note: `最近模型：${stats.lastModel || '—'}（用量会落盘，重启不清零）`,
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
    const knowledge = createKnowledge({
      conf,
      dataDir: ctx.dataDir,
      log: ctx.logger,
      // 没配 embedding 时 providers.embed 直接返回 null，知识库自动走纯关键词
      embed: (texts) => providers.embed(texts),
    });

    ctx.state.lastReply ??= new Map();
    ctx.state.queues ??= new Map();
    ctx.state.errHintAt ??= new Map();
    ctx.state.ovCache ??= new Map();

    /**
     * 会话级选择（用哪个模型 / 哪个人格）要**落盘**：
     * 存 ctx.state 的话热重载还在、重启就丢，管理员切过的全回落默认值，
     * 群里看着像「设置自己失效了」。加一层内存缓存，别每条消息都读盘。
     */
    async function overrideOf(chatId) {
      let ov = ctx.state.ovCache.get(chatId);
      if (!ov) {
        ov = (await ctx.storage.get(`ov:${chatId}`, null)) || {};
        ctx.state.ovCache.set(chatId, ov);
      }
      return ov;
    }

    async function setOverride(chatId, patch) {
      const ov = { ...(await overrideOf(chatId)), ...patch };
      ctx.state.ovCache.set(chatId, ov);
      await ctx.storage.set(`ov:${chatId}`, ov);
      return ov;
    }

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

    const personaFor = async (chatId) => {
      const list = personaList();
      const ov = await overrideOf(chatId);
      const name = ov.persona || conf().defaultPersona || Object.keys(list)[0] || '默认';
      const p = list[name] || list[conf().defaultPersona] || Object.values(list)[0] || {};
      return {
        name,
        prompt: String(p.prompt || ''),
        beginDialogs: Array.isArray(p.beginDialogs) ? p.beginDialogs : [],
        /** 人格默认语气（可空）；运行时情绪会盖过它 */
        mood: String(p.mood || ''),
        /** 这个角色挂了就挂了的自定义报错文案（可空） */
        errorText: String(p.errorText || ''),
        /** 允许某些人格不用工具（比如只想让它纯聊天） */
        tools: p.tools !== false,
      };
    };

    const providerFor = async (chatId) => {
      const ov = await overrideOf(chatId);
      return ov.provider || conf().defaultProvider;
    };

    /**
     * 用量统计落盘。
     *
     * `dashboard()` 是同步的、拿不到 ctx，所以数字只能挂在模块级 stats 上；
     * 但模块级变量重启就没了——面板上「已用多少 token」每次重启归零，
     * 等于没有。所以进 setup 时读回来，之后按 10 秒节流写盘
     * （每次回复都写一遍没必要，storage 也是有 IO 的）。
     */
    if (!stats.__loaded) {
      stats.__loaded = true;
      ctx.storage
        .get('usage', null)
        .then((u) => {
          if (u && typeof u === 'object') Object.assign(stats, u);
        })
        .catch(() => {});
    }
    let lastUsageSave = 0;
    const saveUsage = () => {
      if (Date.now() - lastUsageSave < 10_000) return;
      lastUsageSave = Date.now();
      const { __loaded, ...rest } = stats;
      ctx.storage.set('usage', rest).catch(() => {});
    };

    /* ---------------- 整理（睡眠整合的轻量版） ---------------- */

    /** 有哪些会话用过（定时整理要遍历），落盘，重启不丢 */
    const chatList = async () => {
      const raw = await ctx.storage.get('chats', []);
      return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string' && x) : [];
    };
    const noteChat = (chatId) => {
      chatList()
        .then(async (list) => {
          if (list.includes(chatId)) return;
          list.push(chatId);
          if (list.length > 200) list.splice(0, list.length - 200);
          await ctx.storage.set('chats', list);
        })
        .catch(() => {});
    };

    /**
     * 把最近的对话让模型提炼成几条长期事实。
     *
     * 这是「睡眠整合」的最小实现：不落日记、不搞评分衰减，只做一件事——
     * 把聊过的内容沉淀成之后还能被检索到的事实。为什么值得做：
     * 靠人手动 `/ai 记住` 的话，99% 的事都会被忘掉，而「第二天醒来还是
     * 同一个人」恰恰是活人感的前提。
     *
     * 为什么不让它每轮自动跑：每条消息多一次模型调用，贵且慢。所以做成
     * 「手动 /ai 整理」+「可选定时」，让用户自己权衡。
     */
    async function consolidate(chatId, providerId) {
      const scope = await memory.scopeOf(chatId);
      const h = memory.history(scope);
      if (h.length < 4) return 0;

      const dialog = h
        .slice(-24)
        .map(
          (m) =>
            `${m.role === 'user' ? m.name || '群友' : 'AI'}：${String(m.content).slice(0, 300)}`,
        )
        .join('\n');
      const prompt =
        '从下面这段群聊里提炼值得长期记住的事实，一行一条，最多 5 条。\n' +
        '优先记：谁是谁（身份/称呼）、偏好、约定、正在做的事。涉及具体人时带上人名。\n' +
        '不要解释、不要编号、不要客套。没什么值得记的只输出「无」。\n\n' +
        dialog;

      const { text } = await providers.chat({
        messages: [{ role: 'user', content: prompt }],
        providerId,
        signal: AbortSignal.timeout(60_000),
      });
      const lines = String(text || '')
        .split('\n')
        .map((s) => s.replace(/^[-·•*\d.、\s]+/, '').trim())
        .filter((s) => s && s !== '无' && s.length <= 200)
        .slice(0, 5);
      for (const l of lines) await memory.addFact(chatId, l, '');
      return lines.length;
    }

    /**
     * 定时整理：只在配置打开时注册。注意改配置要重启插件才生效——
     * ctx.schedule 是在 setup 里注册的，不会跟着配置热更。
     */
    if (conf().autoConsolidate) {
      const hours = Math.max(1, Number(conf().consolidateHours) || 12);
      ctx.schedule('consolidate', hours * 3600_000, async () => {
        const list = await chatList();
        for (const id of list.slice(-50)) {
          try {
            const n = await consolidate(id, await providerFor(id));
            if (n) ctx.logger.info(`定时整理 ${String(id).slice(0, 8)}：+${n} 条记忆`);
          } catch (e) {
            ctx.logger.warn(`定时整理 ${String(id).slice(0, 8)} 失败：${e.message}`);
          }
        }
      });
    }

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
            const cur = await providerFor(msg.chatId);
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
          await setOverride(msg.chatId, { provider: p.id });
          return msg.reply(`本会话已切到：${p.id}（${p.name} / ${p.model}）`);
        }

        if (sub === '人格' || sub === 'persona') {
          const list = personaList();
          const names = Object.keys(list);
          if (!rest) {
            const cur = (await personaFor(msg.chatId)).name;
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
          await setOverride(msg.chatId, { persona: rest });
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
        noteChat(msg.chatId);
          memory.reset(scope);
          await memory.clearSummary(scope);
          return msg.reply('这个对话的上下文已清空（长期记忆还在，要清用 /ai 记忆）');
        }

        if (sub === '记住' || sub === 'remember') {
          if (!rest) return msg.reply('用法：/ai 记住 我喜欢猫');
          const arr = await memory.addFact(msg.chatId, rest, speakerOf(msg));
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

        if (sub === '知识' || sub === 'kb' || sub === 'knowledge') {
          if (rest === '重建' || rest === 'reload' || rest === 'refresh') {
            const i = await knowledge.reload();
            return msg.reply(
              `知识库已重建：${i.docs.length} 个文件 / ${i.chunks.length} 块` +
                (i.vec ? '（已叠向量检索）' : ''),
            );
          }
          const st = await knowledge.stats();
          const vecLine = st.vec
            ? `检索方式：关键词 + 向量（${st.vecModel}，已缓存 ${st.vecCached} 块向量）`
            : providers.embeddingConf()
              ? '检索方式：关键词（向量索引还没建，发 /ai 知识 重建 试一次）'
              : '检索方式：关键词（想语义命中就配 embedding.model）';
          if (!st.docs.length) {
            return msg.reply(
              `知识库是空的。把 .md / .txt 文件放进这个目录：\n${st.dir}\n` +
                '然后发 /ai 知识 重建 重新索引。',
            );
          }
          const lines = st.docs.map((d) => `· ${d.name}（${d.chunks} 块 / ${d.chars} 字）`);
          return msg.reply(
            `知识库：${st.docs.length} 个文件，${st.chunks} 块\n${lines.join('\n')}\n\n` +
              `${vecLine}\n目录：${st.dir}\n发 /ai 知识 重建 重新索引`,
          );
        }

        if (sub === '整理' || sub === 'consolidate') {
          const n = await consolidate(msg.chatId, await providerFor(msg.chatId));
          return msg.reply(
            n
              ? `整理完了，新记住 ${n} 条（用 /ai 记忆 看）`
              : '这段对话里没提炼出值得长期记的东西',
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
            '/ai 记忆 [关键词] —— 看它记得什么 / 搜记忆\n' +
            '/ai 知识 [重建] —— 知识库状态 / 重新索引\n' +
            '/ai 整理 —— 把这段对话里值得记的事提炼成长期记忆',
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
      const files = Array.isArray(msg.files) ? msg.files : [];
      if (!fullText && !images.length && !files.length) return;
      if (fullText && fullText.length < (Number(c.minChars) || 0)) return;

      const now = Date.now();
      const last = ctx.state.lastReply.get(msg.chatId) || 0;
      if (now - last < (Number(c.cooldownSec) || 0) * 1000) return;

      /**
       * 同一会话串行处理：先到的先回，后来的排队。
       *
       * 以前是「忙就直接 return」——用户连发两句，第二句静默消失，
       * 模型永远不知道有这句，用户以为机器人装死。排队才是对的，
       * 但要有上限，否则刷屏时队列越排越长、回复越来越离谱。
       */
      const maxQueue = Math.max(1, Number(c.maxQueue) || 3);
      const q = ctx.state.queues.get(msg.chatId) || { chain: Promise.resolve(), pending: 0 };
      ctx.state.queues.set(msg.chatId, q);
      if (q.pending >= maxQueue) {
        ctx.logger.debug(`队列已满（${q.pending} 条挂着），丢弃 ${String(msg.chatId).slice(0, 8)} 的一条`);
        return;
      }

      q.pending += 1;
      /**
       * 必须 await 自己这一轮：框架的 `msg.reply()` 只是往缓冲区里塞，
       * 真正发送发生在监听器返回之后的 `flushReplies()`。这里要是 fire-and-forget，
       * 迟到的回复就永远躺在缓冲区里发不出去。
       *
       * await 的副作用正好是我们想要的：后面的消息排在队里等前一条回复完，
       * 不会三条消息同时打三次模型、也不会把上下文写乱。
       */
      const run = q.chain
        .then(() => {
          q.pending -= 1; // 开始跑了就交还名额
          return handle(msg, fullText, images, files, c, aiMode);
        })
        .catch(() => {});
      q.chain = run.finally(() => {
        if (q.pending <= 0) ctx.state.queues.delete(msg.chatId);
      });
      await q.chain;
    });

    /** 真正干活的那一轮（已在会话队列里，串行执行） */
    async function handle(msg, fullText, images, files, c, aiMode) {
      const pid = await providerFor(msg.chatId);
      // 一次回复的总时限：模型卡住时能主动放弃，别让这个群永久占着队列
      const timeoutMs = Math.max(10, Number(c.timeoutSec) || 90) * 1000;
      const signal = AbortSignal.timeout(timeoutMs);
      let persona = null;
      try {
        persona = await personaFor(msg.chatId);
        // 会话（群/私聊）→ 对话（话题）：上下文和摘要按对话隔离，人格与长期记忆按会话共享
        const scope = await memory.scopeOf(msg.chatId);
        const [recalled, summaryText, kbList, moodTone] = await Promise.all([
          c.recall === false
            ? memory.facts(msg.chatId).then((list) => ({ list, total: list.length, truncated: false }))
            : memory.recall(msg.chatId, fullText),
          memory.summary(scope),
          // 知识库检索失败不能拖垮回复：它只是加分项
          c.knowledge === false
            ? []
            : knowledge
                .search(fullText, Math.max(1, Number(c.knowledgeTop) || 3))
                .catch(() => []),
          memory.mood(msg.chatId),
        ]);
        const groupChat = msg.kind === 'group';
        const speaker = speakerOf(msg);
        const system = memory.buildSystem({
          persona,
          factList: recalled.list,
          factTotal: recalled.total,
          summaryText,
          kbList,
          groupChat,
          // 运行时情绪优先，没设过就用人格自带语气
          moodTone: moodTone || persona.mood,
          aiMode,
        });
        /**
         * token 预算：system + 开场对话先占掉，剩下的才给历史。
         * 只按轮数限制的话，一轮里塞了几千字的长消息照样能把窗口撑爆。
         */
        const budget = Number(c.maxContextTokens) || 0;
        let historyBudget = 0;
        if (budget) {
          const fixed =
            estimateTokens(system) +
            persona.beginDialogs.reduce((a, m) => a + estimateTokens(m.content), 0);
          historyBudget = Math.max(0, budget - fixed);
        }
        const history = memory.historyForModel(
          scope,
          Number(c.historyTurns) || 12,
          historyBudget,
        );
        const userContent = await buildUserContent(fullText, images, files, c, ctx.logger);
        // 当前这条也要带名字，否则历史里都带、只有最新一条不带，模型容易对错人
        const lastUser =
          speaker && typeof userContent === 'string'
            ? { role: 'user', content: `${speaker}：${userContent}` }
            : { role: 'user', content: userContent };

        const messages = [
          { role: 'system', content: system },
          ...persona.beginDialogs,
          ...history,
          lastUser,
        ];

        // 工具调用循环：模型要工具就执行，把结果喂回去，直到它给最终回复
        // 人格可以单独关掉工具（只想让它纯聊天的角色）
        const useTools = c.tools !== false && persona.tools !== false;
        const tools = useTools ? TOOLS : undefined;
        const maxRounds = Math.max(1, Number(c.maxToolRounds) || 4);
        // 工具循环里可能打好几次模型，用量要按「实际调用」累加，不能只记最后一次
        let uIn = 0;
        let uOut = 0;
        let uCalls = 0;
        const ask = async (withTools) => {
          const res = await providers.chat({
            messages,
            tools: withTools ? tools : undefined,
            providerId: pid,
            signal,
          });
          uCalls += 1;
          uIn += Number(res.usage?.prompt_tokens) || 0;
          uOut += Number(res.usage?.completion_tokens) || 0;
          return res;
        };
        let r = null;
        for (let round = 0; round < maxRounds; round++) {
          r = await ask(true);
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
              out = await runTool(tc.function?.name, args, {
                memory,
                knowledge,
                chatId: msg.chatId,
                userId: msg.userId,
                userName: msg.userName,
              });
            } catch (e) {
              out = `工具执行失败：${e.message}`;
            }
            messages.push({ role: 'tool', tool_call_id: tc.id, content: String(out) });
          }

          // 轮数用尽还没给最终回复：不带工具再要一次，逼它总结
          if (round === maxRounds - 1) {
            r = await ask(false);
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
        memory.addTurn(scope, fullText || '[图片]', answer, { name: speaker });
        ctx.state.lastReply.set(msg.chatId, Date.now());

        stats.replied += 1;
        stats.totalMs += r.ms;
        stats.count += 1;
        stats.lastModel = r.model;
        stats.calls += uCalls;
        stats.inTokens += uIn;
        stats.outTokens += uOut;
        saveUsage();
        ctx.logger.info(
          `${String(msg.chatId).slice(0, 8)} ${r.model} ${r.ms}ms` +
            (uCalls > 1 ? ` / ${uCalls} 次调用` : ''),
        );

        // 后台压缩，不阻塞回复（reply 是攒着发的，等压缩会拖慢发送）
        memory.maybeCompress(scope, pid).catch(() => {});
      } catch (e) {
        stats.errors += 1;
        const timeout = e.name === 'TimeoutError' || /abort/i.test(e.message || '');
        const why = timeout
          ? `模型 ${Math.round(timeoutMs / 1000)} 秒没回（可在配置里调 timeoutSec）`
          : e.message;
        ctx.logger.error('AI 回复失败：', why);
        // 一分钟内只提示一次，别因为模型挂了刷屏
        const lastHint = ctx.state.errHintAt.get(msg.chatId) || 0;
        if (Date.now() - lastHint > 60_000) {
          ctx.state.errHintAt.set(msg.chatId, Date.now());
          // 人格可以自定义「挂了」时说什么（保持角色不跳戏）；没配就用通用文案
          const text = persona?.errorText || `AI 暂时不可用：${why}`;
          await msg.reply(text).catch(() => {});
        }
      }
    }

    ctx.menu('说明', [
      '直连模型，不依赖 DSH；每个会话独立的上下文与人格',
      '一个会话里可以开多个「对话」（话题），上下文互不干扰，长期记忆共用',
      '把说明文档丢进 dataDir/knowledge/，它就能照着文档回答（/ai 知识 看状态）',
      '默认被 @ / 回复时说话，可在配置里改成「AI 自己判断」',
      '用 /ai 帮助 查看管理命令',
    ]);
  },

  teardown(ctx) {
    ctx.state.queues?.clear();
    ctx.state.lastReply?.clear();
  },
};

/** 群聊里的说话人昵称；私聊没必要标（就一个人） */
function speakerOf(msg) {
  return msg?.kind === 'group' ? String(msg.userName || msg.userId || '').slice(0, 20) : '';
}

/**
 * 拼一条 user 消息的内容。
 * 没有图片 → 纯文本；有图片且开了 vision → 下载转 base64 的多模态格式；
 * 否则只标注数量。
 *
 * 为什么转 base64 而不是直接给 URL：QQ 的图片 CDN 地址很多服务商抓不到
 * （防盗链/内网），base64 最稳。太大（>5MB）或下载失败时回退成 URL。
 */
async function buildUserContent(text, images, files, c, log) {
  const tail = await readTextFiles(files, c, log);
  const full = tail ? `${text}\n\n${tail}`.trim() : text;
  if (!images.length) return full;
  if (!c.vision) return `${full}\n[图片×${images.length}]`.trim();
  const parts = [{ type: 'text', text: full || '（请看图）' }];
  for (const img of images.slice(0, 4)) {
    const url = await toImageUrl(img, log);
    if (url) parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|xml|ya?ml|ini|conf|js|mjs|ts|py|go|java|sql|html?)$/i;

/**
 * 把群友发来的**文本类文件**读出来拼进消息。
 *
 * 为什么不解析 PDF/Word/Excel：那三个要么带压缩包（docx/xlsx 是 zip）、要么
 * 是二进制格式，零依赖解析不了。与其半吊子支持、读出乱码，不如只认纯文本，
 * 其它类型在消息里标一句「[文件 x.pdf]」，让模型知道有这么个东西。
 */
async function readTextFiles(files, c, log) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return '';
  const maxChars = Math.max(0, Number(c.maxFileChars) || 4000);
  const out = [];
  for (const f of list.slice(0, 3)) {
    const name = String(f?.filename || '').slice(0, 60);
    const isText =
      String(f?.contentType || '').startsWith('text/') || TEXT_EXT.test(name);
    if (!c.readFiles || !isText || maxChars === 0) {
      out.push(`[文件 ${name || '未命名'}]`);
      continue;
    }
    try {
      const res = await fetch(f.url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.text();
      const body = raw.slice(0, maxChars);
      out.push(
        `【文件 ${name || '未命名'}】\n${body}${raw.length > maxChars ? `\n…（还有 ${raw.length - maxChars} 字没贴）` : ''}`,
      );
    } catch (e) {
      log?.debug?.(`读文件失败 ${name}：${e.message}`);
      out.push(`[文件 ${name || '未命名'}（读不出来）]`);
    }
  }
  return out.join('\n\n');
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
      name: 'set_mood',
      description:
        '调整自己接下来的说话语气（比如被逗乐了、被骂了有点不爽、聊累了想短说）。' +
        '只在语气真的该变时调，别每句都调；传空字符串表示回到平常。',
      parameters: {
        type: 'object',
        properties: {
          tone: {
            type: 'string',
            description: '一句人话描述此刻的语气，如「有点烦，话短」「心情不错，愿意多聊」',
          },
        },
        required: ['tone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: '在知识库（群里的说明文档）里查资料，回答规则、玩法、指令这类问题前先查',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '查什么' } },
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

async function runTool(name, args, { memory, knowledge, chatId, userName }) {
  switch (name) {
    case 'get_time':
      return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    case 'remember': {
      if (!args?.text) return '缺少要记住的内容';
      const arr = await memory.addFact(chatId, args.text, userName);
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
    case 'set_mood': {
      const tone = String(args?.tone || '').trim();
      await memory.setMood(chatId, tone);
      return tone ? `语气已调整：${tone}` : '语气回到平常';
    }
    case 'search_knowledge': {
      const q = String(args?.query || '').trim();
      if (!q) return '缺少查询内容';
      const hits = await knowledge.search(q, 3);
      if (!hits.length) return '知识库里没有相关内容';
      return hits.map((h) => `〔${h.doc}〕\n${h.text}`).join('\n\n');
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

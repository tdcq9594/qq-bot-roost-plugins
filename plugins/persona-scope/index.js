/**
 * persona-scope —— 专属人设（对指定的人换一套人格，不影响全局）
 *
 * ── 它解决什么 ────────────────────────────────────────────────────
 * 机器人的人设本来是全局的。有时候只想**对某一个人**换一套——比如主人。
 * 这个人来聊天时用专属人设，别人来还是原文；两套互不干扰。
 *
 * ── 在 Roost 上怎么做到的（重要，决定它的能力边界）──────────────
 * Roost 里人设本身由**宿主侧**负责（ai-chat 把 `system` 交给 DSH / webhook，
 * 人设来自 dsh-roost 的 `personas/*.md` + 按群覆盖），插件之间没有
 * "provider / 注入系统提示" 这种通道 —— ctx 上只有 command / on / use /
 * schedule / storage / tool 这几样。
 *
 * 所以这里走**中间件**：在插件分发之前，只改写「命中的人」这一轮的正文，
 * 把专属人设拼成一段带边界的指令块附在原文后面。
 *   · 对其它插件透明：原文一个字不动，标记只用中文书名号，不会被当成命令前缀
 *   · 对别人不生效：只改命中者的那条消息，其余人在群里完全感知不到
 *   · 对 AI 插件通用：不改 ai-chat 内部，换 webhook / DSH 也一样有效
 *
 * 代价说清楚：它进的是**用户消息**而不是系统提示，权重比真正的人设低一层；
 * 而且每轮都会占一点 token（有 maxChars 上限）。要更强的人设请继续用
 * 宿主侧的 personas/*.md，这个插件负责「只对某个人」这层差异化。
 *
 * ── 为什么只认 openid ─────────────────────────────────────────────
 * 昵称、群名片随时能改，两个人同名很常见。一旦「名字像就算」，
 * 任何把名片改成主人名字的路人都能拿到专属设定 —— 这是权限差异，
 * 误认的代价远高于漏认。所以判定函数签名里根本没有能传名字的参数。
 */
import {
  normalizeCards, normalizePresets, migrateRules, parseIdList, matchesTarget, pickCard, cardsForUser, presetCost,
  buildPersonaBlock, buildVars, injectInto, stripInjection, renderTemplate, BLOCK_OPEN, BLOCK_CLOSE,
} from './lib/card.js';
import { buildPresetsPage, buildCardsPage } from './lib/page.js';
import { EXAMPLE_CARD } from './lib/example-card.js';

export const VERSION = '1.3.1';

/** 人设块在正文里的定位标记，别的插件/日志靠它识别 */
export const MARK = BLOCK_OPEN;

export const DEFAULTS = {
  enabled: true,
  targets: '',
  minLevel: 0,
  cards: [],
  defaultCard: '',
  presets: [],
  maxChars: 1200,
  onlyWhenAddressed: false,
  debug: false,
};

export function readCfg(ctx) {
  const raw = ctx?.config || {};
  const val = (k) => {
    const v = raw[k];
    // 面板给的是值；testkit 会把字段描述符原样递进来
    const x = v && typeof v === 'object' && !Array.isArray(v) && 'default' in v ? v.default : v;
    return x === undefined || x === null ? DEFAULTS[k] : x;
  };
  return {
    enabled: val('enabled') !== false,
    targets: String(val('targets') ?? ''),
    minLevel: Math.max(0, Number(val('minLevel')) || 0),
    cards: normalizeCards(val('cards')),
    defaultCard: String(val('defaultCard') ?? ''),
    /**
     * 预设列表（对齐 RP-Hub 的预设管理）。
     * 老配置里存的是 `rules`，这里兜一下迁移：不迁移的话升级后用户之前写的规则会凭空消失。
     */
    presets: (() => {
      const now = normalizePresets(val('presets'));
      if (now.length) return now;
      return migrateRules(val('rules'));
    })(),
    maxChars: Math.max(100, Number(val('maxChars')) || 1200),
    onlyWhenAddressed: val('onlyWhenAddressed') === true,
    debug: val('debug') === true,
  };
}

export default {
  id: 'persona-scope',
  name: 'rp人设',
  version: '1.3.1', // 必须是字面量，与上面的 VERSION 同步
  shortDesc: '对指定的人换一套人格，别人不受影响。rp向插件，建议相对懂rp再玩',
  description: '给指定的人（如主人）单独换一套人设卡，支持正则条件分支；其他人仍是原人设',
  icon: '🎭',
  frameworkVersion: '>=0.6.10',
  /**
   * 必须落在 weather-card(10) 之后、ai-chat(-100) 之前。
   *
   * 监听器按 priority 降序串行执行，共用同一个 msg —— 站在这个位置才能
   * 「别的插件都看到干净正文，只有 AI 看到带人设的版本」。
   * 当前链路：trpg-forwarder 60 → reply-judge 50 → weather-card 10 → 本插件 5 → ai-chat -100
   * 改这个数字前先确认上面几个插件的 priority 没变，否则排序会重新倒挂。
   */
  priority: 5,

  config: {
    enabled: { type: 'boolean', default: true, label: '启用专属人设', desc: '关闭后完全不改任何消息，行为与没装这个插件一致。' },
    targets: {
      type: 'string',
      default: '',
      label: '对哪些人生效（openid）',
      desc: '逗号/空格分隔。只认 openid —— 协议字段，改名、撞名都不影响。'
        + '留空时不按名单生效，但仍可按下面的「权限等级」生效。'
        + '不知道自己的 openid？让对方发一句 /人设 我是谁，机器人会把 openid 回给本人。',
    },
    minLevel: {
      type: 'number',
      default: 0,
      min: 0,
      label: '或按权限等级生效（0 = 不看等级）',
      desc: '等级数字越小越高：0=主人、1=管理员、2=群管、3=助手。填 1 表示「管理员及以上都用专属人设」。'
        + '与上面的 openid 名单是「或」的关系。',
    },
    cards: {
      type: 'json',
      default: [],
      label: '人设卡（JSON 数组）',
      desc: '（不懂就让ai帮你改）每个元素 { id, name, text, targets? }。text 里可以用 {{if /正则/}}…{{else}}…{{end}} 写条件分支，'
        + '符合 RP 人设卡的写法。例：{"id":"butler","name":"执事","text":"角色：你是{{nick}}的执事。\\n{{if /早安|早上好/}}早上用问候语气。{{end}}"}',
    },
    defaultCard: { type: 'string', default: '', label: '默认用人设卡 id', desc: '留空 = 用数组里第一套。' },
    /**
     * 预设列表本身由「预设管理」页维护，面板这里只留一个只读说明。
     *
     * 不把 JSON 文本域摆在这里：几百字的预设塞进一个输入框，改一个字都要滚半天，
     * 也没法排序、单条开关、导入导出。面板里给个入口，编辑去那个页面。
     */
    presets: {
      type: 'json',
      default: [],
      label: '预设（用「预设管理」页编辑，别手改）',
      desc: '在面板左侧「专属人设 · 预设管理」里新建/排序/开关/导入导出。'
        + '这里声明成配置项是必须的：配置重置（恢复默认）时框架按这份 schema 重建文件，'
        + '不声明的话预设会被整份丢掉。手改这个 JSON 也行，但记得字段是 '
        + '{ name, role, when, content, enabled }。',
    },
    maxChars: {
      type: 'number',
      default: 1200,
      min: 100,
      max: 20000,
      label: '注入长度上限（字符，maxChars）',
      desc: '人设卡 + 启用的预设，每轮都会拼进消息发出去。超出这个上限时**优先保住预设**（防抢话、破限这类规则比卡片的台词示例更关键），先截短人设卡正文；只有预设本身超过上限才会去截预设。'
        + '怎么定：'
        + '① 只用人设卡、话不多 → 800~1200；'
        + '② 标准的 RP 人设卡（基础信息/性格/口吻/台词示例/扮演指导）→ 1200~3000，随卡片实际字数定；'
        + '③ 卡片之外还开「破限」这类长预设 → 两者相加再留 200 余量（随包示例卡 1211 + 破限 3552 ≈ 4900）。'
        + '预算越大每轮越费 token、越挤上下文，够用就行。'
        + '在「人设卡」页顶部有实时预算条，会直接显示「当前内容 N 字 / 预算 M 字」，超了变红提醒。',
    },
    onlyWhenAddressed: { type: 'boolean', default: false, label: '只在对方叫机器人时注入', desc: '默认关：这个人说的每句都按专属人设。打开后只在他 @ 机器人 / 私聊时注入，群里闲聊时不带（更省 token，但人设切换会有断层感）。' },
    debug: { type: 'boolean', default: false, label: '调试日志', desc: '把每次注入的块写进插件日志，方便调正则。' },
  },

  setup(ctx) {
    const log = ctx.logger;
    ctx.state.ps ??= { injected: 0, skipped: 0, last: '', lastAt: 0 };
    const st = ctx.state.ps;

    let dashTimer = null;
    const refreshDashboard = () => {
      if (dashTimer) return;
      dashTimer = setTimeout(() => {
        dashTimer = null;
        try {
          const c = readCfg(ctx);
          ctx.setDashboard?.({
            metrics: [
              { label: '已注入', value: st.injected, unit: '次' },
              { label: '命中但跳过', value: st.skipped, unit: '次' },
              { label: '人设卡', value: c.cards.length, unit: '套' },
              { label: '预设', value: `${c.presets.filter((p) => p.enabled !== false).length}/${c.presets.length}`, unit: '条' },
              { label: '生效对象', value: parseIdList(c.targets).length + (c.minLevel ? `+等级≥${c.minLevel}` : '') },
              { label: '最近一次', value: st.last || '—' },
            ],
            note: `中间件注入，不改全局人设\n${c.enabled ? '' : '⚠️ 当前已关闭'}`,
          });
        } catch { /* 面板不是关键路径 */ }
      }, 1500);
    };

    /**
     * 这个人这一轮该拿到什么。**注入和 /人设 命令共用这一个判定**。
     *
     * 以前两处各判各的：注入那边传了 `card.targets`、命令那边只传全局 `targets`，
     * 于是「只在卡片名单里写了某人」的情况下，他能收到专属人设、却看不了 `/人设 预览`
     * （被判成「不在生效范围」）—— 同一个事实两个答案，用户只会觉得插件坏了。
     *
     * @returns {{ card: object|null, matched: boolean, block: string }}
     *   matched 表示「身份上属于生效对象」，与最终是否注入无关 ——
     *   skipped 指标靠它区分「路人」和「目标但这次没注入」。
     */
    async function resolveFor(msg, { ignoreAddressed = false } = {}) {
      const c = readCfg(ctx);
      const empty = { card: null, matched: false, block: '' };
      if (!c.enabled) return empty;
      if (!c.cards.length && !c.presets.length) return empty;

      const level = await ctx.levelOf(msg).catch(() => 9999);
      const card = pickCard(cardsForUser(c.cards, { userId: msg.userId }), c.defaultCard);
      /**
       * 用**这张卡自己的名单**去判：卡片有名单就只看名单，没有才回落到全局。
       * 不这么做的话，「只给 A 用的卡」会被全局名单/等级放行给 B（串卡）。
       */
      const matched = Boolean(matchesTarget(
        { userId: msg.userId, level, targets: c.targets, minLevel: c.minLevel },
        card?.targets ?? '',
      ));
      if (!matched) return { card, matched: false, block: '' };

      if (!ignoreAddressed && c.onlyWhenAddressed && msg.kind === 'group' && msg.addressed !== true) {
        return { card, matched: true, block: '' };
      }

      const vars = buildVars({
        nick: msg.userName,
        userId: msg.userId,
        level,
        chatId: msg.chatId,
        // 可能只有预设没有卡：这里必须容 null
        cardName: card?.name ?? '',
      });
      const subject = stripInjection(msg.content);
      const block = buildPersonaBlock({ card, presets: c.presets, subject, vars, maxChars: c.maxChars });
      return { card, matched: true, block };
    }

    /** 兼容旧调用点：只要注入正文 */
    async function personaFor(msg, opt) {
      return (await resolveFor(msg, opt)).block;
    }

    /**
     * 注入点：**监听器，不是中间件**。
     *
     * 这一条是踩过的坑，别改回 ctx.use：
     *
     * 中间件的执行顺序由 `ctx.use` 的注册顺序决定（= 插件目录的加载顺序），
     * 跟 `priority` 完全无关 —— priority 只管 `on('message')` 监听器。
     * `persona-scope` 目录名排在 `reply-judge` / `trpg-forwarder` / `weather-card` 前面，
     * 所以它在中间件里一改 `msg.content`，后面所有插件看到的都是被拼了几百字人设的正文：
     *   · reply-judge 会命中「你」字规则、长度扣分 → 强行接话或被判成粘贴
     *   · weather-card 要求 ≤20 字才触发 → 目标用户说「上海天气」再也不出卡
     *   · trpg-forwarder 会把一整段执事人设当行动文本发给守密人
     *
     * 改用监听器后就能靠 priority 精确落位（监听器按 priority 降序串行执行、共用同一个 msg）：
     *
     *   trpg-forwarder 60 → reply-judge 50 → weather-card 10 → **本插件 5** → ai-chat -100
     *
     * 于是别的插件都看到干净正文，只有 AI 看到带人设的版本。
     * 中间件（trpg-forwarder）在所有监听器之前跑，同样拿到干净正文。
     *
     * 不调 `msg.claim()`：要不要回话是 ai-chat 的事，这里只负责把设定摆到它面前。
     */
    ctx.on('message', async (msg) => {
      try {
        // 命令有自己的处理链，塞一段人设进去只会污染指令解析
        if (!msg || msg.isCommand) return;
        if (!msg.content || !String(msg.content).trim()) return;
        const { matched, block } = await resolveFor(msg);
        /**
         * `skipped` 只统计**目标用户这次没注入**，不统计路人。
         *
         * 以前这里对返回空就 +1 并刷面板，而 personaFor 对全群路人都返回空 ——
         * 几百人的活跃群里，谁聊句闲话都会把这个数顶上去，指标彻底失去意义
         *（还会给每条闲聊挂一个 1.5s 的刷新定时器）。
         */
        if (!block) {
          if (matched) { st.skipped += 1; refreshDashboard(); }
          return;
        }
        msg.content = injectInto(msg.content, block);
        st.injected += 1;
        st.last = String(msg.userName || msg.userId || '').slice(0, 16);
        st.lastAt = Date.now();
        if (readCfg(ctx).debug) log.info(`注入专属人设 → ${st.last}（${block.length} 字）\n${block}`);
        refreshDashboard();
      } catch (e) {
        // 这里崩了不能影响别的插件：只记日志，正文保持原样
        log.warn(`专属人设注入失败，本条按原样放行：${e?.message || e}`);
      }
    });

    /* ── 命令 ───────────────────────────────────────────────── */

    ctx.command('人设 [操作]', { desc: '专属人设：预览 / 测试 / 我是谁' }, async (msg) => {
      const c = readCfg(ctx);
      const op = String(msg.args?.[0] || '').trim();
      /**
       * 「预览」和「测试」会把专属人设卡与预设原文原样打出来。
       *
       * 那是写给某一个人的私密设定（可能还有破限词），不能谁问都给：
       * 以前群里任何路人发一句 `/人设 测试 随便`，整份人设就上了公屏。
       * 所以这两条要求「管理员，或本身就是生效对象」。
       */
      const level = await ctx.levelOf(msg).catch(() => 9999);
      const isAdmin = await ctx.can(msg, 1).catch(() => false);
      /**
       * 「是不是生效对象」必须和注入侧用**同一个判定**。
       * 以前这里只传全局 targets，导致「只在卡片名单里写了某人」的配置下，
       * 那个人聊天能收到专属人设、却看不了 /人设 预览 —— 同一个事实两个答案。
       */
      const isTarget = (await resolveFor({ ...msg, content: msg.content || '', isCommand: false }, { ignoreAddressed: true })).matched;
      const mayView = isAdmin || isTarget;

      if (op === '我是谁') {
        return msg.reply([
          '你的身份信息（这些是机器人用来认人的依据）：',
          `openid：${msg.userId}`,
          `会话：${msg.kind === 'group' ? '群' : '私聊'} ${msg.chatId}`,
          `权限等级：${level}`,
          '',
          '把 openid 填进「对哪些人生效」即可获得专属人设。',
        ].join('\n'));
      }

      if (op === '预览' || op === '测试') {
        if (!mayView) return msg.reply('专属人设的内容只对管理员和生效对象可见。');
      }

      if (op === '预览') {
        /**
         * 先按「你自己这一条会注入什么」算；
         * 管理员不在生效范围时再退一步，按配置内容渲染一份给他检查 ——
         * 否则管理员没法验证自己写的卡，只能换号试。
         */
        let { block } = await resolveFor({ ...msg, content: msg.content || '', isCommand: false }, { ignoreAddressed: true });
        let adminView = false;
        if (!block && isAdmin) {
          adminView = true;
          const card = pickCard(c.cards, c.defaultCard);
          const vars = buildVars({ nick: msg.userName, userId: msg.userId, level, chatId: msg.chatId, cardName: card?.name ?? '' });
          block = buildPersonaBlock({ card, presets: c.presets, subject: String(msg.content || ''), vars, maxChars: c.maxChars });
        }
        if (!block) {
          return msg.reply([
            '这一条不会注入专属人设。原因可能是：',
            c.enabled ? '' : '· 插件已关闭（看面板）',
            c.cards.length || c.presets.length ? '' : '· 还没配置人设卡或预设',
            '· 你的 openid / 等级不在生效范围内',
            c.onlyWhenAddressed ? '· 开了「只在叫机器人时注入」，而这条没 @ 我' : '',
            '',
            '发 /人设 我是谁 可以看到自己的 openid 和等级。',
          ].filter(Boolean).join('\n'));
        }
        if (adminView) return msg.reply(`你不在生效范围内，下面按配置内容渲染（仅供检查）：\n\n${block}`);
        return msg.reply(`如果这条消息会进 AI，注入内容会是：\n\n${block}`);
      }

      if (op === '测试') {
        /**
         * 样本从 `msg.args` 取，不要从 `msg.content` 剥前缀：
         * 群里 @机器人 触发时 content 里带 at 段、命令前缀也可能是别的字符，
         * 用正则剥很容易剥不干净，把「@机器人 /人设 测试 抱抱」整条当成样本。
         */
        const sample = (Array.isArray(msg.args) ? msg.args.slice(1).join(' ') : '').trim();
        if (!sample) return msg.reply('用法：/人设 测试 抱抱你\n用这句话试一下正则条件会走哪个分支');
        const card = pickCard(cardsForUser(c.cards, { userId: msg.userId }), c.defaultCard);
        if (!card && !c.presets.length) return msg.reply('还没配置人设卡或预设');
        const vars = buildVars({ nick: msg.userName, userId: msg.userId, level, chatId: msg.chatId, cardName: card?.name ?? '' });
        /**
         * 直接走真实拼装函数而不是只渲染 `card.text`：
         * 这样能一并验证预设的 when 条件，而且「只有预设没有卡」时也测得出来
         * （以前这里硬取 `card.name`，没有卡就直接报错，等于把无卡配置挡在测试之外）。
         */
        const block = buildPersonaBlock({ card, presets: c.presets, subject: sample, vars, maxChars: c.maxChars });
        const body = stripInjection(block).replace(BLOCK_OPEN, '').replace(BLOCK_CLOSE, '').trim();
        return msg.reply([
          `测试句：${sample}`,
          `人设卡：${card ? (card.name || card.id) : '（没有，只用预设）'}`,
          `预设：${c.presets.filter((p) => p.enabled !== false).length}/${c.presets.length} 条启用`,
          '',
          '渲染结果：',
          body || '（空 —— 条件都没命中，且没有无条件内容）',
        ].join('\n'));
      }

      // 默认：状态。卡名与内容对非管理员不做展开（同一个泄露面）
      const ids = parseIdList(c.targets);
      const lines = [
        `专属人设 v${VERSION}｜${c.enabled ? '已启用' : '已关闭'}`,
        mayView
          ? `人设卡：${c.cards.length} 套（${c.cards.map((x) => x.name || x.id).join('、') || '无'}）`
          : `人设卡：${c.cards.length} 套`,
        `预设：${c.presets.length} 条（启用 ${c.presets.filter((p) => p.enabled !== false).length}）`,
        `生效对象：${ids.length ? `${ids.length} 个 openid` : '未配置 openid'}${c.minLevel ? ` + 等级≤${c.minLevel}` : ''}`,
        `只在叫机器人时注入：${c.onlyWhenAddressed ? '是' : '否'}`,
      ];
      lines.push('', mayView
        ? '/人设 预览 看这一条会注入什么｜/人设 测试 <句子> 试正则｜/人设 我是谁 查自己的 openid'
        : '人设卡名与预设内容仅管理员可见。发 /人设 我是谁 可以看到自己的 openid。');
      return msg.reply(lines.join('\n'));
    });

    ctx.menu('专属人设', [
      { text: '对指定的人换一套人设', desc: '在面板填「对哪些人生效」+ 人设卡，不影响全局' },
      { cmd: '人设 预览', desc: '看这条消息会注入的专属人设内容' },
      { cmd: '人设 测试 抱抱你', desc: '用给定句子试一下正则条件走哪个分支' },
      { cmd: '人设 我是谁', desc: '查自己的 openid 与权限等级' },
      { text: '预设管理', desc: '面板左侧「专属人设 · 预设管理」：新建 / 排序 / 开关 / 导入导出' },
    ]);

    /* ── 预设管理页 + 它的后端接口 ──────────────────────────── */

    /**
     * 一个整页的「预设管理」UI（RP-Hub 那种列表：排序、单条开关、编辑、导入导出）。
     *
     * 面板的 config 只支持 number/text/boolean/select/json/textarea，
     * 摆一个 JSON 文本域给用户改几百字预设是最难用的形态 —— 所以走 registerPage：
     * 独立 iframe（CSS 不外漏），数据通过下面两条 registerRoute 读写。
     *
     * 夹具里 registerPage / registerRoute 都返回 null，所以都要能容忍不存在。
     */
    try {
      ctx.registerPage?.({ key: 'presets', label: '预设管理', html: buildPresetsPage() });
      /**
       * 人设卡页：列表 + 编辑 + 载入示例 + **注入预算条**。
       *
       * maxChars 单独开到这一页，是因为它和卡片长度强耦合：
       * 卡片写 3000 字、预算还是 1200，尾部就被截断，而用户很难自己把
       * 「调设置」和「内容变短了」联系起来。放在同一屏里能当场看到。
       */
      ctx.registerPage?.({ key: 'cards', label: '人设卡', html: buildCardsPage() });
    } catch (e) {
      log.warn(`管理页注册失败（框架版本可能偏旧）：${e?.message || e}`);
    }

    const hasRoute = Boolean(ctx.registerRoute?.('GET', '/presets', async () => {
      const c = readCfg(ctx);
      return { presets: c.presets };
    }));
    if (!hasRoute) log.warn('当前环境不支持 registerRoute，预设管理页只能看不能存');

    /**
     * 人设卡的读写。
     * `?example=1` 直接把随包的示例卡交给页面，页面点「载入示例」不用自己拼 JSON。
     */
    ctx.registerRoute?.('GET', '/cards', async ({ query }) => {
      const c = readCfg(ctx);
      const withMeta = (list) => list.map((x) => ({ id: x.id, name: x.name, targets: x.targets, text: x.text }));
      if (String(query?.example ?? '') === '1') return { cards: withMeta(c.cards), example: EXAMPLE_CARD };
      return {
        cards: withMeta(c.cards),
        // 页面要算「卡片 + 预设」的总长度，所以把预设字数一并给出
        // 用 presetCost 而不是 content.length：user/assistant 角色还会多一层来源标注
        presetTotal: c.presets.reduce((n, p) => n + presetCost(p), 0),
        maxChars: c.maxChars,
      };
    });

    ctx.registerRoute?.('PUT', '/cards', async ({ body, json }) => {
      const list = body && Array.isArray(body.cards) ? body.cards : null;
      if (!list) return json(400, { ok: false, error: '缺少 cards 数组' });
      const clean = normalizeCards(list);
      await ctx.setConfig({ cards: clean });
      log.info(`人设卡已更新：${clean.length} 张`);
      return { ok: true, count: clean.length };
    });

    /**
     * 只改注入预算。
     *
     * 单独一条路由而不是塞进 /cards：预算影响的是**每一轮**的消息长度，
     * 和卡片内容不是一回事；页面上的「改预算」按钮也不该触发整份卡片重写。
     */
    ctx.registerRoute?.('PUT', '/settings', async ({ body, json }) => {
      const v = Number(body?.maxChars);
      if (!Number.isFinite(v) || v < 100) return json(400, { ok: false, error: 'maxChars 必须 ≥ 100' });
      // 上限 20000：再大就不是人设卡而是整本小说，每轮都发会直接把上下文撑爆
      const capped = Math.min(20000, Math.round(v));
      await ctx.setConfig({ maxChars: capped });
      log.info(`注入预算已改为 ${capped} 字`);
      return { ok: true, maxChars: capped };
    });

    ctx.registerRoute?.('PUT', '/presets', async ({ body, json }) => {
      const list = body && Array.isArray(body.presets) ? body.presets : null;
      if (!list) return json(400, { ok: false, error: '缺少 presets 数组' });
      /**
       * 归一化后再落盘：页面传来的东西同样不可信（手改过的 localStorage、
       * 从别处导入的 JSON），坏字段不能直接进配置。
       */
      const clean = normalizePresets(list);
      await ctx.setConfig({ presets: clean });
      log.info(`预设已更新：${clean.length} 条（启用 ${clean.filter((p) => p.enabled !== false).length}）`);
      return { ok: true, count: clean.length };
    });

    ctx.onTeardown?.(() => { if (dashTimer) clearTimeout(dashTimer); });
    refreshDashboard();
    log.info(`专属人设已加载 v${VERSION}｜人设卡 ${readCfg(ctx).cards.length} 套｜生效对象 ${parseIdList(readCfg(ctx).targets).length} 个`);
  },
};

// 给测试用的出口
export const internals = {
  readCfg, personaFor: null, parseIdList,
};

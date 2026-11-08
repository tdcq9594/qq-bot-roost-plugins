/**
 * 决策门：这条消息要不要理？
 *
 * 新设计里插件**不注册任何指令**——群里说什么它都看得见，
 * 由它自己决定接不接话。但「每条都问一次模型」既贵又吵，
 * 所以先用一层**免费规则**把大部分消息挡掉，剩下的才交给模型判断。
 *
 * 三层，从便宜到贵：
 *   1. 硬规则（这里，纯内存判断，0 成本）
 *   2. 模型判断（system prompt 里让它输出 <skip> 表示不接）
 *   3. 冷却与配额（回过一次就安静一会儿）
 *
 * 为什么把「@ 我 / 回复我 / 私聊」直接放行到第 3 步：
 * 这些是明确的对话请求，再让模型判断一遍纯属浪费。
 */

import { RELEVANCE_MIN, inQuietHours, isShortAsk, topicRelevance } from './policy-config.js';

/** 模型用这个标记表示「这条我不该接」 */
export const SKIP_MARK = '<skip>';

/** 默认忽略词：别的插件靠这些关键词干活，别抢 */
export const DEFAULT_IGNORE = ['/'];

/**
 * @param {object} msg Roost 的 Message
 * @param {object} c 配置（conf() 的结果）
 * @param {object} state 每会话的运行时状态（冷却/配额），由调用方维护
 * @returns {{ go: boolean, force?: boolean, reason: string }}
 *   go=false 就别往下走了；force=true 表示「明确在叫我」，跳过模型判断
 */
/**
 * 这条消息「说了什么」。
 *
 * **官方接口里纯图片/纯语音消息的 content 是空串**，内容全在 attachments 里：
 *   · 图片：attachments[].url
 *   · 语音：attachments[].asrText（官方 ASR 白给的转写）
 *
 * 所以不能只看 content —— 只看它的话，用户发张图/说句话，
 * 会被当成「空消息」直接跳过，表现就是「框架收不到」。
 */
export function textOf(msg) {
  const said = String(msg?.content ?? '').trim();
  const asr = (msg?.attachments ?? [])
    .filter((a) => a?.type === 'voice' && a.asrText)
    .map((a) => String(a.asrText).trim())
    .filter(Boolean)
    .join(' ');

  /**
   * 打字和语音**都要留下**。
   *
   * 以前是 `if (said) return said;`——用户打一句「你听」再补一条语音，
   * 语音的转写就整段丢了，模型只看到「你听」。而这条路径是纯语音的
   * 主路径（`content` 为空时才走 asrText），所以改这里不会影响纯语音。
   *
   * `includes` 那个判断是防重复：某些版本的框架会把转写直接拼进
   * `content`，这时再加一遍就重复了。
   */
  if (!said) return asr;
  if (!asr || said.includes(asr)) return said;
  return `${said}\n${asr}`;
}

/**
 * 这条是机器人发的吗。
 *
 * 官方事件体里 `author.bot` 是 boolean（文档：「是否为机器人」），
 * 这是**唯一可靠**的判据——从正文猜「这语气像 AI」必然误伤：
 * 群里真有人这么说话，也有 AI 说得像人。
 *
 * 为什么要判：群里有第二个 AI 时，两边都是「读所有消息、自己决定接不接」，
 * 谁都不认识对方是机器人。2026-10-28 实测，一句「嗨」滚成十几轮，
 * 两个号还互相起外号（「分号」「小点点」），最后要人喊「停下」才断。
 *
 * `msg.isBot` 是框架将来可能会给的字段（现在还没有），先认着，
 * 有了就直接用，不用再改这里。
 */
export function isFromBot(msg) {
  return msg?.isBot === true || msg?.raw?.author?.bot === true;
}

export function shouldConsider(msg, c, state = {}) {
  // 私聊一律理——用户专门点开来跟你说话，没有「打扰」的问题
  if (msg.kind === 'c2c') return { go: true, force: true, reason: '私聊' };

  const now = Date.now();
  /** 「@ 之后」窗口时长（毫秒）。只有 `window` 模式用得上 */
  const winMs = Math.max(1, Number(c.windowMin) || 3) * 60_000;

  /**
   * 真 @ 了：任何模式下都直接接，不再让模型判断「要不要接」。
   *
   * `window` 模式顺手把窗口续上——**窗口只由真 @ 打开**，
   * 不由「命令」打开（以前 `bot.js` 的 sticky 是 `mentioned || isCommand`，
   * 于是发一条「扔骰子」也能让她接下来三分钟句句接话，那是 bug）。
   */
  if (msg.mentioned) {
    if (c.decide === 'window') state.windowUntil = now + winMs;
    return { go: true, force: true, reason: '被 @' };
  }

  // 别的插件的指令到不了这里（框架在分派阶段就 return 了），
  // 但用户可能把前缀改成别的东西，所以再兜一道
  const ignore = Array.isArray(c.ignoreWords) ? c.ignoreWords : DEFAULT_IGNORE;
  const text = textOf(msg);
  const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
  // 纯图片 / 纯语音：文本是空的，但 attachments 有东西 —— 不能算空消息
  if (!text && !atts.length) return { go: false, reason: '空消息' };
  for (const w of ignore) {
    if (w && text.startsWith(w)) return { go: false, reason: `以「${w}」开头，像是别的插件的指令` };
  }

  /**
   * 三种模式的收敛点（`ai` 之外的两个在这里挡住）。
   *
   *   · `mention` —— 只有真 @ 才接。**不认**框架的「免 @ 窗口」：
   *     那个窗口是 `mentioned || isCommand || sticky` 的合并布尔
   *     （`message.js:266`），认它就等于「@ 过一次之后句句都接」，
   *     用户设的「只在被 @ 时」形同虚设（线上真实反馈）。
   *   · `window`  —— @ 之后 `windowMin` 分钟内都接；过点恢复安静。
   *     窗口状态放在 `state`（per-chat 的 pace 对象）里，不依赖框架的 sticky。
   */
  if (c.decide === 'mention') return { go: false, reason: '当前是「只在被 @ 时回复」模式' };
  if (c.decide === 'window') {
    if (state.windowUntil && now < state.windowUntil) {
      return { go: true, force: false, reason: '在 @ 之后的窗口内' };
    }
    return { go: false, reason: '不在 @ 之后的窗口内' };
  }

  /**
   * `ai` 模式：框架的「免 @ 窗口 / 命令」仍然算在叫她。
   * 这个模式本来就每条都看，force 只是让它绕开情绪闸门和配额。
   */
  if (msg.addressed) return { go: true, force: true, reason: '在免@窗口内 / 命令' };

  // 冷却：刚回过就别急着再回，否则一个人能跟它刷屏
  if (state.lastReplyAt && now - state.lastReplyAt < c.cooldownSec * 1000) {
    /**
     * 冷却期内**不丢消息**，攒着。
     *
     * 以前这里直接 `go: false`，用户在这 20 秒里说的话就凭空消失了——
     * 他说了三句，机器人一句都没看见，体感极差。
     * 现在放行，但带上「还剩多久」，由合并窗口压到冷却结束再一起交出去。
     */
    const left = c.cooldownSec * 1000 - (now - state.lastReplyAt);
    return {
      go: true,
      cooling: true,
      cooldownLeftMs: Math.max(0, left),
      reason: `冷却中（还剩 ${Math.ceil(left / 1000)} 秒，攒着）`,
    };
  }

  // 每分钟配额：防止群里聊得热火朝天时它跟着狂刷
  if (c.maxRepliesPerMin > 0) {
    const recent = (state.replyTimes ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= c.maxRepliesPerMin) {
      return { go: false, reason: `每分钟最多 ${c.maxRepliesPerMin} 条，已经用满` };
    }
  }

  /**
   * ---- 可选接话策略（调研报告 A2/A3/A4/A5 + E10 读取位）----
   *
   * 默认 `decide:'ai'` + 所有 `policy*` 参数为 0/false 时 `policyActive`
   * 为 false，整块跳过、连 `state` 都不碰——必须与升级前逐字等价。
   * 老配置 / 测试夹具没有 `c.policy` 时同样跳过。
   *
   * 放在冷却与每分钟配额**之后**：那两道先拦，拦了就不计入策略次数，
   * 免得「被冷却挡掉的消息」也把小时额度吃掉。
   */
  const p = c.policy;
  const policyActive = !!p && (
    p.mode !== 'ai' || p.burstMax > 0 || p.maxPerHour > 0 ||
    p.quietStartHour !== p.quietEndHour || p.shortAskMustReply || c.silent === true
  );
  if (policyActive) {
    /** E10：阶段 7 的 `/silent` 会写这个值；被 @ / 私聊 / addressed 已在上面放行 */
    if (c.silent === true) return { go: false, reason: '主人设了静默' };

    const times = (state.policyTimes ??= []);
    while (times.length && now - times[0] > 3_600_000) times.shift();
    const shortAsk = isShortAsk(text, p.shortAskMustReply);

    /** 明确被追问时刹车不拦（对方 `group-policy.js` 同款：明确被叫不拦） */
    if (!shortAsk) {
      /** 测试可注入小时（state.policyNowHour），生产走本地时间 */
      const hour = Number.isFinite(state.policyNowHour) ? state.policyNowHour : new Date().getHours();
      if (inQuietHours(p, hour)) return { go: false, reason: '静默时段' };
      if (p.burstMax > 0 && times.filter((t) => now - t < 120_000).length >= p.burstMax) {
        return { go: false, reason: `两分钟内最多接 ${p.burstMax} 次` };
      }
      if (p.maxPerHour > 0 && times.length >= p.maxPerHour) {
        return { go: false, reason: `每小时最多接 ${p.maxPerHour} 次` };
      }
    }

    const adopt = (reason, force = false) => {
      times.push(now);
      return { go: true, force, reason };
    };

    if (shortAsk) return adopt('被追问（在吗 / 人呢）', true);
    /** 纯图片 / 语音没有正文，相关度打分会误判成 0 —— 直接放行 */
    if (atts.length && !text) return adopt('有附件，交给模型看');

    /** A3：她刚说过话的 3 分钟内算「在聊」，跳过相关度门接着聊 */
    if (p.mode === 'engaged' && state.lastReplyAt && now - state.lastReplyAt < 3 * 60_000) {
      if (state.engagedAt !== state.lastReplyAt) {
        state.engagedAt = state.lastReplyAt;
        state.engagedCount = 0;
      }
      state.engagedCount = (state.engagedCount || 0) + 1;
      if (state.engagedCount > p.engagedMaxTurns) {
        return { go: false, reason: `已经连着接了 ${p.engagedMaxTurns} 次没人接，先停一下` };
      }
      return adopt(`连聊中（第 ${state.engagedCount} 次）`);
    }

    /** A2：免费相关度门。关键词 + 最近消息窗口，不查跨进程记忆 */
    if (p.mode === 'relevance' || p.mode === 'engaged') {
      const win = (state.topicWindow ??= []);
      const rel = topicRelevance(text, win);
      win.push(text);
      if (win.length > 8) win.shift();
      if (rel < RELEVANCE_MIN) {
        return { go: false, reason: `相关度 ${rel.toFixed(2)} 太低，省一次模型` };
      }
      return adopt(`相关度 ${rel.toFixed(2)}，交给模型判断`);
    }

    /** 只开了刹车、模式仍是 ai：也要计数，否则小时/突发额度永远吃不满 */
    return adopt('交给模型判断');
  }

  return { go: true, force: false, reason: '交给模型判断' };
}

/**
 * 解析一个按钮标记的内容：`显示文字 | 点了之后发的话`
 *
 * 竖线用半角或全角都行——模型两种都会写。
 * 点了之后发的话为空时，退回用显示文字（至少别是个死按钮）。
 *
 * @param {string} value
 * @returns {{label:string, data:string}|null}
 */
export function parseButton(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parts = raw.split(/\s*[|｜]\s*/);
  const label = String(parts[0] ?? '').trim().slice(0, 12);
  const data = String(parts[1] ?? label).trim().slice(0, 100);
  if (!label) return null;
  return { label, data };
}

/**
 * 把正文里的字面 `<skip>` 标记摘掉。
 *
 * 标记是插件和模型之间的内部约定，**任何情况下都不该出现在群消息里**。
 * `isSkip` 判为「想答」时正文还要照发，那就得先把标记摘干净。
 */
export function stripSkip(text) {
  return String(text ?? '').split(SKIP_MARK).join('').trim();
}

/**
 * 摘掉 `<<retract>>`（「把上一条收回来」的标记）。
 *
 * 返回摘干净的正文和「到底要不要撤」，调用方两件事都要用：
 * 正文发出去、上一条撤回。摘除必须在拼正文**之前**做——
 * 以前是发完再 `body = body.replace(...)`，而 body 是 const，
 * 模型一输出这个标记就抛 TypeError，整条回复变成报错。
 *
 * @param {string} text
 * @returns {{ text: string, want: boolean }}
 */
export function takeRetract(text) {
  const raw = String(text ?? '');
  const want = /<<retract>>/i.test(raw);
  return { text: want ? raw.replace(/<<retract>>/gi, '').trim() : raw.trim(), want };
}

/**
 * 从模型输出里剥掉 `<skip>` 标记。
 *
 * 只有「整条基本就是 <skip>」才算不接——模型有时会写
 * 「<skip> 不过这个问题我可以答」这种，那说明它其实想答。
 */
export function isSkip(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  // 去掉标记后如果剩不下多少内容，就是真的不想接
  return stripSkip(t).length < 4;
}

/**
 * 解析模型输出里的「动作标记」。
 *
 * 没有指令之后，用户说「记住我住在杭州」也得能用——靠模型自己输出标记，
 * 插件解析执行，然后把标记从回复里摘掉。这是零依赖的轻量工具调用。
 *
 * 支持：
 *   <<remember: 内容>>   记一件事
 *   <<forget: 关键词>>   忘掉一件事
 *   <<persona: 内容>>    改这个会话的人设
 *   <<clear>>            清空这个会话的上下文
 *   <<image: 地址或路径>>       就地插图（图文同条，按标记位置排版）
 *   <<image-alone: 地址或路径>> 单独发一条图片消息（文字与图各占一条）
 *   <<voice: 地址或路径>> 发一条语音
 *   <<close: 收在哪 | 下次怎么接>> 给这段对话收个尾（这里只摘，执行在 DSH 宿主）
 *   <<silence: 2h>>      自己安静一阵子（30m / 2h / 1d，不写单位按分钟）
 *
 * **两种发图方式，语义不同，别混**：
 *   · `<<image: 路径>>` 留在正文原位 → 这里把它换成 `![](路径)`，由框架
 *     `msg.replyAuto()` 按位置排版，图片和文字在**同一条**消息里；
 *   · `<<image-alone: 路径>>` → 抽成 image 动作，正文先发、图片**单独一条**紧跟。
 *
 * 为什么模型侧不用标准 `![alt](路径)`：那种语法太常见，模型讲解「怎么发图」
 * 时会自然写出来，然后被当真指令执行（实测）。标记是内部协议，讲解时
 * 不会被自然写出；代码块里的标记也不执行。
 *
 * @param {string} text
 * @returns {{ text: string, actions: Array<{type:string, value?:string}> }}
 */
export function parseActions(text) {
  const actions = [];
  let out = String(text ?? '');

  /**
   * 代码块 / 行内代码里的标记**不执行**。
   *
   * 不做的后果（2026-11-07 子智能体实测）：模型讲解「怎么发图」时会把示例
   * 原样写出来，示例就被当成真指令——图片被真的发出去，或正文里那半句
   * 被替换成「读不到」提示，用户看到的是病句。
   *
   * 两条保守规则，宁可少屏蔽也不要误吞正文：围栏必须有闭合才认，
   * 行内代码必须同一行内成对。
   */
  const take = (re, type, hasValue = true) => {
    const ranges = codeRanges(out);
    /**
     * 回调参数**不能按「一定有捕获组」取**：`replace` 的实参形状是
     * `(匹配, 组1…组n, 偏移, 原串)`。
     * `<<clear>>` 那条正则没有捕获组，写成 `(m, v, offset)` 会把「偏移」
     * 收进 `v`、把「原串」收进 `offset`，`inCode()` 拿到字符串恒假 ——
     * 模型在代码块里举例 `<<clear>>` 就会真的把会话上下文清掉（实测）。
     * 所以按位置从尾部取：倒数第二个永远是偏移。
     */
    out = out.replace(re, (...args) => {
      const offset = args[args.length - 2];
      if (typeof offset === 'number' && inCode(offset, ranges)) return args[0];
      actions.push(hasValue ? { type, value: String(args[1]).trim() } : { type });
      return '';
    });
  };

  // remember-here：只记在这个群（群内梗、绰号），不跨群
  take(/<<remember-here[:：]\s*([\s\S]*?)>>/gi, 'rememberHere');
  take(/<<remember[:：]\s*([\s\S]*?)>>/gi, 'remember');
  take(/<<forget[:：]\s*([\s\S]*?)>>/gi, 'forget');
  // replace：语义改口（旧说法 | 新说法）。执行归宿主，这里只负责摘干净
  take(/<<replace[:：]\s*([\s\S]*?)>>/gi, 'replace');
  take(/<<persona[:：]\s*([\s\S]*?)>>/gi, 'persona');
  take(/<<clear>>/gi, 'clear', false);
  /**
   * `<<image-alone: 路径>>` = **单独发一条图**：抽成动作，正文发完由
   * `sendMedia` 另发一条。
   *
   * 要「图文同条」写 `<<image: 路径>>` —— 那个**不能**在这里抽：它的位置
   * 就是图要出现的位置，抽掉位置信息图只能被堆到末尾。它在最后一步
   * 被转成框架认的 `![](路径)`（见 `convertInlineImages`）。
   *
   * **值不像路径就原样留着**：模型讲解写法时会写 `<<image-alone: 图片路径>>`
   * 这种占位词，抽走的话正文就少一截（实测会变成「单独发一条图——写 ，话照常…」）。
   */
  {
    const ranges = codeRanges(out);
    out = out.replace(/<<image-alone[:：]\s*([^<>]*?)>>/gi, (m, v, offset) => {
      if (inCode(offset, ranges)) return m;
      const p = normalizeSource(String(v ?? '').trim());
      if (!looksLikeSource(p)) return m;
      actions.push({ type: 'image', value: p });
      return '';
    });
  }
  take(/<<voice[:：]\s*([\s\S]*?)>>/gi, 'voice');
  /**
   * `<<file: 路径>>`：模型**不该**写这个（发文件要走 `qq_send_file` 工具），
   * 它和图片标记是同一类「名字 + 路径」的形状，手滑写出来很正常。
   *
   * **只摘不执行**：真正的路径校验和发送都在 dsh-roost 那边（只有它知道
   * 谁能发、能发什么、文件是否存在）。这里认识它的唯一目的是——
   * 别让 `<<file: C:\Users\...>>` 这串原文漏到群里。
   */
  take(/<<file[:：]\s*([\s\S]*?)>>/gi, 'file');
  // 可点击按钮
  take(/<<button[:：]\s*([\s\S]*?)>>/gi, 'button');
  // 语音：要念出来的话（插件转成 silk 再发）
  take(/<<say[:：]\s*([\s\S]*?)>>/gi, 'say');
  /**
   * 对话收尾：`<<close: 收在哪 | 下次怎么接>>`。
   *
   * 这里**只摘不执行**——收尾状态归 DSH 宿主（`dsh-roost/src/closing.js`），
   * 那边才有人读它（下一轮提示词、主动搭话的刹车）。直连模式没有这两样，
   * 收尾本来也无处生效，摘干净就够了，别让标记漏到用户眼前。
   */
  take(/<<close[:：]\s*([\s\S]*?)>>/gi, 'close');
  /**
   * 情绪：`<<mood: valence=-0.3, reason=被凶了>>`。
   *
   * ai-chat **不执行**它——情绪归 DSH 宿主（`dsh-roost/src/mood.js`）。
   * 但必须**认识**它：直连模式没有宿主，不认识就等于标记原样发到群里；
   * 而 `qq_send` 的工具参数里模型是真会写这个标记的（宿主那条路拦得住，
   * 参数回传给 ai-chat 的 `parts` 就未必了）。
   */
  take(/<<mood[:：]\s*([\s\S]*?)>>/gi, 'mood');

  /**
   * 静默：`<<silence:2h>>`。
   *
   * 她可以自己决定安静一阵子（吵累了、话题不对、想让人自己待会儿）。
   * 这是**唯一一个由模型直接改运行状态的标记**——别的标记改的都是记忆或人设，
   * 这个会真的让机器人闭嘴，所以时长必须带上，而且要能自动到期。
   *
   * 不写时长（`<<silence>>`）按兜底正则当未知标记摘掉，不生效——
   * 无期限的静默等于「再也不说话」，那是运维该做的事，不该由模型顺手干。
   */
  take(/<<silence[:：]\s*([\s\S]*?)>>/gi, 'silence');

  /**
   * 兜底：任何剩下的 `<<名字>>` / `<<名字: 值>>` 一律当标记摘掉。
   *
   * 为什么需要这一层——标记协议是**两个仓库各自实现**的（这边一套正则，
   * dsh-roost 的 `applyMemoryMarkers` 另一套）。哪一边加了新标记、另一边没跟上，
   * `<<xxx:...>>` 就会漏进群。`mood` 已经这么漏过一次了。
   * 只匹配「字母开头 + 可选冒号值」的形状，普通文本里的尖括号不会误伤。
   *
   * 两个例外：
   *   · 代码块里的标记不动——那是模型在举例；
   *   · `<<image: 路径>>` 不摘——它是「就地插图」，下一步要转成 `![](路径)`。
   */
  {
    const ranges = codeRanges(out);
    out = out.replace(/<<[a-z][a-z-]{0,20}(?:[:：][^<>]{0,2000})?>>/gi, (m, offset) => {
      if (inCode(offset, ranges)) return m;
      if (/^<<\s*image(?:-alone)?\s*[:：]/i.test(m)) return m;
      return '';
    });
  }

  /**
   * 最后一步：把「就地插图」标记换成框架认的 markdown 图片。
   *
   * **这一层是模型协议与框架能力的分界线**：模型只见 `<<image: 路径>>`，
   * 框架只见 `![](路径)`。换掉 `![]()` 当模型语法的原因是它太常见——模型
   * 讲解发图时会自然写出，然后被当真指令执行；标记是内部协议，讲解时
   * 不会被自然写出，路径里的括号 / 引号 / 空格也不会再和语法打架。
   */
  out = convertInlineImages(out, (p) => {
    actions.push({ type: 'image', value: p });
    return '';
  });

  // 摘掉标记后可能留下多余空行，收一下
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, actions };
}

/**
 * 找出「不该解析」的代码区间：``` 围栏与行内 `…`。
 *
 * @param {string} text
 * @returns {Array<[number, number]>}
 */
export function codeRanges(text) {
  const s = String(text ?? '');
  const ranges = [];
  const fence = /^[ \t]*(`{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;
  for (const m of s.matchAll(fence)) ranges.push([m.index, m.index + m[0].length]);
  const inline = /`[^`\n]+`/g;
  for (const m of s.matchAll(inline)) {
    const at = m.index ?? 0;
    if (ranges.some(([a, b]) => at >= a && at < b)) continue;
    ranges.push([at, at + m[0].length]);
  }
  return ranges;
}

const inCode = (at, ranges) => ranges.some(([a, b]) => at >= a && at < b);

/**
 * 这个值像不像「真能拿去的图/语音地址」。
 *
 * 模型讲解写法时会写出 `<<image: 图片路径>>` 这种占位词，它不像路径。
 * 判据只认形状（协议头 / 盘符 / 分隔符 / 图片扩展名），不做文件存在性检查——
 * 存在性归框架，这里只负责「这是指令还是举例」。
 */
const SOURCE_PREFIX = /^(?:[a-z][a-z0-9+.-]*:\/\/|\\\\|\/|[a-z]:[\\/]|\.{1,2}[\\/])/i;
const IMAGE_EXT_TAIL = /\.(png|jpe?g|gif|webp|bmp)(?:[?#].*)?$/i;
export function looksLikeSource(p) {
  const s = String(p ?? '').trim();
  if (!s) return false;
  return SOURCE_PREFIX.test(s) || IMAGE_EXT_TAIL.test(s);
}

/**
 * 把 `file:///C:/…` 还原成本地路径。
 *
 * 不做的后果是**静默失败**：框架把带 scheme 的一律当远程引用，`file:///…`
 * 会原样进 markdown，QQ 拉不到、也不报错——用户看到一条没有图的消息，
 * 日志里干干净净。模型偶尔会这么写（尤其被问「路径怎么写」之后）。
 *
 * 只在明确是 `file://` 时动，其它协议（http/https/qqbot-media）一概不碰；
 * 百分号编码解不开就退回原串，交给后面的存在性检查去降级。
 *
 * @param {string} p
 * @returns {string}
 */
export function normalizeSource(p) {
  const s = String(p ?? '').trim();
  const m = /^file:\/\/(?:\/)?(.+)$/i.exec(s);
  if (!m) return s;
  const raw = m[1];
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * 就地插图标记 → 框架认的 `![](路径)`；代码块里的原样保留。
 *
 * `onUnsupported` 处理**表达式装不下的路径**：框架的图片正则用
 * `\(([^)]*)\)`，路径里带右括号（Windows 下载目录的 `截图(1).png`）会被
 * 截断成 `截图(1`，然后报「读不到」。这种路径退回「单独发一条图」，
 * 至少图能发出去，不会静默消失。回调返回替换文本（通常是空串）。
 *
 * @param {string} text
 * @param {(path:string)=>string} [onUnsupported]
 */
export function convertInlineImages(text, onUnsupported = null) {
  const s = String(text ?? '');
  const ranges = codeRanges(s);
  return s.replace(/<<\s*image\s*[:：]\s*([^<>]*?)>>/gi, (m, src, offset) => {
    if (inCode(offset, ranges)) return m;
    const p = normalizeSource(String(src ?? '').trim());
    if (!p) return '';
    if (!looksLikeSource(p)) return m; // 占位词（讲解写法）：留着，别当指令
    if (p.includes(')') && typeof onUnsupported === 'function') return String(onUnsupported(p) ?? '');
    return `![](${p})`;
  });
}

/* ------------------------------------------------------------------ */
/* 通用图文出口的接入辅助（框架 msg.replyAuto 的首个消费者，不是能力边界） */
/* ------------------------------------------------------------------ */

/**
 * 正文里有没有需要框架排版的图（有就交给 `msg.replyAuto()`）。
 *
 * 判断的是**转换之后**的 `![](路径)` —— `parseActions()` 已经把模型写的
 * `<<image: 路径>>` 换成了它，所以后面的逻辑不用再认识标记。
 */
const INLINE_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/;
export function hasInlineImage(text) {
  return INLINE_IMAGE_RE.test(String(text ?? ''));
}

/**
 * 把正文里的图片节点**抽出来**变成 image 动作，正文里只留干净文字。
 *
 * 用得上的是**没有 `msg` 对象**的通道（宿主主动搭话 / `/send`）：
 * 那边根本发不了图，抽掉只为不泄漏本地路径。正常回复一律走
 * `msg.replyAuto()`，它现在支持 keyboard，带按钮也不用再抽图。
 *
 * 输入是 `parseActions()` 转换后的 `![](路径)`（模型标记已经换成它了）。
 * 这里产出的是**内部动作**，只在插件内部流转，不是任何对外语法。
 */
export function extractInlineImages(text) {
  const images = [];
  const out = String(text ?? '').replace(/!\[[^\]]*\]\(([^)]*)\)/g, (_m, src) => {
    const u = String(src ?? '').trim();
    if (u) images.push({ type: 'image', value: u });
    return '';
  });
  return { text: out, images };
}

/**
 * 把 `30m` / `2h` / `1d` / `45` 解析成毫秒。认不出来返回 0。
 *
 * 默认单位是**分钟**：`<<silence:30>>` 比 `<<silence:30m>>` 更可能是人想写的。
 *
 * 上限 30 天。模型偶尔会写出 `<<silence:9999h>>` 这种，
 * 而没有上限的话那等于永久静默——恢复只能靠面板，用户会以为机器人坏了。
 *
 * @param {string} v
 * @returns {number} 毫秒
 */
export function parseDuration(v) {
  const m = String(v ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i);
  if (!m) return 0;
  const mul = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] || 'm').toLowerCase()];
  const ms = Math.round(Number(m[1]) * mul);
  return Math.min(ms, 30 * 86_400_000);
}


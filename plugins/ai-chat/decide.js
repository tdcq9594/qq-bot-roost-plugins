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
  if (said) return said;
  return (msg?.attachments ?? [])
    .filter((a) => a?.type === 'voice' && a.asrText)
    .map((a) => String(a.asrText).trim())
    .filter(Boolean)
    .join(' ');
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

  /**
   * 群聊里明确在叫我的：@ 了、或者回复了我的消息。
   * 这两种情况再让模型判断「要不要接」就太蠢了。
   */
  if (msg.mentioned || msg.addressed) return { go: true, force: true, reason: '被 @ 或回复' };

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
   * `decide: 'mention'` 是「只在被叫到时说话」模式。
   * 适合不希望机器人插话的群——省 token，也省心。
   */
  if (c.decide === 'mention') return { go: false, reason: '当前是「只在 @ 时回复」模式' };

  // 冷却：刚回过就别急着再回，否则一个人能跟它刷屏
  const now = Date.now();
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
 *   <<image: 地址或路径>> 发一张图（表情包、生成的图都走这条）
 *   <<voice: 地址或路径>> 发一条语音
 *   <<close: 收在哪 | 下次怎么接>> 给这段对话收个尾（这里只摘，执行在 DSH 宿主）
 *
 * @param {string} text
 * @returns {{ text: string, actions: Array<{type:string, value?:string}> }}
 */
export function parseActions(text) {
  const actions = [];
  let out = String(text ?? '');

  const take = (re, type, hasValue = true) => {
    out = out.replace(re, (_, v) => {
      actions.push(hasValue ? { type, value: String(v).trim() } : { type });
      return '';
    });
  };

  // remember-here：只记在这个群（群内梗、绰号），不跨群
  take(/<<remember-here:\s*([\s\S]*?)>>/gi, 'rememberHere');
  take(/<<remember:\s*([\s\S]*?)>>/gi, 'remember');
  take(/<<forget:\s*([\s\S]*?)>>/gi, 'forget');
  take(/<<persona:\s*([\s\S]*?)>>/gi, 'persona');
  take(/<<clear>>/gi, 'clear', false);
  // 富媒体：图片（表情包/生图都走这条）和语音
  take(/<<image:\s*([\s\S]*?)>>/gi, 'image');
  take(/<<voice:\s*([\s\S]*?)>>/gi, 'voice');
  // 可点击按钮
  take(/<<button:\s*([\s\S]*?)>>/gi, 'button');
  // 语音：要念出来的话（插件转成 silk 再发）
  take(/<<say:\s*([\s\S]*?)>>/gi, 'say');
  /**
   * 对话收尾：`<<close: 收在哪 | 下次怎么接>>`。
   *
   * 这里**只摘不执行**——收尾状态归 DSH 宿主（`dsh-roost/src/closing.js`），
   * 那边才有人读它（下一轮提示词、主动搭话的刹车）。直连模式没有这两样，
   * 收尾本来也无处生效，摘干净就够了，别让标记漏到用户眼前。
   */
  take(/<<close:\s*([\s\S]*?)>>/gi, 'close');
  /**
   * 情绪：`<<mood: valence=-0.3, reason=被凶了>>`。
   *
   * ai-chat **不执行**它——情绪归 DSH 宿主（`dsh-roost/src/mood.js`）。
   * 但必须**认识**它：直连模式没有宿主，不认识就等于标记原样发到群里；
   * 而 `qq_send` 的工具参数里模型是真会写这个标记的（宿主那条路拦得住，
   * 参数回传给 ai-chat 的 `parts` 就未必了）。
   */
  take(/<<mood:\s*([\s\S]*?)>>/gi, 'mood');

  /**
   * 兜底：任何剩下的 `<<名字>>` / `<<名字: 值>>` 一律当标记摘掉。
   *
   * 为什么需要这一层——标记协议是**两个仓库各自实现**的（这边一套正则，
   * dsh-roost 的 `applyMemoryMarkers` 另一套）。哪一边加了新标记、另一边没跟上，
   * `<<xxx:...>>` 就会漏进群。`mood` 已经这么漏过一次了。
   * 只匹配「字母开头 + 可选冒号值」的形状，普通文本里的尖括号不会误伤。
   */
  out = out.replace(/<<[a-z][a-z-]{0,20}(?::[^<>]{0,2000})?>>/gi, '');

  // 摘掉标记后可能留下多余空行，收一下
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, actions };
}

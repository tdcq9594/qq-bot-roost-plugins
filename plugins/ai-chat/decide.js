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
  const text = String(msg.content ?? '').trim();
  if (!text) return { go: false, reason: '空消息' };
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
    return { go: false, reason: `冷却中（${c.cooldownSec} 秒）` };
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
 * 从模型输出里剥掉 `<skip>` 标记。
 *
 * 只有「整条基本就是 <skip>」才算不接——模型有时会写
 * 「<skip> 不过这个问题我可以答」这种，那说明它其实想答。
 */
export function isSkip(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  // 去掉标记后如果剩不下多少内容，就是真的不想接
  const rest = t.split(SKIP_MARK).join('').trim();
  return rest.length < 4;
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

  take(/<<remember:\s*([\s\S]*?)>>/gi, 'remember');
  take(/<<forget:\s*([\s\S]*?)>>/gi, 'forget');
  take(/<<persona:\s*([\s\S]*?)>>/gi, 'persona');
  take(/<<clear>>/gi, 'clear', false);
  // 富媒体：图片（表情包/生图都走这条）和语音
  take(/<<image:\s*([\s\S]*?)>>/gi, 'image');
  take(/<<voice:\s*([\s\S]*?)>>/gi, 'voice');

  // 摘掉标记后可能留下多余空行，收一下
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, actions };
}

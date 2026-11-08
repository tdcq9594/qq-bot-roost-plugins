/**
 * 接话策略 + 静默状态的**契约**（调研报告 §18.3 阶段 2 产物）。
 *
 * 这一层只定「字段叫什么、默认值是多少、坏值怎么归一化」，**不接进
 * `decide.js`、也不注册进 `index.js` 的 config schema**。理由：阶段 2 是配置
 * 骨架，功能在阶段 3 才实现；现在就把开关挂到面板上，用户点了一个什么
 * 也不会发生的开关，比没有这个开关更糟。
 *
 * 阶段 3 接线时做三件事：把 `POLICY_MODES` 填进 config schema 的 options、
 * 在 `decide.js` 用 `normalizeGroupPolicy(cfg)` 读策略、把 `isSilent()` 挂进
 * 规则门最前面。字段名和默认值在这里定死，接线时不用再拍一次脑袋。
 *
 * 为什么单独一个文件：ai-chat 在 Roost 框架进程，dsh-roost 在 DSH 进程，
 * 两边配置不共享。这两个仓的开关各归各，跨进程只走 `/r/*` 回包（阶段 0 ②
 * 契约：新增字段必须先握手，不能「加个字段等对方读」）。
 */

/**
 * 接话模式。**这一份就是 `index.js` config schema 里 `decide` 的 options**，
 * 不另起第二个下拉：两个「什么时候接话」的下拉会把人搞晕，而且现有的
 * `mention` / `window` 两种语义不能被新策略挤掉。
 *
 * 前三个是原有行为（默认 `ai`），后两个是调研报告 A2/A3 的 opt-in。
 * 框架的 `ctx.config` 是**扁平 map**，所以契约表里写的 `groupPolicy.mode`
 * 嵌套路径落不了地；模式继续用 `decide`，其余参数用 `policy*` 前缀的扁平键。
 */
export const POLICY_MODES = Object.freeze([
  { value: 'ai', label: 'AI 自己判断（读全量消息）' },
  { value: 'mention', label: '只有被 @ 时说话' },
  { value: 'window', label: '@ 之后一段时间内都接话' },
  { value: 'relevance', label: '省钱：先过一道免费的相关度门' },
  { value: 'engaged', label: '连聊：相关度门 + 她说过话后接着聊' },
]);

/** 相关度门阈值：低于这个分数就不花钱调模型（A2） */
export const RELEVANCE_MIN = 0.25;

export const GROUP_POLICY_DEFAULTS = Object.freeze({
  /** ai = 交给模型 `<skip>`，与现在完全一致 */
  mode: 'ai',
  /** 120 秒内最多主动接几次；0 = 不刹车 */
  burstMax: 0,
  /** 每小时最多接几次；0 = 不限 */
  maxPerHour: 0,
  /** 本地静默时段 [start, end)。相等 = 不设静默 */
  quietStartHour: 1,
  quietEndHour: 1,
  /** A5：≤12 字的「在吗 / 人呢」当作被追问，直接放行。默认关 */
  shortAskMustReply: false,
  /** engaged 态连续接话上限，防她自己跟自己聊 */
  engagedMaxTurns: 6,
});

/** 主人命令的状态位（E10）：阶段 3 预留读取、阶段 7 用 ctx.command() 写入 */
export const SILENT_STATE_KEY = 'aiChat.silent';

/**
 * 把框架的扁平 `ctx.config` 变成一份完整策略。
 * 面板只认扁平键，策略层用短名，两边在这里对接，别在 decide.js 里散着读。
 */
export function policyFromConfig(cfg = {}) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  return normalizeGroupPolicy({
    mode: c.decide,
    burstMax: c.policyBurstMax,
    maxPerHour: c.policyMaxPerHour,
    quietStartHour: c.policyQuietStartHour,
    quietEndHour: c.policyQuietEndHour,
    shortAskMustReply: c.policyShortAskMustReply,
    engagedMaxTurns: c.policyEngagedMaxTurns,
  });
}

/** 问句：最该回的一类，给分最高 */
const ASK_RE = /(吗|呢|呀|吧|么|？|\?|怎么|为什么|啥|谁|哪|几|能不能|可不可以|要不要|是不是|有没有|如何|求助)/;
/** 兴趣/话题词：命中说明这句有内容，不只是附和 */
const TOPIC_RE = /(游戏|电影|音乐|歌|代码|程序|猫|狗|吃|饭|玩|天气|工作|上班|学习|考试|书|旅行|旅游|照片|图片|视频|唱|想|觉得|喜欢|讨厌|bug|模型|机器人|服务器|插件|新闻|球|车|咖啡|奶茶|电脑|手机|价格|钱)/i;

function bigrams(s) {
  const t = String(s || '').replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}

/**
 * 免费的相关度打分（A2）：不看模型、不查跨进程记忆。
 *
 * 对方 aurabot 用「兴趣词 ×0.3 + **记忆命中** ×0.5」，但记忆检索在
 * dsh-roost 进程，ai-chat 拿不到（§14.2-2）。这里把那一维换成
 * **最近消息窗口的重合度**：她在聊的话题里出现过的词，说明这句接得上。
 * 纯字符串运算，零成本；分数只用来决定「要不要花钱调模型」，不进提示词。
 */
export function topicRelevance(text, windowTexts = []) {
  const t = String(text ?? '').trim();
  if (!t) return 0;
  let score = 0;
  if (ASK_RE.test(t)) score += 0.45;
  if (TOPIC_RE.test(t)) score += 0.3;
  if ([...t].length >= 20) score += 0.3;

  const bg = bigrams(t);
  let best = 0;
  for (const w of (Array.isArray(windowTexts) ? windowTexts : []).slice(-6)) {
    const bw = bigrams(w);
    if (!bw.size) continue;
    let hit = 0;
    for (const g of bg) if (bw.has(g)) hit += 1;
    best = Math.max(best, hit / Math.max(1, bg.size));
  }
  score += 0.5 * best;
  return Math.min(1, Math.round(score * 100) / 100);
}

/** A5：≤12 字的「在吗 / 人呢」算被追问。默认关，打开才生效 */
export function isShortAsk(text, on = false) {
  if (!on) return false;
  const t = String(text ?? '').trim();
  if (!t || [...t].length > 12) return false;
  return /(在吗|在不在|人呢|还在吗|喂|醒醒|出来|？？|\?)$/.test(t);
}

const intIn = (v, min, max, fallback) => {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || typeof v === 'boolean') return fallback;
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return n < min || n > max ? fallback : n;
};

/**
 * 把配置（可能手改过、可能是老配置、可能整个缺失）夹成一份完整策略。
 * 纯函数：不改输入，坏值一律回默认，绝不抛错——配置坏掉不该让机器人不回话。
 */
export function normalizeGroupPolicy(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const mode = POLICY_MODES.some((m) => m.value === src.mode) ? src.mode : GROUP_POLICY_DEFAULTS.mode;
  const quietStartHour = intIn(src.quietStartHour, 0, 23, GROUP_POLICY_DEFAULTS.quietStartHour);
  const quietEndHour = intIn(src.quietEndHour, 0, 23, GROUP_POLICY_DEFAULTS.quietEndHour);
  return {
    mode,
    burstMax: intIn(src.burstMax, 0, 30, GROUP_POLICY_DEFAULTS.burstMax),
    maxPerHour: intIn(src.maxPerHour, 0, 100, GROUP_POLICY_DEFAULTS.maxPerHour),
    quietStartHour,
    quietEndHour,
    shortAskMustReply: src.shortAskMustReply === true,
    engagedMaxTurns: intIn(src.engagedMaxTurns, 1, 20, GROUP_POLICY_DEFAULTS.engagedMaxTurns),
  };
}

/** 此刻是否在静默时段（本地小时，支持跨零点，如 23 → 8） */
export function inQuietHours(policy, hour = new Date().getHours()) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return false;
  const { quietStartHour: a, quietEndHour: b } = normalizeGroupPolicy(policy);
  if (a === b) return false;
  return a < b ? h >= a && h < b : h >= a || h < b;
}

/**
 * E10：主人 `/silent` 之后她要**知道自己没在说话**，否则会「以为在说话、
 * 其实被静默」，下一轮起就接不上。阶段 3 在规则门最前面读这个值。
 *
 * 只认显式 true；老配置 / 没状态 / 状态是字符串都当「没静默」。
 */
export function isSilent(state) {
  const v = state && typeof state === 'object' ? state[SILENT_STATE_KEY] : undefined;
  return v === true;
}

/** 给状态对象打静默标记，返回新对象（不改传入的，方便单测与回滚） */
export function withSilent(state, on) {
  return { ...(state && typeof state === 'object' ? state : {}), [SILENT_STATE_KEY]: on === true };
}

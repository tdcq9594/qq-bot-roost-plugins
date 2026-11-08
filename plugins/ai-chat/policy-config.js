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

/** 接话策略三态。`ai` 是现状，其余两个都是 opt-in，默认绝不改变线上行为 */
export const POLICY_MODES = Object.freeze([
  { value: 'ai', label: 'AI 自己判断（保持现状）' },
  { value: 'relevance', label: '省钱：先过一道免费的相关度门' },
  { value: 'engaged', label: '连聊：她说过话后接着聊一小会儿' },
]);

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

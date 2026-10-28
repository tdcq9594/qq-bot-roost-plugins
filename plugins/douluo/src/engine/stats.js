/**
 * 属性计算
 * ========
 *
 * 关键决定：属性**不是**逐级累加的，而是每次由「武魂基础值 × 等级系数 × 魂环系数」重算。
 *
 * 原版（回合制2）是 `生命 += 50 × 等级 × 系列生命 ÷ 10` 这种累加式，
 * 一旦改内容表里的武魂数值，老角色的属性就和新角色对不上，而且浮点截断会越滚越偏。
 * 重算式的好处：改数值、改公式，所有角色下一次读面板就自动对齐。
 */
import { mainAttr } from './formula.js';

/**
 * @param {{wuhun:object, level:number, ringCount:number, cfg:object, flat?:object}} p
 *        flat：装备/套装的**加法**加成（来自 engine/modifiers.js）
 */
export function computeAttrs({ wuhun, level, ringCount, cfg, flat = null, mult = 0 }) {
  const rate = Number(cfg.level_attr_rate ?? cfg.level_up_attr_rate ?? 0.18) || 0;
  const ringBonus = Number(cfg.ring_attr_bonus ?? 0.12) || 0;
  const lv = Math.max(1, Number(level) || 1);
  const rings = Math.max(0, Number(ringCount) || 0);

  // 等级线性 + 魂环连乘（魂环是台阶，等级是斜坡）
  const k = (1 + rate * (lv - 1)) * Math.pow(1 + ringBonus, rings);

  const scale = (v) => Math.max(1, Math.round(Number(v || 0) * k));

  const out = {
    hp_max: scale(wuhun.hp),
    mp_max: scale(wuhun.mp),
    atk: scale(wuhun.atk),
    def: scale(wuhun.def),
    spd: scale(wuhun.spd),
    str: scale(wuhun.str),
    intel: scale(wuhun.intel),
    // 百分比类不跟着等级放大，只吃魂环加成（否则后期闪避必满）
    dodge: Math.min(75, Math.round(Number(wuhun.dodge ?? 0) * Math.pow(1 + ringBonus, rings))),
    crit: Math.min(75, Math.round(Number(wuhun.crit ?? 0) * Math.pow(1 + ringBonus, rings))),
    crit_dmg: Math.round(Number(wuhun.crit_dmg ?? 150)),
  };

  /**
   * 装备加成走**加法**，不参与上面的连乘。
   *
   * 这是方案 §13 定的：原版所有加成都是乘法，魂环 × 等级 × 装备三层乘下来
   * 后期直接指数爆炸。装备给固定值，魂环给倍率，等级给斜率，三层各管一段。
   */
  if (flat) {
    out.hp_max += Number(flat.hp ?? 0);
    out.mp_max += Number(flat.mp ?? 0);
    out.atk += Number(flat.atk ?? 0);
    out.def += Number(flat.def ?? 0);
    out.spd += Number(flat.spd ?? 0);
    out.str += Number(flat.str ?? 0);
    out.intel += Number(flat.intel ?? 0);
    out.dodge = Math.min(75, out.dodge + Number(flat.dodge ?? 0));
    out.crit = Math.min(75, out.crit + Number(flat.crit ?? 0));
    out.crit_dmg += Number(flat.crit_dmg ?? 0);
  }

  /**
   * 乘区：宗门等级这类「全局增益」走这里，和加法分开。
   *
   * 为什么不并进 flat：flat 是固定值（装备/伙伴），乘区是比例（宗门/领域）。
   * 混在一起的话，后期一件装备的固定值会被宗门比例放大，
   * 数值会随「加了多少内容」漂移。分开算，比例只放大「基础+固定」这一整块。
   *
   * 闪避/暴击**不吃乘区**（否则后期必满），只放大主属性。
   */
  if (mult) {
    const k = 1 + Math.max(0, Math.min(2, Number(mult)));
    for (const a of ['hp_max', 'mp_max', 'atk', 'def', 'spd', 'str', 'intel']) {
      out[a] = Math.round(out[a] * k);
    }
    out.crit_dmg = Math.round(out.crit_dmg * (1 + Math.min(0.5, Number(mult))));
  }

  return out;
}

/** 战力构成明细，面板和游戏内都能用 */
export function powerBreakdown(player) {
  const parts = [
    ['攻击', Number(player.atk ?? 0) * 2],
    ['防御', Number(player.def ?? 0) * 1.5],
    ['生命', Number(player.hp_max ?? 0) * 0.1],
    ['魂力', Number(player.mp_max ?? 0) * 0.05],
    ['速度', Number(player.spd ?? 0) * 1],
    ['闪避', Number(player.dodge ?? 0) * 20],
    ['暴击', Number(player.crit ?? 0) * 30],
    ['魂环', Number(player.ring_years_sum ?? 0) / 100],
  ].map(([k, v]) => [k, Math.round(v)]);
  return { parts, total: parts.reduce((s, [, v]) => s + v, 0) };
}

export { mainAttr };

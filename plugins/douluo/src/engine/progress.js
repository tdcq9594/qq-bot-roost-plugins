/**
 * 等级与经验
 * ==========
 *
 * 沿用「魂环墙」：每 ring_level_step 个魂环解锁 step 级上限。
 *   0 环 → 10 级封顶，1 环 → 20 级，…… 9 环 → 99 级
 *
 * 这是斗罗 IP 的节奏器，也是玩家去打魂兽的动机。但**必须配合保底**（见 §13.5），
 * 否则卡在 10 级又掉不出魂环的玩家会直接走。
 */

/** 从 level 升到 level+1 需要多少经验 */
export function expNeed(level, cfg) {
  const base = Number(cfg.exp_base ?? 100) || 100;
  const pow = Number(cfg.exp_pow ?? 1.6) || 1.6;
  return Math.max(1, Math.round(base * Math.pow(Math.max(1, level), pow)));
}

/** 当前魂环数下的等级上限 */
export function levelCap(ringCount, cfg) {
  const step = Number(cfg.ring_level_step ?? 10) || 10;
  return Math.max(1, (Math.max(0, Number(ringCount) || 0) + 1) * step);
}

/**
 * 加经验，返回新状态。**不写库**，由调用方决定怎么落。
 *
 * @param {{level:number, exp:number}} p
 * @param {number} amount
 * @param {number} ringCount
 * @param {object} cfg
 * @returns {{level:number, exp:number, leveled:number, capped:boolean, need:number, cap:number}}
 */
export function applyExp(p, amount, ringCount, cfg) {
  const cap = levelCap(ringCount, cfg);
  let level = Math.max(1, Number(p.level) || 1);
  let exp = Math.max(0, Number(p.exp) || 0) + Math.max(0, Math.round(Number(amount) || 0));
  let leveled = 0;
  let capped = false;

  while (level < cap) {
    const need = expNeed(level, cfg);
    if (exp < need) break;
    exp -= need;
    level += 1;
    leveled += 1;
  }

  // 到顶了就把经验压在「差一点升级」，避免攒一大坨以后一次爆升
  if (level >= cap) {
    const need = expNeed(level, cfg);
    if (exp >= need) {
      exp = need - 1;
      capped = true;
    }
  }

  return { level, exp, leveled, capped, need: expNeed(level, cfg), cap };
}

/** 经验百分比，给面板显示用 */
export function expPercent(p, cfg) {
  const need = expNeed(p.level, cfg);
  return Math.min(100, Math.round((Number(p.exp ?? 0) / need) * 100));
}

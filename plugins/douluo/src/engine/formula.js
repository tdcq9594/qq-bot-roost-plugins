/**
 * 数值公式（纯函数，不碰 IO）
 * ========================
 *
 * 设计见方案 §13：所有平衡都锚在「一场仗打几回合」上。
 * 所以怪物血量不是手填的，而是由「玩家标准输出 × 目标回合数」反推。
 *
 * 这里刻意写成纯函数 + 系数全部从 content.db 的 cfg 表读：
 *   - 可以单元测试（同输入必同输出）
 *   - 面板改系数即时生效，不用改代码
 *   - 以后接模拟器跑 1 万场看曲线，直接调这些函数
 */

/** 主属性：力量与智力取高者（不同武魂吃不同属性） */
export function mainAttr(p) {
  return Math.max(Number(p.str ?? 0), Number(p.intel ?? 0));
}

/** 战力：方案 §13.3。要求单调——任何属性涨，战力必涨 */
export function power(p, cfg) {
  const ringYears = Number(p.ring_years_sum ?? 0);
  const equipScore = Number(p.equip_score ?? 0);
  return Math.round(
    Number(p.atk ?? 0) * 2 +
      Number(p.def ?? 0) * 1.5 +
      Number(p.hp_max ?? 0) * 0.1 +
      Number(p.mp_max ?? 0) * 0.05 +
      Number(p.spd ?? 0) * 1 +
      Number(p.dodge ?? 0) * 20 +
      Number(p.crit ?? 0) * 30 +
      ringYears / 100 +
      equipScore,
  );
}

/**
 * 期望单次伤害（不含防御减伤），用于反推怪物血量。
 * 已经把暴击的数学期望算进去了。
 */
export function expectedHit(p, cfg) {
  const div = Number(cfg.attr_to_damage_div ?? 1000) || 1000;
  const base = Number(p.atk ?? 0) * (1 + mainAttr(p) / div);
  const critRate = Math.min(100, Number(p.crit ?? 0)) / 100;
  const critMul = Math.max(1, Number(p.crit_dmg ?? 150) / 100);
  return base * (1 + critRate * (critMul - 1));
}

/** 防御减伤：与方案 §13.3 一致 */
export function mitigate(dmg, def, attackerLevel, cfg) {
  const k = Number(cfg.defense_level_factor ?? 50) || 50;
  const d = Math.max(0, Number(def ?? 0));
  const denom = d + k * Math.max(1, Number(attackerLevel ?? 1));
  if (denom <= 0) return dmg;
  return dmg * (1 - d / denom);
}

/**
 * 单次伤害（含技能倍率、暴击、减伤）。
 * @returns {{value:number, crit:boolean}}
 */
export function damageOnce({ p, target, powerPercent = 100, cfg, rng = Math.random }) {
  const div = Number(cfg.attr_to_damage_div ?? 1000) || 1000;
  const powerMax = Number(cfg.skill_power_max ?? 400) || 400;
  const critBase = Number(cfg.crit_base_mult ?? 1.5) || 1.5;
  const critDiv = Number(cfg.crit_dmg_div ?? 200) || 200;

  const base = Number(p.atk ?? 0) * (1 + mainAttr(p) / div);
  const withPower = base * (Math.min(Number(powerPercent ?? 100), powerMax) / 100);

  const isCrit = rng() * 100 < Math.min(100, Number(p.crit ?? 0));
  const critMul = isCrit ? critBase + Number(p.crit_dmg ?? 150) / critDiv : 1;

  const raw = withPower * critMul;
  const value = Math.max(1, Math.round(mitigate(raw, target?.def ?? 0, p.level ?? 1, cfg)));
  return { value, crit: isCrit };
}

/** 组队人数系数：人越多怪越厚 */
export function partyFactor(partySize = 1) {
  return 1 + 0.2 * (Math.max(1, partySize) - 1);
}

/**
 * 怪物血量 = 玩家标准输出 × 目标回合数 × 人数系数
 *
 * 注意这是**演示级**实现：正式版还要考虑技能循环、命中率、玩家防御带来的
 * 生存上限（打不过的怪不该靠血量硬堆）。骨架阶段先跑通链路。
 */
export function monsterHp({ monster, player, partySize = 1, cfg }) {
  const rounds = Math.max(1, Number(monster?.target_rounds ?? 4));
  return Math.max(1, Math.round(expectedHit(player, cfg) * rounds * partyFactor(partySize)));
}

/** 怪物防御：按玩家攻击的一定比例，避免减伤公式吃掉全部伤害 */
export function monsterDef({ monster, player }) {
  const bias = Number(monster?.def_bias ?? 1) || 1;
  return Math.max(0, Math.round(Number(player?.atk ?? 10) * 0.3 * bias));
}

/** 怪物攻击：同样按玩家攻击的比例，保证挨打是痛的但不至于秒 */
export function monsterAtk({ monster, player }) {
  const bias = Number(monster?.atk_bias ?? 1) || 1;
  return Math.max(1, Math.round(Number(player?.atk ?? 10) * 0.25 * bias));
}

/** 魂环年限 → 颜色名（分界值从 cfg 读，逗号分隔） */
export function ringColor(years, cfg) {
  const raw = String(cfg.ring_years_color ?? '100,1000,10000,100000,1000000,10000000');
  const cuts = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  const names = ['白', '黄', '紫', '黑', '红', '金', '彩'];
  let i = 0;
  while (i < cuts.length && years >= cuts[i]) i += 1;
  return names[Math.min(i, names.length - 1)];
}

/**
 * 魂兽年龄 → 等效等级。
 * 原式：(-36 + √(36² + 4·14·age)) / 14 × 2 / 4，来自回合制2 的 `战斗_取魂兽等级`。
 * 保留它是因为减伤公式需要「攻方等级」，而魂兽没有等级字段，只有年龄。
 */
export function monsterLevel(age) {
  const a = Math.max(0, Number(age) || 0);
  const inner = 36 * 36 + 4 * 14 * a;
  const v = (-36 + Math.sqrt(inner)) / 14 * 2 / 4;
  return Math.max(1, Math.round(v));
}

/** 魂环年限随机：age ~ age + age×spread */
export function rollRingYears(age, cfg, rng = Math.random) {
  const a = Math.max(1, Number(age) || 1);
  const spread = Math.max(0, Number(cfg.ring_years_spread ?? 0.5));
  const hi = Math.max(a, Math.round(a * (1 + spread)));
  return a + Math.floor(rng() * (hi - a + 1));
}

/**
 * 状态效果（buff / debuff）
 * ========================
 *
 * 之前技能只有「威力 × 倍率」，打起来全是纯伤害，没有战术空间。
 * 这一层补上原著和常规 RPG 都有的东西：中毒、灼烧、流血、减速、
 * 眩晕、沉默、虚弱、破甲、回复、护盾、会心、疾影、冰冻、即死。
 *
 * 设计原则：
 *   1. **纯函数**。所有状态计算不碰数据库，`resolveRound` 才能在测试里
 *      被反复模拟几十万次（数值体检就是这么干的）。
 *   2. **数据驱动**。状态长什么样全在 `status_def` 表里，加一种状态只加一行。
 *   3. **层数上限由表控制**。`max_stack` 决定同一种状态能叠几层，
 *      避免「叠 20 层中毒直接秒杀」这种失控。
 */
const now = () => Date.now();

/** 把数据库里的 JSON 字符串解析成状态数组 */
export function parseStatuses(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function stringifyStatuses(list) {
  return JSON.stringify((list ?? []).filter((s) => s && s.key && Number(s.left) > 0));
}

/**
 * 施加状态。
 * 同一种状态按 `max_stack` 叠层，取「剩余回合更长」的那个作为持续时间。
 */
export function addStatus(list, key, def, { duration = 0, stacks = 1 } = {}) {
  const out = [...(list ?? [])];
  const idx = out.findIndex((s) => s.key === key);
  const maxStack = Math.max(1, Number(def?.max_stack ?? 1));
  const dur = Math.max(1, Number(duration) || Number(def?.duration ?? 3));
  if (idx >= 0) {
    out[idx] = { ...out[idx], left: Math.max(Number(out[idx].left), dur), stack: Math.min(maxStack, Number(out[idx].stack ?? 1) + stacks) };
    return out;
  }
  out.push({ key, left: dur, stack: Math.min(maxStack, stacks) });
  return out;
}

/**
 * 回合开始结算：掉血/回血 + 剩余回合 -1 + 清掉过期的。
 *
 * @returns {{list:Array, damage:number, heal:number, events:Array}}
 */
export function tickStatuses(list, maxHp, defs = {}) {
  const events = [];
  let damage = 0;
  let heal = 0;
  const next = [];
  for (const s of list ?? []) {
    const def = defs[s.key];
    if (!def) continue;
    const pct = Number(def.tick_pct ?? 0);
    if (pct) {
      const amount = Math.max(1, Math.round((Math.abs(Number(maxHp)) * Math.abs(pct)) / 100)) * Math.max(1, Number(s.stack ?? 1));
      if (pct > 0) {
        damage += amount;
        events.push({ t: 'tick', key: s.key, name: def.name, value: amount, harmful: true });
      } else {
        heal += amount;
        events.push({ t: 'tick', key: s.key, name: def.name, value: amount, harmful: false });
      }
    }
    const left = Number(s.left) - 1;
    if (left > 0) next.push({ ...s, left });
    else events.push({ t: 'expire', key: s.key, name: def.name });
  }
  return { list: next, damage, heal, events };
}

/**
 * 汇总所有状态对属性的影响（百分比）。
 * 战斗里是**临时**属性，不写回玩家表——否则中毒结束还要复原，容易漏。
 */
export function aggregate(list, defs = {}) {
  const out = {
    atk: 0, def: 0, spd: 0, dodge: 0, crit: 0,
    // 原版「状态设置」的 16 个字段里有 6 个我们之前缺：
    // 力量 / 生命 / 魂力 / 暴击伤害 / 经验 / 金币
    str: 0, hp: 0, mp: 0, critDmg: 0, exp: 0, gold: 0,
    skip: false, blockSkill: false, instantKill: 0, shield: 0,
  };
  for (const s of list ?? []) {
    const def = defs[s.key];
    if (!def) continue;
    const st = Math.max(1, Number(s.stack ?? 1));
    out.atk += Number(def.atk_pct ?? 0) * st;
    out.def += Number(def.def_pct ?? 0) * st;
    out.spd += Number(def.spd_pct ?? 0) * st;
    out.dodge += Number(def.dodge_pct ?? 0) * st;
    out.crit += Number(def.crit_pct ?? 0) * st;
    out.str += Number(def.str_pct ?? 0) * st;
    out.hp += Number(def.hp_pct ?? 0) * st;
    out.mp += Number(def.mp_pct ?? 0) * st;
    out.critDmg += Number(def.crit_dmg_pct ?? 0) * st;
    out.exp += Number(def.exp_pct ?? 0) * st;
    out.gold += Number(def.gold_pct ?? 0) * st;
    if (Number(def.skip_turn) === 1) out.skip = true;
    if (Number(def.block_skill) === 1) out.blockSkill = true;
    if (Number(def.instant_kill) === 1) out.instantKill = Math.max(out.instantKill, Number(def.instant_kill_chance ?? 5));
  }
  // 百分比类不能叠成负数（否则防御变负会算成加伤）
  for (const k of ['atk', 'def', 'spd', 'str', 'hp', 'mp']) out[k] = Math.max(-80, out[k]);
  // 经验和金币是结算加成，砍到 -100% 就没意义了，只允许 [-80, +300]
  out.exp = Math.max(-80, Math.min(300, out.exp));
  out.gold = Math.max(-80, Math.min(300, out.gold));
  return out;
}

/** 按百分比修正一个属性值 */
export function applyPct(value, pct) {
  return Math.max(1, Math.round(Number(value) * (1 + Number(pct) / 100)));
}

/**
 * 从技能配置里挑出这次要附加的状态。
 * @param {{chance:number, duration:number, key:string}[]} candidates
 */
export function rollStatuses(candidates, rng = Math.random) {
  const out = [];
  for (const c of candidates ?? []) {
    if (rng() * 100 < Number(c.chance ?? 100)) out.push(c);
  }
  return out;
}

export { now };

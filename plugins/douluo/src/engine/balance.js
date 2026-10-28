/**
 * 数值基准与怪物生成
 * ==================
 *
 * ## 为什么需要这一层
 *
 * 早期版本（骨架）里，怪物血量是**按玩家当前输出反推**的：
 *
 *     hp = expectedHit(玩家) × target_rounds
 *
 * 看起来很聪明——"任何玩家打任何怪都是 4 回合"。但它有个致命副作用：
 * **玩家变强，怪也跟着变强**。升 10 级、拿 3 个魂环、穿一身装备之后，
 * 打同一只十年白虎还是 4 回合。玩家感觉不到成长，这是文游最伤的问题。
 *
 * 正确做法（这一层做的事）：
 *
 *     怪物属性由**怪物自己的年龄/品阶**决定
 *     = 按「该年龄对应的标准玩家」反推，而不是按"你"
 *
 * 于是：
 *   - Lv1 打 10 年魂兽 → 4 回合（目标）
 *   - Lv20 打 10 年魂兽 → 1~2 回合（爽）
 *   - Lv20 打 1000 年魂兽 → 4 回合（目标）
 * 成长感来自「同一只怪越打越快」和「能打更老的怪」，这才是 RPG 的手感。
 *
 * 副产品：怪物属性变成**纯内容函数**（age + tier + cfg），
 * 不依赖谁在打，所以能预计算、能模拟、能一次算出全服平衡表。
 */

/**
 * 该等级「应该有几个魂环」——魂环墙的逆函数。
 * 等级上限 = (环数+1)×step，反过来 level → 环数 = ceil(level/step)-1。
 */
export function expectedRings(level, cfg) {
  const step = Math.max(1, Number(cfg.ring_level_step ?? 10));
  const lv = Math.max(1, Number(level) || 1);
  return Math.max(0, Math.min(9, Math.ceil(lv / step) - 1));
}

/** 品阶系数：精英/BOSS 更肉、更疼 */
export function tierFactor(tier, cfg) {
  const t = String(tier ?? 'normal');
  if (t === 'elite') return Number(cfg.tier_elite_factor ?? 1.6);
  if (t === 'boss') return Number(cfg.tier_boss_factor ?? 2.5);
  return 1;
}

/**
 * 生成怪物属性。**只依赖内容表 + 系数，不依赖具体玩家。**
 *
 * 两条锚（这是平衡的核心，别随便改顺序）：
 *
 * 1. **血量锚在回合数上，并且要扣掉防御减伤**
 *       hp = 期望单次伤害 × 目标回合 × 减伤系数 × 品阶系数
 *    早期漏了「减伤系数」，目标 10 回合的怪实际打了 16 回合——
 *    因为怪有防御，每一下都被砍掉一部分。
 *
 * 2. **攻击力锚在「打完这场还剩多少血」上**
 *       atk = 消耗比例 × 标准玩家生命 / (实际回合数 × 玩家减伤系数)
 *    而不是「玩家攻击的 25%」那种拍脑袋比例。这样每一场标准战斗结束时
 *    玩家都剩固定比例的命：普通怪 45%、精英 35%、BOSS 20%。
 *    早期用固定比例，结果万年熊目标 18 回合、胜率 0%——玩家在打的过程中就死了。
 *
 * @param {{monster:object, cfg:object, refWuhun:object,
 *          computeAttrs:Function, expectedHit:Function, monsterLevel:Function, mitigate:Function}} p
 */
export function monsterStats({ monster, cfg, refWuhun, computeAttrs, expectedHit, monsterLevel, mitigate }) {
  /**
   * 标准等级要卡在玩家等级上限内（99）。
   *
   * 原著里百万年魂兽按年龄换算能到 266 级，但玩家的墙是 100 级——
   * 按 266 级玩家生成属性，等于全服没人打得过。
   * 年龄继续保留（决定魂环颜色和年限），只把「难度」压回可达范围。
   */
  const lv = Math.max(1, Math.min(99, Number(monsterLevel(Number(monster.age) || 0))));
  const rings = expectedRings(lv, cfg);
  const ref = computeAttrs({ wuhun: refWuhun, level: lv, ringCount: rings, cfg });
  const f = tierFactor(monster.tier, cfg);
  const tier = String(monster.tier ?? 'normal');

  const baseRounds = Math.max(1, Number(monster.target_rounds ?? 4));
  /**
   * `target_rounds` 就是**最终**回合数，品阶系数不再往上乘。
   *
   * 早期把品阶乘进回合数，BOSS 变成 18×2.5 = 45 回合——群里要发 45 条消息。
   * 品阶只决定「更肉还是更疼」（见下面的 survive_*），不决定打多久。
   */
  const expectedRounds = baseRounds;

  // ① 防御：按标准玩家攻击的比例，避免减伤公式吃掉全部伤害
  const def = Math.max(0, Math.round(Number(ref.atk) * 0.3 * Number(monster.def_bias ?? 1)));

  // ② 玩家打怪时的减伤系数（1 = 无减伤）。血量要除以它，回合数才准。
  const monsterMit = clamp(mitigate(1, def, lv, cfg), 0.15, 1);

  // ③ 血量：补上减伤
  const hp = Math.max(1, Math.round(expectedHit(ref, cfg) * expectedRounds * monsterMit));

  // ④ 攻击力：锚在「打完剩多少血」，按品阶给不同消耗
  const consume = Number(cfg[`survive_${tier}`] ?? 0.55);
  const playerMit = clamp(mitigate(1, Number(ref.def), lv, cfg), 0.15, 1);
  const atk = Math.max(
    1,
    Math.round((consume * Number(ref.hp_max)) / (expectedRounds * playerMit) * Number(monster.atk_bias ?? 1)),
  );

  return { level: lv, rings, hp, hpMax: hp, def, atk, tierFactor: f, baseRounds, expectedRounds, ref };
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return hi;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 单场模拟。返回打了几个回合、有没有赢、剩多少血。
 *
 * 复用 `resolveRound()`，所以模拟出来的数字和真实战斗**完全一致**——
 * 这点很重要：如果模拟器和线上用两套公式，测出来的平衡是假的。
 */
export function simulateFight({ player, monster, cfg, maxRounds = 60, rng = Math.random, resolveRound }) {
  const b = {
    monster_hp: monster.hp,
    monster_hp_max: monster.hp,
    monster_def: monster.def,
    monster_atk: monster.atk,
    monster_age: 0,
  };
  let hp = Number(player.hp_max ?? player.hp ?? 1);
  let mp = Number(player.mp_max ?? player.mp ?? 0);
  let round = 0;

  while (round < maxRounds && b.monster_hp > 0 && hp > 0) {
    round += 1;
    const r = resolveRound({ player: { ...player, hp, mp }, battle: b, action: { type: 'attack' }, cfg, rng });
    b.monster_hp = r.monsterHp;
    hp = r.playerHp;
    mp = r.playerMp;
    if (r.monsterDead) return { rounds: round, win: true, hpLeft: hp };
    if (r.playerDead) return { rounds: round, win: false, hpLeft: 0 };
  }
  // 打满回合还没死：算玩家赢（怪被磨死了），但标记 timeout
  return { rounds: round, win: b.monster_hp <= 0, hpLeft: hp, timeout: true };
}

/**
 * 多次采样，给分布而不是单次结果。
 * 单次模拟会被暴击/闪避的随机性骗到，看分布才靠谱。
 */
export function sampleFight({ player, monster, cfg, samples = 200, rng = Math.random, resolveRound }) {
  const rounds = [];
  let wins = 0;
  for (let i = 0; i < samples; i += 1) {
    const r = simulateFight({ player, monster, cfg, rng, resolveRound });
    rounds.push(r.rounds);
    if (r.win) wins += 1;
  }
  rounds.sort((a, b) => a - b);
  const at = (p) => rounds[Math.min(rounds.length - 1, Math.floor(rounds.length * p))] ?? 0;
  const avg = rounds.reduce((s, x) => s + x, 0) / Math.max(1, rounds.length);
  return {
    samples,
    winRate: Math.round((wins / Math.max(1, samples)) * 100),
    avgRounds: Math.round(avg * 10) / 10,
    p10: at(0.1),
    p50: at(0.5),
    p90: at(0.9),
  };
}

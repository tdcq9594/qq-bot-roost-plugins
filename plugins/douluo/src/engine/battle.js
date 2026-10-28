/**
 * 战斗回合结算（纯函数）
 * ====================
 *
 * 为什么单独一层：原版（回合制2）最大的坑是「伤害在三个地方各算一遍，
 * 后算的把先算的覆盖掉」——BUFF 加成算完又被裸值盖回去、敌方承伤时把玩家闪避
 * 当防御传进去。这里把一回合的结算收成**一个函数**，输入状态 + 行动，输出新状态 +
 * 事件流，中间不碰数据库、不读全局变量。
 *
 * 好处：
 *   - 可注入 rng，同种子同结果 → 战斗能回放、能回归测试
 *   - 文案由调用方渲染，这一层只管数
 *
 * 事件流（events）是给呈现层用的，形状固定：
 *   { t:'damage', by:'player'|'monster', value, crit, skill }
 *   { t:'miss',   by }
 *   { t:'dodge',  by }        by 是被打的一方
 *   { t:'dead',   by }        by 是死掉的一方
 *   { t:'flee' }
 *   { t:'defend', cut, mp }   防御：本回合承伤打折 + 回魂力
 *   { t:'no_mp',  need, have }
 *
 * 相比同类插件多一个「防御」动作：只有「攻击/魂技」两选一时，回合制退化成
 * 「哪个数字大按哪个」；有防御才有「这回合该不该硬扛」的决策。
 */
import { damageOnce, monsterLevel } from './formula.js';
import { parseStatuses, tickStatuses, addStatus, aggregate, applyPct, rollStatuses } from './status.js';

/** 防御状态：承伤系数与回魂比例（都在 cfg 里可调） */
const DEFEND_TAKEN = 0.5;
const DEFEND_MP_RATIO = 0.1;

/** 把怪物行包装成 damageOnce 能吃的「攻击者」 */
function monsterAsAttacker(battle) {
  return {
    atk: battle.monster_atk,
    str: 0,
    intel: 0,
    // 原版魂兽有独立的暴击/暴伤字段，之前这里硬编码 0，
    // 等于所有怪都「不会暴击」——高暴击的敏捷型魂兽完全体现不出来
    crit: Number(battle.monster_crit ?? 0),
    crit_dmg: Number(battle.monster_crit_dmg ?? 150),
    level: monsterLevel(battle.monster_age),
  };
}

/**
 * 结算一回合：玩家先出手，怪物没死就反击。
 *
 * @param {object} p
 * @param {object} p.player  玩家行（读 atk/def/str/intel/crit/crit_dmg/dodge/level/hp/mp）
 * @param {object} p.battle  战斗行（读 monster_hp / monster_def / monster_atk / monster_age）
 * @param {{type:'attack'|'skill'|'flee', skill?:object}} p.action
 * @param {object} p.cfg
 * @param {()=>number} [p.rng]
 */
/**
 * 一回合结算。
 *
 * 状态效果的顺序很重要，这里是**回合开始先结算状态**：
 *   1. 双方状态 tick（中毒掉血 / 回复回血），可能直接分出胜负
 *   2. 玩家眩晕就跳过出手（但仍会被打）
 *   3. 玩家出手，命中后按技能配置附加状态
 *   4. 怪物眩晕就不反击
 *
 * 为什么先 tick 再出手：如果先出手，被毒死的那一方还能先打一下，
 * 玩家会觉得「明明该死了还打我」，而且即时反馈也不对。
 */
export function resolveRound({ player, battle, action = { type: 'attack' }, cfg, rng = Math.random, statusDefs = {}, skillStatus = {}, monsterSkill = {} }) {
  const events = [];
  let monsterHp = Number(battle.monster_hp) || 0;
  let playerHp = Number(player.hp) || 0;
  let playerMp = Number(player.mp) || 0;

  if (action.type === 'flee') {
    events.push({ t: 'flee' });
    return { events, monsterHp, playerHp, playerMp, monsterDead: false, playerDead: false, fled: true };
  }

  /* ---------------- 冷却 ---------------- */

  const pCd = parseCd(battle.player_cd);
  const mCd = parseCd(battle.monster_cd);
  // 回合开始先减冷却（本回合刚放的技能在下面重新写入，不会被误减）
  for (const k of Object.keys(pCd)) {
    pCd[k] = Math.max(0, Number(pCd[k]) - 1);
    if (!pCd[k]) delete pCd[k];
  }
  for (const k of Object.keys(mCd)) {
    mCd[k] = Math.max(0, Number(mCd[k]) - 1);
    if (!mCd[k]) delete mCd[k];
  }

  const skill = action.type === 'skill' ? action.skill : null;
  if (skill) {
    const left = Number(pCd[skill.id] ?? 0);
    if (left > 0) {
      return {
        events: [{ t: 'cooldown', skill: skill.name, left }],
        monsterHp, playerHp, playerMp,
        monsterDead: false, playerDead: false,
        playerStatus: parseStatuses(battle.player_status),
        monsterStatus: parseStatuses(battle.monster_status),
        playerCd: pCd, monsterCd: mCd,
      };
    }
  }

  // ---- 状态结算 ----
  let pStatus = parseStatuses(battle.player_status);
  let mStatus = parseStatuses(battle.monster_status);
  const pMax = Number(player.hp_max ?? player.hp ?? 1);
  const mMax = Number(battle.monster_hp_max ?? battle.monster_hp ?? 1);

  /**
   * 行为标记（跳过行动 / 封魂技 / 即死）要在 **tick 之前** 取。
   *
   * 踩过的坑：眩晕和即死印记的持续都是 1 回合，如果先 tick 再聚合，
   * 它们会在生效前就被减到 0 清掉——「眩晕」变成了完全没用的状态。
   * 属性百分比则用 tick 之后的列表，让掉血和减益同步。
   */
  const pAggPre = aggregate(pStatus, statusDefs);
  const mAggPre = aggregate(mStatus, statusDefs);

  const pTick = tickStatuses(pStatus, pMax, statusDefs);
  pStatus = pTick.list;
  if (pTick.damage) playerHp = Math.max(0, playerHp - pTick.damage);
  if (pTick.heal) playerHp = Math.min(pMax, playerHp + pTick.heal);
  for (const e of pTick.events) events.push({ ...e, on: 'player' });

  const mTick = tickStatuses(mStatus, mMax, statusDefs);
  mStatus = mTick.list;
  if (mTick.damage) monsterHp = Math.max(0, monsterHp - mTick.damage);
  if (mTick.heal) monsterHp = Math.min(mMax, monsterHp + mTick.heal);
  for (const e of mTick.events) events.push({ ...e, on: 'monster' });

  if (playerHp <= 0) {
    events.push({ t: 'dead', by: 'player' });
    return { events, monsterHp, playerHp, playerMp, monsterDead: false, playerDead: true, playerStatus: pStatus, monsterStatus: mStatus, playerCd: pCd, monsterCd: mCd };
  }
  if (monsterHp <= 0) {
    events.push({ t: 'dead', by: 'monster' });
    return { events, monsterHp, playerHp, playerMp, monsterDead: true, playerDead: false, playerStatus: pStatus, monsterStatus: mStatus, playerCd: pCd, monsterCd: mCd };
  }

  // ---- 即死判定（低概率直接秒，命中就结束） ----
  const pAgg = { ...aggregate(pStatus, statusDefs), skip: pAggPre.skip, blockSkill: pAggPre.blockSkill, instantKill: pAggPre.instantKill };
  const mAgg = { ...aggregate(mStatus, statusDefs), skip: mAggPre.skip, instantKill: mAggPre.instantKill };
  if (pAgg.instantKill && rng() * 100 < pAgg.instantKill) {
    events.push({ t: 'instant_kill', on: 'player' });
    return { events, monsterHp, playerHp: 0, playerMp, monsterDead: false, playerDead: true, playerStatus: pStatus, monsterStatus: mStatus, playerCd: pCd, monsterCd: mCd };
  }
  if (mAgg.instantKill && rng() * 100 < mAgg.instantKill) {
    events.push({ t: 'instant_kill', on: 'monster' });
    return { events, monsterHp: 0, playerHp, playerMp, monsterDead: true, playerDead: false, playerStatus: pStatus, monsterStatus: mStatus, playerCd: pCd, monsterCd: mCd };
  }

  // ---- 玩家出手 ----
  const defending = action.type === 'defend';

  if (pAgg.skip) {
    events.push({ t: 'stunned', on: 'player' });
  } else if (skill && pAgg.blockSkill) {
    events.push({ t: 'silenced', on: 'player' });
  } else {
    if (skill) {
      if (playerMp < Number(skill.cost ?? 0)) {
        return { events: [{ t: 'no_mp', need: Number(skill.cost ?? 0), have: playerMp }], monsterHp, playerHp, playerMp, monsterDead: false, playerDead: false, playerStatus: pStatus, monsterStatus: mStatus, playerCd: pCd, monsterCd: mCd };
      }
      playerMp -= Number(skill.cost ?? 0);
      // 用完就进冷却（skill.cd 是回合数，0 = 无冷却）
      const cd = Math.max(0, Number(skill.cd ?? 0));
      if (cd > 0) pCd[skill.id] = cd;
    }

    if (defending) {
      // 防御不出手，但回一点魂力，让「攒魂力放大招」成为可行策略
      const gain = Math.max(1, Math.round(Number(player.mp_max ?? player.mp ?? 1) * DEFEND_MP_RATIO));
      playerMp = Math.min(Number(player.mp_max ?? playerMp + gain), playerMp + gain);
      events.push({ t: 'defend', cut: Math.round((1 - DEFEND_TAKEN) * 100), mp: gain });
    } else if (skill && (skill.scope === 'self_one' || skill.scope === 'self_all')) {
      /**
       * 己方技能：治疗 + 给自己上状态。
       *
       * 原版 342 个魂技里有 **26 个是「己方单体 / 己方全体」**（治疗、护盾、狂暴），
       * 我们之前只实现了打敌人，这 26 个技能导进来也放不出来。
       *
       * 治疗量用「施法者最大生命 × heal_pct%」表达，而不是绝对数值——
       * 这样 30 级的治疗技能到 80 级还能用，不会像固定值那样迅速过期。
       */
      const maxHp = Math.max(1, applyPct(player.hp_max ?? player.hp ?? 1, pAgg.hp));
      const healPct = Number(skill.heal_pct ?? 0);
      if (healPct > 0) {
        const before = playerHp;
        playerHp = Math.min(maxHp, playerHp + Math.max(1, Math.round((maxHp * healPct) / 100)));
        events.push({ t: 'heal', by: 'player', value: playerHp - before, skill: skill.name });
      }
      const cands = skillStatus[Number(skill.id)] ?? [];
      for (const hit of rollStatuses(cands, rng)) {
        const def = statusDefs[hit.key];
        if (!def) continue;
        if (hit.target === 'enemy') {
          mStatus = addStatus(mStatus, hit.key, def, { duration: Number(hit.duration) || 0 });
          events.push({ t: 'status', on: 'monster', key: hit.key, name: def.name, harmful: def.kind !== 'buff' });
        } else {
          pStatus = addStatus(pStatus, hit.key, def, { duration: Number(hit.duration) || 0 });
          events.push({ t: 'status', on: 'player', key: hit.key, name: def.name, harmful: def.kind !== 'buff' });
        }
      }
      if (!healPct && !cands.length) events.push({ t: 'no_effect', skill: skill.name });
    } else {
      const hitRate = Math.min(100, skill ? Number(skill.hit ?? 95) : 100);
      const dodged = rng() * 100 < Math.min(60, Math.max(0, Number(mAgg.dodge ?? 0)));
      if (dodged) {
        events.push({ t: 'dodge', by: 'monster' });
      } else if (rng() * 100 >= hitRate) {
        events.push({ t: 'miss', by: 'player' });
      } else {
        // 状态里的攻击百分比是**临时**修正，不改玩家表
        const eff = {
          ...player,
          atk: applyPct(player.atk, pAgg.atk),
          crit: Math.max(0, Number(player.crit ?? 0) + Number(pAgg.crit ?? 0)),
          // 暴击伤害也吃状态加成（原版「暴击伤害」字段）
          crit_dmg: Math.max(100, Number(player.crit_dmg ?? 150) + Number(pAgg.critDmg ?? 0)),
        };
        const d = damageOnce({
          p: eff,
          target: { def: applyPct(battle.monster_def ?? 1, mAgg.def) },
          powerPercent: skill ? Number(skill.power ?? 100) : 100,
          cfg,
          rng,
        });
        monsterHp = Math.max(0, monsterHp - d.value);
        events.push({ t: 'damage', by: 'player', value: d.value, crit: d.crit, skill: skill?.name ?? null });

        // 命中后按技能配置附加状态
        if (skill && monsterHp > 0) {
          const cands = skillStatus[Number(skill.id)] ?? [];
          for (const hit of rollStatuses(cands, rng)) {
            const def = statusDefs[hit.key];
            if (!def) continue;
            // target='self' 的状态挂到施法者身上（狂暴/嗜血/护体这类）
            if (hit.target === 'self') {
              pStatus = addStatus(pStatus, hit.key, def, { duration: Number(hit.duration) || 0 });
              events.push({ t: 'status', on: 'player', key: hit.key, name: def.name, harmful: def.kind !== 'buff' });
            } else {
              mStatus = addStatus(mStatus, hit.key, def, { duration: Number(hit.duration) || 0 });
              events.push({ t: 'status', on: 'monster', key: hit.key, name: def.name, harmful: def.kind !== 'buff' });
            }
          }
        }
      }

      if (monsterHp <= 0) {
        events.push({ t: 'dead', by: 'monster' });
        return { events, monsterHp, playerHp, playerMp, monsterDead: true, playerDead: false, playerStatus: pStatus, monsterStatus: mStatus, playerCd: pCd, monsterCd: mCd };
      }
    }
  }

  // ---- 怪物反击 ----
  if (mAgg.skip) {
    events.push({ t: 'stunned', on: 'monster' });
  } else if (rng() * 100 < Math.min(75, Number(applyPct(player.dodge ?? 1, pAgg.dodge ?? 0)) || 0)) {
    events.push({ t: 'dodge', by: 'player' });
  } else {
    /**
     * 怪物 AI：优先放技能。
     *
     * 之前 `monster_skill` 表有 223 条配置，但战斗里怪物只会普攻——
     * 玩家永远面对「一根木桩」。现在按权重挑一个不在冷却里的技能，
     * 用它的威力，并把它的状态（中毒/减速/眩晕）打到玩家身上。
     */
    const picked = pickMonsterSkill(battle, monsterSkill, mCd, cfg, rng);
    const power = picked ? Number(picked.power ?? 100) : 100;
    const md = damageOnce({
      p: monsterAsAttacker({ ...battle, monster_atk: applyPct(battle.monster_atk ?? 1, mAgg.atk) }),
      target: { def: applyPct(player.def ?? 1, pAgg.def ?? 0) },
      powerPercent: power,
      cfg,
      rng,
    });
    const taken = defending ? Math.max(1, Math.round(md.value * DEFEND_TAKEN)) : md.value;
    playerHp = Math.max(0, playerHp - taken);
    events.push({ t: 'damage', by: 'monster', value: taken, crit: false, defended: defending, skill: picked?.name ?? null });

    if (picked) {
      const cd = Math.max(0, Number(picked.cd ?? 0));
      if (cd > 0) mCd[picked.id] = cd;
      if (playerHp > 0) {
        for (const hit of rollStatuses(skillStatus[Number(picked.id)] ?? [], rng)) {
          const def = statusDefs[hit.key];
          if (!def) continue;
          pStatus = addStatus(pStatus, hit.key, def, { duration: Number(hit.duration) || 0 });
          events.push({ t: 'status', on: 'player', key: hit.key, name: def.name, harmful: def.kind !== 'buff' });
        }
      }
    }

    if (playerHp <= 0) {
      events.push({ t: 'dead', by: 'player' });
      return { events, monsterHp, playerHp, playerMp, monsterDead: false, playerDead: true, playerStatus: pStatus, monsterStatus: mStatus, playerCd: pCd, monsterCd: mCd };
    }
  }

  return { events, monsterHp, playerHp, playerMp, monsterDead: false, playerDead: false, playerStatus: pStatus, monsterStatus: mStatus, playerCd: pCd, monsterCd: mCd };
}

/* ---------------- 冷却与怪物 AI 的小工具 ---------------- */

function parseCd(raw) {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? { ...v } : {};
  } catch {
    return {};
  }
}

/**
 * 挑一个怪物技能。
 * 没配技能 / 都没冷却好 / 概率没中 → 返回 null（走普攻）。
 */
function pickMonsterSkill(battle, monsterSkill, mCd, cfg, rng) {
  const list = monsterSkill?.byMonster?.[Number(battle.monster_id)] ?? [];
  if (!list.length) return null;
  const rate = Math.max(0, Number(cfg?.monster_skill_rate ?? 45));
  if (rng() * 100 >= rate) return null;

  const ready = list
    .map((x) => {
      const s = monsterSkill?.skills?.[Number(x.skill_id)];
      if (!s) return null;
      if (Number(mCd[s.id] ?? 0) > 0) return null;
      return { ...s, weight: Math.max(1, Number(x.weight ?? 1)) };
    })
    .filter(Boolean);
  if (!ready.length) return null;

  const total = ready.reduce((sum, s) => sum + s.weight, 0);
  let roll = rng() * total;
  for (const s of ready) {
    roll -= s.weight;
    if (roll <= 0) return s;
  }
  return ready[ready.length - 1];
}

/**
 * 挂机补算：玩家多久没动，怪物就多打了几下。
 *
 * 但**必须有上限**（方案 §5.1）：原版按真实秒数补算，玩家去泡杯咖啡回来会被
 * 补算几百次直接打死。这里最多补 catchup_max_rounds 回合，超出的直接丢弃。
 *
 * @returns {{hits:number, skipped:number, playerHp:number, playerDead:boolean, events:object[]}}
 */
export function catchUp({ player, battle, cfg, now = Date.now(), rng = Math.random }) {
  const interval = Math.max(1, 10 - Number(player.spd ?? 0) / 100); // 秒
  const idleSec = Math.max(0, (now - Number(battle.last_act_at || now)) / 1000);
  const raw = Math.floor(idleSec / interval);
  const cap = Math.max(0, Number(cfg.catchup_max_rounds ?? 5));
  const hits = Math.min(raw, cap);
  const skipped = Math.max(0, raw - cap);

  const events = [];
  let playerHp = Number(player.hp) || 0;
  let dead = false;

  for (let i = 0; i < hits; i += 1) {
    if (rng() * 100 < Math.min(75, Number(player.dodge) || 0)) {
      events.push({ t: 'dodge', by: 'player' });
      continue;
    }
    const md = damageOnce({
      p: monsterAsAttacker(battle),
      target: { def: player.def },
      powerPercent: 100,
      cfg,
      rng,
    });
    playerHp = Math.max(0, playerHp - md.value);
    events.push({ t: 'damage', by: 'monster', value: md.value, crit: false });
    if (playerHp <= 0) {
      events.push({ t: 'dead', by: 'player' });
      dead = true;
      break;
    }
  }

  return { hits, skipped, playerHp, playerDead: dead, events };
}

/**
 * 玩家对玩家的异步对战（PVP）。
 *
 * 为什么用模拟而不是直接比战力：比战力是「数字大的赢」，玩家没有参与感，
 * 也无法解释「我战力高为什么输」。这里真的按回合打，速度决定先手，
 * 结果能复盘（events 里每一下伤害都在），和 PVE 共用同一套伤害公式。
 *
 * 对手用**当前快照**（他不需要在线），所以叫异步。
 *
 * @returns {{winner:'a'|'b', rounds:number, aHp:number, bHp:number, events:object[]}}
 */
/**
 * 玩家对玩家结算。
 *
 * 和 PVE 用同一个 `damageOnce`，但**不能照搬 PVE 的参数**：
 *   - PVE 的怪物攻击力是按「几回合打死标准玩家」反推的，双方血量差很大；
 *     PVP 两边血量相近，照搬会变成「谁先手谁赢」。
 *   - PVE 的怪不会闪避，PVP 的玩家会——早期版本这里压根没判闪避，闪避属性在 PVP 里是废的。
 *
 * 所以 PVP 单独做四件事：
 *   1. **伤害缩放**（pvp_damage_scale）：拉长回合，让属性差体现出来而不是靠先手
 *   2. **后手补偿**（pvp_second_mover_bonus）：先手优势客观存在，给后手一点伤害补正
 *   3. **判闪避**：让闪避属性在 PVP 里真的有用
 *   4. **等级差衰减**（pvp_level_gap_soft）：等级差太大时，强的一方伤害递减，
 *      避免高等级无限屠新手
 */
export function duelResolve({ a, b, cfg, maxRounds = 0, rng = Math.random }) {
  const aMax = Math.max(1, Number(a.hp_max ?? a.hp ?? 1));
  const bMax = Math.max(1, Number(b.hp_max ?? b.hp ?? 1));
  let aHp = Math.max(1, Number(a.hp ?? aMax));
  let bHp = Math.max(1, Number(b.hp ?? bMax));

  const scale = Math.max(0.2, Number(cfg.pvp_damage_scale ?? 0.75));
  const secondBonus = Math.max(0, Number(cfg.pvp_second_mover_bonus ?? 0.12));
  const gapSoft = Math.max(1, Number(cfg.pvp_level_gap_soft ?? 10));
  const roundsCap = Math.max(1, Number(maxRounds || cfg.pvp_max_rounds || 15));

  const events = [];
  let round = 0;
  const first = Number(a.spd ?? 0) >= Number(b.spd ?? 0) ? 'a' : 'b';

  while (round < roundsCap && aHp > 0 && bHp > 0) {
    round += 1;
    const order = first === 'a' ? ['a', 'b'] : ['b', 'a'];
    for (const who of order) {
      if (aHp <= 0 || bHp <= 0) break;
      const atk = who === 'a' ? a : b;
      const def = who === 'a' ? b : a;

      // 闪避：PVE 里怪物不闪，PVP 必须判，否则闪避属性白加
      const dodge = Math.min(60, Math.max(0, Number(def.dodge ?? 0)));
      if (rng() * 100 < dodge) {
        events.push({ round, by: who, dodged: true, value: 0 });
        continue;
      }

      // 等级差：强的一方伤害递减（最多砍 50%）
      const lvA = Number(atk.level ?? 1);
      const lvB = Number(def.level ?? 1);
      const gapPenalty = lvA > lvB ? Math.max(0.5, 1 - (lvA - lvB) / (gapSoft * 4)) : 1;
      const postBonus = who === first ? 1 : 1 + secondBonus;

      const d = damageOnce({ p: atk, target: { def: def.def }, powerPercent: 100, cfg, rng });
      const value = Math.max(1, Math.round(d.value * scale * gapPenalty * postBonus));
      if (who === 'a') bHp = Math.max(0, bHp - value);
      else aHp = Math.max(0, aHp - value);
      events.push({ round, by: who, value, crit: d.crit });
    }
  }

  let winner;
  if (aHp <= 0 && bHp > 0) winner = 'b';
  else if (bHp <= 0 && aHp > 0) winner = 'a';
  else winner = aHp / aMax >= bHp / bMax ? 'a' : 'b'; // 都没打死：比剩余血量比例

  return { winner, rounds: round, aHp, bHp, aMax, bMax, events, first };
}

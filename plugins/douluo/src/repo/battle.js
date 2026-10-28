/**
 * 战斗数据层
 * ==========
 *
 * 引擎（engine/battle.js）只管算，这里管「读状态 → 算 → 落库 → 发奖」。
 *
 * 三个和同类插件不一样的地方：
 *   1. 怪物属性在开战时**快照**进 battle 表。内容表后来改了，不会影响正在打的这场
 *      （原版是每次攻击都去读配置，运营一改数值就把战斗中的人打崩）。
 *   2. 战斗落库，进程重启/断线重连能接着打。原版放「临时数据」单库，重启即丢。
 *   3. 挂机补算有上限，且超时判逃跑不判死亡（方案 §5.1）。
 */
import { resolveRound, catchUp } from '../engine/battle.js';
import { rollRingYears } from '../engine/formula.js';
import { parseStatuses, aggregate } from '../engine/status.js';
import { expNeed } from '../engine/progress.js';
import { withTx } from './player.js';

const now = () => Date.now();

/**
 * 第 slot 个魂环需要多少年以上的魂兽。
 * 每两个环升一个年限档：1-2 十年 / 3-4 百年 / 5-6 千年 / 7-8 万年 / 9-10 十万年。
 */
function ringMinAge(slot) {
  const n = Math.max(1, Math.trunc(Number(slot) || 1));
  return 10 ** (1 + Math.floor((n - 1) / 2));
}
const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export class BattleRepo {
  constructor(game, content, players, balance) {
    this.db = game;
    this.content = content;
    this.players = players;
    this.balance = balance;
  }

  current(openid) {
    return this.db.prepare("SELECT * FROM battle WHERE openid = ? AND state = 'active'").get(String(openid)) ?? null;
  }

  /** 本地图能打的魂兽 */
  monstersAt(mapId) {
    return this.content.db
      .prepare(
        `SELECT m.* FROM monster m JOIN monster_map mm ON mm.monster_id = m.id
          WHERE mm.map_id = ? AND m.enabled = 1 ORDER BY
                CASE m.tier WHEN 'normal' THEN 0 WHEN 'elite' THEN 1 ELSE 2 END, m.id`,
      )
      .all(Number(mapId));
  }

  /** 按名字找魂兽，并校验它确实在玩家所在地图 */
  findMonster(name, mapId) {
    const m = this.content.db.prepare('SELECT * FROM monster WHERE name = ? AND enabled = 1').get(String(name));
    if (!m) return { error: 'no_such' };
    const here = this.content.db
      .prepare('SELECT 1 AS ok FROM monster_map WHERE monster_id = ? AND map_id = ?')
      .get(m.id, Number(mapId));
    if (!here) return { error: 'not_here', monster: m };
    return { monster: m };
  }

  /**
   * 开战：扣体力、快照怪物属性、建战斗行。
   */
  start(openid, monsterName) {
    // 开战前先结算被动回血，否则「休息了一会儿再打」等于没休息
    const p = this.players.regen(openid);
    if (!p) return { error: 'no_player' };
    if (p.status === 'dead') return { error: 'dead' };
    if (this.current(openid)) return { error: 'in_battle' };

    const found = this.findMonster(monsterName, p.map_id);
    if (found.error === 'no_such') return { error: 'no_such', name: monsterName };
    if (found.error === 'not_here') return { error: 'not_here', name: monsterName, monster: found.monster };

    const m = found.monster;
    const cfg = this.content.allCfg();
    const cost = Math.max(0, Number(cfg.stamina_cost_battle ?? 1));
    if (Number(p.stamina) < cost) return { error: 'no_stamina', need: cost, have: p.stamina };

    /**
     * 怪物属性由**内容**决定（年龄/品阶），不由玩家输出决定。
     * 早期版本按玩家 DPS 反推，导致「越练越没感觉」——见 engine/balance.js 顶部说明。
     */
    const stats = this.balance.monsterStats(m);
    const hp = stats.hp;
    const def = stats.def;
    const atk = stats.atk;

    withTx(this.db, () => {
      this.db.prepare('UPDATE player SET stamina = stamina - ?, status = ?, last_seen = ? WHERE openid = ?')
        .run(cost, 'battle', now(), openid);
      /**
       * 暴击/闪避：原版魂兽有独立字段，我们导入了 139 只带这些值的怪；
       * 老内容没填就按年龄给一档默认值——否则「所有怪暴击率都是 0」，
       * 敏捷型魂兽的特色完全体现不出来。
       */
      const band = (arr) => arr[ageBand(m.age)] ?? arr[0];
      const mCrit = Number(m.crit) || band([3, 6, 10, 15, 20]);
      const mCritDmg = Number(m.crit_dmg) || 150;
      const mDodge = Number(m.dodge) || band([1, 2, 4, 6, 8]);
      /**
       * 斗铠领域：原版「附加状态」——开启的领域在**战斗开始时**挂到玩家身上，
       * 而不是加到面板属性里。这样「领域」是战斗中生效的东西，
       * 和斗铠本身的固定属性加成区分开。left 给 999 = 整场持续。
       */
      const domain = this.extra?.activeDomain?.(openid);
      const initStatus = domain?.status_key
        ? JSON.stringify([{ key: domain.status_key, left: 999, stack: 1 }])
        : '[]';
      this.db
        .prepare(
          `INSERT INTO battle (openid, monster_id, monster_name, monster_hp, monster_hp_max,
                               monster_def, monster_atk, monster_age, round, started_at, last_act_at, state,
                               player_status, monster_status, player_cd, monster_cd,
                               monster_crit, monster_crit_dmg, monster_dodge)
           VALUES (?,?,?,?,?,?,?,?,0,?,?,'active',?,?,'{}','{}',?,?,?)`,
        )
        .run(openid, m.id, m.name, hp, hp, def, atk, m.age, now(), now(), initStatus, '[]', mCrit, mCritDmg, mDodge);
    });

    return { battle: this.current(openid), monster: m, staminaCost: cost, player: this.players.get(openid) };
  }

  /** 状态定义 + 技能→状态映射（缓存，内容不变就一直用） */
  #statusCtx() {
    if (this._statusCtx) return this._statusCtx;
    const defs = {};
    for (const r of this.content.db.prepare('SELECT * FROM status_def WHERE enabled = 1').all()) defs[r.key] = r;
    const bySkill = {};
    for (const r of this.content.db.prepare('SELECT * FROM skill_status').all()) {
      if (!bySkill[r.skill_id]) bySkill[r.skill_id] = [];
      bySkill[r.skill_id].push({
        key: r.status_key,
        chance: Number(r.chance ?? 100),
        duration: Number(r.duration ?? 0),
        // 'enemy' = 打敌人身上，'self' = 加在自己身上（原版「魂技自身附加」）
        target: r.target === 'self' ? 'self' : 'enemy',
      });
    }
    // 怪物技能：怪物 id → [{skill_id, weight}]，以及技能本体
    const byMonster = {};
    for (const r of this.content.db.prepare('SELECT * FROM monster_skill').all()) {
      if (!byMonster[r.monster_id]) byMonster[r.monster_id] = [];
      byMonster[r.monster_id].push({ skill_id: r.skill_id, weight: r.weight });
    }
    const skills = {};
    for (const r of this.content.db.prepare('SELECT * FROM skill WHERE enabled = 1').all()) skills[r.id] = r;
    this._statusCtx = { defs, bySkill, monsterSkill: { byMonster, skills } };
    return this._statusCtx;
  }

  /**
   * 一次行动。
   * @param {{type:'attack'|'skill'|'defend'|'flee', skill?:object}} action
   */
  act(openid, action) {
    const p = this.players.get(openid);
    if (!p) return { error: 'no_player' };
    const b = this.current(openid);
    if (!b) return { error: 'no_battle' };

    const cfg = this.content.allCfg();
    const idleBase = Number(b.last_act_at) || now();

    if (action.type === 'flee') {
      this.#endBattle(openid, 'idle');
      return { fled: true, events: [{ t: 'flee' }], battle: b };
    }

    const stx = this.#statusCtx();
    const r = resolveRound({ player: p, battle: b, action, cfg, statusDefs: stx.defs, skillStatus: stx.bySkill, monsterSkill: stx.monsterSkill });
    if (r.events[0]?.t === 'no_mp') {
      return { error: 'no_mp', need: r.events[0].need, have: r.events[0].have };
    }
    if (r.events[0]?.t === 'cooldown') {
      return { error: 'cooldown', skill: r.events[0].skill, left: r.events[0].left };
    }

    const events = [...r.events];
    let playerHp = r.playerHp;
    let playerMp = r.playerMp;
    let monsterHp = r.monsterHp;
    let playerDead = r.playerDead;
    let monsterDead = r.monsterDead;

    /**
     * 伙伴助战：出战的伙伴有概率追击一次。
     *
     * 之前伙伴只是「属性挂件」——加完 atk/def 就没事了，玩家对它的存在感很弱。
     * 这里让它真的出手，战斗里能看到「火狐 追击 23」这种反馈，
     * 伙伴才像一个同伴，而不是一件装备。
     */
    if (!monsterDead && !playerDead) {
      const comp = this.players.activeCompanions(openid).find((c) => c.kind !== 'card' && Number(c.active) === 1);
      const rate = Number(cfg.companion_follow_rate ?? 30);
      if (comp && Math.random() * 100 < rate) {
        const dmg = Math.max(1, Math.round(Number(comp.atk ?? 0) * (1 + Number(comp.str ?? 0) / 1000)));
        monsterHp = Math.max(0, monsterHp - dmg);
        events.push({ t: 'companion', name: comp.name, value: dmg });
        if (monsterHp <= 0) monsterDead = true;
      }
    }

    // 怪物没死 → 按挂机时长补算（有上限）
    let catchupInfo = null;
    if (!monsterDead && !playerDead) {
      const c = catchUp({ player: { ...p, hp: playerHp }, battle: { ...b, last_act_at: idleBase }, cfg, now: now() });
      if (c.hits > 0) {
        catchupInfo = { hits: c.hits, skipped: c.skipped };
        events.push(...c.events);
        playerHp = c.playerHp;
        playerDead = c.playerDead;
      }
    }

    // 落库
    withTx(this.db, () => {
      if (playerDead) {
        this.db.prepare('UPDATE player SET hp = 0, status = ?, last_seen = ? WHERE openid = ?').run('dead', now(), openid);
        this.db.prepare('DELETE FROM battle WHERE openid = ?').run(openid);
      } else if (monsterDead) {
        // 交给 finish 处理，这里只更新玩家
        this.db.prepare('UPDATE player SET hp = ?, mp = ?, last_seen = ? WHERE openid = ?').run(playerHp, playerMp, now(), openid);
      } else {
        this.db
          .prepare('UPDATE player SET hp = ?, mp = ?, last_seen = ? WHERE openid = ?')
          .run(playerHp, playerMp, now(), openid);
        this.db
          .prepare(
            'UPDATE battle SET monster_hp = ?, round = round + 1, last_act_at = ?, player_status = ?, monster_status = ?, player_cd = ?, monster_cd = ? WHERE id = ?',
          )
          .run(
            monsterHp,
            now(),
            JSON.stringify(r.playerStatus ?? []),
            JSON.stringify(r.monsterStatus ?? []),
            JSON.stringify(r.playerCd ?? {}),
            JSON.stringify(r.monsterCd ?? {}),
            b.id,
          );
      }
    });

    if (playerDead) {
      return { events, playerDead: true, catchup: catchupInfo, player: this.players.get(openid) };
    }

    if (monsterDead) {
      const reward = this.finish(openid, b, p, cfg);
      return { events, monsterDead: true, catchup: catchupInfo, reward, player: this.players.get(openid) };
    }

    return {
      events,
      catchup: catchupInfo,
      monsterHp,
      player: this.players.get(openid),
      battle: this.current(openid),
    };
  }

  /**
   * 自动战斗：一直普攻到分出结果。
   *
   * 为什么要做：一场战斗 4 回合就是 4 条消息、4 次操作，
   * 群里三个人同时打怪能刷出十几条。现代放置类游戏都是默认自动，
   * 只在需要决策时打断玩家。
   *
   * 这里**不**替玩家做决策（不用魂技、不吃药），只重复普攻——
   * 想手动的人继续用 `攻击`，两者共存。
   */
  autoFight(openid, { maxRounds = 30 } = {}) {
    const b = this.current(openid);
    if (!b) return { error: 'no_battle' };
    const events = [];
    let rounds = 0;
    let outcome = null;
    let reward = null;

    for (let i = 0; i < maxRounds; i += 1) {
      const r = this.act(openid, { type: 'attack' });
      if (r.error) return { ...r, events, rounds };
      rounds += 1;
      events.push(...(r.events ?? []));
      if (r.playerDead) {
        outcome = 'dead';
        break;
      }
      if (r.monsterDead) {
        outcome = 'win';
        reward = r.reward ?? null;
        break;
      }
    }
    return {
      ok: true,
      rounds,
      outcome: outcome ?? 'timeout',
      events,
      reward,
      player: this.players.get(openid),
      battle: this.current(openid),
    };
  }

  /** 击杀结算：经验、魂币、击杀计数、魂环掉落 */
  finish(openid, b, p, cfg) {
    const m = this.content.db.prepare('SELECT * FROM monster WHERE id = ?').get(b.monster_id) ?? {
      exp_rate: 1,
      gold_rate: 1,
      age: b.monster_age,
      name: b.monster_name,
      drop_ring: 1,
    };

    /**
     * 状态里的「经验 / 金币」加成（原版状态 16 字段里的两个）。
     * 战斗结束时玩家身上可能还挂着「双倍经验」这类 buff，这里按它结算。
     * 组队加成也在这里乘上去（队友越多经验越高）。
     */
    const stx = this.#statusCtx();
    const agg = aggregate(parseStatuses(b.player_status), stx.defs);
    const expMul = 1 + Number(agg.exp ?? 0) / 100;
    const goldMul = 1 + Number(agg.gold ?? 0) / 100;
    const teamMul = 1 + Number(this.extra?.teamBonus?.(openid)?.expBonus ?? 0);
    const expGain = Math.max(1, Math.round(expNeed(p.level, cfg) * Number(cfg.kill_exp_ratio ?? 0.15) * Number(m.exp_rate ?? 1) * expMul * teamMul));
    const goldGain = Math.max(0, Math.round(Number(cfg.kill_gold_base ?? 10) * Number(m.gold_rate ?? 1) * Math.max(1, p.level) * goldMul));

    const out = withTx(this.db, () => {
      this.db.prepare('DELETE FROM battle WHERE openid = ?').run(openid);
      this.db.prepare('UPDATE player SET status = ?, last_seen = ? WHERE openid = ?').run('idle', now(), openid);
      this.db
        .prepare(
          `INSERT INTO kill_count (openid, monster_id, n) VALUES (?,?,1)
           ON CONFLICT(openid, monster_id) DO UPDATE SET n = n + 1`,
        )
        .run(openid, b.monster_id);
      return { expGain, goldGain };
    });

    this.players.addGold(openid, goldGain, `击杀 ${b.monster_name}`);
    // 装备掉耐久（`growth` 由 index.js 后置注入）
    this.growth?.wear(openid);
    const expResult = this.players.gainExp(openid, expGain);

    // ---- 魂环掉落 ----
    let ring = null;
    let ringBlocked = null;
    if (Number(m.drop_ring ?? 1) === 1) {
      const rings = this.players.ringCount(openid);
      const nextSlot = rings + 1;
      const needAge = ringMinAge(nextSlot);

      /**
       * 年限门槛：第 N 环必须由足够老的魂兽形成。
       *
       * 原著里魂环的年限跟着魂兽走，不是随便打只兔子就能长第 9 环。
       * 早期没有这道门槛，43 次击杀就能攒满 10 个环——
       * 魂环墙这个节奏器直接被玩穿了。
       *
       *   1–2 环 → 十年以上（10）
       *   3–4 环 → 百年以上（100）
       *   5–6 环 → 千年以上（1000）
       *   7–8 环 → 万年以上（10000）
       *   9–10 环 → 十万年以上（100000）
       */
      if (Number(b.monster_age) < needAge) {
        ringBlocked = { slot: nextSlot, needAge, haveAge: Number(b.monster_age) };
      } else {
        const first = rings === 0 && Number(cfg.ring_drop_first ?? 1) === 1;
        const rate = Number(cfg.ring_drop_rate ?? 35);
        if (first || Math.random() * 100 < rate) {
          ring = this.#dropRing(openid, b, cfg);
        }
      }
    }

    const drops = this.#rollDrops(openid, b.monster_id);
    return { ...out, exp: expResult, ring, ringBlocked, drops };
  }

  /**
   * 掉落结算。
   *
   * 之前击杀只给经验+魂币+魂环，材料全靠商店买——打怪没有「捡到东西」的反馈。
   * 现在按 `monster_drop` 逐条 roll，材料/装备/宝石/伙伴都可能掉。
   */
  #rollDrops(openid, monsterId) {
    let rows = [];
    try {
      rows = this.content.db.prepare('SELECT * FROM monster_drop WHERE monster_id = ?').all(Number(monsterId));
    } catch {
      return [];
    }
    const got = [];
    for (const d of rows) {
      if (Math.random() * 100 >= Number(d.chance ?? 0)) continue;
      const lo = Math.max(1, Number(d.qty_min ?? 1));
      const hi = Math.max(lo, Number(d.qty_max ?? lo));
      const qty = lo + Math.floor(Math.random() * (hi - lo + 1));
      try {
        if (d.kind === 'item') {
          const it = this.content.db.prepare('SELECT name FROM item WHERE id = ?').get(Number(d.ref_id));
          if (!it) continue;
          this.players.addItem(openid, Number(d.ref_id), qty, '击杀掉落');
          got.push({ kind: 'item', name: it.name, qty });
        } else if (d.kind === 'equip') {
          const eq = this.content.db.prepare('SELECT name FROM equip WHERE id = ?').get(Number(d.ref_id));
          if (!eq) continue;
          this.players.grantEquip(openid, Number(d.ref_id), '击杀掉落');
          got.push({ kind: 'equip', name: eq.name, qty: 1 });
        } else if (d.kind === 'gem') {
          const gm = this.content.db.prepare('SELECT name FROM gem WHERE id = ?').get(Number(d.ref_id));
          if (!gm) continue;
          this.db
            .prepare(
              `INSERT INTO gem_owned (openid, gem_id, qty) VALUES (?,?,?)
               ON CONFLICT(openid, gem_id) DO UPDATE SET qty = qty + ?`,
            )
            .run(String(openid), Number(d.ref_id), qty, qty);
          got.push({ kind: 'gem', name: gm.name, qty });
        } else if (d.kind === 'companion') {
          const cp = this.content.db.prepare('SELECT name FROM companion WHERE id = ?').get(Number(d.ref_id));
          if (!cp) continue;
          this.players.grantCompanion(openid, Number(d.ref_id), '击杀掉落');
          got.push({ kind: 'companion', name: cp.name, qty: 1 });
        }
      } catch {
        /* 单条掉落失败不影响整场结算 */
      }
    }
    return got;
  }

  #dropRing(openid, b, cfg) {
    const years = rollRingYears(b.monster_age, cfg);
    const skill = this.#pickSkill(b.monster_id);
    this.db
      .prepare(
        `INSERT INTO pending_ring (openid, monster_id, monster_name, years, skill_id, at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(openid) DO UPDATE SET monster_id=excluded.monster_id, monster_name=excluded.monster_name,
           years=excluded.years, skill_id=excluded.skill_id, at=excluded.at`,
      )
      .run(openid, b.monster_id, b.monster_name, years, skill?.id ?? null, now());
    return { years, skill: skill?.name ?? null, monsterName: b.monster_name };
  }

  #pickSkill(monsterId) {
    const rows = this.content.db
      .prepare(
        `SELECT s.*, ms.weight FROM monster_skill ms JOIN skill s ON s.id = ms.skill_id
          WHERE ms.monster_id = ? AND s.enabled = 1`,
      )
      .all(Number(monsterId));
    if (!rows.length) return null;
    const total = rows.reduce((n, r) => n + Math.max(1, Number(r.weight)), 0);
    let roll = Math.random() * total;
    for (const r of rows) {
      roll -= Math.max(1, Number(r.weight));
      if (roll <= 0) return r;
    }
    return rows[rows.length - 1];
  }

  pendingRing(openid) {
    return this.db.prepare('SELECT * FROM pending_ring WHERE openid = ?').get(String(openid)) ?? null;
  }

  /** 附加魂环：把 pending 的环装上去，并重算属性 */
  attachRing(openid) {
    const pr = this.pendingRing(openid);
    if (!pr) return { error: 'no_pending' };
    const cfg = this.content.allCfg();
    const maxSlot = Math.max(1, Number(cfg.max_ring_slot ?? 10));
    const count = this.players.ringCount(openid);
    if (count >= maxSlot) return { error: 'full', maxSlot };

    const slot = count + 1;
    withTx(this.db, () => {
      this.db
        .prepare('INSERT INTO ring (openid, slot, years, name, skill_id) VALUES (?,?,?,?,?)')
        .run(openid, slot, pr.years, pr.monster_name, pr.skill_id);
      this.db.prepare('DELETE FROM pending_ring WHERE openid = ?').run(openid);
      // 等级上限可能因为多了一个环而放开，这里重算一次经验是否够升级
      this.players.recalc(openid);
    });

    const p = this.players.get(openid);
    // 魂环墙解开后，攒着的经验可能直接够升级
    const expResult = this.players.gainExp(openid, 0);

    return { ring: { slot, years: pr.years, name: pr.monster_name, skillId: pr.skill_id }, player: this.players.get(openid), expResult, before: p };
  }

  /**
   * 复活。
   *
   * **默认免费、只回半血**，花魂币可以满血复活。
   *
   * 早期版本复活固定收 50 魂币，结果新号打怪死一次、身上只有 20 魂币，
   * 就再也复活不了——彻底死锁，只能等运营救。复活不该是一道货币门。
   */
  revive(openid, { full = false } = {}) {
    const p = this.players.get(openid);
    if (!p) return { error: 'no_player' };
    if (p.status !== 'dead') return { error: 'not_dead' };
    const cfg = this.content.allCfg();
    const cost = full ? Math.max(0, Number(cfg.revive_cost_gold ?? 50)) : 0;
    if (full && Number(p.gold) < cost) return { error: 'no_gold', need: cost, have: p.gold };

    const hp = full ? Number(p.hp_max) : Math.max(1, Math.round(Number(p.hp_max) * 0.5));
    withTx(this.db, () => {
      if (cost) this.players.addGold(openid, -cost, '复活（满血）');
      this.db.prepare('UPDATE player SET status = ?, hp = ?, mp = mp_max WHERE openid = ?').run('idle', hp, openid);
      this.db.prepare('DELETE FROM battle WHERE openid = ?').run(openid);
    });
    return { cost, full, hp, player: this.players.get(openid) };
  }

  /** 逃跑 */
  flee(openid) {
    const b = this.current(openid);
    if (!b) return { error: 'no_battle' };
    this.#endBattle(openid, 'idle');
    return { ok: true };
  }

  #endBattle(openid, status) {
    withTx(this.db, () => {
      this.db.prepare('DELETE FROM battle WHERE openid = ?').run(openid);
      this.db.prepare('UPDATE player SET status = ? WHERE openid = ?').run(status, openid);
    });
  }

  /** 战斗统计，给面板用 */
  stats() {
    return {
      active: this.db.prepare("SELECT COUNT(*) AS n FROM battle WHERE state = 'active'").get().n,
      todayKills: this.db.prepare('SELECT COALESCE(SUM(n),0) AS n FROM kill_count').get().n,
      pendingRings: this.db.prepare('SELECT COUNT(*) AS n FROM pending_ring').get().n,
    };
  }
}

export { dayKey };

/**
 * 魂兽年龄档：0 十年 / 1 百年 / 2 千年 / 3 万年 / 4 十万年。
 * 老内容没填暴击闪避时按这个档给默认值，避免「所有怪暴击率都是 0」。
 */
function ageBand(age) {
  const a = Number(age) || 0;
  if (a >= 100000) return 4;
  if (a >= 10000) return 3;
  if (a >= 1000) return 2;
  if (a >= 100) return 1;
  return 0;
}

/**
 * 组织与领地
 * ==========
 *
 * 归并：势力、帝国、宗门、家族本质都是「一个玩家团体 + 成员身份」。
 * 同类插件按世界观给每个名字各开一套表；这里只有 guild + guild_member，
 * 差别靠 `level`（层级）和 `name`（自己起的名）体现。
 *
 * 领地是 guild 的延伸：一张 `territory` 表按 map_id 记录谁占着、产出多少。
 */
import { withTx } from './player.js';
import { simulateFight } from '../engine/balance.js';
import { resolveRound } from '../engine/battle.js';

const now = () => Date.now();

export class GuildRepo {
  constructor(game, content, players, balance) {
    this.db = game;
    this.content = content;
    this.players = players;
    this.balance = balance;
  }

  #cfg() {
    return this.content.allCfg();
  }

  /** 我在哪个宗门 */
  of(openid) {
    const m = this.db.prepare('SELECT * FROM guild_member WHERE openid = ?').get(String(openid));
    if (!m) return null;
    const g = this.db.prepare('SELECT * FROM guild WHERE id = ?').get(m.guild_id);
    return g ? { ...g, myRank: m.rank, joinedAt: m.joined_at } : null;
  }

  byName(name) {
    return this.db.prepare('SELECT * FROM guild WHERE name = ?').get(String(name ?? '').trim()) ?? null;
  }

  members(guildId) {
    return this.db
      .prepare('SELECT * FROM guild_member WHERE guild_id = ? ORDER BY CASE rank WHEN \'leader\' THEN 0 WHEN \'elder\' THEN 1 ELSE 2 END, joined_at')
      .all(Number(guildId))
      .map((m) => {
        const p = this.players.get(m.openid);
        return { ...m, name: p?.name ?? '（已注销）', level: p?.level ?? 0 };
      });
  }

  create(openid, name) {
    const n = String(name ?? '').trim();
    if (n.length < 2 || n.length > 10) return { error: 'bad_name' };
    if (this.of(openid)) return { error: 'in_guild' };
    if (this.byName(n)) return { error: 'name_taken', name: n };

    const cfg = this.#cfg();
    const cost = Math.max(0, Number(cfg.guild_create_cost ?? 1000));
    const p = this.players.get(openid);
    if (Number(p.gold) < cost) return { error: 'no_gold', need: cost, have: Number(p.gold) };

    withTx(this.db, () => {
      this.players.addGold(openid, -cost, `创建宗门 ${n}`);
      const r = this.db
        .prepare('INSERT INTO guild (name, leader, level, funds, created_at) VALUES (?,?,1,0,?)')
        .run(n, openid, now());
      this.db
        .prepare("INSERT INTO guild_member (openid, guild_id, rank, joined_at) VALUES (?,?,'leader',?)")
        .run(openid, Number(r.lastInsertRowid), now());
    });
    return { ok: true, guild: this.of(openid), cost };
  }

  join(openid, name) {
    if (this.of(openid)) return { error: 'in_guild' };
    const g = this.byName(name);
    if (!g) return { error: 'no_guild', name };
    const cfg = this.#cfg();
    const max = Math.max(1, Number(cfg.guild_max_members ?? 30));
    const n = this.db.prepare('SELECT COUNT(*) c FROM guild_member WHERE guild_id = ?').get(g.id).c;
    if (n >= max) return { error: 'full', max };
    this.db
      .prepare("INSERT INTO guild_member (openid, guild_id, rank, joined_at) VALUES (?,?,'member',?)")
      .run(openid, g.id, now());
    return { ok: true, guild: this.of(openid) };
  }

  leave(openid) {
    const g = this.of(openid);
    if (!g) return { error: 'not_in_guild' };
    if (g.myRank === 'leader') {
      const n = this.db.prepare('SELECT COUNT(*) c FROM guild_member WHERE guild_id = ?').get(g.id).c;
      if (n > 1) return { error: 'leader_must_transfer' };
      // 只剩自己：解散
      withTx(this.db, () => {
        this.db.prepare('DELETE FROM guild_member WHERE guild_id = ?').run(g.id);
        this.db.prepare('DELETE FROM guild WHERE id = ?').run(g.id);
        this.db.prepare('UPDATE territory SET guild_id = 0 WHERE guild_id = ?').run(g.id);
      });
      return { ok: true, disbanded: true, name: g.name };
    }
    this.db.prepare('DELETE FROM guild_member WHERE openid = ?').run(openid);
    return { ok: true, name: g.name };
  }

  /** 捐魂币进宗门资金 */
  contribute(openid, amount) {
    const g = this.of(openid);
    if (!g) return { error: 'not_in_guild' };
    const n = Math.trunc(Number(amount) || 0);
    if (n <= 0) return { error: 'bad_amount' };
    const p = this.players.get(openid);
    if (Number(p.gold) < n) return { error: 'no_gold', have: Number(p.gold) };
    withTx(this.db, () => {
      this.players.addGold(openid, -n, `捐给宗门 ${g.name}`);
      this.db.prepare('UPDATE guild SET funds = funds + ? WHERE id = ?').run(n, g.id);
    });
    return { ok: true, funds: Number(g.funds) + n };
  }

  /**
   * 宗门升级：花宗门资金换等级，等级给**全体成员**全属性加成。
   *
   * 之前宗门等级是个永远不动的装饰字段，除了挖矿没有任何长期目标。
   * 现在它是「集体投资 → 全员受益」的循环：捐钱 → 升级 → 大家变强。
   */
  upgrade(openid) {
    const g = this.of(openid);
    if (!g) return { error: 'not_in_guild' };
    if (g.myRank !== 'leader') return { error: 'not_leader' };
    const cfg = this.#cfg();
    const max = Math.max(1, Number(cfg.guild_max_level ?? 10));
    if (Number(g.level) >= max) return { error: 'maxed', max };
    const cost = Math.round(Number(cfg.guild_upgrade_base ?? 1000) * Math.pow(Number(g.level), 2));
    if (Number(g.funds) < cost) return { error: 'no_funds', need: cost, have: Number(g.funds) };

    withTx(this.db, () => {
      this.db.prepare('UPDATE guild SET funds = funds - ?, level = level + 1 WHERE id = ?').run(cost, g.id);
    });

    // 等级变了，全员属性要重算（加成走 mult 乘区）
    const members = this.members(g.id);
    for (const m of members) this.players.recalc(m.openid);

    return {
      ok: true,
      name: g.name,
      level: Number(g.level) + 1,
      cost,
      pct: Number(cfg.guild_level_bonus ?? 0.02) * (Number(g.level) + 1),
      members: members.length,
    };
  }

  /* ---------------- 宗门战 / 领地争夺 ---------------- */

  /**
   * 宣战。
   *
   * 为什么要「先宣战」而不是直接抢：直接抢等于强者无成本碾压，
   * 小宗门连反应的机会都没有。宣战要花钱、有 24 小时窗口，
   * 守方有时间反应（升级宗门、加固守卫），这才是「战」。
   */
  declareWar(openid, targetName) {
    const g = this.of(openid);
    if (!g) return { error: 'not_in_guild' };
    if (g.myRank !== 'leader') return { error: 'not_leader' };
    const t = this.byName(targetName);
    if (!t) return { error: 'no_guild', name: targetName };
    if (t.id === g.id) return { error: 'self' };

    const cfg = this.#cfg();
    const cost = Math.max(0, Number(cfg.war_declare_cost ?? 2000));
    if (Number(g.funds) < cost) return { error: 'no_funds', need: cost, have: Number(g.funds) };

    const hours = Math.max(1, Number(cfg.war_hours ?? 24));
    const exist = this.warWith(g.id, t.id);
    if (exist) return { error: 'already', name: t.name, until: exist.expires_at };

    withTx(this.db, () => {
      this.db.prepare('UPDATE guild SET funds = funds - ? WHERE id = ?').run(cost, g.id);
      this.db
        .prepare('INSERT INTO guild_war (guild_id, target_guild_id, declared_at, expires_at) VALUES (?,?,?,?)')
        .run(g.id, t.id, now(), now() + hours * 3600_000);
    });
    return { ok: true, target: t, cost, hours };
  }

  /** 我对某个宗门还有效的宣战记录 */
  warWith(guildId, targetId) {
    return (
      this.db
        .prepare(
          'SELECT * FROM guild_war WHERE guild_id = ? AND target_guild_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1',
        )
        .get(Number(guildId), Number(targetId), now()) ?? null
    );
  }

  /** 我发出的所有有效宣战 */
  myWars(openid) {
    const g = this.of(openid);
    if (!g) return [];
    return this.db
      .prepare('SELECT * FROM guild_war WHERE guild_id = ? AND expires_at > ? ORDER BY expires_at DESC')
      .all(g.id, now())
      .map((w) => ({ ...w, targetName: this.db.prepare('SELECT name FROM guild WHERE id = ?').get(w.target_guild_id)?.name ?? '???' }));
  }

  /** 守卫强度：占领方宗门等级 + 占领时长，上限由配置挡着 */
  guardDefense(t) {
    const cfg = this.#cfg();
    const base = Math.max(1, Number(cfg.guard_defense_base ?? 100));
    const max = Math.max(base, Number(cfg.guard_max_defense ?? 400));
    if (!Number(t.guild_id)) return base; // 无主：基础守卫
    const holder = this.db.prepare('SELECT level FROM guild WHERE id = ?').get(t.guild_id);
    const lvBonus = 1 + Number(cfg.guard_level_bonus ?? 0.15) * Number(holder?.level ?? 1);
    const hours = Math.max(0, (now() - Number(t.occupied_at || now())) / 3600_000);
    const timeBonus = 1 + Number(cfg.guard_time_bonus ?? 0.02) * hours;
    return Math.min(max, Math.round(base * lvBonus * timeBonus));
  }

  /**
   * 抢夺领地：打守卫，赢则易主。
   *
   * 守卫用 `monsterStats` 现算，所以和普通战斗同一套数值——
   * 不会出现「领地守卫」比同等级魂兽强十倍这种失控。
   */
  raid(openid, mapName) {
    const g = this.of(openid);
    if (!g) return { error: 'not_in_guild' };
    if (g.myRank !== 'leader') return { error: 'not_leader' };
    const map = this.content.db.prepare('SELECT * FROM map WHERE name = ? AND enabled = 1').get(String(mapName ?? '').trim());
    if (!map) return { error: 'no_map', name: mapName };
    const def = this.content.db.prepare('SELECT * FROM territory_def WHERE map_id = ?').get(map.id);
    if (!def) return { error: 'no_territory', name: map.name };

    const t = this.db.prepare('SELECT * FROM territory WHERE map_id = ?').get(map.id);
    const holder = Number(t?.guild_id ?? 0);
    if (holder === g.id) return { error: 'already_ours', name: map.name };
    // 有主才需要宣战；无主直接占
    if (holder) {
      const war = this.warWith(g.id, holder);
      if (!war) {
        const holderName = this.db.prepare('SELECT name FROM guild WHERE id = ?').get(holder)?.name ?? '对方';
        return { error: 'no_war', name: map.name, holder: holderName };
      }
    }

    const p = this.players.get(openid);
    if (!p || p.status === 'dead') return { error: 'dead' };
    const defense = this.guardDefense(t ?? { guild_id: holder, occupied_at: now() });
    const cfg = this.#cfg();
    const guard = {
      name: `${map.name} 守卫`,
      // 守卫强度换算成一个「年龄」，让 monsterStats 生成对应属性
      age: Math.max(10, defense * 120),
      target_rounds: Math.max(2, Number(cfg.guard_base_rounds ?? 6)),
      tier: 'elite',
      def_bias: 1.1,
      atk_bias: 1.1,
    };
    const stats = this.balance.monsterStats(guard);
    const res = simulateFight({ player: p, monster: stats, cfg, resolveRound, maxRounds: 40 });

    this.db.prepare('UPDATE player SET hp = ? WHERE openid = ?').run(Math.max(0, res.hpLeft), openid);

    if (!res.win) {
      // 守方守住：给守方一点资金，守卫更强（下次更难抢）
      if (holder) {
        const reward = Math.max(0, Number(cfg.raid_lose_fund ?? 300));
        this.db.prepare('UPDATE guild SET funds = funds + ? WHERE id = ?').run(reward, holder);
        this.db.prepare('UPDATE territory SET defense = MIN(?, defense + 10) WHERE map_id = ?').run(
          Number(cfg.guard_max_defense ?? 400),
          map.id,
        );
      }
      this.db.prepare("UPDATE player SET status = 'dead' WHERE openid = ?").run(openid);
      return { ok: true, win: false, map: map.name, defense, rounds: res.rounds, holder };
    }

    // 抢下来了
    const newDefense = Math.max(1, Math.round(Number(cfg.guard_defense_base ?? 100) * (1 + Number(cfg.guard_level_bonus ?? 0.15) * Number(g.level))));
    withTx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO territory (map_id, guild_id, occupied_at, last_mine_at, defense) VALUES (?,?,?,?,?)
           ON CONFLICT(map_id) DO UPDATE SET guild_id = excluded.guild_id,
             occupied_at = excluded.occupied_at, last_mine_at = excluded.last_mine_at, defense = excluded.defense`,
        )
        .run(map.id, g.id, now(), now(), newDefense);
    });
    return { ok: true, win: true, map: map.name, defense, newDefense, rounds: res.rounds, from: holder, player: this.players.get(openid) };
  }

  /* ---------------- 领地 ---------------- */

  /** 所有可占领领地（配置来自 content，归属来自 game） */
  territories() {
    const defs = this.content.db.prepare('SELECT * FROM territory_def ORDER BY map_id').all();
    const states = new Map(this.db.prepare('SELECT * FROM territory').all().map((t) => [t.map_id, t]));
    return defs.map((d) => {
      const st = states.get(d.map_id) ?? { guild_id: 0, occupied_at: 0, last_mine_at: 0, defense: 0 };
      const map = this.content.db.prepare('SELECT name FROM map WHERE id = ?').get(d.map_id);
      const guild = st.guild_id ? this.db.prepare('SELECT name, level FROM guild WHERE id = ?').get(st.guild_id) : null;
      return {
        ...d,
        ...st,
        mapName: map?.name ?? `#${d.map_id}`,
        guildName: guild?.name ?? '无主',
        holderLevel: guild?.level ?? 0,
        defense: st.guild_id ? this.guardDefense(st) : this.guardDefense({ guild_id: 0, occupied_at: now() }),
      };
    });
  }

  /** 占领：只有宗主能占，要花宗门资金（只能占无主的，有主的要「抢夺」） */
  occupy(openid, mapName) {
    const g = this.of(openid);
    if (!g) return { error: 'not_in_guild' };
    if (g.myRank !== 'leader') return { error: 'not_leader' };
    const map = this.content.db.prepare('SELECT * FROM map WHERE name = ? AND enabled = 1').get(String(mapName ?? '').trim());
    if (!map) return { error: 'no_map', name: mapName };
    const def = this.content.db.prepare('SELECT * FROM territory_def WHERE map_id = ?').get(map.id);
    if (!def) return { error: 'no_territory', name: map.name };
    const st = this.db.prepare('SELECT * FROM territory WHERE map_id = ?').get(map.id);
    if (Number(st?.guild_id) === g.id) return { error: 'already_ours', name: map.name };
    // 有主的地盘必须先宣战再抢，不能直接占
    if (Number(st?.guild_id)) {
      const holder = this.db.prepare('SELECT name FROM guild WHERE id = ?').get(st.guild_id);
      return { error: 'occupied', name: map.name, holder: holder?.name ?? '别的宗门' };
    }

    const cfg = this.#cfg();
    const cost = Math.max(0, Number(cfg.occupy_cost ?? 500));
    if (Number(g.funds) < cost) return { error: 'no_funds', need: cost, have: Number(g.funds) };
    const defense = Math.max(1, Math.round(Number(cfg.guard_defense_base ?? 100) * (1 + Number(cfg.guard_level_bonus ?? 0.15) * Number(g.level))));

    withTx(this.db, () => {
      this.db.prepare('UPDATE guild SET funds = funds - ? WHERE id = ?').run(cost, g.id);
      this.db
        .prepare(
          `INSERT INTO territory (map_id, guild_id, occupied_at, last_mine_at, defense) VALUES (?,?,?,?,?)
           ON CONFLICT(map_id) DO UPDATE SET guild_id = excluded.guild_id,
             occupied_at = excluded.occupied_at, last_mine_at = excluded.last_mine_at, defense = excluded.defense`,
        )
        .run(map.id, g.id, now(), now(), defense);
    });
    return { ok: true, map: map.name, cost, defense };
  }

  /**
   * 收工（领地产出）。
   *
   * 和早期 `挖矿` 的区别：
   *   1. 有**每人每天次数上限**——不然一个人能把宗门产出全收走
   *   2. 收益按**宗门等级**加成——宗门升级才有实际回报
   */
  collect(openid) {
    const g = this.of(openid);
    if (!g) return { error: 'not_in_guild' };
    const rows = this.db.prepare('SELECT * FROM territory WHERE guild_id = ?').all(g.id);
    if (!rows.length) return { error: 'no_territory' };

    const cfg = this.#cfg();
    const day = new Date().toISOString().slice(0, 10);
    const limit = Math.max(0, Number(cfg.collect_daily_limit ?? 3));
    const used = Number(
      this.db.prepare('SELECT count FROM territory_collect WHERE openid = ? AND day = ?').get(String(openid), day)?.count ?? 0,
    );
    if (limit && used >= limit) return { error: 'daily_limit', limit };

    const capHours = Math.max(1, Number(cfg.mine_cap_hours ?? 12));
    const hourMs = 3600_000;
    const bonus = 1 + Math.max(0, Number(cfg.collect_guild_bonus ?? 0.1)) * Number(g.level);

    let gold = 0;
    const items = [];
    withTx(this.db, () => {
      for (const t of rows) {
        const def = this.content.db.prepare('SELECT * FROM territory_def WHERE map_id = ?').get(t.map_id);
        if (!def) continue;
        const elapsed = Math.min(capHours * hourMs, now() - Number(t.last_mine_at || now()));
        const hours = Math.floor(elapsed / hourMs);
        if (hours <= 0) continue;
        gold += Math.round(Number(def.mine_gold) * hours * bonus);
        if (def.mine_item_id && def.mine_item_qty) {
          items.push({ id: def.mine_item_id, qty: Math.round(Number(def.mine_item_qty) * hours * bonus) });
        }
        this.db.prepare('UPDATE territory SET last_mine_at = last_mine_at + ? WHERE map_id = ?').run(hours * hourMs, t.map_id);
      }
      if (gold) this.players.addGold(openid, gold, `领地收工（${g.name}）`);
      for (const it of items) this.players.addItem(openid, it.id, it.qty, `领地收工（${g.name}）`);
      this.db
        .prepare(
          `INSERT INTO territory_collect (openid, day, count) VALUES (?,?,1)
           ON CONFLICT(openid, day) DO UPDATE SET count = count + 1`,
        )
        .run(String(openid), day);
    });

    return { ok: true, gold, items, guild: g, bonus, used: used + 1, limit };
  }
}

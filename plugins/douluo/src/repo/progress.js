/**
 * 进度类系统：排行榜 / 挑战 / 斗天（战令）
 * ======================================
 *
 * 归并思路：
 *   - **排行榜**：13 个榜本质是「同一张 player 表，不同 ORDER BY」。
 *     所以只有一张 `rank_def`，加榜只加一行，不改代码。
 *   - **万兽台 / 深渊 / 世界BOSS / 神位**：本质都是「有层数、有每日次数、有奖励的 PVE」。
 *     所以只有一张 `challenge`，用 `kind` 区分。
 *   - **斗天（战令）**：积分 + 档位 + 领取，一张 `season_point`。
 */
import { simulateFight } from '../engine/balance.js';
import { resolveRound } from '../engine/battle.js';

const now = () => Date.now();
const today = () => new Date().toISOString().slice(0, 10);

export class ProgressRepo {
  constructor(game, content, players, balance, economy, mail) {
    this.db = game;
    this.content = content;
    this.players = players;
    this.balance = balance;
    this.economy = economy;
    this.mail = mail;
  }

  #cfg() {
    return this.content.allCfg();
  }

  /* ================= 排行榜 ================= */

  ranks() {
    return this.content.db.prepare('SELECT * FROM rank_def WHERE enabled = 1 ORDER BY key').all();
  }

  /**
   * 查榜。
   *
   * `order_by` 来自内容表（运营可改），所以只允许字母/下划线/逗号/空格/ASC/DESC，
   * 挡住注入。这是「内容可编辑」必须付的安全成本。
   */
  rank(key, limit = 10) {
    const def = this.content.db.prepare('SELECT * FROM rank_def WHERE key = ? AND enabled = 1').get(String(key));
    if (!def) return null;
    if (!/^[A-Za-z_][A-Za-z0-9_ ,]*(ASC|DESC)[A-Za-z0-9_ ,]*$/i.test(def.order_by.trim())) {
      return { ...def, rows: [], error: '排序表达式不合法' };
    }
    const rows = this.db
      .prepare(`SELECT * FROM player ORDER BY ${def.order_by} LIMIT ?`)
      .all(Math.min(50, Math.max(1, Number(limit) || 10)));
    return { ...def, rows };
  }

  /* ================= 挑战（万兽台/深渊/世界BOSS/神位） ================= */

  challenges() {
    return this.content.db.prepare('SELECT * FROM challenge WHERE enabled = 1 ORDER BY id').all();
  }

  #challengeByName(name) {
    const n = String(name ?? '').trim();
    return this.challenges().find((c) => c.name === n) ?? this.challenges().find((c) => c.name.includes(n) || n.includes(c.name)) ?? null;
  }

  progress(openid, challengeId) {
    let row = this.db
      .prepare('SELECT * FROM challenge_progress WHERE openid = ? AND challenge_id = ?')
      .get(String(openid), Number(challengeId));
    if (!row) {
      this.db
        .prepare('INSERT INTO challenge_progress (openid, challenge_id, depth, daily_count, last_day) VALUES (?,?,0,0,?)')
        .run(String(openid), Number(challengeId), today());
      row = this.db
        .prepare('SELECT * FROM challenge_progress WHERE openid = ? AND challenge_id = ?')
        .get(String(openid), Number(challengeId));
    }
    // 跨天重置次数
    if (row.last_day !== today()) {
      this.db
        .prepare('UPDATE challenge_progress SET daily_count = 0, last_day = ? WHERE openid = ? AND challenge_id = ?')
        .run(today(), String(openid), Number(challengeId));
      row.daily_count = 0;
      row.last_day = today();
    }
    return row;
  }

  /** 某层的配置（名字/是否守关/奖励），没配返回 null */
  floorOf(challengeId, floor) {
    return (
      this.content.db
        .prepare('SELECT * FROM challenge_floor WHERE challenge_id = ? AND floor = ?')
        .get(Number(challengeId), Number(floor)) ?? null
    );
  }

  /** 某个挑战的全部层（给玩家看进度用） */
  floors(challengeId) {
    return this.content.db
      .prepare('SELECT * FROM challenge_floor WHERE challenge_id = ? ORDER BY floor')
      .all(Number(challengeId));
  }

  /** 已首通的层 */
  clearedFloors(openid, challengeId) {
    return new Set(
      this.db
        .prepare('SELECT floor FROM challenge_clear WHERE openid = ? AND challenge_id = ?')
        .all(String(openid), Number(challengeId))
        .map((r) => Number(r.floor)),
    );
  }

  /** 按层数生成对手（复用怪物生成，保证和普通战斗同一套数值） */
  #depthMonster(ch, depth, floor = null) {
    if (Number(ch.monster_id)) {
      const m = this.content.db.prepare('SELECT * FROM monster WHERE id = ?').get(Number(ch.monster_id));
      if (m) return m;
    }
    // 没有指定怪：按层数推一个年龄，越深越老；守关层再拔高一档
    const isBoss = Number(floor?.is_boss) === 1;
    const base = 10 * Math.pow(1.55, Math.max(0, depth - 1)) * (isBoss ? 1.35 : 1);
    return {
      name: floor?.name ? `${ch.name} · ${floor.name}` : `${ch.name} 第${depth}层`,
      age: Math.round(base),
      target_rounds: (4 + Math.floor(depth / 4)) + (isBoss ? 3 : 0),
      tier: isBoss ? 'boss' : 'normal',
      def_bias: isBoss ? 1.15 : 1,
      atk_bias: isBoss ? 1.15 : 1,
    };
  }

  /**
   * 打一层。用 `simulateFight` 一次性结算（爬塔不适合一条一条发消息）。
   * 赢了才推进层数，输了保持原层。
   */
  fight(openid, name) {
    const p = this.players.get(openid);
    if (!p) return { error: 'no_player' };
    if (p.status === 'dead') return { error: 'dead' };
    const ch = this.#challengeByName(name);
    if (!ch) return { error: 'no_challenge', name };
    if (Number(p.level) < Number(ch.level_req)) return { error: 'level', need: Number(ch.level_req), have: Number(p.level) };

    const prog = this.progress(openid, ch.id);
    const limit = Math.max(0, Number(ch.daily_limit ?? 3));
    if (limit && Number(prog.daily_count) >= limit) return { error: 'daily_limit', limit };

    const depth = Math.min(Number(ch.max_depth), Number(prog.depth) + 1);
    const floor = this.floorOf(ch.id, depth);
    const monster = this.#depthMonster(ch, depth, floor);
    const stats = this.balance.monsterStats(monster);
    const cfg = this.#cfg();
    const res = simulateFight({ player: p, monster: stats, cfg, resolveRound, maxRounds: 60 });

    // 世界BOSS：扣共享血量
    let bossLeft = null;
    if (ch.kind === 'boss') {
      const wb = this.#bossRow(ch.id, stats.hp);
      const dmg = Math.min(Number(wb.hp), Math.max(1, stats.hp - Number(res.hpLeft ?? 0)) + Math.round(Number(p.atk) * 3));
      this.db.prepare('UPDATE world_boss SET hp = MAX(0, hp - ?) WHERE id = ?').run(dmg, ch.id);
      bossLeft = Math.max(0, Number(wb.hp) - dmg);
    }

    this.db
      .prepare('UPDATE challenge_progress SET daily_count = daily_count + 1, depth = ? WHERE openid = ? AND challenge_id = ?')
      .run(res.win ? Math.min(Number(ch.max_depth), depth) : Number(prog.depth), String(openid), ch.id);
    this.db
      .prepare('UPDATE player SET hp = ?, last_seen = ? WHERE openid = ?')
      .run(Math.max(0, Number(res.hpLeft ?? 0)), now(), String(openid));

    let reward = null;
    let firstClear = null;
    if (res.win) {
      // 层配置优先（每层自己的奖励），没配就退回挑战的默认奖励
      reward = floor ? safeJson(floor.reward) : safeJson(ch.reward);
      const scale = ch.kind === 'tower' ? 1 + (depth - 1) * 0.15 : 1;
      try {
        this.economy.trade(String(openid), {
          gain: {
            gold: Math.round(Number(reward.gold ?? 0) * scale),
            exp: 0,
            items: (reward.items ?? []).map((it) => ({ id: Number(it.id), qty: Math.round(Number(it.qty ?? 1) * scale) })),
          },
          reason: `${ch.name} 第${depth}层 ${floor?.name ?? ''}`.trim(),
        });
      } catch {
        /* 奖励发不出去不影响战斗结果 */
      }
      if (reward.exp) this.players.gainExp(String(openid), Math.round(Number(reward.exp) * scale));
      this.addPoints(openid, floor?.is_boss ? 60 : ch.kind === 'boss' ? 50 : 20);

      // 首通：第一次打通这一层，额外给一份「守关奖励」
      if (floor && Number(floor.is_boss) === 1) {
        const done = this.db
          .prepare('SELECT 1 AS ok FROM challenge_clear WHERE openid = ? AND challenge_id = ? AND floor = ?')
          .get(String(openid), ch.id, depth);
        if (!done) {
          const fc = safeJson(floor.first_clear);
          firstClear = fc;
          try {
            this.economy.trade(String(openid), {
              gain: {
                gold: Number(fc.gold ?? 0),
                coupon: Number(fc.coupon ?? 0),
                items: Array.isArray(fc.items) ? fc.items : [],
                equips: Array.isArray(fc.equips) ? fc.equips : [],
                companions: Array.isArray(fc.companions) ? fc.companions : [],
              },
              reason: `首通 ${ch.name} 第${depth}层 ${floor.name}`,
            });
            if (Array.isArray(fc.gems)) {
              for (const gid of fc.gems) {
                const gem = this.content.db.prepare('SELECT name FROM gem WHERE id = ?').get(Number(gid));
                if (gem) {
                  this.db
                    .prepare(
                      `INSERT INTO gem_owned (openid, gem_id, qty) VALUES (?,?,1)
                       ON CONFLICT(openid, gem_id) DO UPDATE SET qty = qty + 1`,
                    )
                    .run(String(openid), Number(gid));
                }
              }
            }
            this.db
              .prepare('INSERT OR IGNORE INTO challenge_clear (openid, challenge_id, floor, at) VALUES (?,?,?,?)')
              .run(String(openid), ch.id, depth, now());
          } catch {
            firstClear = null;
          }
        }
      }
    } else {
      this.db.prepare('UPDATE player SET status = ? WHERE openid = ?').run('dead', String(openid));
    }

    return {
      ok: true,
      challenge: ch,
      floor,
      depth,
      firstClear,
      win: res.win,
      rounds: res.rounds,
      hpLeft: res.hpLeft,
      monster,
      stats,
      reward,
      bossLeft,
      player: this.players.get(openid),
    };
  }

  #bossRow(id, maxHp) {
    let wb = this.db.prepare('SELECT * FROM world_boss WHERE id = ?').get(Number(id));
    if (!wb || wb.day !== today()) {
      this.db
        .prepare(
          `INSERT INTO world_boss (id, hp, max_hp, day, spawned_at) VALUES (?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET hp = excluded.hp, max_hp = excluded.max_hp, day = excluded.day, spawned_at = excluded.spawned_at`,
        )
        .run(Number(id), maxHp * 50, maxHp * 50, today(), now());
      wb = this.db.prepare('SELECT * FROM world_boss WHERE id = ?').get(Number(id));
    }
    return wb;
  }

  bossState(challengeId) {
    const ch = this.content.db.prepare('SELECT * FROM challenge WHERE id = ?').get(Number(challengeId));
    const stats = ch ? this.balance.monsterStats(this.#depthMonster(ch, 1)) : null;
    const wb = ch ? this.#bossRow(ch.id, stats?.hp ?? 1000) : null;
    return wb ? { hp: wb.hp, maxHp: wb.max_hp, day: wb.day } : null;
  }

  /* ================= 每日悬赏 ================= */

  /**
   * 每日悬赏：每天 3 个击杀目标，按「玩家 + 日期」确定性生成。
   *
   * 为什么不用真随机：同一天退出再进应该是同一批悬赏，
   * 否则玩家可以反复刷出「离自己最近的怪」。
   *
   * 为什么记 `base`：如果只看累计击杀，老玩家一上线就自动完成——
   * 记下生成时的击杀数，要求**新增** N 只才算完成。
   */
  dailyBounties(openid) {
    const day = today();
    const p = this.players.get(openid);
    if (!p) return [];
    let rows = this.db.prepare('SELECT * FROM bounty WHERE openid = ? AND day = ?').all(String(openid), day);
    if (!rows.length) {
      // 挑离自己等级最近的 10 只怪当候选池
      const pool = this.content.db
        .prepare('SELECT id, name, age FROM monster WHERE enabled = 1 ORDER BY ABS(age - ?) ASC LIMIT 10')
        .all(Math.max(10, Math.pow(Math.max(1, Number(p.level)) / 2, 2) * 14));
      if (!pool.length) return [];
      const seed = hash(String(openid) + day);
      const picked = [];
      for (let i = 0; i < 3 && pool.length; i += 1) {
        const cand = pool[(seed + i * 7) % pool.length];
        if (!picked.some((x) => x.id === cand.id)) picked.push(cand);
      }
      for (const m of picked) {
        const base = Number(
          this.db.prepare('SELECT n FROM kill_count WHERE openid = ? AND monster_id = ?').get(String(openid), m.id)?.n ?? 0,
        );
        this.db
          .prepare('INSERT OR IGNORE INTO bounty (openid, day, monster_id, target, claimed, base) VALUES (?,?,?,?,0,?)')
          .run(String(openid), day, m.id, 3, base);
      }
      rows = this.db.prepare('SELECT * FROM bounty WHERE openid = ? AND day = ?').all(String(openid), day);
    }
    return rows.map((r) => {
      const m = this.content.db.prepare('SELECT name, age FROM monster WHERE id = ?').get(r.monster_id);
      const now = Number(
        this.db.prepare('SELECT n FROM kill_count WHERE openid = ? AND monster_id = ?').get(String(openid), r.monster_id)?.n ?? 0,
      );
      const progress = Math.max(0, now - Number(r.base ?? 0));
      return {
        ...r,
        name: m?.name ?? `#${r.monster_id}`,
        progress: Math.min(Number(r.target), progress),
        done: progress >= Number(r.target),
        reward: { gold: Math.round(Number(p.level) * 40), points: 20 },
      };
    });
  }

  /** 交悬赏：把所有已完成的一次性结算 */
  claimBounties(openid) {
    const list = this.dailyBounties(openid).filter((b) => b.done && !Number(b.claimed));
    if (!list.length) return { ok: true, count: 0, gold: 0, points: 0 };
    let gold = 0;
    let points = 0;
    for (const b of list) {
      try {
        this.economy.trade(String(openid), { gain: { gold: b.reward.gold }, reason: `悬赏 ${b.name}` });
      } catch {
        continue;
      }
      this.db.prepare('UPDATE bounty SET claimed = 1 WHERE openid = ? AND day = ? AND monster_id = ?').run(
        String(openid),
        b.day,
        b.monster_id,
      );
      gold += b.reward.gold;
      points += b.reward.points;
    }
    if (points) this.addPoints(openid, points);
    return { ok: true, count: list.length, gold, points };
  }

  /* ================= 斗天（战令） ================= */

  seasonNo() {
    const cfg = this.#cfg();
    const days = Math.max(1, Number(cfg.season_days ?? 30));
    return Math.max(1, Math.floor(Date.now() / (days * 86400_000)) % 1000);
  }

  points(openid) {
    const row = this.db
      .prepare('SELECT * FROM season_point WHERE openid = ? AND season = ?')
      .get(String(openid), this.seasonNo());
    return row ?? { openid: String(openid), season: this.seasonNo(), points: 0, claimed: '[]' };
  }

  addPoints(openid, n) {
    const season = this.seasonNo();
    const add = Math.max(0, Math.trunc(Number(n) || 0));
    if (!add) return;
    this.db
      .prepare(
        `INSERT INTO season_point (openid, season, points, claimed) VALUES (?,?,?, '[]')
         ON CONFLICT(openid, season) DO UPDATE SET points = points + ?`,
      )
      .run(String(openid), season, add, add);
  }

  tiers() {
    const cfg = this.#cfg();
    const raw = String(cfg.battlepass_tiers ?? '100,300,600,1000,2000');
    return raw
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
  }

  claimTier(openid, tier) {
    const list = this.tiers();
    const t = Number(tier);
    if (!list.includes(t)) return { error: 'no_tier', tiers: list };
    const row = this.points(openid);
    if (Number(row.points) < t) return { error: 'not_enough', need: t, have: Number(row.points) };
    const claimed = safeJsonArr(row.claimed);
    if (claimed.includes(t)) return { error: 'claimed', tier: t };

    const gold = t * 2;
    const coupon = Math.round(t / 50);
    try {
      this.economy.trade(String(openid), { gain: { gold, coupon }, reason: `斗天 ${t} 分奖励` });
    } catch (e) {
      return { error: 'trade', message: e.message };
    }
    this.db
      .prepare('UPDATE season_point SET claimed = ? WHERE openid = ? AND season = ?')
      .run(JSON.stringify([...claimed, t]), String(openid), this.seasonNo());
    return { ok: true, tier: t, gold, coupon };
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

/** 稳定哈希（同一玩家 + 同一天 → 同一批悬赏） */
function hash(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i += 1) {
    h = (h * 31 + String(str).charCodeAt(i)) % 1_000_003;
  }
  return Math.abs(h);
}

function safeJsonArr(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

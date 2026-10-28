/**
 * 社交与 PVP
 * ==========
 *
 * 归并：好友、情侣、师徒、仇人本质都是「两个玩家之间的一条关系」，
 * 所以只有一张 `relation` 表 + `kind`。同类插件给情侣/师徒各开一套表一套指令。
 *
 * PVP 也是同一个思路：斗魂、PK、排位都是「异步打一场」，
 * 所以只有 `duelResolve()` 一个结算函数 + `duel` 一张记录表 + 玩家身上的 rank_score。
 */
import { duelResolve } from '../engine/battle.js';
import { power } from '../engine/formula.js';

const now = () => Date.now();

/** 关系类型 → 中文与「谁是谁」 */
export const REL_KIND = {
  friend: { label: '好友', mutual: true },
  couple: { label: '情侣', mutual: true },
  master: { label: '师徒', mutual: false }, // 发起方是师父
  enemy: { label: '仇人', mutual: false },
};

export class SocialRepo {
  constructor(game, content, players) {
    this.db = game;
    this.content = content;
    this.players = players;
  }

  #cfg() {
    return this.content.allCfg();
  }

  /** 按昵称找人，返回 { player } 或 { error } */
  findPlayer(name, selfOpenid) {
    const list = this.players.findByName(name);
    if (!list.length) return { error: 'not_found', name };
    if (list.length > 1) return { error: 'ambiguous', name, count: list.length };
    if (list[0].openid === selfOpenid) return { error: 'self', name };
    return { player: list[0] };
  }

  /* ---------------- 关系 ---------------- */

  /**
   * 发起一条关系（对方要确认）。
   * @param {'friend'|'couple'|'master'|'enemy'} kind
   */
  request(openid, targetName, kind) {
    if (!REL_KIND[kind]) return { error: 'bad_kind' };
    const f = this.findPlayer(targetName, openid);
    if (f.error) return f;
    const to = f.player.openid;

    const exist = this.db
      .prepare('SELECT * FROM relation WHERE from_openid = ? AND to_openid = ? AND kind = ?')
      .get(openid, to, kind);
    if (exist && exist.status === 'active') return { error: 'already', name: f.player.name };
    if (exist && exist.status === 'pending') return { error: 'pending', name: f.player.name };

    this.db
      .prepare(
        `INSERT INTO relation (from_openid, to_openid, kind, status, created_at) VALUES (?,?,?,'pending',?)
         ON CONFLICT(from_openid, to_openid, kind) DO UPDATE SET status = 'pending', created_at = excluded.created_at`,
      )
      .run(openid, to, kind, now());
    return { ok: true, target: f.player, kind };
  }

  /** 对方答应：把 pending 改成 active */
  accept(openid, fromName, kind) {
    if (!REL_KIND[kind]) return { error: 'bad_kind' };
    const f = this.findPlayer(fromName, openid);
    if (f.error) return f;
    const row = this.db
      .prepare("SELECT * FROM relation WHERE from_openid = ? AND to_openid = ? AND kind = ? AND status = 'pending'")
      .get(f.player.openid, openid, kind);
    if (!row) return { error: 'no_request', name: f.player.name };
    this.db
      .prepare("UPDATE relation SET status = 'active' WHERE from_openid = ? AND to_openid = ? AND kind = ?")
      .run(f.player.openid, openid, kind);
    return { ok: true, from: f.player, kind };
  }

  /** 解除（任何一方都能解除） */
  end(openid, otherName, kind) {
    if (!REL_KIND[kind]) return { error: 'bad_kind' };
    const f = this.findPlayer(otherName, openid);
    if (f.error) return f;
    const other = f.player.openid;
    const r = this.db
      .prepare(
        `UPDATE relation SET status = 'ended'
          WHERE kind = ? AND status IN ('active','pending')
            AND ((from_openid = ? AND to_openid = ?) OR (from_openid = ? AND to_openid = ?))`,
      )
      .run(kind, openid, other, other, openid);
    if (!r.changes) return { error: 'none', name: f.player.name };
    return { ok: true, target: f.player, kind };
  }

  /** 我的关系总览 */
  relations(openid) {
    const out = { couple: [], master: [], apprentice: [], friend: [], enemy: [], incoming: [] };
    const rows = this.db
      .prepare("SELECT * FROM relation WHERE (from_openid = ? OR to_openid = ?) AND status = 'active'")
      .all(openid, openid);
    for (const r of rows) {
      const otherId = r.from_openid === openid ? r.to_openid : r.from_openid;
      const other = this.players.get(otherId);
      const name = other?.name ?? '（已注销）';
      if (r.kind === 'couple' || r.kind === 'friend' || r.kind === 'enemy') {
        (out[r.kind] ??= []).push(name);
      } else if (r.kind === 'master') {
        // from 是**徒弟**（发起拜师的人），to 是师父
        if (r.from_openid === openid) out.master.push(name);
        else out.apprentice.push(name);
      }
    }
    // 待我确认的请求
    const pend = this.db
      .prepare("SELECT * FROM relation WHERE to_openid = ? AND status = 'pending'")
      .all(openid);
    for (const p of pend) {
      const from = this.players.get(p.from_openid);
      out.incoming.push({ kind: p.kind, label: REL_KIND[p.kind]?.label ?? p.kind, name: from?.name ?? '???' });
    }
    return out;
  }

  /* ---------------- 喊话 ---------------- */

  /** 世界喊话限频：返回还要等多少秒 */
  shoutCooldown(openid) {
    const cfg = this.#cfg();
    const gap = Math.max(0, Number(cfg.shout_cooldown_sec ?? 30)) * 1000;
    const row = this.db.prepare('SELECT at FROM shout_log WHERE openid = ?').get(openid);
    const last = Number(row?.at ?? 0);
    const wait = last + gap - now();
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }

  markShout(openid) {
    this.db
      .prepare('INSERT INTO shout_log (openid, at) VALUES (?,?) ON CONFLICT(openid) DO UPDATE SET at = excluded.at')
      .run(openid, now());
  }

  /* ---------------- PVP ---------------- */

  /** 同地图的其他玩家 */
  nearPlayers(openid, limit = 10) {
    const me = this.players.get(openid);
    if (!me) return [];
    return this.db
      .prepare('SELECT openid, name, level, atk, def, hp_max, rank_score FROM player WHERE map_id = ? AND openid != ? LIMIT ?')
      .all(me.map_id, openid, Math.min(30, limit));
  }

  /**
   * 异步对战：拿对手当前快照打一场。
   * @returns {{ok:true, win:boolean, ...}|{error:string}}
   */
  duel(openid, targetName) {
    const me = this.players.get(openid);
    if (!me) return { error: 'no_player' };
    if (me.status === 'dead') return { error: 'dead' };
    const f = this.findPlayer(targetName, openid);
    if (f.error) return f;
    const foe = f.player;

    const cfg = this.#cfg();

    /**
     * 每日场次上限。
     * 没有这个，两个人可以互相刷分刷到天上去；一个人也能反复打同一个弱号。
     */
    const day = new Date().toISOString().slice(0, 10);
    const limit = Math.max(0, Number(cfg.pvp_daily_limit ?? 10));
    const daily = this.db.prepare('SELECT * FROM duel_daily WHERE openid = ? AND day = ?').get(String(openid), day);
    const used = Number(daily?.wins ?? 0) + Number(daily?.losses ?? 0);
    if (limit && used >= limit) return { error: 'daily_limit', limit };

    const r = duelResolve({ a: me, b: foe, cfg });

    const win = r.winner === 'a';
    const winnerId = win ? openid : foe.openid;
    const baseWin = Math.max(1, Number(cfg.duel_win_score ?? 10));
    const baseLose = Math.max(0, Number(cfg.duel_lose_score ?? 5));

    /**
     * 实力差距衰减：打比自己弱很多的人，赢了也没多少分。
     * 这是防止「高等级反复屠新手刷榜」的关键——否则排行榜只反映谁更闲。
     */
    const pMe = power(me, cfg);
    const pFoe = power(foe, cfg);
    const gap = Math.abs(pMe - pFoe) / Math.max(1, Math.max(pMe, pFoe));
    const damping = Math.max(0, 1 - Math.min(Number(cfg.pvp_score_damping ?? 0.85), gap));
    const winScore = Math.max(1, Math.round(baseWin * damping));
    const loseScore = Math.max(1, Math.round(baseLose * damping));

    this.db.prepare('UPDATE player SET rank_score = MAX(0, rank_score + ?) WHERE openid = ?').run(win ? winScore : -loseScore, openid);
    // 对手是快照，也给他记分（离线也能被挑战，这是异步 PVP 的常规做法）
    this.db.prepare('UPDATE player SET rank_score = MAX(0, rank_score + ?) WHERE openid = ?').run(win ? -loseScore : winScore, foe.openid);
    this.db
      .prepare(
        `INSERT INTO duel_daily (openid, day, wins, losses) VALUES (?,?,?,?)
         ON CONFLICT(openid, day) DO UPDATE SET wins = wins + ?, losses = losses + ?`,
      )
      .run(String(openid), day, win ? 1 : 0, win ? 0 : 1, win ? 1 : 0, win ? 0 : 1);

    this.db
      .prepare(
        `INSERT INTO duel (a_openid, b_openid, winner, a_power, b_power, rounds, log, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(openid, foe.openid, winnerId, power(me, cfg), power(foe, cfg), r.rounds, JSON.stringify(r.events.slice(-8)), now());

    return {
      ok: true,
      win,
      me,
      foe,
      rounds: r.rounds,
      aHp: r.aHp,
      bHp: r.bHp,
      aMax: r.aMax,
      bMax: r.bMax,
      events: r.events,
      scoreDelta: win ? winScore : -loseScore,
    };
  }

  /** 排位榜 */
  rankTop(limit = 10) {
    return this.db
      .prepare('SELECT openid, name, level, rank_score, atk, def, hp_max, mp_max, spd, dodge, crit FROM player ORDER BY rank_score DESC, level DESC LIMIT ?')
      .all(Math.min(50, limit));
  }

  /** 我的对战记录 */
  myDuels(openid, limit = 5) {
    return this.db
      .prepare('SELECT * FROM duel WHERE a_openid = ? OR b_openid = ? ORDER BY id DESC LIMIT ?')
      .all(openid, openid, limit)
      .map((d) => {
        const iAmA = d.a_openid === openid;
        const foeId = iAmA ? d.b_openid : d.a_openid;
        return { ...d, foeName: this.players.get(foeId)?.name ?? '???', win: d.winner === openid };
      });
  }
}

/**
 * 体验类系统：称号 / 签到 / 冥想 / 资料 / 送花 / 约战 / 教程
 * =====================================================
 *
 * 这些系统共同点：**都是围着「玩家这个人」转的，不涉及战斗数值**。
 * 所以归在一起，共用 `player_ext`（寄语/匿名/魅力/副武魂）。
 */
import { power } from '../engine/formula.js';

const now = () => Date.now();
const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

export class QolRepo {
  constructor(game, content, players, economy, social) {
    this.db = game;
    this.content = content;
    this.players = players;
    this.economy = economy;
    this.social = social;
  }

  #cfg() {
    return this.content.allCfg();
  }

  ext(openid) {
    let row = this.db.prepare('SELECT * FROM player_ext WHERE openid = ?').get(String(openid));
    if (!row) {
      this.db.prepare('INSERT INTO player_ext (openid) VALUES (?)').run(String(openid));
      row = this.db.prepare('SELECT * FROM player_ext WHERE openid = ?').get(String(openid));
    }
    return row;
  }

  /* ================= 称号 ================= */

  /**
   * 称号：达到条件自动授予，可佩戴一个。
   * 之前 `称号` 只有 4 条死数据、没有任何获取途径——补上「自动授予」这一环。
   */
  checkTitles(openid) {
    const p = this.players.get(openid);
    if (!p) return [];
    const rings = this.players.ringCount(openid);
    const all = this.content.db.prepare('SELECT * FROM title WHERE enabled = 1').all();
    const owned = new Set(
      this.db.prepare('SELECT title_id FROM player_title WHERE openid = ?').all(String(openid)).map((r) => r.title_id),
    );
    const gained = [];
    for (const t of all) {
      if (owned.has(t.id)) continue;
      const cond = safeJson(t.cond);
      let ok = true;
      if (cond.level && Number(p.level) < Number(cond.level)) ok = false;
      if (cond.ring && rings < Number(cond.ring)) ok = false;
      if (cond.gold && Number(p.gold) < Number(cond.gold)) ok = false;
      if (cond.kill) {
        const n = this.db.prepare('SELECT COALESCE(SUM(n),0) n FROM kill_count WHERE openid = ?').get(String(openid)).n;
        if (Number(n) < Number(cond.kill)) ok = false;
      }
      if (!ok) continue;
      this.db.prepare('INSERT INTO player_title (openid, title_id, worn, got_at) VALUES (?,?,0,?)').run(String(openid), t.id, now());
      gained.push(t);
    }
    return gained;
  }

  titles(openid) {
    this.checkTitles(openid);
    const all = this.content.db.prepare('SELECT * FROM title WHERE enabled = 1 ORDER BY id').all();
    const owned = new Map(
      this.db.prepare('SELECT * FROM player_title WHERE openid = ?').all(String(openid)).map((r) => [r.title_id, r]),
    );
    return all.map((t) => ({ ...t, owned: owned.has(t.id), worn: Number(owned.get(t.id)?.worn ?? 0) === 1 }));
  }

  wearTitle(openid, name) {
    this.checkTitles(openid);
    const t = this.content.db.prepare('SELECT * FROM title WHERE name = ? AND enabled = 1').get(String(name ?? '').trim());
    if (!t) return { error: 'no_title', name };
    const has = this.db.prepare('SELECT 1 AS ok FROM player_title WHERE openid = ? AND title_id = ?').get(String(openid), t.id);
    if (!has) return { error: 'not_owned', name: t.name };
    this.db.prepare('UPDATE player_title SET worn = 0 WHERE openid = ?').run(String(openid));
    this.db.prepare('UPDATE player_title SET worn = 1 WHERE openid = ? AND title_id = ?').run(String(openid), t.id);
    return { ok: true, title: t };
  }

  unwearTitle(openid) {
    const r = this.db.prepare('UPDATE player_title SET worn = 0 WHERE openid = ? AND worn = 1').run(String(openid));
    return { ok: true, changes: r.changes };
  }

  /**
   * 佩戴中的称号名。
   * `player_title` 在游戏库、`title` 在内容库，**不能 JOIN**，只能分两步查。
   */
  wornTitle(openid) {
    const row = this.db
      .prepare('SELECT title_id FROM player_title WHERE openid = ? AND worn = 1')
      .get(String(openid));
    if (!row) return null;
    return this.content.db.prepare('SELECT name FROM title WHERE id = ?').get(row.title_id) ?? null;
  }

  /* ================= 签到（连续） ================= */

  signinState(openid) {
    const row = this.db.prepare('SELECT * FROM signin WHERE openid = ?').get(String(openid));
    const streak = Number(row?.streak ?? 0);
    const lastDay = String(row?.last_day ?? '');
    const signedToday = lastDay === today();
    const nextDay = signedToday ? ((streak - 1) % 7) + 1 : (lastDay === yesterday() ? (streak % 7) + 1 : 1);
    return { streak, lastDay, signedToday, nextDay, total: Number(row?.total ?? 0) };
  }

  signin(openid) {
    const st = this.signinState(openid);
    if (st.signedToday) return { error: 'signed', streak: st.streak };
    const day = st.lastDay === yesterday() ? (st.streak % 7) + 1 : 1;
    const reward = this.content.db.prepare('SELECT * FROM signin_reward WHERE day = ?').get(day);
    const streak = st.lastDay === yesterday() ? st.streak + 1 : 1;

    const items = Array.isArray(safeJsonArr(reward?.items)) ? safeJsonArr(reward?.items) : [];
    try {
      this.economy.trade(String(openid), {
        gain: { gold: Number(reward?.gold ?? 0), coupon: Number(reward?.coupon ?? 0), items },
        reason: `签到第 ${day} 天`,
      });
    } catch (e) {
      return { error: 'trade', message: e.message };
    }
    if (reward?.exp) this.players.gainExp(String(openid), Number(reward.exp));
    this.db
      .prepare(
        `INSERT INTO signin (openid, streak, last_day, total) VALUES (?,?,?,1)
         ON CONFLICT(openid) DO UPDATE SET streak = ?, last_day = ?, total = total + 1`,
      )
      .run(String(openid), streak, today(), streak, today());
    return { ok: true, day, streak, reward, player: this.players.get(openid) };
  }

  /* ================= 冥想（挂机） ================= */

  startMeditate(openid) {
    const p = this.players.get(openid);
    if (!p) return { error: 'no_player' };
    if (p.status === 'battle') return { error: 'in_battle' };
    const cur = this.db.prepare('SELECT * FROM meditation WHERE openid = ?').get(String(openid));
    if (cur) return { error: 'already', since: cur.started_at };
    this.db.prepare('INSERT INTO meditation (openid, started_at) VALUES (?,?)').run(String(openid), now());
    return { ok: true, startedAt: now() };
  }

  stopMeditate(openid) {
    const cur = this.db.prepare('SELECT * FROM meditation WHERE openid = ?').get(String(openid));
    if (!cur) return { error: 'not_meditating' };
    const cfg = this.#cfg();
    const capHours = Math.max(1, Number(cfg.meditation_cap_hours ?? 8));
    const perMin = Math.max(0, Number(cfg.meditation_exp_per_min ?? 30));
    const mins = Math.min(capHours * 60, Math.floor((now() - Number(cur.started_at)) / 60_000));
    this.db.prepare('DELETE FROM meditation WHERE openid = ?').run(String(openid));
    if (mins <= 0) return { ok: true, minutes: 0, exp: 0 };
    const exp = mins * perMin;
    const r = this.players.gainExp(String(openid), exp);
    return { ok: true, minutes: mins, exp, capped: mins >= capHours * 60, leveled: r?.leveled ?? 0, player: this.players.get(openid) };
  }

  meditating(openid) {
    return this.db.prepare('SELECT * FROM meditation WHERE openid = ?').get(String(openid)) ?? null;
  }

  /* ================= 资料 / 改名 / 寄语 / 匿名 ================= */

  profile(openid) {
    const p = this.players.get(openid);
    if (!p) return null;
    const e = this.ext(openid);
    const title = this.wornTitle(openid);
    const guild = this.db
      .prepare('SELECT g.name, g.level FROM guild_member gm JOIN guild g ON g.id = gm.guild_id WHERE gm.openid = ?')
      .get(String(openid));
    const rel = this.social ? this.social.relations(openid) : { couple: [] };
    const cfg = this.#cfg();
    return {
      player: p,
      power: power(p, cfg),
      title: title?.name ?? '',
      guild: guild ? `${guild.name} Lv.${guild.level}` : '',
      couple: rel.couple ?? [],
      rings: this.players.ringCount(openid),
      bio: e.bio,
      charm: e.charm,
      anonymous: Number(e.anonymous) === 1,
      subWuhun: Number(e.sub_wuhun_id) || 0,
    };
  }

  rename(openid, newName) {
    const n = String(newName ?? '').trim();
    if (n.length < 1 || n.length > 12) return { error: 'bad_name' };
    const dup = this.players.findByName(n);
    if (dup.length) return { error: 'name_taken', name: n };
    const cfg = this.#cfg();
    const cost = Math.max(0, Number(cfg.rename_cost ?? 500));
    const p = this.players.get(openid);
    if (Number(p.gold) < cost) return { error: 'no_gold', need: cost, have: Number(p.gold) };
    this.players.addGold(openid, -cost, `改名为 ${n}`);
    this.db.prepare('UPDATE player SET name = ? WHERE openid = ?').run(n, String(openid));
    this.ext(openid);
    this.db.prepare('UPDATE player_ext SET rename_count = rename_count + 1 WHERE openid = ?').run(String(openid));
    return { ok: true, name: n, cost, before: p.name };
  }

  setBio(openid, text) {
    const t = String(text ?? '').trim().slice(0, 60);
    this.ext(openid);
    this.db.prepare('UPDATE player_ext SET bio = ? WHERE openid = ?').run(t, String(openid));
    return { ok: true, bio: t };
  }

  toggleAnon(openid, on) {
    this.ext(openid);
    const v = on ? 1 : 0;
    this.db.prepare('UPDATE player_ext SET anonymous = ? WHERE openid = ?').run(v, String(openid));
    return { ok: true, anonymous: Boolean(v) };
  }

  isAnonymous(openid) {
    return Number(this.ext(openid).anonymous) === 1;
  }

  /* ================= 送花 ================= */

  sendFlower(openid, targetName, qty = 1) {
    const n = Math.max(1, Math.min(99, Math.trunc(Number(qty) || 1)));
    const list = this.players.findByName(targetName);
    if (!list.length) return { error: 'not_found', name: targetName };
    if (list.length > 1) return { error: 'ambiguous', name: targetName };
    const to = list[0];
    if (to.openid === openid) return { error: 'self' };
    const cfg = this.#cfg();
    const price = Math.max(0, Number(cfg.flower_price ?? 100)) * n;
    try {
      this.economy.trade(String(openid), { pay: { gold: price }, reason: `送花给 ${to.name}×${n}` });
    } catch (e) {
      return { error: 'trade', message: e.message };
    }
    const charm = Math.max(0, Number(cfg.charm_per_flower ?? 10)) * n;
    this.ext(to.openid);
    this.db.prepare('UPDATE player_ext SET charm = charm + ? WHERE openid = ?').run(charm, String(to.openid));
    this.db
      .prepare('INSERT INTO flower_log (from_openid, to_openid, qty, at) VALUES (?,?,?,?)')
      .run(String(openid), String(to.openid), n, now());
    return { ok: true, to: to.name, qty: n, charm, price };
  }

  /* ================= 约战（实时对决） ================= */

  requestDuel(openid, targetName) {
    const list = this.players.findByName(targetName);
    if (!list.length) return { error: 'not_found', name: targetName };
    if (list.length > 1) return { error: 'ambiguous', name: targetName };
    const to = list[0];
    if (to.openid === openid) return { error: 'self' };
    const exist = this.db
      .prepare("SELECT * FROM duel_request WHERE from_openid = ? AND to_openid = ? AND status = 'pending'")
      .get(String(openid), String(to.openid));
    if (exist) return { error: 'pending', name: to.name };
    this.db
      .prepare('INSERT INTO duel_request (from_openid, to_openid, status, created_at) VALUES (?,?,?,?)')
      .run(String(openid), String(to.openid), 'pending', now());
    return { ok: true, to: to.name };
  }

  pendingDuels(openid) {
    return this.db
      .prepare("SELECT * FROM duel_request WHERE to_openid = ? AND status = 'pending' ORDER BY id DESC LIMIT 10")
      .all(String(openid))
      .map((r) => ({ ...r, fromName: this.players.get(r.from_openid)?.name ?? '???' }));
  }

  acceptDuel(openid, fromName) {
    const list = this.players.findByName(fromName);
    if (!list.length) return { error: 'not_found', name: fromName };
    const from = list[0];
    const req = this.db
      .prepare("SELECT * FROM duel_request WHERE from_openid = ? AND to_openid = ? AND status = 'pending'")
      .get(String(from.openid), String(openid));
    if (!req) return { error: 'no_request', name: from.name };
    this.db.prepare("UPDATE duel_request SET status = 'accepted' WHERE id = ?").run(req.id);
    const res = this.social.duel(openid, from.name);
    if (res.error) return res;
    return { ok: true, from: from.name, result: res };
  }

  /* ================= 图鉴 ================= */

  /**
   * 魂兽图鉴：击杀过就算解锁。
   *
   * 为什么值得做：`kill_count` 一直在记，但玩家看不到。
   * 把它变成「收集进度」之后，同一个击杀行为多了一层意义——
   * 玩家会主动去找没打过的怪，而不是只刷最快的那只。
   * 这层意义不需要任何新数据，只是把已有数据换个角度呈现。
   */
  bestiary(openid) {
    const monsters = this.content.db
      .prepare('SELECT id, name, age, tier, desc FROM monster WHERE enabled = 1 ORDER BY age, id')
      .all();
    const kills = new Map(
      this.db.prepare('SELECT monster_id, n FROM kill_count WHERE openid = ?').all(String(openid)).map((r) => [r.monster_id, r.n]),
    );
    const list = monsters.map((m) => ({
      ...m,
      unlocked: kills.has(m.id),
      kills: Number(kills.get(m.id) ?? 0),
    }));
    return {
      list,
      unlocked: list.filter((m) => m.unlocked).length,
      total: list.length,
    };
  }

  /** 图鉴收集奖励（达到档位可领一次） */
  bestiaryRewards(openid) {
    const { unlocked } = this.bestiary(openid);
    const claimed = new Set(
      this.db.prepare('SELECT count FROM bestiary_claim WHERE openid = ?').all(String(openid)).map((r) => r.count),
    );
    return this.content.db
      .prepare('SELECT * FROM bestiary_reward ORDER BY count')
      .all()
      .map((r) => ({ ...r, reached: unlocked >= Number(r.count), claimed: claimed.has(Number(r.count)) }));
  }

  claimBestiary(openid) {
    const rows = this.bestiaryRewards(openid).filter((r) => r.reached && !r.claimed);
    if (!rows.length) return { ok: true, count: 0, got: [] };
    const got = [];
    for (const r of rows) {
      try {
        this.economy.trade(String(openid), {
          gain: {
            gold: Number(r.gold ?? 0),
            coupon: Number(r.coupon ?? 0),
            items: safeJsonArr(r.items),
          },
          reason: `图鉴 ${r.count} 种`,
        });
      } catch {
        continue;
      }
      this.db
        .prepare('INSERT OR IGNORE INTO bestiary_claim (openid, count, at) VALUES (?,?,?)')
        .run(String(openid), Number(r.count), now());
      got.push(r.desc || `解锁 ${r.count} 种`);
    }
    return { ok: true, count: got.length, got };
  }

  /* ================= 教程 ================= */

  tutorials() {
    return this.content.db.prepare('SELECT * FROM tutorial ORDER BY sort, id').all();
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

function safeJsonArr(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

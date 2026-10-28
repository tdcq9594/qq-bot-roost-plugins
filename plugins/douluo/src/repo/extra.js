/**
 * 扩展系统仓库
 * ============
 *
 * 这一批是「原版有、我们没有」的功能，全部对齐原版控制台的字段：
 *
 * | 系统 | 原版来源 | 我们的表 |
 * | --- | --- | --- |
 * | 组队 | 命令设置里 7 条队伍指令 | `team` / `team_member` / `team_invite` |
 * | 钓鱼 | 地图设置-钓鱼 | `gather_point`(kind=fish) + `gather_state` |
 * | 武魂融合 | 武魂融合列表.ini | `wuhun_fusion` |
 * | 武魂进化 | 武魂进化列表.ini | `wuhun.evolve_*` |
 * | 快捷指令 | 命令设置 4 条 + 快捷指令.ini | `quick_cmd` |
 * | 斗铠领域 | 斗铠领域列表.ini（43 个） | `domain_def` / `domain_open` |
 * | 职业等级 | 职业等级.ini（7 职业 × 10 级） | `profession_level` + `player.prof_exp` |
 * | 机甲聚能 | 机甲列表（总能量值 + 聚能概率） | `player.mecha_energy` |
 * | 魂导器封印 | 命令设置 封印/解封 | `equip_owned.sealed` |
 *
 * 两个共同的设计取舍：
 *   1. 都复用已有的经济/属性通道（`economy.trade`、`players.addItem`、`recalc`），
 *      不各自记账，否则流水对不上。
 *   2. **跨库一律分两步查**。`team` 在游戏库、`wuhun` 在内容库，JOIN 会直接报
 *      no such table——这个错在这个项目里犯过太多次，所以每次涉及两张表都写明。
 */
import { withTx } from './player.js';

const now = () => Date.now();
const day = () => new Date().toISOString().slice(0, 10);

function safeJson(s, d = {}) {
  try {
    const v = JSON.parse(s ?? '');
    return v && typeof v === 'object' ? v : d;
  } catch {
    return d;
  }
}

export class ExtraRepo {
  constructor(game, content, players, economy) {
    this.db = game;
    this.content = content;
    this.players = players;
    this.economy = economy;
  }

  #cfg() {
    return this.content.allCfg();
  }

  /* ================= 组队 ================= */

  teamOf(openid) {
    const row = this.db.prepare('SELECT team_id FROM team_member WHERE openid = ?').get(String(openid));
    if (!row) return null;
    const t = this.db.prepare('SELECT * FROM team WHERE id = ?').get(row.team_id);
    if (!t) return null;
    // 跨库：team_member 在游戏库、player 也在游戏库，这个 JOIN 是合法的
    const members = this.db
      .prepare(
        'SELECT tm.openid, p.name, p.level, p.wuhun_id, p.hp, p.hp_max FROM team_member tm LEFT JOIN player p ON p.openid = tm.openid WHERE tm.team_id = ? ORDER BY tm.joined_at',
      )
      .all(t.id)
      .map((m) => ({ ...m, leader: m.openid === t.leader }));
    return { ...t, members, isLeader: t.leader === String(openid) };
  }

  teamCreate(openid, name) {
    const p = this.players.get(openid);
    if (!p) return { error: 'no_player' };
    if (this.teamOf(openid)) return { error: 'in_team' };
    const nm = String(name ?? '').trim() || `${p.name}的队伍`;
    return withTx(this.db, () => {
      const r = this.db.prepare('INSERT INTO team (leader, name, created_at) VALUES (?,?,?)').run(String(openid), nm.slice(0, 16), now());
      this.db.prepare('INSERT INTO team_member (openid, team_id, joined_at) VALUES (?,?,?)').run(String(openid), r.lastInsertRowid, now());
      return { ok: true, team: this.teamOf(openid) };
    });
  }

  teamInvite(openid, targetName) {
    const t = this.teamOf(openid);
    if (!t) return { error: 'no_team' };
    if (!t.isLeader) return { error: 'not_leader' };
    const target = this.#findPlayer(targetName);
    if (target.error) return target;
    if (this.teamOf(target.id)) return { error: 'target_in_team' };
    const max = Number(this.#cfg().team_max_size ?? 4);
    if (t.members.length >= max) return { error: 'full', max };
    const dup = this.db
      .prepare("SELECT id FROM team_invite WHERE team_id = ? AND to_openid = ? AND status = 'pending'")
      .get(t.id, String(target.id));
    if (dup) return { error: 'pending' };
    this.db
      .prepare('INSERT INTO team_invite (team_id, from_openid, to_openid, created_at) VALUES (?,?,?,?)')
      .run(t.id, String(openid), String(target.id), now());
    return { ok: true, team: t, target };
  }

  teamAccept(openid, fromName) {
    const p = this.players.get(openid);
    if (!p) return { error: 'no_player' };
    if (this.teamOf(openid)) return { error: 'in_team' };
    const rows = this.db
      .prepare("SELECT * FROM team_invite WHERE to_openid = ? AND status = 'pending' ORDER BY id DESC")
      .all(String(openid));
    if (!rows.length) return { error: 'no_invite' };
    let pick = rows[0];
    if (fromName) {
      const hit = rows.find((r) => {
        const f = this.players.get(r.from_openid);
        return f && f.name === String(fromName).trim();
      });
      if (!hit) return { error: 'no_invite_from', name: fromName };
      pick = hit;
    }
    const t = this.db.prepare('SELECT * FROM team WHERE id = ?').get(pick.team_id);
    if (!t) {
      this.db.prepare("UPDATE team_invite SET status = 'expired' WHERE id = ?").run(pick.id);
      return { error: 'team_gone' };
    }
    const max = Number(this.#cfg().team_max_size ?? 4);
    const size = this.db.prepare('SELECT COUNT(*) n FROM team_member WHERE team_id = ?').get(t.id).n;
    if (size >= max) return { error: 'full', max };
    withTx(this.db, () => {
      this.db
        .prepare('INSERT OR REPLACE INTO team_member (openid, team_id, joined_at) VALUES (?,?,?)')
        .run(String(openid), t.id, now());
      this.db.prepare("UPDATE team_invite SET status = 'accepted' WHERE id = ?").run(pick.id);
    });
    return { ok: true, team: this.teamOf(openid) };
  }

  teamLeave(openid) {
    const t = this.teamOf(openid);
    if (!t) return { error: 'no_team' };
    let disbanded = false;
    withTx(this.db, () => {
      this.db.prepare('DELETE FROM team_member WHERE openid = ?').run(String(openid));
      const left = this.db.prepare('SELECT COUNT(*) n FROM team_member WHERE team_id = ?').get(t.id).n;
      if (left === 0) {
        this.db.prepare('DELETE FROM team WHERE id = ?').run(t.id);
        this.db.prepare('DELETE FROM team_invite WHERE team_id = ?').run(t.id);
        disbanded = true;
      } else if (t.isLeader) {
        // 队长走了，顺位给最早加入的人——否则队伍变成没有队长的僵尸队
        const next = this.db.prepare('SELECT openid FROM team_member WHERE team_id = ? ORDER BY joined_at LIMIT 1').get(t.id);
        this.db.prepare('UPDATE team SET leader = ? WHERE id = ?').run(next.openid, t.id);
      }
    });
    return { ok: true, disbanded };
  }

  teamKick(openid, targetName) {
    const t = this.teamOf(openid);
    if (!t) return { error: 'no_team' };
    if (!t.isLeader) return { error: 'not_leader' };
    const target = this.#findPlayer(targetName);
    if (target.error) return target;
    if (String(target.id) === String(openid)) return { error: 'self' };
    const m = this.db.prepare('SELECT * FROM team_member WHERE openid = ? AND team_id = ?').get(String(target.id), t.id);
    if (!m) return { error: 'not_member' };
    this.db.prepare('DELETE FROM team_member WHERE openid = ?').run(String(target.id));
    return { ok: true, target, team: this.teamOf(openid) };
  }

  /** 组队打怪的加成：队友越多经验越高（原版有队伍系统但没写加成规则，这是我们补的） */
  teamBonus(openid) {
    const t = this.teamOf(openid);
    if (!t) return { size: 1, expBonus: 0 };
    const per = Number(this.#cfg().team_exp_bonus ?? 0.15);
    return { size: t.members.length, expBonus: Math.min(0.5, per * (t.members.length - 1)) };
  }

  /* ================= 钓鱼 / 采集 ================= */

  points(openid) {
    const p = this.players.get(openid);
    if (!p) return [];
    const rows = this.content.db
      .prepare('SELECT * FROM gather_point WHERE map_id = ? AND enabled = 1 ORDER BY kind, id')
      .all(Number(p.map_id));
    return rows.map((r) => {
      const st = this.db.prepare('SELECT last_at FROM gather_state WHERE openid = ? AND point_id = ?').get(String(openid), r.id);
      const left = Math.max(0, Number(r.refresh) * 1000 - (now() - Number(st?.last_at ?? 0)));
      const item = r.item_id ? this.content.db.prepare('SELECT name FROM item WHERE id = ?').get(r.item_id) : null;
      return { ...r, itemName: item?.name ?? '（未配置）', cooldownLeft: Math.ceil(left / 1000) };
    });
  }

  /** 钓鱼 / 采集：同一套逻辑，kind 区分 */
  gather(openid, kind = 'fish', pointId = 0) {
    const p = this.players.get(openid);
    if (!p) return { error: 'no_player' };
    if (p.status === 'battle') return { error: 'in_battle' };
    const list = this.points(openid).filter((x) => x.kind === kind);
    if (!list.length) return { error: 'no_point', kind };
    const point = pointId ? list.find((x) => x.id === Number(pointId)) : list[0];
    if (!point) return { error: 'no_point', kind };
    if (point.cooldownLeft > 0) return { error: 'cooldown', left: point.cooldownLeft };
    if (Number(point.level_req) > Number(p.level)) return { error: 'level_low', need: point.level_req };

    // 需要鱼饵/工具：原版「钓鱼所需=鱼饵」
    if (Number(point.need_item) > 0) {
      const have = this.players.detail(openid)?.inventory.find((i) => i.item_id === Number(point.need_item));
      if (!have || Number(have.qty) <= 0) return { error: 'no_bait' };
      this.players.addItem(openid, Number(point.need_item), -1, '钓鱼消耗');
    }

    const qty = Math.max(
      1,
      Math.round(Number(point.qty_min) + Math.random() * Math.max(0, Number(point.qty_max) - Number(point.qty_min))),
    );
    withTx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO gather_state (openid, point_id, last_at) VALUES (?,?,?)
           ON CONFLICT(openid, point_id) DO UPDATE SET last_at = excluded.last_at`,
        )
        .run(String(openid), point.id, now());
      if (Number(point.item_id)) {
        this.players.addItem(openid, Number(point.item_id), qty, `${kind === 'fish' ? '钓鱼' : '采集'} ${point.name}`);
      }
    });
    return { ok: true, point, qty };
  }

  /* ================= 武魂融合 ================= */

  fusionList(openid) {
    const p = this.players.get(openid);
    if (!p) return [];
    const rows = this.content.db.prepare('SELECT * FROM wuhun_fusion WHERE enabled = 1 ORDER BY id').all();
    const sub = Number(this.db.prepare('SELECT sub_wuhun_id FROM player_ext WHERE openid = ?').get(String(openid))?.sub_wuhun_id ?? 0);
    const owned = new Set([Number(p.wuhun_id), sub].filter(Boolean));
    const done = new Set(
      this.db.prepare('SELECT fusion_id FROM wuhun_fused WHERE openid = ?').all(String(openid)).map((r) => r.fusion_id),
    );
    return rows.map((f) => {
      const a = this.content.db.prepare('SELECT name FROM wuhun WHERE id = ?').get(f.wuhun_a);
      const b = this.content.db.prepare('SELECT name FROM wuhun WHERE id = ?').get(f.wuhun_b);
      const sk = f.skill_id ? this.content.db.prepare('SELECT name FROM skill WHERE id = ?').get(f.skill_id) : null;
      return {
        ...f,
        aName: a?.name ?? '？',
        bName: b?.name ?? '？',
        skillName: sk?.name ?? '',
        ready: owned.has(Number(f.wuhun_a)) && owned.has(Number(f.wuhun_b)),
        done: done.has(f.id),
      };
    });
  }

  /**
   * 融合：要求「主武魂 + 副武魂」正好是配置的两侧。
   *
   * 为什么不要求材料：原版融合的门槛就是「两个特定武魂」，
   * 再叠材料会让本来就要抽的双武魂更难凑。
   */
  fuse(openid, fusionName) {
    const p = this.players.get(openid);
    if (!p) return { error: 'no_player' };
    const list = this.fusionList(openid);
    const f = fusionName ? list.find((x) => x.name === String(fusionName).trim()) : list.find((x) => x.ready && !x.done);
    if (!f) return { error: 'no_fusion', name: fusionName };
    if (!f.ready) return { error: 'not_ready', name: f.name, need: [f.aName, f.bName] };
    if (f.done) return { error: 'already', name: f.name };

    const attrs = safeJson(f.attrs);
    const bonus = Object.entries(attrs).filter(([, v]) => Number(v));
    withTx(this.db, () => {
      this.db.prepare('INSERT OR IGNORE INTO wuhun_fused (openid, fusion_id, at) VALUES (?,?,?)').run(String(openid), f.id, now());
      // 融合后把融合技塞进快捷槽（如果还没有）
      if (f.skill_id) {
        const has = this.db.prepare('SELECT slot FROM loadout WHERE openid = ? AND skill_id = ?').get(String(openid), f.skill_id);
        if (!has) {
          const used = this.db.prepare('SELECT slot FROM loadout WHERE openid = ?').all(String(openid)).map((r) => r.slot);
          let use = 1;
          while (used.includes(use) && use <= 10) use += 1;
          if (use <= 10) {
            this.db.prepare('INSERT OR REPLACE INTO loadout (openid, slot, skill_id) VALUES (?,?,?)').run(String(openid), use, f.skill_id);
          }
        }
      }
    });
    this.players.recalc(openid);
    return { ok: true, fusion: f, bonus };
  }

  /* ================= 武魂进化 ================= */

  evolveInfo(openid) {
    const p = this.players.get(openid);
    if (!p) return null;
    const w = this.content.db.prepare('SELECT * FROM wuhun WHERE id = ?').get(Number(p.wuhun_id));
    if (!w) return null;
    const target = Number(w.evolve_to) ? this.content.db.prepare('SELECT * FROM wuhun WHERE id = ?').get(Number(w.evolve_to)) : null;
    const itemName = String(w.evolve_item ?? '').trim();
    const needItem = itemName ? this.content.db.prepare('SELECT id, name FROM item WHERE name = ?').get(itemName) : null;
    const have = needItem
      ? Number(this.players.detail(openid)?.inventory.find((i) => i.item_id === needItem.id)?.qty ?? 0)
      : 0;
    return {
      wuhun: w,
      target,
      needLevel: Number(w.evolve_level ?? 0),
      needItem: needItem?.name ?? '',
      have,
      canEvolve: Boolean(target) && Number(p.level) >= Number(w.evolve_level ?? 0) && (!needItem || have > 0),
    };
  }

  evolve(openid) {
    const info = this.evolveInfo(openid);
    if (!info) return { error: 'no_player' };
    if (!info.target) return { error: 'no_target', wuhun: info.wuhun.name };
    const p = this.players.get(openid);
    if (Number(p.level) < info.needLevel) return { error: 'level_low', need: info.needLevel, have: p.level };
    if (info.needItem && info.have <= 0) return { error: 'no_item', name: info.needItem };

    withTx(this.db, () => {
      if (info.needItem) {
        const row = this.content.db.prepare('SELECT id FROM item WHERE name = ?').get(info.needItem);
        if (row) this.players.addItem(openid, row.id, -1, '武魂进化');
      }
      this.db.prepare('UPDATE player SET wuhun_id = ? WHERE openid = ?').run(info.target.id, String(openid));
    });
    this.players.recalc(openid);
    return { ok: true, from: info.wuhun.name, to: info.target.name, player: this.players.get(openid) };
  }

  /* ================= 快捷指令 ================= */

  quickList(openid) {
    return this.db.prepare('SELECT * FROM quick_cmd WHERE openid = ? ORDER BY slot').all(String(openid));
  }

  quickSet(openid, slot, cmd) {
    const s = Math.max(1, Math.min(20, Number(slot) || 0));
    const c = String(cmd ?? '').trim().slice(0, 40);
    if (!s || !c) return { error: 'bad_args' };
    this.db
      .prepare('INSERT INTO quick_cmd (openid, slot, cmd) VALUES (?,?,?) ON CONFLICT(openid, slot) DO UPDATE SET cmd = excluded.cmd')
      .run(String(openid), s, c);
    return { ok: true, slot: s, cmd: c };
  }

  quickDel(openid, slot) {
    const s = Number(slot) || 0;
    if (!s) return { error: 'bad_args', slot: 0 };
    const r = this.db.prepare('DELETE FROM quick_cmd WHERE openid = ? AND slot = ?').run(String(openid), s);
    return r.changes ? { ok: true, slot: s } : { error: 'not_found', slot: s };
  }

  quickClear(openid) {
    const r = this.db.prepare('DELETE FROM quick_cmd WHERE openid = ?').run(String(openid));
    return { ok: true, n: r.changes };
  }

  quickResolve(openid, slot) {
    const row = this.db.prepare('SELECT cmd FROM quick_cmd WHERE openid = ? AND slot = ?').get(String(openid), Number(slot) || 0);
    return row?.cmd ?? null;
  }

  /* ================= 斗铠领域 ================= */

  domainList(openid) {
    const rows = this.content.db.prepare('SELECT * FROM domain_def WHERE enabled = 1 ORDER BY id').all();
    const opened = new Set(
      this.db.prepare('SELECT domain_id FROM domain_open WHERE openid = ?').all(String(openid)).map((r) => r.domain_id),
    );
    const eq = this.players.owned(openid).find((e) => e.part === 'domain' && Number(e.equipped) === 1);
    return rows.map((d) => ({ ...d, opened: opened.has(d.id), equippedDomain: Boolean(eq), cost: safeJson(d.cost) }));
  }

  /** 觉醒领域：需要一个已穿戴的领域型斗铠（原版「合成领域」的前提） */
  domainAwaken(openid, name) {
    const p = this.players.get(openid);
    if (!p) return { error: 'no_player' };
    const d = this.content.db.prepare('SELECT * FROM domain_def WHERE name = ? AND enabled = 1').get(String(name ?? '').trim());
    if (!d) return { error: 'no_domain', name };
    const eq = this.players.owned(openid).find((e) => e.part === 'domain' && Number(e.equipped) === 1);
    if (!eq) return { error: 'no_armor' };
    const cost = safeJson(d.cost);
    const gold = Number(cost.gold ?? 0);
    if (gold && Number(p.gold) < gold) return { error: 'no_gold', need: gold, have: p.gold };
    withTx(this.db, () => {
      if (gold) this.players.addGold(openid, -gold, `觉醒领域 ${d.name}`);
      this.db.prepare('INSERT OR IGNORE INTO domain_open (openid, domain_id, opened_at) VALUES (?,?,?)').run(String(openid), d.id, now());
    });
    return { ok: true, domain: d };
  }

  /**
   * 开启/关闭领域。
   * 同一时间只能开一个——否则 43 个领域一起开，属性会叠成天文数字。
   */
  domainToggle(openid, on, name) {
    const list = this.domainList(openid);
    if (!list.length) return { error: 'no_domain' };
    if (!on) {
      const r = this.db.prepare('DELETE FROM domain_open WHERE openid = ?').run(String(openid));
      return { ok: true, closed: r.changes };
    }
    const d = name ? list.find((x) => x.name === String(name).trim()) : list.find((x) => x.opened);
    if (!d) return { error: 'no_domain', name };
    if (!d.opened) return { error: 'not_awakened', name: d.name };
    withTx(this.db, () => {
      this.db.prepare('DELETE FROM domain_open WHERE openid = ?').run(String(openid));
      this.db.prepare('INSERT INTO domain_open (openid, domain_id, opened_at) VALUES (?,?,?)').run(String(openid), d.id, now());
    });
    return { ok: true, domain: d };
  }

  /**
   * 当前开启的领域。
   *
   * ⚠️ `domain_open` 在**游戏库**、`domain_def` 在**内容库**，不能 JOIN。
   * 分两步查——这个错在这个项目里犯过好几次，每次都是 no such table。
   */
  activeDomain(openid) {
    const row = this.db.prepare('SELECT domain_id FROM domain_open WHERE openid = ?').get(String(openid));
    if (!row) return null;
    const d = this.content.db.prepare('SELECT * FROM domain_def WHERE id = ?').get(row.domain_id);
    if (!d) return null;
    return { ...d, attrs: safeJson(d.attrs) };
  }

  /* ================= 职业等级 ================= */

  professionInfo(openid) {
    const p = this.players.get(openid);
    if (!p) return null;
    const name = String(p.profession ?? '').trim();
    if (!name) return { none: true };
    const lv = Number(p.prof_level ?? 1);
    const next = this.content.db
      .prepare('SELECT * FROM profession_level WHERE profession = ? AND level = ?')
      .get(name, lv + 1);
    return {
      name,
      level: lv,
      exp: Number(p.prof_exp ?? 0),
      need: Number(next?.need_exp ?? 0),
      max: !next,
      bonus: safeJson(next?.bonus ?? '{}'),
    };
  }

  /** 制作/炼丹给职业经验（原版设计图的「获得职业经验」字段） */
  addProfExp(openid, amount) {
    const p = this.players.get(openid);
    if (!p || !String(p.profession ?? '').trim()) return null;
    let lv = Number(p.prof_level ?? 1);
    let exp = Number(p.prof_exp ?? 0) + Math.max(0, Number(amount) || 0);
    let leveled = 0;
    for (let i = 0; i < 20; i += 1) {
      const next = this.content.db
        .prepare('SELECT need_exp FROM profession_level WHERE profession = ? AND level = ?')
        .get(p.profession, lv + 1);
      if (!next) break;
      if (exp < Number(next.need_exp)) break;
      exp -= Number(next.need_exp);
      lv += 1;
      leveled += 1;
    }
    this.db.prepare('UPDATE player SET prof_level = ?, prof_exp = ? WHERE openid = ?').run(lv, exp, String(openid));
    return { level: lv, exp, leveled };
  }

  /* ================= 机甲聚能 ================= */

  mechaInfo(openid) {
    const p = this.players.get(openid);
    if (!p) return null;
    const mecha = this.players.owned(openid).find((e) => e.part === 'mecha' && Number(e.equipped) === 1);
    return { mecha, energy: Number(p.mecha_energy ?? 0), max: Number(this.#cfg().mecha_energy_max ?? 100) };
  }

  mechaCharge(openid) {
    const info = this.mechaInfo(openid);
    if (!info?.mecha) return { error: 'no_mecha' };
    const p = this.players.get(openid);
    const cfg = this.#cfg();
    const cost = Number(cfg.mecha_charge_cost ?? 200);
    if (info.energy >= info.max) return { error: 'full', max: info.max };
    if (Number(p.gold) < cost) return { error: 'no_gold', need: cost, have: p.gold };
    const gain = Math.min(info.max - info.energy, Number(cfg.mecha_charge_gain ?? 20));
    withTx(this.db, () => {
      this.players.addGold(openid, -cost, '机甲充能');
      this.db.prepare('UPDATE player SET mecha_energy = mecha_energy + ? WHERE openid = ?').run(gain, String(openid));
    });
    return { ok: true, gain, energy: info.energy + gain, max: info.max, cost };
  }

  /* ================= 魂导器封印 ================= */

  seal(openid, name) {
    const eq = this.players.owned(openid).find((e) => e.name === String(name ?? '').trim());
    if (!eq) return { error: 'no_equip', name };
    if (Number(eq.equipped) === 1) return { error: 'equipped', name: eq.name };
    if (Number(eq.sealed) === 1) return { error: 'already', name: eq.name };
    this.db.prepare('UPDATE equip_owned SET sealed = 1 WHERE id = ?').run(eq.instanceId);
    return { ok: true, name: eq.name };
  }

  unseal(openid, name) {
    const eq = this.players.owned(openid).find((e) => e.name === String(name ?? '').trim());
    if (!eq) return { error: 'no_equip', name };
    if (Number(eq.sealed) !== 1) return { error: 'not_sealed', name: eq.name };
    const p = this.players.get(openid);
    const cost = Number(this.#cfg().unseal_cost ?? 300);
    if (Number(p.gold) < cost) return { error: 'no_gold', need: cost, have: p.gold };
    withTx(this.db, () => {
      this.players.addGold(openid, -cost, `解封 ${eq.name}`);
      this.db.prepare('UPDATE equip_owned SET sealed = 0 WHERE id = ?').run(eq.instanceId);
    });
    return { ok: true, name: eq.name, cost };
  }

  sealedList(openid) {
    return this.players.owned(openid).filter((e) => Number(e.sealed) === 1);
  }

  /* ================= 通用 ================= */

  #findPlayer(name) {
    const n = String(name ?? '').trim();
    if (!n) return { error: 'no_name' };
    const rows = this.db.prepare('SELECT openid, name FROM player WHERE name = ?').all(n);
    if (!rows.length) return { error: 'not_found', name: n };
    if (rows.length > 1) return { error: 'ambiguous', count: rows.length, name: n };
    return { id: rows[0].openid, name: rows[0].name };
  }
}

export { day };

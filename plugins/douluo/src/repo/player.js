/**
 * 玩家数据访问层
 * ==============
 *
 * 所有写操作都走事务，并且**每一笔货币/物品变动都写 tx_log**。
 * 这是「面板能追到每一分钱」的前提，也是后面做经济审计的基础。
 */
import { power } from '../engine/formula.js';
import { computeAttrs } from '../engine/stats.js';
import { applyExp } from '../engine/progress.js';
import { collectModifiers, computeSetBonuses } from '../engine/modifiers.js';

/** 简单事务包装。node:sqlite 是同步的，所以这里不需要 async */
export function withTx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw e;
  }
}

const now = () => Date.now();

export class PlayerRepo {
  constructor(game, content) {
    this.db = game;
    this.content = content;
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM player').get().n;
  }

  /** 列表：昵称模糊 + openid 精确，两种都支持（运营手里多半只有昵称） */
  list({ q = '', page = 1, size = 30 } = {}) {
    const kw = String(q || '').trim();
    const where = kw ? 'WHERE name LIKE ? OR openid = ?' : '';
    const params = kw ? [`%${kw}%`, kw] : [];
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM player ${where}`).get(...params).n;
    const lim = Math.min(200, Math.max(1, Number(size) || 30));
    const pg = Math.max(1, Number(page) || 1);
    const rows = this.db
      .prepare(
        `SELECT openid, name, gender, level, exp, gold, coupon, map_id, status,
                hp, hp_max, mp, mp_max, atk, def, spd, dodge, crit, crit_dmg,
                str, intel, stamina, title_id, created_at, last_seen
           FROM player ${where}
          ORDER BY last_seen DESC, level DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, lim, (pg - 1) * lim);

    const cfg = this.#cfgAll();
    return {
      rows: rows.map((r) => ({ ...r, power: power({ ...r, ring_years_sum: this.#ringYears(r.openid) }, cfg) })),
      total,
      page: pg,
      size: lim,
    };
  }

  get(openid) {
    return this.db.prepare('SELECT * FROM player WHERE openid = ?').get(String(openid)) ?? null;
  }

  /**
   * 按昵称找玩家。
   *
   * 昵称**不唯一**（QQ 里重名很常见），所以返回所有匹配，
   * 让调用方自己判断「找不到 / 唯一 / 有歧义」。社交和 PVP 都靠它。
   */
  findByName(name) {
    const n = String(name ?? '').trim();
    if (!n) return [];
    return this.db.prepare('SELECT * FROM player WHERE name = ?').all(n);
  }

  /** 详情：角色 + 背包 + 魂环 + 称号，一次给全 */
  detail(openid) {
    const p = this.get(openid);
    if (!p) return null;
    // 两个库分开查再在内存里拼，不做跨库 JOIN（content 是只读连接，ATTACH 会变复杂）
    const inventory = this.db
      .prepare('SELECT item_id, qty FROM inventory WHERE openid = ? ORDER BY item_id')
      .all(p.openid);
    const itemRows = this.content.db.prepare('SELECT id, name, kind FROM item').all();
    const nameOf = new Map(itemRows.map((r) => [r.id, r]));

    const rings = this.db.prepare('SELECT * FROM ring WHERE openid = ? ORDER BY slot').all(p.openid);
    const titles = this.db
      .prepare('SELECT title_id FROM title_owned WHERE openid = ?')
      .all(p.openid)
      .map((r) => r.title_id);

    const cfg = this.#cfgAll();
    const ownedEquip = this.owned(p.openid);
    const ownedComp = this.ownedCompanions(p.openid);
    const mods = this.mods(p.openid);
    return {
      player: { ...p, power: power({ ...p, ring_years_sum: this.#ringYears(p.openid) }, cfg) },
      inventory: inventory.map((r) => ({
        item_id: r.item_id,
        qty: r.qty,
        name: nameOf.get(r.item_id)?.name ?? `#${r.item_id}`,
        kind: nameOf.get(r.item_id)?.kind ?? '',
      })),
      rings,
      titles,
      equipment: {
        owned: ownedEquip,
        equipped: ownedEquip.filter((e) => Number(e.equipped) === 1),
        sources: mods.sources,
        flat: mods.flat,
      },
      companions: {
        owned: ownedComp,
        active: ownedComp.filter((c) => Number(c.active) === 1),
        cards: ownedComp.filter((c) => c.kind === 'card'),
      },
      tx: this.recentTx(20, p.openid),
    };
  }

  /**
   * 发放货币 / 物品。
   * @param {string} openid
   * @param {{kind:'gold'|'coupon'|'item', id?:number, qty:number, reason?:string, admin?:string}} opt
   */
  give(openid, { kind, id = 0, qty = 0, reason = '面板发放', admin = 'panel' }) {
    const n = Math.trunc(Number(qty));
    if (!Number.isFinite(n) || n === 0) throw new Error('数量必须是非零整数');
    const p = this.get(openid);
    if (!p) throw new Error(`没有这个玩家：${openid}`);

    return withTx(this.db, () => {
      let balance = 0;
      let skipTx = false;
      if (kind === 'gold' || kind === 'coupon') {
        const col = kind === 'gold' ? 'gold' : 'coupon';
        const next = Math.max(0, Number(p[col]) + n);
        this.db.prepare(`UPDATE player SET ${col} = ? WHERE openid = ?`).run(next, p.openid);
        balance = next;
      } else if (kind === 'item') {
        const itemId = Math.trunc(Number(id));
        if (!itemId) throw new Error('发物品必须给 item_id');
        const cur = this.db.prepare('SELECT qty FROM inventory WHERE openid = ? AND item_id = ?').get(p.openid, itemId);
        const next = Math.max(0, Number(cur?.qty ?? 0) + n);
        if (next === 0) {
          this.db.prepare('DELETE FROM inventory WHERE openid = ? AND item_id = ?').run(p.openid, itemId);
        } else {
          this.db
            .prepare(
              `INSERT INTO inventory (openid, item_id, qty) VALUES (?, ?, ?)
               ON CONFLICT(openid, item_id) DO UPDATE SET qty = excluded.qty`,
            )
            .run(p.openid, itemId, next);
        }
        balance = next;
      } else if (kind === 'equip') {
        // 装备走 grantEquip（它自己写流水），这里不再重复记
        const equipId = Math.trunc(Number(id));
        if (!equipId) throw new Error('发装备必须给 equip_id');
        const g = this.grantEquip(p.openid, equipId, reason);
        balance = g.instanceId;
        skipTx = true;
      } else if (kind === 'companion') {
        const cid = Math.trunc(Number(id));
        if (!cid) throw new Error('发伙伴必须给 companion_id');
        const g = this.grantCompanion(p.openid, cid, reason);
        balance = g.instanceId;
        skipTx = true;
      } else {
        throw new Error(`不认识的发放类型：${kind}`);
      }

      if (!skipTx) {
        this.db
          .prepare('INSERT INTO tx_log (openid, kind, ref_id, delta, balance, reason, at) VALUES (?,?,?,?,?,?,?)')
          .run(p.openid, kind, kind === 'item' ? Number(id) : 0, n, balance, reason, now());
      }
      this.db
        .prepare('INSERT INTO admin_log (admin, action, target, payload, at) VALUES (?,?,?,?,?)')
        .run(admin, `give:${kind}`, p.openid, JSON.stringify({ id, qty, reason }), now());

      return { ok: true, balance };
    });
  }

  /** 建号。属性全部来自 content.db 的武魂表，代码里不写死任何数字 */
  /**
   * 建号。
   *
   * `wuhunId` 不传就是**未觉醒**状态：武魂为 NULL，用基础属性，
   * 等玩家自己发 `武魂觉醒` 才抽武魂。
   * 之前这里写死 `wuhunId: 1`，导致所有人都是蓝银草——这是「怎么只有蓝银草」的根因。
   */
  create({ openid, name, gender = '男', wuhunId = 0 }) {
    const id = String(openid || '').trim();
    if (!id) throw new Error('缺少 openid');
    if (this.get(id)) throw new Error('你已经有角色了');

    const w = wuhunId
      ? this.content.db.prepare('SELECT * FROM wuhun WHERE id = ? AND enabled = 1').get(Number(wuhunId))
      : null;
    if (wuhunId && !w) throw new Error(`没有这个武魂：${wuhunId}`);

    // 未觉醒时用一套基础值，觉醒后由 recalc 按武魂重算
    const b = w ?? { hp: 100, mp: 100, atk: 10, def: 10, spd: 10, dodge: 5, crit: 5, crit_dmg: 150, str: 10, intel: 10 };

    const t = now();
    this.db
      .prepare(
        `INSERT INTO player
          (openid, name, gender, level, exp, wuhun_id,
           hp, hp_max, mp, mp_max, atk, def, spd, dodge, crit, crit_dmg, str, intel,
           gold, coupon, map_id, stamina, status, created_at, last_seen)
         VALUES (?,?,?,1,0,?, ?,?,?,?, ?,?,?,?,?,?, ?,?, 0,0,1,188,'idle',?,?)`,
      )
      .run(
        id,
        String(name || '无名').slice(0, 12),
        gender === '女' ? '女' : '男',
        w ? w.id : null,
        b.hp,
        b.hp,
        b.mp,
        b.mp,
        b.atk,
        b.def,
        b.spd,
        b.dodge,
        b.crit,
        b.crit_dmg,
        b.str,
        b.intel,
        t,
        t,
      );

    // 建号赠送（内容表里配的新手礼包）
    const gift = this.content.db.prepare("SELECT id FROM item WHERE effect = 'gift_newbie' AND enabled = 1").get();
    if (gift) {
      this.db.prepare('INSERT INTO inventory (openid, item_id, qty) VALUES (?,?,1)').run(id, gift.id);
    }

    return this.get(id);
  }

  remove(openid) {
    const p = this.get(openid);
    if (!p) throw new Error('没有这个玩家');
    return withTx(this.db, () => {
      this.db.prepare('DELETE FROM player WHERE openid = ?').run(p.openid);
      this.db
        .prepare('INSERT INTO admin_log (admin, action, target, payload, at) VALUES (?,?,?,?,?)')
        .run('panel', 'delete', p.openid, p.name, now());
      return { ok: true };
    });
  }

  recentTx(limit = 100, openid = null) {
    const lim = Math.min(500, Math.max(1, Number(limit) || 100));
    if (openid) {
      return this.db.prepare('SELECT * FROM tx_log WHERE openid = ? ORDER BY id DESC LIMIT ?').all(openid, lim);
    }
    return this.db.prepare('SELECT * FROM tx_log ORDER BY id DESC LIMIT ?').all(lim);
  }

  stats() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayStart = today.getTime();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS players,
                COALESCE(SUM(gold), 0)   AS gold,
                COALESCE(SUM(coupon), 0) AS coupon,
                COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS todayNew,
                COALESCE(SUM(CASE WHEN last_seen >= ? THEN 1 ELSE 0 END), 0)  AS active24h
           FROM player`,
      )
      .get(dayStart, Date.now() - 86400_000);
    const battles = 0; // 战斗表还没建，先占位
    return { ...row, battles };
  }

  #ringYears(openid) {
    const r = this.db.prepare('SELECT COALESCE(SUM(years),0) AS s FROM ring WHERE openid = ?').get(openid);
    return Number(r?.s ?? 0);
  }

  #cfgAll() {
    return this.content.allCfg();
  }

  /* ---------------- 装备 ---------------- */

  /** 内容表的两张装备表，读一次缓存一次调用（表很小） */
  #equipContent() {
    const byId = new Map(this.content.db.prepare('SELECT * FROM equip').all().map((r) => [r.id, r]));
    const sets = new Map(this.content.db.prepare('SELECT * FROM equip_set').all().map((r) => [r.id, r]));
    return { byId, sets };
  }

  /** 玩家持有的全部装备（含未装备的），把内容字段拼上 */
  owned(openid) {
    const { byId } = this.#equipContent();
    return this.db
      .prepare('SELECT * FROM equip_owned WHERE openid = ? ORDER BY equipped DESC, id')
      .all(openid)
      .map((o) => {
        const c = byId.get(o.equip_id) ?? {};
        return {
          ...c,
          instanceId: o.id,
          equip_id: o.equip_id,
          level: o.level,
          equipped: o.equipped,
          // 这两个是实例状态（游戏库），内容表里没有，必须显式带出来
          durability: o.durability,
          holes: o.holes,
          part: o.part || c.part || '',
          name: c.name ?? `#${o.equip_id}`,
        };
      });
  }

  /** 只看已装备的 */
  equipped(openid) {
    return this.owned(openid)
      .filter((e) => Number(e.equipped) === 1)
      .map((e) => {
        // 宝石属性并进装备本身，这样面板和加成来源看到的是一整块
        const g = this.#gemAttrs(e.instanceId);
        if (!Object.keys(g).length) return e;
        const out = { ...e };
        for (const [k, v] of Object.entries(g)) out[k] = Number(out[k] ?? 0) + v;
        return out;
      });
  }

  /** 加成汇总：装备 + 套装 + 伙伴 */
  mods(openid) {
    // 耐久归零的装备不提供加成（这是「修理」存在的意义）
    const eq = this.equipped(openid).filter((e) => Number(e.durability ?? 100) > 0);
    const { sets } = this.#equipContent();
    const setBonuses = computeSetBonuses(eq, sets);
    const cfg = this.#cfgAll();
    return collectModifiers({
      equipped: eq,
      extras: [...this.#aptitudeExtras(openid), ...this.#domainExtras(openid)],
      companions: this.activeCompanions(openid),
      setBonuses,
      buffs: this.buffs(openid),
      equipRate: 0.1,
      compRate: Number(cfg.companion_level_rate ?? 0.1),
    });
  }

  /** 宝石属性（挂在装备实例上）。gem 在内容库、gem_slot 在游戏库，分两步查。 */
  #gemAttrs(equipInstanceId) {
    const slots = this.db.prepare('SELECT gem_id FROM gem_slot WHERE equip_id = ?').all(Number(equipInstanceId));
    const out = {};
    for (const s of slots) {
      const g = this.content.db.prepare('SELECT * FROM gem WHERE id = ?').get(s.gem_id);
      if (!g) continue;
      for (const a of ['atk', 'def', 'hp', 'mp', 'spd', 'crit', 'dodge']) {
        const v = Number(g[a] ?? 0);
        if (v) out[a] = (out[a] ?? 0) + v;
      }
    }
    return out;
  }

  /**
   * 已开启的斗铠领域属性。
   *
   * 走 extras 通道（和功法一样）：领域给的是固定加成，
   * 不该吃装备的等级系数，也不该被宗门乘区放大两次。
   * 同一时间只能开一个，由 ExtraRepo.domainToggle 保证。
   */
  #domainExtras(openid) {
    if (!this.extra) return [];
    try {
      const d = this.extra.activeDomain(openid);
      if (!d) return [];
      return [{ name: d.name, attrs: d.attrs ?? {} }];
    } catch {
      return [];
    }
  }

  /** 功法/血脉：学会就永久加，走 extras 通道（不吃等级系数） */
  #aptitudeExtras(openid) {
    const rows = this.db.prepare('SELECT aptitude_id FROM aptitude_owned WHERE openid = ?').all(String(openid));
    return rows
      .map((r) => {
        const a = this.content.db.prepare('SELECT * FROM aptitude WHERE id = ?').get(r.aptitude_id);
        if (!a) return null;
        let attrs = {};
        try {
          attrs = JSON.parse(a.attrs || '{}');
        } catch {
          attrs = {};
        }
        return { name: a.name, attrs };
      })
      .filter(Boolean);
  }

  /** 全局增益：宗门等级给全体成员的全属性比例加成 */
  buffs(openid) {
    const g = this.db
      .prepare('SELECT g.name, g.level FROM guild_member gm JOIN guild g ON g.id = gm.guild_id WHERE gm.openid = ?')
      .get(String(openid));
    if (!g) return [];
    const cfg = this.#cfgAll();
    const pct = Number(cfg.guild_level_bonus ?? 0.02) * Number(g.level);
    return pct > 0 ? [{ name: `${g.name} Lv.${g.level}`, pct }] : [];
  }

  /** 某个大类有没有激活（战舰/机甲/领域） */
  hasActiveEquip(openid, kind) {
    return this.owned(openid).some((e) => e.kind === kind && Number(e.equipped) === 1);
  }

  /**
   * 强化装备。
   *
   * 用「必成 + 递增成本」，不用随机成功率：
   * 随机强化是手游最典型的挫败来源（连败十次直接退游），
   * 而文游玩家没有"氪金补救"的通道，只能骂人。
   * 成本按 level^1.6 涨，10 级封顶。
   */
  upgradeEquip(openid, name) {
    const all = this.owned(openid);
    const target = all.find((e) => e.name === name);
    if (!target) return { error: 'not_owned', name };
    const cfg = this.#cfgAll();
    const max = Math.max(1, Number(cfg.equip_upgrade_max ?? 10));
    const lv = Math.max(1, Number(target.level));
    if (lv >= max) return { error: 'maxed', name: target.name, max };

    const cost = Math.round(Number(cfg.equip_upgrade_base ?? 200) * Math.pow(lv, 1.6));
    const p = this.get(openid);
    if (Number(p.gold) < cost) return { error: 'no_gold', need: cost, have: Number(p.gold) };

    withTx(this.db, () => {
      this.addGold(openid, -cost, `强化 ${target.name} +${lv + 1}`);
      this.db.prepare('UPDATE equip_owned SET level = level + 1 WHERE id = ?').run(target.instanceId);
    });
    return { ok: true, name: target.name, level: lv + 1, cost, player: this.recalc(openid) };
  }

  /**
   * 分解装备，返还魂环碎片。
   *
   * 以前多余装备只能压箱底：拍卖行没人要、商店不收、也不掉别的东西，
   * 打到的重复魂骨就是一堆死数据。分解给它一个出口，顺便喂给炼丹/合成。
   */
  salvageEquip(openid, name) {
    const all = this.owned(openid);
    const target = all.find((e) => e.name === name);
    if (!target) return { error: 'not_owned', name };
    const cfg = this.#cfgAll();
    const itemId = Number(cfg.salvage_item_id ?? 3);
    const qty = Math.max(
      1,
      Math.round((Number(target.rarity ?? 1) * 2 + Number(target.level ?? 1) * 3) * Number(cfg.salvage_rate ?? 1)),
    );
    withTx(this.db, () => {
      this.db.prepare('DELETE FROM equip_owned WHERE id = ?').run(target.instanceId);
      this.addItem(openid, itemId, qty, `分解 ${target.name}`);
    });
    const itemName = this.content.db.prepare('SELECT name FROM item WHERE id = ?').get(itemId)?.name ?? '碎片';
    return { ok: true, name: target.name, qty, itemName, player: this.recalc(openid) };
  }

  /* ---------------- 武魂觉醒 / 删号 ---------------- */

  /**
   * 武魂觉醒。
   *
   * 按稀有度加权随机：普通好出、神级稀有。
   * **首次免费**，之后每次花钱且递增——不然玩家会一直重掷到 SSR 才停，
   * 武魂就没有「命运」的意思了。
   *
   * 已经附了魂环也能觉醒（魂技是魂环给的，跟武魂无关），但会提示一句。
   */
  awaken(openid, rng = Math.random, forceName = '') {
    const p = this.get(openid);
    if (!p) return { error: 'no_player' };

    const pool = this.content.db.prepare('SELECT * FROM wuhun WHERE enabled = 1').all();
    if (!pool.length) return { error: 'no_wuhun' };

    const cfg = this.#cfgAll();
    const times = Number(this.db.prepare('SELECT COUNT(*) n FROM player_meta WHERE openid = ? AND key = ?').get(String(openid), 'awaken')?.n ?? 0);
    const free = times === 0;
    const cost = free ? 0 : Math.round(Number(cfg.awaken_cost_base ?? 1000) * (1 + times * 0.8));
    if (!free && Number(p.gold) < cost) return { error: 'no_gold', need: cost, have: Number(p.gold), times };

    // 稀有度越高越难出：1星 50 / 2星 26 / 3星 14 / 4星 7 / 5星 3
    const WEIGHT = { 1: 50, 2: 26, 3: 14, 4: 7, 5: 3 };
    let picked = null;
    if (forceName) {
      // 指定武魂：给测试和运营补发用，玩家指令不暴露这个口子
      picked = pool.find((w) => w.name === String(forceName).trim()) ?? null;
      if (!picked) return { error: 'no_wuhun', name: forceName };
    } else {
      const weighted = pool.map((w) => ({ w, weight: WEIGHT[Number(w.rarity)] ?? 10 }));
      const total = weighted.reduce((s, x) => s + x.weight, 0);
      let roll = rng() * total;
      picked = weighted[weighted.length - 1].w;
      for (const x of weighted) {
        roll -= x.weight;
        if (roll <= 0) {
          picked = x.w;
          break;
        }
      }
    }

    const before = p.wuhun_id ? this.content.db.prepare('SELECT name FROM wuhun WHERE id = ?').get(p.wuhun_id)?.name : null;
    withTx(this.db, () => {
      if (cost) this.addGold(openid, -cost, `武魂觉醒（第 ${times + 1} 次）`);
      this.db.prepare('UPDATE player SET wuhun_id = ? WHERE openid = ?').run(picked.id, String(openid));
      this.db
        .prepare(
          `INSERT INTO player_meta (openid, key, value) VALUES (?, 'awaken', '1')
           ON CONFLICT(openid, key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
        )
        .run(String(openid));
    });

    const after = this.recalc(openid);
    return { ok: true, wuhun: picked, before, cost, times: times + 1, free, player: after, rings: this.ringCount(openid) };
  }

  /** 已觉醒次数 */
  awakenTimes(openid) {
    return Number(
      this.db.prepare('SELECT value FROM player_meta WHERE openid = ? AND key = ?').get(String(openid), 'awaken')?.value ?? 0,
    );
  }

  /** 下一次觉醒要花多少（0 = 免费） */
  awakenCost(openid) {
    const times = this.awakenTimes(openid);
    if (times === 0) return 0;
    const cfg = this.#cfgAll();
    return Math.round(Number(cfg.awaken_cost_base ?? 1000) * (1 + times * 0.8));
  }

  /**
   * 删号。**不留任何游戏性限制**（不需要等级、不需要道具），
   * 但关联数据必须清干净——不然残留的魂环/装备会挂在一个不存在的角色上。
   */
  remove(openid) {
    const id = String(openid);
    const p = this.get(id);
    if (!p) return { error: 'no_player' };
    const tables = [
      'inventory', 'ring', 'equip_owned', 'companion_owned', 'player_quest', 'kill_count',
      'player_title', 'title_owned', 'signin', 'challenge_progress', 'gem_slot', 'gem_owned',
      'aptitude_owned', 'hidden_weapon_owned', 'player_ext', 'duel_request', 'meditation',
      'player_skill', 'season_point', 'bestiary_claim', 'bounty', 'mail', 'territory_collect',
      'duel_daily', 'player_meta', 'sign_in', 'battle', 'loadout', 'relation', 'flower_log',
      'guild_member', 'auction', 'pending_ring',
    ];
    withTx(this.db, () => {
      for (const t of tables) {
        try {
          this.db.prepare(`DELETE FROM ${t} WHERE openid = ?`).run(id);
        } catch {
          /* 表不存在就跳过（不同版本表不一样） */
        }
      }
      // 有些表用别的列名
      for (const [t, col] of [
        ['duel', 'a_openid'], ['duel', 'b_openid'],
        ['flower_log', 'from_openid'], ['flower_log', 'to_openid'],
        ['duel_request', 'from_openid'], ['duel_request', 'to_openid'],
        ['relation', 'from_openid'], ['relation', 'to_openid'],
      ]) {
        try {
          this.db.prepare(`DELETE FROM ${t} WHERE ${col} = ?`).run(id);
        } catch {
          /* 同上 */
        }
      }
      this.db.prepare('DELETE FROM player WHERE openid = ?').run(id);
    });
    return { ok: true, name: p.name, level: p.level };
  }

  /* ---------------- 魂技等级 ---------------- */

  /**
   * 魂技等级：玩家自己的技能熟练度。
   *
   * 之前魂技是「拿到就固定威力」，抽到好技能之后没有任何培养空间。
   * 现在每级 +8% 威力（`skill_level_power`），10 级封顶，
   * 消耗按 `level^1.6` 递增——和装备强化同一套成本曲线，玩家好理解。
   */
  skillLevel(openid, skillId) {
    return Number(
      this.db.prepare('SELECT level FROM player_skill WHERE openid = ? AND skill_id = ?').get(String(openid), Number(skillId))?.level ?? 1,
    );
  }

  skillUpgradeCost(level) {
    const cfg = this.#cfgAll();
    return Math.round(Number(cfg.skill_upgrade_base ?? 500) * Math.pow(Math.max(1, Number(level)), 1.6));
  }

  /** 把技能按等级换算成实际威力（战斗里用这个） */
  effectiveSkill(openid, skill) {
    if (!skill) return skill;
    const cfg = this.#cfgAll();
    const lv = this.skillLevel(openid, skill.id);
    const per = Number(cfg.skill_level_power ?? 8);
    return { ...skill, level: lv, power: Math.round(Number(skill.power ?? 100) * (1 + (per / 100) * (lv - 1))) };
  }

  upgradeSkill(openid, skillId) {
    const cfg = this.#cfgAll();
    const max = Math.max(1, Number(cfg.skill_max_level ?? 10));
    const cur = this.skillLevel(openid, skillId);
    if (cur >= max) return { error: 'maxed', level: cur, max };
    const cost = this.skillUpgradeCost(cur);
    const p = this.get(openid);
    if (Number(p.gold) < cost) return { error: 'no_gold', need: cost, have: Number(p.gold) };

    this.addGold(openid, -cost, `魂技升级 #${skillId}`);
    this.db
      .prepare(
        `INSERT INTO player_skill (openid, skill_id, level) VALUES (?,?,2)
         ON CONFLICT(openid, skill_id) DO UPDATE SET level = level + 1`,
      )
      .run(String(openid), Number(skillId));
    return { ok: true, level: cur + 1, cost, max };
  }

  /* ---------------- 伙伴（魂灵 / 战宠 / 战魂 / 集卡） ---------------- */

  #companionContent() {
    return new Map(this.content.db.prepare('SELECT * FROM companion').all().map((r) => [r.id, r]));
  }

  /** 玩家持有的全部伙伴，把内容字段拼上 */
  ownedCompanions(openid) {
    const byId = this.#companionContent();
    return this.db
      .prepare('SELECT * FROM companion_owned WHERE openid = ? ORDER BY active DESC, id')
      .all(openid)
      .map((o) => {
        const c = byId.get(o.companion_id) ?? {};
        return {
          ...c,
          instanceId: o.id,
          companion_id: o.companion_id,
          level: o.level,
          active: o.active,
          kind: o.kind || c.kind || '',
          name: c.name ?? `#${o.companion_id}`,
        };
      });
  }

  /**
   * 参与加成的伙伴。
   *
   * 集卡（kind=card）**收集即生效**，不用出战——这是和同类插件最不一样的一点：
   * 那边要「声明/升等级」才给加成，玩家得先把卡养起来才有收益，
   * 这里抽到就算数，图鉴感更强。
   */
  activeCompanions(openid) {
    return this.ownedCompanions(openid).filter((c) => c.kind === 'card' || Number(c.active) === 1);
  }

  /** 发一个伙伴 */
  grantCompanion(openid, companionId, reason = '') {
    const c = this.content.db.prepare('SELECT * FROM companion WHERE id = ?').get(Number(companionId));
    if (!c) throw new Error(`没有这个伙伴：${companionId}`);
    const r = this.db
      .prepare('INSERT INTO companion_owned (openid, companion_id, kind, level, active, obtained_at) VALUES (?,?,?,1,0,?)')
      .run(openid, c.id, c.kind, Date.now());
    if (reason) {
      this.db
        .prepare('INSERT INTO tx_log (openid, kind, ref_id, delta, balance, reason, at) VALUES (?,?,?,?,?,?,?)')
        .run(openid, 'companion', c.id, 1, Number(r.lastInsertRowid), reason, Date.now());
    }
    /**
     * 必须重算：集卡是「收集即生效」的，发到手里就该加属性。
     * 不重算的话要等玩家下一次穿装备/升级才生效，玩家会以为卡没用。
     */
    this.recalc(openid);
    return { instanceId: Number(r.lastInsertRowid), name: c.name, kind: c.kind };
  }

  /**
   * 出战 / 收回。同类只能上一个（库里有部分唯一索引兜底）。
   */
  setCompanionActive(openid, name, on) {
    const all = this.ownedCompanions(openid);
    const target = all.find((c) => c.name === name);
    if (!target) return { error: 'not_owned', name };
    if (target.kind === 'card') return { error: 'card_passive', name };

    if (!on) {
      if (Number(target.active) !== 1) return { error: 'not_active', name };
      this.db.prepare('UPDATE companion_owned SET active = 0 WHERE id = ?').run(target.instanceId);
      return { ok: true, item: target, player: this.recalc(openid) };
    }

    if (Number(target.active) === 1) return { error: 'already', name };
    const occupied = all.find((c) => Number(c.active) === 1 && c.kind === target.kind);
    if (occupied) return { error: 'slot_taken', name, kind: target.kind, by: occupied.name };
    this.db.prepare('UPDATE companion_owned SET active = 1 WHERE id = ?').run(target.instanceId);
    return { ok: true, item: target, player: this.recalc(openid) };
  }

  /**
   * 穿装备。一个部位只能穿一件（库里有部分唯一索引兜底，这里先给人话提示）。
   * @returns {{ok:true, item:object}|{error:string, ...}}
   */
  equipItem(openid, name) {
    const all = this.owned(openid);
    const target = all.find((e) => e.name === name && Number(e.equipped) === 0);
    if (!target) {
      const worn = all.find((e) => e.name === name && Number(e.equipped) === 1);
      if (worn) return { error: 'already', name };
      return { error: 'not_owned', name };
    }
    const occupied = all.find((e) => Number(e.equipped) === 1 && e.part === target.part);
    if (occupied) return { error: 'slot_taken', name, part: target.part, by: occupied.name };

    this.db.prepare('UPDATE equip_owned SET equipped = 1 WHERE id = ?').run(target.instanceId);
    const p = this.recalc(openid);
    return { ok: true, item: target, player: p };
  }

  /** 脱装备：按部位或名字都行 */
  unequipItem(openid, key) {
    const all = this.owned(openid);
    const worn = all.filter((e) => Number(e.equipped) === 1);
    const target = worn.find((e) => e.part === key) ?? worn.find((e) => e.name === key);
    if (!target) return { error: 'not_worn', key };
    this.db.prepare('UPDATE equip_owned SET equipped = 0 WHERE id = ?').run(target.instanceId);
    const p = this.recalc(openid);
    return { ok: true, item: target, player: p };
  }

  /** 发一件装备（面板和掉落都用它） */
  grantEquip(openid, equipId, reason = '') {
    const c = this.content.db.prepare('SELECT * FROM equip WHERE id = ?').get(Number(equipId));
    if (!c) throw new Error(`没有这个装备：${equipId}`);
    const r = this.db
      .prepare('INSERT INTO equip_owned (openid, equip_id, part, level, equipped, obtained_at) VALUES (?,?,?,1,0,?)')
      .run(openid, c.id, c.part, Date.now());
    if (reason) {
      this.db
        .prepare('INSERT INTO tx_log (openid, kind, ref_id, delta, balance, reason, at) VALUES (?,?,?,?,?,?,?)')
        .run(openid, 'equip', c.id, 1, Number(r.lastInsertRowid), reason, Date.now());
    }
    // 装备本身没穿，属性不变；但保持「发完就重算」的约定，省得以后加被动效果漏掉
    this.recalc(openid);
    return { instanceId: Number(r.lastInsertRowid), name: c.name, part: c.part };
  }

  /** 魂环数 */
  ringCount(openid) {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM ring WHERE openid = ?').get(openid);
    return Number(r?.n ?? 0);
  }

  /**
   * 重算属性并落库。
   *
   * 升级、附加魂环、改内容表之后都调它——因为属性是**算出来的**，不是累加的。
   * 这样改数值/改公式后，所有角色下一次动作就自动对齐，不会出现新老角色对不上。
   */
  recalc(openid) {
    const p = this.get(openid);
    if (!p) return null;
    const w = this.content.db.prepare('SELECT * FROM wuhun WHERE id = ?').get(p.wuhun_id);
    if (!w) return p;
    const rings = this.ringCount(openid);
    const mods = this.mods(openid);
    const attrs = computeAttrs({ wuhun: w, level: p.level, ringCount: rings, cfg: this.#cfgAll(), flat: mods.flat, mult: mods.mult });
    // 生命/魂力按上限等比保留当前比例（升级回满、受伤按比例）
    const hpRatio = p.hp_max > 0 ? p.hp / p.hp_max : 1;
    const mpRatio = p.mp_max > 0 ? p.mp / p.mp_max : 1;
    const hp = Math.max(1, Math.round(attrs.hp_max * hpRatio));
    const mp = Math.max(0, Math.round(attrs.mp_max * mpRatio));
    /**
     * 战力也落库。
     * 它是算出来的，但排行榜要按它排序——SQL 排不了 JS 函数，
     * 所以每次重算时顺手写一份。属于「冗余但必要」的字段。
     */
    const pw = power({ ...attrs, level: p.level }, this.#cfgAll());
    this.db
      .prepare(
        `UPDATE player SET hp=?, hp_max=?, mp=?, mp_max=?, atk=?, def=?, spd=?, str=?, intel=?,
                          dodge=?, crit=?, crit_dmg=?, power=? WHERE openid=?`,
      )
      .run(hp, attrs.hp_max, mp, attrs.mp_max, attrs.atk, attrs.def, attrs.spd,
           attrs.str, attrs.intel, attrs.dodge, attrs.crit, attrs.crit_dmg, pw, openid);
    return this.get(openid);
  }

  /** 加经验并处理升级，返回 { before, after, leveled, capped } */
  /** 5 分钟内算在线 */
  #online(id) {
    const o = this.get(id);
    return Boolean(o) && Date.now() - Number(o.last_seen || 0) < 5 * 60_000;
  }

  /**
   * 经验加成。
   *
   * 情侣关系以前只是个记录，玩家没有任何理由去建立它。
   * 这里给「同时在线 +15%」——不是无条件的，得两个人都真的在玩，
   * 否则就变成"挂个情侣位白嫖经验"。
   */
  expRate(openid) {
    const cfg = this.#cfgAll();
    const per = Number(cfg.couple_exp_bonus ?? 0.15);
    if (per <= 0) return 0;
    const rows = this.db
      .prepare("SELECT from_openid, to_openid FROM relation WHERE kind = 'couple' AND status = 'active' AND (from_openid = ? OR to_openid = ?)")
      .all(String(openid), String(openid));
    let rate = 0;
    for (const r of rows) {
      const other = r.from_openid === openid ? r.to_openid : r.from_openid;
      if (this.#online(other)) rate += per;
    }
    return rate;
  }

  /** 徒弟涨经验，师父分一份（不递归） */
  #feedMaster(openid, exp) {
    const cfg = this.#cfgAll();
    const share = Number(cfg.apprentice_exp_share ?? 0.05);
    if (share <= 0) return null;
    /**
     * 方向：`from_openid` 是**徒弟**（发起拜师的人），`to_openid` 是师父。
     * 早期写反了（查 to_openid = 徒弟），结果师父永远收不到分成。
     */
    const r = this.db
      .prepare("SELECT to_openid FROM relation WHERE kind = 'master' AND status = 'active' AND from_openid = ?")
      .get(String(openid));
    if (!r) return null;
    const master = this.get(r.to_openid);
    if (!master) return null;
    const give = Math.max(1, Math.round(Number(exp) * share));
    const res = applyExp(master, give, this.ringCount(master.openid), cfg);
    this.db.prepare('UPDATE player SET level = ?, exp = ? WHERE openid = ?').run(res.level, res.exp, master.openid);
    if (res.leveled > 0) this.recalc(master.openid);
    return { master: master.name, exp: give };
  }

  gainExp(openid, amount) {
    const p = this.get(openid);
    if (!p) return null;
    const cfg = this.#cfgAll();
    const rings = this.ringCount(openid);
    // 情侣同时在线 → 经验加成
    const bonus = this.expRate(openid);
    const gained = Math.max(0, Math.round(Number(amount) * (1 + bonus)));
    const r = applyExp(p, gained, rings, cfg);
    this.db.prepare('UPDATE player SET level=?, exp=?, last_seen=? WHERE openid=?').run(r.level, r.exp, Date.now(), openid);
    // 师徒：师父分一份
    const share = gained > 0 ? this.#feedMaster(openid, gained) : null;
    if (r.leveled > 0) {
      // 升级回满
      this.recalc(openid);
      this.db.prepare('UPDATE player SET hp=hp_max, mp=mp_max WHERE openid=?').run(openid);
      return { before: p, after: this.get(openid), leveled: r.leveled, capped: r.capped, expNeed: r.need, cap: r.cap, ringCount: rings, bonus, gained, share };
    }
    return { before: p, after: this.get(openid), leveled: 0, capped: r.capped, expNeed: r.need, cap: r.cap, ringCount: rings, bonus, gained, share };
  }

  /**
   * 使用物品（批量操作用）。
   * 和 `使用` 指令共用同一套效果判断，避免两处逻辑走偏。
   */
  useItem(openid, name, qty = 1) {
    const n = Math.max(1, Math.trunc(Number(qty) || 1));
    const d = this.detail(openid);
    if (!d) return { error: 'no_player' };
    const inv = d.inventory.find((i) => i.name === name);
    if (!inv) return { error: 'no_item', name };
    if (Number(inv.qty) < n) return { error: 'not_enough', have: Number(inv.qty) };
    const item = this.content.db.prepare('SELECT * FROM item WHERE id = ?').get(inv.item_id);
    if (!item) return { error: 'no_item', name };
    const p = this.get(openid);

    /**
     * 原版物品的三个门槛，我们之前一个都没做：
     *   - 「最小使用等级 / 最大使用等级」：1 级小号不能直接吃 90 级丹药
     *   - 「每天次数」：升级卷这类不能无限吃
     * 不做的话，导入的原版物品里有相当一部分会变成「1 级就能吃满级道具」。
     */
    const lv = Number(p.level);
    const minLv = Number(item.min_level ?? 1);
    const maxLv = Number(item.max_level ?? 0);
    if (minLv > 1 && lv < minLv) return { error: 'level_low', need: minLv, have: lv, name: item.name };
    if (maxLv > 0 && lv > maxLv) return { error: 'level_high', need: maxLv, have: lv, name: item.name };

    const dailyLimit = Number(item.daily_limit ?? 0);
    if (dailyLimit > 0) {
      const day = new Date().toISOString().slice(0, 10);
      const used = Number(
        this.db.prepare('SELECT n FROM item_daily WHERE openid = ? AND item_id = ? AND day = ?').get(openid, item.id, day)?.n ?? 0,
      );
      if (used + n > dailyLimit) return { error: 'daily_limit', limit: dailyLimit, used, name: item.name };
      this.db
        .prepare(
          `INSERT INTO item_daily (openid, item_id, day, n) VALUES (?,?,?,?)
           ON CONFLICT(openid, item_id, day) DO UPDATE SET n = n + ?`,
        )
        .run(openid, item.id, day, n, n);
    }

    let text = '';
    let extra = null;
    if (item.effect === 'heal_hp') {
      const heal = Math.min(Number(item.amount) * n, p.hp_max - p.hp);
      if (heal <= 0) return { error: 'full' };
      this.db.prepare('UPDATE player SET hp = hp + ? WHERE openid = ?').run(heal, openid);
      text = `生命 +${heal}`;
    } else if (item.effect === 'heal_mp') {
      const heal = Math.min(Number(item.amount) * n, p.mp_max - p.mp);
      if (heal <= 0) return { error: 'full' };
      this.db.prepare('UPDATE player SET mp = mp + ? WHERE openid = ?').run(heal, openid);
      text = `魂力 +${heal}`;
    } else if (item.effect === 'add_gold') {
      this.addGold(openid, Number(item.amount) * n, `使用 ${item.name}`);
      text = `魂币 +${Number(item.amount) * n}`;
    } else if (item.effect === 'add_exp') {
      this.gainExp(openid, Number(item.amount) * n);
      text = `经验 +${Number(item.amount) * n}`;
    } else if (item.effect === 'add_level') {
      /**
       * 「能力上升=等级」——原版的升级卷。
       * 不走 gainExp（那会受经验曲线限制），直接改 level 再 recalc。
       */
      const cap = Number(this.#cfgAll().max_level ?? 99);
      const up = Math.min(n * Math.max(1, Number(item.amount) || 1), Math.max(0, cap - lv));
      if (up <= 0) return { error: 'level_cap', name: item.name };
      this.db.prepare('UPDATE player SET level = level + ? WHERE openid = ?').run(up, openid);
      this.recalc(openid);
      text = `等级 +${up}（现在 Lv.${lv + up}）`;
    } else if (item.effect === 'teleport') {
      const target = this.content.db
        .prepare('SELECT * FROM map WHERE name = ? AND enabled = 1')
        .get(String(item.teleport_map ?? '').trim());
      if (!target) return { error: 'no_map', name: item.name };
      this.db.prepare('UPDATE player SET map_id = ? WHERE openid = ?').run(target.id, openid);
      text = `传送到 ${target.name}`;
      extra = { map: target.name };
    } else if (item.effect === 'open_box') {
      /**
       * 「内涵道具」——礼包。
       * 原版格式是「物品名*数量|物品名*数量」，按名字匹配到 item。
       */
      const raw = String(item.contains ?? '').trim();
      if (!raw || raw === '[]') return { error: 'unusable', name: item.name };
      let parts = [];
      if (raw.startsWith('[')) {
        try {
          parts = JSON.parse(raw).map((x) => ({ name: x.name, qty: Number(x.qty ?? 1) }));
        } catch {
          parts = [];
        }
      } else {
        parts = raw
          .split('|')
          .filter(Boolean)
          .map((seg) => {
            const [nm, qy] = seg.split('*');
            return { name: String(nm ?? '').trim(), qty: Math.max(1, Number(qy) || 1) };
          });
      }
      const got = [];
      for (const part of parts) {
        const row = this.content.db.prepare('SELECT id, name FROM item WHERE name = ?').get(part.name);
        if (!row) continue;
        this.addItem(openid, row.id, part.qty * n, `开启 ${item.name}`);
        got.push(`${row.name}×${part.qty * n}`);
      }
      if (!got.length) return { error: 'unusable', name: item.name };
      text = `开出 ${got.join(' · ')}`;
    } else {
      return { error: 'unusable', name: item.name };
    }

    // 「附加状态 / 自身附加」——原版物品也能上状态
    const stKey = String(item.give_status ?? '').trim();
    if (stKey) {
      const chance = Number(item.give_status_chance ?? 100);
      if (Math.random() * 100 < chance) {
        const def = this.content.db.prepare('SELECT * FROM status_def WHERE key = ? OR name = ?').get(stKey, stKey);
        if (def) extra = { ...(extra ?? {}), status: def.name };
      }
    }

    this.addItem(openid, item.id, -n, `使用 ${name}`);
    return { ok: true, text, extra };
  }

  /**
   * 被动回血：非战斗状态下按离线分钟数恢复。
   *
   * 为什么必须有：之前玩家连打几场就残血，又没回血手段，
   * 第 4 场必死——「没有恢复手段」是挂机类文游最典型的劝退点。
   *
   * 战斗中 / 阵亡时不回（否则战斗就没有压力了）。
   * 每次读面板、每次开战前都会结算一次，所以不用定时器。
   */
  regen(openid) {
    const p = this.get(openid);
    if (!p || p.status !== 'idle') return p;
    if (p.hp >= p.hp_max && p.mp >= p.mp_max) return p;
    const cfg = this.#cfgAll();
    const rate = Math.max(0, Number(cfg.regen_percent_per_min ?? 2));
    const mins = (Date.now() - Number(p.last_seen || Date.now())) / 60000;
    if (mins < 0.5) return p;
    const heal = Math.floor((Number(p.hp_max) * rate) / 100 * mins);
    if (heal <= 0) return p;
    const hp = Math.min(Number(p.hp_max), Number(p.hp) + heal);
    const mp = Math.min(Number(p.mp_max), Number(p.mp) + heal);
    this.db.prepare('UPDATE player SET hp = ?, mp = ? WHERE openid = ?').run(hp, mp, openid);
    return this.get(openid);
  }

  /**
   * 休息：立刻回满，有冷却。
   * 被动回血太慢，战斗间隙玩家需要一个「明确地恢复」的动作。
   */
  rest(openid) {
    const p = this.get(openid);
    if (!p) return { error: 'no_player' };
    if (p.status === 'battle') return { error: 'in_battle' };
    if (p.status === 'dead') return { error: 'dead' };
    const cfg = this.#cfgAll();
    const cd = Math.max(0, Number(cfg.rest_cooldown_sec ?? 60)) * 1000;
    const wait = Number(p.last_rest_at ?? 0) + cd - Date.now();
    if (cd && wait > 0) return { error: 'cooldown', wait: Math.ceil(wait / 1000) };

    const before = { hp: Number(p.hp), mp: Number(p.mp) };
    this.db
      .prepare('UPDATE player SET hp = hp_max, mp = mp_max, last_rest_at = ? WHERE openid = ?')
      .run(Date.now(), openid);
    const after = this.get(openid);
    return { ok: true, healedHp: Number(after.hp) - before.hp, healedMp: Number(after.mp) - before.mp, player: after };
  }

  /** 加魂币（走流水） */
  addGold(openid, delta, reason = '') {
    const p = this.get(openid);
    if (!p) return null;
    const next = Math.max(0, Number(p.gold) + Number(delta));
    this.db.prepare('UPDATE player SET gold = ? WHERE openid = ?').run(next, openid);
    this.db
      .prepare('INSERT INTO tx_log (openid, kind, ref_id, delta, balance, reason, at) VALUES (?,?,?,?,?,?,?)')
      .run(openid, 'gold', 0, Math.trunc(delta), next, reason, Date.now());
    return next;
  }

  /** 加物品 */
  addItem(openid, itemId, qty = 1, reason = '') {
    const cur = this.db.prepare('SELECT qty FROM inventory WHERE openid = ? AND item_id = ?').get(openid, itemId);
    const next = Math.max(0, Number(cur?.qty ?? 0) + Number(qty));
    if (next === 0) {
      this.db.prepare('DELETE FROM inventory WHERE openid = ? AND item_id = ?').run(openid, itemId);
    } else {
      this.db
        .prepare(
          `INSERT INTO inventory (openid, item_id, qty) VALUES (?,?,?)
           ON CONFLICT(openid, item_id) DO UPDATE SET qty = excluded.qty`,
        )
        .run(openid, itemId, next);
    }
    if (qty) {
      this.db
        .prepare('INSERT INTO tx_log (openid, kind, ref_id, delta, balance, reason, at) VALUES (?,?,?,?,?,?,?)')
        .run(openid, 'item', itemId, Math.trunc(qty), next, reason, Date.now());
    }
    return next;
  }
}

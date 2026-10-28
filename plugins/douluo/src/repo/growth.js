/**
 * 养成类系统：宝石镶嵌 / 功法血脉 / 暗器 / 双生武魂 / 耐久
 * =====================================================
 *
 * 归并思路：
 *   - **功法 + 血脉**：都是「学一门 → 永久加属性（可能带魂技）」，一张 `aptitude` + kind。
 *   - **宝石**：挂在装备实例的孔位上，属性并进该装备的加成里（不新开一套计算）。
 *   - **暗器**：一次性的高倍率攻击，用 `hidden_weapon` 表。
 *   - **双生武魂**：主副两个武魂 id 互换，不新建表（存在 `player_ext.sub_wuhun_id`）。
 *   - **耐久**：装备实例上的一列，归零就不给加成。
 */
const now = () => Date.now();

export class GrowthRepo {
  constructor(game, content, players, economy) {
    this.db = game;
    this.content = content;
    this.players = players;
    this.economy = economy;
  }

  #cfg() {
    return this.content.allCfg();
  }

  /* ================= 宝石镶嵌 ================= */

  gems() {
    return this.content.db.prepare('SELECT * FROM gem WHERE enabled = 1 ORDER BY rarity, id').all();
  }

  #findEquip(openid, name) {
    return this.players.owned(openid).find((e) => e.name === name) ?? null;
  }

  /** 装备的孔位：已开的孔 = 已插宝石的孔数 + 空孔 */
  slots(equipId) {
    return this.db.prepare('SELECT * FROM gem_slot WHERE equip_id = ? ORDER BY slot').all(Number(equipId));
  }

  /** 开孔：每件装备最多 gem_slot_max 个孔 */
  openSlot(openid, equipName) {
    const e = this.#findEquip(openid, equipName);
    if (!e) return { error: 'not_owned', name: equipName };
    const cfg = this.#cfg();
    const max = Math.max(1, Number(cfg.gem_slot_max ?? 3));
    const opened = Number(e.holes ?? 0);
    if (opened >= max) return { error: 'max_holes', max };
    const cost = Math.round(Number(cfg.gem_open_cost ?? 500) * (opened + 1));
    const p = this.players.get(openid);
    if (Number(p.gold) < cost) return { error: 'no_gold', need: cost, have: Number(p.gold) };
    this.players.addGold(openid, -cost, `给 ${e.name} 开孔`);
    this.db.prepare('UPDATE equip_owned SET holes = holes + 1 WHERE id = ?').run(e.instanceId);
    return { ok: true, name: e.name, holes: opened + 1, max, cost };
  }

  /** 镶嵌：插到第一个空孔 */
  socket(openid, equipName, gemName) {
    const e = this.#findEquip(openid, equipName);
    if (!e) return { error: 'not_owned', name: equipName };
    const gem = this.content.db.prepare('SELECT * FROM gem WHERE name = ? AND enabled = 1').get(String(gemName));
    if (!gem) return { error: 'no_gem', name: gemName };
    const holes = Number(e.holes ?? 0);
    const used = this.slots(e.instanceId);
    if (used.length >= holes) return { error: 'no_hole', holes };

    const have = Number(
      this.db.prepare('SELECT qty FROM gem_owned WHERE openid = ? AND gem_id = ?').get(String(openid), gem.id)?.qty ?? 0,
    );
    if (have <= 0) return { error: 'no_stock', name: gem.name };

    const slot = holes - used.length; // 从高到低填
    this.db.prepare('INSERT OR REPLACE INTO gem_slot (equip_id, slot, gem_id) VALUES (?,?,?)').run(e.instanceId, slot, gem.id);
    this.db.prepare('UPDATE gem_owned SET qty = qty - 1 WHERE openid = ? AND gem_id = ?').run(String(openid), gem.id);
    const after = this.players.recalc(openid);
    return { ok: true, equip: e.name, gem: gem.name, slot, player: after };
  }

  /** 摘孔：宝石回到库存 */
  unsocket(openid, equipName, slot) {
    const e = this.#findEquip(openid, equipName);
    if (!e) return { error: 'not_owned', name: equipName };
    const s = this.slots(e.instanceId).find((x) => Number(x.slot) === Number(slot));
    if (!s) return { error: 'no_slot', slot };
    this.db.prepare('DELETE FROM gem_slot WHERE equip_id = ? AND slot = ?').run(e.instanceId, s.slot);
    this.db
      .prepare(
        `INSERT INTO gem_owned (openid, gem_id, qty) VALUES (?,?,1)
         ON CONFLICT(openid, gem_id) DO UPDATE SET qty = qty + 1`,
      )
      .run(String(openid), Number(s.gem_id));
    const after = this.players.recalc(openid);
    const gem = this.content.db.prepare('SELECT name FROM gem WHERE id = ?').get(s.gem_id);
    return { ok: true, gem: gem?.name ?? '', equip: e.name, player: after };
  }

  /** 发宝石（运营/抽奖用） */
  grantGem(openid, gemName, qty = 1) {
    const gem = this.content.db.prepare('SELECT * FROM gem WHERE name = ?').get(String(gemName));
    if (!gem) return { error: 'no_gem', name: gemName };
    this.db
      .prepare(
        `INSERT INTO gem_owned (openid, gem_id, qty) VALUES (?,?,?)
         ON CONFLICT(openid, gem_id) DO UPDATE SET qty = qty + ?`,
      )
      .run(String(openid), Number(gem.id), Number(qty), Number(qty));
    return { ok: true, gem: gem.name, qty };
  }

  /* ================= 功法 / 血脉 ================= */

  aptitudes(kind = '') {
    return kind
      ? this.content.db.prepare('SELECT * FROM aptitude WHERE kind = ? AND enabled = 1 ORDER BY rarity, id').all(String(kind))
      : this.content.db.prepare('SELECT * FROM aptitude WHERE enabled = 1 ORDER BY kind, rarity, id').all();
  }

  ownedAptitudes(openid) {
    return this.db
      .prepare('SELECT * FROM aptitude_owned WHERE openid = ?')
      .all(String(openid))
      .map((r) => {
        const a = this.content.db.prepare('SELECT * FROM aptitude WHERE id = ?').get(r.aptitude_id);
        return a ? { ...r, ...a, attrs: safeJson(a.attrs) } : null;
      })
      .filter(Boolean);
  }

  learn(openid, name) {
    const a = this.content.db.prepare('SELECT * FROM aptitude WHERE name = ? AND enabled = 1').get(String(name ?? '').trim());
    if (!a) return { error: 'no_aptitude', name };
    const has = this.db
      .prepare('SELECT 1 AS ok FROM aptitude_owned WHERE openid = ? AND aptitude_id = ?')
      .get(String(openid), a.id);
    if (has) return { error: 'already', name: a.name };

    const cost = safeJson(a.cost);
    try {
      this.economy.trade(String(openid), {
        pay: { gold: Number(cost.gold ?? 0), items: Array.isArray(cost.items) ? cost.items : [] },
        reason: `学习 ${a.name}`,
      });
    } catch (e) {
      return { error: 'trade', message: e.message };
    }
    this.db.prepare('INSERT INTO aptitude_owned (openid, aptitude_id, got_at) VALUES (?,?,?)').run(String(openid), a.id, now());
    const after = this.players.recalc(openid);
    return { ok: true, aptitude: a, attrs: safeJson(a.attrs), player: after };
  }

  /* ================= 暗器 ================= */

  weapons() {
    return this.content.db.prepare('SELECT * FROM hidden_weapon WHERE enabled = 1 ORDER BY price').all();
  }

  /** 暗器库存 */
  weaponStock(openid, weaponId) {
    return (
      this.db
        .prepare('SELECT qty FROM hidden_weapon_owned WHERE openid = ? AND weapon_id = ?')
        .get(String(openid), Number(weaponId))?.qty ?? 0
    );
  }

  buyWeapon(openid, name) {
    const w = this.content.db.prepare('SELECT * FROM hidden_weapon WHERE name = ? AND enabled = 1').get(String(name ?? '').trim());
    if (!w) return { error: 'no_weapon', name };
    try {
      this.economy.trade(String(openid), { pay: { gold: Number(w.price) }, reason: `购买暗器 ${w.name}` });
    } catch (e) {
      return { error: 'trade', message: e.message };
    }
    this.db
      .prepare(
        `INSERT INTO hidden_weapon_owned (openid, weapon_id, qty) VALUES (?,?,1)
         ON CONFLICT(openid, weapon_id) DO UPDATE SET qty = qty + 1`,
      )
      .run(String(openid), w.id);
    return { ok: true, weapon: w };
  }

  /* ================= 双生武魂 ================= */

  ext(openid) {
    let row = this.db.prepare('SELECT * FROM player_ext WHERE openid = ?').get(String(openid));
    if (!row) {
      this.db.prepare('INSERT INTO player_ext (openid) VALUES (?)').run(String(openid));
      row = this.db.prepare('SELECT * FROM player_ext WHERE openid = ?').get(String(openid));
    }
    return row;
  }

  /** 设置副武魂（第二武魂），之后可以随时互换 */
  setSubWuhun(openid, wuhunName) {
    const w = this.content.db.prepare('SELECT * FROM wuhun WHERE name = ? AND enabled = 1').get(String(wuhunName ?? '').trim());
    if (!w) return { error: 'no_wuhun', name: wuhunName };
    const p = this.players.get(openid);
    if (Number(p.wuhun_id) === Number(w.id)) return { error: 'same', name: w.name };
    this.ext(openid);
    this.db.prepare('UPDATE player_ext SET sub_wuhun_id = ? WHERE openid = ?').run(w.id, String(openid));
    return { ok: true, wuhun: w };
  }

  /** 主副互换 */
  swapWuhun(openid) {
    const p = this.players.get(openid);
    const e = this.ext(openid);
    if (!Number(e.sub_wuhun_id)) return { error: 'no_sub' };
    const cur = Number(p.wuhun_id);
    this.db.prepare('UPDATE player SET wuhun_id = ? WHERE openid = ?').run(e.sub_wuhun_id, String(openid));
    this.db.prepare('UPDATE player_ext SET sub_wuhun_id = ? WHERE openid = ?').run(cur, String(openid));
    const after = this.players.recalc(openid);
    const main = this.content.db.prepare('SELECT name FROM wuhun WHERE id = ?').get(e.sub_wuhun_id);
    const sub = this.content.db.prepare('SELECT name FROM wuhun WHERE id = ?').get(cur);
    return { ok: true, main: main?.name ?? '', sub: sub?.name ?? '', player: after };
  }

  /* ================= 耐久 ================= */

  /** 修理：name 为空则全修 */
  repair(openid, name = '') {
    const all = this.players.owned(openid);
    const cfg = this.#cfg();
    const max = Math.max(1, Number(cfg.durability_max ?? 100));
    const per = Math.max(0, Number(cfg.repair_cost_per_point ?? 5));
    const targets = name ? all.filter((e) => e.name === name) : all;
    if (!targets.length) return { error: name ? 'not_owned' : 'no_equip', name };

    const need = targets.reduce((s, e) => s + Math.max(0, max - Number(e.durability ?? max)), 0);
    if (need <= 0) return { error: 'full' };
    const cost = need * per;
    const p = this.players.get(openid);
    if (Number(p.gold) < cost) return { error: 'no_gold', need: cost, have: Number(p.gold) };

    this.players.addGold(openid, -cost, '装备修理');
    for (const e of targets) {
      this.db.prepare('UPDATE equip_owned SET durability = ? WHERE id = ?').run(max, e.instanceId);
    }
    const after = this.players.recalc(openid);
    return { ok: true, points: need, cost, count: targets.length, player: after };
  }

  /** 战斗后掉耐久（由 BattleRepo.finish 调用） */
  wear(openid) {
    const cfg = this.#cfg();
    const cost = Math.max(0, Number(cfg.durability_per_battle ?? 1));
    if (!cost) return;
    this.db
      .prepare(
        `UPDATE equip_owned SET durability = MAX(0, durability - ?)
          WHERE equipped = 1 AND id IN (SELECT id FROM equip_owned WHERE openid = ? AND equipped = 1)`,
      )
      .run(cost, String(openid));
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

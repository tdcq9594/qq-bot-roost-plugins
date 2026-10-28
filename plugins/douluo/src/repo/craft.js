/**
 * 生活职业与配方
 * ==============
 *
 * 归并：炼丹、合成、设计图、打造 —— 全是「配方 + 材料 → 产物」。
 * 同类插件给炼丹开一套（鼎/方/火/材/丹 五个指令），给合成再开一套，
 * 给设计图再开一套。这里只有 `recipe` 一张表 + 一个 `craft()`。
 *
 * 职业只是一列 `profession`，转职就是改这一列；配方用 `profession` 和
 * `level_req` 限制谁能做，不需要额外的「权限表」。
 */
import { withTx } from './player.js';

const now = () => Date.now();

export class CraftRepo {
  constructor(game, content, players, economy) {
    this.db = game;
    this.content = content;
    this.players = players;
    this.economy = economy;
  }

  #cfg() {
    return this.content.allCfg();
  }

  professions() {
    return this.content.db.prepare('SELECT * FROM profession WHERE enabled = 1 ORDER BY id').all();
  }

  /** 配方列表；kind 为空则全部 */
  recipes(kind = '') {
    const rows = kind
      ? this.content.db.prepare('SELECT * FROM recipe WHERE enabled = 1 AND kind = ? ORDER BY level_req, id').all(kind)
      : this.content.db.prepare('SELECT * FROM recipe WHERE enabled = 1 ORDER BY kind, level_req, id').all();
    return rows.map((r) => ({ ...r, cost: safeJson(r.cost) }));
  }

  /** 转职：换职业免费，但同一时间只有一个职业 */
  learn(openid, professionName) {
    const p = this.players.get(openid);
    if (!p) return { error: 'no_player' };
    const pro = this.content.db.prepare('SELECT * FROM profession WHERE name = ? AND enabled = 1').get(String(professionName ?? '').trim());
    if (!pro) return { error: 'no_profession', name: professionName };
    if (p.profession === pro.name) return { error: 'same', name: pro.name };
    const before = p.profession || '';
    this.db.prepare('UPDATE player SET profession = ? WHERE openid = ?').run(pro.name, openid);
    return { ok: true, profession: pro, before };
  }

  /**
   * 制作。材料/货币扣除和产出都在同一个事务里，
   * 中间任何一步失败都不会出现「材料没了东西没给」。
   */
  craft(openid, recipeName, times = 1) {
    const p = this.players.get(openid);
    if (!p) return { error: 'no_player' };
    const n = Math.max(1, Math.min(99, Math.trunc(Number(times) || 1)));
    const recipe = this.content.db.prepare('SELECT * FROM recipe WHERE name = ? AND enabled = 1').get(String(recipeName ?? '').trim());
    if (!recipe) return { error: 'no_recipe', name: recipeName };
    if (recipe.profession && p.profession !== recipe.profession) {
      return { error: 'wrong_profession', need: recipe.profession, have: p.profession || '无' };
    }
    if (Number(p.level) < Number(recipe.level_req)) {
      return { error: 'level', need: Number(recipe.level_req), have: Number(p.level) };
    }

    const cost = safeJson(recipe.cost);
    const pay = {
      gold: Number(cost.gold ?? 0) * n,
      items: (Array.isArray(cost.items) ? cost.items : []).map((it) => ({ id: Number(it.id), qty: Number(it.qty ?? 1) * n })),
    };

    const gain = { items: [], equips: [], companions: [] };
    const outQty = Math.max(1, Number(recipe.out_qty ?? 1)) * n;
    if (recipe.out_kind === 'equip') for (let i = 0; i < outQty; i += 1) gain.equips.push(recipe.out_id);
    else if (recipe.out_kind === 'companion') for (let i = 0; i < outQty; i += 1) gain.companions.push(recipe.out_id);
    else gain.items.push({ id: recipe.out_id, qty: outQty });

    try {
      this.economy.trade(openid, { pay, gain, reason: `制作 ${recipe.name}×${n}` });
    } catch (e) {
      return { error: 'trade', message: e.message };
    }

    // 熟练度：每做一次涨一点经验，让「练职业」有正反馈
    const exp = Math.max(0, Number(this.#cfg().craft_exp ?? 5)) * n;
    const r = this.players.gainExp(openid, exp);

    const outName = this.#outName(recipe);
    return { ok: true, recipe: recipe.name, qty: outQty, outName, exp, leveled: r?.leveled ?? 0 };
  }

  /* ================= 丹药（鼎 / 火 / 药材 / 品质） ================= */

  /**
   * 丹药和普通制作的差别：
   *
   * 普通制作（`制作`）是**必成**的——把材料换成产物，没有随机性。
   * 炼丹（`炼丹`）有**成功率**和**品质**，因为它们靠丹鼎和丹火：
   *   - 没鼎没火 → 基础成功率很低（55%）
   *   - 好鼎好火 → 可以顶到 95%
   *   - 成功之后按 roll 分下品/中品/上品，产量翻倍
   *
   * 这就是「丹鼎/丹火/药材/品质」四件套的意义：
   * 让炼药师这个职业有**装备投资**和**手艺成长**，而不是点一下就有。
   */
  alchemyTools(kind = '') {
    return kind
      ? this.content.db.prepare('SELECT * FROM alchemy_tool WHERE kind = ? AND enabled = 1 ORDER BY bonus').all(String(kind))
      : this.content.db.prepare('SELECT * FROM alchemy_tool WHERE enabled = 1 ORDER BY kind, bonus').all();
  }

  myTools(openid) {
    const e = this.db.prepare('SELECT furnace_id, fire_id FROM player_ext WHERE openid = ?').get(String(openid)) ?? {};
    const get = (id) => (Number(id) ? this.content.db.prepare('SELECT * FROM alchemy_tool WHERE id = ?').get(Number(id)) : null);
    return { furnace: get(e.furnace_id), fire: get(e.fire_id) };
  }

  /** 装备丹鼎或丹火（买 + 装一步到位，简化流程） */
  equipTool(openid, name) {
    const t = this.content.db.prepare('SELECT * FROM alchemy_tool WHERE name = ? AND enabled = 1').get(String(name ?? '').trim());
    if (!t) return { error: 'no_tool', name };
    const p = this.players.get(openid);
    if (!p) return { error: 'no_player' };
    const cur = this.myTools(openid);
    if (t.kind === 'furnace' && Number(cur.furnace?.id) === Number(t.id)) return { error: 'same', name: t.name };
    if (t.kind === 'fire' && Number(cur.fire?.id) === Number(t.id)) return { error: 'same', name: t.name };

    this.db.prepare('INSERT INTO player_ext (openid) VALUES (?) ON CONFLICT(openid) DO NOTHING').run(String(openid));
    const col = t.kind === 'furnace' ? 'furnace_id' : 'fire_id';
    this.db.prepare(`UPDATE player_ext SET ${col} = ? WHERE openid = ?`).run(t.id, String(openid));
    return { ok: true, tool: t, prev: t.kind === 'furnace' ? cur.furnace : cur.fire };
  }

  /** 当前炼丹成功率 */
  brewRate(openid, recipe) {
    const cfg = this.#cfg();
    const p = this.players.get(openid);
    const t = this.myTools(openid);
    const base = Number(cfg.alchemy_base_rate ?? 55);
    const cap = Number(cfg.alchemy_rate_cap ?? 95);
    /**
     * 等级加成必须**封顶**。
     * 实测 20 级炼 1 级丹方时，等级给了 +38%，直接把「丹鼎/丹火」的价值压没了——
     * 玩家没有理由去买鼎买火，四件套退化成一件。
     */
    const lvCap = Math.max(0, Number(cfg.alchemy_level_bonus_cap ?? 20));
    const lvBonus = Math.min(lvCap, Math.max(0, Number(p.level) - Number(recipe.level_req)) * Number(cfg.alchemy_level_bonus ?? 2));
    const rate = base + Number(t.furnace?.bonus ?? 0) + Number(t.fire?.bonus ?? 0) + lvBonus;
    return { rate: Math.max(1, Math.min(cap, Math.round(rate))), tools: t, base, cap };
  }

  /**
   * 炼丹。失败返还一半材料（不做「全损」——那是老式页游的劝退设计）。
   */
  brew(openid, recipeName, times = 1) {
    const p = this.players.get(openid);
    if (!p) return { error: 'no_player' };
    const n = Math.max(1, Math.min(20, Math.trunc(Number(times) || 1)));
    const recipe = this.content.db
      .prepare("SELECT * FROM recipe WHERE name = ? AND kind = 'alchemy' AND enabled = 1")
      .get(String(recipeName ?? '').trim());
    if (!recipe) return { error: 'no_recipe', name: recipeName };
    if (recipe.profession && p.profession !== recipe.profession) {
      return { error: 'wrong_profession', need: recipe.profession, have: p.profession || '无' };
    }
    if (Number(p.level) < Number(recipe.level_req)) {
      return { error: 'level', need: Number(recipe.level_req), have: Number(p.level) };
    }

    const { rate, tools } = this.brewRate(openid, recipe);
    const cost = safeJson(recipe.cost);
    const cfg = this.#cfg();
    const refund = Math.max(0, Math.min(1, Number(cfg.alchemy_refund ?? 0.5)));

    const results = { success: 0, fail: 0, quality: { 下品: 0, 中品: 0, 上品: 0 }, gained: 0 };
    for (let i = 0; i < n; i += 1) {
      const pay = {
        gold: Number(cost.gold ?? 0),
        items: (Array.isArray(cost.items) ? cost.items : []).map((it) => ({ id: Number(it.id), qty: Number(it.qty ?? 1) })),
      };
      const ok = Math.random() * 100 < rate;
      try {
        if (ok) {
          // 品质：下品 x1 / 中品 x2 / 上品 x3
          const roll = Math.random() * 100;
          const mult = roll < 50 ? 1 : roll < 85 ? 2 : 3;
          const label = mult === 1 ? '下品' : mult === 2 ? '中品' : '上品';
          results.quality[label] += 1;
          results.gained += mult;
          results.success += 1;
          this.economy.trade(String(openid), {
            pay,
            gain: { items: [{ id: recipe.out_id, qty: Math.max(1, Number(recipe.out_qty ?? 1)) * mult }] },
            reason: `炼丹 ${recipe.name}（${label}）`,
          });
        } else {
          results.fail += 1;
          // 失败：只扣一部分材料，钱照扣（火耗）
          const back = (Array.isArray(cost.items) ? cost.items : []).map((it) => ({
            id: Number(it.id),
            qty: Math.floor(Number(it.qty ?? 1) * refund),
          })).filter((it) => it.qty > 0);
          this.economy.trade(String(openid), {
            pay: { gold: Number(cost.gold ?? 0), items: pay.items },
            gain: { items: back },
            reason: `炼丹失败 ${recipe.name}（返还 ${Math.round(refund * 100)}% 材料）`,
          });
        }
      } catch (e) {
        if (i === 0) return { error: 'trade', message: e.message };
        break;
      }
    }

    const exp = Math.max(0, Number(cfg.craft_exp ?? 5)) * (results.success * 2 + results.fail);
    const lv = exp > 0 ? this.players.gainExp(openid, exp) : null;
    const outName = this.#outName(recipe);
    return { ok: true, recipe: recipe.name, outName, rate, tools, ...results, exp, leveled: lv?.leveled ?? 0 };
  }

  #outName(recipe) {
    const table = recipe.out_kind === 'equip' ? 'equip' : recipe.out_kind === 'companion' ? 'companion' : 'item';
    return this.content.db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(Number(recipe.out_id))?.name ?? `#${recipe.out_id}`;
  }

  /** 我的职业与能做什么 */
  myCraft(openid) {
    const p = this.players.get(openid);
    const list = this.recipes();
    const can = list.filter((r) => (!r.profession || r.profession === p.profession) && Number(p.level) >= Number(r.level_req));
    return { profession: p.profession || '', level: p.level, can, all: list };
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

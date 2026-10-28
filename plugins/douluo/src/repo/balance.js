/**
 * 数值体检
 * ========
 *
 * 把「内容表 + 系数」变成一张可读的平衡表，并给出健康判定。
 *
 * 为什么值得做：现在 cfg 里有 40 多个系数，运营改一个（比如
 * `attr_to_damage_div` 从 1000 改成 500），可能让 90 级玩家一回合秒掉
 * 万年级魂兽，而**没有任何地方会报警**——只能等玩家发截图。
 *
 * 这里复用 `resolveRound()`，所以模拟结果和线上完全一致。
 */
import { computeAttrs } from '../engine/stats.js';
import { expectedHit, mitigate, monsterLevel } from '../engine/formula.js';
import { monsterStats as calcMonster, sampleFight, expectedRings } from '../engine/balance.js';
import { resolveRound } from '../engine/battle.js';

const ATTR_KEYS = ['hp', 'mp', 'atk', 'def', 'spd', 'str', 'intel', 'dodge', 'crit', 'crit_dmg'];

export class BalanceRepo {
  constructor(game, content, players) {
    this.db = game;
    this.content = content;
    this.players = players;
    this._refWuhun = null;
  }

  #cfg() {
    return this.content.allCfg();
  }

  /**
   * 标准武魂 = 所有启用武魂的 **10 分位**。
   *
   * 为什么不是平均值：平均值会被极端值带偏。导入 39 个原著武魂之后，
   * 平均值从 12 涨到 35，怪物血量跟着翻三倍，拿初始武魂的新号被十年白虎打死。
   *
   * 为什么不是中位数：中位数代表「典型玩家」，但怪物的难度下限应该由
   * **偏弱的玩家**来定。实测 25 分位时，前 10 场胜率只有 40%——
   * 刚建号、武魂最差的那批人第一只怪就打不过，直接劝退。
   * 10 分位 = 「比十分之一的人强」，这样几乎所有人都能稳过同级怪，
   * 难度靠「去打更老的魂兽」来提供，而不是靠开局卡人。
   */
  refWuhun() {
    if (this._refWuhun) return this._refWuhun;
    const rows = this.content.db.prepare('SELECT * FROM wuhun WHERE enabled = 1').all();
    if (!rows.length) {
      this._refWuhun = { hp: 100, mp: 100, atk: 10, def: 10, spd: 10, str: 10, intel: 10, dodge: 5, crit: 5, crit_dmg: 150 };
      return this._refWuhun;
    }
    const out = {};
    for (const k of ATTR_KEYS) {
      const vals = rows.map((r) => Number(r[k] ?? 0)).sort((a, b) => a - b);
      out[k] = vals[Math.floor(vals.length * 0.1)] ?? vals[0] ?? 0;
    }
    this._refWuhun = out;
    return out;
  }

  /** 该等级的标准玩家（按应有魂环数） */
  referencePlayer(level) {
    const cfg = this.#cfg();
    const rings = expectedRings(level, cfg);
    const attrs = computeAttrs({ wuhun: this.refWuhun(), level, ringCount: rings, cfg });
    return { ...attrs, level, ringCount: rings, hp: attrs.hp_max, mp: attrs.mp_max };
  }

  /** 怪物属性（内容函数，与谁在打无关） */
  monsterStats(monster) {
    return calcMonster({
      monster,
      cfg: this.#cfg(),
      refWuhun: this.refWuhun(),
      computeAttrs,
      expectedHit,
      monsterLevel,
      mitigate,
    });
  }

  monsters() {
    return this.content.db.prepare('SELECT * FROM monster WHERE enabled = 1 ORDER BY age, id').all();
  }

  /**
   * 平衡矩阵：每只怪 × 每个等级段。
   * @param {{levels?:number[], samples?:number}} [opt]
   */
  report({ levels = [1, 10, 20, 30, 40, 50, 60, 70, 80, 90], samples = 60 } = {}) {
    const cfg = this.#cfg();
    const monsters = this.monsters();
    const rows = [];
    for (const m of monsters) {
      const stats = this.monsterStats(m);
      const cells = [];
      for (const lv of levels) {
        const p = this.referencePlayer(lv);
        const r = sampleFight({
          player: p,
          monster: stats,
          cfg,
          samples,
          resolveRound,
        });
        cells.push({ level: lv, ...r, verdict: verdictOf(r, stats.expectedRounds) });
      }
      rows.push({
        id: m.id,
        name: m.name,
        age: m.age,
        tier: m.tier,
        targetRounds: Number(m.target_rounds ?? 4),
        expectedRounds: stats.expectedRounds,
        standardLevel: stats.level,
        hp: stats.hp,
        def: stats.def,
        atk: stats.atk,
        cells,
      });
    }
    return { levels, samples, refWuhun: this.refWuhun(), rows };
  }

  /**
   * 健康判定。三条硬规则：
   *  1. 在怪自己的标准等级下，平均回合数要在 target±2 内
   *  2. 等级越高回合越少（成长必须有感）
   *  3. 标准等级下胜率要 ≥ 90%（打同级怪不该频繁翻车）
   */
  check({ samples = 80 } = {}) {
    const cfg = this.#cfg();
    const out = [];
    for (const m of this.monsters()) {
      const stats = this.monsterStats(m);
      const target = stats.expectedRounds;

      const atStd = sampleFight({ player: this.referencePlayer(stats.level), monster: stats, cfg, samples, resolveRound });
      out.push({
        name: m.name,
        rule: '标准等级回合数',
        expect: `${target}±2`,
        actual: `${atStd.avgRounds} 回合（Lv${stats.level}）`,
        ok: Math.abs(atStd.avgRounds - target) <= 2,
      });
      out.push({
        name: m.name,
        rule: '标准等级胜率',
        expect: '≥90%',
        actual: `${atStd.winRate}%`,
        ok: atStd.winRate >= 90,
      });

      // 成长感：Lv+20 打同一只怪应该明显更快
      // 已经顶到 99 级的怪没法再"升级"，这条跳过（不是失败）
      const canGrow = stats.level < 99;
      if (canGrow) {
        const hi = sampleFight({ player: this.referencePlayer(Math.min(99, stats.level + 20)), monster: stats, cfg, samples, resolveRound });
        out.push({
          name: m.name,
          rule: '升级 20 级后更快',
          expect: '< 标准回合数',
          actual: `${hi.avgRounds} < ${atStd.avgRounds}`,
          ok: hi.avgRounds < atStd.avgRounds,
        });
      }

      // 反过来的极端：低 20 级去打，应该明显吃力
      // 「打不过」或「回合数翻倍」都算吃力——不能要求一定输，
      // 否则 99 级怪的低级对照会永远失败（那个等级已经没得再降了）
      if (stats.level > 20) {
        const lo = sampleFight({ player: this.referencePlayer(stats.level - 20), monster: stats, cfg, samples, resolveRound });
        const muchSlower = lo.avgRounds >= atStd.avgRounds * 1.5;
        out.push({
          name: m.name,
          rule: '低 20 级明显吃力',
          expect: '胜率 <60% 或 回合数 ≥1.5×',
          actual: `${lo.winRate}% · ${lo.avgRounds} 回合`,
          ok: lo.winRate < 60 || muchSlower,
        });
      }
    }
    const failed = out.filter((x) => !x.ok);
    return { items: out, passed: out.length - failed.length, failed: failed.length, ok: failed.length === 0 };
  }
}

function verdictOf(cell, target) {
  if (cell.winRate < 80) return 'danger';
  if (Math.abs(cell.avgRounds - target) <= 2) return 'good';
  if (cell.avgRounds < target) return 'fast'; // 打得太快：可能是等级压制（正常）或数值失控
  return 'slow';
}

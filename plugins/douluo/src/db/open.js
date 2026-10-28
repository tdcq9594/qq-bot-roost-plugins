/**
 * 数据库打开与建表
 * ================
 *
 * 两个库，职责分开：
 *   content.db —— 内容（武魂/魂兽/魂技/物品/地图/任务/称号/系数）
 *                 **业务代码只读**，后台管理页才写。可以整体导出/导入/回滚。
 *   game.db    —— 玩家运行时数据（角色/背包/魂环/流水/管理日志）
 *
 * 用 Node 22 内置的 `node:sqlite`，不引第三方包。
 * 用 createRequire 探测而不是静态 import：静态 import 在低版本 Node 上
 * 会让整个插件加载失败，而这里要的是「没有 SQLite 就报个清楚的错」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');

/** 建表语句和测试数据都在同目录 */
const readSql = (name) => fs.readFileSync(path.join(HERE, name), 'utf8');

function openDatabase(file, { readOnly = false } = {}) {
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch {
    throw new Error('当前 Node 不支持 node:sqlite（需要 22.5 以上），斗罗插件无法启动');
  }
  if (typeof sqlite?.DatabaseSync !== 'function') {
    throw new Error('node:sqlite 里没有 DatabaseSync，斗罗插件无法启动');
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file, readOnly ? { readOnly: true } : {});
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 3000');
    db.exec('PRAGMA foreign_keys = ON');
  }
  return db;
}

/**
 * 补一列（幂等）。
 *
 * `CREATE TABLE IF NOT EXISTS` 不会给已存在的表加列，所以新版本要加字段
 * 必须走 ALTER。这里每次启动都检查一遍，缺了就加——老库自动升级，
 * 不用让用户删库重来。
 *
 * @returns {boolean} 是否真的加了
 */
export function ensureColumn(db, table, column, type = 'TEXT', dflt = "''") {
  let cols = [];
  try {
    cols = db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
  } catch {
    return false;
  }
  if (!cols.length || cols.includes(column)) return false;
  db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${type} DEFAULT ${dflt}`);
  return true;
}

/**
 * 打开（并在需要时初始化）两个库。
 *
 * @param {string} dataDir  ctx.dataDir
 * @param {{seed?: boolean}} [opts] seed=true 时，内容库为空会灌入测试数据
 */
export function openDbs(dataDir, { seed = true } = {}) {
  const contentFile = path.join(dataDir, 'content.db');
  const gameFile = path.join(dataDir, 'game.db');

  const content = openDatabase(contentFile);
  content.exec(readSql('content.sql'));

  // 空库才灌测试数据。已经有内容就绝不动它——后台改过的数据不能被覆盖。
  const hasContent = content.prepare('SELECT COUNT(*) AS n FROM wuhun').get().n > 0;
  if (seed && !hasContent) {
    content.exec(readSql('seed.sql'));
  }

  // 增量补丁每次都跑：新版本加的系数会在老库上自动补默认值，不覆盖已改的值
  content.exec(readSql('patch.sql'));

  // 内容包（从旧版 INI 生成，全部 INSERT OR IGNORE）：
  // 老库也能补上，不会覆盖后台改过的行。删掉这个文件就不加载。
  const pack = path.join(HERE, 'content-pack.sql');
  if (fs.existsSync(pack)) {
    try {
      content.exec(fs.readFileSync(pack, 'utf8'));
    } catch (e) {
      // 内容包坏了不能拖垮整个插件：跳过它，用已有的内容继续跑
      console.warn(`[douluo] 内容包加载失败，已跳过：${e.message}`);
    }
  }

  /**
   * post.sql：**依赖内容包**的增量（按名字给魂兽挂技能、按地图名加领地……）。
   * 必须排在内容包之后，否则 SELECT 会静默命中 0 行。
   */
  if (fs.existsSync(path.join(HERE, 'post.sql'))) {
    try {
      content.exec(readSql('post.sql'));
    } catch (e) {
      console.warn(`[douluo] post.sql 加载失败，已跳过：${e.message}`);
    }
  }

  // 图字段（v4）：武魂立绘 / 地图 / 魂兽 / 装备
  ensureColumn(content, 'wuhun', 'image');
  ensureColumn(content, 'map', 'image');
  ensureColumn(content, 'monster', 'image');
  ensureColumn(content, 'equip', 'image');
  ensureColumn(content, 'npc', 'image');

  const game = openDatabase(gameFile);
  game.exec(readSql('game.sql'));

  // 玩家身上的后加字段（v7）：职业、排位分
  ensureColumn(game, 'player', 'profession', 'TEXT', "''");
  ensureColumn(game, 'player', 'rank_score', 'INTEGER', '0');
  ensureColumn(game, 'player', 'last_rest_at', 'INTEGER', '0');
  ensureColumn(game, 'player', 'wins', 'INTEGER', '0');
  ensureColumn(game, 'player', 'boss_kills', 'INTEGER', '0');
  ensureColumn(game, 'equip_owned', 'durability', 'INTEGER', '100');
  ensureColumn(game, 'equip_owned', 'holes', 'INTEGER', '0');
  ensureColumn(game, 'player', 'power', 'INTEGER', '0');
  ensureColumn(game, 'territory', 'defense', 'INTEGER', '100');
  ensureColumn(game, 'player_ext', 'furnace_id', 'INTEGER', '0');
  ensureColumn(game, 'player_ext', 'fire_id', 'INTEGER', '0');
  ensureColumn(game, 'bounty', 'base', 'INTEGER', '0');
  ensureColumn(game, 'battle', 'player_status', 'TEXT', "'[]'");
  ensureColumn(game, 'battle', 'monster_status', 'TEXT', "'[]'");
  ensureColumn(game, 'battle', 'player_cd', 'TEXT', "'{}'");
  ensureColumn(game, 'battle', 'monster_cd', 'TEXT', "'{}'");

  /* ---------------- v24：对齐原版控制台的字段面 ---------------- */

  // 状态：原版 16 字段里我们缺的 6 个（力量/生命/魂力/暴伤/经验/金币）
  for (const c of ['str_pct', 'hp_pct', 'mp_pct', 'crit_dmg_pct', 'exp_pct', 'gold_pct']) {
    ensureColumn(content, 'status_def', c, 'INTEGER', '0');
  }

  // 魂技：效果类型 / 触发类型 / 连锁 / 限定系列 / 治疗量
  ensureColumn(content, 'skill', 'effect_type', 'TEXT', "'damage'");
  ensureColumn(content, 'skill', 'trigger_type', 'TEXT', "'active'");
  ensureColumn(content, 'skill', 'trigger_skill', 'INTEGER', '0');
  ensureColumn(content, 'skill', 'series_id', 'INTEGER', '0');
  ensureColumn(content, 'skill', 'heal_pct', 'INTEGER', '0');
  // 状态挂到谁身上：enemy（默认）/ self
  ensureColumn(content, 'skill_status', 'target', 'TEXT', "'enemy'");

  // 物品：原版「能力上升 / 传送 / 内涵道具 / 每天次数 / 等级区间 / 附加状态」
  ensureColumn(content, 'item', 'ability', 'TEXT', "''");
  ensureColumn(content, 'item', 'ability_amount', 'INTEGER', '0');
  ensureColumn(content, 'item', 'teleport_map', 'TEXT', "''");
  ensureColumn(content, 'item', 'contains', 'TEXT', "'[]'");
  ensureColumn(content, 'item', 'daily_limit', 'INTEGER', '0');
  ensureColumn(content, 'item', 'min_level', 'INTEGER', '1');
  ensureColumn(content, 'item', 'max_level', 'INTEGER', '0');
  ensureColumn(content, 'item', 'give_status', 'TEXT', "''");
  ensureColumn(content, 'item', 'give_status_chance', 'INTEGER', '100');

  // 魂兽：原版有独立的暴击/暴伤/闪避/敏捷
  ensureColumn(content, 'monster', 'crit', 'INTEGER', '0');
  ensureColumn(content, 'monster', 'crit_dmg', 'INTEGER', '150');
  ensureColumn(content, 'monster', 'dodge', 'INTEGER', '0');
  ensureColumn(content, 'monster', 'spd', 'INTEGER', '0');

  // 地图：建筑物 / 采集 / 钓鱼
  ensureColumn(content, 'map', 'building', 'TEXT', "''");
  ensureColumn(content, 'map', 'gather_item_id', 'INTEGER', '0');
  ensureColumn(content, 'map', 'gather_refresh', 'INTEGER', '0');
  ensureColumn(content, 'map', 'gather_need', 'TEXT', "''");
  ensureColumn(content, 'map', 'fish_item_id', 'INTEGER', '0');
  ensureColumn(content, 'map', 'fish_refresh', 'INTEGER', '0');
  ensureColumn(content, 'map', 'fish_need', 'TEXT', "''");

  // 职业：等级上限 + 经验
  ensureColumn(content, 'profession', 'max_level', 'INTEGER', '10');
  ensureColumn(content, 'profession', 'exp_bonus', 'INTEGER', '0');

  // 武魂：进化（原版「进化成武魂 / 需求等级 / 需求物品」）
  ensureColumn(content, 'wuhun', 'evolve_to', 'INTEGER', '0');
  ensureColumn(content, 'wuhun', 'evolve_level', 'INTEGER', '0');
  ensureColumn(content, 'wuhun', 'evolve_item', 'TEXT', "''");

  // 玩家 / 装备实例：职业经验、机甲能量、魂导器封印
  ensureColumn(game, 'player', 'prof_exp', 'INTEGER', '0');
  ensureColumn(game, 'player', 'prof_level', 'INTEGER', '1');
  ensureColumn(game, 'player', 'mecha_energy', 'INTEGER', '0');
  ensureColumn(game, 'equip_owned', 'sealed', 'INTEGER', '0');
  ensureColumn(game, 'battle', 'monster_crit', 'INTEGER', '0');
  ensureColumn(game, 'battle', 'monster_crit_dmg', 'INTEGER', '150');
  ensureColumn(game, 'battle', 'monster_dodge', 'INTEGER', '0');

  /**
   * console-pack.sql：从原版「斗罗控制台」的 89 个 ini 导入的内容
   * （79 状态 / 342 魂技 / 139 魂兽 / 108 地图 / 72 魂骨 / 53 武魂…）。
   *
   * 位置很关键，两个条件都要满足：
   *   1. 在 **所有 ensureColumn 之后** —— 它要写 `status_def.str_pct` 这些新列
   *   2. 在 **内容包 + post.sql 之后** —— 它靠名字回填地图连通、NPC 归属、武魂融合两侧
   * 生成器是 `scripts/import-console-ini.mjs`。
   */
  if (fs.existsSync(path.join(HERE, 'console-pack.sql'))) {
    try {
      content.exec(readSql('console-pack.sql'));
    } catch (e) {
      console.warn(`[douluo] console-pack.sql 加载失败，已跳过：${e.message}`);
    }
  }

  /**
   * post2.sql：依赖 **console-pack.sql** 的修补
   * （给导入的魂兽补掉落/技能、修正升级卷的 effect）。
   *
   * 顺序：content-pack → post → console-pack → post2。
   * 这些语句要看到导入后的行，放到 post.sql 里会静默命中 0 行。
   */
  if (fs.existsSync(path.join(HERE, 'post2.sql'))) {
    try {
      content.exec(readSql('post2.sql'));
    } catch (e) {
      console.warn(`[douluo] post2.sql 加载失败，已跳过：${e.message}`);
    }
  }

  // 地图连通 / 空地图配怪：SQLite 的相关子查询在 UPDATE/INSERT 里限制太多，
  // 这两件事用纯 JS 做，见文件末尾的说明。
  try {
    repairMapConnectivity(content);
  } catch (e) {
    console.warn(`[douluo] 地图连通修复失败，已跳过：${e.message}`);
  }
  try {
    repairMapMonsters(content);
  } catch (e) {
    console.warn(`[douluo] 出没补齐失败，已跳过：${e.message}`);
  }

  return {
    content,
    game,
    dataDir,
    contentFile,
    gameFile,
    close() {
      try {
        content.close();
      } catch {}
      try {
        game.close();
      } catch {}
    },
  };
}

export { openDatabase, PLUGIN_ROOT };

/**
 * 地图连通性修复。
 *
 * ## 为什么是 JS 不是 SQL
 *
 * SQLite 的 `UPDATE map SET north = (SELECT ... WHERE ... map.min_level ...)` 里
 * **不能引用外层表名**（报 no such column: map.min_level），`UPDATE ... FROM` 也一样。
 * 而这件事本身是一次 BFS，用 JS 写更直白，125 张图的开销可以忽略。
 *
 * ## 为什么必须双向
 *
 * 第一版只写了 `孤岛.north = 可达图` —— 意思是「从孤岛往北能出去」，
 * 但从起点 BFS **走不进来**（可达图那边没有指向孤岛的方向），
 * 所以日志写着「125/125 可达」而实际玩家只走得到 44 张。
 * 教训：连通性要按「能不能走到」验证，不能按「我改了几条边」验证。
 */
function repairMapConnectivity(content) {
  const rows = content.prepare('SELECT id, name, min_level, north, south, east, west FROM map WHERE enabled = 1').all();
  if (rows.length < 2) return;

  const byId = new Map(rows.map((r) => [r.id, r]));
  const DIRS = ['north', 'south', 'east', 'west'];

  const bfs = () => {
    const start = [...rows].sort((a, b) => (a.min_level ?? 1) - (b.min_level ?? 1) || a.id - b.id)[0];
    const seen = new Set([start.id]);
    const q = [start.id];
    while (q.length) {
      const cur = byId.get(q.shift());
      if (!cur) continue;
      for (const k of DIRS) {
        const to = Number(cur[k]) || 0;
        if (to && byId.has(to) && !seen.has(to)) {
          seen.add(to);
          q.push(to);
        }
      }
    }
    return seen;
  };

  const seen = bfs();
  if (seen.size >= rows.length) return;

  const setNorth = content.prepare('UPDATE map SET north = ? WHERE id = ?');
  const setDir = (dir, id, v) => content.prepare(`UPDATE map SET ${dir} = ? WHERE id = ?`).run(v, id);
  let fixed = 0;

  for (const r of rows) {
    if (seen.has(r.id)) continue;
    let best = null;
    let bestD = Infinity;
    for (const x of rows) {
      if (!seen.has(x.id)) continue;
      const d = Math.abs((x.min_level ?? 1) - (r.min_level ?? 1));
      if (d < bestD) {
        bestD = d;
        best = x;
      }
    }
    if (!best) break;

    // 双向：孤岛往北到 best，best 找一个空方向回指孤岛
    setNorth.run(best.id, r.id);
    const freeDir = DIRS.find((k) => !Number(best[k]));
    if (freeDir) {
      setDir(freeDir, best.id, r.id);
      best[freeDir] = r.id;
    } else {
      // best 四个方向都占了：把孤岛插进 best 的北向链里
      setNorth.run(best.north ?? best.id, r.id);
      setDir('north', best.id, r.id);
      best.north = r.id;
    }
    r.north = best.id;
    seen.add(r.id);
    fixed += 1;
  }
  if (fixed) console.log(`[douluo] 地图连通修复：${fixed} 张孤岛已双向接上`);
}

/**
 * 给「一只怪都没有」的地图配怪。
 *
 * 为什么是 JS：`INSERT ... SELECT ... WHERE m.age = (SELECT ... mp.min_level ...)`
 * 里引用外层别名会报 no such column（和地图连通同一个限制）。
 *
 * 排除功能区：商城/拍卖/银行这类地方本来就不该有魂兽。
 */
function repairMapMonsters(content) {
  const FN = ['商城', '商店', '拍卖', '银行', '铁匠', '客栈', '酒馆', '职业', '铸造'];
  const maps = content
    .prepare(
      `SELECT m.id, m.name, m.min_level FROM map m
       WHERE m.enabled = 1 AND NOT EXISTS (SELECT 1 FROM monster_map x WHERE x.map_id = m.id)`,
    )
    .all()
    .filter((m) => !FN.some((k) => String(m.name).includes(k)));
  if (!maps.length) return;

  const monsters = content.prepare('SELECT id, age FROM monster ORDER BY age, id').all();
  if (!monsters.length) return;

  // 等级 → 目标年龄：和内容包的年龄曲线同量级（10 级 ≈ 120，50 级 ≈ 30 万）
  const targetAge = (lv) => Math.max(10, Math.round(Math.pow(Math.max(1, lv), 2) * 120));
  const nearest = (age) => {
    let best = monsters[0];
    let bd = Infinity;
    for (const m of monsters) {
      const d = Math.abs(Number(m.age ?? 0) - age);
      if (d < bd) {
        bd = d;
        best = m;
      }
    }
    return best;
  };
  const shifted = (m, offset) => monsters[Math.min(monsters.length - 1, Math.max(0, monsters.indexOf(m) + offset))] ?? m;

  const ins = content.prepare('INSERT OR IGNORE INTO monster_map (monster_id, map_id) VALUES (?,?)');
  let n = 0;
  for (const m of maps) {
    const first = nearest(targetAge(Number(m.min_level ?? 1)));
    ins.run(first.id, m.id);
    // 第二只错开几档，避免一张图只有一种怪
    ins.run(shifted(first, 3).id, m.id);
    n += 1;
  }
  if (n) console.log(`[douluo] 出没补齐：${n} 张空地图各配了 2 只魂兽`);
}

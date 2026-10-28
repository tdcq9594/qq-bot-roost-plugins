/**
 * 内容深度审计
 * ============
 *
 *   node plugins/douluo/scripts/audit-content.mjs
 *
 * 回答一个问题：**每张内容表「够不够撑起它对应的玩法」？**
 *
 * 只看三件事：
 *   1. 条目数（是不是只有两三条测试数据）
 *   2. 字段填充率（有没有一半字段是空的默认值）
 *   3. 覆盖面（每个地图有没有怪、每个职业有没有配方、每档魂环有没有魂技……）
 *
 * 输出按「严重程度」排序，方便决定先补哪里。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { openDbs } = await import(pathToFileURL(path.join(HERE, '..', 'src', 'db', 'open.js')).href);

const DATA_DIR = path.join(os.tmpdir(), 'douluo-audit');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
const { content } = openDbs(DATA_DIR, { seed: true });

const q = (sql, ...args) => content.prepare(sql).get(...args);
const all = (sql, ...args) => content.prepare(sql).all(...args);

/* ---------------- 每张表的「目标条目数」 ---------------- */

/**
 * 这个数字不是拍脑袋：它大致等于「该玩法能撑几次选择」。
 * 低于这个数，玩家很快就会看到重复内容。
 */
const TARGET = {
  wuhun: 20, wuhun_series: 5, map: 20, monster: 40, npc: 15, item: 40,
  quest: 20, skill: 12, title: 10, equip: 15, companion: 12, profession: 4,
  recipe: 12, shop: 5, gem: 8, aptitude: 8, hidden_weapon: 3, guild_shop: 3,
  tutorial: 5, signin_reward: 7, rank_def: 6, challenge: 4, alchemy_tool: 4,
  territory_def: 2, monster_map: 20,
};

const tables = all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .map((r) => r.name)
  .filter((n) => !['cfg', 'content_meta', 'schema_version'].includes(n));

const rows = [];
for (const t of tables) {
  const cols = all(`PRAGMA table_info(${t})`).map((c) => c.name);
  const total = q(`SELECT COUNT(*) n FROM ${t}`).n;
  const enabled = cols.includes('enabled') ? q(`SELECT COUNT(*) n FROM ${t} WHERE enabled = 1`).n : total;
  // 字段填充率：排除 id/enabled/desc 这类结构性字段
  const soft = cols.filter((c) => !['id', 'enabled', 'desc', 'name', 'key'].includes(c));
  let filled = 0;
  let slots = 0;
  if (total && soft.length) {
    for (const c of soft) {
      const v = q(`SELECT COUNT(*) n FROM ${t} WHERE ${c} IS NOT NULL AND ${c} != '' AND ${c} != 0`).n;
      filled += v;
      slots += total;
    }
  }
  const fillRate = slots ? Math.round((filled / slots) * 100) : 100;
  const target = TARGET[t] ?? 0;
  const thin = target && enabled < target;
  rows.push({ table: t, total, enabled, fillRate, target, thin, gap: thin ? target - enabled : 0 });
}

/* ---------------- 覆盖面检查 ---------------- */

const gaps = [];

// 每张图有没有怪
const noMob = all(`SELECT m.name FROM map m WHERE m.enabled = 1
  AND NOT EXISTS (SELECT 1 FROM monster_map mm WHERE mm.map_id = m.id)`);
if (noMob.length) gaps.push({ level: '高', what: '没有魂兽的地图', detail: `${noMob.length} 张：${noMob.slice(0, 6).map((x) => x.name).join(' / ')}` });

// 每张图有几只怪（<2 就是单调）
const fewMob = all(`SELECT m.name, COUNT(mm.monster_id) n FROM map m
  LEFT JOIN monster_map mm ON mm.map_id = m.id WHERE m.enabled = 1
  GROUP BY m.id HAVING n < 2`);
if (fewMob.length) gaps.push({ level: '中', what: '只有 0–1 只魂兽的地图', detail: `${fewMob.length} 张` });

// 每个职业有没有配方
const noRecipe = all(`SELECT p.name FROM profession p WHERE p.enabled = 1
  AND NOT EXISTS (SELECT 1 FROM recipe r WHERE r.profession = p.name AND r.enabled = 1)`);
if (noRecipe.length) gaps.push({ level: '高', what: '没有配方的职业', detail: noRecipe.map((x) => x.name).join(' / ') });

// 魂兽有没有技能
const noSkill = q(`SELECT COUNT(*) n FROM monster m WHERE m.enabled = 1
  AND NOT EXISTS (SELECT 1 FROM monster_skill ms WHERE ms.monster_id = m.id)`).n;
if (noSkill) gaps.push({ level: '中', what: '没有技能的魂兽', detail: `${noSkill} / ${q('SELECT COUNT(*) n FROM monster WHERE enabled=1').n} 只` });

// 魂技够不够覆盖 10 个魂环槽
const skillN = q('SELECT COUNT(*) n FROM skill WHERE enabled = 1').n;
if (skillN < 10) gaps.push({ level: '高', what: '魂技数量不足（10 个魂环槽）', detail: `只有 ${skillN} 个` });

// 称号条件覆盖
const titleN = q('SELECT COUNT(*) n FROM title WHERE enabled = 1').n;
if (titleN < 8) gaps.push({ level: '中', what: '称号太少', detail: `只有 ${titleN} 个` });

// 丹方与药材
const herbN = q("SELECT COUNT(*) n FROM item WHERE kind = 'herb'").n;
const alchemyN = q("SELECT COUNT(*) n FROM recipe WHERE kind = 'alchemy'").n;
if (alchemyN < 6) gaps.push({ level: '中', what: '丹方太少', detail: `${alchemyN} 个（药材 ${herbN} 种）` });

// 装备部位覆盖
const parts = all('SELECT part, COUNT(*) n FROM equip WHERE enabled = 1 GROUP BY part');
const PART_ALL = ['head', 'torso', 'body', 'arm_l', 'arm_r', 'leg_l', 'leg_r', 'conduct_atk', 'conduct_def', 'domain', 'mecha', 'ship', 'spirit_atk', 'spirit_def'];
const missingPart = PART_ALL.filter((p) => !parts.some((x) => x.part === p));
if (missingPart.length) gaps.push({ level: '中', what: '没有装备的部位', detail: missingPart.join(' / ') });

// 商店货架
const shelfN = q('SELECT COUNT(DISTINCT shop_id) n FROM shop_item').n;
if (shelfN < 3) gaps.push({ level: '中', what: '商店货架太少', detail: `${shelfN} 个` });

// 挑战分层奖励
const chN = q('SELECT COUNT(*) n FROM challenge WHERE enabled = 1').n;
if (chN < 4) gaps.push({ level: '中', what: '挑战玩法不足', detail: `${chN} 个` });

/* ---------------- 报告 ---------------- */

const thin = rows.filter((r) => r.thin).sort((a, b) => b.gap - a.gap);
const empty = rows.filter((r) => r.enabled === 0 && r.target);

console.log(`=== 内容表 ${rows.length} 张 ===\n`);
console.log('表名'.padEnd(18) + '条目'.padStart(6) + '目标'.padStart(6) + '填充率'.padStart(8));
for (const r of rows.sort((a, b) => b.gap - a.gap || a.fillRate - b.fillRate)) {
  const flag = r.thin ? '⚠' : ' ';
  console.log(`${flag} ${r.table.padEnd(16)}${String(r.enabled).padStart(6)}${String(r.target || '-').padStart(6)}${String(r.fillRate + '%').padStart(8)}`);
}

console.log(`\n=== 内容不足（低于目标条目数）${thin.length} 张 ===`);
for (const r of thin) console.log(`  ${r.table}: ${r.enabled} / ${r.target}（差 ${r.gap}）`);

if (empty.length) {
  console.log(`\n=== 完全没有内容的表 ${empty.length} 张 ===`);
  for (const r of empty) console.log(`  ${r.table}`);
}

console.log(`\n=== 覆盖面问题 ${gaps.length} 条 ===`);
for (const g of gaps.sort((a, b) => (a.level === '高' ? -1 : 1))) {
  console.log(`  [${g.level}] ${g.what} — ${g.detail}`);
}

const lowFill = rows.filter((r) => r.fillRate < 40 && r.enabled >= 3);
if (lowFill.length) {
  console.log(`\n=== 字段填充率低（大量空字段）${lowFill.length} 张 ===`);
  for (const r of lowFill) console.log(`  ${r.table}: ${r.fillRate}%`);
}

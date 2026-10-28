/**
 * 旧版 INI → 内容包生成器
 * ======================
 *
 *   node plugins/douluo/scripts/import-ini.mjs [--src 目录] [--out 文件] [--dry]
 *
 * 输入：`D:/WorkBuddy/源/CAQ/斗罗大陆数据/*.ini`（GBK 编码）
 * 输出：`src/db/content-pack.sql`（`INSERT OR IGNORE`，可重复执行）
 *
 * ## 只「参考」，不照抄
 *
 * 旧版数值是另一套公式算出来的（史莱姆 age=50 就有 466 血），
 * 直接搬过来会把我们的平衡打崩。所以这里只取三样东西：
 *
 *   1. **名字**（原著向的魂兽/地图/NPC/物品/武魂）
 *   2. **关系**（哪只怪出没在哪张图、哪张图连哪张图、NPC 在哪）
 *   3. **年龄/描述**（魂兽年龄决定魂环年限，是原著设定）
 *
 * 数值全部由我们自己的模型生成：
 *   tier / target_rounds / exp_rate / gold_rate ← 按年龄分档
 *   生命/攻/防                                ← engine/balance.js 现算
 *
 * 这样导入后 `GET /balance/check` 仍然是全绿的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SRC = 'D:/WorkBuddy/源/CAQ/斗罗大陆数据';
const DEFAULT_OUT = path.join(HERE, '..', 'src', 'db', 'content-pack.sql');

/** ID 段：和手写种子（1–99）错开，避免撞车 */
const ID = { map: 1000, monster: 1000, npc: 1000, item: 1000, wuhun: 100, series: 10, quest: 100 };

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const SRC = arg('--src', DEFAULT_SRC);
const OUT = arg('--out', DEFAULT_OUT);
const DRY = argv.includes('--dry');

/* ---------------- INI 解析 ---------------- */

function parseIni(file) {
  const buf = fs.readFileSync(file);
  // 旧数据是 GBK；Node 没内置 GBK 解码，用 TextDecoder（ICU 里有 gbk）
  let text;
  try {
    text = new TextDecoder('gbk').decode(buf);
  } catch {
    text = buf.toString('utf8');
  }
  const out = {};
  let cur = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      cur = line.slice(1, -1).trim();
      if (!out[cur]) out[cur] = {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0 || !cur) continue;
    out[cur][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const isTrue = (v) => String(v ?? '').trim() === '真';
const num = (v, d = 0) => {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) && n !== 0 ? n : d;
};
const splitAt = (v) =>
  String(v ?? '')
    .split('@')
    .map((x) => x.trim())
    .filter(Boolean);

/* ---------------- 数值分档（我们的模型） ---------------- */

/**
 * 魂兽年龄 → 品阶 / 目标回合 / 收益倍率。
 * 分档依据原著：十年 / 百年 / 千年 / 万年 / 十万年。
 */
function bandOf(age) {
  if (age >= 1000000) return { tier: 'boss', rounds: 12, exp: 60, gold: 40, label: '百万年' };
  if (age >= 100000) return { tier: 'boss', rounds: 12, exp: 30, gold: 20, label: '十万年' };
  if (age >= 10000) return { tier: 'boss', rounds: 12, exp: 12, gold: 8, label: '万年' };
  if (age >= 1000) return { tier: 'elite', rounds: 8, exp: 4, gold: 3, label: '千年' };
  if (age >= 100) return { tier: 'normal', rounds: 5, exp: 1.8, gold: 1.4, label: '百年' };
  return { tier: 'normal', rounds: 4, exp: 1, gold: 1, label: '十年' };
}

/**
 * 把原始年龄「按排名压缩」到可玩阶梯。
 *
 * 为什么要压：旧版的 `魂兽年龄` 是另一套等级曲线算的，45 只怪里中位数是 7 万，
 * 按年龄硬分档会得到 32 个 BOSS——开局就没怪可打。
 *
 * 压缩规则：**只保留相对强弱**（旧版里更老的怪，压完还是更老），
 * 但把年龄铺到 十年→百年→千年→万年→十万年→百万年 六个档位上。
 * 这样魂环颜色、掉落年限、难度三者仍然一致。
 */
const LADDER = [
  { n: 12, base: 10, step: 7, cap: 90 }, // 十年（白）
  { n: 11, base: 100, step: 70, cap: 900 }, // 百年（黄）
  { n: 10, base: 1000, step: 800, cap: 9000 }, // 千年（紫）
  { n: 7, base: 10000, step: 11000, cap: 90000 }, // 万年（黑）
  { n: 4, base: 100000, step: 200000, cap: 900000 }, // 十万年（红）
  { n: 99, base: 1000000, step: 0, cap: 1000000 }, // 百万年（金）
];

function ladderAge(rank) {
  let left = rank;
  for (const b of LADDER) {
    if (left < b.n) return Math.min(b.cap, b.base + left * b.step);
    left -= b.n;
  }
  return 1000000;
}

/* ---------------- 读取 ---------------- */

function read(name) {
  const p = path.join(SRC, `${name}.ini`);
  if (!fs.existsSync(p)) return {};
  return parseIni(p);
}

const rawMaps = read('地图数据');
const rawMonsters = { ...read('魂兽列表'), ...read('BOSS列表') };
const rawNpcs = read('NPC列表');
const rawItems = read('物品列表');
const rawQuests = read('任务列表');
const rawWuhun = read('武魂信息');
const rawSeries = read('武魂系列');

/* ---------------- 地图 ---------------- */

const maps = Object.entries(rawMaps)
  .filter(([, v]) => isTrue(v['是否创建']))
  .map(([name, v], i) => ({
    id: ID.map + i,
    name,
    desc: v['地图描述'] ?? '',
    portal: isTrue(v['传送阵']) ? 1 : 0,
    northName: v['前'] ?? '',
    southName: v['后'] ?? '',
    westName: v['左'] ?? '',
    eastName: v['右'] ?? '',
    npcs: splitAt(v['NPC列表']),
  }));

const mapIdByName = new Map(maps.map((m) => [m.name, m.id]));
const link = (n) => mapIdByName.get(String(n ?? '').trim()) ?? 'NULL';

/* ---------------- 魂兽 ---------------- */

const monsters = [];
{
  // 先按原始年龄排序，再按排名压到可玩阶梯（只保留相对强弱）
  const raw = Object.entries(rawMonsters)
    .filter(([, v]) => isTrue(v['是否创建']))
    .map(([name, v]) => ({ name, srcAge: num(v['魂兽年龄'], 10), spawn: String(v['魂兽出没地图'] ?? '').trim() }))
    .sort((a, b) => a.srcAge - b.srcAge);

  raw.forEach((m, rank) => {
    const age = ladderAge(rank);
    const band = bandOf(age);
    monsters.push({
      id: ID.monster + rank,
      name: m.name,
      age,
      srcAge: m.srcAge,
      ...band,
      spawn: m.spawn,
      desc: `${band.label}魂兽${m.spawn ? `，出没于${m.spawn}` : ''}（原著年龄 ${m.srcAge} 年）`,
    });
  });
}

/* ---------------- NPC ---------------- */

const npcs = [];
for (const [name, v] of Object.entries(rawNpcs)) {
  if (!isTrue(v['是否存在'])) continue;
  const mapName = String(v['所在地图'] ?? '').trim();
  const quests = splitAt(v['任务列表']);
  npcs.push({
    id: ID.npc + npcs.length,
    name,
    mapName,
    mapId: link(mapName),
    dialog: v['平常对话'] || (quests.length ? `我这有 ${quests.length} 个任务。` : ''),
    quests,
  });
}

/* ---------------- 物品 ---------------- */

const items = [];
for (const [name, v] of Object.entries(rawItems)) {
  if (!isTrue(v['是否存在'])) continue;
  const healHp = num(v['生命恢复']);
  const healMp = num(v['魂力恢复']);
  const levelUp = String(v['能力上升'] ?? '').includes('等级');
  let kind = 'material';
  let effect = '';
  let amount = 0;
  if (healHp > 0) {
    kind = 'consumable';
    effect = 'heal_hp';
    amount = healHp;
  } else if (healMp > 0) {
    kind = 'consumable';
    effect = 'heal_mp';
    amount = healMp;
  } else if (levelUp) {
    kind = 'consumable';
    effect = 'add_exp';
    amount = 500;
  }
  const scene = String(v['使用场景'] ?? '');
  items.push({
    id: ID.item + items.length,
    name,
    kind,
    use_scene: scene.includes('战斗中') ? 'battle' : scene.includes('战斗外') ? 'out' : 'any',
    price: num(v['出售价格'], 0),
    effect,
    amount,
    tradeable: isTrue(v['可交易性']) || String(v['可交易性'] ?? '') === '' ? 1 : 0,
    desc: (v['说明'] ?? '').slice(0, 120),
  });
}

/* ---------------- 武魂 / 系列 ---------------- */

/**
 * 武魂属性要缩放到**本插件自己的量级**。
 *
 * 旧版武魂攻击是 20–60，我们的手写种子是 8–14（两套公式）。
 * 直接搬进来会让「标准武魂」中位数从 9 涨到 40，怪物血量跟着翻四倍，
 * 拿初始武魂的新号连十年白虎都打不过。
 *
 * 做法：按属性分别缩放，让**导入集的中位数**等于我们种子的中位数。
 * 相对强弱完全保留（旧版里攻击高的还是高），只是换了个刻度。
 */
const SEED_MEDIAN = { atk: 9.5, def: 10, mp: 130, hp: 130, spd: 11.5, str: 9.5, intel: 15.5, dodge: 6, crit: 6.5, critDmg: 152 };

function median(arr) {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
}

const series = Object.entries(rawSeries)
  .filter(([, v]) => isTrue(v['是否创建']))
  .map(([name, v], i) => ({
    id: ID.series + i,
    name,
    hp: num(v['生命'], 1),
    mp: num(v['魂力'], 1),
    atk: num(v['攻击力'], 1),
    def: num(v['防御力'], 1),
    spd: num(v['攻击速度'], 1),
    str: num(v['力量'], 1),
    intel: num(v['精神力'], 1),
  }));
const seriesIdByName = new Map(series.map((s) => [s.name, s.id]));

const wuhunRaw = Object.entries(rawWuhun)
  .filter(([, v]) => isTrue(v['是否创建']))
  .map(([name, v], i) => ({
    id: ID.wuhun + i,
    name,
    seriesName: String(v['武魂系列'] ?? '').trim(),
    raw: {
      atk: num(v['武魂攻击'], 10),
      def: num(v['武魂防御'], 10),
      mp: num(v['武魂魂力'], 100),
      spd: num(v['武魂敏捷'], 10),
      str: num(v['武魂力量'], 10),
      intel: num(v['武魂精神力'], 10),
      dodge: num(v['武魂闪避'], 5),
      crit: num(v['武魂暴击率'], 5),
      critDmg: num(v['武魂暴击伤害'], 150),
    },
    desc: (v['武魂描述'] ?? '').slice(0, 120),
  }));

// 按属性缩放，让导入集的中位数对齐我们种子的中位数
const rawMedian = Object.fromEntries(
  Object.keys(SEED_MEDIAN)
    .filter((k) => k !== 'hp')
    .map((k) => [k, median(wuhunRaw.map((w) => w.raw[k]))]),
);
const scaleOf = (k) => (rawMedian[k] > 0 ? SEED_MEDIAN[k] / rawMedian[k] : 1);
const sc = (v, k, min = 1) => Math.max(min, Math.round(Number(v) * scaleOf(k)));

const wuhuns = wuhunRaw.map((w) => {
  const mp = sc(w.raw.mp, 'mp', 50);
  return {
    id: w.id,
    name: w.name,
    seriesName: w.seriesName,
    atk: sc(w.raw.atk, 'atk', 3),
    def: sc(w.raw.def, 'def', 3),
    mp,
    /**
     * 生命不能写成 `魂力 × 2`。
     *
     * 旧版没有「生命」字段，早期用 mp×2 折算，结果导入集的血量是 260，
     * 而手写种子的武魂只有 100–150——「标准武魂」被拉到 260，
     * 怪物攻击力按 260 血的玩家来定，拿初始武魂（120 血）的新号一开战就被打死。
     * 现在按**种子里的 hp/mp 比例**折算，让导入武魂的血量也落在 120–150。
     */
    hp: Math.max(60, Math.round(mp * (SEED_MEDIAN.hp / SEED_MEDIAN.mp))),
    spd: sc(w.raw.spd, 'spd', 3),
    str: sc(w.raw.str, 'str', 3),
    intel: sc(w.raw.intel, 'intel', 3),
    dodge: Math.min(30, sc(w.raw.dodge, 'dodge', 1)),
    crit: Math.min(30, sc(w.raw.crit, 'crit', 1)),
    critDmg: Math.min(220, Math.max(120, Math.round(w.raw.critDmg * (SEED_MEDIAN.critDmg / (rawMedian.critDmg || 152))))),
    // 稀有度按**原始**攻击排（缩放后都挤在一起了）
    rarity: w.raw.atk >= 60 ? 4 : w.raw.atk >= 45 ? 3 : w.raw.atk >= 30 ? 2 : 1,
    desc: w.desc,
  };
});

/* ---------------- 任务（只导能表达的） ---------------- */

const monsterIdByName = new Map(monsters.map((m) => [m.name, m.id]));
const itemIdByName = new Map(items.map((it) => [it.name, it.id]));

const quests = [];
const skippedQuests = [];
for (const [name, v] of Object.entries(rawQuests)) {
  if (!isTrue(v['是否存在'])) continue;
  const cond = {};
  const reward = {};

  if (isTrue(v['达成条件-杀掉怪物'])) {
    const raw = String(v['达成条件-杀掉怪物-内容'] ?? '').trim();
    // 旧版写成「魔狼*3」或「魔狼」
    const [mName, cnt] = raw.split('*');
    const mid = monsterIdByName.get(String(mName ?? '').trim());
    if (!mid) {
      skippedQuests.push(`${name}（找不到魂兽「${mName}」）`);
      continue;
    }
    cond.kill = { monster_id: mid, count: num(cnt, 3) };
  }
  if (isTrue(v['达成条件-达到某级'])) {
    cond.level = num(v['达成条件-达到某级-内容'], 10);
  }
  if (isTrue(v['达成条件-收集物品'])) {
    const raw = String(v['达成条件-收集物品-内容'] ?? '').trim();
    const [iName, cnt] = raw.split('*');
    const iid = itemIdByName.get(String(iName ?? '').trim());
    if (!iid) {
      skippedQuests.push(`${name}（找不到物品「${iName}」）`);
      continue;
    }
    cond.items = [{ id: iid, qty: num(cnt, 1) }];
  }
  if (!Object.keys(cond).length) {
    skippedQuests.push(`${name}（只有 NPC 对话条件，暂不支持）`);
    continue;
  }

  if (isTrue(v['任务奖励-货币'])) reward.gold = num(v['任务奖励-货币-内容'], 100);
  if (isTrue(v['任务奖励-经验'])) reward.exp = num(v['任务奖励-经验-内容'], 100);
  if (isTrue(v['任务奖励-物品'])) {
    const raw = String(v['任务奖励-物品-内容'] ?? '').trim();
    const [iName, cnt] = raw.split('*');
    const iid = itemIdByName.get(String(iName ?? '').trim());
    if (iid) reward.item = [{ id: iid, qty: num(cnt, 1) }];
  }

  quests.push({
    id: ID.quest + quests.length,
    name,
    desc: String(v['任务说明'] ?? '').slice(0, 160),
    cond,
    reward,
  });
}

/* ---------------- 输出 SQL ---------------- */

/**
 * 地图最低等级 = 这张图上最弱魂兽的标准等级。
 * 这样「星斗中心」自然要求高等级，不用手工一个个填。
 */
const stdLevel = (age) => Math.max(1, Math.round(((-36 + Math.sqrt(36 * 36 + 4 * 14 * age)) / 14) * 2 / 4));
const mapMinLevel = new Map();
for (const m of monsters) {
  const mid = mapIdByName.get(m.spawn);
  if (!mid) continue;
  mapMinLevel.set(mid, Math.min(mapMinLevel.get(mid) ?? 99, stdLevel(m.age)));
}

/* ---------------- 补空洞：空地图配怪、孤立地图连路 ---------------- */

// 1) 没有魂兽的地图：按「等级接近」补 2–3 只，让每张图都能打
const assignedTo = new Map(); // mapId -> [monster]
for (const m of monsters) {
  const mid = mapIdByName.get(m.spawn);
  if (!mid) continue;
  if (!assignedTo.has(mid)) assignedTo.set(mid, []);
  assignedTo.get(mid).push(m);
}
const extraSpawns = [];
for (const map of maps) {
  if (assignedTo.has(map.id)) continue;
  const target = mapMinLevel.get(map.id) ?? 1;
  // 挑标准等级最接近的 3 只（允许和别的图重复，怪本来就到处都有）
  const near = [...monsters]
    .sort((a, b) => Math.abs(stdLevel(a.age) - target) - Math.abs(stdLevel(b.age) - target))
    .slice(0, 3);
  for (const m of near) extraSpawns.push({ monster: m.name, map: map.name });
  assignedTo.set(map.id, near);
}

// 2) 孤立地图（四个方向都没连）：接到等级最接近的那张图上
const linked = new Set();
for (const m of maps) {
  for (const n of [m.northName, m.southName, m.westName, m.eastName]) {
    if (n && mapIdByName.has(String(n).trim())) {
      linked.add(m.name);
      linked.add(String(n).trim());
    }
  }
}
const orphans = maps.filter((m) => !linked.has(m.name));
const extraLinks = [];
for (const o of orphans) {
  const lvO = mapMinLevel.get(o.id) ?? 1;
  const cand = maps
    .filter((x) => x.name !== o.name)
    .sort((a, b) => Math.abs((mapMinLevel.get(a.id) ?? 1) - lvO) - Math.abs((mapMinLevel.get(b.id) ?? 1) - lvO))[0];
  if (!cand) continue;
  // 双向连：孤岛的北 → 候选图；候选图的南 → 孤岛（如果南边空着）
  extraLinks.push({ from: o.name, to: cand.name });
}

const q = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;
const lines = [];
const push = (s) => lines.push(s);

push('-- ============================================================');
push('-- 自动生成，请勿手改：node plugins/douluo/scripts/import-ini.mjs');
push(`-- 来源：${SRC}`);
push(`-- 地图 ${maps.length} · 魂兽 ${monsters.length} · NPC ${npcs.length} · 物品 ${items.length} · 武魂 ${wuhuns.length} · 系列 ${series.length} · 任务 ${quests.length}`);
push('--');
push('-- 只参考了旧版的「名字 / 关系 / 年龄」，数值全部按本插件模型重算。');
push('-- 全部 INSERT OR IGNORE，重复执行安全，也不会覆盖后台改过的行。');
push('-- ============================================================');
push('');

if (series.length) {
  push('-- ---------- 武魂系列 ----------');
  for (const s of series) {
    push(
      `INSERT OR IGNORE INTO wuhun_series (id, name, hp, mp, str, intel, atk, def, spd) VALUES (${s.id}, ${q(s.name)}, ${s.hp}, ${s.mp}, ${s.str}, ${s.intel}, ${s.atk}, ${s.def}, ${s.spd});`,
    );
  }
  push('');
}

if (wuhuns.length) {
  push('-- ---------- 武魂 ----------');
  for (const w of wuhuns) {
    push(
      `INSERT OR IGNORE INTO wuhun (id, name, series_id, rarity, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (${w.id}, ${q(w.name)}, ${w.seriesName ? `(SELECT id FROM wuhun_series WHERE name = ${q(w.seriesName)})` : 'NULL'}, ${w.rarity}, ${w.hp}, ${w.mp}, ${w.atk}, ${w.def}, ${w.spd}, ${w.str}, ${w.intel}, ${w.dodge}, ${w.crit}, ${w.critDmg}, ${q(w.desc)});`,
    );
  }
  push('');
}

if (maps.length) {
  push('-- ---------- 地图 ----------');
  push('-- 先只插名字，不写方向：方向要靠名字回查 id，得等所有图都插完');
  for (const m of maps) {
    push(
      `INSERT OR IGNORE INTO map (name, portal, min_level, desc) VALUES (${q(m.name)}, ${m.portal}, ${mapMinLevel.get(m.id) ?? 1}, ${q(m.desc)});`,
    );
  }
  push('');
  push('-- 再按名字回填方向（这样和手写种子的同名地图也能连上，不依赖 id）');
  for (const m of maps) {
    const dirs = [
      ['north', m.northName],
      ['south', m.southName],
      ['west', m.westName],
      ['east', m.eastName],
    ];
    const sets = dirs
      .filter(([, n]) => n && mapIdByName.has(String(n).trim()))
      .map(([col, n]) => `${col} = (SELECT id FROM map WHERE name = ${q(String(n).trim())})`);
    if (!sets.length) continue;
    push(`UPDATE map SET ${sets.join(', ')} WHERE name = ${q(m.name)};`);
  }
  push('');
  if (extraLinks.length) {
    push('-- 孤立地图接一条路（按等级最接近），否则玩家永远走不到');
    for (const l of extraLinks) {
      push(`UPDATE map SET north = (SELECT id FROM map WHERE name = ${q(l.to)}) WHERE name = ${q(l.from)} AND north IS NULL;`);
      push(`UPDATE map SET south = (SELECT id FROM map WHERE name = ${q(l.from)}) WHERE name = ${q(l.to)} AND south IS NULL;`);
    }
    push('');
  }
}

if (monsters.length) {
  push('-- ---------- 魂兽 ----------');
  for (const m of monsters) {
    push(
      `INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (${m.id}, ${q(m.name)}, ${q(m.tier)}, ${m.rounds}, ${m.age}, 1, 1, 1, ${m.exp}, ${m.gold}, 1, ${q(m.desc)});`,
    );
  }
  push('');
  push('-- ---------- 魂兽出没 ----------');
  for (const m of monsters) {
    const mid = mapIdByName.get(m.spawn);
    if (!mid) continue;
    push(
      `INSERT OR IGNORE INTO monster_map (monster_id, map_id) VALUES (${m.id}, (SELECT id FROM map WHERE name = ${q(m.spawn)}));`,
    );
  }
  if (extraSpawns.length) {
    push('-- 空地图补怪：按等级接近分配，保证每张图都能打');
    for (const e of extraSpawns) {
      push(
        `INSERT OR IGNORE INTO monster_map (monster_id, map_id) VALUES ((SELECT id FROM monster WHERE name = ${q(e.monster)}), (SELECT id FROM map WHERE name = ${q(e.map)}));`,
      );
    }
  }
  push('');
}

if (npcs.length) {
  push('-- ---------- NPC ----------');
  for (const n of npcs) {
    if (n.mapId === 'NULL') continue;
    push(
      `INSERT OR IGNORE INTO npc (id, name, map_id, dialog) VALUES (${n.id}, ${q(n.name)}, (SELECT id FROM map WHERE name = ${q(n.mapName)}), ${q(n.dialog || `我在${n.mapName}。`)});`,
    );
  }
  push('');
}

if (items.length) {
  push('-- ---------- 物品 ----------');
  for (const it of items) {
    push(
      `INSERT OR IGNORE INTO item (id, name, kind, use_scene, price, effect, amount, tradeable, desc) VALUES (${it.id}, ${q(it.name)}, ${q(it.kind)}, ${q(it.use_scene)}, ${it.price}, ${q(it.effect)}, ${it.amount}, ${it.tradeable}, ${q(it.desc)});`,
    );
  }
  push('');
}

if (quests.length) {
  push('-- ---------- 任务 ----------');
  for (const qq of quests) {
    push(
      `INSERT OR IGNORE INTO quest (id, name, kind, desc, cond, reward) VALUES (${qq.id}, ${q(qq.name)}, 'main', ${q(qq.desc)}, ${q(JSON.stringify(qq.cond))}, ${q(JSON.stringify(qq.reward))});`,
    );
  }
  push('');
}

// NPC→任务 必须在 quests 之后输出，否则 SELECT 时任务还不存在
if (npcs.length && quests.length) {
  push('-- ---------- NPC 给的任务 ----------');
  const questNames = new Set(quests.map((x) => x.name));
  for (const n of npcs) {
    for (const qn of n.quests ?? []) {
      if (!questNames.has(qn)) continue;
      push(
        `INSERT OR IGNORE INTO npc_quest (npc_id, quest_id) SELECT n.id, q.id FROM npc n, quest q WHERE n.name = ${q(n.name)} AND q.name = ${q(qn)};`,
      );
    }
  }
  push('');
}

push(`INSERT OR IGNORE INTO content_meta (key, value) VALUES ('content_pack', 'ini-v1');`);

const sql = lines.join('\n') + '\n';

/* ---------------- 报告 ---------------- */

console.log('=== 导入统计 ===');
console.log(`地图    ${maps.length}`);
console.log(`魂兽    ${monsters.length}（${['normal', 'elite', 'boss'].map((t) => `${t} ${monsters.filter((m) => m.tier === t).length}`).join(' / ')}）`);
console.log(`NPC     ${npcs.length}（有地图的 ${npcs.filter((n) => n.mapId !== 'NULL').length}）`);
console.log(`物品    ${items.length}（可用 ${items.filter((i) => i.effect).length}）`);
console.log(`武魂    ${wuhuns.length} · 系列 ${series.length}`);
console.log(`任务    ${quests.length}${skippedQuests.length ? `（跳过 ${skippedQuests.length}）` : ''}`);
if (skippedQuests.length) {
  console.log('\n=== 跳过的任务 ===');
  for (const s of skippedQuests.slice(0, 12)) console.log(' -', s);
  if (skippedQuests.length > 12) console.log(` - …… 另有 ${skippedQuests.length - 12} 条`);
}
const unlinked = monsters.filter((m) => m.spawn && !mapIdByName.has(m.spawn));
if (unlinked.length) {
  console.log('\n=== 出没地图不存在的魂兽 ===');
  for (const m of unlinked.slice(0, 10)) console.log(` - ${m.name} → 「${m.spawn}」`);
}

if (DRY) {
  console.log('\n[dry] 不写文件。前 30 行预览：\n');
  console.log(sql.split('\n').slice(0, 30).join('\n'));
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, sql, 'utf8');
  console.log(`\n已写入 ${OUT}（${(sql.length / 1024).toFixed(1)} KB，${lines.length} 行）`);
}

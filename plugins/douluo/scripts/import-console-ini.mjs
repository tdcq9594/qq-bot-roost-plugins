#!/usr/bin/env node
/**
 * 从原版「斗罗控制台」的 ini 数据导入内容
 * ==========================================
 *
 * 数据源：`D:/WorkBuddy/源/Nanbot2/斗罗大陆数据/*.ini`（89 个，GBK）
 * 产物：`src/db/console-pack.sql`（在 post.sql 之后、post2.sql 之前执行）
 *
 * ## 为什么不直接搬数值
 *
 * 原版的数值量级是**亿级**（魂兽生命中位数 5 亿、魂技威力中位数 8000、
 * 消耗中位数 1900），我们的战斗是**百级**（攻击几十、魂力几百）。
 * 直接搬会让整个数值体系崩掉。
 *
 * 所以这个脚本做两件事：
 *   1. **搬结构**：名字、字段关系、稀有度、等级需求、百分比类属性 → 原样导入
 *   2. **标定数值**：绝对值属性按分位数映射到我们自己的曲线
 *
 * 映射用幂函数而不是线性，因为原版数值是「指数膨胀」的（越后期越离谱），
 * 线性映射会把前 90% 的内容压成一个点。
 *
 * ## 用法
 *
 *   node scripts/import-console-ini.mjs            # 生成 console-pack.sql
 *   node scripts/import-console-ini.mjs --dry      # 只看统计
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(HERE, '..', 'src', 'db');
const SRC = process.env.CONSOLE_INI_DIR || 'D:/WorkBuddy/源/Nanbot2/斗罗大陆数据';
const OUT = path.join(DB_DIR, 'console-pack.sql');
const DRY = process.argv.includes('--dry');

/* ---------------- ini 读取 ---------------- */

const dec = new TextDecoder('gbk');
const cache = new Map();

function readIni(file) {
  if (cache.has(file)) return cache.get(file);
  const full = path.join(SRC, file);
  if (!fs.existsSync(full)) {
    cache.set(file, []);
    return [];
  }
  const txt = dec.decode(fs.readFileSync(full));
  const out = [];
  for (const block of txt.split(/^\[/m).slice(1)) {
    const nl = block.indexOf(']');
    if (nl < 0) continue;
    const name = block.slice(0, nl).trim();
    if (!name) continue;
    const kv = {};
    for (const line of block.slice(nl + 1).split('\n')) {
      const i = line.indexOf('=');
      if (i <= 0) continue;
      kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    out.push({ name, kv });
  }
  cache.set(file, out);
  return out;
}

/* ---------------- 工具 ---------------- */

const q = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;
const num = (v, d = 0) => {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : d;
};
const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, Math.round(v)));
/** 幂函数映射：把 x 从 srcMid 附近映射到 dstMid，两端 clamp */
const scale = (x, srcMid, dstMid, exp, lo, hi) => (x > 0 ? clamp(lo, hi, dstMid * Math.pow(x / srcMid, exp)) : lo);

/**
 * 敏感词拦截。
 * 原版 ini 里混了粗俗和民族敏感的恶搞命名（真机联调时在群里直接看到了），
 * 导入前必须挡掉，否则上线一次就够封号。
 */
const BAD = [
  '日本鬼子', '鬼子', '傻逼', '傻B', '煞笔', '狗日', '操你', '草你', '妈的', '他妈',
  '尼玛', '你妈', '干你', '贱', '婊', '骚', '妓', '嫖', '支那', '东亚病夫',
  '台独', '港独', '藏独', '疆独', '法轮', '六四', '习近平', '共产党', '反动', '独裁',
  '老司机', '封弊者', '心累',
];
const badName = (name) => {
  const s = String(name ?? '');
  if (!s.trim()) return true;
  if (s.length > 16) return true;
  return BAD.some((w) => s.includes(w));
};

/** 已有名字（避免 UNIQUE 冲突被 INSERT OR IGNORE 静默吞掉） */
function existingNames() {
  const set = new Set();
  for (const file of ['content-pack.sql', 'patch.sql', 'post.sql', 'seed.sql']) {
    const p = path.join(DB_DIR, file);
    if (!fs.existsSync(p)) continue;
    const txt = fs.readFileSync(p, 'utf8');
    for (const m of txt.matchAll(/VALUES\s*\(\s*\d+\s*,\s*'([^']+)'/g)) set.add(m[1]);
  }
  return set;
}
const EXIST = existingNames();

const L = [];
const push = (s) => L.push(s);
const stat = {};

/** 状态名 → 我们生成的 key（跳过被过滤的，保证序号连续） */
function statusKeyMap() {
  const map = new Map();
  let i = 0;
  for (const { name, kv } of readIni('状态列表.ini')) {
    if (badName(name) || String(kv['是否存在'] ?? '真') === '假') continue;
    i += 1;
    map.set(name, `c_${i}`);
  }
  return map;
}
const STATUS_KEY = statusKeyMap();

/** 魂技名 → id（同理） */
function skillIdMap() {
  const map = new Map();
  let i = 0;
  for (const { name, kv } of readIni('魂技列表.ini')) {
    if (badName(name) || String(kv['是否创建'] ?? '真') === '假') continue;
    if (EXIST.has(name)) continue;
    map.set(name, 1000 + i);
    i += 1;
  }
  return map;
}
const SKILL_ID = skillIdMap();

/* ============================================================
 * 1. 状态（79 个，16 字段全映射）
 * ============================================================ */

function importStatuses() {
  const rows = readIni('状态列表.ini');
  const lines = [];
  const seen = new Set();
  for (const { name, kv } of rows) {
    if (badName(name) || seen.has(name)) continue;
    seen.add(name);
    if (String(kv['是否存在'] ?? '真') === '假') continue;
    const tick = num(kv['持续伤害']);
    const dot = String(kv['是否持续伤害'] ?? '假') === '真';
    const v = {
      str: num(kv['力量']), atk: num(kv['攻击']), def: num(kv['防御']), spd: num(kv['速度']),
      dodge: num(kv['闪避']), crit: num(kv['暴击率']), critDmg: num(kv['暴击伤害']),
      hp: num(kv['生命']), mp: num(kv['魂力']), exp: num(kv['经验']), gold: num(kv['金币']),
    };
    // 原版「状态解除」是回合数，量级 5~50；我们一场 4~12 回合，除以 5 并封顶 8
    const dur = clamp(1, 8, Math.round(num(kv['状态解除'], 3) / 5) || 1);
    // 持续伤害：原版是绝对值，我们按「最大生命 %」表达，只取量级分档
    const tickPct = dot && tick ? clamp(1, 20, Math.round(Math.log10(Math.abs(tick) + 10) * 1.6)) : 0;
    const bits = [];
    const add = (label, n) => n && bits.push(`${label}${n > 0 ? '+' : ''}${n}`);
    add('力量', v.str); add('攻击', v.atk); add('防御', v.def); add('速度', v.spd);
    add('闪避', v.dodge); add('暴击', v.crit); add('暴伤', v.critDmg);
    add('生命', v.hp); add('魂力', v.mp); add('经验', v.exp); add('金币', v.gold);
    if (tickPct) bits.push(`每回合掉 ${tickPct}% 生命`);
    const noAct = String(kv['战斗不能'] ?? '假') === '真';
    if (noAct) bits.push('无法行动');
    const kind = [v.str, v.atk, v.def, v.spd, v.dodge, v.crit, v.critDmg, v.hp, v.mp, v.exp, v.gold].some((x) => x > 0)
      ? 'buff'
      : 'debuff';

    lines.push(
      `  (${q(STATUS_KEY.get(name))}, ${q(name)}, ${q(kind)}, ${q(bits.join(' · ') || '无明显效果')}, 3, ${dur}, ${tickPct},\n` +
        `   ${v.atk}, ${v.def}, ${v.spd}, ${v.dodge}, ${v.crit},\n` +
        `   ${v.str}, ${v.hp}, ${v.mp}, ${v.critDmg}, ${v.exp}, ${v.gold}, ${noAct ? 1 : 0}, 0, 0, 0, 1)`,
    );
  }
  stat.状态 = lines.length;
  if (!lines.length) return;
  push('-- ---------- 状态：原版 79 个（16 字段全映射） ----------');
  push(
    'INSERT OR IGNORE INTO status_def (key, name, kind, desc, max_stack, duration, tick_pct,\n' +
      '  atk_pct, def_pct, spd_pct, dodge_pct, crit_pct,\n' +
      '  str_pct, hp_pct, mp_pct, crit_dmg_pct, exp_pct, gold_pct,\n' +
      '  skip_turn, block_skill, instant_kill, instant_kill_chance, enabled) VALUES',
  );
  push(lines.join(',\n') + ';');
  push('');
}

/* ============================================================
 * 2. 魂技（342 个，含己方单体/全体）
 * ============================================================ */

const SCOPE_MAP = { 敌单体: 'enemy_one', 敌全体: 'enemy_all', 己方单体: 'self_one', 己方全体: 'self_all' };

function importSkills() {
  const rows = readIni('魂技列表.ini');
  const lines = [];
  const statusLines = [];
  const seen = new Set();
  let selfCount = 0;

  for (const { name, kv } of rows) {
    if (badName(name) || seen.has(name)) continue;
    seen.add(name);
    if (String(kv['是否创建'] ?? '真') === '假') continue;
    if (EXIST.has(name)) continue;

    const scopeRaw = String(kv['效果范围'] ?? '').trim();
    const scope = SCOPE_MAP[scopeRaw] ?? 'enemy_one';
    const isSelf = scope === 'self_one' || scope === 'self_all';
    if (isSelf) selfCount += 1;

    // 原版中位：威力 8000 / 消耗 1900 / 冷却 40 / 命中 90
    const ourPower = scale(num(kv['魂技威力']), 8000, 200, 0.18, 80, 560);
    const ourCost = scale(num(kv['魂技消耗']), 1900, 48, 0.25, 4, 90);
    const ourCd = clamp(0, 10, Math.round(num(kv['魂技冷却时间']) / 10));
    const hit = clamp(50, 100, num(kv['魂技命中率'], 90) || 90);
    // 己方技能：治疗量按威力折算（heal_pct 是「施法者最大生命 %」）
    const healPct = isSelf ? clamp(5, 60, Math.round(ourPower / 12)) : 0;
    const desc = String(kv['魂技说明'] ?? '').slice(0, 60) || `${scopeRaw}技能`;
    const id = SKILL_ID.get(name);

    lines.push(
      `  (${id}, ${q(name)}, ${q(scope)}, ${ourPower}, ${ourCost}, ${hit}, ${ourCd}, ${q(desc)},\n` +
        `   ${q(isSelf ? 'heal' : 'damage')}, 'active', 0, 0, ${healPct}, 1)`,
    );
    const addOn = String(kv['魂技附加效果'] ?? '').trim();
    if (addOn && STATUS_KEY.has(addOn)) statusLines.push(`  (${id}, ${q(STATUS_KEY.get(addOn))}, 100, 0, 'enemy')`);
    const selfOn = String(kv['魂技自身附加'] ?? '').trim();
    if (selfOn && STATUS_KEY.has(selfOn)) statusLines.push(`  (${id}, ${q(STATUS_KEY.get(selfOn))}, 100, 0, 'self')`);
  }
  stat.魂技 = lines.length;
  stat.己方魂技 = selfCount;
  if (!lines.length) return;
  push('-- ---------- 魂技：原版 342 个（含己方单体/全体治疗增益） ----------');
  push(
    'INSERT OR IGNORE INTO skill (id, name, scope, power, cost, hit, cd, desc,\n' +
      '  effect_type, trigger_type, trigger_skill, series_id, heal_pct, enabled) VALUES',
  );
  push(lines.join(',\n') + ';');
  if (statusLines.length) {
    push('');
    push('-- 魂技 → 状态（原版的「魂技附加效果 / 魂技自身附加」）');
    push('INSERT OR IGNORE INTO skill_status (skill_id, status_key, chance, duration, target) VALUES');
    push(statusLines.join(',\n') + ';');
  }
  push('');
}

/* ============================================================
 * 3. 物品（307 个）
 * ============================================================ */

function importItems() {
  const rows = readIni('物品列表.ini');
  const lines = [];
  const fixes = [];
  const seen = new Set();
  let n = 0;

  for (const { name, kv } of rows) {
    if (badName(name) || seen.has(name)) continue;
    seen.add(name);
    if (String(kv['是否存在'] ?? '真') === '假') continue;
    if (EXIST.has(name)) continue;

    const price = scale(num(kv['出售价格']), 100, 150, 0.55, 5, 60000);
    const heal = num(kv['生命恢复']);
    const mana = num(kv['魂力恢复']);
    const ability = String(kv['能力上升'] ?? '').trim();
    const abilityAmt = num(kv['能力提升量']);

    /**
     * 「能力上升」优先于回血/回蓝。
     *
     * 原版很多升级卷**同时**填了生命恢复（顺手回点血），
     * 如果先判 heal，这些卷轴就全变成普通药水了。
     */
    let effect = '';
    let amount = 0;
    if (ability === '等级' && abilityAmt > 0) {
      effect = 'add_level';
      amount = clamp(1, 10, abilityAmt);
    } else if (ability === '经验' && abilityAmt > 0) {
      effect = 'add_exp';
      amount = scale(abilityAmt, 1e6, 3000, 0.5, 100, 50000);
    } else if (heal > 0) {
      effect = 'heal_hp';
      amount = scale(heal, 1e5, 800, 0.45, 50, 8000);
    } else if (mana > 0) {
      effect = 'heal_mp';
      amount = scale(mana, 1e5, 500, 0.45, 30, 5000);
    } else if (String(kv['传送地图'] ?? '').trim()) {
      effect = 'teleport';
    } else if (String(kv['内涵道具'] ?? '').trim()) {
      effect = 'open_box';
    }

    const useScene = String(kv['使用场景'] ?? '所有').includes('战斗') ? 'battle' : 'any';
    const tradeable = String(kv['可交易性'] ?? '真') === '真' ? 1 : 0;
    const kind = effect === 'teleport' ? 'tool' : effect === 'open_box' ? 'gift' : effect ? 'consumable' : 'material';
    const desc = String(kv['说明'] ?? '').slice(0, 60) || name;
    const id = 2000 + n;

    lines.push(
      `  (${id}, ${q(name)}, ${q(kind)}, ${q(useScene)}, ${price}, ${q(effect)}, ${amount}, ${tradeable}, ${q(desc)},\n` +
        `   ${q(ability)}, ${abilityAmt}, ${q(String(kv['传送地图'] ?? ''))}, ${q(String(kv['内涵道具'] ?? ''))}, ` +
        `${num(kv['每天次数'])}, ${num(kv['最小使用等级'], 1)}, ${num(kv['最大使用等级'])}, ` +
        `${q(String(kv['附加状态'] ?? ''))}, ${num(kv['附加状态几率'], 100)})`,
    );
    fixes.push({ id, effect, amount });
    n += 1;
  }
  stat.物品 = n;
  if (!n) return;
  push('-- ---------- 物品：原版 307 个（含升级卷/传送符/礼包） ----------');
  push(
    'INSERT OR IGNORE INTO item (id, name, kind, use_scene, price, effect, amount, tradeable, desc,\n' +
      '  ability, ability_amount, teleport_map, contains, daily_limit, min_level, max_level,\n' +
      '  give_status, give_status_chance) VALUES',
  );
  push(lines.join(',\n') + ';');
  push('');
  /**
   * 修正段：老库里这些 id 已存在，`INSERT OR IGNORE` 会跳过，
   * 于是「effect 判定逻辑改过」在老库上永远不生效。
   * 按 id 直接 UPDATE —— id 是按 ini 顺序生成的序号，同一份 ini 每次结果一样。
   * （用 upsert 不行：更新 name 会撞 UNIQUE，因为原版有同名不同 id 的条目。）
   */
  if (fixes.length) {
    push('-- 修正已存在行的效果字段（INSERT OR IGNORE 不会更新老行）');
    for (const f of fixes) push(`UPDATE item SET effect = ${q(f.effect)}, amount = ${f.amount} WHERE id = ${f.id};`);
    push('');
  }
}

/* ============================================================
 * 4. 魂兽（186 只）+ 出没 + 技能
 * ============================================================ */

function importMonsters() {
  const rows = readIni('魂兽列表.ini');
  const lines = [];
  const skillLinks = [];
  const seen = new Set();
  let n = 0;

  for (const { name, kv } of rows) {
    if (badName(name) || seen.has(name)) continue;
    seen.add(name);
    if (String(kv['是否存在'] ?? '真') === '假') continue;
    if (EXIST.has(name)) continue;

    // 原版年龄 50 ~ 100 亿 → 我们 10 ~ 100 万（十万年魂兽上限）
    const age = scale(num(kv['魂兽年龄'], 10), 50, 10, 0.7, 10, 1000000);
    const hpRaw = num(kv['魂兽生命']);
    const tier = hpRaw >= 3e9 ? 'boss' : hpRaw >= 3e8 ? 'elite' : 'normal';
    const rounds = tier === 'boss' ? 12 : tier === 'elite' ? 8 : 5;
    const crit = clamp(0, 60, num(kv['魂兽暴击']));
    const critDmg = clamp(100, 300, num(kv['魂兽暴击伤害'], 150));
    const dodge = clamp(0, 40, num(kv['魂兽闪避']));
    const id = 3000 + n;
    const band = age >= 100000 ? '十万年' : age >= 10000 ? '万年' : age >= 1000 ? '千年' : age >= 100 ? '百年' : '十年';

    lines.push(
      `  (${id}, ${q(name)}, ${q(tier)}, ${rounds}, ${age}, 1, 1, 1, ` +
        `${tier === 'boss' ? 12 : tier === 'elite' ? 4 : 1.5}, ${tier === 'boss' ? 8 : tier === 'elite' ? 3 : 1.2}, 1, ` +
        `${q(`${name}，${band}魂兽`)}, ${crit}, ${critDmg}, ${dodge}, 0)`,
    );
    // 魂兽技能：格式「技能名{#分#}施放率{#分#}威力{@分@}…」
    for (const part of String(kv['魂兽技能'] ?? '').split('{@分@}')) {
      const f = part.split('{#分#}');
      if (f.length < 2) continue;
      const sid = SKILL_ID.get(f[0].trim());
      if (!sid) continue;
      skillLinks.push(`  (${id}, ${sid}, ${clamp(1, 100, num(f[1], 30))})`);
    }
    n += 1;
  }
  stat.魂兽 = n;
  if (!n) return;
  push('-- ---------- 魂兽：原版 186 只（补上暴击/暴伤/闪避字段） ----------');
  push(
    'INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias,\n' +
      '  exp_rate, gold_rate, drop_ring, desc, crit, crit_dmg, dodge, spd) VALUES',
  );
  push(lines.join(',\n') + ';');
  if (skillLinks.length) {
    push('');
    push('-- 魂兽 → 魂技（原版「魂兽技能=名字{#分#}施放率…」）');
    push('INSERT OR IGNORE INTO monster_skill (monster_id, skill_id, weight) VALUES');
    push(skillLinks.join(',\n') + ';');
  }
  push('');
}

/* ============================================================
 * 5. 地图（109 张）+ 四向连通 + 钓点 + NPC 归属
 * ============================================================ */

function importMaps() {
  const rows = readIni('地图数据.ini');
  const lines = [];
  const links = [];
  const npcLinks = [];
  const fishes = [];
  let n = 0;

  for (const { name, kv } of rows) {
    if (badName(name)) continue;
    if (String(kv['是否创建'] ?? '真') === '假') continue;
    // 已存在的图不重复插入，但**连通/钓点/NPC 归属仍要处理**——
    // 这些是原版独有的关系数据，丢了就白导了。
    const isNew = !EXIST.has(name);
    if (isNew) {
      const desc = String(kv['地图描述'] ?? '').replace(/\s+/g, ' ').slice(0, 80) || name;
      lines.push(`  (${4000 + n}, ${q(name)}, 1, 1, ${q(desc)}, ${q(String(kv['建筑物'] ?? '').slice(0, 200))})`);
      n += 1;
    }
    // 四向连通：原版存的是**地图名**，这里记下来，后面按名字回填 id
    for (const [cn, en] of Object.entries({ 前: 'north', 后: 'south', 左: 'west', 右: 'east' })) {
      const to = String(kv[cn] ?? '').trim();
      if (to && !badName(to)) links.push({ name, en, to });
    }
    // NPC 列表：「名字@名字@」
    for (const npcName of String(kv['NPC列表'] ?? '').split('@').map((s) => s.trim()).filter(Boolean)) {
      if (!badName(npcName)) npcLinks.push({ npcName, mapName: name });
    }
    // 钓鱼点：「钓鱼物品=物品名*数量|」
    const fish = String(kv['钓鱼物品'] ?? '').trim();
    if (fish) {
      const first = fish.split('|')[0];
      const fname = first.split('*')[0].trim();
      const qty = num(first.split('*')[1], 1) || 1;
      if (fname && !badName(fname)) fishes.push({ mapName: name, fname, qty, refresh: num(kv['钓鱼刷新'], 300) });
    }
  }
  stat.地图 = n;
  stat.地图连通 = links.length;
  stat.NPC归属 = npcLinks.length;
  stat.钓点 = fishes.length;

  if (lines.length) {
    push('-- ---------- 地图：原版 109 张（含建筑物/钓鱼/四向连通） ----------');
    push('INSERT OR IGNORE INTO map (id, name, min_level, portal, desc, building) VALUES');
    push(lines.join(',\n') + ';');
  }
  if (fishes.length) {
    push('');
    push('-- 钓点：原版「钓鱼物品=物品名*数量|」');
    for (const g of fishes) {
      push(
        `INSERT OR IGNORE INTO gather_point (map_id, kind, name, item_id, qty_min, qty_max, need_item, refresh, level_req, enabled)\n` +
          `  SELECT id, 'fish', ${q(`${g.mapName}·钓点`)}, COALESCE((SELECT id FROM item WHERE name = ${q(g.fname)}), 0), ` +
          `${g.qty}, ${g.qty * 2}, 0, ${g.refresh}, 1, 1 FROM map WHERE name = ${q(g.mapName)};`,
      );
    }
  }
  if (links.length) {
    push('');
    push('-- 四向连通：原版存地图名，按名字回填 id（必须在地图全部插入之后）');
    for (const l of links) {
      push(
        `UPDATE map SET ${l.en} = (SELECT id FROM map WHERE name = ${q(l.to)}) WHERE name = ${q(l.name)} AND ${l.en} IS NULL;`,
      );
    }
  }
  if (npcLinks.length) {
    push('');
    push('-- NPC 归属地图：原版「NPC列表=名字@名字@」');
    for (const l of npcLinks) {
      push(
        `UPDATE npc SET map_id = COALESCE((SELECT id FROM map WHERE name = ${q(l.mapName)}), map_id) WHERE name = ${q(l.npcName)};`,
      );
    }
  }
  push('');
}

/* ============================================================
 * 6. 魂兽出没（原版「出没地图.ini」：地图名 → 魂兽名=真）
 * ============================================================ */

function importSpawns() {
  const rows = readIni('出没地图.ini');
  const pairs = [];
  for (const { name: mapName, kv } of rows) {
    if (badName(mapName)) continue;
    for (const [mobName, v] of Object.entries(kv)) {
      if (String(v) !== '真' || badName(mobName)) continue;
      pairs.push({ mapName, mobName });
    }
  }
  stat.出没配置 = pairs.length;
  if (!pairs.length) return;
  push('-- ---------- 魂兽出没：原版「出没地图.ini」 ----------');
  for (const p of pairs) {
    push(
      `INSERT OR IGNORE INTO monster_map (monster_id, map_id) SELECT m.id, mp.id FROM monster m, map mp\n` +
        `  WHERE m.name = ${q(p.mobName)} AND mp.name = ${q(p.mapName)};`,
    );
  }
  push('');
  push('-- 地图等级门槛：按该图最弱魂兽的年龄反推（原版没这个字段，是我们补的）');
  push(
    `UPDATE map SET min_level = COALESCE((
  SELECT CASE
    WHEN MIN(m.age) >= 100000 THEN 60
    WHEN MIN(m.age) >= 10000  THEN 45
    WHEN MIN(m.age) >= 1000   THEN 25
    WHEN MIN(m.age) >= 100    THEN 10
    ELSE 1 END
  FROM monster_map mm JOIN monster m ON m.id = mm.monster_id WHERE mm.map_id = map.id
), 1) WHERE min_level <= 1;`,
  );
  push('');
}

/* ============================================================
 * 7. NPC（46 个）
 * ============================================================ */

function importNpcs() {
  const rows = readIni('NPC列表.ini');
  const lines = [];
  const seen = new Set();
  let n = 0;
  for (const { name, kv } of rows) {
    if (badName(name) || seen.has(name)) continue;
    seen.add(name);
    if (String(kv['是否存在'] ?? '真') === '假') continue;
    if (EXIST.has(name)) continue;
    const dialog = String(kv['平常对话'] ?? '').slice(0, 200) || `${name}看着你。`;
    lines.push(`  (${5000 + n}, ${q(name)}, 1, ${q(dialog)})`);
    n += 1;
  }
  stat.NPC = n;
  if (!n) return;
  push('-- ---------- NPC：原版 46 个 ----------');
  push('INSERT OR IGNORE INTO npc (id, name, map_id, dialog) VALUES');
  push(lines.join(',\n') + ';');
  push('');
}

/* ============================================================
 * 8. 魂骨（74 件）/ 武魂（98 个）
 *
 * 属性一律按稀有度用我们自己的曲线重算——原版是亿级，搬过来必崩。
 * ============================================================ */

const BONE_PART_KEY = {
  头骨: 'head', 躯干骨: 'torso', 左臂骨: 'arm_l', 右臂骨: 'arm_r',
  左腿骨: 'leg_l', 右腿骨: 'leg_r', 外附魂骨: 'extra',
};

function importBones() {
  const rows = readIni('魂骨列表.ini');
  const lines = [];
  const seen = new Set();
  let n = 0;
  for (const { name, kv } of rows) {
    if (badName(name) || seen.has(name)) continue;
    seen.add(name);
    if (String(kv['是否创建'] ?? '真') === '假') continue;
    if (EXIST.has(name)) continue;
    const cat = String(kv['魂骨类别'] ?? '').trim();
    const part = BONE_PART_KEY[cat];
    if (!part) continue;
    const hpRaw = num(kv['魂骨生命']);
    const rarity = hpRaw >= 5e8 ? 5 : hpRaw >= 2e8 ? 4 : hpRaw >= 5e7 ? 3 : 2;
    const f = rarity - 1;
    lines.push(
      `  (${6000 + n}, ${q(name)}, 'bone', ${q(part)}, ${rarity}, NULL, ` +
        `${30 * f + 20}, ${5 * f}, ${6 * f + 3}, ${8 * f + 4}, ${2 * f}, ${3 * f + 1}, ${3 * f + 1}, ` +
        `${1 + f}, ${f}, ${f * 3}, ${q(`${cat}·${rarity} 星`)})`,
    );
    n += 1;
  }
  stat.魂骨 = n;
  if (!n) return;
  push('-- ---------- 魂骨：原版 74 件（7 部位含外附骨） ----------');
  push(
    'INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES',
  );
  push(lines.join(',\n') + ';');
  push('');
}

const SERIES_BY_NAME = { 强攻: 1, 控制: 2, 敏攻: 3, 防御: 4, 辅助: 5, 食物: 6, 治疗: 7, 精神: 11, 力量: 10, 敏捷: 12, 神: 13, 变异: 14 };

function importWuhun() {
  const rows = readIni('武魂信息.ini');
  const lines = [];
  const seen = new Set();
  let n = 0;
  for (const { name, kv } of rows) {
    if (badName(name) || seen.has(name)) continue;
    seen.add(name);
    if (String(kv['是否创建'] ?? '真') === '假') continue;
    if (EXIST.has(name)) continue;
    const seriesName = String(kv['武魂系列'] ?? '').trim();
    let seriesId = 1;
    for (const [k, v] of Object.entries(SERIES_BY_NAME)) {
      if (seriesName.includes(k)) {
        seriesId = v;
        break;
      }
    }
    const hpRaw = num(kv['武魂魂力']) + num(kv['武魂生命']);
    const rarity = hpRaw >= 1e8 ? 5 : hpRaw >= 5e7 ? 4 : hpRaw >= 1e7 ? 3 : 2;
    const f = rarity - 1;
    const desc = String(kv['武魂描述'] ?? '').slice(0, 60) || `${seriesName}武魂`;
    lines.push(
      `  (${7000 + n}, ${q(name)}, ${seriesId}, ${rarity}, ` +
        `${100 + 20 * f}, ${110 + 20 * f}, ${8 + 2 * f}, ${7 + 2 * f}, ${9 + f}, ` +
        `${6 + 2 * f}, ${7 + 2 * f}, ${4 + f}, ${4 + f}, ${140 + 8 * f}, ${q(desc)})`,
    );
    n += 1;
  }
  stat.武魂 = n;
  if (!n) return;
  push('-- ---------- 武魂：原版 98 个（属性按稀有度重算） ----------');
  push(
    'INSERT OR IGNORE INTO wuhun (id, name, series_id, rarity, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES',
  );
  push(lines.join(',\n') + ';');
  push('');
}

/* ============================================================
 * 9. 职业等级（原版 7 职业 × 10 级）
 * ============================================================ */

function importProfessions() {
  const rows = readIni('职业等级.ini');
  const lines = [];
  const CN = { 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  for (const { name, kv } of rows) {
    if (badName(name)) continue;
    for (const [k, v] of Object.entries(kv)) {
      const m = k.match(/^(.+?)级需要经验$/);
      if (!m) continue;
      const lv = CN[m[1]] ?? Number(m[1]);
      if (!lv) continue;
      // 原版经验 500 万 ~ 8.7 亿 → 我们 2 万 ~ 300 万
      lines.push(`  (${q(name)}, ${lv}, ${scale(num(v), 5e6, 20000, 0.55, 5000, 3000000)}, '{}')`);
    }
  }
  stat.职业等级 = lines.length;
  if (!lines.length) return;
  push('-- ---------- 职业等级：原版 7 职业 × 10 级 ----------');
  push('INSERT OR IGNORE INTO profession_level (profession, level, need_exp, bonus) VALUES');
  push(lines.join(',\n') + ';');
  push('');
}

/* ============================================================
 * 10. 武魂融合 / 进化 / 斗铠领域
 * ============================================================ */

function importFusion() {
  const rows = readIni('武魂融合列表.ini');
  const lines = [];
  const needs = [];
  let n = 0;
  for (const { name, kv } of rows) {
    if (badName(name)) continue;
    if (String(kv['是否存在'] ?? '真') === '假') continue;
    const need = String(kv['需求武魂'] ?? '').split('@').map((s) => s.trim()).filter(Boolean);
    if (need.length < 2) continue;
    const id = 8000 + n;
    lines.push(
      `  (${id}, ${q(name)}, 0, 0, 0, ${q(String(kv['融合BUFF'] ?? ''))}, '{}', ${q(`${need[0]} + ${need[1]} 融合`)}, 1)`,
    );
    needs.push({ id, a: need[0], b: need[1], skill: String(kv['融合魂技'] ?? '') });
    n += 1;
  }
  stat.武魂融合 = n;
  if (!n) return;
  push('-- ---------- 武魂融合：原版 25 组（需求武魂 + 融合魂技 + 融合BUFF） ----------');
  push('INSERT OR IGNORE INTO wuhun_fusion (id, name, wuhun_a, wuhun_b, skill_id, buff, attrs, desc, enabled) VALUES');
  push(lines.join(',\n') + ';');
  push('');
  push('-- 按名字回填融合的两侧武魂与魂技（此时武魂/魂技已存在）');
  for (const it of needs) {
    push(
      `UPDATE wuhun_fusion SET wuhun_a = COALESCE((SELECT id FROM wuhun WHERE name = ${q(it.a)}), 0),\n` +
        `  wuhun_b = COALESCE((SELECT id FROM wuhun WHERE name = ${q(it.b)}), 0),\n` +
        `  skill_id = COALESCE((SELECT id FROM skill WHERE name = ${q(it.skill)}), 0) WHERE id = ${it.id};`,
    );
  }
  push('');
  /**
   * 兜底：原版的武魂名（神化的蓝银草 / 金龙王）和我们的对不上，
   * 硬留 0 会让这条融合永远点不动。按稀有度挑一个填上——
   * 名字不对总比点不动强。
   *
   * 注意 SQLite 的 UPDATE 子查询**不能引用外层表名**（`wuhun_fusion.id` 会报
   * no such column），所以逐条生成、用 LIMIT 1 OFFSET 取不同的行。
   */
  push('-- 兜底：原版武魂名对不上时按稀有度挑一个（否则这条融合永远点不动）');
  for (let i = 0; i < needs.length; i += 1) {
    const id = 8000 + i;
    push(
      `UPDATE wuhun_fusion SET wuhun_a = (SELECT id FROM wuhun WHERE enabled = 1 AND rarity >= 4 ORDER BY id LIMIT 1 OFFSET ${i % 9}) WHERE id = ${id} AND wuhun_a = 0;`,
    );
    push(
      `UPDATE wuhun_fusion SET wuhun_b = (SELECT id FROM wuhun WHERE enabled = 1 AND rarity >= 3 ORDER BY id DESC LIMIT 1 OFFSET ${i % 7}) WHERE id = ${id} AND wuhun_b = 0;`,
    );
  }
  push('');
}

function importEvolution() {
  const rows = readIni('武魂进化列表.ini');
  const lines = [];
  for (const { name, kv } of rows) {
    if (badName(name)) continue;
    if (String(kv['是否存在'] ?? '真') === '假') continue;
    const to = String(kv['进化成武魂'] ?? '').trim();
    if (!to || badName(to)) continue;
    // 按名字回填：源武魂不在本库的语句会自然空转
    lines.push(
      `UPDATE wuhun SET evolve_to = (SELECT id FROM wuhun WHERE name = ${q(to)}), ` +
        `evolve_level = ${num(kv['需求等级'], 1)}, evolve_item = ${q(String(kv['需求物品'] ?? ''))} WHERE name = ${q(name)};`,
    );
  }
  stat.武魂进化 = lines.length;
  if (!lines.length) return;
  push('-- ---------- 武魂进化：原版 48 条（源武魂 → 进化成武魂 + 需求等级/物品） ----------');
  for (const l of lines) push(l);
  push('');
}

function importDomains() {
  const rows = readIni('斗铠领域列表.ini');
  const lines = [];
  const seen = new Set();
  let n = 0;
  for (const { name, kv } of rows) {
    if (badName(name)) continue;
    const dname = String(kv['领域名称'] ?? '').trim() || name;
    if (badName(dname) || seen.has(dname)) continue;
    seen.add(dname);
    const stKey = STATUS_KEY.get(String(kv['附加状态'] ?? '').trim()) ?? '';
    lines.push(`  (${9000 + n}, ${q(dname)}, ${q(stKey)}, '{}', '{"gold":2000}', ${q(`斗铠 ${name} 的领域`)}, 1)`);
    n += 1;
  }
  stat.领域 = n;
  if (!n) return;
  push('-- ---------- 斗铠领域：原版 43 个（领域名称 + 附加状态） ----------');
  push('INSERT OR IGNORE INTO domain_def (id, name, status_key, attrs, cost, desc, enabled) VALUES');
  push(lines.join(',\n') + ';');
  push('');
}

/* ============================================================
 * 11. NPC 条件对话
 *
 * 原版 ini 里 NPC 只有「平常对话」一个纯文本字段，条件分支是运行时
 * 按「条件对话-」前缀拼出来的，没有可导的结构。
 * 所以这一块是**我们自己设计**的：
 *
 * ## 条件格式（全部 AND）
 *
 *   { level: 20 }            最低等级
 *   { levelMax: 40 }         最高等级
 *   { ring: 3 }              最低魂环数
 *   { gold: 10000 }          最低魂币
 *   { kill: 100 }            最少累计击杀
 *   { item: {name, qty} }    持有物品
 *   { time: 'night' }        day / night（按服务器小时）
 *
 * ## 动作
 *
 *   ''                  只是说话
 *   heal                回满（孟婆那种）
 *   give:<物品名>*<数量>  给东西（只给一次，靠 player_meta 记）
 *
 * ## 为什么按「身份」套模板
 *
 * 50 个 NPC 手写 200 段对话不现实，也没意义——玩家记不住第 37 个村民说了什么。
 * 按身份分 4 类（长者 / 商人 / 向导 / 神秘），每类 3–5 段，
 * 保证「同一个 NPC 在不同阶段说的话不一样」，这才是条件对话的价值。
 * ============================================================ */

const ARCH = [
  {
    like: ['%孟婆%'],
    lines: [
      { cond: {}, text: '喝了这碗汤，前尘往事就都忘了。不过你还没到该忘的时候——回去吧。', action: 'heal' },
      { cond: { level: 50 }, text: '五十级了？那碗汤，你早晚要喝。不急。', action: 'heal' },
    ],
  },
  {
    like: ['%村长%'],
    lines: [
      { cond: { level: 1 }, text: '新来的？拿着，三瓶金疮药。别死在第一天——这地方连块碑都不给你立。', action: 'give:金疮药*3' },
      { cond: { ring: 1 }, text: '第一环了。魂环不是装饰，是拿命换的。记住这个。' },
      { cond: { level: 30 }, text: '三十级。你身上那股味道，和刚来的时候不一样了。' },
    ],
  },
  {
    like: ['%长老%', '%将军%', '%校长%', '%统领%', '%祭司%', '%塔主%', '%守护者%', '%位面之主%', '%众神之主%', '%创世%', '%龙神%', '%雪神%', '%罗刹%', '%忘情仙%', '%封号斗罗%', '%域'],
    lines: [
      { cond: { level: 1 }, text: '这片大陆不养闲人。想活下来，先去杀几只十年魂兽。' },
      { cond: { ring: 1 }, text: '第一环。魂环不是装饰，是你拿命换的。' },
      { cond: { level: 30 }, text: '三十级。你身上那股味道，和刚来的时候不一样了。' },
      { cond: { kill: 100 }, text: '一百条命。你数过吗？我数过。' },
      { cond: { level: 60 }, text: '六十级……我该叫你一声前辈了。' },
    ],
  },
  {
    like: ['%杂货商%', '%铁匠%', '%掌柜%', '%货架%', '%商人%', '%百货员%', '%小仙女%'],
    lines: [
      { cond: { level: 1 }, text: '看看？都是便宜货，够你活过前十天。' },
      { cond: { gold: 10000 }, text: '哟，有钱人了。我这儿有些压箱底的，敢不敢买？' },
      { cond: { ring: 3 }, text: '三环的客人。好东西在后头，钱带够了吗？' },
    ],
  },
  {
    like: ['%向导%', '%船夫%', '%猎户%', '%守林人%', '%冯地%', '%霍洛%', '%唐虎%', '%大明%', '%二明%', '%二龙%', '%凤仙%', '%游客%', '%萝莉%', '%游人%', '%路人%'],
    lines: [
      { cond: { level: 1 }, text: '往北走，那边的怪弱。别往深处去，会死人的。' },
      { cond: { ring: 3 }, text: '三环了？那你该往深处走了。浅水养不出真龙。' },
      { cond: { time: 'night' }, text: '天黑了。这时候外面的东西最活跃，也最饿。' },
      { cond: { level: 20 }, text: '二十级的人我见得多，活到三十级的少。' },
    ],
  },
  {
    like: ['%唐昊%'],
    lines: [
      { cond: { level: 1 }, text: '……滚。' },
      { cond: { ring: 3 }, text: '三环。还不够。' },
      { cond: { level: 50 }, text: '昊天宗不收废物。你算不算废物，自己心里清楚。' },
    ],
  },
  {
    // 兜底：所有没被上面匹配到的 NPC
    like: ['%'],
    lines: [
      { cond: { level: 1 }, text: '……（他打量了你一眼，没说话）' },
      { cond: { level: 40 }, text: '你身上的气息变了。是魂骨，还是别的什么？' },
      { cond: { kill: 300 }, text: '三百条命堆出来的东西，藏不住的。' },
    ],
  },
];

/**
 * 条件对话用 **SQL 的 LIKE 匹配**生成，而不是「读 ini 的名字列表逐条生成」。
 *
 * 原因：`村长` 是我们自己在 content-pack 里加的，原版 NPC列表.ini 里没有；
 * 反过来原版有些 NPC 我们又没导。按名字列表生成必然漏。
 * 用 LIKE 直接对数据库里的 npc 表匹配，覆盖所有现有和以后新增的 NPC。
 *
 * 一个 NPC 可能同时命中多个类别（「圣魂长老」命中长者类，
 * 「铁匠老周」命中商人类）。同一 sort 撞 uq_npcdlg(npc_id, sort) 时
 * `INSERT OR IGNORE` 会跳过，所以**ARCH 的顺序就是优先级**——
 * 特殊 NPC（孟婆/村长/唐昊）必须排在通用类别前面。
 */
function importDialogs() {
  const lines = [];
  let n = 0;
  for (const arch of ARCH) {
    const where = arch.like.map((p) => `name LIKE ${q(p)}`).join(' OR ');
    arch.lines.forEach((l, i) => {
      lines.push(
        `INSERT OR IGNORE INTO npc_dialog (npc_id, cond, text, action, sort, enabled)\n` +
          `  SELECT id, ${q(JSON.stringify(l.cond))}, ${q(l.text)}, ${q(l.action ?? '')}, ${i}, 1 FROM npc WHERE ${where};`,
      );
      n += 1;
    });
  }
  stat.条件对话 = n;
  if (!n) return;
  push('-- ---------- NPC 条件对话（按身份 LIKE 匹配，同一个人在不同阶段说不同的话） ----------');
  push('-- 条件格式见 scripts/import-console-ini.mjs；幂等靠 uq_npcdlg(npc_id, sort)，ARCH 顺序即优先级');
  for (const l of lines) push(l);
  push('');
}

/* ============================================================
 * 主流程
 * ============================================================ */

if (!fs.existsSync(SRC)) {
  console.error(`找不到原版数据目录：${SRC}`);
  process.exit(1);
}

push('-- ============================================================');
push('-- 由 scripts/import-console-ini.mjs 生成，请勿手改');
push('-- 数据源：原版「斗罗控制台」的 89 个 ini');
push('-- 数值已按我们的曲线重新标定（原版是亿级，我们是百级）');
push('-- 执行顺序：content-pack → post → console-pack → post2');
push('-- ============================================================');
push('');

importStatuses();
importSkills();
importItems();
importMonsters();
importMaps();
importSpawns();
importNpcs();
importBones();
importWuhun();
importProfessions();
importFusion();
importEvolution();
importDomains();
importDialogs();

console.log('导入统计：');
for (const [k, v] of Object.entries(stat)) console.log(`  ${k.padEnd(8)} ${v}`);
console.log(`  已有内容跳过 ${EXIST.size} 个名字`);

if (DRY) {
  console.log('\n--dry：未写文件');
} else {
  fs.writeFileSync(OUT, L.join('\n'));
  console.log(`\n已写入 ${path.relative(process.cwd(), OUT)}（${L.length} 行）`);
}

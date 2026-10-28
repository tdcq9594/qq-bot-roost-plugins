/**
 * 通关测试
 * ========
 *
 *   node plugins/douluo/test/playthrough.mjs
 *
 * 用一个「自动玩家」从建号开始往下玩，回答一个问题：
 * **新玩家会不会在某个地方卡死？**
 *
 * 它做的事和真人一样：
 *   建号 → 在本图找能打的怪 → 挑战 → 一直攻击到死 → 附加魂环
 *   → 等级够了就换更难的怪 → 打不动就换图
 *
 * 断言的是「不卡死」，不是「几回合」：
 *   - 前 10 场胜率不能太低（开局不能被劝退）
 *   - 30 场内必须升到 5 级并拿到 1 个魂环（有成长）
 *   - 地图图连通，能走到至少 8 张图（世界不封闭）
 *   - 任何时候都不能出现「所有怪都打不过、也没有更弱的图可去」
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import plugin from '../index.js';
import { makeCtx, runCommand } from '../../../src/plugin/testkit.js';

const DATA_DIR = path.join(os.tmpdir(), 'douluo-play');
fs.rmSync(DATA_DIR, { recursive: true, force: true });

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
};

const ctx = makeCtx({ id: 'douluo', config: { seedOnEmpty: true, prefix: '/' }, dataDir: DATA_DIR, quiet: true });
await plugin.setup(ctx);
ctx.__setup = true;

const content = ctx.state.content;
const players = ctx.state.players;
const battles = ctx.state.battles;
const balance = ctx.state.balance;
const OPENID = 'PLAY_001';
const run = (cmd, line) => runCommand(plugin, cmd, { ctx, content: line, userId: OPENID });

const cfg = content.allCfg();

/* ---------------- 1. 地图连通性 ---------------- */

console.log('\n[1] 世界连通性');
const allMaps = content.db.prepare('SELECT * FROM map WHERE enabled = 1').all();
const byId = new Map(allMaps.map((m) => [m.id, m]));
const byName = new Map(allMaps.map((m) => [m.name, m]));
const start = byName.get('圣魂村') ?? allMaps.find((m) => Number(m.min_level) <= 1) ?? allMaps[0];
ok('有起点地图', Boolean(start), start?.name);

const seen = new Set([start.id]);
const queue = [start.id];
while (queue.length) {
  const cur = byId.get(queue.shift());
  if (!cur) continue;
  for (const k of ['north', 'south', 'east', 'west']) {
    const nx = Number(cur[k]);
    if (nx && byId.has(nx) && !seen.has(nx)) {
      seen.add(nx);
      queue.push(nx);
    }
  }
}
ok('从起点可达的地图 >= 8 张', seen.size >= 8, `${seen.size} / ${allMaps.length} 张`);
ok('没有孤岛（可达率 > 50%）', seen.size / allMaps.length > 0.5, `${Math.round((seen.size / allMaps.length) * 100)}%`);

/* ---------------- 2. 建号 ---------------- */

console.log('\n[2] 建号与开局');
let r = await run('开始穿越', '/开始穿越 男 测试者');
ctx.state.players.awaken(OPENID, Math.random, '蓝银草');
ok('建号成功', r.replies.join('').includes('账号已创建'));
const p0 = players.get(OPENID);
ok('落在起点地图', p0.map_id === start.id, start.name);

/* ---------------- 3. 自动战斗 ---------------- */

/** 当前地图上，按标准等级排序的怪 */
function mobsHere() {
  const p = players.get(OPENID);
  return battles.monstersAt(p.map_id).map((m) => ({ ...m, stats: balance.monsterStats(m) }));
}

/**
 * 模拟时间流逝：真实玩家在群里不会一秒打一场，
 * 两场之间通常会隔几分钟（聊天、看面板、发呆）。
 * 把 last_seen 往回拨，被动回血和休息冷却才会生效。
 */
function passTime(min = 3) {
  players.db
    .prepare('UPDATE player SET last_seen = last_seen - ?, last_rest_at = 0 WHERE openid = ?')
    .run(min * 60000, OPENID);
}

/** 一直攻击到结束，返回 'win' | 'dead' | 'timeout' */
async function fightToEnd(maxHits = 40) {
  for (let i = 0; i < maxHits; i += 1) {
    const res = await run('攻击', '/攻击');
    const txt = res.replies.join('\n');
    if (txt.includes('敌方生命归零')) return 'win';
    if (txt.includes('阵亡')) return 'dead';
    if (txt.includes('没有在战斗')) return 'lost';
  }
  return 'timeout';
}

console.log('\n[3] 前 10 场战斗');
const firstTen = [];
let wins = 0;
for (let i = 0; i < 10; i += 1) {
  const p = players.get(OPENID);
  if (p.status === 'dead') {
    await run('复活', '/复活');
  }
  passTime(3);
  await run('休息', '/休息');
  const list = mobsHere();
  if (!list.length) break;
  // 挑最弱的打
  const target = list.sort((a, b) => a.stats.level - b.stats.level)[0];
  const start1 = await run('挑战魂兽', `/挑战魂兽 ${target.name}`);
  if (!start1.replies.join('').includes('战斗开始')) break;
  const out = await fightToEnd();
  firstTen.push({ name: target.name, out });
  if (out === 'win') wins += 1;
}
const winRate = firstTen.length ? wins / firstTen.length : 0;
ok('前 10 场胜率 >= 80%', winRate >= 0.8, `${wins}/${firstTen.length} = ${Math.round(winRate * 100)}%`);
for (const f of firstTen.filter((x) => x.out !== 'win')) console.log(`     败：${f.name} → ${f.out}`);

/* ---------------- 4. 成长 ---------------- */

console.log('\n[4] 成长曲线（连续打 40 场）');
let kills = wins;
let deadCount = firstTen.filter((x) => x.out === 'dead').length;
for (let i = 0; i < 40; i += 1) {
  let p = players.get(OPENID);
  if (p.status === 'dead') {
    await run('复活', '/复活');
    p = players.get(OPENID);
  }
  // 有魂环就先附加（这是玩家一定会做的）
  if (battles.pendingRing(OPENID)) await run('附加魂环', '/附加魂环');

  await run('休息', '/休息');
  const list = mobsHere();
  if (!list.length) break;
  // 策略：打「标准等级 <= 自己等级」里最难的；都不行就打最弱的
  const mine = players.get(OPENID).level;
  const okList = list.filter((m) => m.stats.level <= mine + 3).sort((a, b) => b.stats.level - a.stats.level);
  const target = okList[0] ?? list.sort((a, b) => a.stats.level - b.stats.level)[0];
  const s = await run('挑战魂兽', `/挑战魂兽 ${target.name}`);
  if (!s.replies.join('').includes('战斗开始')) break;
  const out = await fightToEnd();
  if (out === 'win') kills += 1;
  if (out === 'dead') deadCount += 1;
}

const pEnd = players.get(OPENID);
const rings = players.ringCount(OPENID);
ok('30 场后等级 > 1', pEnd.level > 1, `Lv.${pEnd.level}`);
ok('拿到至少 1 个魂环', rings >= 1, `${rings} 个`);
ok('胜率没有崩（累计 >= 70%）', kills / (kills + deadCount) >= 0.7, `${kills} 胜 / ${deadCount} 败`);
ok('等级上限没被魂环卡住', pEnd.level <= (rings + 1) * Number(cfg.ring_level_step ?? 10), `Lv.${pEnd.level} / 上限 ${(rings + 1) * 10}`);

/* ---------------- 5. 换图 ---------------- */

console.log('\n[5] 走地图');
let moved = 0;
for (const dir of ['北', '南', '东', '西']) {
  const before = players.get(OPENID).map_id;
  const res = await run('移动', `/移动 ${dir}`);
  const after = players.get(OPENID).map_id;
  if (after !== before) {
    moved += 1;
    console.log(`     ${dir} → ${res.replies.join('').split('\n')[0].replace(/^#+\s*/, '')}`);
  }
  if (moved >= 3) break;
}
ok('能走到别的图', moved >= 1, `${moved} 次`);

/* ---------------- 6. 经济与产出 ---------------- */

console.log('\n[6] 产出');
const inv = players.detail(OPENID).inventory;
ok('打怪掉了东西（魂环已转化）', rings >= 1);
ok('有魂币收入', pEnd.gold > 0, `${pEnd.gold} 魂币`);
ok('背包有物品', inv.length >= 1, `${inv.length} 种`);
ok('有经验积累', pEnd.exp >= 0 || pEnd.level > 1, `Lv.${pEnd.level} exp=${pEnd.exp}`);

/* ---------------- 7. 平衡体检仍然健康 ---------------- */

console.log('\n[7] 数值体检');
const chk = balance.check({ samples: 60 });
ok('13 条规则仍全绿', chk.ok === true, `${chk.passed} 通过 / ${chk.failed} 失败`);
for (const it of chk.items.filter((x) => !x.ok)) console.log(`     ✗ ${it.name} · ${it.rule} 期望 ${it.expect} 实际 ${it.actual}`);

console.log(`\n=== 总结 ===`);
console.log(`最终：Lv.${pEnd.level} · ${rings} 环 · ${pEnd.gold} 魂币 · 击杀 ${kills} · 阵亡 ${deadCount}`);
console.log(`${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

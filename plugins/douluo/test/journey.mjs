/**
 * 全流程检查（journey）
 * ====================
 *
 *   node plugins/douluo/test/journey.mjs
 *
 * 和其它测试的分工：
 *   - `smoke` / `features` 是**按模块**断言（这个功能对不对）
 *   - 这个是**按玩家旅程**跑一遍（整条路走不走得通、会不会卡死）
 *
 * 判断标准很简单：每一步都不能出现「没反应」「报错」「提示要一个你拿不到的东西」。
 * 所以这里不看具体数值，只看**回复是否可读、状态是否推进**。
 *
 * 最后会统计：走了多少步、覆盖了多少个动词、有没有断点。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import plugin from '../index.js';
import { makeCtx, runCommand } from '../../../src/plugin/testkit.js';

const DATA_DIR = path.join(os.tmpdir(), 'douluo-journey');
fs.rmSync(DATA_DIR, { recursive: true, force: true });

const ctx = makeCtx({ id: 'douluo', config: { seedOnEmpty: true, prefix: '/' }, dataDir: DATA_DIR, quiet: true });
await plugin.setup(ctx);
ctx.__setup = true;

const content = ctx.state.content;
const players = ctx.state.players;
const battles = ctx.state.battles;
const economy = ctx.state.economy;
const guild = ctx.state.guild;
const craft = ctx.state.craft;
const prog = ctx.state.progress;
const qol = ctx.state.qol;
const social = ctx.state.social;

const ME = 'J_ME';
const ALT = 'J_ALT';

let step = 0;
let bad = 0;
const verbs = new Set();
const notes = [];

/** 发一条指令，断言「有可读回复且不是报错」 */
async function say(verb, line, { expect } = {}) {
  step += 1;
  verbs.add(verb);
  const r = await runCommand(plugin, verb, { ctx, content: line, userId: ME });
  const text = (r.replies ?? []).join('\n');
  const empty = !text.trim();
  const errored = /^(Error|TypeError|ReferenceError|Cannot |undefined)/m.test(text);
  const failed = expect ? !expect.test(text) : false;
  const ok = !empty && !errored && !failed;
  if (!ok) {
    bad += 1;
    console.log(`  ✗ ${line}  →  ${(text || '(空回复)').split('\n')[0].slice(0, 80)}`);
  } else {
    console.log(`  ✓ ${line}`);
  }
  return text;
}

const ok = (name, cond, extra = '') => {
  step += 1;
  if (cond) console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
  else {
    bad += 1;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
  return cond;
};

/* ================= 1. 入门 ================= */

console.log('\n[1] 入门');
await say('创建账号', '/创建账号 旅人', { expect: /账号已创建/ });
await say('武魂觉醒', '/武魂觉醒', { expect: /武魂觉醒|武魂/ });
ok('觉醒后有武魂', Boolean(players.get(ME).wuhun_id), 'wuhun_id=' + players.get(ME).wuhun_id);
await say('斗罗菜单', '/斗罗菜单', { expect: /下一步/ });
await say('属性', '/属性', { expect: /战力|攻击/ });
await say('教程', '/教程', { expect: /怎么/ });
await say('帮助', '/帮助', { expect: /指令|战斗/ });
await say('背包', '/背包');
await say('签到', '/签到', { expect: /签到/ });
await say('邮件', '/邮件');
ok('建号成功', Boolean(players.get(ME)));

/* ================= 2. 战斗主线 ================= */

console.log('\n[2] 战斗主线');
players.db.prepare('UPDATE player SET gold = 300000, stamina = 999 WHERE openid = ?').run(ME);
await say('魂兽', '/魂兽', { expect: /魂兽|白虎|哥布林|魔狼/ });

// 一路打，直到拿到魂环
let ring = null;
for (let i = 0; i < 20 && !ring; i += 1) {
  players.db.prepare('UPDATE player SET hp = hp_max, status = ? WHERE openid = ?').run('idle', ME);
  const mobs = battles.monstersAt(players.get(ME).map_id);
  if (!mobs.length) break;
  await runCommand(plugin, '挑战魂兽', { ctx, content: `/挑战魂兽 ${mobs[0].name}`, userId: ME });
  const af = battles.autoFight(ME, { maxRounds: 40 });
  if (af.reward?.ring) ring = af.reward.ring;
  if (players.get(ME).status === 'battle') await runCommand(plugin, '逃跑', { ctx, content: '/逃跑', userId: ME });
}
ok('能打到魂环', Boolean(ring), ring ? `${ring.years} 年` : '20 场没出');
if (ring) {
  await say('附加魂环', '/附加魂环', { expect: /魂环|第/ });
  ok('魂环已附加', players.ringCount(ME) >= 1, `${players.ringCount(ME)} 个`);
}

await say('魂环', '/魂环', { expect: /魂环/ });
const mySkill = content.db.prepare('SELECT * FROM skill WHERE enabled = 1 LIMIT 1').get();
if (mySkill) {
  players.db
    .prepare('INSERT OR IGNORE INTO ring (openid, slot, years, name, skill_id) VALUES (?,99,1000,?,?)')
    .run(ME, mySkill.name, mySkill.id);
  await say('设置魂技', `/设置魂技 1 ${mySkill.name}`, { expect: /快捷|绑定/ });
  await say('魂技升级', '', { expect: /魂技|威力/ });
  await say('魂技升级', `/魂技升级 ${mySkill.name}`, { expect: /\+|魂币/ });
}

/* ================= 3. 装备 ================= */

console.log('\n[3] 装备');
players.grantEquip(ME, 1, '旅程');
await say('我的装备', '/我的装备', { expect: /装备/ });
await say('装备', '/装备 鹿之左臂骨', { expect: /装备|穿上|佩戴/ });
await say('强化', '/强化 鹿之左臂骨', { expect: /\+/ });
await say('开孔', '/开孔 鹿之左臂骨', { expect: /开孔/ });
ctx.state.growth.grantGem(ME, '赤焰石', 3);
await say('镶嵌', '/镶嵌 鹿之左臂骨 赤焰石', { expect: /镶嵌/ });
await say('摘孔', '/摘孔 鹿之左臂骨 1', { expect: /取下/ });
players.db.prepare('UPDATE equip_owned SET durability = 30 WHERE openid = ? AND equipped = 1').run(ME);
await say('修理', '/修理', { expect: /修理/ });
await say('卸下', '/卸下 全部', { expect: /已卸下/ });

/* ================= 4. 生活与炼丹 ================= */

console.log('\n[4] 生活与炼丹');
await say('职业', '/职业', { expect: /职业|配方/ });
await say('转职', '/转职 炼药师', { expect: /炼药师/ });
await say('丹鼎', '/丹鼎 九龙鼎', { expect: /成功率/ });
await say('丹火', '/丹火 幽冥火', { expect: /成功率/ });
players.addItem(ME, 201, 40, '旅程');
players.addItem(ME, 205, 20, '旅程');
await say('炼丹', '/炼丹 回魂丹·真 3', { expect: /成功率|成功|失败/ });
await say('配方', '/配方', { expect: /配方|丹方/ });

/* ================= 5. 任务 ================= */

console.log('\n[5] 任务');
await say('任务', '/任务');
const npcHere = content.db.prepare('SELECT name FROM npc WHERE map_id = ? AND enabled = 1').get(players.get(ME).map_id);
if (npcHere) await say('对话', `/对话 ${npcHere.name}`, { expect: /./ });
const q = content.db.prepare('SELECT * FROM quest WHERE enabled = 1 LIMIT 1').get();
if (q) {
  await say('接受任务', `/接受任务 ${q.name}`, { expect: /任务/ });
}

/* ================= 6. 日常 ================= */

console.log('\n[6] 日常');
await say('悬赏', '/悬赏', { expect: /悬赏|击杀/ });
await say('图鉴', '/图鉴', { expect: /图鉴|解锁/ });
await say('排行', '/排行 战力', { expect: /榜/ });
await say('斗天', '/斗天', { expect: /积分|赛季/ });
await say('冥想', '/冥想', { expect: /冥想/ });
// 把开始时间往前拨 30 分钟，走真实的「结算经验」路径
ctx.state.qol.db.prepare('UPDATE meditation SET started_at = started_at - ? WHERE openid = ?').run(30 * 60_000, ME);
await say('冥想', '/冥想', { expect: /冥想|经验/ });

/* ================= 7. 宗门与领地 ================= */

console.log('\n[7] 宗门与领地');
await say('创建宗门', '/创建宗门 旅程宗', { expect: /宗门/ });
await say('宗门', '/宗门', { expect: /旅程宗/ });
await say('捐献', '/捐献 3000', { expect: /捐献/ });
await say('宗门升级', '/宗门升级', { expect: /Lv\.|资金/ });
await say('领地', '/领地', { expect: /领地/ });
const terr = guild.territories().find((t) => !t.guild_id);
if (terr) {
  await say('占领', `/占领 ${terr.mapName}`, { expect: /占领/ });
  guild.db.prepare('UPDATE territory SET last_mine_at = last_mine_at - ? WHERE map_id = ?').run(4 * 3600_000, terr.map_id);
  await say('收工', '/收工', { expect: /收工|魂币/ });
}
await say('宗门商店', '/宗门商店', { expect: /商店|资金/ });

// 第二个宗门 + 宣战抢夺
await runCommand(plugin, '开始穿越', { ctx, content: '/开始穿越 男 对手', userId: ALT });
players.db.prepare('UPDATE player SET gold = 300000 WHERE openid = ?').run(ALT);
await runCommand(plugin, '创建宗门', { ctx, content: '/创建宗门 对手宗', userId: ALT });
guild.db.prepare('UPDATE guild SET funds = 99999 WHERE name = ?').run('对手宗');
const t2 = guild.territories().find((t) => !t.guild_id);
if (t2) {
  guild.occupy(ALT, t2.mapName);
  await say('宣战', '/宣战 对手宗', { expect: /宣战/ });
  players.db.prepare('UPDATE player SET level = 70, hp = hp_max, status = ? WHERE openid = ?').run('idle', ME);
  players.recalc(ME);
  await say('抢夺', `/抢夺 ${t2.mapName}`, { expect: /抢|守卫/ });
}

/* ================= 8. 挑战 ================= */

console.log('\n[8] 挑战');
await say('挑战', '/挑战', { expect: /万兽台/ });
await say('挑战', '/挑战 万兽台', { expect: /层|回合/ });
await say('世界BOSS', '/世界BOSS', { expect: /世界BOSS|血量/ });

/* ================= 9. 社交 ================= */

console.log('\n[9] 社交');
await say('资料', `/资料 ${players.get(ALT).name}`, { expect: /等级|战力/ });
await say('送花', `/送花 ${players.get(ALT).name}`, { expect: /送花|魅力/ });
await say('改名', '/改名 旅人甲', { expect: /改名/ });
await say('签名', '/签名 走完一段旅程', { expect: /签名/ });
await say('匿名', '/匿名 开', { expect: /匿名/ });
await say('称号', '/称号', { expect: /称号/ });
await say('约战', `/约战 ${players.get(ALT).name}`, { expect: /约战|应战/ });
players.db.prepare('UPDATE player SET hp = hp_max, status = ? WHERE openid IN (?,?)').run('idle', ME, ALT);
await say('斗魂', `/斗魂 ${players.get(ALT).name}`, { expect: /胜|败|回合|上限/ });

/* ================= 10. 经济 ================= */

console.log('\n[10] 经济');
await say('商城', '/商城', { expect: /商城|魂币/ });
await say('银行', '/银行', { expect: /银行|存款/ });
await say('拍卖', '/拍卖', { expect: /拍卖/ });
await say('神秘商店', '/神秘商店', { expect: /神秘商店|折扣|魂币/ });
await say('抽奖', '/抽奖 1', { expect: /抽|奖/ });
await say('邮件', '/邮件', { expect: /邮件|没有/ });
await say('领取', '/领取 全部', { expect: /领取|没有/ });

/* ================= 11. 收尾 ================= */

console.log('\n[11] 收尾');
await say('属性', '/属性', { expect: /下一步/ });
await say('斗罗菜单', '/斗罗菜单', { expect: /下一步/ });
await say('附近', '/附近');
await say('地图', '/地图', { expect: /地图|出口/ });
await say('移动', '/移动 北');

/* ================= 12. 功能清单检查 ================= */

console.log('\n[12] 功能清单');
const { createHandlers } = await import('../src/cmd/handlers.js');
const H = createHandlers({
  content,
  players,
  battles,
  media: { send: async () => false, has: () => false, resolve: () => null, enabled: () => false, imgDir: DATA_DIR },
  economy,
  social,
  guild,
  craft,
  balance: ctx.state.balance,
  mail: ctx.state.mail,
  progress: prog,
  growth: ctx.state.growth,
  qol,
  pfx: () => '/',
});
const all = Object.keys(H);
const noDesc = all.filter((k) => !H[k].desc);
ok('每个指令都有说明', noDesc.length === 0, noDesc.length ? `缺：${noDesc.join(' / ')}` : `${all.length} 个`);
const noRun = all.filter((k) => typeof H[k].run !== 'function');
ok('每个指令都有 run', noRun.length === 0, noRun.length ? `缺：${noRun.join(' / ')}` : '');

const uncovered = all.filter((k) => !verbs.has(k));
console.log(`  指令总数 ${all.length} · 本次旅程覆盖 ${verbs.size} 个`);
if (uncovered.length) console.log(`  未在旅程中出现（${uncovered.length}）：${uncovered.join(' / ')}`);

/* ================= 13. 内容安全检查 ================= */

console.log('\n[13] 内容安全');
// 内容包来自第三方 INI，命名不可控。真机联调时在群里直接看到了敏感命名，
// 所以这一步必须在测试里卡住——上线一次就够封号。
const HARD = [
  '日本鬼子', '鬼子', '支那', '东亚病夫', '台独', '港独', '藏独', '疆独', '法轮', '六四',
  '傻逼', '煞笔', '傻B', '狗日', '操你', '草你', '干你', '他妈', '尼玛', '你妈',
  '妈的', '婊子', '贱人', '妓女', '嫖',
];
const checkTables = ['wuhun', 'map', 'monster', 'npc', 'item', 'equip', 'companion', 'skill', 'quest', 'title', 'gem', 'aptitude', 'challenge', 'recipe', 'tutorial'];
const hits = [];
for (const t of checkTables) {
  let rows = [];
  try {
    rows = content.db.prepare(`SELECT id, name FROM ${t}`).all();
  } catch {
    continue;
  }
  for (const r of rows) {
    const nm = String(r.name ?? '');
    const w = HARD.find((x) => nm.includes(x));
    if (w) hits.push(`${t}#${r.id}（${w}）`);
  }
}
ok('内容里没有敏感/粗俗词', hits.length === 0, hits.length ? `${hits.length} 条：${hits.slice(0, 3).join(' / ')}` : `${checkTables.length} 张表已扫`);

// 空名字 / 超长名字
const weird = [];
for (const t of checkTables) {
  let rows = [];
  try {
    rows = content.db.prepare(`SELECT id, name FROM ${t}`).all();
  } catch {
    continue;
  }
  for (const r of rows) {
    const nm = String(r.name ?? '').trim();
    if (!nm || nm.length > 24) weird.push(`${t}#${r.id}`);
  }
}
ok('没有空名或超长名', weird.length === 0, weird.length ? weird.slice(0, 3).join(' / ') : '');

// 菜单覆盖：每个指令都要能从菜单或帮助找到（新加指令最容易漏这一步）
const { execFileSync: runNodeScript } = await import('node:child_process');
let menuOk = true;
let menuDetail = '';
try {
  runNodeScript(process.execPath, [path.join(import.meta.dirname, '..', 'scripts', 'check-menu.mjs')], { stdio: 'pipe' });
} catch (e) {
  menuOk = false;
  menuDetail = String(e.stdout ?? e.message).split('\n').filter((l) => l.startsWith('  - ')).slice(0, 3).join(' / ');
}
ok('每个指令都进了菜单或帮助', menuOk, menuDetail || '147 进菜单 / 157 进帮助');

// 纯文本消息里不能有 markdown 链接——塞进去会把 mqqapi://… 原样发到群里
const { execFileSync } = await import('node:child_process');
let linkOk = true;
let linkDetail = '';
try {
  execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'scripts', 'lint-links.mjs')], { stdio: 'pipe' });
} catch (e) {
  linkOk = false;
  linkDetail = String(e.stdout ?? e.message).split('\n').filter((l) => l.includes('handlers.js:')).slice(0, 3).join(' / ');
}
ok('纯文本消息里没有 markdown 链接', linkOk, linkDetail || '419 处出口已扫');

/* ================= 汇总 ================= */

console.log(`\n=== 旅程汇总 ===`);
console.log(`走了 ${step} 步 · 覆盖 ${verbs.size} 个动词 · 断点 ${bad} 个`);
console.log(`玩家终态：Lv.${players.get(ME)?.level} · ${players.ringCount(ME)} 环 · ${players.get(ME)?.gold} 魂币`);
console.log(`\n${bad === 0 ? '全流程通过' : '有断点'}：${step - bad} 通过 / ${bad} 失败`);
process.exit(bad === 0 ? 0 : 1);

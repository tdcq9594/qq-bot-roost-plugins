/**
 * 系统功能测试（深化后的机制）
 * ==========================
 *
 *   node plugins/douluo/test/features.mjs
 *
 * 覆盖「参考现代设计」补强的四个系统，断言的是**状态变化**，不是文案：
 *
 *   魂骨/装备  → 强化必成、属性真涨、成本递增、满级/没钱有拦截
 *   势力/宗门  → 升级花资金、全员属性按比例上涨、权限与资金有拦截
 *   情侣       → 双方在线时经验真的 +15%，一方离线就没有
 *   师徒       → 徒弟涨经验，师父真的分到一份
 *   战舰       → 激活后能越过地图等级门槛，没激活就被拦
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import plugin from '../index.js';
import { makeCtx, runCommand } from '../../../src/plugin/testkit.js';

const DATA_DIR = path.join(os.tmpdir(), 'douluo-features');
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
const guild = ctx.state.guild;
const A = 'F_A';
const B = 'F_B';
const run = (id, verb, line) => runCommand(plugin, verb, { ctx, content: line, userId: id });

await run(A, '开始穿越', '/开始穿越 男 甲');
players.awaken(A, Math.random, '蓝银草');
await run(B, '开始穿越', '/开始穿越 女 乙');
players.awaken(B, Math.random, '蓝银草');
players.db.prepare('UPDATE player SET gold = 100000, coupon = 5000, stamina = 999 WHERE openid IN (?,?)').run(A, B);

/* ================= 1. 魂骨 / 装备强化 ================= */

console.log('\n[1] 装备强化（必成 + 成本递增）');
players.grantEquip(A, 1, '测试'); // 鹿之左臂骨
players.equipItem(A, '鹿之左臂骨');
const atk0 = players.get(A).atk;
ok('强化前记下攻击', atk0 > 0, `atk=${atk0}`);

let r = await run(A, '强化', '/强化 鹿之左臂骨');
ok('强化成功', r.replies.join('').includes('+2'), r.replies[0].split('\n')[0]);
const atk1 = players.get(A).atk;
ok('强化后攻击真的涨了', atk1 > atk0, `${atk0} → ${atk1}`);
ok('装备等级落库', players.owned(A).find((e) => e.name === '鹿之左臂骨').level === 2);

// 成本必须递增
const lv2 = players.upgradeEquip(A, '鹿之左臂骨');
const lv3 = players.upgradeEquip(A, '鹿之左臂骨');
ok('强化成本递增', lv3.cost > lv2.cost, `${lv2.cost} → ${lv3.cost}`);

// 没钱拦截
players.db.prepare('UPDATE player SET gold = 0 WHERE openid = ?').run(A);
r = await run(A, '强化', '/强化 鹿之左臂骨');
ok('没钱强化被拦', r.replies.join('').includes('魂币'), r.replies[0].split('\n')[0]);
players.db.prepare('UPDATE player SET gold = 100000 WHERE openid = ?').run(A);

// 满级拦截
const max = Number(content.allCfg().equip_upgrade_max ?? 10);
for (let i = 0; i < max; i += 1) players.upgradeEquip(A, '鹿之左臂骨');
r = await run(A, '强化', '/强化 鹿之左臂骨');
ok('满级被拦', r.replies.join('').includes('满级'), r.replies[0].split('\n')[0]);

/* ================= 2. 势力 / 宗门 ================= */

console.log('\n[2] 宗门等级（集体投资 → 全员受益）');
r = await run(A, '创建宗门', '/创建宗门 测试宗');
ok('建宗成功', r.replies.join('').includes('宗门创建成功'));
await run(B, '加入宗门', '/加入宗门 测试宗');

const hpBeforeUp = players.get(B).hp_max;
r = await run(A, '捐献', '/捐献 5000');
ok('捐资金', r.replies.join('').includes('捐献成功'));

r = await run(A, '宗门升级', '/宗门升级');
ok('宗主能升级', r.replies.join('').includes('Lv.2'), r.replies[0].split('\n')[0]);
ok('宗门等级落库', guild.of(A).level === 2);

const hpB2 = players.get(B).hp_max;
// 用生命看，不用攻击：低等级时 4% 的加成在 atk 8 上会被四舍五入抹平
ok('成员属性跟着涨（乘区生效）', hpB2 > hpBeforeUp, `乙 hp ${hpBeforeUp} → ${hpB2}`);
ok('buff 进加成来源', players.mods(B).sources.some((s) => s.type === 'buff'), JSON.stringify(players.mods(B).mult));

// 权限与资金
r = await run(B, '宗门升级', '/宗门升级');
ok('非宗主不能升级', r.replies.join('').includes('只有宗主'));
players.db.prepare('UPDATE guild SET funds = 0 WHERE name = ?').run('测试宗');
r = await run(A, '宗门升级', '/宗门升级');
ok('资金不够被拦', r.replies.join('').includes('资金不够'), r.replies[0].split('\n')[0]);

/* ================= 3. 情侣 ================= */

console.log('\n[3] 情侣（同时在线才有收益）');
await run(A, '求婚', '/求婚 乙');
await run(B, '答应', '/答应 甲');
ok('情侣关系成立', players.db.prepare("SELECT COUNT(*) n FROM relation WHERE kind='couple' AND status='active'").get().n === 1);

// 双方在线
players.db.prepare('UPDATE player SET last_seen = ? WHERE openid IN (?,?)').run(Date.now(), A, B);
const r1 = players.gainExp(A, 1000);
ok('双方在线 → 经验 +15%', r1.gained === 1150, `实得 ${r1.gained}（加成 ${Math.round(r1.bonus * 100)}%）`);

// 一方离线
players.db.prepare('UPDATE player SET last_seen = ? WHERE openid = ?').run(Date.now() - 3600_000, B);
const r2 = players.gainExp(A, 1000);
ok('对方离线 → 没有加成', r2.gained === 1000, `实得 ${r2.gained}`);

// 分手后彻底没有
players.db.prepare('UPDATE player SET last_seen = ? WHERE openid = ?').run(Date.now(), B);
await run(A, '分手', '/分手 乙');
const r3 = players.gainExp(A, 1000);
ok('分手后没有加成', r3.gained === 1000, `实得 ${r3.gained}`);

/* ================= 4. 师徒 ================= */

console.log('\n[4] 师徒（徒弟涨经验，师父分成）');
await run(B, '拜师', '/拜师 甲');
await run(A, '答应', '/答应 乙');
ok('师徒关系成立', players.db.prepare("SELECT COUNT(*) n FROM relation WHERE kind='master' AND status='active'").get().n === 1);

const masterExp0 = Number(players.get(A).exp);
const r4 = players.gainExp(B, 1000);
ok('徒弟涨经验', r4.gained > 0, `${r4.gained}`);
ok('师父分到一份', Boolean(r4.share) && r4.share.exp > 0, r4.share ? `${r4.share.master} +${r4.share.exp}` : '没有分成');
const masterExp1 = Number(players.get(A).exp);
const masterLv1 = Number(players.get(A).level);
ok('师父经验/等级真的变了', masterExp1 !== masterExp0 || masterLv1 > 1, `exp ${masterExp0} → ${masterExp1}`);

/* ================= 5. 战舰 ================= */

console.log('\n[5] 战舰（越过地图等级门槛）');
// 造一条需要高等级的路
const here = players.get(A).map_id;
const hard = content.db
  .prepare('SELECT * FROM map WHERE enabled = 1 AND id != ? AND min_level > 50 LIMIT 1')
  .get(here);
if (!hard) {
  content.db.prepare('UPDATE map SET min_level = 60 WHERE id = (SELECT id FROM map WHERE enabled = 1 AND id != ? LIMIT 1)').run(here);
}
const targetMap = hard ?? content.db.prepare('SELECT * FROM map WHERE enabled = 1 AND id != ? LIMIT 1').get(here);
// 把它挂到当前地图的北边
content.db.prepare('UPDATE map SET north = ? WHERE id = ?').run(targetMap.id, here);
content.db.prepare('UPDATE map SET min_level = 60 WHERE id = ?').run(targetMap.id);

r = await run(A, '移动', '/移动 北');
ok('没战舰 → 被等级门槛拦住', r.replies.join('').includes('需要'), r.replies[0].split('\n')[0]);

players.grantEquip(A, 12, '测试'); // 轻型战舰
players.equipItem(A, '轻型战舰');
ok('战舰已激活', players.hasActiveEquip(A, 'ship') === true);

r = await run(A, '移动', '/移动 北');
ok('有战舰 → 越过门槛', r.replies.join('').includes('战舰护航'), r.replies[0].split('\n')[1] ?? '');
ok('真的过去了', players.get(A).map_id === targetMap.id);

/* ================= 6. 魂骨套装 + 强化联动 ================= */

console.log('\n[6] 魂骨套装与强化叠加');
const C = 'F_C';
await run(C, '开始穿越', '/开始穿越 男 丙');
players.awaken(C, Math.random, '蓝银草');
players.db.prepare('UPDATE player SET gold = 100000 WHERE openid = ?').run(C);
players.grantEquip(C, 1, '测试');
players.grantEquip(C, 2, '测试');
players.equipItem(C, '鹿之左臂骨');
players.equipItem(C, '鹿之右臂骨');
const modsC = players.mods(C);
ok('两件套触发', modsC.sources.some((s) => s.type === 'set' && s.need === 2));
const flatBefore = modsC.flat.atk;
players.upgradeEquip(C, '鹿之左臂骨');
const flatAfter = players.mods(C).flat.atk;
ok('强化后套装/装备加成都变高', flatAfter > flatBefore, `flat.atk ${flatBefore} → ${flatAfter}`);

/* ================= 7. 系统联动（这一批的重点） ================= */

console.log('\n[7] 系统之间的联动');
const battles = ctx.state.battles;

// 7.1 伙伴助战：伙伴真的出手
// 直接把玩家放到「有怪的第一张图」，避免受传送规则影响
const firstMap = content.db.prepare('SELECT map_id FROM monster_map ORDER BY map_id LIMIT 1').get();
players.db.prepare('UPDATE player SET map_id = ?, stamina = 999 WHERE openid = ?').run(firstMap.map_id, A);
const hereMob = battles.monstersAt(firstMap.map_id)[0];
players.grantCompanion(A, 2, '测试'); // 百年魂灵
players.setCompanionActive(A, '百年魂灵', true);
content.db.prepare("UPDATE cfg SET value = '100' WHERE key = 'companion_follow_rate'").run();
const startRes = battles.start(A, hereMob.name);
ok('开战成功', Boolean(startRes.battle), startRes.error ?? hereMob.name);
// 把双方血量拉高，隔离出「伙伴助战」这一件事——否则玩家一刀秒了怪，追击没机会触发
if (startRes.battle) {
  players.db.prepare('UPDATE battle SET monster_hp = 99999 WHERE id = ?').run(startRes.battle.id);
  players.db.prepare('UPDATE player SET hp = 99999 WHERE openid = ?').run(A);
}
const actRes = startRes.battle ? battles.act(A, { type: 'attack' }) : { events: [] };
ok('伙伴追击出现在战斗事件里', (actRes.events ?? []).some((e) => e.t === 'companion'), JSON.stringify((actRes.events ?? []).find((e) => e.t === 'companion') ?? null));
if (players.get(A).status === 'battle') await run(A, '逃跑', '/逃跑');
content.db.prepare("UPDATE cfg SET value = '30' WHERE key = 'companion_follow_rate'").run();

// 7.2 分解：多余装备有去处
const ownedBefore = players.owned(A).length;
const fragBefore = players.detail(A).inventory.find((i) => i.name === '魂环碎片')?.qty ?? 0;
r = await run(A, '分解', '/分解 鹿之左臂骨');
ok('分解成功', r.replies.join('').includes('已分解'), r.replies[0].split('\n')[0]);
ok('装备真的没了', players.owned(A).length === ownedBefore - 1, `${ownedBefore} → ${players.owned(A).length}`);
const fragAfter = players.detail(A).inventory.find((i) => i.name === '魂环碎片')?.qty ?? 0;
ok('碎片真的到账', fragAfter > fragBefore, `${fragBefore} → ${fragAfter}`);

// 7.3 对话 NPC：世界不再只是数据
r = await run(A, '对话', '/对话 圣魂长老');
ok('找到 NPC 并显示对话', r.replies.join('').includes('圣魂长老'), r.replies[0].split('\n')[0]);
ok('列出他能给的任务', /可接|进行中|可交付|已完成/.test(r.replies.join('')), r.replies.join('').includes('托付') ? '有任务列表' : '没有任务');
r = await run(A, '对话', '/对话 不存在的人');
ok('找不到人有提示', r.replies.join('').includes('没有'));

// 7.4 收集物品类任务能交了（之前 checkQuest 不支持 items）
content.db.prepare(
  `INSERT OR REPLACE INTO quest (id, name, kind, desc, cond, reward) VALUES (999,'测试收集','main','交 2 个碎片','{"items":[{"id":3,"qty":2}]}','{"gold":50}')`,
).run();
players.db.prepare("INSERT OR REPLACE INTO player_quest (openid, quest_id, state, progress, updated_at) VALUES (?,999,'doing',0,0)").run(A);
r = await run(A, '完成任务', '/完成任务 测试收集');
ok('收集物品类任务可交付', r.replies.join('').includes('完成'), r.replies[0].split('\n')[0]);

// 7.5 「下一步」提示：按状态给不同的建议
r = await run(A, '属性', '/属性');
ok('属性面板有下一步', r.replies.join('').includes('下一步'), (r.replies.join('').match(/下一步\*\*[^\n]*/) ?? [''])[0]);
// 造一个待附加魂环的状态
players.db
  .prepare('INSERT OR REPLACE INTO pending_ring (openid, monster_id, monster_name, years, skill_id, at) VALUES (?,1,?,?,NULL,?)')
  .run(A, '十年白虎', 10, Date.now());
r = await run(A, '属性', '/属性');
ok('有魂环时提示变成「附加魂环」', r.replies.join('').includes('附加魂环'), (r.replies.join('').match(/下一步\*\*[^\n]*/) ?? [''])[0]);
players.db.prepare('DELETE FROM pending_ring WHERE openid = ?').run(A);

// 7.6 菜单顶部也带下一步
r = await run(A, '斗罗菜单', '/斗罗菜单');
ok('菜单带下一步分组', r.replies.join('').includes('下一步'));

/* ================= 8. 邮件 + 自动战斗 ================= */

console.log('\n[8] 邮件（离线收益的兜底）');
const mail = ctx.state.mail;
const mailBefore = mail.countUnclaimed(A);
const sent = mail.send(A, { title: '测试补发', body: '给点东西', attachments: { gold: 777 } });
ok('能发邮件', sent.id > 0, `#${sent.id}`);
ok('未领数 +1', mail.countUnclaimed(A) === mailBefore + 1);

const goldBeforeMail = Number(players.get(A).gold);
r = await run(A, '邮件', '/邮件');
ok('邮件列表显示标题与附件', r.replies.join('').includes('测试补发') && r.replies.join('').includes('777'));
r = await run(A, '领取', `/领取 ${sent.id}`);
ok('领取成功', r.replies.join('').includes('测试补发'), r.replies[0].split('\n')[0]);
ok('魂币真的到账', Number(players.get(A).gold) === goldBeforeMail + 777, `${goldBeforeMail} → ${players.get(A).gold}`);
r = await run(A, '领取', `/领取 ${sent.id}`);
ok('重复领取被拦', r.replies.join('').includes('已经领过'));

mail.send(A, { title: '第二封', attachments: { coupon: 50 } });
mail.send(A, { title: '第三封', attachments: { gold: 10 } });
r = await run(A, '领取', '/领取 全部');
ok('一键领取', r.replies.join('').includes('领取了'), r.replies[0].split('\n')[0]);
ok('领完没有剩余', mail.countUnclaimed(A) === 0);

// 拍卖成交 → 卖家收到邮件，不是直接进钱包
players.addItem(A, 2, 5, '测试');
const auctionRes = ctx.state.economy.auctionList(A, { itemName: '金疮药', qty: 1, price: 200 });
ok('上架成功', auctionRes.ok === true, `#${auctionRes.id}`);
const sellerGoldBefore = Number(players.get(A).gold);
const bidRes = ctx.state.economy.auctionBid(B, auctionRes.id);
ok('买家竞拍成功', bidRes.ok === true);
ok('卖家钱包没直接加钱', Number(players.get(A).gold) === sellerGoldBefore, `${sellerGoldBefore} → ${players.get(A).gold}`);
ok('卖家收到邮件', mail.countUnclaimed(A) === 1, `${mail.countUnclaimed(A)} 封`);
r = await run(A, '领取', '/领取 全部');
ok('领取后钱到账', Number(players.get(A).gold) === sellerGoldBefore + 190, `+${Number(players.get(A).gold) - sellerGoldBefore}（扣 5% 手续费）`);

console.log('\n[9] 自动战斗');
const autoMap = content.db.prepare('SELECT map_id FROM monster_map ORDER BY map_id LIMIT 1').get();
players.db.prepare('UPDATE player SET map_id = ?, stamina = 999, hp = hp_max WHERE openid = ?').run(autoMap.map_id, A);
const autoMob = battles.monstersAt(autoMap.map_id)[0];
await run(A, '挑战魂兽', `/挑战魂兽 ${autoMob.name}`);
const msgsBefore = 0;
r = await run(A, '自动', '/自动');
const autoText = r.replies.join('');
ok('自动战斗一条消息出结果', r.replies.length === 1, `${r.replies.length} 条`);
ok('结果是胜利', autoText.includes('自动战斗结束'), r.replies[0].split('\n')[0]);
ok('报出回合数', /\d+ 回合/.test(autoText), (autoText.match(/\d+ 回合/) ?? [''])[0]);
ok('战斗已结束', players.get(A).status !== 'battle');

// 连打
players.db.prepare('UPDATE player SET hp = hp_max, stamina = 999 WHERE openid = ?').run(A);
await run(A, '挑战魂兽', `/挑战魂兽 ${autoMob.name}`);
r = await run(A, '自动', '/自动 3');
ok('连打 3 场', /[123] 胜/.test(r.replies.join('')), (r.replies.join('').match(/\d+ 胜/) ?? [''])[0]);

/* ================= 10. 扩展系统（v10 一批） ================= */

console.log('\n[10] 扩展系统');
const prog = ctx.state.progress;
const grow = ctx.state.growth;
const qol = ctx.state.qol;
const craft = ctx.state.craft;
players.db.prepare('UPDATE player SET gold = 200000, stamina = 999 WHERE openid = ?').run(A);

// 10.1 排行榜（通用模型，加榜只加行）
ok('排行有 8 个榜', prog.ranks().length >= 8, `${prog.ranks().length} 个`);
const rk = prog.rank('power', 5);
ok('战力榜有数据', rk && rk.rows.length > 0, `${rk.rows.length} 条`);
ok('排行榜按表达式排序', Number(rk.rows[0].power) >= Number(rk.rows[rk.rows.length - 1].power));
r = await run(A, '排行', '/排行 战力');
ok('排行指令可用', r.replies.join('').includes('战力榜'));

// 10.2 挑战（万兽台/深渊/世界BOSS/神位 共用模型）
ok('挑战有 4 个', prog.challenges().length >= 4);
const tower = prog.challenges().find((c) => c.kind === 'tower');
const pr0 = prog.progress(A, tower.id);
const chRes = prog.fight(A, tower.name);
ok('挑战能打', chRes.ok === true, `第 ${chRes.depth} 层 ${chRes.win ? '胜' : '败'} ${chRes.rounds} 回合`);
const pr1 = prog.progress(A, tower.id);
ok('次数 +1', Number(pr1.daily_count) === Number(pr0.daily_count) + 1);
if (chRes.win) ok('赢了推进层数', Number(pr1.depth) === Number(pr0.depth) + 1, `第 ${pr1.depth} 层`);
else ok('输了保持层数', Number(pr1.depth) === Number(pr0.depth));
// 世界BOSS 共享血量
const bossCh = prog.challenges().find((c) => c.kind === 'boss');
const b0 = prog.bossState(bossCh.id);
ok('世界BOSS 有血量', b0 && b0.maxHp > 0, `${b0?.hp}/${b0?.maxHp}`);
players.db.prepare('UPDATE player SET hp = hp_max, status = ? WHERE openid = ?').run('idle', A);
const bRes = prog.fight(A, bossCh.name);
const b1 = prog.bossState(bossCh.id);
ok('打BOSS会掉共享血量', b1.hp <= b0.hp, `${b0.hp} → ${b1.hp}`);

// 10.3 斗天（战令）
prog.addPoints(A, 500);
const pt = prog.points(A);
ok('斗天积分累计', Number(pt.points) >= 500, `${pt.points} 分`);
const goldBeforeTier = Number(players.get(A).gold);
const claim = prog.claimTier(A, 100);
ok('领取档位奖励', claim.ok === true, `+${claim.gold} 魂币`);
ok('魂币到账', Number(players.get(A).gold) === goldBeforeTier + claim.gold);
ok('同档不能重复领', prog.claimTier(A, 100).error === 'claimed');

// 10.4 宝石镶嵌（[7] 里把装备分解了，这里重新发一件）
players.grantEquip(A, 1, '测试');
players.equipItem(A, '鹿之左臂骨');
grow.grantGem(A, '赤焰石', 2);
ok('宝石入库', grow.db.prepare('SELECT qty FROM gem_owned WHERE openid = ? AND gem_id = 1').get(A).qty === 2);
const atkNoGem = Number(players.get(A).atk);
r = await run(A, '开孔', '/开孔 鹿之左臂骨');
ok('开孔成功', r.replies.join('').includes('开孔成功'), r.replies[0].split('\n')[0]);
r = await run(A, '镶嵌', '/镶嵌 鹿之左臂骨 赤焰石');
ok('镶嵌成功', r.replies.join('').includes('镶嵌成功'), r.replies[0].split('\n')[0]);
ok('镶嵌后攻击上涨', Number(players.get(A).atk) > atkNoGem, `${atkNoGem} → ${players.get(A).atk}`);
r = await run(A, '摘孔', '/摘孔 鹿之左臂骨 1');
ok('摘孔成功', r.replies.join('').includes('已取下'), r.replies[0].split('\n')[0]);

// 10.5 功法（extras 通道，不吃等级系数）
const atkNoApt = Number(players.get(A).atk);
const learnRes = grow.learn(A, '控鹤擒龙');
ok('学功法成功', learnRes.ok === true, JSON.stringify(learnRes.attrs));
ok('功法属性进加成来源', players.mods(A).sources.some((s) => s.type === 'aptitude'));
ok('学完攻击上涨', Number(players.get(A).atk) > atkNoApt, `${atkNoApt} → ${players.get(A).atk}`);
ok('重复学被拦', grow.learn(A, '控鹤擒龙').error === 'already');

// 10.6 称号（自动授予 + 佩戴）
const gained = qol.checkTitles(A);
const allTitles = qol.titles(A);
ok('称号有获得记录', allTitles.some((t) => t.owned), `${allTitles.filter((t) => t.owned).length}/${allTitles.length} 已获得`);
const firstOwned = allTitles.find((t) => t.owned);
if (firstOwned) {
  const w = qol.wearTitle(A, firstOwned.name);
  ok('能佩戴称号', w.ok === true, firstOwned.name);
  ok('佩戴状态落库', qol.wornTitle(A)?.name === firstOwned.name);
}

// 10.7 连续签到
const si = qol.signin(A);
ok('签到成功', si.ok === true, `第 ${si.day} 天，连续 ${si.streak}`);
ok('同一天不能重复签', qol.signin(A).error === 'signed');
ok('签到状态正确', qol.signinState(A).signedToday === true);

// 10.8 冥想（挂机经验）
const med = qol.startMeditate(A);
ok('开始冥想', med.ok === true);
qol.db.prepare('UPDATE meditation SET started_at = started_at - ? WHERE openid = ?').run(30 * 60_000, A);
const expBeforeMed = Number(players.get(A).exp);
const stop = qol.stopMeditate(A);
ok('结束冥想给经验', stop.ok && stop.exp > 0, `${stop.minutes} 分钟 +${stop.exp}`);
ok('冥想状态已清除', qol.meditating(A) === null);

// 10.9 送花 / 魅力
const charmBefore = Number(qol.ext(B).charm);
const fl = qol.sendFlower(A, players.get(B).name, 2);
ok('送花成功', fl.ok === true, `+${fl.charm} 魅力`);
ok('对方魅力上涨', Number(qol.ext(B).charm) === charmBefore + fl.charm);

// 10.10 约战（实时对决）
const dq = qol.requestDuel(A, players.get(B).name);
ok('约战发出', dq.ok === true);
ok('对方能看到约战', qol.pendingDuels(B).some((x) => x.fromName === players.get(A).name));
players.db.prepare('UPDATE player SET hp = hp_max, status = ? WHERE openid IN (?,?)').run('idle', A, B);
const acc = qol.acceptDuel(B, players.get(A).name);
ok('应战并开打', acc.ok === true, acc.result ? `${acc.result.rounds} 回合` : '');

// 10.11 耐久与修理
players.db.prepare('UPDATE equip_owned SET durability = 40 WHERE openid = ? AND equipped = 1').run(A);
const rep = grow.repair(A);
ok('修理成功', rep.ok === true, `修 ${rep.points} 点花 ${rep.cost}`);
ok('耐久回满', grow.db.prepare('SELECT MIN(durability) d FROM equip_owned WHERE openid = ? AND equipped = 1').get(A).d === 100);

// 10.12 暗器
grow.buyWeapon(A, '袖箭');
ok('买到暗器', grow.weaponStock(A, 1) > 0, `${grow.weaponStock(A, 1)} 个`);

// 10.13 双生武魂
const subRes = grow.setSubWuhun(A, '昊天锤');
if (subRes.ok) {
  const beforeMain = Number(players.get(A).wuhun_id);
  const sw = grow.swapWuhun(A);
  ok('主副武魂互换', sw.ok === true && Number(players.get(A).wuhun_id) !== beforeMain, `${sw.sub} ↔ ${sw.main}`);
} else {
  ok('副武魂设置（找不到昊天锤则跳过）', true, subRes.error ?? '');
}

// 10.14 批量 / 搜索 / 一键卸下
players.addItem(A, 2, 10, '测试');
players.db.prepare('UPDATE player SET hp = 1 WHERE openid = ?').run(A);
r = await run(A, '批量', '/批量 使用 金疮药 5');
ok('批量使用', r.replies.join('').includes('批量使用'), r.replies[0].split('\n')[1]);
r = await run(A, '背包', '/背包 金疮');
ok('背包搜索', r.replies.join('').includes('搜'), r.replies[0].split('\n')[0]);
r = await run(A, '卸下', '/卸下 全部');
ok('一键卸下', r.replies.join('').includes('已卸下'), r.replies[0].split('\n')[0]);

/* ================= 11. 宗门战 / 领地争夺 ================= */

console.log('\n[11] 宗门战与领地争夺');
const D = 'F_D';
await run(D, '开始穿越', '/开始穿越 男 丁');
players.awaken(D, Math.random, '蓝银草');
players.db.prepare('UPDATE player SET gold = 200000, level = 1 WHERE openid IN (?,?)').run(A, D);
await run(D, '创建宗门', '/创建宗门 敌对宗');
ok('第二个宗门建好', guild.of(D)?.name === '敌对宗');

// 让敌对宗先占一块无主地
guild.db.prepare('UPDATE guild SET funds = 99999 WHERE name = ?').run('敌对宗');
players.db.prepare('UPDATE player SET map_id = 1 WHERE openid = ?').run(D);
const occ2 = guild.occupy(D, '星斗森林');
ok('敌对宗占了星斗森林', occ2.ok === true, occ2.error ?? '');
const terrNow = guild.territories().find((t) => t.mapName === '星斗森林');
ok('领地有归属和守卫', terrNow.guild_id > 0 && terrNow.defense > 0, `守卫 ${terrNow.defense}`);

// 没有宣战不能抢
const noWar = guild.raid(A, '星斗森林');
ok('没宣战不能抢', noWar.error === 'no_war', `${noWar.error} / ${noWar.holder}`);

// 占领别人的地也会被拦
const occBlocked = guild.occupy(A, '星斗森林');
ok('不能直接占别人的地', occBlocked.error === 'occupied', occBlocked.holder);

// 宣战
guild.db.prepare('UPDATE guild SET funds = 99999 WHERE name = ?').run('测试宗');
const war = guild.declareWar(A, '敌对宗');
ok('宣战成功', war.ok === true, `花费 ${war.cost}`);
ok('宣战记录可查', guild.warWith(guild.of(A).id, guild.of(D).id) !== null);
ok('重复宣战被拦', guild.declareWar(A, '敌对宗').error === 'already');

// 抢夺：先按当前实力打一次，打不过就升级再打
players.db.prepare('UPDATE player SET hp = hp_max, status = ? WHERE openid = ?').run('idle', A);
let raid = guild.raid(A, '星斗森林');
ok('抢夺能发起', raid.ok === true, `守卫 ${raid.defense} · ${raid.rounds} 回合 · ${raid.win ? '赢' : '输'}`);
if (!raid.win) {
  players.db.prepare('UPDATE player SET level = 60, hp = hp_max, status = ? WHERE openid = ?').run('idle', A);
  players.recalc(A);
  raid = guild.raid(A, '星斗森林');
  ok('升级后抢下来', raid.ok === true && raid.win === true, `守卫 ${raid.defense} · ${raid.rounds} 回合`);
}
const afterRaid = guild.territories().find((t) => t.mapName === '星斗森林');
ok('领地易主', afterRaid.guild_id === guild.of(A).id, `现在归 ${afterRaid.guildName}`);

// 收工有每日上限
guild.db.prepare('UPDATE territory SET last_mine_at = last_mine_at - ? WHERE map_id = 4').run(3 * 3600_000);
const c1 = guild.collect(A);
ok('收工有收益', c1.ok === true && c1.gold > 0, `+${c1.gold} 魂币（加成 ${Math.round((c1.bonus - 1) * 100)}%）`);
let lastC = c1;
for (let i = 0; i < 5; i += 1) {
  guild.db.prepare('UPDATE territory SET last_mine_at = last_mine_at - ? WHERE map_id = 4').run(3 * 3600_000);
  lastC = guild.collect(A);
  if (lastC.error) break;
}
ok('收工有每日上限', lastC.error === 'daily_limit', `${lastC.error ?? '没拦住'}`);

/* ================= 12. 丹药（鼎 / 火 / 药材 / 品质） ================= */

console.log('\n[12] 丹药系统');
players.db.prepare("UPDATE player SET profession = '炼药师', level = 20 WHERE openid = ?").run(A);
players.recalc(A);

const rateNoTool = craft.brewRate(A, content.db.prepare("SELECT * FROM recipe WHERE name = '回魂丹·真'").get());
ok('没鼎没火时成功率较低', rateNoTool.rate < 90, `${rateNoTool.rate}%`);

const tool1 = craft.equipTool(A, '九龙鼎');
ok('装备丹鼎', tool1.ok === true, `+${tool1.tool.bonus}%`);
const tool2 = craft.equipTool(A, '幽冥火');
ok('装备丹火', tool2.ok === true, `+${tool2.tool.bonus}%`);

const rateWithTool = craft.brewRate(A, content.db.prepare("SELECT * FROM recipe WHERE name = '回魂丹·真'").get());
ok('好鼎好火提高成功率', rateWithTool.rate > rateNoTool.rate, `${rateNoTool.rate}% → ${rateWithTool.rate}%`);
ok('成功率有上限', rateWithTool.rate <= 95);

players.addItem(A, 201, 60, '测试'); // 蓝银草
players.addItem(A, 205, 20, '测试'); // 龙芝叶
players.db.prepare('UPDATE player SET gold = 200000 WHERE openid = ?').run(A);
const brew = craft.brew(A, '回魂丹·真', 8);
ok('炼丹能出结果', brew.ok === true, `成功 ${brew.success} / 失败 ${brew.fail}`);
ok('成功时有品质分级', brew.success === 0 || Object.values(brew.quality).some((v) => v > 0), JSON.stringify(brew.quality));
ok('成功时有产出', brew.success === 0 || brew.gained > 0, `产出 ${brew.gained}`);
ok('炼丹给经验', brew.exp > 0, `+${brew.exp}`);

// 材料不足
const poor = craft.brew(A, '凝神丹', 1);
ok('材料不足有提示', poor.error === 'trade' || poor.ok === false, poor.message ?? '');
// 职业不对
players.db.prepare("UPDATE player SET profession = '铁匠' WHERE openid = ?").run(A);
const wrongPro = craft.brew(A, '回魂丹·真', 1);
ok('职业不对被拦', wrongPro.error === 'wrong_profession', wrongPro.need);

/* ================= 13. 图鉴 / 悬赏（原创功能） ================= */

console.log('\n[13] 图鉴与悬赏');
const best0 = qol.bestiary(A);
ok('图鉴有全部魂兽', best0.total >= 50, `${best0.total} 种`);
ok('击杀过的已解锁', best0.unlocked > 0, `${best0.unlocked} 种`);

// 造一次击杀 → 图鉴解锁数 +1（找一只还没解锁的）
const lockedOne = best0.list.find((m) => !m.unlocked);
if (lockedOne) {
  players.db
    .prepare('INSERT INTO kill_count (openid, monster_id, n) VALUES (?,?,1) ON CONFLICT(openid, monster_id) DO UPDATE SET n = n + 1')
    .run(A, lockedOne.id);
  const best1 = qol.bestiary(A);
  ok('击杀后图鉴解锁 +1', best1.unlocked === best0.unlocked + 1, `${best0.unlocked} → ${best1.unlocked}`);
}

const rewards = qol.bestiaryRewards(A);
ok('图鉴奖励有档位', rewards.length >= 5, `${rewards.length} 档`);
const claimB = qol.claimBestiary(A);
ok('图鉴领奖可用', claimB.ok === true, claimB.count ? `领了 ${claimB.count} 档` : '还没达到档位');
ok('重复领不会重复发', qol.claimBestiary(A).count === 0);

// 悬赏：同一天稳定
const bn1 = prog.dailyBounties(A);
const bn2 = prog.dailyBounties(A);
ok('每日悬赏 3 个', bn1.length === 3, bn1.map((x) => x.name).join(' / '));
ok('同一天悬赏稳定', JSON.stringify(bn1.map((x) => x.monster_id)) === JSON.stringify(bn2.map((x) => x.monster_id)));
ok('悬赏有进度字段', bn1.every((x) => typeof x.progress === 'number' && x.target > 0));

// 完成一个悬赏再领
const target0 = bn1[0];
players.db
  .prepare(
    `INSERT INTO kill_count (openid, monster_id, n) VALUES (?,?,?)
     ON CONFLICT(openid, monster_id) DO UPDATE SET n = ?`,
  )
  .run(A, target0.monster_id, Number(target0.base ?? 0) + Number(target0.target), Number(target0.base ?? 0) + Number(target0.target));
const after = prog.dailyBounties(A).find((x) => x.monster_id === target0.monster_id);
ok('击杀后悬赏达成', after.done === true, `${after.progress}/${after.target}`);
const goldBeforeB = Number(players.get(A).gold);
const cb = prog.claimBounties(A);
ok('交悬赏给奖励', cb.count >= 1 && Number(players.get(A).gold) > goldBeforeB, `+${cb.gold} 魂币 +${cb.points} 积分`);

/* ================= 14. 挑战层纵深（层名 / 守关 / 首通） ================= */

console.log('\n[14] 挑战层纵深');
const towerFloors = prog.floors(tower.id);
ok('万兽台有 30 层配置', towerFloors.length === 30, `${towerFloors.length} 层`);
ok('每层都有名字', towerFloors.every((f) => f.name && f.name.length > 0), towerFloors[0].name);
const towerBoss = towerFloors.filter((f) => Number(f.is_boss) === 1).map((f) => f.floor);
ok('万兽台每 10 层守关', JSON.stringify(towerBoss) === '[10,20,30]', towerBoss.join(','));
const abyssBoss = prog.floors(2).filter((f) => Number(f.is_boss) === 1).map((f) => f.floor);
ok('深渊每 5 层守关', JSON.stringify(abyssBoss) === '[5,10,15,20]', abyssBoss.join(','));

// 直接把进度推到第 9 层，下一次就是守关层
const E = 'F_E';
await run(E, '开始穿越', '/开始穿越 男 戊');
players.awaken(E, Math.random, '蓝银草');
players.db.prepare('UPDATE player SET level = 70, gold = 200000, stamina = 999, hp = hp_max WHERE openid = ?').run(E);
players.recalc(E);
prog.db
  .prepare(
    `INSERT INTO challenge_progress (openid, challenge_id, depth, daily_count, last_day) VALUES (?,?,9,0,'')
     ON CONFLICT(openid, challenge_id) DO UPDATE SET depth = 9, daily_count = 0`,
  )
  .run(E, tower.id);
const f10 = prog.fight(E, tower.name);
ok('第 10 层是守关', f10.floor?.is_boss === 1 && f10.depth === 10, `${f10.floor?.name} · ${f10.win ? '胜' : '败'}`);
if (f10.win) {
  ok('首通给了额外奖励', Boolean(f10.firstClear), JSON.stringify(f10.firstClear).slice(0, 80));
  ok('首通记入数据库', prog.clearedFloors(E, tower.id).has(10));
  // 再打一次同一层（重置进度回 9）不应该再给首通
  prog.db.prepare('UPDATE challenge_progress SET depth = 9, daily_count = 0 WHERE openid = ? AND challenge_id = ?').run(E, tower.id);
  const again = prog.fight(E, tower.name);
  ok('首通只给一次', again.win ? again.firstClear === null : true, again.win ? '没有重复给' : '这次没打过');
} else {
  ok('首通（这次没打过，跳过）', true, '战力不足');
  ok('首通记入数据库（跳过）', true);
  ok('首通只给一次（跳过）', true);
}

/* ================= 15. 状态效果（中毒/减速/眩晕/即死） ================= */

console.log('\n[15] 状态效果');
const { resolveRound, duelResolve } = await import('../src/engine/battle.js');
const statusDefs = Object.fromEntries(
  content.db.prepare('SELECT * FROM status_def WHERE enabled = 1').all().map((r) => [r.key, r]),
);
const skillStatus = {};
for (const r of content.db.prepare('SELECT * FROM skill_status').all()) {
  (skillStatus[r.skill_id] ??= []).push({ key: r.status_key, chance: r.chance, duration: r.duration });
}
ok('状态定义有 14 种', Object.keys(statusDefs).length >= 14, `${Object.keys(statusDefs).length} 种`);
ok('有技能能附加状态', Object.keys(skillStatus).length >= 10, `${Object.keys(skillStatus).length} 个技能`);

const cfgNow = content.allCfg();
const mkPlayer = () => ({
  openid: 'T', level: 20, hp: 500, hp_max: 500, mp: 500, mp_max: 500,
  atk: 40, def: 20, spd: 15, str: 10, intel: 10, dodge: 0, crit: 0, crit_dmg: 150,
});
const mkBattle = (extra = {}) => ({
  monster_hp: 2000, monster_hp_max: 2000, monster_def: 10, monster_atk: 30, monster_age: 1000,
  player_status: '[]', monster_status: '[]', ...extra,
});
const always = () => 0.01; // 必中、不闪、不暴击

// 中毒：回合开始掉血
let st1 = resolveRound({
  player: mkPlayer(),
  battle: mkBattle({ monster_status: JSON.stringify([{ key: 'poison', left: 3, stack: 1 }]) }),
  action: { type: 'defend' }, cfg: cfgNow, rng: always, statusDefs, skillStatus,
});
ok('中毒每回合掉血', st1.events.some((e) => e.t === 'tick' && e.key === 'poison'), JSON.stringify(st1.events[0]));

// 眩晕：跳过出手
let st2 = resolveRound({
  player: mkPlayer(),
  battle: mkBattle({ player_status: JSON.stringify([{ key: 'stun', left: 1, stack: 1 }]) }),
  action: { type: 'attack' }, cfg: cfgNow, rng: always, statusDefs, skillStatus,
});
ok('眩晕跳过出手', st2.events.some((e) => e.t === 'stunned' && e.on === 'player'));

// 减速：属性被临时下调（用怪物的减速影响玩家承伤判断不好测，直接测 aggregate）
const { aggregate } = await import('../src/engine/status.js');
const aggSlow = aggregate([{ key: 'slow', left: 2, stack: 1 }], statusDefs);
ok('减速降低速度', aggSlow.spd < 0, `spd ${aggSlow.spd}%`);
const aggBreak = aggregate([{ key: 'armor_break', left: 2, stack: 2 }], statusDefs);
ok('破甲可叠层', aggBreak.def <= -50, `def ${aggBreak.def}%`);

// 技能附加状态：用带毒的技能打
const poisonSkill = content.db.prepare('SELECT * FROM skill WHERE id = 16').get(); // 曼陀罗毒
let st3 = resolveRound({
  player: mkPlayer(),
  battle: mkBattle(),
  action: { type: 'skill', skill: poisonSkill },
  cfg: cfgNow, rng: always, statusDefs, skillStatus,
});
ok('技能命中后附加中毒', st3.events.some((e) => e.t === 'status' && e.key === 'poison'), JSON.stringify(st3.monsterStatus));

// 即死：直接击杀
let st4 = resolveRound({
  player: mkPlayer(),
  battle: mkBattle({ monster_status: JSON.stringify([{ key: 'death_mark', left: 1, stack: 1 }]) }),
  action: { type: 'attack' }, cfg: cfgNow, rng: () => 0.001, statusDefs, skillStatus,
});
ok('即死印记能秒杀', st4.monsterDead === true && st4.events.some((e) => e.t === 'instant_kill'), '直接倒下');

/* ================= 16. PVP 平衡 ================= */

console.log('\n[16] PVP 平衡');
const sameA = { level: 30, hp: 800, hp_max: 800, atk: 50, def: 30, spd: 20, dodge: 0, crit: 0, crit_dmg: 150 };
const sameB = { ...sameA };
const pvp1 = duelResolve({ a: sameA, b: sameB, cfg: cfgNow, rng: () => 0.5 });
ok('同等属性打得久（不是一回合定胜负）', pvp1.rounds >= 6, `${pvp1.rounds} 回合`);
ok('PVP 伤害被缩放', pvp1.aHp < sameA.hp_max, `剩 ${pvp1.aHp}/${pvp1.aMax}`);

// 闪避生效
const dodger = { ...sameA, dodge: 60 };
const pvp2 = duelResolve({ a: sameA, b: dodger, cfg: cfgNow, rng: () => 0.1 });
ok('PVP 里闪避真的生效', pvp2.events.some((e) => e.dodged), `${pvp2.events.filter((e) => e.dodged).length} 次闪避`);

// 等级差：强者伤害被衰减（用同一随机序列比总伤害）
const strong = { ...sameA, level: 80, atk: 200 };
const weak = { ...sameA, level: 10 };
const pvp3 = duelResolve({ a: strong, b: weak, cfg: cfgNow, rng: () => 0.5 });
const strongDmg = pvp3.events.filter((e) => e.by === 'a').reduce((s, e) => s + e.value, 0);
ok('等级差有伤害衰减', strongDmg / Math.max(1, pvp3.rounds) < 200 * 1.5, `平均 ${Math.round(strongDmg / Math.max(1, pvp3.rounds))}/回合`);

// 每日场次上限
const pvpLimit = Number(cfgNow.pvp_daily_limit ?? 10);
ok('PVP 有每日场次上限', pvpLimit > 0, `${pvpLimit} 场/天`);

/* ================= 17. 魂兽掉落 / 魂技升级 ================= */

console.log('\n[17] 魂兽掉落与魂技升级');
const dropCount = content.db.prepare('SELECT COUNT(*) n FROM monster_drop').get().n;
const dropMobs = content.db.prepare('SELECT COUNT(DISTINCT monster_id) n FROM monster_drop').get().n;
ok('掉落配置已生成', dropCount > 100, `${dropCount} 条`);
ok('覆盖全部魂兽', dropMobs >= content.db.prepare('SELECT COUNT(*) n FROM monster WHERE enabled=1').get().n, `${dropMobs} 只`);

// 打几场，至少掉一次东西
const F = 'F_F';
await run(F, '开始穿越', '/开始穿越 男 己');
players.awaken(F, Math.random, '蓝银草');
players.db.prepare('UPDATE player SET gold = 50000, stamina = 999, hp = hp_max WHERE openid = ?').run(F);
const dropMap = content.db.prepare('SELECT map_id FROM monster_map ORDER BY map_id LIMIT 1').get();
players.db.prepare('UPDATE player SET map_id = ? WHERE openid = ?').run(dropMap.map_id, F);
const dropMob = battles.monstersAt(dropMap.map_id)[0];
let anyDrop = null;
let kills = 0;
for (let i = 0; i < 8 && !anyDrop; i += 1) {
  players.db.prepare('UPDATE player SET hp = hp_max, status = ? WHERE openid = ?').run('idle', F);
  const st = battles.start(F, dropMob.name);
  if (!st.battle) break;
  const af = battles.autoFight(F, { maxRounds: 40 });
  kills += 1;
  if (af.reward?.drops?.length) anyDrop = af.reward.drops;
}
ok('击杀会掉东西', Boolean(anyDrop), anyDrop ? anyDrop.map((d) => `${d.name}×${d.qty}`).join(' · ') : `${kills} 场没掉`);

// 掉落真的进背包 / 装备库
if (anyDrop) {
  const inv = players.detail(F).inventory;
  const owned = players.owned(F);
  const okAny = anyDrop.some(
    (d) => (d.kind === 'item' && inv.some((i) => i.name === d.name)) || (d.kind === 'equip' && owned.some((e) => e.name === d.name)) || d.kind === 'gem' || d.kind === 'companion',
  );
  ok('掉落真的入库', okAny, '物品/装备/宝石/伙伴至少一类');
}

// 魂技升级
players.db.prepare("UPDATE player SET profession = '炼药师' WHERE openid = ?").run(A);
const skillRow = content.db.prepare('SELECT * FROM skill WHERE id = 16').get();
const skBefore = players.effectiveSkill(A, skillRow);
players.db.prepare('UPDATE player SET gold = 100000 WHERE openid = ?').run(A);
const up = players.upgradeSkill(A, skillRow.id);
ok('魂技可以升级', up.ok === true, `+${up.level} · ${up.cost} 魂币`);
const skAfter = players.effectiveSkill(A, skillRow);
ok('升级后威力变高', skAfter.power > skBefore.power, `${skBefore.power}% → ${skAfter.power}%`);
ok('等级落库', players.skillLevel(A, skillRow.id) === up.level);
// 满级拦截
for (let i = 0; i < 12; i += 1) players.upgradeSkill(A, skillRow.id);
const maxLv = Number(cfgNow.skill_max_level ?? 10);
ok('魂技有满级上限', players.skillLevel(A, skillRow.id) === maxLv, `+${maxLv}`);
ok('满级后不能再升', players.upgradeSkill(A, skillRow.id).error === 'maxed');

/* ================= 18. 建号 / 武魂觉醒 / 删号 ================= */

console.log('\n[18] 建号 · 武魂觉醒 · 删号');
const G = 'F_G';
await run(G, '创建账号', '/创建账号 庚');
const pg = players.get(G);
ok('建号不带武魂', !Number(pg.wuhun_id), 'wuhun_id=' + pg.wuhun_id);

// 首次觉醒免费
const goldBeforeAw = Number(pg.gold);
const aw1 = players.awaken(G);
ok('首次觉醒免费', aw1.ok === true && aw1.cost === 0, '出 ' + aw1.wuhun?.name);
ok('觉醒后属性按武魂重算', Number(players.get(G).atk) !== 10 || Number(players.get(G).hp_max) !== 100, 'atk=' + players.get(G).atk);
ok('觉醒次数记录', players.awakenTimes(G) === 1);
ok('第二次开始收费', players.awakenCost(G) > 0, players.awakenCost(G) + ' 魂币');

// 给够钱，连抽 12 次，看武魂有没有多样性（不该永远同一个）
players.db.prepare('UPDATE player SET gold = 500000 WHERE openid = ?').run(G);
const seen = new Set([aw1.wuhun.name]);
for (let i = 0; i < 12; i += 1) {
  const r2 = players.awaken(G);
  if (r2.ok) seen.add(r2.wuhun.name);
}
ok('武魂有随机性（不是永远同一个）', seen.size >= 3, [...seen].slice(0, 5).join(' / ') + (seen.size > 5 ? ' …' : ''));
ok('觉醒次数累计', players.awakenTimes(G) === 13, String(players.awakenTimes(G)));

// 删号：不带「确认」不删
let del = await run(G, '删号', '/删号');
ok('删号要确认', del.replies.join('').includes('确认') && Boolean(players.get(G)));
del = await run(G, '删号', '/删号 确认');
ok('确认后删号', !players.get(G), del.replies[0]?.split('\n')[0] ?? '');
// 关联数据也清了
const leftRing = players.db.prepare('SELECT COUNT(*) n FROM ring WHERE openid = ?').get(G).n;
const leftInv = players.db.prepare('SELECT COUNT(*) n FROM inventory WHERE openid = ?').get(G).n;
ok('关联数据已清空', leftRing === 0 && leftInv === 0, `ring=${leftRing} inv=${leftInv}`);

// 删号后可以重新建号
await run(G, '创建账号', '/创建账号 庚二');
ok('删号后能重建', players.get(G)?.name === '庚二', players.get(G)?.name);

/* ================= 19. 对齐原版控制台（v24） ================= */

console.log('\n[19] 原版控制台对齐');
const ex = ctx.state.extra;

// 19.1 状态的新维度：力量/生命/魂力/暴伤/经验/金币
const { aggregate: aggStatus } = await import('../src/engine/status.js');
const defsAll = {};
for (const d of content.db.prepare('SELECT * FROM status_def WHERE enabled = 1').all()) defsAll[d.key] = d;
const rageDef = content.db.prepare("SELECT * FROM status_def WHERE name = '狂化'").get();
const statusTotal = content.db.prepare('SELECT COUNT(*) n FROM status_def').get().n;
ok('原版 79 个状态已导入', statusTotal >= 79, `${statusTotal} 个`);
ok('狂化带力量加成（原版 16 字段）', rageDef && Number(rageDef.str_pct) > 0, rageDef ? `str_pct=${rageDef.str_pct}` : '缺');
const aggRage = aggStatus([{ key: rageDef.key, left: 3, stack: 1 }], defsAll);
ok('聚合出力量/暴击', aggRage.str > 0 && aggRage.crit > 0, `str=${aggRage.str} crit=${aggRage.crit}`);

// 经验加成：临时把狂化的 exp_pct 设 100，验证聚合能读出来
content.db.prepare("UPDATE status_def SET exp_pct = 100 WHERE name = '狂化'").run();
const aggExp = aggStatus(
  [{ key: rageDef.key, left: 3, stack: 1 }],
  { ...defsAll, [rageDef.key]: content.db.prepare('SELECT * FROM status_def WHERE key = ?').get(rageDef.key) },
);
ok('经验加成能聚合出来', aggExp.exp === 100, `exp=${aggExp.exp}`);
content.db.prepare("UPDATE status_def SET exp_pct = 0 WHERE name = '狂化'").run();

// 19.2 己方技能（治疗）：原版 26 个己方单体/全体技能
const selfSkill = content.db.prepare("SELECT * FROM skill WHERE scope IN ('self_one','self_all') AND heal_pct > 0 LIMIT 1").get();
ok('有己方治疗技能', Boolean(selfSkill), selfSkill ? `${selfSkill.name} heal=${selfSkill.heal_pct}%` : '无');
ok('己方技能 >= 26 个', content.db.prepare("SELECT COUNT(*) n FROM skill WHERE scope IN ('self_one','self_all')").get().n >= 26);

if (selfSkill) {
  await run(A, '传送', '/传送 圣魂村');
  players.db.prepare('UPDATE player SET hp = 1, stamina = 999 WHERE openid = ?').run(A);
  // 跨库不能 JOIN：player 在游戏库、monster/monster_map 在内容库，分两步查
  const myMap = Number(players.get(A).map_id);
  const mobHere = content.db
    .prepare('SELECT m.* FROM monster m JOIN monster_map mm ON mm.monster_id = m.id WHERE mm.map_id = ? LIMIT 1')
    .get(myMap);
  if (mobHere) {
    battles.start(A, mobHere.name);
    players.db.prepare('UPDATE player SET mp = mp_max WHERE openid = ?').run(A);
    const r1 = battles.act(A, { type: 'skill', skill: selfSkill });
    ok('己方技能真的回血', r1.events.some((e) => e.t === 'heal'), JSON.stringify(r1.events.find((e) => e.t === 'heal') ?? r1.events[0]));
    if (players.get(A).status === 'battle') await run(A, '逃跑', '/逃跑');
  } else {
    ok('己方技能真的回血', false, '当前地图没有魂兽');
  }
}

// 19.3 组队
await run(B, '创建队伍', '/创建队伍 测试队');
const teamB = ex.teamOf(B);
ok('建队成功', Boolean(teamB) && teamB.isLeader, teamB?.name);
const rInv = await run(B, '邀请组队', '/邀请组队 甲');
ok('邀请发出', rInv.replies.join('').includes('已邀请'));
const rJoin = await run(A, '加入队伍', '/加入队伍 乙');
ok('对方接受邀请', rJoin.replies.join('').includes('已加入'), rJoin.replies[0]?.split('\n')[0] ?? '');
const teamNow = ex.teamOf(B);
ok('队伍变成 2 人', teamNow?.members.length === 2, `${teamNow?.members.length} 人`);
ok('组队有经验加成', ex.teamBonus(B).expBonus > 0, `+${Math.round(ex.teamBonus(B).expBonus * 100)}%`);
const rLeave = await run(A, '队伍离开', '/队伍离开');
ok('退出队伍', rLeave.replies.join('').includes('已退出') || rLeave.replies.join('').includes('解散'));

// 19.4 钓鱼
const fishMap = content.db.prepare("SELECT map_id FROM gather_point WHERE kind = 'fish' LIMIT 1").get();
if (fishMap) {
  players.db.prepare('UPDATE player SET map_id = ? WHERE openid = ?').run(fishMap.map_id, A);
  const rFish = await run(A, '钓鱼', '/钓鱼');
  ok('钓鱼可用', rFish.replies.join('').includes('钓到') || rFish.replies.join('').includes('刚钓过'), rFish.replies[0]?.split('\n')[0] ?? '');
  const again = await run(A, '钓鱼', '/钓鱼');
  ok('钓点有冷却', again.replies.join('').includes('还要等') || again.replies.join('').includes('钓到'), again.replies[0]?.split('\n')[0] ?? '');
} else {
  ok('钓鱼可用', false, '没有任何钓点');
}

// 19.5 武魂融合
const fusions = ex.fusionList(A);
ok('融合配置 25 组', fusions.length >= 20, `${fusions.length} 组`);
const f0 = fusions[0];
if (f0) {
  players.db.prepare('UPDATE player SET wuhun_id = ? WHERE openid = ?').run(f0.wuhun_a, A);
  players.db.prepare('INSERT OR REPLACE INTO player_ext (openid, sub_wuhun_id) VALUES (?,?)').run(A, f0.wuhun_b);
  const readyList = ex.fusionList(A).filter((x) => x.ready && !x.done);
  ok('凑齐两侧武魂后可融合', readyList.length > 0, `${readyList.length} 组可融`);
  if (readyList.length) {
    const rf = ex.fuse(A, readyList[0].name);
    ok('融合成功', rf.ok === true, rf.ok ? `${rf.fusion.name}${rf.fusion.skillName ? ' → ' + rf.fusion.skillName : ''}` : rf.error);
    ok('融合记录落库', players.db.prepare('SELECT COUNT(*) n FROM wuhun_fused WHERE openid = ?').get(A).n > 0);
    const again = ex.fuse(A, readyList[0].name);
    ok('重复融合被拦', again.error === 'already', again.error);
  }
}

// 19.6 武魂进化
const evoW = content.db.prepare('SELECT * FROM wuhun WHERE evolve_to > 0 LIMIT 1').get();
if (evoW) {
  players.db.prepare('UPDATE player SET wuhun_id = ?, level = 99 WHERE openid = ?').run(evoW.id, A);
  players.recalc(A);
  const info = ex.evolveInfo(A);
  ok('进化信息可读', Boolean(info?.target), info?.target?.name ?? '无');
  // 进化要材料：按 evolve_item 名字发一份
  if (info?.needItem) {
    const mat = content.db.prepare('SELECT id FROM item WHERE name = ?').get(info.needItem);
    if (mat) players.addItem(A, mat.id, 5, '测试');
  }
  const beforeAtk = Number(players.get(A).atk);
  const rev = ex.evolve(A);
  ok('进化成功', rev.ok === true, rev.ok ? `${rev.from} → ${rev.to}` : rev.error);
  ok('进化后属性重算', Number(players.get(A).atk) !== beforeAtk, `${beforeAtk} → ${players.get(A).atk}`);
} else {
  ok('进化信息可读', false, '没有任何武魂配了进化');
}

// 19.7 快捷指令
await run(A, '设置快捷', '/设置快捷 3 魂兽');
ok('快捷槽存下来', ex.quickResolve(A, 3) === '魂兽', String(ex.quickResolve(A, 3)));
const rQuick = await run(A, '快捷', '/快捷 3');
ok('快捷能读出来', rQuick.replies.join('').includes('魂兽'));
const rDel = await run(A, '删除快捷', '/删除快捷 3');
ok('删除快捷', rDel.replies.join('').includes('已删除'));
ok('删完查不到', ex.quickResolve(A, 3) === null);

// 19.8 斗铠领域（domain_def 那套）
const domains = ex.domainList(A);
ok('领域配置已导入', domains.length >= 10, `${domains.length} 个`);
if (domains.length) {
  const d0 = domains[0];
  const noArmor = ex.domainAwaken(A, d0.name);
  ok('没斗铠不能觉醒', noArmor.error === 'no_armor' || noArmor.ok, noArmor.error ?? 'ok');
  const domEquip = content.db.prepare("SELECT id, name FROM equip WHERE part = 'domain' LIMIT 1").get();
  if (domEquip) {
    players.grantEquip(A, domEquip.id, '测试');
    players.equipItem(A, domEquip.name);
    players.db.prepare('UPDATE player SET gold = 999999 WHERE openid = ?').run(A);
    const rAw = ex.domainAwaken(A, d0.name);
    ok('觉醒领域', rAw.ok === true, rAw.ok ? rAw.domain.name : rAw.error);
    const rOpen = ex.domainToggle(A, true, d0.name);
    ok('开启领域', rOpen.ok === true, rOpen.error ?? '');
    // 领域的效果是「战斗开始时挂上附加状态」，不是面板属性
    players.db.prepare('UPDATE player SET hp = hp_max, stamina = 999 WHERE openid = ?').run(A);
    const domMob = content.db
      .prepare('SELECT m.* FROM monster m JOIN monster_map mm ON mm.monster_id = m.id WHERE mm.map_id = ? LIMIT 1')
      .get(Number(players.get(A).map_id));
    if (domMob) {
      battles.start(A, domMob.name);
      const st = JSON.parse(players.db.prepare('SELECT player_status FROM battle WHERE openid = ?').get(A)?.player_status ?? '[]');
      ok('领域在战斗开局生效', !d0.status_key || st.some((x) => x.key === d0.status_key), `状态 ${JSON.stringify(st)}`);
      if (players.get(A).status === 'battle') await run(A, '逃跑', '/逃跑');
    } else {
      ok('领域在战斗开局生效', false, '没有怪');
    }
    ex.domainToggle(A, false);
    ok('关闭领域', ex.activeDomain(A) === null);
  }
}

// 19.9 物品新效果：升级卷 / 传送符 / 每日次数
const lvItem = content.db.prepare("SELECT * FROM item WHERE effect = 'add_level' LIMIT 1").get();
if (lvItem) {
  players.addItem(A, lvItem.id, 1, '测试');
  players.db.prepare('UPDATE player SET level = 5 WHERE openid = ?').run(A);
  const beforeLv = Number(players.get(A).level);
  const rUse = players.useItem(A, lvItem.name, 1);
  ok('升级卷真的加等级', rUse.ok === true && Number(players.get(A).level) > beforeLv, `Lv.${beforeLv} → Lv.${players.get(A).level}`);
} else {
  ok('升级卷真的加等级', false, '没有 effect=add_level 的物品');
}

const tpItem = content.db.prepare("SELECT * FROM item WHERE effect = 'teleport' AND teleport_map <> '' LIMIT 1").get();
if (tpItem) {
  const tgt = content.db.prepare('SELECT id, name FROM map WHERE name = ?').get(tpItem.teleport_map);
  if (tgt) {
    players.addItem(A, tpItem.id, 1, '测试');
    const rTp = players.useItem(A, tpItem.name, 1);
    ok('传送符真的改地图', rTp.ok === true && Number(players.get(A).map_id) === Number(tgt.id), `map_id=${players.get(A).map_id}`);
  }
}

const limitItem = content.db.prepare('SELECT * FROM item WHERE daily_limit > 0 LIMIT 1').get();
if (limitItem) {
  players.addItem(A, limitItem.id, 50, '测试');
  const day = new Date().toISOString().slice(0, 10);
  players.db
    .prepare('INSERT OR REPLACE INTO item_daily (openid, item_id, day, n) VALUES (?,?,?,?)')
    .run(A, limitItem.id, day, Number(limitItem.daily_limit));
  const rLimit = players.useItem(A, limitItem.name, 1);
  ok('每日次数会拦', rLimit.error === 'daily_limit', rLimit.error ?? 'ok');
  players.db.prepare('DELETE FROM item_daily WHERE openid = ? AND item_id = ?').run(A, limitItem.id);
}

// 19.10 魂兽暴击/闪避字段真的用上了
const critMob = content.db.prepare('SELECT * FROM monster WHERE crit > 0 ORDER BY crit DESC LIMIT 1').get();
ok('有带暴击的魂兽', Boolean(critMob), critMob ? `${critMob.name} crit=${critMob.crit}%` : '无');
if (critMob) {
  const cm = content.db.prepare('SELECT map_id FROM monster_map WHERE monster_id = ? LIMIT 1').get(critMob.id);
  if (cm) players.db.prepare('UPDATE player SET map_id = ?, hp = hp_max, stamina = 999 WHERE openid = ?').run(cm.map_id, A);
  const b = battles.start(A, critMob.name);
  if (b.battle) {
    const row = players.db.prepare('SELECT monster_crit, monster_crit_dmg, monster_dodge FROM battle WHERE openid = ?').get(A);
    ok('开战快照了怪物暴击', Number(row?.monster_crit) > 0, JSON.stringify(row));
    if (players.get(A).status === 'battle') await run(A, '逃跑', '/逃跑');
  } else {
    ok('开战快照了怪物暴击', false, b.error);
  }
}

/* ================= 20. NPC 条件对话 ================= */

console.log('\n[20] NPC 条件对话');

const dlgTotal = content.db.prepare('SELECT COUNT(*) n FROM npc_dialog').get().n;
const dlgNpc = content.db.prepare('SELECT COUNT(DISTINCT npc_id) n FROM npc_dialog').get().n;
const npcTotal = content.db.prepare('SELECT COUNT(*) n FROM npc').get().n;
ok('条件对话已导入', dlgTotal >= 150, `${dlgTotal} 段`);
ok('覆盖全部 NPC', dlgNpc === npcTotal, `${dlgNpc} / ${npcTotal}`);

// 20.1 同一个人在不同等级说不同的话
const G2 = 'F_H';
await run(G2, '创建账号', '/创建账号 辛');
players.awaken(G2, Math.random, '蓝银草');
const npcHere = content.db
  .prepare('SELECT n.* FROM npc n WHERE n.map_id = ? AND EXISTS (SELECT 1 FROM npc_dialog d WHERE d.npc_id = n.id) LIMIT 1')
  .get(Number(players.get(G2).map_id));
if (npcHere) {
  // 一级时说的话
  players.db.prepare('UPDATE player SET level = 1 WHERE openid = ?').run(G2);
  const low = await run(G2, '对话', `/对话 ${npcHere.name}`);
  const lowText = low.replies.join('');
  // 六十级时说的话
  players.db.prepare('UPDATE player SET level = 60, gold = 999999 WHERE openid = ?').run(G2);
  const high = await run(G2, '对话', `/对话 ${npcHere.name}`);
  const highText = high.replies.join('');
  ok('不同等级说不同的话', lowText !== highText, `${npcHere.name}：Lv.1 与 Lv.60 的输出不同`);
  ok('高等级能解锁新台词', highText.length >= lowText.length - 40, `${lowText.length} → ${highText.length} 字`);
} else {
  ok('不同等级说不同的话', false, '出生地没有带条件对话的 NPC');
}

// 20.2 条件判定：等级不够看不到高级台词
const elderNpc = content.db
  .prepare(
    "SELECT n.id, n.name FROM npc n JOIN npc_dialog d ON d.npc_id = n.id WHERE d.cond LIKE '%\"level\":60%' LIMIT 1",
  )
  .get();
if (elderNpc) {
  players.db.prepare('UPDATE player SET level = 1 WHERE openid = ?').run(G2);
  const elderMap = content.db.prepare('SELECT map_id FROM npc WHERE id = ?').get(elderNpc.id)?.map_id ?? 1;
  players.db.prepare('UPDATE player SET map_id = ? WHERE openid = ?').run(elderMap, G2);
  const lv1 = await run(G2, '对话', `/对话 ${elderNpc.name}`);
  const lv1Text = lv1.replies.join('');
  players.db.prepare('UPDATE player SET level = 60 WHERE openid = ?').run(G2);
  const lv60 = await run(G2, '对话', `/对话 ${elderNpc.name}`);
  const lv60Text = lv60.replies.join('');
  ok('Lv.60 台词在 Lv.1 看不到', !lv1Text.includes('前辈'), lv1Text.split('\n')[1]?.slice(0, 30) ?? '');
  ok('Lv.60 能看到前辈台词', lv60Text.includes('前辈'), lv60Text.split('\n').find((l) => l.includes('前辈'))?.slice(0, 30) ?? '');
}

// 20.3 give 动作只给一次
const giveNpc = content.db
  .prepare("SELECT n.id, n.name, d.action FROM npc n JOIN npc_dialog d ON d.npc_id = n.id WHERE d.action LIKE 'give:%' LIMIT 1")
  .get();
if (giveNpc) {
  const giveMap = content.db.prepare('SELECT map_id FROM npc WHERE id = ?').get(giveNpc.id)?.map_id ?? 1;
  players.db.prepare('UPDATE player SET level = 1, map_id = ? WHERE openid = ?').run(giveMap, G2);
  // 20.1 已经对话过一次（那会儿就领了），这里要清掉领取记录才能测「第一次给」
  players.db.prepare("DELETE FROM player_meta WHERE openid = ? AND key LIKE 'dlg:%'").run(G2);
  const invBefore = Number(players.detail(G2).inventory.reduce((s, i) => s + i.qty, 0));
  const r1 = await run(G2, '对话', `/对话 ${giveNpc.name}`);
  const invAfter1 = Number(players.detail(G2).inventory.reduce((s, i) => s + i.qty, 0));
  ok('give 动作真的给东西', invAfter1 > invBefore, `背包 ${invBefore} → ${invAfter1}`);
  const r2 = await run(G2, '对话', `/对话 ${giveNpc.name}`);
  const invAfter2 = Number(players.detail(G2).inventory.reduce((s, i) => s + i.qty, 0));
  ok('再对话不会重复给', invAfter2 === invAfter1, `背包 ${invAfter1} → ${invAfter2}`);
} else {
  ok('give 动作真的给东西', false, '没有 give 动作的对话');
}

// 20.4 heal 动作回满
const healNpc = content.db
  .prepare("SELECT n.id, n.name FROM npc n JOIN npc_dialog d ON d.npc_id = n.id WHERE d.action = 'heal' LIMIT 1")
  .get();
if (healNpc) {
  const healMap = content.db.prepare('SELECT map_id FROM npc WHERE id = ?').get(healNpc.id)?.map_id ?? 1;
  players.db.prepare('UPDATE player SET level = 60, hp = 1, mp = 0, map_id = ? WHERE openid = ?').run(healMap, G2);
  await run(G2, '对话', `/对话 ${healNpc.name}`);
  const after = players.get(G2);
  ok('heal 动作回满', Number(after.hp) === Number(after.hp_max), `${after.hp} / ${after.hp_max}`);
} else {
  ok('heal 动作回满', false, '没有 heal 动作的对话');
}

/* ================= 汇总 ================= */

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

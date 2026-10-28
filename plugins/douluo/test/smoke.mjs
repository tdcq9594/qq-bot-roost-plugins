/**
 * 骨架自测
 * ========
 *
 *   node plugins/douluo/test/smoke.mjs
 *
 * 不连 QQ、不开面板：用 testkit 造假 ctx，把命令、战斗、公式、数据层各跑一遍。
 * 数据目录固定在系统临时目录，**每次跑之前清空**，保证结果可复现。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import plugin from '../index.js';
import { makeCtx, runCommand, runListeners, makeMsg } from '../../../src/plugin/testkit.js';
import { monsterHp, monsterDef, damageOnce, power, ringColor, monsterLevel } from '../src/engine/formula.js';
import { levelCap, applyExp } from '../src/engine/progress.js';
import { computeAttrs } from '../src/engine/stats.js';

const DATA_DIR = path.join(os.tmpdir(), 'douluo-smoke');
fs.rmSync(DATA_DIR, { recursive: true, force: true });

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

const ctx = makeCtx({ id: 'douluo', config: { seedOnEmpty: true, prefix: '/' }, dataDir: DATA_DIR, quiet: true });
await plugin.setup(ctx);
// runCommand 看到 __setup 就不会再跑一遍 setup（否则会把这里抓到的 repo 换成新的）
ctx.__setup = true;

const content = ctx.state.content;
const players = ctx.state.players;
const battles = ctx.state.battles;
const cfg = content.allCfg();
const OPENID = 'TEST_OPENID_001';
const run = (cmd, line) => runCommand(plugin, cmd, { ctx, content: line, userId: OPENID });

console.log('\n[1] 内容库');
ok('内容表已建', content.tables().length >= 12, content.tables().length + ' 张');
ok('武魂 >= 4 个（含内容包）', content.db.prepare('SELECT COUNT(*) n FROM wuhun').get().n >= 4, content.db.prepare('SELECT COUNT(*) n FROM wuhun').get().n + ' 个');
ok('魂兽 >= 4 只（含内容包）', content.db.prepare('SELECT COUNT(*) n FROM monster').get().n >= 4, content.db.prepare('SELECT COUNT(*) n FROM monster').get().n + ' 只');
ok('魂兽掉落技能已配', content.db.prepare('SELECT COUNT(*) n FROM monster_skill').get().n >= 5);
ok('系数已灌（含增量补丁）', Object.keys(cfg).length >= 20, Object.keys(cfg).length + ' 条');

console.log('\n[2] 内容 CRUD（面板会走这条链路）');
const ins = content.insert('item', { id: 900, name: '测试道具', kind: 'material', price: 1 });
ok('新增', ins.ok === true);
ok('读回', content.db.prepare('SELECT * FROM item WHERE id = 900').get()?.name === '测试道具');
content.update('item', { id: 900 }, { name: '测试道具改名', price: 2 });
ok('更新', content.db.prepare('SELECT name, price FROM item WHERE id = 900').get().name === '测试道具改名');
ok('搜索命中', content.list('item', { q: '测试道具' }).total === 1);
content.remove('item', { id: 900 });
ok('删除', content.db.prepare('SELECT * FROM item WHERE id = 900').get() === undefined);
let guard = false;
try { content.insert('player', { openid: 'x' }); } catch { guard = true; }
ok('跨库表名被拒', guard);
let roGuard = false;
try { content.insert('content_meta', { key: 'x', value: 'y' }); } catch { roGuard = true; }
ok('只读表被拒', roGuard);

console.log('\n[3] 数值与进度');
ok('战力单调', power({ atk: 100 }, cfg) > power({ atk: 90 }, cfg));
const fake = { atk: 100, str: 100, intel: 10, crit: 10, crit_dmg: 150, level: 10, hp_max: 1000, def: 50, spd: 20, dodge: 5 };
const m1 = content.db.prepare('SELECT * FROM monster WHERE id = 1').get();
// 怪物属性现在由内容生成（年龄/品阶），不再是「按玩家输出反推」
const bal = ctx.state.balance;
const st1 = bal.monsterStats(m1);
let left = st1.hp;
let rounds = 0;
const ref1 = bal.referencePlayer(st1.level);
while (left > 0 && rounds < 500) {
  left -= damageOnce({ p: ref1, target: { def: st1.def }, cfg, rng: () => 0.5 }).value;
  rounds += 1;
}
ok('标准玩家打标准等级怪 ≈ 目标回合', Math.abs(rounds - st1.expectedRounds) <= 2, `实测 ${rounds} / 目标 ${st1.expectedRounds}`);
ok('魂环颜色分级', ringColor(10, cfg) === '白' && ringColor(2000, cfg) === '紫' && ringColor(2e6, cfg) === '金');
ok('魂兽等级换算', monsterLevel(10) >= 1 && monsterLevel(10000) > monsterLevel(10));
ok('等级上限随魂环放开', levelCap(0, cfg) === 10 && levelCap(1, cfg) === 20 && levelCap(9, cfg) === 100);
const capped = applyExp({ level: 10, exp: 0 }, 999999, 0, cfg);
ok('卡墙：0 环最多 10 级', capped.level === 10 && capped.capped === true, `level=${capped.level}`);
const unlocked = applyExp({ level: 10, exp: 0 }, 999999, 1, cfg);
ok('1 环可突破 10 级', unlocked.level > 10, `level=${unlocked.level}`);
const w1 = content.db.prepare('SELECT * FROM wuhun WHERE id=1').get();
const attrs1 = computeAttrs({ wuhun: w1, level: 1, ringCount: 0, cfg });
const attrs99 = computeAttrs({ wuhun: w1, level: 99, ringCount: 9, cfg });
ok('属性随等级/魂环增长', attrs99.atk > attrs1.atk * 10, `Lv1 ${attrs1.atk} → Lv99·9环 ${attrs99.atk}`);

console.log('\n[4] 建号与面板');
let r = await run('斗罗菜单', '/斗罗菜单');
ok('空参数出菜单', r.replies.length > 0, r.replies[0].split('\n')[0]);
r = await run('属性', '/属性');
ok('没角色时给引导', r.replies.join('').includes('还没有角色'));
r = await run('开始穿越', '/开始穿越 男 唐三');
// 建号不再自带武魂，觉醒到蓝银草（等价旧行为，保证断言数值不变）
ctx.state.players.awaken(OPENID, Math.random, '蓝银草');
ok('建号成功', r.replies.join('').includes('账号已创建'));
const p0 = players.get(OPENID);
ok('角色落库', p0?.name === '唐三' && p0?.gender === '男', `Lv.${p0?.level} atk=${p0?.atk}`);
ok('新手礼包已发', players.detail(OPENID).inventory.length === 1);
r = await run('属性', '/属性');
ok('面板有战力与血条', r.replies.join('').includes('战力') && r.replies.join('').includes('▰'));
r = await run('签到', '/签到');
ok('签到成功（连续签到版）', r.replies.join('').includes('签到 · 第') && r.replies.join('').includes('连续'), r.replies[0].split('\n')[0]);
r = await run('签到', '/签到');
ok('重复签到被拦', r.replies.join('').includes('已经签到过'));
r = await run('帮助', '/帮助');
ok('帮助列出带前缀的指令', r.replies.join('').includes('/攻击'));

console.log('\n[5] 战斗闭环');
r = await run('魂兽', '/魂兽');
ok('列出附近魂兽', r.replies.join('').includes('十年白虎'));
r = await run('挑战魂兽', '/挑战魂兽 十年白虎');
ok('开战成功', r.replies.join('').includes('战斗开始'), r.replies[0].split('\n')[0]);
ok('战斗已落库', battles.current(OPENID) !== null);
r = await run('挑战魂兽', '/挑战魂兽 十年白虎');
ok('重复开战被拦', r.replies.join('').includes('还在战斗中'));

let guardCount = 0;
let killed = false;
let lastText = '';
while (guardCount < 60) {
  r = await run('攻击', '/攻击');
  lastText = r.replies.join('\n');
  guardCount += 1;
  if (lastText.includes('敌方生命归零') || lastText.includes('阵亡')) {
    killed = lastText.includes('敌方生命归零');
    break;
  }
}
ok('能打死怪', killed, `${guardCount} 次攻击`);
ok('击杀后有经验/魂币', /获得经验.*魂币/.test(lastText));
ok('首环必掉', battles.pendingRing(OPENID) !== null, `${battles.pendingRing(OPENID)?.years} 年`);
ok('战斗已清理', battles.current(OPENID) === null);

r = await run('附加魂环', '/附加魂环');
ok('附加魂环成功', r.replies.join('').includes('附加成功'));
ok('魂环落库', players.ringCount(OPENID) === 1);
ok('等级上限提到 20', levelCap(players.ringCount(OPENID), cfg) === 20);
r = await run('附加魂环', '/附加魂环');
ok('没待附加时有提示', r.replies.join('').includes('没有待附加'));
r = await run('魂环', '/魂环');
ok('魂环列表显示颜色', /白色|黄色|紫色/.test(r.replies.join('')));

console.log('\n[6] 防御与逃跑');
await run('挑战魂兽', '/挑战魂兽 十年白虎');
r = await run('防御', '/防御');
ok('防御有减伤提示', r.replies.join('').includes('防御姿态'));
r = await run('逃跑', '/逃跑');
ok('逃跑成功', r.replies.join('').includes('脱离'));
ok('逃跑后无战斗', battles.current(OPENID) === null);

console.log('\n[7] 任务');
r = await run('任务', '/任务');
ok('任务列表', r.replies.join('').includes('初入圣魂村'));
r = await run('接受任务', '/接受任务 初入圣魂村');
ok('接受成功', r.replies.join('').includes('接受任务'));
r = await run('完成任务', '/完成任务 初入圣魂村');
ok('未达成时拦住', r.replies.join('').includes('还没完成'));
players.db.prepare('UPDATE kill_count SET n = 99 WHERE openid = ?').run(OPENID);
r = await run('完成任务', '/完成任务 初入圣魂村');
ok('达成后可交', r.replies.join('').includes('完成任务'));

console.log('\n[8] 装备（魂骨 / 斗铠 / 魂导器 共用一个模型）');
ok('装备内容表已灌', content.db.prepare('SELECT COUNT(*) n FROM equip').get().n >= 7);
ok('套装表已灌', content.db.prepare('SELECT COUNT(*) n FROM equip_set').get().n >= 1);
const beforeAtk = players.get(OPENID).atk;
players.grantEquip(OPENID, 1, '自测发放'); // 鹿之左臂骨 arm_l
players.grantEquip(OPENID, 2, '自测发放'); // 鹿之右臂骨 arm_r
players.grantEquip(OPENID, 5, '自测发放'); // 玄冰斗铠 body
ok('发放装备落库', players.owned(OPENID).length === 3);
r = await run('魂骨', '/魂骨');
ok('魂骨列表只显示魂骨', r.replies.join('').includes('鹿之左臂骨') && !r.replies.join('').includes('玄冰斗铠'));
r = await run('装备', '/装备 鹿之左臂骨');
ok('装备成功', r.replies.join('').includes('装备 ·'));
ok('属性真的涨了', players.get(OPENID).atk > beforeAtk, `atk ${beforeAtk} → ${players.get(OPENID).atk}`);
r = await run('装备', '/装备 鹿之右臂骨');
ok('第二件也穿上', players.equipped(OPENID).length === 2);
const mods2 = players.mods(OPENID);
ok('套装 2 件触发', mods2.sources.some((s) => s.type === 'set' && s.need === 2), JSON.stringify(mods2.flat));
r = await run('装备', '/装备 玄冰斗铠');
ok('斗铠能穿', players.equipped(OPENID).length === 3);
r = await run('属性', '/属性');
ok('面板列出加成来源', r.replies.join('').includes('加成来源') && r.replies.join('').includes('套装'));
r = await run('装备', '/装备 鹿之左臂骨');
ok('重复穿被拦', r.replies.join('').includes('已经穿在身上'));
// 造一件同部位的第二件，验证「一个部位只能穿一件」
players.grantEquip(OPENID, 1, '自测发放');
r = await run('装备', '/装备 鹿之左臂骨');
ok('同部位被占用时提示', r.replies.join('').includes('已经穿了'), r.replies[0].split('\n')[0]);
const atkWorn = players.get(OPENID).atk;
r = await run('卸下', '/卸下 左臂');
ok('卸下成功', r.replies.join('').includes('卸下 ·'));
ok('卸下后属性回落', players.get(OPENID).atk < atkWorn, `atk ${atkWorn} → ${players.get(OPENID).atk}`);
r = await run('卸下', '/卸下 尾巴');
ok('卸错部位有提示', r.replies.join('').includes('身上没有'));

console.log('\n[9] 系统开关（领域/机甲/战舰/斗灵 复用装备模型）');
players.grantEquip(OPENID, 10, '自测发放'); // 领域
players.grantEquip(OPENID, 11, '自测发放'); // 机甲
players.grantEquip(OPENID, 13, '自测发放'); // 攻击斗灵
r = await run('领域', '/领域');
ok('领域列表', r.replies.join('').includes('杀戮之都领域'));
const atkNoDomain = players.get(OPENID).atk;
r = await run('领域', '/领域 开');
ok('领域开启', r.replies.join('').includes('已开启'));
ok('开启后攻击上升', players.get(OPENID).atk > atkNoDomain, `${atkNoDomain} → ${players.get(OPENID).atk}`);
r = await run('领域', '/领域 开');
ok('重复开启被拦', r.replies.join('').includes('已经开着'));
r = await run('领域', '/领域 关');
ok('领域关闭', r.replies.join('').includes('已关闭'));
ok('关闭后攻击回落', players.get(OPENID).atk === atkNoDomain);
r = await run('机甲', '/机甲 控制');
ok('机甲控制', r.replies.join('').includes('已开启'));
r = await run('机甲', '/机甲 退出');
ok('机甲退出', r.replies.join('').includes('已关闭'));
r = await run('斗灵', '/斗灵 安装');
ok('斗灵安装', r.replies.join('').includes('已开启'));
r = await run('斗灵', '/斗灵');
ok('斗灵列表显示已装备', r.replies.join('').includes('已装备'));
r = await run('战舰', '/战舰');
ok('没有战舰时给引导', r.replies.join('').includes('还没有战舰'));

console.log('\n[10] 前缀（默认 /，可自定义）');
ok('默认前缀是 /', ctx.config.prefix === '/');
ctx.config.prefix = '。';
const msg = makeMsg({ content: '。属性', userId: OPENID });
const handled = await runListeners(plugin, msg, ctx);
ok('自定义前缀能触发', handled === true, (msg.replies[0] ?? '').split('\n')[0]);
ctx.config.prefix = '/';
// 群里发裸词：真实场景是 @机器人 之后（mentioned=true），才会纠正
const bare = makeMsg({ content: '攻击', userId: OPENID, mentioned: true });
const taught = await runListeners(plugin, bare, ctx);
ok('漏前缀会被纠正', taught === true && bare.replies.join('').includes('/攻击'), bare.replies[0]);
// 群里没 @ 的闲聊不应该被纠正（避免噪音）
const chat = makeMsg({ content: '攻击', userId: OPENID });
const noisy = await runListeners(plugin, chat, ctx);
ok('群里没 @ 的闲聊不触发', noisy === false && chat.replies.length === 0);
r = await run('攻击', '/不存在的词');
ok('未知指令有回应', r.replies.length > 0, r.replies[0].split('\n')[0]);

console.log('\n[11] 发放与流水');
const g = players.give(OPENID, { kind: 'gold', qty: 500, reason: '自测发放' });
ok('发魂币', g.balance >= 500);
players.give(OPENID, { kind: 'item', id: 1, qty: 3, reason: '自测发放' });
const d = players.detail(OPENID);
ok('背包到账', d.inventory.some((i) => i.item_id === 1 && i.qty >= 3));
ok('流水有记录', d.tx.length >= 2, d.tx.length + ' 条');
ok('统计口径', players.stats().players === 1);

console.log('\n[12] 热重载不炸');
await plugin.setup(ctx);
ok('二次 setup 后数据还在', ctx.state.players.count() === 1);
ok('战斗仓库可用', typeof ctx.state.battles.current === 'function');

console.log('\n[13] 图片（图文同条）');
// 热重载之后 ctx.state 里是新 repo，这里必须重新取
const c2 = ctx.state.content;
const media = ctx.state.media;
ok('图片开关默认开', media.enabled() === true);
c2.db.prepare("UPDATE wuhun SET image = 'https://example.com/wuhun.png' WHERE id = 1").run();
c2.db.prepare("UPDATE map SET image = 'https://example.com/map.png' WHERE id = 1").run();
c2.db.prepare("UPDATE monster SET image = 'https://example.com/mob.png' WHERE id = 1").run();
ok('远程图能解析', media.resolve('https://example.com/wuhun.png')?.local === false);
ok('本地图不存在时解析失败', media.resolve('nope.png') === null);

let img = await run('武魂', '/武魂');
ok('武魂：一条消息（图文同条）', img.replies.length === 1 && img.replies[0].startsWith('[image]'), img.replies[0].slice(0, 46));
ok('武魂：图里带文字', img.replies[0].includes('【武魂】'));

img = await run('地图', '/地图');
ok('地图：一条消息（图文同条）', img.replies.length === 1 && img.replies[0].startsWith('[image]'), img.replies[0].slice(0, 46));
ok('地图：图里带地点名', img.replies[0].includes('【圣魂村】'));

ctx.state.players.db.prepare('UPDATE player SET stamina = 188, status = ? WHERE openid = ?').run('idle', OPENID);
ctx.state.players.db.prepare('DELETE FROM battle WHERE openid = ?').run(OPENID);
img = await run('挑战魂兽', '/挑战魂兽 十年白虎');
ok('开战：一条消息（图文同条）', img.replies.length === 1 && img.replies[0].startsWith('[image]'), img.replies[0].slice(0, 46));
ok('开战：图里带战斗信息', img.replies[0].includes('战斗开始'));
await run('逃跑', '/逃跑');

// 关掉开关 → 全部退回 markdown，且不再发图
ctx.config.images = false;
ok('开关关掉后 has() 为假', media.has('https://example.com/wuhun.png') === false);
img = await run('武魂', '/武魂');
ok('关掉后退回 markdown', img.replies.length === 1 && img.replies[0].startsWith('##'), img.replies[0].split('\n')[0]);
img = await run('地图', '/地图');
ok('地图也退回 markdown', img.replies[0].startsWith('##'));
ctx.config.images = true;

// 内容表里没图 → 不发图
c2.db.prepare("UPDATE wuhun SET image = '' WHERE id = 1").run();
img = await run('武魂', '/武魂');
ok('没填图时退回 markdown', img.replies[0].startsWith('##'));

console.log('\n[14] 伙伴（魂灵/战宠/战魂/集卡 共用一个模型）');
const p3 = ctx.state.players;
ok('伙伴内容表已灌', c2.db.prepare('SELECT COUNT(*) n FROM companion').get().n >= 10);
p3.grantCompanion(OPENID, 1, '自测发放'); // 十年魂灵 soul
p3.grantCompanion(OPENID, 2, '自测发放'); // 百年魂灵 soul
p3.grantCompanion(OPENID, 8, '自测发放'); // 集卡
ok('发放伙伴落库', p3.ownedCompanions(OPENID).length === 3);

const atkBeforeComp = p3.get(OPENID).atk;
const flatBefore = p3.mods(OPENID).flat.atk;
ok('集卡未出战也计入加成', flatBefore >= 5, `flat.atk=${flatBefore}`);

img = await run('魂灵', '/魂灵');
ok('魂灵列表只显示魂灵', img.replies.join('').includes('十年魂灵') && !img.replies.join('').includes('史莱克'));
img = await run('出战', '/出战 十年魂灵');
ok('出战成功', img.replies.join('').includes('出战 ·'));
ok('出战后攻击上升', p3.get(OPENID).atk > atkBeforeComp, `${atkBeforeComp} → ${p3.get(OPENID).atk}`);
img = await run('出战', '/出战 十年魂灵');
ok('重复出战被拦', img.replies.join('').includes('已经在出战'));
img = await run('出战', '/出战 百年魂灵');
ok('同类只能一个', img.replies.join('').includes('已经站着'), img.replies[0].split('\n')[0]);
img = await run('出战', '/出战 史莱克七怪·壹');
ok('集卡不用出战', img.replies.join('').includes('收集就生效'));
img = await run('收回', '/收回 十年魂灵');
ok('收回成功', img.replies.join('').includes('收回 ·'));
ok('收回后属性回落', p3.get(OPENID).atk === atkBeforeComp);
img = await run('出战', '/出战 百年魂灵');
ok('换一个出战', img.replies.join('').includes('出战 ·'));
img = await run('伙伴', '/伙伴');
ok('伙伴总览含图鉴', img.replies.join('').includes('图鉴') && img.replies.join('').includes('出战'));
img = await run('战宠', '/战宠');
ok('没有战宠时给引导', img.replies.join('').includes('还没有'));
img = await run('属性', '/属性');
ok('属性面板列出伙伴加成', img.replies.join('').includes('百年魂灵'));

console.log('\n[15] 经济（商城/银行/拍卖/抽奖/月卡/CDK）');
const eco = ctx.state.economy;
const OPENID2 = 'TEST_OPENID_002';
p3.db.prepare('UPDATE player SET gold = 10000, coupon = 1000 WHERE openid = ?').run(OPENID);
if (!p3.get(OPENID2)) p3.create({ openid: OPENID2, name: '小刚', gender: '男', wuhunId: 1 });
p3.db.prepare('UPDATE player SET gold = 1000 WHERE openid = ?').run(OPENID2);
ok('商城 7 个', eco.shops().length === 7);
ok('货架有货', eco.shopItems(1).length >= 2);

img = await run('商城', '/商城');
ok('商城列表', img.replies.join('').includes('杂货铺'));
img = await run('商城', '/商城 杂货铺');
ok('看货架', img.replies.join('').includes('金疮药'));

let goldBefore = p3.get(OPENID).gold;
img = await run('购买', '/购买 金疮药 2');
ok('购买成功', img.replies.join('').includes('购买成功'));
ok('扣了魂币', p3.get(OPENID).gold === goldBefore - 80, `${goldBefore} → ${p3.get(OPENID).gold}`);
ok('物品到账', p3.detail(OPENID).inventory.some((i) => i.name === '金疮药' && i.qty >= 2));
img = await run('购买', '/购买 不存在的东西');
ok('买不存在的东西有提示', img.replies.length > 0, img.replies[0].split('\n')[0]);

goldBefore = p3.get(OPENID).gold;
img = await run('出售', '/出售 金疮药 1');
ok('出售成功', img.replies.join('').includes('出售成功'));
ok('卖回有钱进', p3.get(OPENID).gold > goldBefore, `${goldBefore} → ${p3.get(OPENID).gold}`);

img = await run('存', '/存 1000');
ok('存款成功', img.replies.join('').includes('存款'));
ok('存款落库', eco.bank(OPENID).deposit === 1000);
img = await run('取', '/取 400');
ok('取款成功', eco.bank(OPENID).deposit === 600);
img = await run('贷', '/贷 200');
ok('贷款成功', eco.bank(OPENID).loan === 200);
img = await run('还', '/还 200');
ok('还款成功', eco.bank(OPENID).loan === 0);
img = await run('银行', '/银行');
ok('银行面板', img.replies.join('').includes('存款'));

// 拍卖：卖家挂单 → 买家竞拍
const invBefore = p3.detail(OPENID).inventory.find((i) => i.name === '金疮药')?.qty ?? 0;
const listRes = eco.auctionList(OPENID, { itemName: '金疮药', qty: 1, price: 100 });
ok('上架成功', listRes.ok === true, `#${listRes.id}`);
ok('上架后物品被扣', (p3.detail(OPENID).inventory.find((i) => i.name === '金疮药')?.qty ?? 0) === invBefore - 1);
img = await run('拍卖', '/拍卖');
ok('拍卖行能看到', img.replies.join('').includes('金疮药'));
const bid1 = eco.auctionBid(OPENID, listRes.id);
ok('不能拍自己的', bid1.error === 'own');
const sellerGoldBefore = p3.get(OPENID).gold;
const buyerGoldBefore = p3.get(OPENID2).gold;
const bid2 = eco.auctionBid(OPENID2, listRes.id);
ok('买家竞拍成功', bid2.ok === true, `手续费 ${bid2.fee}`);
ok('买家付钱', p3.get(OPENID2).gold === buyerGoldBefore - 100);
// 卖家收款走邮件（他可能不在场），要领取后才进钱包
const mailRepo = ctx.state.mail;
ok('卖家收到成交邮件', mailRepo.countUnclaimed(OPENID) >= 1, `${mailRepo.countUnclaimed(OPENID)} 封`);
ok('卖家钱包没被直接改', p3.get(OPENID).gold === sellerGoldBefore);
mailRepo.claimAll(OPENID);
ok('领取后卖家到账（扣 5%）', p3.get(OPENID).gold === sellerGoldBefore + 95, `${sellerGoldBefore} → ${p3.get(OPENID).gold}`);
ok('物品转给买家', p3.detail(OPENID2).inventory.some((i) => i.name === '金疮药'));

goldBefore = p3.get(OPENID).gold;
img = await run('抽奖', '/抽奖 1');
ok('抽奖成功', img.replies.join('').includes('抽奖 ×1'));
// 抽到的可能是「魂币 100」，净额会抵消，所以直接查流水里有没有 -100
const payRow = p3.db
  .prepare("SELECT * FROM tx_log WHERE openid = ? AND kind='gold' AND delta = -100 AND reason LIKE '抽奖%' ORDER BY id DESC")
  .get(OPENID);
ok('抽奖扣费有流水', Boolean(payRow), payRow ? `余额 ${payRow.balance}` : '没找到 -100 的流水');

img = await run('月卡', '/月卡 购买');
ok('月卡开通', img.replies.join('').includes('月卡已开通'));
img = await run('月卡', '/月卡 领取');
ok('月卡领取', img.replies.join('').includes('月卡领取'));
img = await run('月卡', '/月卡 领取');
ok('重复领取被拦', img.replies.join('').includes('今天已经领过'));

eco.createCdk('TEST-1', { gold: 500, items: [{ id: 2, qty: 2 }] });
goldBefore = p3.get(OPENID).gold;
img = await run('兑换', '/兑换 test-1');
ok('兑换成功（大小写不敏感）', img.replies.join('').includes('兑换成功'));
ok('CDK 奖励到账', p3.get(OPENID).gold === goldBefore + 500);
img = await run('兑换', '/兑换 TEST-1');
ok('CDK 不能重复用', img.replies.join('').includes('用完'));

console.log('\n[16] 社交与 PVP');
const soc = ctx.state.social;
const asA = (cmd, line) => runCommand(plugin, cmd, { ctx, content: line, userId: OPENID });
const asB = (cmd, line) => runCommand(plugin, cmd, { ctx, content: line, userId: OPENID2 });

img = await asA('求婚', '/求婚 小刚');
ok('求婚发出请求', img.replies.join('').includes('已发出请求'));
img = await asB('关系', '/关系');
ok('对方能看到待确认', img.replies.join('').includes('待你确认') && img.replies.join('').includes('唐三'));
img = await asB('答应', '/答应 唐三');
ok('答应后成立', img.replies.join('').includes('情侣成立'));
img = await asA('关系', '/关系');
ok('关系里出现情侣', img.replies.join('').includes('情侣') && img.replies.join('').includes('小刚'));
img = await asA('求婚', '/求婚 小刚');
ok('重复求婚被拦', img.replies.join('').includes('已经是'));
img = await asA('分手', '/分手 小刚');
ok('分手成功', img.replies.join('').includes('已解除'));

img = await asA('拜师', '/拜师 小刚');
ok('拜师请求', img.replies.join('').includes('已发出请求'));
await asB('答应', '/答应 唐三');
img = await asA('关系', '/关系');
ok('师徒关系成立（拜师的人看到「师父」）', img.replies.join('').includes('师父') && img.replies.join('').includes('小刚'), img.replies[0].replace(/\n/g, ' ').slice(0, 40));

img = await asA('喊话', '/喊话 收魂环碎片');
ok('喊话成功', img.replies.join('').includes('世界 ·'));
img = await asA('喊话', '/喊话 再来一条');
ok('喊话有冷却', img.replies.join('').includes('冷却'));

const scoreA = p3.get(OPENID).rank_score;
img = await asA('斗魂', '/斗魂 小刚');
ok('斗魂有结果', /胜利|败北/.test(img.replies.join('')), img.replies[0].split('\n')[0]);
ok('排位分有变化', p3.get(OPENID).rank_score !== scoreA, `${scoreA} → ${p3.get(OPENID).rank_score}`);
img = await asA('排位', '/排位');
ok('排位榜有名字', img.replies.join('').includes('唐三'));
img = await asA('附近', '/附近');
ok('附近列出玩家', img.replies.join('').includes('小刚'));

console.log('\n[17] 宗门与领地');
const gd = ctx.state.guild;
p3.db.prepare('UPDATE player SET gold = 5000 WHERE openid = ?').run(OPENID);
img = await asA('创建宗门', '/创建宗门 史莱克');
ok('创建宗门成功', img.replies.join('').includes('宗门创建成功'));
ok('宗门落库', gd.of(OPENID)?.name === '史莱克');
img = await asB('加入宗门', '/加入宗门 史莱克');
ok('他人加入成功', img.replies.join('').includes('已加入'));
ok('成员 2 人', gd.members(gd.of(OPENID).id).length === 2);
img = await asA('捐献', '/捐献 600');
ok('捐献成功', img.replies.join('').includes('捐献成功'));
img = await asA('领地', '/领地');
ok('领地列表', img.replies.join('').includes('星斗森林'));
img = await asA('占领', '/占领 星斗森林');
ok('占领成功', img.replies.join('').includes('占领成功'));
img = await asA('挖矿', '/挖矿');
ok('刚占完没产出', img.replies.join('').includes('还没到产出时间'));
// 把上次收取时间往前推 3 小时，模拟挂机
p3.db.prepare('UPDATE territory SET last_mine_at = last_mine_at - ? WHERE map_id = 4').run(3 * 3600_000);
const goldMine = p3.get(OPENID).gold;
img = await asA('挖矿', '/挖矿');
ok('挂机 3 小时有产出（收工）', img.replies.join('').includes('收工') && img.replies.join('').includes('魂币'), img.replies[0].split('\n')[1]);
ok('魂币真的到账', p3.get(OPENID).gold > goldMine);
img = await asB('占领', '/占领 星斗森林');
ok('非宗主不能占', img.replies.join('').includes('只有宗主'));

console.log('\n[18] 生活（职业 / 配方）');
const cr = ctx.state.craft;
img = await asA('转职', '/转职 炼药师');
ok('转职成功', img.replies.join('').includes('转职成功'));
ok('职业落库', p3.get(OPENID).profession === '炼药师');
img = await asA('配方', '/配方');
ok('配方列表', img.replies.join('').includes('回魂丹'));
p3.addItem(OPENID, 3, 20, '自测');
img = await asA('制作', '/制作 回魂丹 1');
ok('制作成功', img.replies.join('').includes('制作成功'), img.replies[0].split('\n')[1]);
img = await asA('制作', '/制作 玄冰斗铠 1');
ok('职业不对被拦', img.replies.join('').includes('要 **铁匠**'));
img = await asA('制作', '/制作 不存在的配方');
ok('没配方有提示', img.replies.join('').includes('没有'));
img = await asA('职业', '/职业');
ok('职业页列出能做的', img.replies.join('').includes('炼药师'));

console.log('\n[19] 数值体检（平衡锚点）');
const b2 = ctx.state.balance;
ok('标准武魂 = 武魂平均值', b2.refWuhun().atk > 0, JSON.stringify(b2.refWuhun()));
const mob1 = c2.db.prepare('SELECT * FROM monster WHERE id = 1').get();
const s1 = b2.monsterStats(mob1);
const s1again = b2.monsterStats(mob1);
ok('怪物属性可复现（不依赖玩家）', s1.hp === s1again.hp && s1.atk === s1again.atk);
ok('怪物属性带标准等级', s1.level >= 1 && s1.expectedRounds === Number(mob1.target_rounds), `Lv${s1.level} / ${s1.expectedRounds} 回合`);

const chk = b2.check({ samples: 80 });
ok('全部平衡规则通过', chk.ok === true, `${chk.passed} 通过 / ${chk.failed} 失败`);
for (const it of chk.items.filter((x) => !x.ok)) console.log(`     ✗ ${it.name} · ${it.rule} 期望 ${it.expect} 实际 ${it.actual}`);

const rep = b2.report({ levels: [1, 10, 20, 30, 50], samples: 40 });
ok('矩阵形状正确', rep.rows.length >= 4 && rep.rows[0].cells.length === 5, rep.rows.length + ' 只怪');
const boss = rep.rows.find((r) => r.tier === 'boss');
const lowCell = boss.cells.find((c) => c.level === 1);
const highCell = boss.cells.find((c) => c.level === 50);
ok('BOSS 低级打不过', lowCell.winRate < 40, `Lv1 胜率 ${lowCell.winRate}%`);
// 注意：低级的 avgRounds 没意义（那是"被打死用了几个回合"），只能比胜率和高级回合
ok(
  'BOSS 高级碾压',
  highCell.winRate === 100 && highCell.avgRounds <= boss.expectedRounds,
  `Lv50 ${highCell.avgRounds} 回合 / 标准 ${boss.expectedRounds} 回合`,
);

// 成长必须单调：同一只怪，等级越高回合越少
const curve = rep.rows[0].cells.map((c) => c.avgRounds);
ok('同一只怪等级越高越快', curve.every((v, i) => i === 0 || v <= curve[i - 1] + 0.5), curve.join(' → '));

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

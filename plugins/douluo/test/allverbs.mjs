/**
 * 全指令巡检
 * ==========
 *
 *   node plugins/douluo/test/allverbs.mjs
 *
 * 把 87 个动词挨个跑一遍（给上合理的参数），只查三件事：
 *   1. 有没有抛异常
 *   2. 有没有回空
 *   3. 有没有返回「失败/错误/undefined/NaN」
 *
 * 这不是功能测试（那是 smoke/features 的事），而是**巡检**：
 * 保证没有哪个指令是坏的、空的、或者会炸进程。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import plugin from '../index.js';
import { makeCtx, runCommand } from '../../../src/plugin/testkit.js';

const DATA_DIR = path.join(os.tmpdir(), 'douluo-allverbs');
fs.rmSync(DATA_DIR, { recursive: true, force: true });

const ctx = makeCtx({ id: 'douluo', config: { seedOnEmpty: true, prefix: '/' }, dataDir: DATA_DIR, quiet: true });
await plugin.setup(ctx);
ctx.__setup = true;

const content = ctx.state.content;
const players = ctx.state.players;
const OPENID = 'ALL_001';
const OPENID2 = 'ALL_002';

/** 每个动词的「合理参数」——按真实玩家会怎么打来给 */
const ARGS = {
  开始穿越: '男 巡检者',
  使用: '金疮药 1',
  挑战魂兽: '十年白虎',
  魂技: '1',
  魂技升级: '',
  更换魂环: '1',
  创建队伍: '',
  我的队伍: '',
  邀请组队: '旁观者',
  加入队伍: '',
  队伍离开: '',
  踢出队员: '旁观者',
  钓鱼: '',
  采集: '',
  融合列表: '',
  武魂融合: '',
  武魂进化: '',
  快捷: '',
  设置快捷: '1 魂兽',
  删除快捷: '1',
  清空快捷: '',
  领域列表: '',
  觉醒领域: '冰皇域',
  开启领域: '',
  关闭领域: '',
  职业等级: '',
  充能: '',
  聚能: '',
  封印: '鹿之左臂骨',
  解封: '鹿之左臂骨',
  掉落: '',
  自动: '1',
  邮件: '',
  领取: '全部',
  分解: '鹿之左臂骨',
  对话: '圣魂长老',
  图鉴: '',
  悬赏: '',
  丹鼎: '九龙鼎',
  丹火: '幽冥火',
  炼丹: '回魂丹·真 1',
  宣战: '敌对宗',
  抢夺: '星斗森林',
  收工: '',
  领奖: '',
  应战: '巡检者',
  送花: '旁观者',
  升卡: '百年魂灵',
  物品: '金疮药',
  设置魂技: '1 白虎之爪',
  附加魂环: '',
  移动: '北',
  传送: '圣魂村',
  接受任务: '初入圣魂村',
  完成任务: '初入圣魂村',
  装备: '鹿之左臂骨',
  卸下: '左臂',
  出战: '十年魂灵',
  收回: '十年魂灵',
  领域: '开',
  机甲: '控制',
  战舰: '激活',
  斗灵: '安装',
  商城: '杂货铺',
  购买: '金疮药 1',
  出售: '金疮药 1',
  存: '100',
  取: '50',
  贷: '100',
  还: '100',
  上架: '金疮药 1 100',
  竞拍: '1',
  下架: '1',
  抽奖: '1',
  月卡: '购买',
  兑换: 'NO-SUCH-CODE',
  求婚: '旁观者',
  答应: '巡检者',
  分手: '旁观者',
  拜师: '旁观者',
  出师: '旁观者',
  加好友: '旁观者',
  喊话: '巡检一下',
  斗魂: '旁观者',
  创建宗门: '巡检宗',
  加入宗门: '巡检宗',
  捐献: '100',
  占领: '星斗森林',
  转职: '炼药师',
  配方: '炼丹',
  制作: '回魂丹 1',
  帮助: '攻击',
  斗罗: '属性',
  dl: '属性',
};

const allVerbs = Object.keys(ctx.state.verbs).sort();
console.log(`巡检 ${allVerbs.length} 个动词\n`);

// 先建两个号，社交/对战类才有对象
await runCommand(plugin, '开始穿越', { ctx, content: '/开始穿越 男 巡检者', userId: OPENID });
await runCommand(plugin, '开始穿越', { ctx, content: '/开始穿越 女 旁观者', userId: OPENID2 });
players.db.prepare('UPDATE player SET gold = 50000, coupon = 5000, stamina = 999 WHERE openid IN (?,?)').run(OPENID, OPENID2);
// 给点家底，让装备/伙伴/经济类指令有东西可操作
for (const e of [1, 5, 6, 10, 11, 12, 13]) players.grantEquip(OPENID, e, '巡检');
for (const c of [1, 2, 4, 8]) players.grantCompanion(OPENID, c, '巡检');
players.addItem(OPENID, 2, 20, '巡检');
players.addItem(OPENID, 3, 30, '巡检');

const BAD = /失败|错误|undefined|NaN|\[object|throw|Error:/;
const problems = [];
let okCount = 0;

for (const verb of allVerbs) {
  const arg = ARGS[verb] ?? '';
  const line = `/${verb}${arg ? ' ' + arg : ''}`;
  let out;
  try {
    out = await runCommand(plugin, verb, { ctx, content: line, userId: OPENID });
  } catch (e) {
    problems.push({ verb, kind: '抛异常', detail: e.message });
    continue;
  }
  const text = (out?.replies ?? []).join('\n');
  if (!text.trim()) {
    problems.push({ verb, kind: '回空', detail: line });
    continue;
  }
  const m = text.match(BAD);
  if (m) {
    // 有些是正常的业务提示（比如「兑换码不存在」不算问题）
    // 战斗类结果（抢夺失败/被击倒）是正常业务输出，不是错误
    const benign = /不存在|没有|不够|不能|已经|还没|没有在战斗|冷却|只能|需要|失败 ·|阵亡|败北/.test(text);
    if (!benign) {
      problems.push({ verb, kind: `可疑输出「${m[0]}」`, detail: text.split('\n')[0].slice(0, 80) });
      continue;
    }
  }
  okCount += 1;
}

/* ---------------- 报告 ---------------- */

console.log(`正常 ${okCount} / ${allVerbs.length}\n`);
if (!problems.length) {
  console.log('没有发现问题。');
} else {
  console.log(`发现 ${problems.length} 个问题：`);
  for (const p of problems) console.log(`  ✗ ${p.verb.padEnd(10)} ${p.kind} — ${p.detail}`);
}

/* ---------------- 顺带统计内容覆盖 ---------------- */

const cnt = (t) => content.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE enabled = 1`).get().n;
console.log('\n=== 内容覆盖 ===');
for (const t of ['wuhun', 'map', 'monster', 'npc', 'item', 'quest', 'skill', 'title', 'equip', 'companion', 'profession', 'recipe', 'shop']) {
  console.log(`  ${t.padEnd(12)} ${cnt(t)}`);
}

const orphanMaps = content.db
  .prepare(
    `SELECT m.name FROM map m
      WHERE m.enabled = 1 AND m.north IS NULL AND m.south IS NULL AND m.west IS NULL AND m.east IS NULL`,
  )
  .all();
console.log(`\n孤立地图（四个方向都没连）: ${orphanMaps.length}`);
if (orphanMaps.length) console.log('  ' + orphanMaps.map((m) => m.name).join(' / '));

const noMob = content.db
  .prepare('SELECT m.name FROM map m WHERE m.enabled = 1 AND NOT EXISTS (SELECT 1 FROM monster_map mm WHERE mm.map_id = m.id)')
  .all();
console.log(`没有魂兽的地图: ${noMob.length}${noMob.length ? '（' + noMob.slice(0, 8).map((m) => m.name).join(' / ') + '）' : ''}`);

process.exit(problems.length === 0 ? 0 : 1);

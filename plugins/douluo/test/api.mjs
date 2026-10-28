/**
 * 面板接口自测（不起 HTTP，直接跑分发逻辑）
 * =========================================
 *
 *   node plugins/douluo/test/api.mjs
 *
 * 走的是和真实请求完全一样的链路：
 *   RouteRegistry.add → match → runRoute → 插件的处理函数
 * 只是省掉了 socket，所以能在任何环境跑。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import plugin from '../index.js';
import { makeCtx } from '../../../src/plugin/testkit.js';
import { RouteRegistry, runRoute } from '../../../src/plugin/routes.js';

const DATA_DIR = path.join(os.tmpdir(), 'douluo-api');
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

const ctx = makeCtx({ id: 'douluo', config: { seedOnEmpty: true }, dataDir: DATA_DIR, quiet: true });

// 用真的 RouteRegistry 接管 ctx.registerRoute
const reg = new RouteRegistry();
ctx.registerRoute = (method, pattern, handler) => reg.add('douluo', method, pattern, handler);
ctx.__setup = true;
await plugin.setup(ctx);

const content = ctx.state.content;
const players = ctx.state.players;

async function call(method, p, { query = {}, body = null } = {}) {
  const hit = reg.match('douluo', method, p);
  if (!hit) return { code: 0, data: { error: 'route not found' } };
  return runRoute(hit, { query, body, method });
}

console.log('\n[1] 路由注册');
ok('注册了 13 条以上', reg.size >= 13, reg.size + ' 条');
ok('未知路径返回 null', reg.match('douluo', 'GET', '/nope') === null);
ok('方法不匹配返回 null', reg.match('douluo', 'PUT', '/stats') === null);

console.log('\n[2] 概览');
let r = await call('GET', '/stats');
ok('/stats 200', r.code === 200);
ok('带回表清单', Array.isArray(r.data.tables) && r.data.tables.length >= 11, r.data.contentTables + ' 张');
ok('带回数据目录', typeof r.data.dataDir === 'string');

console.log('\n[3] 内容表读写');
r = await call('GET', '/content/wuhun', { query: { size: '2' } });
ok('列表 200', r.code === 200 && r.data.rows.length === 2, `total=${r.data.total}`);
ok('带回列定义（前端据此生成表单）', r.data.columns.some((c) => c.name === 'name'));

r = await call('POST', '/content/item', { body: { row: { id: 910, name: '接口测试道具', kind: 'material', price: 5 } } });
ok('新增 200', r.code === 200 && r.data.ok);

r = await call('PATCH', '/content/item', { body: { pk: { id: 910 }, row: { name: '改名了' } } });
ok('修改 200', r.code === 200 && r.data.changes === 1);
ok('修改已落库', content.db.prepare('SELECT name FROM item WHERE id=910').get().name === '改名了');

r = await call('DELETE', '/content/item', { body: { pk: { id: 910 } } });
ok('删除 200', r.code === 200 && r.data.changes === 1);

r = await call('GET', '/content/nosuchtable');
ok('不存在的表 → 400', r.code === 400, r.data.error);
r = await call('POST', '/content/content_meta', { body: { row: { key: 'a', value: 'b' } } });
ok('只读表 → 400', r.code === 400, r.data.error);
r = await call('POST', '/content/item', { body: { row: {} } });
ok('空字段 → 400', r.code === 400);

console.log('\n[4] 数值系数');
r = await call('GET', '/cfg');
ok('系数列表', r.code === 200 && r.data.rows.length >= 10);
r = await call('PATCH', '/cfg', { body: { key: 'crit_base_mult', value: '1.6' } });
ok('改系数 200', r.code === 200 && r.data.ok);
ok('系数生效（不是缓存）', content.allCfg().crit_base_mult === 1.6);
r = await call('PATCH', '/cfg', { body: { key: 'no_such_key', value: '1' } });
ok('不存在的系数 → 404', r.code === 404);
await call('PATCH', '/cfg', { body: { key: 'crit_base_mult', value: '1.5' } });

console.log('\n[5] 玩家');
r = await call('GET', '/players');
ok('空列表 200', r.code === 200 && r.data.total === 0);

r = await call('POST', '/players/nobody/give', { body: { kind: 'gold', qty: 100 } });
ok('给不存在的人发钱 → 400', r.code === 400, r.data.error);

const OPENID = 'API_TEST_OPENID';
players.create({ openid: OPENID, name: '接口小明', gender: '女', wuhunId: 2 });
r = await call('GET', '/players');
ok('列表能查到', r.data.total === 1 && r.data.rows[0].power > 0, 'power=' + r.data.rows[0].power);

r = await call('GET', `/players/${OPENID}`);
ok('详情 200', r.code === 200 && r.data.player.name === '接口小明');
ok('详情带背包/魂环/流水', Array.isArray(r.data.inventory) && Array.isArray(r.data.rings) && Array.isArray(r.data.tx));

r = await call('POST', `/players/${OPENID}/give`, { body: { kind: 'gold', qty: 250, reason: '测试' } });
ok('发魂币 200', r.code === 200 && r.data.balance === 250);
r = await call('POST', `/players/${OPENID}/give`, { body: { kind: 'item', id: 1, qty: 2, reason: '测试' } });
ok('发物品 200', r.code === 200 && r.data.balance === 2);
r = await call('POST', `/players/${OPENID}/give`, { body: { kind: 'gold', qty: 0 } });
ok('数量 0 → 400', r.code === 400, r.data.error);
r = await call('POST', `/players/${OPENID}/give`, { body: { kind: 'vip', qty: 1 } });
ok('未知类型 → 400', r.code === 400);

r = await call('GET', '/tx', { query: { limit: '10' } });
ok('流水有记录', r.code === 200 && r.data.rows.length === 2, r.data.rows.length + ' 条');
ok('流水按时间倒序', r.data.rows[0].at >= r.data.rows[1].at);

r = await call('GET', '/options');
ok('下拉选项齐', ['wuhun', 'item', 'monster', 'map', 'title', 'skill', 'equip'].every((k) => Array.isArray(r.data[k])));
ok('装备选项有内容', r.data.equip.length >= 7, r.data.equip.length + ' 件');

console.log('\n[5.5] 发装备');
r = await call('POST', `/players/${OPENID}/give`, { body: { kind: 'equip', id: 1, qty: 1, reason: '面板发装备' } });
ok('发装备 200', r.code === 200 && r.data.ok, 'instance=' + r.data.balance);
r = await call('GET', `/players/${OPENID}`);
ok('详情里能看到装备', r.data.equipment.owned.length === 1 && r.data.equipment.owned[0].name === '鹿之左臂骨');
ok('未装备时 sources 为空', r.data.equipment.sources.length === 0);
players.equipItem(OPENID, '鹿之左臂骨');
r = await call('GET', `/players/${OPENID}`);
ok('穿上后 sources 有记录', r.data.equipment.sources.length === 1, JSON.stringify(r.data.equipment.flat));
r = await call('POST', `/players/${OPENID}/give`, { body: { kind: 'equip', id: 9999, qty: 1 } });
ok('不存在的装备 → 400', r.code === 400, r.data.error);

console.log('\n[5.6] 发伙伴');
r = await call('GET', '/options');
ok('伙伴选项有内容', Array.isArray(r.data.companion) && r.data.companion.length >= 10, (r.data.companion || []).length + ' 个');
r = await call('POST', `/players/${OPENID}/give`, { body: { kind: 'companion', id: 1, qty: 1, reason: '面板发伙伴' } });
ok('发伙伴 200', r.code === 200 && r.data.ok);
r = await call('GET', `/players/${OPENID}`);
ok('详情里有伙伴', r.data.companions.owned.length === 1 && r.data.companions.owned[0].name === '十年魂灵');
players.setCompanionActive(OPENID, '十年魂灵', true);
r = await call('GET', `/players/${OPENID}`);
ok('出战后进入 active', r.data.companions.active.length === 1);
ok('伙伴也进加成来源', r.data.equipment.sources.some((s) => s.type === 'companion'));
r = await call('POST', `/players/${OPENID}/give`, { body: { kind: 'companion', id: 9999, qty: 1 } });
ok('不存在的伙伴 → 400', r.code === 400);

r = await call('DELETE', `/players/${OPENID}`);
ok('删角色 200', r.code === 200 && r.data.ok);
ok('删干净了', players.get(OPENID) === null);

console.log('\n[6] 异常不炸进程');
const bad = reg.match('douluo', 'GET', '/players/:openid');
const out = await runRoute(bad, { params: { openid: 'x' }, query: {}, body: null, method: 'GET' });
ok('查不到玩家 → 404（不是抛错）', out.code === 404);

console.log('\n[7] 设置（面板改前缀）');
r = await call('GET', '/settings');
ok('读到当前前缀', r.code === 200 && typeof r.data.prefix === 'string', r.data.prefix);
ok('带回指令清单', Array.isArray(r.data.verbs) && r.data.verbs.includes('攻击'), (r.data.verbs || []).length + ' 个');
r = await call('PATCH', '/settings', { body: { prefix: '。' } });
ok('改前缀 200', r.code === 200 && r.data.config.prefix === '。');
ok('配置真的变了', ctx.config.prefix === '。');
r = await call('PATCH', '/settings', { body: { prefix: '' } });
ok('空前缀 → 400', r.code === 400);
r = await call('PATCH', '/settings', { body: { prefix: 'a b' } });
ok('带空格 → 400', r.code === 400);
r = await call('PATCH', '/settings', { body: { prefix: '/' } });
ok('改回 /', r.code === 200 && ctx.config.prefix === '/');
r = await call('GET', '/settings');
ok('带回图片开关与图目录', r.data.images === true && typeof r.data.imagesDir === 'string', r.data.imagesDir);
r = await call('PATCH', '/settings', { body: { images: false } });
ok('关掉图片', r.code === 200 && r.data.config.images === false);
r = await call('PATCH', '/settings', { body: { images: true } });
ok('打开图片', r.code === 200 && r.data.config.images === true);
r = await call('PATCH', '/settings', { body: {} });
ok('没给字段 → 400', r.code === 400);

console.log('\n[8] 经济');
r = await call('GET', '/economy');
ok('经济概览 200', r.code === 200 && typeof r.data.gold === 'number');
ok('带回 7 个商城', Array.isArray(r.data.shops) && r.data.shops.length === 7);
ok('带回奖池数量', typeof r.data.prizeCount === 'number' && r.data.prizeCount >= 5, r.data.prizeCount + ' 个奖');

r = await call('POST', '/cdk', { body: { code: 'PANEL-1', rewards: { gold: 888 }, maxUses: 2 } });
ok('生成 CDK 200', r.code === 200 && r.data.code === 'PANEL-1');
r = await call('POST', '/cdk', { body: { code: 'PANEL-1', rewards: { gold: 1 } } });
ok('重复码 → 400', r.code === 400);
r = await call('POST', '/cdk', { body: { code: '不合法 码', rewards: {} } });
ok('非法字符 → 400', r.code === 400);
r = await call('POST', '/cdk', { body: { code: 'PANEL-2', rewards: '{bad json' } });
ok('坏 JSON → 400', r.code === 400);
r = await call('GET', '/cdk');
ok('CDK 列表含新码', r.code === 200 && r.data.rows.some((x) => x.code === 'PANEL-1'));

console.log('\n[9] 数值体检');
r = await call('GET', '/balance', { query: { levels: '1,20,50', samples: '20' } });
ok('矩阵 200', r.code === 200 && r.data.rows.length >= 4, r.data.rows?.length + ' 只怪');
ok('列数跟着 levels 走', r.data.rows[0].cells.length === 3);
ok('带回标准武魂', typeof r.data.refWuhun?.atk === 'number', JSON.stringify(r.data.refWuhun));
r = await call('GET', '/balance/check', { query: { samples: '20' } });
ok('判定 200', r.code === 200 && typeof r.data.ok === 'boolean', `${r.data.passed} 通过 / ${r.data.failed} 失败`);
ok('平衡规则全部通过', r.data.ok === true);

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

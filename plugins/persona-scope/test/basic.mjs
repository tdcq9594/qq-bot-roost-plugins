// persona-scope 纯函数测试：不连 QQ、不发网络，只验模板引擎、正则条件、身份判定、
// 预设分流与幂等性，另外锁住预设管理页的完整性（脚本能编译、元素齐全）。
//
//   node --test "plugins/persona-scope/test/*.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import plugin, { VERSION, DEFAULTS } from '../index.js';
import {
  compileCondition, renderTemplate, asArray, normalizeCards, normalizePresets, migrateRules,
  parseIdList, matchesTarget, pickCard, buildPersonaBlock, stripInjection, injectInto, buildVars,
  BLOCK_OPEN, BLOCK_CLOSE,
} from '../lib/card.js';
import { buildPresetsPage } from '../lib/page.js';

/* ── 清单 ─────────────────────────────────────────────────────── */

test('市场描述 ≤60 字，版本号两处一致', () => {
  assert.ok(plugin.description.length <= 60, `description ${plugin.description.length} 字`);
  assert.equal(plugin.version, VERSION);
  assert.equal(plugin.id, 'persona-scope');
});

test('附加规则字段已移除，改成预设', () => {
  assert.equal(plugin.config.rules, undefined, 'rules 配置项应已删除');
  assert.ok(plugin.config.presets, 'presets 要声明在 schema 里（重置配置时才不会丢）');
  assert.equal(DEFAULTS.rules, undefined);
  assert.ok(Array.isArray(DEFAULTS.presets));
});

/* ── 条件编译 ─────────────────────────────────────────────────── */

test('compileCondition 支持 /re/flags、裸正则与字面文字', () => {
  assert.equal(compileCondition('/抱抱|亲亲/').test('我想抱抱你'), true);
  assert.equal(compileCondition('早安|早上好').test('早上好呀'), true);
  assert.equal(compileCondition('а[б').test('а[б'), true, '非法正则退化成字面包含');
  assert.equal(compileCondition(''), null);
});

test('坏正则不会抛错（只返回 null 或字面包含）', () => {
  assert.doesNotThrow(() => compileCondition('/(未闭合/'));
  assert.doesNotThrow(() => compileCondition('[[['));
});

/* ── 模板渲染 ─────────────────────────────────────────────────── */

test('{{if}} 命中走 then，不命中走 else', () => {
  const t = '角色：执事。{{if /早安/}}晨间语气。{{else}}平静语气。{{end}}';
  assert.equal(renderTemplate(t, {}, '早安'), '角色：执事。晨间语气。');
  assert.equal(renderTemplate(t, {}, '晚安'), '角色：执事。平静语气。');
});

test('没有 else 且不命中时整段消失', () => {
  assert.equal(renderTemplate('前{{if /抱抱/}}亲昵{{end}}后', {}, '走开'), '前后');
});

test('嵌套条件从内向外展开', () => {
  const t = '{{if /a/}}A{{if /b/}}B{{else}}b{{end}}{{end}}';
  assert.equal(renderTemplate(t, {}, 'ab'), 'AB');
  assert.equal(renderTemplate(t, {}, 'a'), 'Ab');
  assert.equal(renderTemplate(t, {}, 'c'), '');
});

test('变量替换，未知变量原样保留', () => {
  assert.equal(renderTemplate('你好 {{nick}}，{{time}}', { nick: '小王', time: '09:30' }, ''), '你好 小王，09:30');
  assert.equal(renderTemplate('{{没这个变量}}', {}, ''), '{{没这个变量}}');
});

test('缺 end 的模板不会死循环，也不会吃掉正文', () => {
  const out = renderTemplate('正常文字{{if /x/}}没闭合的块', {}, 'x');
  assert.ok(out.startsWith('正常文字'));
  assert.ok(out.length < 200);
});

/* ── 配置归一 ─────────────────────────────────────────────────── */

test('asArray 容忍 JSON 字符串 / 单对象 / 坏数据', () => {
  assert.deepEqual(asArray('[{"a":1}]'), [{ a: 1 }]);
  assert.deepEqual(asArray({ a: 1 }), [{ a: 1 }]);
  assert.deepEqual(asArray('不是 json'), []);
  assert.deepEqual(asArray(null), []);
});

test('normalizeCards 丢掉没有正文的卡，并补 id', () => {
  const cards = normalizeCards([
    { name: '空卡', text: '   ' },
    { name: '执事', text: '角色：执事' },
    { id: 'x', text: '有 id' },
  ]);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].id, 'card2');
  assert.equal(cards[1].id, 'x');
});

test('normalizePresets 归一 name/role/when/content/enabled', () => {
  const list = normalizePresets([
    { name: '防抢话', content: '不许替对方说话', role: 'system' },
    { name: '', content: '没名字的', role: '乱写' },
    { name: '空的', content: '  ' },
    { name: '预注入', content: '用户说：你好', role: 'user', when: '/早安/', enabled: false },
  ]);
  assert.equal(list.length, 3, '空正文那条被丢掉');
  assert.equal(list[0].role, 'system');
  assert.equal(list[1].name, '预设 2', '空名字补序号');
  assert.equal(list[1].role, 'system', '非法 role 落到 system');
  assert.equal(list[2].enabled, false);
  assert.equal(list[2].role, 'user');
  assert.equal(list[2].when, '/早安/');
});

test('migrateRules 把旧的 rules 转成预设（升级不丢配置）', () => {
  const migrated = migrateRules([
    { when: '抱抱', text: '亲昵一点', mode: 'append' },
    { when: '', text: '总是生效的' },
    { when: 'x', text: '' },
  ]);
  assert.equal(migrated.length, 2);
  assert.equal(migrated[0].role, 'system');
  assert.equal(migrated[0].when, '抱抱');
  assert.equal(migrated[0].content, '亲昵一点');
});

test('parseIdList 支持多种分隔符并去重保序', () => {
  assert.deepEqual(parseIdList('a,b，c、d;e；f a'), ['a', 'b', 'c', 'd', 'e', 'f']);
});

/* ── 身份判定：只看 openid / 等级，绝不看昵称 ──────────────────── */

test('matchesTarget 认 openid，不认名字', () => {
  const cfg = { targets: 'USER_A, USER_B', minLevel: 0 };
  assert.equal(matchesTarget({ ...cfg, userId: 'USER_A', level: 9 }), true);
  assert.equal(matchesTarget({ ...cfg, userId: 'USER_C', level: 9 }), false);
  assert.equal(matchesTarget({ ...cfg, userId: 'USER_C', nick: '主人', level: 9 }), false);
});

test('matchesTarget 按等级生效（数字越小越高）', () => {
  const cfg = { targets: '', minLevel: 1 };
  assert.equal(matchesTarget({ ...cfg, userId: 'ANY', level: 0 }), true, '主人');
  assert.equal(matchesTarget({ ...cfg, userId: 'ANY', level: 1 }), true, '管理员');
  assert.equal(matchesTarget({ ...cfg, userId: 'ANY', level: 2 }), false, '群管不该命中');
  assert.equal(matchesTarget({ ...cfg, userId: 'ANY', level: 9999 }), false, '普通人');
});

test('minLevel=0 时不看等级', () => {
  assert.equal(matchesTarget({ targets: '', minLevel: 0, userId: 'ANY', level: 0 }), false);
});

test('卡片自带的 targets 优先于全局 targets', () => {
  const c = { targets: 'GLOBAL', minLevel: 0, userId: 'CARD_ONLY' };
  assert.equal(matchesTarget(c, 'CARD_ONLY'), true);
  assert.equal(matchesTarget(c, 'OTHER'), false);
});

test('pickCard 按 id 选，找不到退回第一套', () => {
  const cards = normalizeCards([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }]);
  assert.equal(pickCard(cards, 'b').id, 'b');
  assert.equal(pickCard(cards, '不存在').id, 'a');
  assert.equal(pickCard([], 'x'), null);
});

/* ── 注入块 ───────────────────────────────────────────────────── */

test('buildPersonaBlock 带边界标记，且把条件渲染进去', () => {
  const card = { text: '角色：执事。{{if /抱抱/}}回应亲昵一点。{{end}}' };
  const block = buildPersonaBlock({ card, subject: '抱抱你', vars: {} });
  assert.ok(block.startsWith(BLOCK_OPEN));
  assert.ok(block.endsWith(BLOCK_CLOSE));
  assert.ok(block.includes('回应亲昵一点'));
});

test('system 预设按数组顺序追加在人设卡之后', () => {
  const card = { text: '角色：执事' };
  const presets = normalizePresets([
    { name: 'A', content: '第一条', role: 'system' },
    { name: 'B', content: '第二条', role: 'system' },
  ]);
  const block = buildPersonaBlock({ card, presets, subject: '', vars: {} });
  const iCard = block.indexOf('角色：执事');
  const iA = block.indexOf('第一条');
  const iB = block.indexOf('第二条');
  assert.ok(iCard < iA && iA < iB, '顺序应为 卡 → A → B');
});

test('预设的 when 条件命中才生效', () => {
  const presets = normalizePresets([{ name: '撒娇', content: '亲昵', when: '/抱抱/' }]);
  assert.equal(buildPersonaBlock({ presets, subject: '抱抱' }).includes('亲昵'), true);
  assert.equal(buildPersonaBlock({ presets, subject: '再见' }).includes('亲昵'), false);
});

test('禁用的预设不参与注入', () => {
  const presets = normalizePresets([{ name: '关掉的', content: '不该出现', enabled: false }]);
  assert.equal(buildPersonaBlock({ presets, subject: '' }), '');
});

test('user / assistant 预设单独成段并标注来源', () => {
  const presets = normalizePresets([
    { name: 'u', content: '今天心情不错', role: 'user' },
    { name: 'a', content: '我记得你喜欢咖啡', role: 'assistant' },
  ]);
  const block = buildPersonaBlock({ presets, subject: '' });
  assert.ok(block.includes('模拟对方说的话'));
  assert.ok(block.includes('模拟你此前说过的话'));
  assert.ok(block.includes('今天心情不错'));
  assert.ok(block.includes('我记得你喜欢咖啡'));
});

test('没有卡片、只有预设也能注入（预设本身就能构成人设）', () => {
  const presets = normalizePresets([{ name: 'x', content: '只用预设' }]);
  assert.ok(buildPersonaBlock({ presets, subject: '' }).includes('只用预设'));
  assert.equal(buildPersonaBlock({ presets: [], card: null }), '');
});

test('card 为 null 时 buildPersonaBlock 不炸（只用预设的常见情况）', () => {
  const presets = normalizePresets([{ name: 'x', content: '只用预设', role: 'system' }]);
  assert.doesNotThrow(() => buildPersonaBlock({ card: null, presets, subject: 'hi', vars: {} }));
  // 这条曾经是真空指针：personaFor 里 `cardName: card.name` 在只有预设时抛 TypeError，
  // 而中间件的 catch 会把它吞成「本条按原样放行」——表现是预设配了却完全不生效
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(!/cardName: card\.name[,\s]/.test(src), '应该用 card?.name 容 null');
});

test('超长会截断', () => {
  const card = { text: 'x'.repeat(5000) };
  const block = buildPersonaBlock({ card, subject: '', maxChars: 300 });
  assert.ok(block.length < 400, `实际 ${block.length}`);
  assert.ok(block.includes('截断'));
});

test('stripInjection 幂等剥离，不会吃掉正文', () => {
  const block = buildPersonaBlock({ card: { text: '设定' } });
  const withBlock = injectInto('你好呀', block);
  assert.equal(stripInjection(withBlock), '你好呀');
  assert.equal(stripInjection(stripInjection(withBlock)), '你好呀');
  assert.equal(stripInjection('普通消息'), '普通消息');
});

test('重复注入不会叠加', () => {
  const block = buildPersonaBlock({ card: { text: '设定' } });
  let text = '原始消息';
  for (let i = 0; i < 3; i += 1) text = injectInto(text, block);
  assert.equal(text.split(BLOCK_OPEN).length - 1, 1);
  assert.ok(text.startsWith('原始消息'));
});

test('注入放在原文之后，原文一个字不动（对别的插件透明）', () => {
  const block = buildPersonaBlock({ card: { text: '设定' } });
  assert.ok(injectInto('/天气 上海', block).startsWith('/天气 上海'));
});

/* ── 预设管理页 ───────────────────────────────────────────────── */

test('预设管理页是完整 HTML，关键元素齐全', () => {
  const html = buildPresetsPage();
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  for (const id of ['list', 'editor', 'add', 'export', 'importFile', 'status', 'count']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
  }
  // 与后端路由对齐
  assert.ok(html.includes('/api/plugins/persona-scope/r/presets'));
});

test('预设管理页的内联脚本能编译（语法错误会让整页按钮失效）', () => {
  const html = buildPresetsPage();
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, '找不到内联脚本');
  // 用 new Function 只编译不执行：能过就说明没有语法错误
  assert.doesNotThrow(() => new Function(m[1]), '内联脚本有语法错误');
});

test('预设管理页体积远低于 512KB 上限', () => {
  assert.ok(buildPresetsPage().length < 512 * 1024);
});

/* ── 变量 ─────────────────────────────────────────────────────── */

test('buildVars 给本地时间，变量齐全', () => {
  const v = buildVars({ nick: '小王', userId: 'U1', level: 0, chatId: 'G1', cardName: '执事', now: new Date(2026, 10, 11, 9, 5) });
  assert.equal(v.nick, '小王');
  assert.equal(v.time, '09:05');
  assert.equal(v.date, '2026-11-11');
  assert.equal(v.weekday, '周三');
  assert.equal(v.level, '0');
});

test('buildVars 昵称为空时给占位', () => {
  assert.equal(buildVars({ nick: '  ' }).nick, '对方');
});

/* ── 字段契约 ─────────────────────────────────────────────────── */

test('onlyWhenAddressed 用框架的 addressed（replyToBot 不存在）', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(src.includes('msg.addressed'));
  assert.ok(!/msg\.replyToBot/.test(src));
});

// 审查发现的四个问题的回归测试
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import plugin from '../index.js';
import {
  buildPersonaBlock, normalizeCards, normalizePresets, presetCost, matchesTarget, cardsForUser,
} from '../lib/card.js';
import { buildCardsPage, buildPresetsPage } from '../lib/page.js';

/* ── 脚手架：真跑一遍插件 + 假 ctx ───────────────────────────── */

function makeCtx(config) {
  const handlers = {};
  const commands = new Map();
  const ctx = {
    id: 'persona-scope',
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get config() { return config; },
    async setConfig(p) { Object.assign(config, p); return config; },
    state: {},
    levelOf: async () => 9999,
    can: async () => false, // 普通人：非管理员
    command(p, o, fn) { commands.set(p.split(' ')[0], fn); },
    menu() {}, onTeardown() {}, setDashboard() {}, schedule() {},
    on(e, fn) { (handlers[e] ||= []).push(fn); },
    storage: { get: async () => null, set: async () => {} },
    registerPage() { return null; }, registerRoute() { return null; },
  };
  plugin.setup(ctx);
  return { ctx, handlers, commands };
}

const mkMsg = (userId, content, extra = {}) => ({
  id: 'M', kind: 'group', groupId: 'G', chatId: 'G', userId, userName: '某人',
  content, isCommand: false, addressed: true, ...extra,
});

const baseCfg = (over = {}) => ({
  enabled: true, targets: '', minLevel: 0, cards: [], defaultCard: '',
  presets: [], maxChars: 1200, onlyWhenAddressed: false, debug: false, ...over,
});

/* ── ① 只在卡片名单里的人，预览与注入必须一致放行 ─────────────── */

test('只在 card.targets 里的人：能注入，也能 /人设 预览', async () => {
  const UID = 'ONLY_IN_CARD';
  const cfg = baseCfg({
    targets: '', // 全局名单故意留空
    cards: [{ id: 'c1', name: '专属', targets: UID, text: '只给这个人的设定' }],
    defaultCard: 'c1',
  });
  const { handlers, commands } = makeCtx(cfg);
  await new Promise((r) => setTimeout(r, 40));

  const m = mkMsg(UID, '你好');
  await handlers.message[0](m);
  assert.ok(m.content.includes('只给这个人的设定'), '聊天时应当注入');

  const cmd = { ...mkMsg(UID, '/人设 预览'), isCommand: true, args: ['预览'], replies: [], async reply(t) { this.replies.push(t); } };
  await commands.get('人设')(cmd);
  assert.ok(
    String(cmd.replies[0]).includes('只给这个人的设定'),
    `预览应与注入一致，实际回了：${cmd.replies[0]}`,
  );
});

test('既不在全局也不在卡片名单的人，预览仍被拒', async () => {
  const cfg = baseCfg({
    targets: '',
    cards: [{ id: 'c1', name: '专属', targets: 'SOMEONE', text: '秘密设定' }],
  });
  const { commands } = makeCtx(cfg);
  await new Promise((r) => setTimeout(r, 40));
  const cmd = { ...mkMsg('STRANGER', '/人设 预览'), isCommand: true, args: ['预览'], replies: [], async reply(t) { this.replies.push(t); } };
  await commands.get('人设')(cmd);
  assert.match(String(cmd.replies[0]), /只对管理员和生效对象可见/);
  assert.ok(!String(cmd.replies[0]).includes('秘密设定'), '不能泄露正文');
});

/* ── ② 路人闲聊不能把 skipped 顶上去 ─────────────────────────── */

test('路人闲聊不计入 skipped，目标用户被挡住才计', async () => {
  const cfg = baseCfg({
    targets: 'TARGET_ONE',
    cards: [{ id: 'c1', name: '卡', text: '设定' }],
    onlyWhenAddressed: true, // 目标用户没 @ 时会被挡 → matched=true 但 block 空
  });
  const { ctx, handlers } = makeCtx(cfg);
  await new Promise((r) => setTimeout(r, 40));

  const s0 = ctx.state.ps.skipped;
  for (let i = 0; i < 5; i += 1) {
    await handlers.message[0](mkMsg('RANDOM_' + i, '闲聊一句'));
  }
  assert.equal(ctx.state.ps.skipped, s0, '路人闲聊不该计入 skipped');

  // 目标用户、没 @ → matched 但没注入 → 计一次
  await handlers.message[0](mkMsg('TARGET_ONE', '说话', { addressed: false }));
  assert.equal(ctx.state.ps.skipped, s0 + 1, '目标但被挡住要计一次');

  // 目标用户、@ 了 → 正常注入，不计 skipped
  const before = ctx.state.ps.skipped;
  await handlers.message[0](mkMsg('TARGET_ONE', '说话', { addressed: true }));
  assert.equal(ctx.state.ps.skipped, before, '正常注入不该计 skipped');
});

/* ── ③ 预算条跟随编辑中的卡 ─────────────────────────────────── */

test('预算条按正在编辑的卡算，不再写死第一张', () => {
  const src = fs.readFileSync(new URL('../lib/page.js', import.meta.url), 'utf8');
  assert.ok(src.includes('cards[editing >= 0 ? editing : 0]'), '应按 editing 取卡');
  assert.ok(!src.includes('"  const c = cards[0];"'), '不该写死 cards[0]');
});

/* ── ④ 预设成本要把包裹头算进去 ─────────────────────────────── */

test('presetCost：user/assistant 角色含包裹前缀，system 不含', () => {
  const sys = { name: 'a', content: 'x'.repeat(100), role: 'system', enabled: true };
  const usr = { name: 'b', content: 'y'.repeat(100), role: 'user', enabled: true };
  const asst = { name: 'c', content: 'z'.repeat(100), role: 'assistant', enabled: true };
  assert.equal(presetCost(sys), 100);
  assert.ok(presetCost(usr) > 100, 'user 预设要含来源标注');
  assert.ok(presetCost(asst) > 100);
  assert.equal(presetCost({ ...sys, enabled: false }), 0, '禁用不计');

  // 与真实注入长度一致（不能算出比实际小，否则用户卡线填就被截）
  const block = buildPersonaBlock({ presets: normalizePresets([usr]), subject: '' });
  const bodyLen = block.length - '〔专属人设·仅对本次发言人生效〕'.length - '〔专属人设结束〕'.length - 2;
  assert.ok(presetCost(usr) >= bodyLen - 2, `预估 ${presetCost(usr)} 应接近实际 ${bodyLen}`);
});

/* ── ⑤ 截断时优先保预设 ─────────────────────────────────────── */

test('超长时截人设卡，预设原样保留', () => {
  const card = normalizeCards([{ id: 'c', name: '卡', text: 'A'.repeat(3000) }])[0];
  const presets = normalizePresets([
    { name: '防抢话', content: '不得替对方补全言行', role: 'system' },
    { name: '破限', content: 'B'.repeat(500), role: 'system' },
  ]);
  const block = buildPersonaBlock({ card, presets, maxChars: 1000 });
  assert.ok(block.includes('不得替对方补全言行'), '防抢话不能被砍');
  assert.ok(block.includes('B'.repeat(500)), '破限不能被砍');
  assert.ok(block.includes('人设卡过长已截断'), '该被截的是卡片');
  // 卡片确实被截短了
  assert.ok(!block.includes('A'.repeat(1200)));
});

test('预算够时不截断', () => {
  const card = normalizeCards([{ id: 'c', name: '卡', text: 'A'.repeat(500) }])[0];
  const presets = normalizePresets([{ name: 'p', content: 'B'.repeat(200), role: 'system' }]);
  const block = buildPersonaBlock({ card, presets, maxChars: 2000 });
  assert.ok(!block.includes('已截断'));
});

test('预设自身超预算时，提示改用「预设过长」', () => {
  const presets = normalizePresets([{ name: '巨', content: 'Z'.repeat(2000), role: 'system' }]);
  const block = buildPersonaBlock({ presets, maxChars: 500 });
  assert.ok(block.includes('预设过长已截断'));
});

/* ── 回归：既有行为没被改坏 ─────────────────────────────────── */

test('卡片名单仍优先于全局名单（不串卡）', () => {
  assert.equal(
    matchesTarget({ userId: 'B', level: 1, targets: 'A,B', minLevel: 1 }, 'A'),
    false,
    '卡片有名单时只看名单',
  );
});

test('cardsForUser 过滤空了不回退全部', () => {
  const cards = normalizeCards([{ id: 'a', text: 'A', targets: 'A' }]);
  assert.deepEqual(cardsForUser(cards, { userId: 'B' }), []);
});

test('人设卡页仍可编译且预算条文案还在', () => {
  const html = buildCardsPage();
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.doesNotThrow(() => new Function(m[1]));
  assert.ok(html.includes('注入预算'));
});

/* ── 1.3.1 两处细节 ─────────────────────────────────────────── */

test('maxChars 说明与 1.3.0 的截断策略一致（优先保预设）', () => {
  const desc = plugin.config.maxChars.desc;
  assert.match(desc, /优先保住预设|先截短人设卡/, '要说明保预设');
  assert.ok(!/先被砍的是预设/.test(desc), '不能再写成「先砍预设」——那和实现相反');
});

test('两个页面的「取消」都会清掉没填内容的空条目', () => {
  for (const [name, html] of [['人设卡', buildCardsPage()], ['预设管理', buildPresetsPage()]]) {
    assert.ok(html.includes('splice(editing, 1)'), `${name}页缺空条目清理`);
    // 必须两个都判空，否则删掉用户真写了一半的条目
    assert.ok(html.includes("!String("), `${name}页清理条件不完整`);
    const m = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.doesNotThrow(() => new Function(m[1]), `${name}页脚本语法错误`);
  }
});

// 审查发现的 bug 的回归测试。
// 每条都对应一个真实可复现的故障，修完不加锁的话下次重构很容易又踩回去。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import plugin, { DEFAULTS, VERSION } from '../index.js';
import {
  compileCondition, renderTemplate, normalizeCards, normalizePresets,
  matchesTarget, cardsForUser, pickCard,
} from '../lib/card.js';

/* ── ① 执行顺序：必须是监听器，且 priority 落在 weather-card 之后、ai-chat 之前 ── */

test('注入点是监听器而不是中间件（中间件按加载顺序跑，priority 管不到）', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(!/ctx\.use\(/.test(src), '不能用 ctx.use：它的顺序由插件目录名决定，会污染下游插件');
  assert.ok(/ctx\.on\('message'/.test(src), '应改用 on(message) 监听器');
});

test('priority 必须低于 weather-card(10)、高于 ai-chat(-100)', () => {
  // 监听器按 priority 降序串行、共用同一个 msg：
  // 站在这个区间的唯一位置才能「别的插件看干净正文，只有 AI 看带人设的」
  assert.ok(Number.isFinite(plugin.priority), 'priority 必须是数字');
  assert.ok(plugin.priority < 10, `priority=${plugin.priority} 必须小于 weather-card 的 10，否则天气关键词会先看到被人设撑长的正文`);
  assert.ok(plugin.priority > -100, `priority=${plugin.priority} 必须大于 ai-chat 的 -100，否则注入发生在 AI 读过正文之后`);
});

test('注入不改命令消息，也不吞消息（不 claim）', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(/msg\.isCommand/.test(src), '命令要跳过');
  // 只认真正的调用语句；注释里提到 msg.claim() 说明「不调」是允许的
  assert.ok(!/^\s*msg\.claim\(/m.test(src), '不该认领消息：要不要回话是 ai-chat 的事');
});

/* ── ② 卡片按人分流：不能回退成全部卡片 ─────────────────────── */

test('cardsForUser：只在名单里的人拿到那张卡', () => {
  const cards = normalizeCards([
    { id: 'a', name: 'A 的卡', text: 'A', targets: 'USER_A' },
    { id: 'g', name: '通用卡', text: 'G' },
  ]);
  assert.deepEqual(cardsForUser(cards, { userId: 'USER_A' }).map((c) => c.id), ['a', 'g']);
  // 不在名单里的人只拿到通用卡，不会拿到 A 的卡
  assert.deepEqual(cardsForUser(cards, { userId: 'USER_B' }).map((c) => c.id), ['g']);
});

test('cardsForUser：全是不匹配的卡时返回空，而不是回退成全部', () => {
  const cards = normalizeCards([{ id: 'a', text: 'A', targets: 'USER_A' }]);
  assert.deepEqual(cardsForUser(cards, { userId: 'USER_B' }), []);
  // 用例：管理员 B 不该拿到「只想给 A 用」的卡
  assert.equal(pickCard(cardsForUser(cards, { userId: 'USER_B' }), ''), null);
});

test('卡片自带名单时，全局 minLevel 不能放行（同一级别的管理员不该串卡）', () => {
  const cardTargets = 'USER_A';
  // B 是管理员（level=1），全局 minLevel=1 —— 旧实现会因此返回 true
  assert.equal(
    matchesTarget({ userId: 'USER_B', level: 1, targets: '', minLevel: 1 }, cardTargets),
    false,
    '卡片有名单就只看名单',
  );
  assert.equal(matchesTarget({ userId: 'USER_A', level: 9, targets: '', minLevel: 0 }, cardTargets), true);
});

test('卡片自带名单非空时，不复用全局 targets', () => {
  // 全局名单含 B，但卡片只给 A —— B 不该因为全局名单拿到这张卡
  assert.equal(
    matchesTarget({ userId: 'USER_B', level: 9, targets: 'USER_A, USER_B', minLevel: 0 }, 'USER_A'),
    false,
  );
});

/* ── ③ 命令权限 ─────────────────────────────────────────────── */

test('/人设 预览 与 测试 要求管理员或生效对象', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(/await ctx\.can\(msg, 1\)/.test(src), '必须 await ctx.can（async）');
  assert.ok(/mayView/.test(src), '应有统一的可见性判定');
});

/* ── ④ 模板：条件里含 } 也要认 ─────────────────────────────── */

test('{{if}} 支持正则量词（条件里含 }）', () => {
  // [^}]+ 会在这里截断，导致整个模板原样漏出去
  assert.equal(renderTemplate('{{if /\\d{2,4}/}}数字{{else}}不是{{end}}', {}, '有 123 个'), '数字');
  assert.equal(renderTemplate('{{if /哈{2,}/}}笑{{else}}没笑{{end}}', {}, '哈哈哈'), '笑');
  assert.equal(renderTemplate('{{if /哈{2,}/}}笑{{else}}没笑{{end}}', {}, '哈'), '没笑');
});

test('{{if}} 里的 | 与括号也能用', () => {
  assert.equal(renderTemplate('{{if /(早|晚)安/}}问候{{else}}无{{end}}', {}, '早安'), '问候');
  assert.equal(renderTemplate('{{if /你好|您好/}}问候{{else}}无{{end}}', {}, '您好呀'), '问候');
});

/* ── ⑤ 裸写条件不能静默变死条件 ─────────────────────────────── */

test('含正则元字符的裸写：正则或字面命中其一即算命中', () => {
  // '$100' 作为正则是「行尾断言 + 100」，永远匹配不到正常句子；
  // 旧的实现直接当正则用 → 静默死条件
  assert.equal(compileCondition('$100').test('这件 $100'), true);
  assert.equal(compileCondition('a.*b').test('就是 a.*b 这两个字'), true);
  // 真正的正则写法仍然有效
  assert.equal(compileCondition('早安|早上好').test('早上好呀'), true);
  // 显式 /…/ 只按正则，不做字面兜底
  assert.equal(compileCondition('/^早/').test('早上'), true);
  assert.equal(compileCondition('/^早/').test('不早'), false);
});

/* ── ⑥ 配置 schema 要有 presets（否则重置配置会丢预设）────────── */

test('presets 必须声明在 config schema 里', () => {
  assert.ok(plugin.config.presets, 'schema 缺 presets：恢复默认配置时会整份丢掉');
  assert.equal(plugin.config.presets.type, 'json');
  assert.deepEqual(plugin.config.presets.default, []);
});

/* ── ⑦ 指标 ─────────────────────────────────────────────────── */

test('skipped 指标有真正的自增处', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(/st\.skipped \+= 1/.test(src), '面板上「命中但跳过」不能永远显示 0');
});

/* ── ⑧ /人设 测试 的样本取自 args ────────────────────────────── */

test('/人设 测试 的样本用 msg.args，不靠剥 content 前缀', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(/msg\.args\.slice\(1\)/.test(src), '群里 @机器人 触发时 content 带 at 段，剥前缀会剥不干净');
});

/* ── 版本 ───────────────────────────────────────────────────── */

test('版本号两处一致', () => {
  assert.equal(plugin.version, VERSION);
  assert.equal(plugin.id, 'persona-scope');
  assert.ok(VERSION >= '1.1.1');
});

/* ── ReDoS 护栏 ──────────────────────────────────────────────────────── */

test('嵌套量词的正则不编译，降级为字面匹配（不能让一条配置把进程带走）', () => {
  const cases = ['(a+)+b', '(a*)*b', '/(a+)+b/', String.raw`(\d+){2,}x`];
  for (const src of cases) {
    const cond = compileCondition(src);
    assert.ok(cond, `${src} 应当仍能构造出条件`);
    const t0 = Date.now();
    const hit = cond.test('a'.repeat(40));
    const cost = Date.now() - t0;
    assert.equal(hit, false);
    assert.ok(cost < 200, `${src} 用时 ${cost}ms，护栏没生效`);
  }
});

test('正常条件不受护栏影响', () => {
  assert.equal(compileCondition('早安|早上好').test('早安，主人'), true);
  assert.equal(compileCondition('^好累').test('好累啊'), true);
  assert.equal(compileCondition('/^主人/i').test('主人你好'), true);
  assert.equal(compileCondition('普通文字').test('这是一句普通文字'), true);
  assert.equal(compileCondition('早安').test('晚上好'), false);
});

test('超长正则源码（>300 字符）不编译', () => {
  const long = 'a|'.repeat(200) + 'z';
  assert.ok(long.length > 300);
  const cond = compileCondition(long);
  assert.ok(cond);
  // 退回字面匹配：正常句子里不会出现这一长串，所以不命中
  assert.equal(cond.test('随便一句话'), false);
});

test('被匹配的字符串截断到 1000 字符', () => {
  const cond = compileCondition('结尾词');
  assert.equal(cond.test('a'.repeat(900) + '结尾词'), true, '900 字符内应命中');
  assert.equal(cond.test('a'.repeat(1200) + '结尾词'), false, '超过 1000 字符的部分不参与判定');
});

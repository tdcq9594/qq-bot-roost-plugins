// 人设卡页 / 预算设置 / 示例卡 / RP 卡变量语义
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import plugin, { VERSION } from '../index.js';
import { buildCardsPage, buildPresetsPage } from '../lib/page.js';
import { EXAMPLE_CARD, EXAMPLE_CARD_LEN } from '../lib/example-card.js';
import { buildVars, renderTemplate, buildPersonaBlock, normalizeCards } from '../lib/card.js';

/* ── maxChars 配置项 ─────────────────────────────────────────── */

test('maxChars 在 schema 里，且说明覆盖了使用场景', () => {
  const f = plugin.config.maxChars;
  assert.ok(f, '缺 maxChars 配置项');
  assert.equal(f.type, 'number');
  assert.equal(f.min, 100);
  assert.equal(f.max, 20000, '要有上限，否则能把上下文撑爆');
  // 说明里必须给出可操作的区间，而不是一句「太长会截断」
  assert.match(f.desc, /800~1200|1200/);
  assert.match(f.desc, /1200~3000|4900/);
  assert.match(f.desc, /破限/);
  assert.match(f.desc, /预算条|人设卡.*页/);
});

/* ── 示例卡 ─────────────────────────────────────────────────── */

test('示例卡结构完整（id/name/text）', () => {
  assert.ok(EXAMPLE_CARD.id);
  assert.ok(EXAMPLE_CARD.name);
  // 注意是按**字符**算（maxChars 也用字符）；按 UTF-8 字节会是 ~3000
  assert.ok(EXAMPLE_CARD.text.length > 800, `只有 ${EXAMPLE_CARD.text.length} 字`);
  assert.equal(EXAMPLE_CARD_LEN, EXAMPLE_CARD.text.length);
});

test('示例卡保留 RP 卡的五段结构', () => {
  for (const sec of ['基础信息', '性格特征', '说话风格', '台词示例', '扮演指导']) {
    assert.ok(EXAMPLE_CARD.text.includes(sec), `缺「${sec}」段`);
  }
});

test('示例卡用的是 {{user}} 而不是写死人称', () => {
  assert.ok(EXAMPLE_CARD.text.includes('{{user}}'));
});

test('示例卡能通过 normalizeCards（不会当成坏数据丢掉）', () => {
  const list = normalizeCards([EXAMPLE_CARD]);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, EXAMPLE_CARD.id);
});

/* ── {{user}} 语义：必须是对方昵称，不是 openid ───────────────── */

test('{{user}} 渲染成昵称，openid 走 {{userId}}', () => {
  const OPENID = '81E083DCED0024C3AE4C7FA77CC9E5A9';
  const vars = buildVars({ nick: '小王', userId: OPENID, cardName: '爱莉安娜' });
  assert.equal(vars.user, '小王', '{{user}} 是「对方」，不是 openid');
  assert.equal(vars.userId, OPENID, 'openid 通过 {{userId}} 拿');
  // 照抄 RP 卡进来，正文里不该出现 openid
  const out = renderTemplate('目前是 {{user}} 的恋人。', vars, '');
  assert.equal(out, '目前是 小王 的恋人。'); // 原文 {{user}} 两侧有空格，替换只换占位符
  assert.ok(!out.includes('81E083DC'), '正文里不能出现 openid');
});

test('{{char}} 渲染卡片名，没有卡名时给占位', () => {
  assert.equal(renderTemplate('我是{{char}}', buildVars({ nick: 'A', cardName: '爱莉安娜' }), ''), '我是爱莉安娜');
  assert.equal(renderTemplate('我是{{char}}', buildVars({ nick: 'A' }), ''), '我是我');
});

test('把整张示例卡塞进注入块：不出现 openid，且 {{user}} 被替换', () => {
  const card = normalizeCards([EXAMPLE_CARD])[0];
  const vars = buildVars({ nick: '小王', userId: '81E083DCED0024C3AE4C7FA77CC9E5A9', cardName: card.name });
  const block = buildPersonaBlock({ card, subject: '早上好', vars, maxChars: 2000 });
  assert.ok(block.includes('小王'), '应替换成昵称');
  assert.ok(!block.includes('{{user}}'), '不该残留未替换的 {{user}}');
  assert.ok(!block.includes('81E083DC'), '不该出现 openid');
  // 这张卡约 1211 字，预算 2000 时应当不被截断
  assert.ok(!block.includes('已截断'), '预算 2000 应该装得下这张卡');
});

test('预算不足时卡片会被截断（反过来证明预算真的在起作用）', () => {
  const card = normalizeCards([EXAMPLE_CARD])[0];
  const vars = buildVars({ nick: '小王', cardName: card.name });
  const tight = buildPersonaBlock({ card, subject: '', vars, maxChars: 500 });
  assert.ok(tight.includes('已截断'));
  assert.ok(tight.length < 700);
});

/* ── 人设卡管理页 ───────────────────────────────────────────── */

test('人设卡页是完整 HTML，关键元素齐全', () => {
  const html = buildCardsPage();
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  for (const id of ['list', 'editor', 'add', 'example', 'export', 'importFile', 'status', 'budget']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
  }
  assert.ok(html.includes('/api/plugins/persona-scope/r/cards'));
  assert.ok(html.includes('/api/plugins/persona-scope/r/settings'), '预算保存走 /settings');
});

test('人设卡页脚本能编译（语法错误会让整页按钮失效）', () => {
  const m = /<script>([\s\S]*?)<\/script>/.exec(buildCardsPage());
  assert.ok(m);
  assert.doesNotThrow(() => new Function(m[1]));
});

test('人设卡页有预算条的说明文案', () => {
  const html = buildCardsPage();
  assert.ok(html.includes('注入预算'));
  assert.ok(html.includes('怎么定'), '要说明怎么选预算');
});

test('两个页面都在 512KB 上限内', () => {
  assert.ok(buildCardsPage().length < 512 * 1024);
  assert.ok(buildPresetsPage().length < 512 * 1024);
});

/* ── 版本 ───────────────────────────────────────────────────── */

test('版本已升级', () => {
  assert.equal(plugin.version, VERSION);
  assert.ok(VERSION >= '1.2.0');
});

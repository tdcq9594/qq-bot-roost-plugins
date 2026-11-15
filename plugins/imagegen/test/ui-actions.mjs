#!/usr/bin/env node
/**
 * 静态守门：清单 ↔ 进程内动作 ↔ 面板页面 ↔ 声明式字段 四处对齐
 *
 *   node test/ui-actions.mjs
 *
 * 「结构齐全」不等于「行为齐全」：按钮声明了但入口没实现、页面没绑、
 * 字段声明了但 rows 没产出，都是点了没反应的假功能。这一份把它们钉在一起。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACTION_IDS } from '../ui/main.mjs';
import { createToolbox } from '../lib/tools.mjs';
import { rowsOf } from '../lib/ui-data.mjs';
import { tmpdir } from 'node:os';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(HERE, 'plugin.json'), 'utf8'));
const pageText = readFileSync(join(HERE, manifest.ui.page), 'utf8');
const serverText = readFileSync(join(HERE, 'server.mjs'), 'utf8');

test('ui.actions 的每个 id 都有进程内实现，一个不多一个不少', () => {
  const declared = manifest.ui.actions.map((a) => a.id).sort();
  assert.deepEqual(declared, [...ACTION_IDS].sort());
  for (const a of manifest.ui.actions) {
    assert.ok(/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(a.id), `动作 id 不合法：${a.id}`);
    assert.ok(a.label.length <= 12, `动作文案超过 12 字：${a.label}`);
    assert.ok(pageText.includes(a.id), `页面里没有绑动作 ${a.id}`);
  }
  assert.ok(manifest.ui.nav.label.length <= 12, '导航文案超过 12 字');
});

test('清单体积没越界（越界 = 整份隐藏，不是报错）', () => {
  assert.ok(Object.keys(manifest.config).length <= 64, 'config 最多 64 个字段');
  assert.ok(manifest.ui.actions.length <= 16, 'ui.actions 最多 16 个');
  assert.ok(manifest.ui.form.keys.length <= 40, 'form.keys 最多 40 个');
  assert.ok(Array.from(manifest.usage).length <= 200, 'usage 别撑爆注入预算');
});

test('form.keys 全部是真配置字段；secret 不许带 default', () => {
  for (const k of manifest.ui.form.keys) {
    assert.ok(Object.hasOwn(manifest.config, k), `form.keys 里的 ${k} 没在 config 声明`);
  }
  for (const [k, f] of Object.entries(manifest.config)) {
    if (f.secret) assert.ok(!Object.hasOwn(f, 'default'), `secret ${k} 不许写 default（会明文回面板）`);
  }
});

test('ui.view.fields 与 rowsOf 产出的键一一对应', () => {
  const declared = manifest.ui.view.fields.map((f) => f.key).sort();
  const produced = Object.keys(rowsOf([{}])[0]).sort();
  assert.deepEqual(declared, produced);
  assert.equal(manifest.ui.view.source.file, 'ui-data.json');
});

test('页面与入口都在扩展目录内，且页面真的发了那几类请求', () => {
  assert.equal(manifest.ui.runtime, 'inprocess');
  assert.ok(/\.m?js$/i.test(manifest.ui.entry));
  for (const rel of [manifest.ui.page, manifest.ui.entry]) {
    assert.ok(!rel.startsWith('/') && !rel.includes('..'), `路径不能越出扩展目录：${rel}`);
    assert.ok(existsSync(join(HERE, rel)), `文件不存在：${rel}`);
  }
  for (const needle of [
    'extensions.config.get', 'extensions.config.save', 'extensions.ui.action',
    '/ext-pages', 'gallery.json', 'cfgLoaded', 'image-alone',
  ]) {
    assert.ok(pageText.includes(needle), `页面缺关键链路：${needle}`);
  }
});

test('页面无 CRLF、无反引号（反引号会截断模板串，本项目出过事故）', () => {
  assert.ok(!pageText.includes('\r\n'), '页面必须是 LF 换行');
  assert.ok(!pageText.includes('`'), '页面里不该出现反引号');
});

test('usage 不会被宿主截断：连 usageText 的前后缀一起算也不超 200 字', () => {
  /**
   * 宿主 `src/ext-usage.js`：USAGE_CHAR_LIMIT = 200（按码点），
   * 截断对象是**拼好的** `usageText()`，不是清单里的裸 usage：
   *   【扩展：imagegen】<usage>（工具：mcp__imagegen__*）
   * 0.2 第一版写了 360 字，模型只能看到前半段，image_status / 防注入
   * 声明全被截掉 —— 这条守门就是为它加的。合计预算另有 2048 字节。
   */
  const section = '【扩展：' + manifest.id + '】' + manifest.usage
    + '（工具：mcp__' + manifest.id + '__*）';
  const chars = Array.from(section).length;
  const bytes = Buffer.byteLength(section, 'utf8');
  assert.ok(chars <= 200, `注入后 ${chars} 字，超过宿主单条 200 字上限会被截断`);
  assert.ok(bytes <= 2048, `注入后 ${bytes} 字节，会挤掉别的扩展的 usage`);
  assert.match(manifest.usage, /<<image-alone:/, '发送标记契约必须在最前面');
  assert.match(manifest.usage, /只是素材|只当素材/, '外部内容防注入声明必须在截断线以内');
  assert.match(manifest.usage, /我去画一下/, '别把人设压成说明书：画之前先说一句的引导要留住');
});

test('「你能画图吗」的触发词只归 image_status，别让模型直接花一次钱', () => {
  /**
   * 第二轮对抗测试 E4：usage 只剩 13 码点，补不下工具路由；
   * 模型选工具主要看 tools/list 的 description。若把「你能画图吗」写进
   * image_test 的描述（哪怕后面跟一句「不要用这个」），逐字命中仍会让它
   * 直接真画一张。所以触发词只能出现在不花钱的 image_status 里。
   */
  const tools = createToolbox({ cfg: {}, dir: tmpdir() }).tools;
  const desc = (name) => tools.find((t) => t.name === name)?.description ?? '';
  assert.match(desc('image_status'), /你能画图吗/);
  assert.doesNotMatch(desc('image_test'), /你能画图吗|你能画吗/);
  assert.match(desc('image_test'), /image_status/, '要给出不花钱的替代工具名');
});

test('版本号三处一致：清单 / server / 索引条目不靠人记', () => {
  assert.match(serverText, new RegExp("version: '" + manifest.version.replace('.', '\\.') + "'"));
  const idx = JSON.parse(readFileSync(join(HERE, '..', '..', 'index.json'), 'utf8'));
  const entry = (idx.plugins || idx.items || []).find((p) => p.id === manifest.id);
  assert.ok(entry, '市场索引里应该有这个扩展');
  assert.equal(entry.version, manifest.version, '索引版本要和清单一致（build-index 会同步）');
  assert.equal(entry.sha256.length, 64);
});

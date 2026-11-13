#!/usr/bin/env node
/**
 * 面板数据文件（6.1 声明式界面）
 * ============================
 *
 *   node test/ui-data.mjs
 *
 * 最后一条断言最要紧：`rowsOf()` 产出的键必须和 plugin.json 里声明的字段
 * **一字不差**。多一个少一个，面板不是空白就是缺列，而扩展这边一点报错都没有。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UI_FILE, createUiData, rowsOf } from '../lib/ui-data.mjs';

/** 用 fileURLToPath：`URL.pathname` 会把空格编码成 %20、Windows 上还带前导斜杠 */
const HERE = fileURLToPath(new URL('..', import.meta.url));

test('rowsOf：只出四个标量字段（宿主会把对象/数组清空）', () => {
  const rows = rowsOf([{ file: '20261114-031501-猫.png', bytes: 1932735, at: new Date(2026, 10, 14, 3, 15).getTime(), prompt: '一只橘猫' }]);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['file', 'prompt', 'size', 'when']);
  assert.equal(rows[0].prompt, '一只橘猫');
  assert.equal(rows[0].size, '1.8MB');
  assert.equal(rows[0].when, '11-14 03:15');
  for (const v of Object.values(rows[0])) assert.equal(typeof v, 'string');
});

test('rowsOf：脏数据不炸，缺提示词给占位', () => {
  const rows = rowsOf([{}, null]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].prompt, '(没记提示词)');
  assert.equal(rows[0].when, '');
  assert.equal(rowsOf(null).length, 0);
});

test('写盘：空列表不覆盖旧数据（一次读失败不该把面板清空）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imagegen-ui-'));
  try {
    const ui = createUiData({ dir });
    assert.equal(ui.fromGallery([]), false);
    assert.equal(ui.fromGallery([{ file: 'a.png', bytes: 1, at: 1, prompt: 'x' }]), true);
    const saved = JSON.parse(readFileSync(join(dir, UI_FILE), 'utf8'));
    assert.equal(saved.rows.length, 1);
    assert.ok(saved.updatedAt > 0);
    ui.fromGallery([]);
    assert.equal(JSON.parse(readFileSync(join(dir, UI_FILE), 'utf8')).rows.length, 1);
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch { /* 系统回收 */ }
  }
});

test('清单声明的字段与 rowsOf 产出的一一对应（改一边就要改另一边）', () => {
  const manifest = JSON.parse(readFileSync(join(HERE, 'plugin.json'), 'utf8'));
  const declared = manifest.ui.view.fields.map((f) => f.key).sort();
  const produced = Object.keys(rowsOf([{}])[0]).sort();
  assert.deepEqual(declared, produced, '声明了但没产出（或反过来）都会让面板空白');
});

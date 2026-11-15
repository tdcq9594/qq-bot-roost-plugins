#!/usr/bin/env node
/**
 * 面板数据两份文件：gallery.json（数组给页面）与 ui-data.json（标量给宿主）
 *
 *   node test/gallery.mjs
 *
 * 重点是两个进程交叉写同一份 ui-data.json 时不能互相抹掉对方的状态。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GALLERY_FILE, createGallery, galleryRows } from '../lib/gallery.mjs';
import { UI_FILE, createUiData, rowsOf } from '../lib/ui-data.mjs';

const items = [
  { file: '20261115-231501-一只橘猫.png', bytes: 1932735, at: new Date(2026, 10, 15, 23, 15).getTime(), prompt: '一只橘猫' },
  { file: '20261115-231400-柴犬.webp', bytes: 20480, at: new Date(2026, 10, 15, 23, 14).getTime(), prompt: '柴犬' },
];

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'imagegen-gallery-'));
  return {
    dir,
    dispose() {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch { /* 系统回收 */ }
    },
  };
}

test('galleryRows：file 是 out/ 相对路径，name 是纯文件名，全是标量', () => {
  const rows = galleryRows(items);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].no, 1);
  assert.equal(rows[0].file, 'out/20261115-231501-一只橘猫.png');
  assert.equal(rows[0].name, '20261115-231501-一只橘猫.png');
  assert.equal(rows[0].size, '1.8MB');
  assert.equal(rows[0].when, '11-15 23:15');
  for (const v of Object.values(rows[0])) {
    assert.ok(['string', 'number'].includes(typeof v), '数组里的字段也只放标量');
  }
  assert.deepEqual(galleryRows(null), []);
});

test('createGallery：tmp + rename 整份写，空列表也真的清空', () => {
  const s = sandbox();
  try {
    const g = createGallery({ dir: s.dir });
    assert.equal(g.write(items), true);
    const j = JSON.parse(readFileSync(join(s.dir, GALLERY_FILE), 'utf8'));
    assert.equal(j.items.length, 2);
    assert.ok(j.updatedAt > 0);
    assert.equal(g.read().length, 2);
    assert.equal(g.write([]), true);
    assert.deepEqual(g.read(), [], '删光最后一张后画廊要变空，不能留着旧图');
  } finally { s.dispose(); }
});

test('setMeta：合并而非覆盖，rows 和别人的字段都留着', () => {
  const s = sandbox();
  try {
    const ui = createUiData({ dir: s.dir });
    ui.write(rowsOf(items));
    ui.setMeta({ today: 2, dailyLimit: 20, ready: '配置看起来能画' });
    ui.setMeta({ lastResult: '画好了', lastVia: '主接口' });
    const j = JSON.parse(readFileSync(join(s.dir, UI_FILE), 'utf8'));
    assert.equal(j.rows.length, 2, 'rows 不能被 meta 写没');
    assert.equal(j.meta.today, 2);
    assert.equal(j.meta.ready, '配置看起来能画');
    assert.equal(j.meta.lastResult, '画好了');
    assert.equal(j.meta.lastVia, '主接口');
  } finally { s.dispose(); }
});

test('两个进程交叉写：MCP 写 rows 不会抹掉宿主进程写的 meta', () => {
  const s = sandbox();
  try {
    const a = createUiData({ dir: s.dir });  // 模拟 MCP 子进程
    const b = createUiData({ dir: s.dir });  // 模拟宿主进程内动作
    a.write(rowsOf(items));
    b.setMeta({ today: 1, lastResult: '画好了' });
    a.fromGallery(items.slice(0, 1));
    const j = JSON.parse(readFileSync(join(s.dir, UI_FILE), 'utf8'));
    assert.equal(j.rows.length, 1);
    assert.equal(j.meta.today, 1, '另一个进程写的状态要留着');
    assert.equal(j.meta.lastResult, '画好了');
  } finally { s.dispose(); }
});

test('fromGallery：默认空列表不覆盖；显式 allowEmpty 才清空', () => {
  const s = sandbox();
  try {
    const ui = createUiData({ dir: s.dir });
    assert.equal(ui.fromGallery(items), true);
    assert.equal(ui.fromGallery([]), false);
    assert.equal(ui.read().rows.length, 2);
    assert.equal(ui.fromGallery([], { allowEmpty: true }), true);
    assert.equal(ui.read().rows.length, 0);
  } finally { s.dispose(); }
});

test('setMeta：塞进来的数组/对象被转成字符串，不会留下假结构', () => {
  const s = sandbox();
  try {
    const ui = createUiData({ dir: s.dir });
    ui.setMeta({ weird: ['a', 'b'] });
    assert.equal(typeof ui.read().meta.weird, 'string');
  } finally { s.dispose(); }
});

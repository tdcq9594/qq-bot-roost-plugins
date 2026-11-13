#!/usr/bin/env node
/**
 * 画作库：存、列、找、删（只碰临时目录）
 *
 *   node test/paint.mjs
 *
 * 这里最值得盯的是 `safeName` 与 `resolveRef`：
 * 前者是「模型给的字符串会不会跑出扩展目录」的唯一一道门，
 * 后者决定 `#1` 到底是哪张 —— 错一位，用户就会收到别人那张图。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bytesText, listPaintings, metaOf, pathOf, removePainting, resolveRef, safeName, savePainting, stampOf } from '../lib/paint.mjs';

/** 有 PNG 魔数就够了：`sniffMime` 只看文件头，不需要真解出一张图。 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'imagegen-paint-'));
  try {
    return fn(dir);
  } finally {
    /** Windows 上刚写完的文件偶尔还被占用：清理失败不该判测试红 */
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch { /* 系统回收 */ }
  }
}

test('stampOf / metaOf：文件名里的时间能原样读回来', () => {
  const at = new Date(2026, 10, 14, 3, 15, 1);
  assert.equal(stampOf(at), '20261114-031501');
  const meta = metaOf('20261114-031501-一只橘猫.png');
  assert.equal(meta.prompt, '一只橘猫');
  assert.equal(new Date(meta.at).getFullYear(), 2026);
  assert.equal(new Date(meta.at).getHours(), 3);
});

test('metaOf：认不出的文件名不炸，提示词为空', () => {
  const meta = metaOf('随手放的图.png');
  assert.equal(meta.prompt, '');
  assert.equal(meta.at, 0);
});

test('存图：文件名带时间和提示词，扩展名按文件头判', () => {
  withDir((dir) => {
    const file = savePainting({ dir, buf: PNG, prompt: '一只橘猫，坐在窗台上', now: new Date(2026, 10, 14, 3, 15, 1) });
    assert.match(file, /^20261114-031501-一只橘猫，坐在窗台上\.png$/);
    assert.ok(existsSync(join(dir, file)));
  });
});

test('存图：提示词里的路径分隔符 / 保留字符不能进文件名', () => {
  withDir((dir) => {
    const file = savePainting({ dir, buf: PNG, prompt: '../../etc/passwd|a:b*c?', now: new Date(2026, 10, 14, 3, 15, 1) });
    assert.ok(file.startsWith('20261114-031501-'));
    assert.ok(!/[\\/:*?"<>|]/.test(file), `文件名里不该有保留字符：${file}`);
    assert.ok(existsSync(join(dir, file)));
  });
});

test('存图：同一秒同一句提示词画两张，不覆盖前一张', () => {
  withDir((dir) => {
    const at = new Date(2026, 10, 14, 3, 15, 1);
    const a = savePainting({ dir, buf: PNG, prompt: '猫', now: at });
    const b = savePainting({ dir, buf: PNG, prompt: '猫', now: at });
    assert.notEqual(a, b);
    assert.equal(listPaintings({ dir }).total, 2);
  });
});

test('存图：不是图片的字节（没有已知魔数）拒收，返回空串而不是写个坏文件', () => {
  withDir((dir) => {
    const file = savePainting({ dir, buf: Buffer.from('<!doctype html>'), prompt: '错误页' });
    assert.equal(file, '');
    assert.equal(listPaintings({ dir }).total, 0);
  });
});

test('列表：按时间倒序、limit 夹在 1–50、空目录不炸', () => {
  withDir((dir) => {
    assert.deepEqual(listPaintings({ dir }), { items: [], total: 0, limit: 20 });
    savePainting({ dir, buf: PNG, prompt: 'old', now: new Date(2026, 10, 14, 1, 0, 0) });
    savePainting({ dir, buf: PNG, prompt: 'new', now: new Date(2026, 10, 14, 2, 0, 0) });
    assert.equal(listPaintings({ dir }).items[0].prompt, 'new');
    assert.equal(listPaintings({ dir, limit: 999 }).limit, 50);
    assert.equal(listPaintings({ dir, limit: 0 }).limit, 20, '0 / 负数当没填');
  });
});

test('safeName：跑不出目录（../、绝对路径、盘符、NUL、非图片后缀全拒）', () => {
  const dir = join(tmpdir(), 'imagegen-safe');
  assert.equal(safeName(dir, '20261114-031501-猫.png'), '20261114-031501-猫.png');
  assert.equal(safeName(dir, '../evil.png'), '');
  assert.equal(safeName(dir, '..\\evil.png'), '');
  assert.equal(safeName(dir, 'sub/evil.png'), '');
  assert.equal(safeName(dir, 'C:\\Windows\\a.png'), '');
  assert.equal(safeName(dir, '/etc/a.png'), '');
  assert.equal(safeName(dir, 'a.png\u0000'), '');
  assert.equal(safeName(dir, 'readme.txt'), '');
  assert.equal(safeName(dir, ''), '');
});

test('编号：#1 永远是最新那张；越界 / 别名 / 文件名都能定位；不存在返回 null', () => {
  withDir((dir) => {
    savePainting({ dir, buf: PNG, prompt: '第一张', now: new Date(2026, 10, 14, 1, 0, 0) });
    savePainting({ dir, buf: PNG, prompt: '第二张', now: new Date(2026, 10, 14, 2, 0, 0) });
    assert.equal(resolveRef({ dir, ref: '#1' }).prompt, '第二张');
    assert.equal(resolveRef({ dir, ref: '2' }).prompt, '第一张');
    assert.equal(resolveRef({ dir, ref: '最新' }).prompt, '第二张');
    assert.equal(resolveRef({ dir, ref: '第二张' }), null, '别名只认固定说法，不拿提示词猜');
    const byName = resolveRef({ dir, ref: resolveRef({ dir, ref: '#1' }).file });
    assert.equal(byName.prompt, '第二张');
    assert.ok(byName.path.startsWith(dir), '路径必须落在传进来的目录里');
    assert.equal(resolveRef({ dir, ref: '#9' }), null);
    assert.equal(resolveRef({ dir, ref: '../x.png' }), null);
    assert.equal(resolveRef({ dir, ref: '' }), null);
    assert.equal(pathOf(dir, '../x.png'), '');
  });
});

test('删除：只删自己目录里的那一张', () => {
  withDir((dir) => {
    const keep = savePainting({ dir, buf: PNG, prompt: '留', now: new Date(2026, 10, 14, 1, 0, 0) });
    const drop = savePainting({ dir, buf: PNG, prompt: '删', now: new Date(2026, 10, 14, 2, 0, 0) });
    assert.equal(removePainting(dir, '../x.png').ok, false);
    assert.equal(removePainting(dir, drop).ok, true);
    assert.ok(existsSync(join(dir, keep)));
    assert.equal(removePainting(dir, drop).ok, false, '删第二次要如实说不在了');
  });
});

test('字节数人话写法', () => {
  assert.equal(bytesText(999), '999B');
  assert.equal(bytesText(2048), '2KB');
  assert.equal(bytesText(1932735), '1.8MB');
});

#!/usr/bin/env node
/**
 * 当日配额账本
 * ============
 *
 *   node test/state.mjs
 *
 * 这是唯一一个「坏了会花钱」的文件，所以边界都写死在这里：
 * 到上限必须拦住、失败必须能退、跨天必须归零（而且不能因为时区算成昨天）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { countToday, dayOf, refund, spend } from '../lib/state.mjs';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'imagegen-state-'));
  try {
    return fn(dir);
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch { /* 系统回收 */ }
  }
}

const day1 = new Date(2026, 10, 14, 23, 59, 0);
const day2 = new Date(2026, 10, 15, 0, 1, 0);

test('dayOf：本地日期（不能是 UTC，否则凌晨会记成昨天）', () => {
  assert.equal(dayOf(new Date(2026, 0, 2, 0, 30)), '2026-01-02');
  assert.equal(dayOf(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
});

test('spend：先扣后画，到上限就拒绝', () => {
  withDir((dir) => {
    assert.equal(countToday(dir, day1), 0);
    const a = spend(dir, { limit: 2, now: day1 });
    assert.deepEqual([a.ok, a.count, a.left], [true, 1, 1]);
    assert.equal(spend(dir, { limit: 2, now: day1 }).left, 0);
    const c = spend(dir, { limit: 2, now: day1 });
    assert.equal(c.ok, false);
    assert.equal(c.count, 2);
    assert.equal(countToday(dir, day1), 2, '被拒绝的那次不该把计数加上去');
  });
});

test('spend：limit=0 表示不限，但仍记账（面板要显示今天画了几张）', () => {
  withDir((dir) => {
    const r = spend(dir, { limit: 0, now: day1 });
    assert.equal(r.ok, true);
    assert.equal(r.left, -1);
    assert.equal(countToday(dir, day1), 1);
  });
});

test('refund：画失败退一个；退到 0 就不再往下减', () => {
  withDir((dir) => {
    spend(dir, { limit: 5, now: day1 });
    refund(dir, { now: day1 });
    assert.equal(countToday(dir, day1), 0);
    refund(dir, { now: day1 });
    assert.equal(countToday(dir, day1), 0);
  });
});

test('跨天：昨天画满了，今天照样能画', () => {
  withDir((dir) => {
    spend(dir, { limit: 1, now: day1 });
    assert.equal(spend(dir, { limit: 1, now: day1 }).ok, false);
    assert.equal(countToday(dir, day2), 0);
    assert.equal(spend(dir, { limit: 1, now: day2 }).ok, true);
  });
});

test('账本坏了（不是 JSON）：当成 0，不拦人', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'state.json'), '{坏');
    assert.equal(countToday(dir, day1), 0);
    assert.equal(spend(dir, { limit: 1, now: day1 }).ok, true);
  });
});

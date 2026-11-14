/**
 * 「ta 刷过什么」的账本。
 *
 * 面板那一块要能看到「几点、看了哪个视频、她自己说了什么」，所以记录必须
 * 一条一条留、并且跨进程可读（定时刷在 MCP 子进程写，面板在宿主进程读）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHistory, KEEP } from '../lib/history.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'bili-history-'));

test('记一条就能读回来，字段齐全', () => {
  const dir = tmp();
  try {
    const h = createHistory({ dir });
    const items = h.add({ at: 1000, kind: 'watch', bvid: 'BV1xx411c7mD', title: '标题', text: '感想' });
    assert.equal(items.length, 1);
    assert.deepEqual(items[0], {
      at: 1000, kind: 'watch', bvid: 'BV1xx411c7mD', title: '标题', text: '感想', acts: [],
    });
    assert.deepEqual(h.read(), items, '读盘结果要和写入返回一致');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('新的排在最前', () => {
  const dir = tmp();
  try {
    const h = createHistory({ dir });
    h.add({ at: 1000, bvid: 'BV1aaaaaaaaa', title: '旧的' });
    h.add({ at: 2000, bvid: 'BV1bbbbbbbbb', title: '新的' });
    assert.deepEqual(h.read().map((x) => x.title), ['新的', '旧的']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同一天同一条视频只留一条，内容取最新那次', () => {
  const dir = tmp();
  try {
    const h = createHistory({ dir });
    const now = Date.now();
    h.add({ at: now, bvid: 'BV1xx411c7mD', title: '标题', text: '第一遍的感想' });
    h.add({ at: now + 60_000, bvid: 'BV1xx411c7mD', title: '标题', text: '第二遍的感想' });
    const items = h.read();
    assert.equal(items.length, 1, '刷两遍不该变成两条');
    assert.equal(items[0].text, '第二遍的感想');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同一批里重复的 BV 也只留一条', () => {
  const dir = tmp();
  try {
    const h = createHistory({ dir });
    const now = Date.now();
    const items = h.add([
      { at: now, bvid: 'BV1xx411c7mD', text: 'a' },
      { at: now, bvid: 'BV1xx411c7mD', text: 'b' },
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0].text, 'b');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('没有 BV 也没有文字的空记录不写', () => {
  const dir = tmp();
  try {
    const h = createHistory({ dir });
    assert.deepEqual(h.add({ at: Date.now(), text: '   ' }), []);
    assert.equal(h.add([null, 42, 'x']).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('未知 kind 归成 watch，acts 里过滤掉非法值', () => {
  const dir = tmp();
  try {
    const h = createHistory({ dir });
    const [it] = h.add({
      at: Date.now(), bvid: 'BV1xx411c7mD', kind: '瞎写', text: 't',
      acts: ['comment', 'garbage', 'share'],
    });
    assert.equal(it.kind, 'watch');
    assert.deepEqual(it.acts, ['comment', 'share']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('只留最近 N 条，不会无限长', () => {
  const dir = tmp();
  try {
    const h = createHistory({ dir, keep: 12 });
    const now = Date.now();
    for (let i = 0; i < 30; i += 1) {
      h.add({ at: now + i * 1000, bvid: `BV1${String(i).padStart(9, '0')}`, title: `v${i}` });
    }
    const items = h.read();
    assert.equal(items.length, 12);
    assert.equal(items[0].title, 'v29', '最新的留着');
    assert.equal(items.some((x) => x.title === 'v0'), false, '最旧的被挤掉');
    assert.ok(h.keep <= KEEP);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('文件坏了当空表，之后还能继续写', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'history.json'), '{ 不是 JSON', 'utf8');
    const h = createHistory({ dir });
    assert.deepEqual(h.read(), []);
    assert.equal(h.add({ at: Date.now(), bvid: 'BV1xx411c7mD', text: '还行' }).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('新进程直接读到别的进程写的（定时刷 → 面板）', () => {
  const dir = tmp();
  try {
    createHistory({ dir }).add({ at: Date.now(), bvid: 'BV1xx411c7mD', title: '跨进程', text: '嗯' });
    const panel = createHistory({ dir });
    assert.equal(panel.read()[0].title, '跨进程');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

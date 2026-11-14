/**
 * 「已经回过的评论」名单。
 *
 * 不记下来的后果很具体：B 站把同一条回复一直留在消息列表里，她每轮都会
 * 看到同一句「有人回了你」，于是同一句话被回十遍。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRepliedStore } from '../lib/replied.mjs';

test('记一条就能查到，重复记返回 false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-replied-'));
  try {
    const s = createRepliedStore({ dir });
    assert.equal(s.has('123'), false);
    assert.equal(s.add('123'), true);
    assert.equal(s.has('123'), true);
    assert.equal(s.add('123'), false, '同一条不该记两次');
    assert.deepEqual(s.all(), ['123']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('新进程从磁盘恢复：重启后不会把回过的又回一遍', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-replied-'));
  try {
    createRepliedStore({ dir }).add('456');
    const again = createRepliedStore({ dir });
    assert.equal(again.has('456'), true, '必须持久化，否则重启就忘了');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('空 id / 空白不记', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-replied-'));
  try {
    const s = createRepliedStore({ dir });
    assert.equal(s.add(''), false);
    assert.equal(s.add('   '), false);
    assert.equal(s.has(''), false);
    assert.deepEqual(s.all(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('文件坏了当空表，不抛异常', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-replied-'));
  try {
    writeFileSync(join(dir, 'replied.json'), '{ 不是 JSON', 'utf8');
    const s = createRepliedStore({ dir });
    assert.deepEqual(s.all(), []);
    assert.equal(s.add('789'), true, '坏文件之后还能继续记');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('只留最近 N 条，不会无限长', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-replied-'));
  try {
    const s = createRepliedStore({ dir, limit: 20 });
    for (let i = 0; i < 30; i += 1) s.add(String(i));
    const all = s.all();
    assert.equal(all.length, 20);
    assert.equal(s.has('29'), true, '最新的留着');
    assert.equal(s.has('0'), false, '最旧的被挤掉');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

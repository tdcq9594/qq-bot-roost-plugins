// 「已经看过什么」的账本：落盘跨实例、上限、坏文件、下一轮关键词。
//
// 2026-11-14 对齐 aurabot `duty.js` 的 `s.seen = [...seen].slice(-500)`：
// 以前 feed 只有内存 recently，进程内动作每点一次按钮都新建实例，
// 于是「连刷几轮换一批」在同一个实例里才成立，重启/换实例就归零。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSeenStore, parseKeywords, SEEN_FILE } from '../lib/seen.mjs';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bili-seen-'));
  try { return fn(dir); }
  finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 系统回收 */ } }
}

const V = (i) => ({ bvid: `BV${String(i).padStart(3, '0')}`, title: `视频 ${i}` });

test('parseKeywords：去重、去空、限长、最多 3 个', () => {
  assert.deepEqual(parseKeywords([' 折纸 ', '观鸟', '折纸', '', null, 42]), ['折纸', '观鸟', '42']);
  assert.deepEqual(parseKeywords('折纸'.repeat(30)), [], '整句话不能拿去搜');
  assert.deepEqual(parseKeywords(null), []);
  assert.deepEqual(parseKeywords(['a', 'b', 'c', 'd']), ['a', 'b', 'c']);
});

test('不传 dir = 纯内存；两个实例之间不共享（测试与无盘环境用）', () => {
  const a = createSeenStore();
  a.add([V(1), V(2)]);
  assert.equal(a.size(), 2);
  assert.equal(a.has('BV001'), true);
  assert.equal(createSeenStore().size(), 0, '内存模式不该跨实例');
});

test('落盘跨实例：新实例读得到上一个实例看过的 BV', () => withDir((dir) => {
  createSeenStore({ dir }).add([V(1), V(2)]);
  const b = createSeenStore({ dir });
  assert.equal(b.size(), 2);
  assert.equal(b.has('BV001'), true);
  assert.equal(b.has('BV999'), false);
  assert.deepEqual(b.recentTitles(2), ['视频 2', '视频 1'], '最新看的排最前');
}));

test('重复 BV 不产生两条；新看的排到最前', () => withDir((dir) => {
  const s = createSeenStore({ dir });
  s.add([V(1), V(2)]);
  s.add([V(1), V(3)]);
  assert.equal(s.size(), 3);
  assert.deepEqual(s.state().seen.map((x) => x.bvid), ['BV003', 'BV001', 'BV002']);
}));

test('最多留 500 条，丢最久没看的', () => withDir((dir) => {
  const s = createSeenStore({ dir });
  s.add(Array.from({ length: 520 }, (_, i) => V(i)));
  assert.equal(s.size(), 500);
  assert.equal(s.has('BV000'), false, '最早那 20 条被挤掉');
  assert.equal(s.has('BV519'), true);
}));

test('文件写坏了当空表，不让这一轮刷不下去', () => withDir((dir) => {
  writeFileSync(join(dir, SEEN_FILE), '{坏掉的 json', 'utf8');
  const s = createSeenStore({ dir });
  assert.equal(s.size(), 0);
  assert.deepEqual(s.nextKeywords(), []);
  s.add([V(1)]);
  assert.equal(s.size(), 1, '下次写盘能自愈');
}));

test('nextKeywords 落盘，两个实例之间传得过去', () => withDir((dir) => {
  createSeenStore({ dir }).setNextKeywords(['折纸', '观鸟']);
  assert.deepEqual(createSeenStore({ dir }).nextKeywords(), ['折纸', '观鸟']);
  createSeenStore({ dir }).setNextKeywords([]);
  assert.deepEqual(createSeenStore({ dir }).nextKeywords(), []);
}));

test('写盘是原子替换，不会留下半截 JSON', () => withDir((dir) => {
  const s = createSeenStore({ dir });
  s.add([V(1)]);
  const raw = readFileSync(join(dir, SEEN_FILE), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
  assert.equal(JSON.parse(raw).seen.length, 1);
}));

test('索引哈希必须跳过 seen.json：用户端跑起来才算得出同一个 sha256', async () => {
  const src = await readFile(new URL('../../../scripts/hashdir.mjs', import.meta.url), 'utf8');
  assert.match(src, /'seen\.json'/, '漏了这条，装了扩展的用户目录哈希会和签名索引对不上');
  assert.match(src, /'history\.json'/, '同类的刷过什么账本一并跳过');
});

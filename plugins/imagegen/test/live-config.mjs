#!/usr/bin/env node
/**
 * 配置热读：面板保存设置后，MCP 子进程不重启也能拿到新值
 *
 *   node test/live-config.mjs
 *
 * 真在临时目录里造宿主那两份文件，用 utimesSync 强制改 mtime，
 * 因为同一毫秒内连续写两次 mtime 可能相等，会把「变了」测成「没变」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLiveConfig } from '../lib/live-config.mjs';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'imagegen-live-'));
  const ext = join(root, 'extensions', 'imagegen');
  const sec = join(root, 'secrets');
  mkdirSync(ext, { recursive: true });
  mkdirSync(sec, { recursive: true });
  return {
    root,
    cfgFile: join(ext, 'config.json'),
    secFile: join(sec, 'imagegen.config.json'),
    dispose() {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch { /* 系统回收 */ }
    },
  };
}

/** 强制把 mtime 拨到一个新的秒，保证「变了」一定被看见 */
let tick = 1700000000;
function touch(file, text) {
  writeFileSync(file, text, 'utf8');
  tick += 2;
  utimesSync(file, new Date(tick * 1000), new Date(tick * 1000));
}

test('首次读到两份文件 → apply；mtime 没变就别重复回调', () => {
  const s = sandbox();
  try {
    touch(s.cfgFile, JSON.stringify({ model: 'm1', dailyLimit: 20 }));
    touch(s.secFile, JSON.stringify({ apiKey: 'sk-1' }));
    const seen = [];
    const refresh = createLiveConfig({
      dataDir: s.root, id: 'imagegen',
      apply: (values, secrets) => seen.push({ values, secrets }),
    });
    assert.equal(refresh(), true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].values.model, 'm1');
    assert.equal(seen[0].secrets.apiKey, 'sk-1');
    assert.equal(refresh(), false, '没变就不该再解析');
    assert.equal(seen.length, 1);
  } finally { s.dispose(); }
});

test('只改非敏感配置：apply 收到新 values，secrets 为 null', () => {
  const s = sandbox();
  try {
    touch(s.cfgFile, JSON.stringify({ model: 'm1' }));
    touch(s.secFile, JSON.stringify({ apiKey: 'sk-1' }));
    const seen = [];
    const refresh = createLiveConfig({ dataDir: s.root, id: 'imagegen', apply: (v, sec) => seen.push({ v, sec }) });
    refresh();
    touch(s.cfgFile, JSON.stringify({ model: 'm2', fallbackEnabled: false }));
    assert.equal(refresh(), true);
    assert.equal(seen.length, 2);
    assert.equal(seen[1].v.model, 'm2');
    assert.equal(seen[1].v.fallbackEnabled, false);
    assert.equal(seen[1].sec, null, '没变的 secret 不该被当成新值覆盖');
  } finally { s.dispose(); }
});

test('密钥清空 / 包了一层的 values / 坏 JSON：都不抛，坏数据保留旧值', () => {
  const s = sandbox();
  try {
    touch(s.cfgFile, JSON.stringify({ model: 'm1' }));
    touch(s.secFile, JSON.stringify({ apiKey: 'sk-1' }));
    const seen = [];
    const refresh = createLiveConfig({ dataDir: s.root, id: 'imagegen', apply: (v, sec) => seen.push({ v, sec }) });
    refresh();

    touch(s.secFile, JSON.stringify({}));
    assert.equal(refresh(), true, '清空密钥也必须回调（server 侧靠 hasOwnProperty 判断）');
    assert.deepEqual(seen[1].sec, {});

    touch(s.cfgFile, JSON.stringify({ values: { model: 'm3' } }));
    assert.equal(refresh(), true);
    assert.equal(seen[2].v.model, 'm3', '容忍 {values:{...}} 包一层的写法');

    touch(s.cfgFile, '{半截文件');
    assert.equal(refresh(), false, '坏 JSON 不算变化，保留旧值');
    assert.equal(seen.length, 3);
  } finally { s.dispose(); }
});

test('缺 dataDir / id：refresh 恒 false，不抛也不读盘', () => {
  assert.equal(createLiveConfig({ id: 'imagegen', apply: () => {} })(), false);
  assert.equal(createLiveConfig({ dataDir: '/tmp', apply: () => {} })(), false);
  assert.equal(createLiveConfig({ dataDir: '/tmp', id: 'imagegen' })(), false);
});

test('apply 自己抛错：refresh 返回 false，不让动作失败', () => {
  const s = sandbox();
  try {
    touch(s.cfgFile, JSON.stringify({ model: 'm1' }));
    const refresh = createLiveConfig({ dataDir: s.root, id: 'imagegen', apply: () => { throw new Error('boom'); } });
    assert.equal(refresh(), false);
    assert.equal(refresh(), false, '回调失败后 mtime 已记，不该反复重试同一个坏值');
  } finally { s.dispose(); }
});

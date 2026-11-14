/**
 * 配置热读：面板保存后，扩展不用重启就能拿到新值。
 *
 * 这条是「设置项没延迟」的关键——宿主那边 `mcpManager.restart()` 对
 * 受管块里的静态条目基本无效，只能靠扩展自己读回来。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLiveConfig } from '../lib/live-config.mjs';

function sandbox(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bili-live-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const ID = 'demo';
const cfgPath = (dir) => join(dir, 'extensions', ID, 'config.json');
const secPath = (dir) => join(dir, 'secrets', `${ID}.config.json`);

function writeCfg(dir, values) {
  mkdirSync(join(dir, 'extensions', ID), { recursive: true });
  writeFileSync(cfgPath(dir), JSON.stringify(values), 'utf8');
}

function writeSecret(dir, secrets) {
  mkdirSync(join(dir, 'secrets'), { recursive: true });
  writeFileSync(secPath(dir), JSON.stringify(secrets), 'utf8');
}

test('读到 config.json 并回调一次；没变化不再回调', sandbox(async (dir) => {
  writeCfg(dir, { feedIntervalMin: 30, enabled: true });
  const seen = [];
  const refresh = createLiveConfig({ dataDir: dir, id: ID, apply: (v, s) => seen.push([v, s]) });

  assert.equal(refresh(), true);
  assert.deepEqual(seen[0][0], { feedIntervalMin: 30, enabled: true });

  /** mtime 没变：不该重复解析，更不该重复回调 */
  assert.equal(refresh(), false);
  assert.equal(seen.length, 1);
}));

test('文件改了会再回调，拿到的是新值', sandbox(async (dir) => {
  writeCfg(dir, { feedIntervalMin: 30 });
  let last = null;
  const refresh = createLiveConfig({ dataDir: dir, id: ID, apply: (v) => { last = v; } });
  refresh();
  assert.equal(last.feedIntervalMin, 30);

  /** 同长度不同内容也要能识别（按 mtime 判，不按大小） */
  writeCfg(dir, { feedIntervalMin: 60 });
  assert.equal(refresh(), true);
  assert.equal(last.feedIntervalMin, 60);
}));

test('secret 单独更新也能带出来（清空要能生效）', sandbox(async (dir) => {
  writeCfg(dir, { enabled: true });
  writeSecret(dir, { cookie: 'SESSDATA=abc' });
  const seen = [];
  const refresh = createLiveConfig({ dataDir: dir, id: ID, apply: (v, s) => seen.push([v, s]) });
  refresh();
  assert.equal(seen.at(-1)[1].cookie, 'SESSDATA=abc');

  writeSecret(dir, { cookie: '' });
  assert.equal(refresh(), true);
  assert.equal(seen.at(-1)[1].cookie, '', '清空 Cookie 必须传空串，不能当作「没变」');
}));

test('文件不存在 / 是坏 JSON：静默返回 false，不抛', sandbox(async (dir) => {
  const refresh = createLiveConfig({ dataDir: dir, id: ID, apply: () => { throw new Error('不该被调用'); } });
  assert.equal(refresh(), false);

  mkdirSync(join(dir, 'extensions', ID), { recursive: true });
  writeFileSync(cfgPath(dir), '{ 半截', 'utf8');
  assert.equal(refresh(), false, '解析失败要吞掉，保留旧配置继续跑');
}));

test('apply 抛错也不让 refresh 抛：动作不能因为读配置崩掉', sandbox(async (dir) => {
  writeCfg(dir, { a: 1 });
  const refresh = createLiveConfig({ dataDir: dir, id: ID, apply: () => { throw new Error('boom'); } });
  assert.equal(refresh(), false);
}));

test('缺 dataDir / id 时退化成空操作', () => {
  assert.equal(createLiveConfig({ id: 'x', apply: () => {} })(), false);
  assert.equal(createLiveConfig({ dataDir: '/tmp', apply: () => {} })(), false);
  assert.equal(createLiveConfig({ dataDir: '/tmp', id: 'x' })(), false);
});

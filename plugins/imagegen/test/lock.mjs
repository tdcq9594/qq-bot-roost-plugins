#!/usr/bin/env node
/**
 * 跨进程锁：真 spawn 多个 Node 进程抢同一份账本 / 面板数据
 *
 *   node test/lock.mjs
 *
 * 为什么必须真起进程：0.1 只有 MCP 子进程一个写者，Node 单线程里同步的
 * 「读-改-写」天然不交错，单测怎么并发都看不出问题。0.2 多了宿主进程内的
 * 面板动作，对抗测试实测 3 进程 barrier、limit=1 时 12/12 轮三个都拿到名额
 * ——按张收钱的服务被画了三张。这个测试就是那条复现的钉子。
 *
 * worker 脚本写在系统临时目录，跑完连目录一起删，不碰插件目录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { countToday, spend } from '../lib/state.mjs';
import { createUiData } from '../lib/ui-data.mjs';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const STATE_URL = pathToFileURL(join(HERE, 'lib', 'state.mjs')).href;
const UI_URL = pathToFileURL(join(HERE, 'lib', 'ui-data.mjs')).href;
const WAIT = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'imagegen-lock-'));
  return {
    dir,
    dispose() {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }); } catch { /* 系统回收 */ }
    },
  };
}

function run(workerFile, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [workerFile, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.setEncoding('utf8');
    c.stderr.setEncoding('utf8');
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', reject);
    c.on('close', (code) => resolve({ code, out: out.trim(), err }));
  });
}

/** 三个进程都卡在 go 文件上，主进程一声令下同时抢锁，比 sleep 猜时序稳 */
async function barrier(workerFile, dir, argSets) {
  const go = join(dir, 'go');
  const kids = argSets.map((args) => run(workerFile, [dir, go, ...args]));
  await new Promise((r) => setTimeout(r, 150));
  writeFileSync(go, 'go');
  return Promise.all(kids);
}

const stateWorker = [
  "import { existsSync } from 'node:fs';",
  'import { spend } from ' + JSON.stringify(STATE_URL) + ';',
  'const [dir, go, limitRaw, timesRaw] = process.argv.slice(2);',
  'const limit = Number(limitRaw || 1), times = Number(timesRaw || 1);',
  'while (!existsSync(go)) { ' + WAIT + '; }',
  'let ok = 0;',
  'for (let i = 0; i < times; i++) { if (spend(dir, { limit }).ok) ok += 1; }',
  'process.stdout.write(String(ok));',
].join('\n');

const uiWorker = [
  "import { existsSync } from 'node:fs';",
  'import { createUiData } from ' + JSON.stringify(UI_URL) + ';',
  'const [dir, go, key] = process.argv.slice(2);',
  'while (!existsSync(go)) { ' + WAIT + '; }',
  'const ui = createUiData({ dir });',
  'for (let i = 0; i < 40; i++) ui.setMeta({ [key]: i });',
  "process.stdout.write('done');",
].join('\n');

test('3 进程同时 spend(limit=1)：只能有一个拿到名额（跑 3 轮）', async () => {
  for (let round = 1; round <= 3; round += 1) {
    const s = sandbox();
    try {
      writeFileSync(join(s.dir, 'state-worker.mjs'), stateWorker, 'utf8');
      const res = await barrier(join(s.dir, 'state-worker.mjs'), s.dir, [['1', '1'], ['1', '1'], ['1', '1']]);
      assert.ok(res.every((r) => r.code === 0 && !r.err), `第 ${round} 轮有 worker 崩了：${res.map((r) => r.err).join('|')}`);
      const total = res.reduce((n, r) => n + Number(r.out || 0), 0);
      assert.equal(total, 1, `第 ${round} 轮拿到名额的进程数应恰好 1，实际 ${total}（${res.map((r) => r.out).join(',')}）`);
      assert.equal(countToday(s.dir), 1);
    } finally { s.dispose(); }
  }
});

test('3 进程各 spend 5 次（不限量）：一次更新都不能丢', async () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.dir, 'state-worker.mjs'), stateWorker, 'utf8');
    const res = await barrier(join(s.dir, 'state-worker.mjs'), s.dir, [['0', '5'], ['0', '5'], ['0', '5']]);
    assert.ok(res.every((r) => r.code === 0 && !r.err));
    assert.equal(countToday(s.dir), 15, '读-改-写没加锁时会少算，这正是双花的根因');
  } finally { s.dispose(); }
});

test('3 进程交叉 setMeta 各 40 次：最终 JSON 合法且三份状态都在', async () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.dir, 'ui-worker.mjs'), uiWorker, 'utf8');
    const res = await barrier(join(s.dir, 'ui-worker.mjs'), s.dir, [['a'], ['b'], ['c']]);
    assert.ok(res.every((r) => r.code === 0 && !r.err), `worker 崩了：${res.map((r) => r.err).join('|')}`);
    const ui = createUiData({ dir: s.dir });
    const meta = ui.read().meta;
    for (const k of ['a', 'b', 'c']) assert.ok(Object.hasOwn(meta, k), `另一个进程写的 ${k} 被抹掉了`);
    const leftovers = readdirSync(s.dir).filter((f) => f.includes('.tmp') || f.endsWith('.lock'));
    assert.deepEqual(leftovers, [], '不该留下临时文件或锁文件');
  } finally { s.dispose(); }
});

test('陈旧锁 + 3 进程并发：owner token 校验要挡住「误删新锁」导致的双花（20 轮）', async () => {
  /**
   * 第二轮对抗测试的 B2：多个进程同时判「这把锁够旧」并 unlink，
   * 其中一个会把另一个刚 open 成功的**新锁**删掉，于是两个进程同时进临界区
   * （旧实现实测 100 轮里 5–7 轮双花）。修复靠 open 后写 token + 退避读回校验。
   */
  for (let round = 1; round <= 20; round += 1) {
    const s = sandbox();
    try {
      const workerFile = join(s.dir, 'state-worker.mjs');
      writeFileSync(workerFile, stateWorker, 'utf8');
      const stale = join(s.dir, 'state.json.lock');
      writeFileSync(stale, 'stale-from-dead-process', 'utf8');
      utimesSync(stale, new Date(0), new Date(0));
      const res = await barrier(workerFile, s.dir, [['1', '1'], ['1', '1'], ['1', '1']]);
      assert.ok(res.every((r) => r.code === 0 && !r.err), `第 ${round} 轮 worker 崩了：${res.map((r) => r.err).join('|')}`);
      const total = res.reduce((n, r) => n + Number(r.out || 0), 0);
      assert.equal(total, 1, `第 ${round} 轮陈旧锁竞态下拿到名额的进程数应恰好 1，实际 ${total}`);
    } finally { s.dispose(); }
  }
});

test('陈旧锁（被强杀的进程留下的）能自动清掉，不把账本卡死', () => {
  const s = sandbox();
  try {
    const lock = join(s.dir, 'state.json.lock');
    writeFileSync(lock, 'stale', 'utf8');
    utimesSync(lock, new Date(0), new Date(0));
    const r = spend(s.dir, { limit: 1 });
    assert.equal(r.ok, true);
    assert.ok(!existsSync(lock), '锁要用完即删');
    assert.equal(countToday(s.dir), 1);
  } finally { s.dispose(); }
});

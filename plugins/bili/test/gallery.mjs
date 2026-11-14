/**
 * 截图库 + 今日计数 + 自动抽帧。
 *
 * 这三块都是「面板上的数字」，错了不会报错、只会显示得不对，所以每条都要有
 * 明确的断言：文件名的过滤规则、跨天清零、没 ffmpeg 时不白跑接口。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { countShots, listShots, writeIndex } from '../lib/gallery.mjs';
import { bumpStats, emptyStats, readStats } from '../lib/stats.mjs';
import { createAutoShot } from '../lib/auto-shot.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'bili-gal-'));
}

test('图库只认 BV号-秒数.jpg，别的文件不算', () => {
  const dir = tmp();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'BV1xx411c7mD-30.jpg'), Buffer.alloc(600));
    writeFileSync(join(dir, 'BV1xx411c7mD-45.jpg'), Buffer.alloc(600));
    writeFileSync(join(dir, 'index.json'), '{}');
    writeFileSync(join(dir, '随手放的.jpg'), Buffer.alloc(600));
    /** 太小的文件多半是写盘失败留下的半截图，不该显示 */
    writeFileSync(join(dir, 'BV1yy411c7mD-10.jpg'), Buffer.alloc(10));

    assert.equal(countShots({ dir }), 2);
    const { items, total } = listShots({ dir });
    assert.equal(total, 2);
    assert.equal(items.length, 2);
    assert.ok(items.every((it) => it.file.startsWith('shots/')), '路径要相对扩展目录，页面才拼得出来');
    assert.ok(items.every((it) => it.bytes >= 500));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('目录不存在时返回空，不抛', () => {
  assert.doesNotThrow(() => listShots({ dir: join(tmpdir(), 'definitely-not-here-xyz') }));
  assert.equal(countShots({ dir: '' }), 0);
});

test('writeIndex 写出可读的清单，先写 tmp 再改名', () => {
  const dir = tmp();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'BV1xx411c7mD-30.jpg'), Buffer.alloc(600));
    assert.equal(writeIndex({ dir }), true);
    const j = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    assert.equal(j.total, 1);
    assert.equal(j.items[0].bvid, 'BV1xx411c7mD');
    assert.equal(j.items[0].at, 30);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('今日计数：跨天自动清零，未知字段不写进去', () => {
  const dir = tmp();
  const file = join(dir, 'ui-data.json');
  let saved = null;
  const ui = { file: () => file, setMeta: (m) => { saved = m.stats; } };
  try {
    const s1 = bumpStats(ui, { rounds: 1, shots: 2, 乱写的字段: 9 });
    assert.equal(s1.rounds, 1);
    assert.equal(s1.shots, 2);
    assert.equal('乱写的字段' in s1, false);

    /** 昨天的数据：读出来要当全新的一天 */
    writeFileSync(file, JSON.stringify({ rows: [], meta: { stats: { day: '2020-01-01', rounds: 99 } } }));
    const s2 = readStats(file);
    assert.equal(s2.rounds, 0, '跨天必须清零');
    assert.equal(s2.day, emptyStats().day);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自动抽帧：开关关着直接跳过，连接口都不发', async () => {
  let called = 0;
  const autoShot = createAutoShot({
    api: { view: async () => { called += 1; return { bvid: 'BV1xx411c7mD', cid: 1, duration: 30 }; } },
    shots: { dir: '/x', take: async () => ({ path: 'p' }), ffmpegStatus: () => ({ ready: true }) },
    ui: { setMeta: () => {}, file: () => '/tmp/none' },
    config: { autoShot: false },
  });
  assert.equal(await autoShot([{ bvid: 'BV1xx411c7mD' }]), 0);
  assert.equal(called, 0);
});

test('自动抽帧：没 ffmpeg 时不白跑接口', async () => {
  let called = 0;
  const autoShot = createAutoShot({
    api: { view: async () => { called += 1; return {}; } },
    shots: { dir: '/x', take: async () => ({ path: 'p' }), ffmpegStatus: () => ({ ready: false }) },
    ui: { setMeta: () => {}, file: () => '/tmp/none' },
    config: { autoShot: true, autoShotCount: 2 },
  });
  assert.equal(await autoShot([{ bvid: 'BV1xx411c7mD' }]), 0);
  assert.equal(called, 0, '没 ffmpeg 时不该先花一次 view 请求');
});

test('自动抽帧：单个视频失败不影响其它，返回成功张数', async () => {
  const dir = tmp();
  const file = join(dir, 'ui-data.json');
  const taken = [];
  const autoShot = createAutoShot({
    api: {
      view: async ({ bvid }) => {
        if (bvid === 'BV1xx411c7mE') throw new Error('拿不到 cid');
        return { bvid, cid: 1, duration: 90 };
      },
    },
    shots: {
      dir,
      take: async ({ info, at }) => { taken.push([info.bvid, at]); return { path: 'p' }; },
      ffmpegStatus: () => ({ ready: true }),
    },
    /**
     * 模拟真实的 `ui.setMeta`：**读磁盘再合并**。
     * 写死成覆盖会让「抽帧前记了 shots、抽帧后又记 gallery」把前一次冲掉，
     * 测试就会误报（真实现是合并，不会丢）。
     */
    ui: {
      file: () => file,
      setMeta: (m) => {
        let cur = {};
        try { cur = JSON.parse(readFileSync(file, 'utf8')).meta || {}; } catch { /* 首次 */ }
        writeFileSync(file, JSON.stringify({ rows: [], meta: { ...cur, ...m } }));
      },
    },
    config: { autoShot: true, autoShotCount: 3, shotKeep: 60 },
  });
  const n = await autoShot([
    { bvid: 'BV1xx411c7mD' },
    { bvid: 'BV1xx411c7mE' },
    { bvid: 'BV1xx411c7mF' },
  ]);
  assert.equal(n, 2, '失败那个要跳过');
  assert.deepEqual(taken.map((t) => t[0]), ['BV1xx411c7mD', 'BV1xx411c7mF']);
  /** 取 1/3 处（90 → 30），避免开头黑帧 */
  assert.equal(taken[0][1], 30);
  /** 抽帧自己只加 `shots`；`rounds` 由刷新的那一层加，两边各管各的 */
  assert.ok(readFileSync(file, 'utf8').includes('"shots"'), '顺带把「今天截了几张」写进面板数据');
  rmSync(dir, { recursive: true, force: true });
});

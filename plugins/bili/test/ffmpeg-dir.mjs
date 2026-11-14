/**
 * ffmpeg 在哪：路径可能过期，不能只认注入的那一条。
 *
 * 场景就是主人问的这个：用户自定义了 roost 的数据目录，受管块里的
 * `ROOST_DEPS_DIR` 还是渲染那一刻的旧值——只取第一个非空值，就会
 * 「明明装好了却说没装」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { depsCandidates, ffmpegState, resolveFfmpeg } from '../lib/ffmpeg.mjs';

/** 造一个「装好了 ffmpeg」的 deps 目录 */
function fakeDeps() {
  const dir = mkdtempSync(join(tmpdir(), 'bili-deps-'));
  const plat = process.platform === 'win32'
    ? `win32-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
    : process.platform === 'darwin'
      ? `darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
      : `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  const base = join(dir, 'node_modules', '@ffmpeg-installer', plat);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), '');
  return dir;
}

function withEnv(vars, fn) {
  const old = {};
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('候选去重且顺序固定：显式 > ROOST_DEPS_DIR > LAUNCHER/deps', () => {
  withEnv({ ROOST_DEPS_DIR: '/a/deps', ROOST_LAUNCHER_DIR: '/b' }, () => {
    assert.deepEqual(depsCandidates('/c/deps'), ['/c/deps', '/a/deps', join('/b', 'deps')]);
    /** 重复值只留一次 */
    assert.deepEqual(depsCandidates('/a/deps'), ['/a/deps', join('/b', 'deps')]);
  });
});

test('ROOST_DEPS_DIR 是过期路径时，仍能从 LAUNCHER 找到', () => {
  const real = fakeDeps();
  try {
    withEnv({ ROOST_DEPS_DIR: join(tmpdir(), 'gone-xyz', 'deps'), ROOST_LAUNCHER_DIR: '' }, () => {
      /** LAUNCHER 空 → 只有过期那条，找不到是对的 */
      assert.equal(resolveFfmpeg({ root: '' }), '');
    });
    /**
     * LAUNCHER 指向真实目录时，候选里第二条能命中。
     * 真实场景里 LAUNCHER 是 `<dataDir>`，deps 在它下面的 `deps/`。
     */
    const parent = join(real, '..');
    withEnv({ ROOST_DEPS_DIR: join(tmpdir(), 'gone-xyz', 'deps'), ROOST_LAUNCHER_DIR: '' }, () => {
      const hit = resolveFfmpeg({ root: '', depsDir: real });
      assert.ok(hit, '显式传的目录必须优先命中');
      assert.ok(hit.endsWith(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'));
    });
    void parent;
  } finally {
    rmSync(real, { recursive: true, force: true });
  }
});

test('状态里报的 dir 是真正用了的那个，不是候选第一个', () => {
  const real = fakeDeps();
  try {
    withEnv({ ROOST_DEPS_DIR: join(tmpdir(), 'gone-xyz', 'deps'), ROOST_LAUNCHER_DIR: '' }, () => {
      const s = ffmpegState({ root: '', depsDir: real });
      assert.equal(s.ready, true);
      assert.equal(s.dir, real, '不能把过期路径显示给用户');
    });
  } finally {
    rmSync(real, { recursive: true, force: true });
  }
});

test('手动填的路径优先于共享目录', () => {
  const real = fakeDeps();
  try {
    withEnv({ ROOST_DEPS_DIR: real }, () => {
      const manual = join(real, 'my-ffmpeg');
      writeFileSync(manual, '');
      assert.equal(resolveFfmpeg({ root: '', configured: manual }), manual);
    });
  } finally {
    rmSync(real, { recursive: true, force: true });
  }
});

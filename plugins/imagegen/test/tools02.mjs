#!/usr/bin/env node
/**
 * 0.2 新增的工具面：image_send / image_status / drawOnce 复用 / 画作保留上限
 *
 *   node test/tools02.mjs
 *
 * 全是假生图、临时目录，不联网、不花钱。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeConfig, drawOnce, markerOf, createToolbox } from '../lib/tools.mjs';
import { listPaintings } from '../lib/paint.mjs';
import { countToday } from '../lib/state.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 3)]);

const cfg0 = (over = {}) => ({
  provider: 'openai', baseUrl: 'https://api.test/v1', apiKey: 'sk', model: 'm1',
  shape: 'square', size: '', stylePrompt: '', img2img: true, dailyLimit: 0,
  fallbackEnabled: true, timeoutSec: 120, maxKeep: 0,
  custom: { url: '', method: 'POST', params: [], bodyType: 'json', responsePath: '' },
  fallbacks: [], ...over,
});

async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'imagegen-tools2-'));
  try { return await fn(dir); } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch { /* 系统回收 */ }
  }
}

function fakeGen() {
  const calls = [];
  const fn = async (args) => { calls.push(args); return { buf: PNG, via: '主接口', ms: 900 }; };
  return { fn, calls };
}

test('image_send：编号 → 可复制的标记串，路径来自画作库而不是入参', async () => {
  await withDir(async (dir) => {
    const g = fakeGen();
    const box = createToolbox({ cfg: cfg0(), dir, gen: g.fn });
    await box.call('image_gen', { prompt: '一只橘猫' });
    const text = await box.call('image_send', { file: '#1' });
    const marker = /<<image-alone: (.+?)>>/.exec(text)?.[1] ?? '';
    assert.ok(marker.startsWith(join(dir, 'out')), `标记里应该是真实绝对路径，实际 ${marker}`);
    assert.ok(existsSync(marker));
    assert.match(text, /原样/);
    assert.equal(g.calls.length, 1, 'image_send 不该再画一张');

    const inline = await box.call('image_send', { file: '最新', style: 'inline' });
    assert.match(inline, /<<image: /, 'inline 换成图文同条的标记');
    assert.doesNotMatch(inline, /<<image-alone/);
  });
});

test('image_send / markerOf：不存在的编号、任意路径都不认', async () => {
  await withDir(async (dir) => {
    const box = createToolbox({ cfg: cfg0(), dir, gen: fakeGen().fn });
    await assert.rejects(() => box.call('image_send', { file: '#9' }), /画作库里没有/);
    /** 扩展不该因为模型随手写的一个字符串就去读本机任意文件 */
    assert.throws(() => markerOf({ dir: join(dir, 'out'), ref: 'C:\\Windows\\win.ini' }), /画作库里没有/);
    await assert.rejects(() => box.call('image_send', { file: '../../secret.png' }), /画作库里没有/);
  });
});

test('image_status：不画图、不联网，说清配置 / 用量 / 缺项 / 备用链', async () => {
  await withDir(async (dir) => {
    const g = fakeGen();
    const box = createToolbox({
      cfg: cfg0({ dailyLimit: 10, fallbacks: [{ baseUrl: 'https://bak.test/v1', model: 'm2' }] }),
      dir, gen: g.fn,
    });
    const text = await box.call('image_status', {});
    assert.match(text, /OpenAI 兼容/);
    assert.match(text, /今天已画 0 张 \/ 上限 10 张/);
    assert.match(text, /备用 1 https:\/\/bak.test\/v1（m2）/);
    assert.match(text, /配置看起来能画/);
    assert.equal(g.calls.length, 0, '自检绝不能顺手画一张');

    const broken = createToolbox({ cfg: cfg0({ baseUrl: '' }), dir, gen: g.fn });
    assert.match(await broken.call('image_status', {}), /还画不了：还没填生图服务地址/);
    assert.equal(g.calls.length, 0);
  });
});

test('drawOnce：面板按钮与模型工具共用同一条链路（配额 / 落盘 / onPaint）', async () => {
  await withDir(async (dir) => {
    const g = fakeGen();
    const painted = [];
    const r = await drawOnce({
      cfg: cfg0({ dailyLimit: 3 }), dir, prompt: '面板测一张', gen: g.fn,
      onPaint: (items, opts) => painted.push({ items, opts }),
    });
    assert.ok(r.path && existsSync(r.path));
    assert.equal(r.via, '主接口');
    assert.equal(r.left, 2);
    assert.equal(countToday(join(dir, 'out')), 1, '面板测试也要占配额');
    assert.equal(painted.length, 1, '画完要回调刷新面板');
    assert.equal(painted[0].items.length, 1);
    assert.equal(painted[0].opts.result.via, '主接口');
    assert.equal(painted[0].opts.result.path, r.path);
    assert.equal(painted[0].opts.allowEmpty, true);
  });
});

test('maxKeep：只删自己按时间戳命名的图，手动放进去的不动', async () => {
  await withDir(async (dir) => {
    const box = createToolbox({ cfg: cfg0({ maxKeep: 2 }), dir, gen: fakeGen().fn });
    await box.call('image_gen', { prompt: '第一张' });
    await box.call('image_gen', { prompt: '第二张' });
    const manual = join(dir, 'out', '主人放的图.png');
    writeFileSync(manual, PNG);
    await box.call('image_gen', { prompt: '第三张' });
    assert.ok(existsSync(manual), '不是扩展生成的图不能被删');
    const { items, total } = listPaintings({ dir: join(dir, 'out'), limit: 50 });
    assert.equal(total, 3, '2 张自己的 + 1 张手动的');
    assert.equal(items.filter((it) => /^\d{8}-\d{6}-/.test(it.file)).length, 2, '自己的只留 2 张');
  });
});

test('describeConfig：0.2 的新开关都在摘要里', () => {
  const text = describeConfig(cfg0({ fallbackEnabled: false, timeoutSec: 60, maxKeep: 30, dailyLimit: 5 }));
  assert.match(text, /备用链已关/);
  assert.match(text, /超时 60 秒/);
  assert.match(text, /画作库保留 30 张/);
  assert.match(text, /每日上限 5 张/);
});

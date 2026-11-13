#!/usr/bin/env node
/**
 * 工具层：配额、参考图、结果文案（生图实现换成假的，不发请求）
 *
 *   node test/tools.mjs
 *
 * 这一层错了的表现都很「安静」：配额没扣 → 账单翻倍；参考图取错 → 发出别人那张；
 * 结果里没写 `<<image-alone: 路径>>` → 图根本没发出去，而工具还回了「画好了」。
 * 所以下面专挑这三件事断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PaintError } from '../lib/errors.mjs';
import { countToday } from '../lib/state.mjs';
import { createToolbox } from '../lib/tools.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 3)]);

const cfg0 = (over = {}) => ({
  provider: 'openai',
  baseUrl: 'https://api.test/v1',
  apiKey: 'sk',
  model: 'm1',
  shape: 'square',
  size: '',
  stylePrompt: '',
  img2img: true,
  dailyLimit: 0,
  custom: { url: '', method: 'POST', params: [], bodyType: 'json', responsePath: '' },
  fallbacks: [],
  ...over,
});

/** 临时目录 + 清理。**必须 await fn 再清理**：清理早于异步体跑完，断言就会看见空目录。 */
async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'imagegen-tools-'));
  try {
    return await fn(dir);
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch { /* 系统回收 */ }
  }
}

/** 假生图：记下调用参数，回一张 PNG */
function fakeGen() {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return { buf: PNG, via: '主接口', ms: 1234 };
  };
  return { fn, calls };
}

test('image_gen：存进 out/、结果里带绝对路径和发送标记', async () => {
  await withDir(async (dir) => {
    const g = fakeGen();
    const box = createToolbox({ cfg: cfg0(), dir, gen: g.fn });
    const text = await box.call('image_gen', { prompt: '一只橘猫' });
    const path = /<<image-alone: (.+?)>>/.exec(text)?.[1] ?? '';
    assert.ok(path.startsWith(join(dir, 'out')), `路径应该在扩展目录的 out/ 下，实际是 ${path}`);
    assert.ok(existsSync(path), '文件应该真的写下来了');
    assert.match(text, /^画好了：/);
    assert.match(text, /1024x1024/);
    assert.match(text, /1\.2 秒/);
    assert.match(text, /主接口/);
    assert.equal(g.calls[0].prompt, '一只橘猫');
    assert.equal(g.calls[0].cfg.size, '1024x1024');
  });
});

test('image_gen：固定风格拼在提示词前面（不是后面）', async () => {
  await withDir(async (dir) => {
    const g = fakeGen();
    const box = createToolbox({ cfg: cfg0({ stylePrompt: '厚涂' }), dir, gen: g.fn });
    await box.call('image_gen', { prompt: '猫', shape: 'portrait' });
    assert.equal(g.calls[0].prompt, '厚涂，猫');
    assert.equal(g.calls[0].cfg.size, '1024x1536');
  });
});

test('配额：到上限就不再画，且如实说是哪天的几张', async () => {
  await withDir(async (dir) => {
    const g = fakeGen();
    const box = createToolbox({ cfg: cfg0({ dailyLimit: 1 }), dir, gen: g.fn });
    const first = await box.call('image_gen', { prompt: '第一张' });
    assert.match(first, /今天还能画 0 张/);
    await assert.rejects(() => box.call('image_gen', { prompt: '第二张' }), (e) => {
      assert.ok(e instanceof PaintError);
      assert.match(e.message, /到上限了/);
      assert.match(e.hint, /每天最多几张/);
      return true;
    });
    assert.equal(g.calls.length, 1, '被拦下的那次不该发出去');
  });
});

test('配额：画失败要把名额退回来（失败不该占额度）', async () => {
  await withDir(async (dir) => {
    const box = createToolbox({
      cfg: cfg0({ dailyLimit: 5 }),
      dir,
      gen: async () => { throw new PaintError('接口 502'); },
    });
    await assert.rejects(() => box.call('image_gen', { prompt: '猫' }));
    assert.equal(countToday(join(dir, 'out')), 0);
  });
});

test('存盘失败：照样回「画好了」，但明说这张发不出去', async () => {
  await withDir(async (dir) => {
    /** 让 out 变成文件：mkdir 必失败，savePainting 返回空串 */
    writeFileSync(join(dir, 'out'), 'x');
    const box = createToolbox({ cfg: cfg0(), dir, gen: fakeGen().fn });
    const text = await box.call('image_gen', { prompt: '猫' });
    assert.match(text, /没能存进画作库/);
    assert.ok(!text.includes('<<image-alone'), '没路径就别教模型写标记');
  });
});

test('参考图：编号能取到旧图；找不到 / 功能关着都给准确原因', async () => {
  await withDir(async (dir) => {
    const g = fakeGen();
    const box = createToolbox({ cfg: cfg0(), dir, gen: g.fn });
    await box.call('image_gen', { prompt: '第一张' });
    await box.call('image_gen', { prompt: '第二张', ref: '#1' });
    assert.ok(Buffer.isBuffer(g.calls[1].image), '第二张应该带上参考图');
    assert.equal(g.calls[1].image.length, PNG.length);

    await assert.rejects(() => box.call('image_gen', { prompt: 'x', ref: '#9' }), /画作库里没有/);
    const off = createToolbox({ cfg: cfg0({ img2img: false }), dir, gen: g.fn });
    await assert.rejects(() => off.call('image_gen', { prompt: 'x', ref: '#1' }), /参考图功能关着/);
  });
});

test('image_list：空库说空库，有图给编号 / 路径 / 当天进度', async () => {
  await withDir(async (dir) => {
    const box = createToolbox({ cfg: cfg0({ dailyLimit: 10 }), dir, gen: fakeGen().fn });
    assert.match(await box.call('image_list', {}), /画作库还是空的/);
    await box.call('image_gen', { prompt: '猫' });
    const text = await box.call('image_list', {});
    assert.match(text, /#1 /);
    assert.match(text, /猫/);
    assert.match(text, /路径：/);
    assert.match(text, /今天已画 1\/10 张/);
  });
});

test('image_test：画一张并报走的是哪条接口', async () => {
  await withDir(async (dir) => {
    const box = createToolbox({ cfg: cfg0(), dir, gen: fakeGen().fn });
    const text = await box.call('image_test', {});
    assert.match(text, /接口通了/);
    assert.match(text, /主接口/);
    assert.match(text, /OpenAI 兼容/);
  });
});

test('image_delete：没 confirm 不删；确认后连文件一起没', async () => {
  await withDir(async (dir) => {
    const box = createToolbox({ cfg: cfg0(), dir, gen: fakeGen().fn });
    await box.call('image_gen', { prompt: '要删的' });
    await assert.rejects(() => box.call('image_delete', { file: '#1' }), /没确认/);
    assert.match(await box.call('image_list', {}), /#1 /);
    const out = await box.call('image_delete', { file: '#1', confirm: true });
    assert.match(out, /删掉了/);
    assert.match(await box.call('image_list', {}), /画作库还是空的/);
  });
});

test('参数校验：未知参数 / 空 prompt / 不存在的工具都给人话', async () => {
  await withDir(async (dir) => {
    const box = createToolbox({ cfg: cfg0(), dir, gen: fakeGen().fn });
    await assert.rejects(() => box.call('image_gen', { promt: '猫' }), /不认识的参数/);
    await assert.rejects(() => box.call('image_gen', { prompt: '  ' }), /prompt 是空的/);
    await assert.rejects(() => box.call('nope', {}), /没有工具/);
  });
});

// comfy-draw 自带测试：不连 QQ、不需要 ComfyUI，只跑纯函数与工作流图断言。
//
//   node --test plugins/comfy-draw/test/
//
// 这里能测的恰好是「最容易悄悄坏掉」的那些：触发词正则、尺寸钳制、两条加载路径
// 的图结构、以及出图路径的越界防护。需要真实 ComfyUI 的部分（提交、取图、
// 自动拉起）不在这里，靠 /绘图 测试 命令在真机上验。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import plugin, { DEFAULTS, VERSION, internals, parseSize } from '../index.js';
import { buildGraph, resolveImagePath, safePrefix, pruneImages } from '../lib/comfy-engine.js';

const { parseKeywords, parseTrigger, withQualityPrefix, formatModelList, humanize } = internals;

// ── 清单字段 ──────────────────────────────────────────────────────────────

test('市场描述不超过 60 字（index.json 的硬要求）', () => {
  assert.ok(plugin.description.length <= 60, `description 有 ${plugin.description.length} 字`);
  assert.ok(plugin.shortDesc.length <= plugin.description.length + 20);
  assert.equal(plugin.version, VERSION);
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
});

test('体积上限默认值与超时默认值同步', () => {
  assert.equal(DEFAULTS.timeoutMs, 180000, '默认超时要压到 3 分钟，给被动回复窗口留余量');
  assert.equal(DEFAULTS.maxImageMB, 8);
});

// ── 关键词与触发 ──────────────────────────────────────────────────────────

test('关键词按逗号/顿号/分号切分，全小写', () => {
  assert.deepEqual(parseKeywords('AI绘图, 画图、Draw；x'), ['ai绘图', '画图', 'draw', 'x']);
  assert.deepEqual(parseKeywords(''), ['ai绘图']);
  assert.deepEqual(parseKeywords('  ,、 '), ['ai绘图']);
});

test('关键词能吃掉中间的空格，但不会误伤别的词', () => {
  assert.deepEqual(parseTrigger('ai绘图+一只猫', ['ai绘图']), {
    hit: true,
    keyword: 'ai绘图',
    rest: '一只猫',
  });
  assert.equal(parseTrigger('AI 绘图：樱花树', ['ai绘图']).rest, '樱花树');
  assert.equal(parseTrigger('ai绘 图 一只狗', ['ai绘图']).rest, '一只狗');
  assert.equal(parseTrigger('aid绘图', ['ai绘图']).hit, false);
  assert.equal(parseTrigger('今天天气不错', ['ai绘图']).hit, false);
});

test('只有触发词、没有需求时 rest 为空', () => {
  const r = parseTrigger('ai绘图', ['ai绘图']);
  assert.equal(r.hit, true);
  assert.equal(r.rest, '');
});

// ── 尺寸 ──────────────────────────────────────────────────────────────────

test('尺寸解析：正常值原样返回', () => {
  assert.deepEqual(parseSize('832x1216'), {
    width: 832,
    height: 1216,
    clamped: false,
    requested: { width: 832, height: 1216 },
  });
  assert.equal(parseSize('1024×1024').width, 1024);
  assert.equal(parseSize('512 * 768').height, 768);
  assert.equal(parseSize(''), null);
  assert.equal(parseSize('大一点'), null);
});

test('尺寸越界会钳制，并把实情带回去（不再静默）', () => {
  const small = parseSize('100x100');
  assert.equal(small.width, 256);
  assert.equal(small.clamped, true);
  assert.deepEqual(small.requested, { width: 100, height: 100 });

  const huge = parseSize('30000x30000');
  assert.equal(huge.width, 2560);
  assert.equal(huge.clamped, true);
});

// ── 提示词修饰 ────────────────────────────────────────────────────────────

test('质量标签只在缺失时补一次', () => {
  assert.equal(withQualityPrefix('a cat', true), 'masterpiece, best quality, a cat');
  assert.equal(withQualityPrefix('masterpiece, a cat', true), 'masterpiece, a cat');
  assert.equal(withQualityPrefix('a cat', false), 'a cat');
});

test('模型清单为空时说人话', () => {
  assert.equal(formatModelList(null), '（一个模型都没有）');
  assert.match(formatModelList({ checkpoints: ['a.safetensors'], unet: [] }), /单文件模型/);
});

test('常见错误翻成人话', () => {
  assert.match(humanize(new Error('connect ECONNREFUSED 127.0.0.1:8188')), /连不上 ComfyUI/);
  assert.match(humanize(new Error('ENOENT: no such file')), /找不到文件或程序路径/);
  assert.equal(humanize(new Error('随便一个错')), '随便一个错');
});

// ── 工作流图：两条加载路径 ────────────────────────────────────────────────

const baseArgs = {
  positive: 'p',
  negative: 'n',
  width: 832,
  height: 1216,
  seed: 42,
  prefix: 'roost',
  batchSize: 1,
};

test('单文件模型：CheckpointLoaderSimple + 老式采样默认值', () => {
  const g = buildGraph(
    { modelName: 'x.safetensors', steps: 0, cfg: 0, sampler: 'auto', scheduler: 'auto' },
    { ...baseArgs, arch: 'checkpoint' },
  );
  assert.equal(g['1'].class_type, 'CheckpointLoaderSimple');
  assert.equal(g['1'].inputs.ckpt_name, 'x.safetensors');
  assert.equal(g['7'].inputs.cfg, 7.5);
  assert.equal(g['7'].inputs.sampler_name, 'dpmpp_2m');
  assert.equal(g['7'].inputs.scheduler, 'karras');
  assert.equal(g['8'].inputs.vae[0], '1');
  assert.equal(g['9'].inputs.filename_prefix, 'roost');
  assert.equal(g['6'].inputs.width, 832);
});

test('拆分模型（单编码器）：UNETLoader + CLIPLoader + VAELoader', () => {
  const g = buildGraph(
    {
      modelName: 'unet.safetensors',
      clipName: 'clip.safetensors',
      vaeName: 'vae.safetensors',
      clipType: 'stable_diffusion',
    },
    { ...baseArgs, arch: 'split' },
  );
  assert.equal(g['1'].class_type, 'UNETLoader');
  assert.equal(g['2'].class_type, 'CLIPLoader');
  assert.equal(g['2'].inputs.clip_name, 'clip.safetensors');
  assert.equal(g['3'].class_type, 'VAELoader');
  assert.equal(g['4'].inputs.clip[0], '2');
  assert.equal(g['8'].inputs.vae[0], '3');
  assert.equal(g['7'].inputs.cfg, 4);
  assert.equal(g['7'].inputs.sampler_name, 'euler');
  assert.equal(g['7'].inputs.scheduler, 'sgm_uniform');
});

test('拆分模型（双编码器）：自动换成 DualCLIPLoader', () => {
  const g = buildGraph(
    {
      modelName: 'unet.safetensors',
      clipName: 'clip1.safetensors',
      clipName2: 'clip2.safetensors',
      vaeName: 'vae.safetensors',
      clipType: 'flux',
    },
    { ...baseArgs, arch: 'split' },
  );
  assert.equal(g['2'].class_type, 'DualCLIPLoader');
  assert.equal(g['2'].inputs.clip_name1, 'clip1.safetensors');
  assert.equal(g['2'].inputs.clip_name2, 'clip2.safetensors');
  assert.equal(g['2'].inputs.type, 'flux');
});

test('批量张数写进 EmptyLatentImage', () => {
  const g = buildGraph({ modelName: 'x' }, { ...baseArgs, arch: 'checkpoint', batchSize: 3 });
  assert.equal(g['6'].inputs.batch_size, 3);
});

// ── 出图路径防护 ──────────────────────────────────────────────────────────

test('正常出图路径拼在出图目录里', () => {
  const dir = path.join(os.tmpdir(), 'comfy-out');
  const file = resolveImagePath({ outputDir: dir }, { subfolder: 'sub', filename: 'a.png' });
  assert.equal(file, path.join(dir, 'sub', 'a.png'));
});

test('子目录/文件名里的上跳路径会被剥掉，读不到出图目录之外', () => {
  const dir = path.join(os.tmpdir(), 'comfy-out');
  // Windows/System 里的东西拼不进来：两段都只取 basename，结果仍在出图目录内
  const neutralized = resolveImagePath(
    { outputDir: dir },
    { subfolder: '../../Windows', filename: 'win.ini' },
  );
  assert.equal(neutralized, path.join(dir, 'Windows', 'win.ini'));
  assert.ok(!path.relative(dir, neutralized).startsWith('..'));

  const abs = resolveImagePath(
    { outputDir: dir },
    { subfolder: '', filename: '../secret.png' },
  );
  assert.equal(abs, path.join(dir, 'secret.png'));

  assert.throws(() => resolveImagePath({ outputDir: dir }, { filename: '..' }), /文件名/);
  assert.throws(() => resolveImagePath({ outputDir: dir }, { filename: '' }), /文件名/);
});

// ── 清理旧图 ──────────────────────────────────────────────────────────────

test('前缀少于 3 个字符或含路径符号时不做清理', () => {
  assert.equal(safePrefix('roost'), 'roost');
  assert.equal(safePrefix('a'), '');
  assert.equal(safePrefix('a/b'), '');
  // 路径符号被剥掉；剥完不够 3 个字符就当没填
  assert.equal(safePrefix('r/o/o/t'), 'root');
  assert.equal(safePrefix('..'), '');
});

test('清理只动本进程记录过的文件，保留最近 N 张', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-prune-'));
  const names = ['roost_1.png', 'roost_2.png', 'roost_3.png', 'roost_4.png'];
  const known = new Set();
  for (const name of names) {
    const full = path.join(dir, name);
    fs.writeFileSync(full, 'x');
    known.add(full);
    await new Promise((r) => setTimeout(r, 12));
  }
  // 不在记录里、但同前缀的文件：新逻辑不该碰它
  const outsider = path.join(dir, 'roost_9.png');
  fs.writeFileSync(outsider, 'x');

  const removed = pruneImages({ outputDir: dir, keepImages: 2, filenamePrefix: 'roost' }, () => {}, known);
  assert.equal(removed, 2);
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, ['roost_3.png', 'roost_4.png', 'roost_9.png']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('keepImages=0 表示不清理', () => {
  assert.equal(pruneImages({ outputDir: os.tmpdir(), keepImages: 0, filenamePrefix: 'roost' }), 0);
});

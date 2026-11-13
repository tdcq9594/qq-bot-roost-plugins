#!/usr/bin/env node
/**
 * 配置解析：面板的两份东西 → 一份能用的配置（不联网、不写盘）
 *
 *   node test/config.mjs
 *
 * 重点验三件事：默认值能兜住空配置、密钥只从环境变量来、备用接口那行
 * 「地址|模型」的手写格式解析得对。这三件错了的表现分别是
 * 「装上一句话都画不了」「密钥明文进了 config」「备用链永远不触发」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSize, parseFallbacks, parseParams, readConfig, readyProblem, secretEnv, sizeFor } from '../lib/config.mjs';

test('密钥 env 名：apiKey → ROOST_EXT_SECRET_APIKEY（与宿主同一套规则）', () => {
  assert.equal(secretEnv('apiKey'), 'ROOST_EXT_SECRET_APIKEY');
  assert.equal(secretEnv('some-Key_2'), 'ROOST_EXT_SECRET_SOME_KEY_2');
});

test('空环境：按默认值起，不抛', () => {
  const cfg = readConfig({});
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.baseUrl, '');
  assert.equal(cfg.apiKey, '');
  assert.equal(cfg.model, 'gpt-image-1');
  assert.equal(cfg.shape, 'square');
  assert.equal(cfg.dailyLimit, 20);
  assert.equal(cfg.img2img, true);
  assert.deepEqual(cfg.fallbacks, []);
  assert.equal(cfg.custom.method, 'POST');
  assert.equal(cfg.custom.bodyType, 'json');
  /** 没填地址就是「还画不了」，而且必须能说出去哪儿填 */
  assert.match(readyProblem(cfg), /服务地址/);
});

test('坏 JSON：不炸，按空配置继续（扩展必须起得来）', () => {
  const logs = [];
  const cfg = readConfig({ ROOST_EXT_CONFIG: '{这不是 json' }, (m) => logs.push(m));
  assert.equal(cfg.model, 'gpt-image-1');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /不是合法 JSON/);
});

test('ROOST_EXT_CONFIG 是数组/字符串：当空配置，不当对象用', () => {
  assert.equal(readConfig({ ROOST_EXT_CONFIG: '[1,2]' }).model, 'gpt-image-1');
  assert.equal(readConfig({ ROOST_EXT_CONFIG: '"x"' }).model, 'gpt-image-1');
});

test('密钥只从 ROOST_EXT_SECRET_APIKEY 来，不认 ROOST_EXT_CONFIG 里的 apiKey', () => {
  const cfg = readConfig({
    ROOST_EXT_CONFIG: JSON.stringify({ apiKey: '明文塞进 config 的' }),
    ROOST_EXT_SECRET_APIKEY: 'sk-from-env',
  });
  assert.equal(cfg.apiKey, 'sk-from-env');
  const noEnv = readConfig({ ROOST_EXT_CONFIG: JSON.stringify({ apiKey: '明文' }) });
  assert.equal(noEnv.apiKey, '');
});

test('地址尾斜杠、模型、风格都按规矩收敛', () => {
  const cfg = readConfig({
    ROOST_EXT_CONFIG: JSON.stringify({
      baseUrl: 'https://x.test/v1///', model: '  m1  ', stylePrompt: ' 厚涂 ', shape: 'portrait', size: '1024×1536',
    }),
  });
  assert.equal(cfg.baseUrl, 'https://x.test/v1');
  assert.equal(cfg.model, 'm1');
  assert.equal(cfg.stylePrompt, '厚涂');
  assert.equal(cfg.shape, 'portrait');
  assert.equal(cfg.size, '1024x1536');
});

test('布尔与数字：字符串形式也认，越界夹回来', () => {
  const cfg = readConfig({
    ROOST_EXT_CONFIG: JSON.stringify({ img2img: 'false', dailyLimit: '999' }),
  });
  assert.equal(cfg.img2img, false);
  assert.equal(cfg.dailyLimit, 200);
  assert.equal(readConfig({ ROOST_EXT_CONFIG: JSON.stringify({ img2img: '开' }) }).img2img, true);
  assert.equal(readConfig({ ROOST_EXT_CONFIG: JSON.stringify({ dailyLimit: 'abc' }) }).dailyLimit, 20);
});

test('尺寸：× 与 * 都归一，认不出给空串（不猜）', () => {
  assert.equal(normalizeSize('1024×768'), '1024x768');
  assert.equal(normalizeSize(' 1024 * 1536 '), '1024x1536');
  assert.equal(normalizeSize('大图'), '');
  assert.equal(normalizeSize('1024'), '');
});

test('sizeFor：工具 size > 工具 shape > 设置 size > 设置 shape > 方图', () => {
  const cfg = { shape: 'portrait', size: '' };
  assert.equal(sizeFor(cfg, { size: '2048x2048', shape: 'wide' }), '2048x2048');
  assert.equal(sizeFor(cfg, { shape: 'landscape' }), '1536x1024');
  assert.equal(sizeFor(cfg, {}), '1024x1536');
  assert.equal(sizeFor({ shape: 'portrait', size: '512x512' }, {}), '512x512');
  /** 模型瞎写一个不存在的构图：不静默换，按设置走 */
  assert.equal(sizeFor({ shape: 'wide', size: '' }, { shape: 'vertical' }), '1536x864');
});

test('备用接口：一行一条「地址|模型」，能只写地址、能去重、脏行跳过', () => {
  assert.deepEqual(
    parseFallbacks(['https://a.test/v1|m1', ' https://b.test/v1 ', 'ftp://c|x', '没竖线的地址但不能用', ''], 'main'),
    [{ baseUrl: 'https://a.test/v1', model: 'm1' }, { baseUrl: 'https://b.test/v1', model: 'main' }],
  );
  /** 同地址同模型不重复试 */
  assert.equal(parseFallbacks(['https://a|m', 'https://a/|m'], 'm').length, 1);
  /** 没模型（主模型也空）就跳过，避免拿空 model 去打一次必失败的请求 */
  assert.deepEqual(parseFallbacks(['https://a'], ''), []);
  assert.equal(parseFallbacks(Array.from({ length: 9 }, (_, i) => `https://h${i}|m`)).length, 5);
});

test('自定义参数：key=value，值是空的也留着（有的接口就要空值）', () => {
  assert.deepEqual(parseParams(['prompt={prompt}', 'n=1', 'empty=', '=坏行', '没等号']), [
    { key: 'prompt', value: '{prompt}' },
    { key: 'n', value: '1' },
    { key: 'empty', value: '' },
  ]);
});

test('readyProblem：自定义接口只看地址，OpenAI 兼容要地址 + 模型', () => {
  assert.match(readyProblem({ provider: 'custom', custom: {} }), /自定义生图接口地址/);
  assert.equal(readyProblem({ provider: 'custom', custom: { url: 'https://a' } }), '');
  assert.match(readyProblem({ provider: 'openai', baseUrl: 'https://a', model: '' }), /模型/);
  assert.equal(readyProblem({ provider: 'openai', baseUrl: 'https://a', model: 'm' }), '');
});

test('谁把 provider 写成别的值：退回 openai，不当自定义接口用', () => {
  const cfg = readConfig({ ROOST_EXT_CONFIG: JSON.stringify({ provider: 'stable-diffusion' }) });
  assert.equal(cfg.provider, 'openai');
});

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

import { applyLiveConfig, normalizeSize, parseFallbacks, parseParams, readConfig, readyProblem, secretEnv, sizeFor } from '../lib/config.mjs';

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

test('0.2 新配置：默认值、夹取、字符串布尔、密钥只从 env 来', () => {
  const base = readConfig({ ROOST_EXT_CONFIG: '{}' });
  assert.equal(base.fallbackEnabled, true);
  assert.equal(base.timeoutSec, 120);
  assert.equal(base.maxKeep, 0);
  assert.equal(base.apiKey, '');

  const cfg = readConfig({
    ROOST_EXT_CONFIG: JSON.stringify({
      fallbackEnabled: 'false', timeoutSec: 999, maxKeep: -3, apiKey: '从面板JSON混进来的',
    }),
    ROOST_EXT_SECRET_APIKEY: '只有这份能用',
  });
  assert.equal(cfg.fallbackEnabled, false, '面板可能把布尔写成字符串');
  assert.equal(cfg.timeoutSec, 180, '超时夹到上限');
  assert.equal(cfg.maxKeep, 0, '负数夹回来');
  assert.equal(cfg.apiKey, '只有这份能用', '密钥绝不从 ROOST_EXT_CONFIG 读');
});

test('applyLiveConfig：原地改活引用；密钥时序、清空、明文注入三条都不出错', () => {
  const env = {
    ROOST_EXT_CONFIG: JSON.stringify({ model: 'm1', timeoutSec: 120 }),
    ROOST_EXT_SECRET_APIKEY: '启动时注入的旧密钥',
  };
  const cfg = readConfig(env);
  assert.equal(cfg.apiKey, '启动时注入的旧密钥');

  /** 只改非敏感配置：secret 没变就别动，旧密钥继续用 */
  const ref = cfg;
  applyLiveConfig(cfg, { model: 'm2', timeoutSec: 60 }, null, env);
  assert.equal(ref, cfg, '必须是原地改，不能换引用（toolbox 持有的是这个对象）');
  assert.equal(cfg.model, 'm2');
  assert.equal(cfg.timeoutSec, 60);
  assert.equal(cfg.apiKey, '启动时注入的旧密钥');

  /** 面板把密钥清空（宿主写 {}）：不能还握着旧密钥继续花钱 */
  applyLiveConfig(cfg, null, {}, env);
  assert.equal(cfg.apiKey, '');

  /** 重新粘一把新密钥 */
  applyLiveConfig(cfg, null, { apiKey: '新密钥' }, env);
  assert.equal(cfg.apiKey, '新密钥');

  /**
   * 对抗测试 B1c 的时序：改完密钥之后又改了一次模型名（secrets mtime 没变，
   * createLiveConfig 传 secrets=null）。这时若拿启动时 env 的旧值覆盖，
   * 新密钥就被悄悄退回了 —— 必须保留现值。
   */
  applyLiveConfig(cfg, { model: 'm3' }, null, env);
  assert.equal(cfg.apiKey, '新密钥', '改非敏感项不能把密钥退回启动时的旧值');

  /** 明文 JSON 里夹带的 apiKey 永远不生效，且仍保留现值 */
  applyLiveConfig(cfg, { apiKey: '想混进来的明文' }, null, env);
  assert.equal(cfg.apiKey, '新密钥', '非敏感 JSON 不许提供密钥');

  /** secrets 里只有别的键、没有 apiKey：不误清 */
  applyLiveConfig(cfg, null, { someOtherSecret: 'x' }, env);
  assert.equal(cfg.apiKey, '新密钥', '缺 apiKey 键不代表用户清了密钥');
});

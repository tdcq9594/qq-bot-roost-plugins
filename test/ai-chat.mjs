/**
 * ai-chat 插件的测试
 * ================
 *
 * 这个文件只测「适配器层」和「插件元数据」，不需要框架、不需要真模型：
 * 用假的 fetch 验证请求体拼得对不对、返回解得对不对、错误翻得对不对。
 *
 * 为什么先测这一层：适配器是这次重构的接缝。接缝错了，
 * 后面接 DSH / webhook 时才发现，那时候改动面已经很大了。
 *
 * 跑法：
 *   node test/ai-chat.mjs
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, '..', 'plugins', 'ai-chat');

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}${detail ? '  ' + detail : ''}`);
  }
};

const { createAdapter, ADAPTER_OPTIONS } = await import(pathToFileURL(path.join(PLUGIN, 'adapter', 'index.js')));
const plugin = (await import(pathToFileURL(path.join(PLUGIN, 'index.js')))).default;

/* ---------------- 插件元数据 ---------------- */

ok('插件: id 没变（老用户配置能继续用）', plugin.id === 'ai-chat', plugin.id);
ok('插件: 声明了 adapter 配置项', Boolean(plugin.config?.adapter));
ok('插件: adapter 默认是 openai', plugin.config?.adapter?.default === 'openai');
ok(
  '插件: adapter 是下拉且选项非空',
  plugin.config?.adapter?.type === 'select' && Array.isArray(plugin.config.adapter.options) && plugin.config.adapter.options.length > 0,
);
ok('插件: 原有配置键还在（apiKey/baseUrl/model）', Boolean(plugin.config?.apiKey && plugin.config?.baseUrl && plugin.config?.model));
ok('适配器选项: 至少含 openai', ADAPTER_OPTIONS.some((o) => o.value === 'openai'));

/* ---------------- openai 适配器 ---------------- */

const explainHttp = (status) => `HTTP_${status}`;

/** 造一个假 fetch，记下请求体 */
function stubFetch({ status = 200, json = null, text = '' } = {}) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => text,
    };
  };
  return { calls, restore: () => (globalThis.fetch = orig) };
}

const baseConf = (over = {}) => () => ({
  adapter: 'openai',
  apiKey: 'sk-test',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  maxTokens: 512,
  temperature: 0.7,
  thinking: false,
  reasoningEffort: 'high',
  ...over,
});

{
  // DeepSeek + 思考关：要显式传 disabled，且要带 temperature
  const f = stubFetch({ json: { choices: [{ message: { content: ' 你好 ' } }], model: 'deepseek-flash' } });
  const a = createAdapter({ conf: baseConf(), explainHttp });
  const r = await a.chat({ messages: [{ role: 'user', content: 'hi' }] });
  f.restore();

  const body = f.calls[0].body;
  ok('openai: 打到 /chat/completions', f.calls[0].url === 'https://api.deepseek.com/chat/completions');
  ok('openai: 带 Bearer 鉴权', f.calls[0].init.headers.Authorization === 'Bearer sk-test');
  ok('openai: 非流式', body.stream === false);
  ok('openai: DeepSeek 显式关思考', body.thinking?.type === 'disabled');
  ok('openai: 思考关时带 temperature', body.temperature === 0.7);
  ok('openai: 返回去掉首尾空白', r.text === '你好');
}

{
  // 非 DeepSeek：不能带 thinking（别家会 400）
  const f = stubFetch({ json: { choices: [{ message: { content: 'ok' } }] } });
  const a = createAdapter({ conf: baseConf({ baseUrl: 'https://api.moonshot.cn/v1' }), explainHttp });
  await a.chat({ messages: [] });
  f.restore();
  ok('openai: 非 DeepSeek 不带 thinking', f.calls[0].body.thinking === undefined);
}

{
  // 思考开：带 enabled + reasoning_effort，且不传 temperature
  const f = stubFetch({ json: { choices: [{ message: { content: 'ok' } }] } });
  const a = createAdapter({ conf: baseConf({ thinking: true, reasoningEffort: 'max' }), explainHttp });
  await a.chat({ messages: [] });
  f.restore();
  const body = f.calls[0].body;
  ok('openai: 思考开带 enabled', body.thinking?.type === 'enabled');
  ok('openai: 思考开带 reasoning_effort', body.reasoning_effort === 'max');
  ok('openai: 思考开不传 temperature', body.temperature === undefined);
}

{
  // 临时指定模型（/模型 命令）
  const f = stubFetch({ json: { choices: [{ message: { content: 'ok' } }] } });
  const a = createAdapter({ conf: baseConf(), explainHttp });
  await a.chat({ messages: [], model: 'deepseek-v4-pro' });
  f.restore();
  ok('openai: 临时模型覆盖配置', f.calls[0].body.model === 'deepseek-v4-pro');
}

{
  // 空内容要报错，不能把空串发到群里
  const f = stubFetch({ json: { choices: [{ message: { content: '   ' } }] } });
  const a = createAdapter({ conf: baseConf(), explainHttp });
  let err = null;
  try {
    await a.chat({ messages: [] });
  } catch (e) {
    err = e;
  }
  f.restore();
  ok('openai: 空内容报错', /空内容/.test(err?.message ?? ''), err?.message ?? '');
}

{
  // 内容被审核拦
  const f = stubFetch({ json: { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] } });
  const a = createAdapter({ conf: baseConf(), explainHttp });
  let err = null;
  try {
    await a.chat({ messages: [] });
  } catch (e) {
    err = e;
  }
  f.restore();
  ok('openai: 内容审核拦下时说清楚', /审核/.test(err?.message ?? ''), err?.message ?? '');
}

{
  // HTTP 错误走 explainHttp
  const f = stubFetch({ status: 401, text: 'unauthorized' });
  const a = createAdapter({ conf: baseConf(), explainHttp });
  let err = null;
  try {
    await a.chat({ messages: [] });
  } catch (e) {
    err = e;
  }
  f.restore();
  ok('openai: HTTP 错误翻成人话', err?.message === 'HTTP_401', err?.message ?? '');
}

/* ---------------- 适配器选择 ---------------- */

{
  let err = null;
  try {
    createAdapter({ conf: baseConf({ adapter: 'dsh' }), explainHttp });
  } catch (e) {
    err = e;
  }
  ok('选择: 未实现的 dsh 明确报错', /dsh 适配器还没做/.test(err?.message ?? ''), err?.message ?? '');
}

{
  let err = null;
  try {
    createAdapter({ conf: baseConf({ adapter: 'nope' }), explainHttp });
  } catch (e) {
    err = e;
  }
  ok('选择: 未知适配器报错', /未知的适配器/.test(err?.message ?? ''), err?.message ?? '');
}

{
  // 关键：选了 dsh 不能悄悄回落到 openai
  let fellBack = false;
  try {
    const a = createAdapter({ conf: baseConf({ adapter: 'dsh' }), explainHttp });
    fellBack = a?.name === 'openai';
  } catch {
    fellBack = false;
  }
  ok('选择: 不会静默回落到 openai', fellBack === false);
}

/* ---------------- 汇总 ---------------- */

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.log('失败项:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exitCode = 1;
}

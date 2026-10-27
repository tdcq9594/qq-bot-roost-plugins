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

const { createAdapter } = await import(pathToFileURL(path.join(PLUGIN, 'adapter', 'index.js')));
const plugin = (await import(pathToFileURL(path.join(PLUGIN, 'index.js')))).default;

/* ---------------- 插件元数据 ---------------- */

ok('插件: id 没变（老用户配置能继续用）', plugin.id === 'ai-chat', plugin.id);
ok('插件: 只连 DSH，不再有适配器下拉', plugin.config?.adapter === undefined);
ok('插件: 直连模型的配置项都删了', !plugin.config?.apiKey && !plugin.config?.baseUrl && !plugin.config?.model);
ok('插件: 保留 DSH 地址', plugin.config?.dshUrl?.type === 'text');
ok('插件: 不再有 webhook 地址', plugin.config?.hostUrl === undefined);

/* ---------------- 适配器：只有 DSH ---------------- */

/** 最小可用配置：现在只连 DSH，模型相关的东西都不在插件里了 */
const baseConf = (over = {}) => () => ({ dshUrl: 'http://127.0.0.1:17321', publicUrl: 'http://127.0.0.1:8080', ...over });

/** 假回话通道：只验证适配器构造，不真等回话 */
const fakeBridge = () => ({ create: () => ({ id: 'e', token: 't', promise: new Promise(() => {}) }), handleReply: () => ({ code: 200, body: {} }), dispose() {} });
const pubUrl = () => 'http://127.0.0.1:8080';

{
  const a = createAdapter({
    conf: baseConf({ dshUrl: 'http://127.0.0.1:17321' }),
    bridge: fakeBridge(),
    publicUrl: pubUrl,
  });
  ok('适配器: 永远是 dsh', a?.name === 'dsh', a?.name ?? '');
}

{
  // 从 3.x 升级上来的配置里可能还留着 adapter: 'openai'，必须被忽略
  const a = createAdapter({ conf: baseConf({ adapter: 'openai' }), bridge: fakeBridge(), publicUrl: pubUrl });
  ok('适配器: 老配置里的 adapter 被忽略', a?.name === 'dsh', a?.name ?? '');
}


/* ---------------- 汇总 ---------------- */

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.log('失败项:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exitCode = 1;
}

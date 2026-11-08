/**
 * E10 主人命令面：/silent /active /quiet /model
 *
 * 锁三件事：
 *   1. 四个命令都注册了，且 `admin: true`（权限交给框架的等级系统，不写死主人）；
 *   2. /silent /active 写的是 `aiChat.silent`（policy-config 的唯一键名），
 *      /quiet 写的是进程内 `aiChatQuiet`（重启失效）；
 *   3. /model 走 dsh-roost 的 `/roost/api/quick`：查询 → model.get，
 *      指定 → model.set，off → model.set + off:true。
 *
 * 跑法：node test/ai-chat-commands.mjs
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = path.join(HERE, '..', 'plugins', 'ai-chat', 'index.js');
const plugin = (await import(pathToFileURL(P))).default;

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

const noop = () => {};
const state = {};
const commands = {};
const handlers = {};
const cfg = {
  decide: 'mention',
  dshUrl: 'http://127.0.0.1:17321',
  mergeWaitSec: 0,
  cooldownSec: 0,
  maxRepliesPerMin: 3,
  debug: false,
};
const ctx = new Proxy({}, {
  get(_t, k) {
    if (k === 'config') return cfg;
    if (k === 'state') return state;
    if (k === 'logger') return { info: noop, debug: noop, warn: noop, error: noop };
    if (k === 'command') {
      return (name, meta, fn) => {
        commands[String(name).trim().split(/\s+/)[0]] = { meta, fn };
        return noop;
      };
    }
    if (k === 'on') return (ev, fn) => { handlers[ev] = fn; };
    if (k === 'onTeardown' || k === 'registerRoute') return noop;
    if (k === 'schedule') return () => ({ cancel: noop });
    if (k === 'gate') return () => Promise.resolve(true);
    if (k === 'levelOf') return () => 'member';
    if (k === 'levelName') return () => '成员';
    if (k === 'isOwner') return () => false;
    return () => Promise.resolve({});
  },
});

await plugin.setup.call(plugin, ctx);

const replied = [];
const msg = { chatId: 'g1', reply: async (t) => { replied.push(String(t)); } };

ok('四个命令都注册了', ['silent', 'active', 'quiet', 'model'].every((n) => commands[n]));
ok('权限走 admin 等级（不是写死主人）',
  ['silent', 'active', 'quiet', 'model'].every((n) => commands[n]?.meta?.admin === true));

/* ---------------- /silent /active ---------------- */

await commands.silent.fn(msg, { args: [] });
ok('/silent 写的是 policy-config 的 aiChat.silent 键', state['aiChat.silent'] === true, JSON.stringify(state));
ok('/silent 有回话', /安静/.test(replied.at(-1) || ''));

await commands.active.fn(msg, { args: [] });
ok('/active 解除静默', state['aiChat.silent'] === false);

/* ---------------- /quiet ---------------- */

await commands.quiet.fn(msg, { args: ['23', '7'] });
ok('/quiet 23 7 写进程内时段', state.aiChatQuiet?.start === 23 && state.aiChatQuiet?.end === 7);

await commands.quiet.fn(msg, { args: ['off'] });
ok('/quiet off 取消时段', state.aiChatQuiet === undefined);

const before = replied.length;
await commands.quiet.fn(msg, { args: ['25', '7'] });
ok('/quiet 参数越界给用法、不写状态',
  state.aiChatQuiet === undefined && replied.length === before + 1 && /用法/.test(replied.at(-1)));

/* ---------------- /model（走 dsh-roost quick） ---------------- */

const calls = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init?.body || '{}');
  calls.push({ url: String(url), body });
  const picked = body.arg?.off ? null : { provider: body.arg?.provider || 'p', model: body.arg?.model || 'm' };
  const reply = body.op === 'model.get'
    ? { ok: true, override: null, byKind: null, global: { provider: 'deepseek', model: 'deepseek-chat' } }
    : (body.arg?.kind ? { ok: true, byKind: picked } : { ok: true, override: picked });
  return { ok: true, status: 200, json: async () => reply };
};

await commands.model.fn(msg, { args: [] });
ok('/model 无参 = model.get 且带 chatId',
  calls.at(-1)?.body?.op === 'model.get' && calls.at(-1)?.body?.arg?.chatId === 'g1',
  JSON.stringify(calls.at(-1)));
ok('/model 查询回显全局默认', /deepseek/.test(replied.at(-1) || ''));

await commands.model.fn(msg, { args: ['aliyun', 'qwen-max'] });
ok('/model p m = model.set',
  calls.at(-1)?.body?.op === 'model.set'
  && calls.at(-1)?.body?.arg?.provider === 'aliyun'
  && calls.at(-1)?.body?.arg?.model === 'qwen-max');
ok('/model 设置后回话说明下一轮生效', /下一轮生效/.test(replied.at(-1) || ''));

await commands.model.fn(msg, { args: ['off'] });
ok('/model off = model.set + off:true',
  calls.at(-1)?.body?.op === 'model.set' && calls.at(-1)?.body?.arg?.off === true);
ok('/model off 回话说明恢复全局', /恢复全局/.test(replied.at(-1) || ''));

await commands.model.fn(msg, { args: ['kind', 'c2c', 'aliyun', 'qwen-max'] });
ok('/model kind c2c p m = model.set + kind',
  calls.at(-1)?.body?.arg?.kind === 'c2c'
  && calls.at(-1)?.body?.arg?.provider === 'aliyun'
  && calls.at(-1)?.body?.arg?.model === 'qwen-max');
ok('/model kind 回话说明「所有私聊」', /所有私聊/.test(replied.at(-1) || ''), replied.at(-1));

await commands.model.fn(msg, { args: ['kind', 'group', 'off'] });
ok('/model kind group off = off:true',
  calls.at(-1)?.body?.arg?.kind === 'group' && calls.at(-1)?.body?.arg?.off === true);

await commands.model.fn(msg, { args: ['kind', 'bogus'] });
ok('/model kind 非法类型给用法', /用法/.test(replied.at(-1) || ''), replied.at(-1));

/* dsh-roost 返回失败时如实回话 */
globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, message: '炸了' }) });
await commands.model.fn(msg, { args: [] });
ok('/model 失败如实回话', /炸了/.test(replied.at(-1) || ''), replied.at(-1));

console.log(`\n${pass} pass, ${fails.length} fail`);
if (fails.length) process.exit(1);

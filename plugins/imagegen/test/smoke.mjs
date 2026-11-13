#!/usr/bin/env node
/**
 * 离线冒烟：不联网，只验 MCP 协议面与「没配置时的说法」
 *
 *   node test/smoke.mjs
 *
 * 真画一张的验证在 test/live.mjs（手动用，要真接口和真钱，不进 CI）。
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  /**
   * 显式清空配置：跑测试的人自己机器上可能真配了接口，
   * 不清空的话「没配置」这条断言会被他自己的配置搞红。
   */
  env: { ...process.env, ROOST_EXT_CONFIG: '', ROOST_EXT_SECRET_APIKEY: '' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let seq = 0;
const waiting = new Map();
let buf = '';

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.error('非 JSON 输出：', line); process.exit(1); }
    const done = waiting.get(msg.id);
    if (done) { waiting.delete(msg.id); done(msg); }
  }
});

const stderr = [];
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => stderr.push(c));

function rpc(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 8000);
    waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

const fail = [];
const check = (cond, label) => {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) fail.push(label);
};

try {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  check(init.result?.serverInfo?.name === 'imagegen', 'initialize 返回 serverInfo.name=imagegen');
  check(init.result?.protocolVersion === '2024-11-05', 'protocolVersion 回显客户端版本');
  check(Boolean(init.result?.capabilities?.tools), '声明 tools 能力');

  // 通知不该有回包；发了之后连接仍然可用即算通过
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const list = await rpc('tools/list', {});
  const tools = list.result?.tools || [];
  const names = tools.map((t) => t.name);
  check(names.length === 4, `tools/list 有 4 个工具（实际 ${names.length}）`);
  for (const n of ['image_gen', 'image_list', 'image_test', 'image_delete']) check(names.includes(n), `工具有 ${n}`);
  check(tools.every((t) => t.inputSchema?.type === 'object'), '每个工具都有 object 入参 schema');
  /** 写操作必须自己声明，别为了「看着无害」全标成只读 */
  const gen = tools.find((t) => t.name === 'image_gen');
  check(gen?.annotations?.readOnlyHint === false, 'image_gen 声明为会写/会花钱（readOnlyHint=false）');

  const ping = await rpc('ping', {});
  check(ping.result && Object.keys(ping.result).length === 0, 'ping 回空结果');

  /** 没配置也要能看画作库：这不是「画不了就什么都干不了」 */
  const empty = await rpc('tools/call', { name: 'image_list', arguments: {} });
  check(empty.result?.isError !== true && /画作库还是空的/.test(empty.result.content[0].text), '没配置时 image_list 照样能用');

  const noCfg = await rpc('tools/call', { name: 'image_gen', arguments: { prompt: '猫' } });
  check(noCfg.result?.isError === true, '没配置时 image_gen 回 isError');
  check(/服务地址/.test(noCfg.result.content[0].text), '并说清缺的是「服务地址」（能直接去面板改）');

  const del = await rpc('tools/call', { name: 'image_delete', arguments: { file: '#1' } });
  check(del.result?.isError === true && /没确认/.test(del.result.content[0].text), '删除没 confirm 就拒');

  const badArg = await rpc('tools/call', { name: 'image_gen', arguments: { promt: '猫' } });
  check(badArg.result?.isError === true && /不认识的参数/.test(badArg.result.content[0].text), '未知参数被拒（且给出原因）');

  const unknown = await rpc('tools/call', { name: 'nope', arguments: {} });
  check(unknown.result?.isError === true, '不存在的工具返回 isError 而不是崩');

  const badMethod = await rpc('nonsense/method', {});
  check(badMethod.error?.code === -32601, '未知方法回 -32601');
} catch (e) {
  console.error('✗ 冒烟失败：', e?.message ?? e);
  fail.push(e?.message ?? String(e));
} finally {
  child.stdin.end();
  child.kill();
}

if (fail.length) {
  console.error(`\n${fail.length} 项失败:\n- ${fail.join('\n- ')}`);
  if (stderr.length) console.error('stderr:\n' + stderr.join('').slice(-800));
  process.exitCode = 1;
} else {
  console.log('\n✓ 全部通过');
}

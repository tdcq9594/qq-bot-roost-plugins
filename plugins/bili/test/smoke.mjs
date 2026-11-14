#!/usr/bin/env node
/**
 * 离线冒烟：不联网，只验 MCP 协议面与参数校验。
 *
 *   node test/smoke.mjs
 *
 * 真跑 B 站接口的验证在 test/live.mjs（手动用，不进 CI）。
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });

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
  check(init.result?.serverInfo?.name === 'bili', 'initialize 返回 serverInfo.name=bili');
  check(init.result?.protocolVersion === '2024-11-05', 'protocolVersion 回显客户端版本');
  check(Boolean(init.result?.capabilities?.tools), '声明 tools 能力');

  // 通知不该有回包；发了之后连接仍然可用即算通过
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const list = await rpc('tools/list', {});
  const tools = list.result?.tools || [];
  const names = tools.map((t) => t.name);
  check(names.length === 10, `tools/list 有 10 个工具（实际 ${names.length}）`);
  for (const n of ['hot', 'weekly', 'search', 'video', 'up', 'feed', 'card', 'shot', 'push', 'push_state']) {
    check(names.includes(n), `工具有 ${n}`);
  }
  check(tools.every((t) => t.inputSchema?.type === 'object'), '每个工具都有 object 入参 schema');
  check(tools.filter((t) => t.name !== 'push').every((t) => t.annotations?.readOnlyHint === true),
    '除 push 外都标 readOnlyHint（不往 B 站写东西）');
  check(tools.find((t) => t.name === 'push')?.annotations?.readOnlyHint === false,
    'push 明确不标只读（它会触发宿主主动发消息）');

  const ping = await rpc('ping', {});
  check(ping.result && Object.keys(ping.result).length === 0, 'ping 回空结果');

  // 参数校验发生在联网之前，所以下面两条都是离线可验的
  const badArg = await rpc('tools/call', { name: 'search', arguments: { keywrod: '猫' } });
  check(badArg.result?.isError === true && /不认识的参数/.test(badArg.result.content[0].text), '未知参数被拒（且给出原因）');

  const noArg = await rpc('tools/call', { name: 'up', arguments: {} });
  check(noArg.result?.isError === true && /UID|昵称/.test(noArg.result.content[0].text), '缺参数时给中文提示');

  // 0.3 的三个新工具：只验离线能跑到的那一层（参数校验 / 未开定时刷的提示）
  const noLink = await rpc('tools/call', { name: 'card', arguments: {} });
  check(noLink.result?.isError === true && /没认出视频号|link/.test(noLink.result.content[0].text), 'card 缺 link 时给中文原因');

  const shotArg = await rpc('tools/call', { name: 'shot', arguments: { link: 'BV1ZAWM61Evb', att: 30 } });
  check(shotArg.result?.isError === true && /不认识的参数/.test(shotArg.result.content[0].text), 'shot 的未知参数被拒');

  const feedOff = await rpc('tools/call', { name: 'feed', arguments: {} });
  check(feedOff.result?.isError !== true && /定时刷没开/.test(feedOff.result.content[0].text), 'feed 没开时是可读提示，不是错误');

  // 0.4：开关全关时也能自检，不该因为没有令牌就报错
  const pushState = await rpc('tools/call', { name: 'push_state', arguments: {} });
  check(pushState.result?.isError !== true && /开着的开关|通道/.test(pushState.result.content[0].text),
    'push_state 离线可读（开关、额度、上一轮结果）');

  const pushOff = await rpc('tools/call', { name: 'push', arguments: {} });
  check(pushOff.result?.isError !== true && /最近没刷到|没投出去|投进/.test(pushOff.result.content[0].text),
    'push 在默认配置下给可读提示，不是崩');

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

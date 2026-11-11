#!/usr/bin/env node
/**
 * 离线冒烟：不联网、不依赖宿主，只验协议面与五个工具的基本行为。
 *
 *   node test/smoke.mjs
 *
 * remember / whoami 在没有宿主的环境里**应该失败**，这里验的是它们失败得
 * 够清楚（有中文原因 + 下一步），而不是假装成功。
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'pipe'],
  // 刻意清掉宿主变量：模拟「本地手动跑」，验证降级路径
  env: { ...process.env, ROOST_API_TOKEN: '', ROOST_API_URL: '' },
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
    try { msg = JSON.parse(line); } catch {
      console.error('✗ stdout 出现了非 JSON（协议通道被污染）：', line.slice(0, 120));
      process.exit(1);
    }
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

const call = (name, args = {}) => rpc('tools/call', { name, arguments: args }).then((m) => m.result);

const fail = [];
const check = (cond, label) => {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) fail.push(label);
};

try {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  check(init.result?.serverInfo?.name === 'demo-ext', 'initialize 返回 serverInfo.name=demo-ext');
  check(init.result?.protocolVersion === '2024-11-05', 'protocolVersion 回显客户端版本');

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const list = await rpc('tools/list', {});
  const names = (list.result?.tools || []).map((t) => t.name);
  check(names.length === 5, `tools/list 有 5 个工具（实际 ${names.length}）`);
  for (const n of ['echo', 'now', 'dice', 'remember', 'whoami']) check(names.includes(n), `工具有 ${n}`);
  check((list.result?.tools || []).every((t) => t.annotations?.readOnlyHint !== undefined), '每个工具都标了 readOnlyHint');

  const ping = await rpc('ping', {});
  check(ping.result && Object.keys(ping.result).length === 0, 'ping 回空结果');

  const echo = await call('echo', { text: '你好，扩展' });
  check(!echo.isError && echo.content[0].text.includes('字数：5'), 'echo 回显并数出字数');

  const dice = await call('dice', { sides: 6, count: 3 });
  check(!dice.isError && /^3d6：/.test(dice.content[0].text), 'dice 返回 3d6 格式');

  const badSides = await call('dice', { sides: 1 });
  check(badSides.isError && /2–1000/.test(badSides.content[0].text), 'dice 越界时给范围提示（而不是崩）');

  const typo = await call('echo', { txt: '写错字段名' });
  check(typo.isError && /不认识的参数/.test(typo.content[0].text), '未知参数被拒并指出名字');

  const empty = await call('echo', {});
  check(empty.isError && /text 是空的/.test(empty.content[0].text), '缺必填参数时给中文原因');

  const now = await call('now', {});
  check(!now.isError && /（时区 /.test(now.content[0].text), 'now 带上本机时区');

  const iso = await call('now', { format: 'iso' });
  check(!iso.isError && /T.*Z$/.test(iso.content[0].text), 'now format=iso 返回 ISO 时间');

  const badTz = await call('now', { timeZone: 'Mars/Olympus' });
  check(badTz.isError && /不认识的时区/.test(badTz.content[0].text), '时区写错时给可改对的提示');

  const who = await call('whoami');
  check(who.isError && /ROOST_API_URL/.test(who.content[0].text), '没有宿主时 whoami 说清楚缺什么');

  const remember = await call('remember', { text: '一句测试' });
  check(remember.isError && /ROOST_API_URL/.test(remember.content[0].text), '没有宿主时 remember 说清楚缺什么');

  const unknown = await call('nope');
  check(unknown.isError && /没有工具/.test(unknown.content[0].text), '不存在的工具返回 isError');

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
  if (stderr.length) console.error('stderr:\n' + stderr.join('').slice(-600));
  process.exitCode = 1;
} else {
  console.log('\n✓ 全部通过');
}

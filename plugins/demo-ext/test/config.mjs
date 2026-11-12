#!/usr/bin/env node
/**
 * 可调设置（`ROOST_EXT_CONFIG`）生效验证。
 *
 *   node test/config.mjs
 *
 * 验两件在真机上最容易「静默失效」的事：
 *  1. 面板存的值真的到了扩展里（不是存了但没人读）；
 *  2. 配置坏掉时扩展仍能起来，只是退回默认 —— 而不是整个扩展装不上。
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 起一个 server，带上指定的宿主 env，返回 rpc 工具。 */
function start(extraEnv) {
  const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ROOST_API_TOKEN: '', ROOST_API_URL: '', ...extraEnv },
  });
  let seq = 0;
  const waiting = new Map();
  let buf = '';
  const stderr = [];

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const done = waiting.get(msg.id);
      if (done) { waiting.delete(msg.id); done(msg); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => stderr.push(c));

  const rpc = (method, params) => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 8000);
      waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };
  const call = async (name, args = {}) => {
    const m = await rpc('tools/call', { name, arguments: args });
    return m.result;
  };
  return { child, rpc, call, stderr, stop: () => child.kill() };
}

const textOf = (result) => (result?.content ?? []).map((c) => c.text ?? '').join('');

const fail = [];
const check = (cond, label) => {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) fail.push(label);
};

const INIT = { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'config', version: '1' } };

// ---- 1. 正常配置：默认值应该被替换 ----
{
  const s = start({
    ROOST_EXT_CONFIG: JSON.stringify({
      echoPrefix: '[[', diceFaces: 20, diceCount: 3, rememberLimit: 25,
    }),
  });
  try {
    const init = await s.rpc('initialize', INIT);
    check(init.result?.serverInfo?.version === '0.1.1', '配置不影响握手（version 0.1.1）');
    s.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const echo = textOf(await s.call('echo', { text: '你好' }));
    check(echo.startsWith('[['), `echo 前缀来自配置（实际：${echo.slice(0, 8)}…）`);
    check(!echo.includes('回显：'), 'echo 没退回默认前缀');

    const dice = textOf(await s.call('dice', {}));
    check(dice.startsWith('3d20：'), `dice 默认面数/个数来自配置（实际：${dice.slice(0, 10)}）`);

    /** 模型显式给参数时仍以模型为准，配置只是默认值 */
    const dice2 = textOf(await s.call('dice', { sides: 6, count: 1 }));
    check(dice2.startsWith('1d6：'), `显式参数优先于配置（实际：${dice2.slice(0, 8)}）`);

    const over = await s.call('remember', { text: 'x'.repeat(30) });
    check(over?.isError === true && textOf(over).includes('别超过 25 字'), '记条字数上限来自配置');

    const who = textOf(await s.call('whoami', {}));
    check(who.includes('演示密钥：未配置'), '没给 secret env 时显示未配置');
  } finally { s.stop(); }
}

// ---- 2. 密钥走独立变量 ----
{
  const s = start({ ROOST_EXT_CONFIG: '{}', ROOST_EXT_SECRET_NOTETOKEN: 'sk-demo' });
  try {
    await s.rpc('initialize', INIT);
    s.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const who = textOf(await s.call('whoami', {}));
    check(who.includes('演示密钥：已配置'), 'secret env 有值时显示已配置');
    check(!who.includes('sk-demo'), '密钥明文不出现在工具输出里');
  } finally { s.stop(); }
}

// ---- 3. 坏配置：能起来，退回默认 ----
{
  const s = start({ ROOST_EXT_CONFIG: '{不是 JSON' });
  try {
    const init = await s.rpc('initialize', INIT);
    check(init.result?.serverInfo?.name === 'demo-ext', '坏配置下仍能完成 initialize');
    s.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const echo = textOf(await s.call('echo', { text: 'hi' }));
    check(echo.startsWith('回显：'), '坏配置退回默认前缀');
    check(s.stderr.join('').includes('不是合法 JSON'), '坏了会在 stderr 说明原因');
  } finally { s.stop(); }
}

console.log(fail.length ? `\n✗ ${fail.length} 项未通过` : '\n✓ 全部通过');
process.exit(fail.length ? 1 : 0);

/**
 * roost-mcp 的冒烟测试：起一个假 Roost，spawn 真的 MCP server，
 * 按协议发几条 JSON-RPC，看它答得对不对。
 *
 * 重点验三件事：
 *   1. 协议形状对不对（initialize / tools/list / tools/call）
 *   2. stdout 里只有 JSON-RPC（混一行日志客户端就崩）
 *   3. 工具执行出错时走 isError，而不是把进程搞挂
 *
 * 跑法：node test/mcp.test.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'index.js');

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

/* ---------------- 假 Roost ---------------- */

const seen = [];
const fake = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/qq/capabilities') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ api: 'sendGroup', risk: 'write', group: '消息·群' }]));
    return;
  }

  if (url.pathname === '/api/qq/call' && req.method === 'POST') {
    let s = '';
    for await (const c of req) s += c;
    const body = JSON.parse(s || '{}');
    seen.push(body);

    if (body.method === 'boom') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '这个接口炸了' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: { id: 'msg-1', method: body.method } }));
    return;
  }

  res.writeHead(404).end();
});

await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const port = fake.address().port;

/* ---------------- 起 MCP server ---------------- */

const child = spawn(process.execPath, [ENTRY], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ROOST_URL: `http://127.0.0.1:${port}`, ROOST_KEY: 'k' },
});

const responses = new Map();
let buf = '';
child.stdout.on('data', (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      responses.set(msg.id, msg);
    } catch {
      ok('stdout 只允许 JSON-RPC', false, `混进了非 JSON：${line.slice(0, 60)}`);
    }
  }
});

let stderr = '';
child.stderr.on('data', (d) => (stderr += String(d)));

const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
const waitFor = async (id, ms = 3000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (responses.has(id)) return responses.get(id);
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
};

/* ---------------- 用例 ---------------- */

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
const init = await waitFor(1);
ok('initialize 有回应', Boolean(init?.result));
ok('initialize 声明了 tools 能力', Boolean(init?.result?.capabilities?.tools));
ok('initialize 报了名字', init?.result?.serverInfo?.name === 'roost-mcp', init?.result?.serverInfo?.name ?? '');

send({ jsonrpc: '2.0', method: 'notifications/initialized' });

send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const list = await waitFor(2);
const names = (list?.result?.tools ?? []).map((t) => t.name);
ok('tools/list 返回工具', names.length >= 5, names.join(','));
ok('工具带 inputSchema', (list?.result?.tools ?? []).every((t) => t.inputSchema?.type === 'object'));
ok('有 qq_send', names.includes('qq_send'));
ok('有 qq_api 兜底', names.includes('qq_api'));

send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'qq_send', arguments: { scene: 'group', target: 'g1', text: '你好' } } });
const sent = await waitFor(3);
ok('qq_send 成功', !sent?.result?.isError && Boolean(sent?.result?.content?.[0]?.text));
ok(
  'qq_send 转成了 sendGroup + __target',
  seen.at(-1)?.method === 'sendGroup' && seen.at(-1)?.args?.__target === 'g1',
  JSON.stringify(seen.at(-1)),
);

send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'qq_capabilities', arguments: {} } });
const caps = await waitFor(4);
ok('qq_capabilities 能取到清单', /sendGroup/.test(caps?.result?.content?.[0]?.text ?? ''));

send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'qq_api', arguments: { method: 'boom' } } });
const boom = await waitFor(5);
ok('工具失败走 isError 而不是崩掉', boom?.result?.isError === true, boom?.result?.content?.[0]?.text ?? '');
ok('失败原因带出来了', /炸了/.test(boom?.result?.content?.[0]?.text ?? ''));

send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } });
const noTool = await waitFor(6);
ok('未知工具返回 JSON-RPC 错误', noTool?.error?.code === -32602, JSON.stringify(noTool?.error ?? {}));

send({ jsonrpc: '2.0', id: 7, method: 'notARealMethod' });
const noMethod = await waitFor(7);
ok('未知方法返回 -32601', noMethod?.error?.code === -32601);

send({ jsonrpc: '2.0', id: 8, method: 'ping' });
const pong = await waitFor(8);
ok('ping 有回应', pong?.result !== undefined);

/* ---------------- 收尾 ---------------- */

child.stdin.end();
child.kill();
await new Promise((r) => fake.close(r));

ok('stderr 里没有崩溃栈', !/TypeError|ReferenceError/.test(stderr), stderr.split('\n')[0] ?? '');

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.log('失败项:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exitCode = 1;
}

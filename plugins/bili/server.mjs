#!/usr/bin/env node
/**
 * bili —— 刷 B 站（标准 MCP server，stdio，零依赖）
 * ================================================
 *
 * 协议只有四件事：`initialize` / `tools/list` / `tools/call` / `ping`。
 * 其它一律标准错误。**日志全部走 stderr**：stdout 是 JSON-RPC 通道，
 * 往里打一行中文就会把整条连接搞坏（这是 MCP server 最常见的翻车点）。
 *
 * 手动联调（不经宿主）：
 *   node server.mjs --call hot '{"limit":3}'
 *   node server.mjs --call video '{"link":"BV1xx"}'
 *   node server.mjs --list
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { BiliError, createBiliApi } from './lib/api.mjs';
import { createToolbox } from './lib/tools.mjs';
import { createUiData } from './lib/ui-data.mjs';

const SERVER = { name: 'bili', version: '0.1.1' };
const log = (m) => process.stderr.write(`[bili] ${m}\n`);
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

/**
 * 可调设置：宿主把面板里保存的**非敏感**值拼成 JSON 放在 `ROOST_EXT_CONFIG`。
 * 解析失败按空配置继续 —— 配置坏了不该让扩展起不来。
 */
const config = (() => {
  try {
    const raw = JSON.parse(String(process.env.ROOST_EXT_CONFIG || '{}'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (e) {
    log(`ROOST_EXT_CONFIG 不是合法 JSON，按空配置启动：${e.message}`);
    return {};
  }
})();

const api = createBiliApi({ log });
const box = createToolbox({ api, log, config });

/**
 * 面板数据（6.1 声明式界面）：宿主只读这个 JSON，不执行这里的任何代码。
 * 写盘时机只有两个，都不额外发请求 —— 见 `lib/ui-data.mjs` 顶部。
 */
/**
 * 扩展自己的目录。用 `fileURLToPath` 而不是 `URL.pathname`：
 * 后者在 Windows 上给 `/C:/...`，而且中文路径会被百分号编码。
 */
const HERE = fileURLToPath(new URL('.', import.meta.url));
const ui = createUiData({ dir: HERE, log });

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg ?? {};

  // 通知（没有 id）不回复。DSH 会发 notifications/initialized，别当错误回。
  if (id === undefined || id === null) {
    if (method && !String(method).startsWith('notifications/')) log(`忽略通知 ${method}`);
    return;
  }

  if (method === 'initialize') {
    return ok(id, {
      // 回客户端请求的版本：官方客户端会按自己那版握手，写死会把新客户端挡回去。
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER,
    });
  }

  if (method === 'ping') return ok(id, {});

  if (method === 'tools/list') return ok(id, { tools: box.tools });

  if (method === 'tools/call') {
    const name = String(params?.name ?? '');
    try {
      const text = await box.call(name, params?.arguments ?? {});
      /** 刚拉过热门就顺手把面板数据刷新一下：零额外请求 */
      if (name === 'hot') ui.fromPool(box.hotPool());
      return ok(id, { content: [{ type: 'text', text: String(text) }] });
    } catch (e) {
      // 业务错误用 isError 而不是 JSON-RPC error：协议层没坏，是这次调用没成，
      // 模型能读到原因并自己决定怎么跟人解释。
      const message = e instanceof BiliError
        ? `${e.message}${e.hint ? `（${e.hint}）` : ''}`
        : `扩展出错了：${e?.message ?? e}`;
      log(`工具 ${name} 失败：${message}`);
      return ok(id, { content: [{ type: 'text', text: message }], isError: true });
    }
  }

  return fail(id, -32601, `没有方法 ${method}`);
}

/* ------------------------------------------------------------------ */
/* 手动调用模式                                                        */
/* ------------------------------------------------------------------ */

async function cli(argv) {
  if (argv.includes('--list')) {
    for (const t of box.tools) console.log(`${t.name}\t${t.description.slice(0, 60)}…`);
    return;
  }
  const i = argv.indexOf('--call');
  if (i < 0) {
    console.error('用法：node server.mjs [--list | --call <tool> <json>]');
    process.exitCode = 2;
    return;
  }
  const name = argv[i + 1];
  let args = {};
  try {
    args = JSON.parse(argv[i + 2] ?? '{}');
  } catch {
    console.error('参数不是合法 JSON');
    process.exitCode = 2;
    return;
  }
  try {
    const text = await box.call(name, args);
    console.log(text);
    console.error(`\n[${Buffer.byteLength(String(text), 'utf8')} 字节]`);
  } catch (e) {
    console.error(`失败：${e?.message ?? e}${e?.hint ? `（${e.hint}）` : ''}`);
    process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ */
/* stdio 主循环                                                        */
/* ------------------------------------------------------------------ */

function serve() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // 坏行忽略：真实 server 也不该因为一行垃圾就退出。
        log('收到一行不是 JSON 的输入，已忽略');
        continue;
      }
      handle(msg).catch((e) => {
        log(`处理 ${msg?.method} 出错：${e?.message ?? e}`);
        if (msg?.id !== undefined) fail(msg.id, -32603, `内部错误：${e?.message ?? e}`);
      });
    }
  });
  process.stdin.on('end', () => process.exit(0));
  // 宿主关掉管道时别抛 EPIPE 栈。
  process.stdout.on('error', () => process.exit(0));
  log(`就绪（${box.tools.length} 个工具）`);

  /**
   * 启动后预热一次面板数据。
   *
   * 放在 `setTimeout` 里、并且吞掉所有错误：这一步失败了不该影响协议握手，
   * 面板那边只会显示「还没有数据文件」，点一下工具就补上了。
   */
  setTimeout(() => {
    box.call('hot', { limit: 8 })
      .then(() => ui.fromPool(box.hotPool()))
      .catch((e) => log(`预热面板数据失败（不影响使用）：${e?.message ?? e}`));
  }, 1200).unref?.();
}

const argv = process.argv.slice(2);
if (argv.length) cli(argv).catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
else serve();

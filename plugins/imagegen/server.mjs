#!/usr/bin/env node
/**
 * imagegen —— 让ta画图（标准 MCP server，stdio，零依赖）
 * ===================================================
 *
 * 协议只有四件事：`initialize` / `tools/list` / `tools/call` / `ping`，
 * 其它一律标准错误。**日志全部走 stderr**：stdout 是 JSON-RPC 通道，
 * 往里打一行中文就会把整条连接搞坏（MCP server 最常见的翻车点）。
 *
 * 手动联调（不经宿主）：
 *   node server.mjs --list
 *   node server.mjs --config              # 打印当前配置摘要（不画图、不花钱）
 *   node server.mjs --call image_list '{"limit":3}'
 *   node server.mjs --call image_gen '{"prompt":"一只橘猫"}'   # 会真花钱
 *
 * ⚠️ 手动 `--call image_gen` 时读的是**当前 shell 的** ROOST_EXT_CONFIG，
 * 不是面板里存的那份。真验证配置请装进宿主里、在 QQ 里让模型调。
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { readConfig, readyProblem } from './lib/config.mjs';
import { textOf } from './lib/errors.mjs';
import { createToolbox, describeConfig } from './lib/tools.mjs';
import { createUiData } from './lib/ui-data.mjs';

const SERVER = { name: 'imagegen', version: '0.1.0' };
const log = (m) => process.stderr.write(`[imagegen] ${m}\n`);
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

/**
 * 扩展自己的目录。用 `fileURLToPath` 而不是 `URL.pathname`：
 * 后者在 Windows 上给 `/C:/...`，中文路径还会被百分号编码。
 * 宿主不给扩展数据目录（只有 ROOST_API_URL / ROOST_EXT_ID / ROOST_LAUNCHER_DIR），
 * 所以画作只能存在自己旁边 —— 反正 `<<image: 路径>>` 只要一个能读到的绝对路径。
 */
const HERE = fileURLToPath(new URL('.', import.meta.url));

const cfg = readConfig(process.env, log);
const ui = createUiData({ dir: HERE, log });
const box = createToolbox({
  cfg,
  dir: HERE,
  log,
  /** 画完/删完顺手刷新面板（复用刚读过的目录，不再发请求） */
  onPaint: (items) => ui.fromGallery(items),
});

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
      // 回客户端请求的版本：官方客户端按自己那版握手，写死会把新客户端挡回去。
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
      /**
       * 没配好时**不让工具消失**：`image_list` / `image_delete` 在没接口的情况下
       * 照样有用（看画作库、清理）。配置检查放在 toolbox 的 `draw()` 里，
       * 只有真要画的时候才拦，并且给出「去哪个面板改」。
       */
      const text = await box.call(name, params?.arguments ?? {});
      return ok(id, { content: [{ type: 'text', text: String(text) }] });
    } catch (e) {
      // 业务错误用 isError 而不是 JSON-RPC error：协议层没坏，是这次调用没成，
      // 模型能读到原因并自己决定怎么跟人解释。
      const message = textOf(e);
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
  if (argv.includes('--config')) {
    const why = readyProblem(cfg);
    console.log(describeConfig(cfg));
    console.log(why ? `⚠ 还画不了：${why}` : '✓ 配置看起来能画（密钥对不对只有真发一次才知道）');
    return;
  }
  const i = argv.indexOf('--call');
  if (i < 0) {
    console.error('用法：node server.mjs [--list | --config | --call <tool> <json>]');
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
  } catch (e) {
    console.error(`失败：${textOf(e)}`);
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
  log(`就绪（${box.tools.length} 个工具，画作存在 ${box.outDir}）`);

  /**
   * 启动时把面板数据刷一遍（读目录，不发请求）。
   * 放在 `setTimeout` 里、并且吞掉所有错误：这一步失败不该影响协议握手，
   * 面板那边只会显示「还没有数据文件」，下次画一张就补上了。
   */
  setTimeout(() => {
    try {
      const { items } = box.gallery(20);
      if (items.length) ui.fromGallery(items);
    } catch (e) {
      log(`预热面板数据失败（不影响使用）：${e?.message ?? e}`);
    }
  }, 300).unref?.();
}

const argv = process.argv.slice(2);
if (argv.length) cli(argv).catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
else serve();

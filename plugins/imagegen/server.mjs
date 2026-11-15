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
 *   node server.mjs --status              # 配置 + 今日用量 + 画作库
 *   node server.mjs --call image_list '{"limit":3}'
 *   node server.mjs --call image_gen '{"prompt":"一只橘猫"}'   # 会真花钱
 *
 * ⚠️ 手动 `--call image_gen` 时读的是**当前 shell 的** ROOST_EXT_CONFIG，
 * 不是面板里存的那份。真验证配置请装进宿主里点面板的「测试生图」。
 */
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { applyLiveConfig, readConfig, readyProblem } from './lib/config.mjs';
import { createLiveConfig } from './lib/live-config.mjs';
import { textOf } from './lib/errors.mjs';
import { createToolbox, describeConfig } from './lib/tools.mjs';
import { createUiData, whenText } from './lib/ui-data.mjs';
import { createGallery } from './lib/gallery.mjs';
import { countToday } from './lib/state.mjs';
import { listPaintings } from './lib/paint.mjs';

const SERVER = { name: 'imagegen', version: '0.2.0' };
const log = (m) => process.stderr.write(`[imagegen] ${m}\n`);
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

/**
 * 扩展自己的目录。用 `fileURLToPath` 而不是 `URL.pathname`：
 * 后者在 Windows 上给 `/C:/...`，中文路径还会被百分号编码。
 */
const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT = join(HERE, 'out');

/**
 * `cfg` 是**活引用**：配置热读会 `Object.assign` 原地改它，
 * toolbox 里所有 `() => cfg.xxx` 的闭包因此立刻看到新值。
 */
const cfg = readConfig(process.env, log);
const ui = createUiData({ dir: HERE, log });
const gal = createGallery({ dir: HERE, log });

/** 面板状态条：只放标量，数组/对象会被宿主透传时 `String()` 掉。 */
function baseMeta() {
  const { total } = listPaintings({ dir: OUT, limit: 1000, cap: 1000 });
  return {
    today: countToday(OUT),
    dailyLimit: Number(cfg.dailyLimit) || 0,
    total,
    ready: readyProblem(cfg) || '配置看起来能画',
  };
}

/**
 * 画完 / 删完 / 面板动作之后刷新两份数据文件。
 *
 * 两个进程都会调这个：MCP 子进程（模型画图）和宿主进程内的面板按钮。
 * `ui.fromGallery()` 会先读回磁盘再合并 meta，`gal.write()` 整份重写数组，
 * 两边不会互相抹掉对方刚写的状态。
 */
function syncPanel(items = [], opts = {}) {
  ui.fromGallery(items, { allowEmpty: opts.allowEmpty !== false });
  gal.write(items);
  const meta = baseMeta();
  if (opts.result) {
    const r = opts.result;
    meta.lastResult = r.path ? '画好了' : '画好了，但没存进画作库';
    meta.lastVia = String(r.via ?? '');
    meta.lastMs = Math.round(Number(r.ms) || 0);
    meta.lastAt = whenText(Date.now());
  }
  ui.setMeta(meta);
}

const box = createToolbox({ cfg, dir: HERE, log, onPaint: syncPanel });

/**
 * 配置热读（0.2）。
 *
 * 面板保存设置后宿主**不会重启这个子进程**（静态 mcp 条目不受
 * `mcpManager.restart()` 治理），只写它自己那两份文件。所以每次工具调用前
 * 直接把最新值读回来，改完设置下一轮就生效，不用重启 DSH。
 */
const refreshConfig = createLiveConfig({
  dataDir: process.env.ROOST_LAUNCHER_DIR,
  id: process.env.ROOST_EXT_ID,
  apply(values, secrets) {
    /** 清空密钥（宿主把 secrets 写成 `{}`）也要生效，见 lib/config.mjs 的说明 */
    applyLiveConfig(cfg, values, secrets, process.env, log);
  },
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
      /** 面板刚改的设置，这次调用就要用上 */
      refreshConfig();
      /**
       * 没配好时**不让工具消失**：`image_list` / `image_send` / `image_delete` /
       * `image_status` 在没接口的情况下照样有用。配置检查放在 `drawOnce()` 里，
       * 只有真要画的时候才拦，并给出「去哪个面板改」。
       */
      const text = await box.call(name, params?.arguments ?? {});
      return ok(id, { content: [{ type: 'text', text: String(text) }] });
    } catch (e) {
      // 业务错误用 isError 而不是 JSON-RPC error：协议层没坏，是这次调用没成。
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
  refreshConfig();
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
  if (argv.includes('--status')) {
    console.log(await box.call('image_status', {}));
    return;
  }
  const i = argv.indexOf('--call');
  if (i < 0) {
    console.error('用法：node server.mjs [--list | --config | --status | --call <tool> <json>]');
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
    console.log(await box.call(name, args));
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
   * 放在 `setTimeout` 里并吞掉所有错误：这一步失败不该影响协议握手。
   * 目录读不到时**不写空行**（会清空面板），只更新状态标量。
   */
  setTimeout(() => {
    try {
      refreshConfig();
      const { items } = listPaintings({ dir: OUT, limit: 50 });
      if (items.length) syncPanel(items, { allowEmpty: true });
      else ui.setMeta(baseMeta());
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

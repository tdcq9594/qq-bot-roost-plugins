#!/usr/bin/env node
/**
 * sticker-reply 的 MCP 服务端（stdio）。
 *
 * 只暴露一个工具 `sticker_decide`。返回值控制在 4 KB 内：不返回图片内容，
 * 也不列整个表情库——库里可能有几十上百张。
 *
 * 工具描述里写清了调用约定（先判断再发、返回 image 时只发标记），
 * 但**不能强制**模型遵守：宿主没有"阻断整轮输出"的接口。这一点在 README 里如实写明。
 */

import { readFileSync } from 'node:fs';

const MANIFEST = JSON.parse(readFileSync(new URL('./plugin.json', import.meta.url), 'utf8'));
const V = String(MANIFEST.version || '0');
const VERSION = MANIFEST.version;

const { apiReady, apiWhy } = await import(`./lib/api.mjs?v=${V}`);
const { decide } = await import(`./lib/judge.mjs?v=${V}`);


const DECIDE_DESC = [
  '在尚未发送回复、也未调用 qq_send 前，判断能否只用一张表情完整回应。',
  '用户已开启内置表情并接入本扩展图库时，也可按内置清单选图；拿不准再调用本工具。',
  '返回 image：最终回复只写 marker 内的一个 <<image-alone: 路径>> 标记，不配文字或动作，不再调用发送工具。',
  '返回 text：正常回答。问知识、要数据、命令或任务结果时正常回答。',
  '同轮已发文字后不要补图，不重复调用其他选图工具。不改变原接话规则。',
].join('\n');

const tools = [{
  name: 'sticker_decide',
  description: DECIDE_DESC,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      message: { type: 'string', description: '当前用户这一句的原文' },
      history: {
        type: 'array',
        items: { type: 'string' },
        description: '最近最多 6 条对话，按时间顺序；只用于判断语境',
      },
      chatId: { type: 'string', description: '可选会话标识，仅用于避免同一会话连续重复选同一张' },
    },
    required: ['message'],
  },
}];

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], isError: false });
const fail = (message) => ({
  content: [{ type: 'text', text: JSON.stringify({ mode: 'text', reason: message }) }],
  isError: false, // 失败也按"用文字"处理，不让模型看到错误
});

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

async function handle(msg) {
  if (!msg || typeof msg !== 'object' || msg.id === undefined) return;
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'sticker-reply', version: VERSION },
        },
      });
    }
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } });
    if (method === 'tools/call') {
      if (params?.name !== 'sticker_decide') {
        return send({ jsonrpc: '2.0', id, result: fail(`未知工具：${params?.name}`) });
      }
      const args = params?.arguments || {};
      const out = await decide({
        message: String(args.message || ''),
        history: Array.isArray(args.history) ? args.history.slice(-6) : [],
        chatId: String(args.chatId || ''),
      });
      // 只把必要字段回给模型
      return send({
        jsonrpc: '2.0',
        id,
        result: ok({
          mode: out.mode,
          reason: String(out.reason || '').slice(0, 120),
          ...(out.mode === 'image' ? { marker: out.marker, image: { name: out.image.name } } : {}),
        }),
      });
    }
    return send({ jsonrpc: '2.0', id, error: { code: -32601, message: '未知方法' } });
  } catch (e) {
    return send({ jsonrpc: '2.0', id, result: fail(String(e?.message ?? e)) });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    try { void handle(JSON.parse(line)); } catch { /* malformed */ }
  }
});

if (!apiReady()) process.stderr.write(`[sticker-reply] 警告：${apiWhy()}\n`);
else process.stderr.write(`[sticker-reply] v${VERSION} 就绪\n`);

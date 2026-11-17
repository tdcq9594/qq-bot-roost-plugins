#!/usr/bin/env node
/**
 * persona-grow 的 MCP 服务端（stdio）—— 版本 3。
 *
 * 与页面动作走**同一套引擎**（`lib/engine.mjs`），不再各自实现一遍。
 *
 * 安全约束：
 *   · 写操作（分析/重置）**只针对当前活跃会话**，模型传来的 chatId 只在其
 *     等于最近活跃群时才被接受。MCP 这一层拿不到「本轮是否 @ 过」，
 *     所以用「当前活跃」当兜底，并把拒绝理由说清楚。
 *   · 预览（commit:false）不写任何状态。
 */

import { readFileSync } from 'node:fs';

const MANIFEST = JSON.parse(readFileSync(new URL('./plugin.json', import.meta.url), 'utf8'));
const V = String(MANIFEST.version || '0');
const VERSION = MANIFEST.version;

const { apiReady, apiWhy } = await import(`./lib/api.mjs?v=${V}`);
const engine = await import(`./lib/engine.mjs?v=${V}`);
const { listGroupsNamed } = await import(`./lib/analyze.mjs?v=${V}`);

const TOOL_DEFS = [
  {
    name: 'persona_growth_status',
    description: '查看当前 QQ 会话的人设成长：已有条目、成熟度、距离下次自动分析还差几轮。只读，不花钱。',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { chatId: { type: 'string', description: '群 openid；留空用最近活跃的群' } },
    },
  },
  {
    name: 'persona_growth_grow_now',
    description: '按最近的真实对话分析一次。commit=false 只预览不写入；默认会写成成长人格并切到这个会话。会消耗模型额度。',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chatId: { type: 'string', description: '必须是当前活跃的群；留空用最近活跃的' },
        commit: { type: 'boolean', description: 'true=落地（默认），false=只预览' },
      },
    },
  },
  {
    name: 'persona_growth_reset',
    description: '清空当前会话的成长并切回原人格（派生人格文件保留，下轮覆盖）。',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { chatId: { type: 'string', description: '必须是当前活跃的群；留空用最近活跃的' } },
    },
  },
];

const tools = TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema }));

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], isError: data?.ok === false });
const fail = (message, extra = {}) => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: false, message, ...extra }) }],
  isError: true,
});

async function call(name, args) {
  try {
    if (name === 'persona_growth_status') {
      const d = await engine.statusOf({ chatId: args?.chatId || '' });
      return ok({ ok: true, ...d, groups: (await listGroupsNamed()).slice(0, 5) });
    }

    if (name === 'persona_growth_grow_now') {
      if (!apiReady()) return fail(`扩展与宿主的连接不可用：${apiWhy()}`);
      const commit = args?.commit !== false;
      const r = await engine.growNow({ chatId: args?.chatId || '', commit });
      if (r.skipped) return ok({ ok: true, skipped: r.skipped, ...r });
      return ok({
        ok: true,
        ...r,
        note: commit
          ? (r.committed ? `已切到「${r.personaId}」` : (r.note || '未新增'))
          : `预览：可新增 ${r.proposed} 条，未写入`,
      });
    }

    if (name === 'persona_growth_reset') {
      const r = await engine.resetChat({ chatId: args?.chatId || '' });
      return r.ok === false ? fail(r.message || '重置失败', r) : ok(r);
    }

    throw new Error(`未知工具：${name}`);
  } catch (e) {
    return fail(String(e?.message ?? e));
  }
}

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
          serverInfo: { name: 'persona-grow', version: VERSION },
        },
      });
    }
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } });
    if (method === 'tools/call') return send({ jsonrpc: '2.0', id, result: await call(params?.name, params?.arguments) });
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
    try { void handle(JSON.parse(line)); } catch { /* malformed request */ }
  }
});

if (!apiReady()) process.stderr.write(`[persona-grow] 警告：${apiWhy()}\n`);
else process.stderr.write(`[persona-grow] v${VERSION} 就绪\n`);

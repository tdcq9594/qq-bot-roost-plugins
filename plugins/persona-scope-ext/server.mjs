#!/usr/bin/env node
/**
 * MCP 服务端（stdio）。
 *
 * 与面板动作共用 `lib/ops.mjs` —— 两边各写一套必然分叉，
 * 最后表现为「面板能建卡、让模型建就报错」。
 */

import { readFileSync } from 'node:fs';

const MANIFEST = JSON.parse(readFileSync(new URL('./plugin.json', import.meta.url), 'utf8'));
const V = String(MANIFEST.version || '0');

const ops = await import(`./lib/ops.mjs?v=${V}`);
const { apiReady, apiWhy } = await import(`./lib/api.mjs?v=${V}`);

const TOOL_DEFS = [
  {
    name: 'persona_scope_list',
    description: '列出人设卡、预设，以及宿主人格库里有哪些人格、当前「按人绑定」的记录。',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        senderId: { type: 'string', description: '可选。某人的 openid，额外回报他实际用哪个人格' },
      },
    },
  },
  {
    name: 'persona_scope_save_card',
    description: '新建或修改一张人设卡（正文按 RP 卡写：角色、性格、说话方式）。不要 id 就是新建。',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'text'],
      properties: {
        id: { type: 'string', description: '改已有卡片时填；新建留空' },
        name: { type: 'string', description: '卡片名' },
        text: { type: 'string', description: '卡片正文' },
        enabled: { type: 'boolean', description: '默认 true' },
        growth: { type: 'boolean', description: '这张卡是否受人设成长影响（叠加该群成长条目），默认 false' },
      },
    },
  },
  {
    name: 'persona_scope_save_preset',
    description: '新建或修改一条预设（附加约束，例如「不要替对方说话」）。启用的预设会接在卡片正文后面一起生成人格。',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'text'],
      properties: {
        id: { type: 'string', description: '改已有预设时填；新建留空' },
        name: { type: 'string', description: '预设名' },
        text: { type: 'string', description: '预设正文' },
        enabled: { type: 'boolean', description: '默认 true；false 表示暂不参与拼装' },
      },
    },
  },
  {
    name: 'persona_scope_apply',
    description: '把某张人设卡（含启用的预设）生成一份宿主人格；给了 openid 就顺带绑给那个人。绑定后他在任何群都用这一套。',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['cardId'],
      properties: {
        cardId: { type: 'string', description: '人设卡 id（来自 persona_scope_list）' },
        openid: { type: 'string', description: '可选。发送者 openid（32 位十六进制）' },
        growthChatId: { type: 'string', description: '可选。要叠加哪个群的成长条目（群 openid）；留空则不叠加' },
        userLabel: { type: 'string', description: '可选。卡片里 {{user}} 要替换成的称呼（默认「对方」）' },
      },
    },
  },
  {
    name: 'persona_scope_repair',
    description: '修复人格库里带 {{占位符}} 的人格（会把它们渲染成纯文本）。这类人格会让整轮没有回复。',
    schema: {
      type: 'object', additionalProperties: false,
      properties: { dryRun: { type: 'boolean', description: 'true = 只报告，不写入' } },
    },
  },
  {
    name: 'persona_scope_clear_growth',
    description: '清除某个群的人设成长（条目与采样归零，保留记录）。会改写 persona-grow 的状态文件并留备份。',
    schema: {
      type: 'object', additionalProperties: false, required: ['chatId'],
      properties: { chatId: { type: 'string', description: '群 openid' } },
    },
  },
  {
    name: 'persona_scope_import',
    description: '从 Roost 插件 persona-scope 的配置里导入人设卡与预设（按 id/名字合并，不覆盖本地独有条目）。',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { replace: { type: 'boolean', description: 'true = 用插件的版本覆盖同 id 条目' } },
    },
  },
  {
    name: 'persona_scope_export',
    description: '把本扩展的人设卡与预设写回 Roost 插件配置（只改 cards/presets，其余设置原样保留，写前自动备份）。',
    schema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'persona_scope_bind',
    description: '把某个人绑到**已存在**的人格上（不一定由本扩展生成）。',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['openid', 'persona'],
      properties: {
        openid: { type: 'string', description: '发送者 openid' },
        persona: { type: 'string', description: '人格 id' },
      },
    },
  },
  {
    name: 'persona_scope_unbind',
    description: '解除「按人绑定」，这个人回到默认人格。',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['openid'],
      properties: { openid: { type: 'string', description: '发送者 openid' } },
    },
  },
];

const tools = TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema }));

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], isError: data?.ok === false });
const fail = (message) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, message }) }], isError: true });

async function callTool(name, args) {
  try {
    if (name === 'persona_scope_list') {
      const local = ops.listAll();
      const host = await ops.statusOf({ senderId: args?.senderId || '' });
      let growth = { installed: false, chats: [] };
      try {
        growth = ops.growthInfo({ bySender: host.bySender, byChat: host.byChat, personas: host.personas });
      } catch { /* 只读旁路 */ }
      let broken = { broken: [] };
      try { broken = await ops.scanBrokenPersonas(); } catch { /* 旁路 */ }
      return ok({ ...local, ...host, growth, interop: ops.interopStatus(), brokenPersonas: broken.broken, api: apiReady() ? 'ok' : apiWhy() });
    }
    if (name === 'persona_scope_save_card') return ok(await ops.saveCard(args));
    if (name === 'persona_scope_save_preset') return ok(await ops.savePreset(args));
    if (name === 'persona_scope_apply') {
      if (!apiReady()) return fail(`扩展与宿主的连接不可用：${apiWhy()}`);
      return ok(await ops.applyCard({ cardId: args?.cardId, openid: args?.openid, growthChatId: args?.growthChatId || '', userLabel: args?.userLabel || '' }));
    }
    if (name === 'persona_scope_repair') return ok(await ops.repairPersonas({ dryRun: args?.dryRun === true }));
    if (name === 'persona_scope_clear_growth') return ok(await ops.clearGrowthOf({ chatId: args?.chatId }));
    if (name === 'persona_scope_import') return ok(await ops.importFromPlugin({ replace: args?.replace === true }));
    if (name === 'persona_scope_export') return ok(await ops.exportToPlugin());
    if (name === 'persona_scope_bind') return ok(await ops.bind({ openid: args?.openid, persona: args?.persona }));
    if (name === 'persona_scope_unbind') return ok(await ops.unbind({ openid: args?.openid }));
    return fail(`未知工具：${name}`);
  } catch (e) {
    return fail(String(e?.message ?? e));
  }
}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

async function handle(msg) {
  if (!msg || typeof msg !== 'object' || msg.id === undefined) return; // 通知类，不回
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: MANIFEST.id, version: String(MANIFEST.version || '0') },
        },
      });
    }
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } });
    if (method === 'tools/call') {
      const r = await callTool(params?.name, params?.arguments ?? {});
      return send({ jsonrpc: '2.0', id, result: r });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `不认识的方法：${method}` } });
  } catch (e) {
    return send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch { /* 单行坏数据不该让整个服务退出 */ }
  }
});
process.stdin.on('end', () => process.exit(0));

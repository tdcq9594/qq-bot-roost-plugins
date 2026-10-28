#!/usr/bin/env node
/**
 * roost-mcp —— 把 Roost 的 QQ 能力暴露成 MCP 工具。
 *
 * 方向跟 ai-chat 插件相反：
 *   ai-chat     「工作台当大脑」——QQ 消息进来，工作台想，插件发出去
 *   roost-mcp   「工作台当手脚」——在 Claude Desktop / Cursor 里说
 *               「帮我在群里发一句」，它调这个 MCP server
 *
 * 走的是 Roost 内核的通用能力通道（`POST /api/qq/call`，v0.8.0 起）：
 * 一个端点覆盖官方 47 个接口，白名单和风险分级在 Roost 那边，这里只负责转发。
 *
 * 零依赖：只用 node 内置的 fetch 和 stdio。
 *
 * 用法（Claude Desktop 的 claude_desktop_config.json）：
 *   { "mcpServers": { "qq": {
 *       "command": "npx", "args": ["-y", "roost-mcp"],
 *       "env": { "ROOST_URL": "http://127.0.0.1:8080", "ROOST_KEY": "面板密钥" }
 *   } } }
 */

import { createInterface } from 'node:readline';

const BASE = String(process.env.ROOST_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const KEY = String(process.env.ROOST_KEY || '');
const BOT = String(process.env.ROOST_BOT || '');

/** 日志必须走 stderr——stdout 是协议通道，混一个字节都会让客户端解析失败 */
const log = (...a) => process.stderr.write(`[roost-mcp] ${a.join(' ')}\n`);

/* ---------------- 调 Roost ---------------- */

/**
 * 鉴权走请求头，不走 query。
 *
 * 以前是 `?key=`：密钥会进反向代理的 access_log、进浏览器历史、
 * 进任何一次抓包。头不会。Roost 两个写法都认，这里优先用安全的那个。
 */
function authHeaders(extra = {}) {
  return { 'content-type': 'application/json', ...(KEY ? { 'X-Access-Key': KEY } : {}), ...extra };
}

async function call(method, args = {}, confirm = false) {
  const body = { method, args };
  if (BOT) body.bot = BOT;
  if (confirm) body.confirm = true;

  const res = await fetch(`${BASE}/api/qq/call`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  const text = await res.text();
  let j = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Roost 返回了非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
  }
  if (!res.ok || j?.ok === false) {
    throw new Error(j?.error || `调用 ${method} 失败（HTTP ${res.status}）`);
  }
  return j?.result ?? j;
}

/* ---------------- 工具定义 ---------------- */

const TOOLS = [
  {
    name: 'qq_send',
    description:
      '在 QQ 里发一条消息。可以发纯文本、Markdown，或者一张图片（给 URL）。'
      + '群聊填 scene=group + 群的 openid；私聊填 scene=c2c + 用户 openid。',
    inputSchema: {
      type: 'object',
      properties: {
        scene: { type: 'string', enum: ['group', 'c2c'], description: '群聊还是私聊' },
        target: { type: 'string', description: '群 openid 或用户 openid' },
        text: { type: 'string', description: '纯文本内容' },
        markdown: { type: 'string', description: 'Markdown 内容，和 text 二选一' },
        imageUrl: { type: 'string', description: '图片 URL，和 text/markdown 三选一' },
      },
      required: ['scene', 'target'],
    },
    async run(a) {
      const method = a.scene === 'c2c' ? 'sendC2C' : 'sendGroup';

      if (a.imageUrl) {
        // uploadMedia(scene, target, opts) —— 三个位置参数
        const up = await call('uploadMedia', {
          __target: a.scene,
          __rest: [a.target, { fileType: 1, url: a.imageUrl }],
        });
        if (!up?.file_info) throw new Error('图片上传没拿到 file_info');
        return call(method, {
          __target: a.target,
          msgType: 7,
          content: ' ',
          media: { file_info: up.file_info },
        });
      }
      if (a.markdown) {
        return call(method, { __target: a.target, markdown: { content: String(a.markdown) } });
      }
      if (!a.text) throw new Error('text / markdown / imageUrl 至少给一个');
      return call(method, { __target: a.target, content: String(a.text) });
    },
  },

  {
    name: 'qq_recall',
    description: '撤回一条机器人自己发的消息。',
    inputSchema: {
      type: 'object',
      properties: {
        scene: { type: 'string', enum: ['group', 'c2c'] },
        target: { type: 'string', description: '群 openid 或用户 openid' },
        messageId: { type: 'string', description: '要撤回的消息 id' },
      },
      required: ['scene', 'target', 'messageId'],
    },
    run: (a) =>
      call(a.scene === 'c2c' ? 'retractC2CMessage' : 'retractGroupMessage', {
        __target: a.target,
        __rest: [a.messageId],
      }),
  },

  {
    name: 'qq_mute',
    description: '群成员禁言 / 解除禁言。需要机器人是群管理员。',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: '群 openid' },
        memberOpenid: { type: 'string', description: '成员的 openid' },
        durationSec: { type: 'number', description: '禁言秒数，0 表示解除' },
      },
      required: ['groupId', 'memberOpenid', 'durationSec'],
    },
    run: (a) =>
      call('muteMembers', {
        __target: a.groupId,
        __rest: [[{ memberOpenid: a.memberOpenid, durationSec: a.durationSec }]],
      }),
  },

  {
    name: 'qq_group_info',
    description: '查群基本信息（群名、人数等）。',
    inputSchema: {
      type: 'object',
      properties: { groupId: { type: 'string', description: '群 openid' } },
      required: ['groupId'],
    },
    run: (a) => call('getGroupInfo', { __target: a.groupId }),
  },

  {
    name: 'qq_capabilities',
    description:
      '列出 Roost 封装了哪些官方接口（方法名、风险等级、限制）。'
      + '不知道有什么能调的时候先看这个。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const res = await fetch(`${BASE}/api/qq/capabilities`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`取能力清单失败（HTTP ${res.status}）`);
      const list = await res.json();
      return { count: Array.isArray(list) ? list.length : 0, endpoints: list };
    },
  },

  {
    name: 'qq_api',
    description:
      '直接调 Roost 封装的其他官方接口。参数用 __target 传第一个位置参数，'
      + '__rest 传后续位置参数，其余键会合成一个对象追加在最后。'
      + '危险操作（踢人、黑名单、审批策略）需要 confirm=true。',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: '方法名，如 createPanel / getGroupMembers' },
        args: { type: 'object', description: '参数对象' },
        confirm: { type: 'boolean', description: '危险操作确认' },
      },
      required: ['method'],
    },
    run: (a) => call(a.method, a.args ?? {}, a.confirm === true),
  },
];

/* ---------------- MCP 协议 ---------------- */

const PROTOCOL = '2024-11-05';

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;

  // 通知类没有 id，不用回
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') log('客户端已初始化');
    return;
  }

  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'roost-mcp', version: '0.1.0' },
        });

      case 'ping':
        return reply(id, {});

      case 'tools/list':
        return reply(id, {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        });

      case 'tools/call': {
        const name = params?.name;
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) return replyError(id, -32602, `没有这个工具：${name}`);
        try {
          const out = await tool.run(params?.arguments ?? {});
          return reply(id, { content: [{ type: 'text', text: JSON.stringify(out ?? {}, null, 2) }] });
        } catch (e) {
          // 工具执行失败按协议用 isError 返回，让模型看到原因而不是崩掉
          return reply(id, { content: [{ type: 'text', text: `出错了：${e.message}` }], isError: true });
        }
      }

      default:
        return replyError(id, -32601, `不认识的方法：${method}`);
    }
  } catch (e) {
    log('处理失败：', e?.message ?? e);
    return replyError(id, -32603, e?.message ?? '内部错误');
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    log('收到非 JSON 的一行，忽略');
    return;
  }
  Promise.resolve(handle(msg)).catch((e) => log('未捕获：', e?.message ?? e));
});

rl.on('close', () => process.exit(0));

log(`就绪：${BASE}${BOT ? `（只操作 ${BOT}）` : ''}`);

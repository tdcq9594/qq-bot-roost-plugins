#!/usr/bin/env node
/**
 * 演示扩展 · 读完这一份，就能写自己的扩展
 * ==========================================
 *
 * 一个扩展 = **一个标准 MCP server** + **一份 plugin.json**。
 * 宿主（DSH）按清单把进程拉起来，按 MCP 协议问「你有什么工具」，
 * 然后把这几个工具以 `mcp__<id>__<tool>` 的名字交给模型。
 *
 * 本文件是可运行的教学，不是 API 清单：
 *   §1 协议   只有四个方法要管：initialize / tools/list / tools/call / ping
 *   §2 工具   五个工具，每个示范一件事（最小 / 默认值 / 校验 / 调宿主 / 只读）
 *   §3 校验   为什么参数要自己校验，以及 isError 和 JSON-RPC error 的区别
 *   §4 边界   stdout 只走协议、日志走 stderr、输出压在 4 KB 内
 *
 * 本地先跑一遍，不用装宿主：
 *   node server.mjs --list
 *   node server.mjs --call echo '{"text":"你好"}'
 *   node server.mjs --call dice '{"sides":6,"count":3}'
 *
 * 装进宿主后，模型看到的是：
 *   mcp__demo-ext__echo / __now / __dice / __remember / __whoami
 *
 * ── 五个工具各自示范什么 ──────────────────────────────────────
 *   echo     最小工具：一个字符串参数，返回一段文本。90% 的扩展从这行开始。
 *   now      无必填参数 + 可选参数 + 默认值：schema 里不写 required 就行。
 *   dice     数字/枚举参数怎么约束，写错了怎么给模型一条**能自己改对**的错误。
 *   remember 调宿主 `/v1`：证明扩展不是孤岛 —— 令牌从环境变量来，scope 决定能调什么。
 *   whoami   只读、无参数：用来一眼确认「我连上宿主了吗、令牌是谁」。
 *
 * ── 三条铁律（违反任何一条都会很难查）──────────────────────────
 *   1. stdout 是协议通道：`console.log` 一行中文就把连接搞坏了，日志一律走 stderr。
 *   2. 进程的 cwd 是扩展自己的目录；env 里只有 ROOST_API_TOKEN / ROOST_API_URL /
 *      ROOST_EXT_ID 三个业务变量（外加 PATH 之类），**没有 HOME / TEMP**。
 *   3. 单次工具输出会被宿主在 4096 字节处硬截断，图片块会被整块丢掉 ——
 *      要返回的东西自己先收口（见 `clamp`）。
 */

import process from 'node:process';

/* ------------------------------------------------------------------ */
/* §0 基础件                                                           */
/* ------------------------------------------------------------------ */

const SERVER = { name: 'demo-ext', version: '0.1.0' };

/** 日志只能走 stderr。stdout 留给 JSON-RPC。 */
const log = (msg) => process.stderr.write(`[demo-ext] ${msg}\n`);

/** 一行一个消息，stdout 写出即「回复」。 */
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

/**
 * 业务错误。抛出它 = 这次调用没成，但协议没坏。
 * 宿主会把它变成 `{ content: [...], isError: true }`，模型能读到原因并自己改。
 */
class ToolError extends Error {
  constructor(message, hint = '') {
    super(message);
    this.name = 'ToolError';
    this.hint = hint;
  }
}

/** 按 UTF-8 字节截断，不切半个汉字（中文一个字 3 字节）。 */
export function clamp(text, max = 3500) {
  const s = String(text ?? '');
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  const mark = '\n…（太长，截断了）';
  const budget = max - Buffer.byteLength(mark, 'utf8');
  let out = '';
  let used = 0;
  for (const ch of Array.from(s)) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (used + n > budget) break;
    out += ch;
    used += n;
  }
  return out + mark;
}

/* ------------------------------------------------------------------ */
/* §1 工具定义                                                         */
/* ------------------------------------------------------------------ */

/**
 * 每个工具的 schema 就是标准 JSON Schema（MCP 用的是 draft-07 的子集）。
 *
 * `description` 是写给**模型**看的：说清楚「什么时候该用」，比说清楚
 * 「这个参数是 string」有用得多。模型不会读你的 README。
 *
 * `annotations.readOnlyHint` 告诉宿主与第三方权限插件「这个工具不改任何东西」，
 * 有些权限策略会拿它做硬否决判断，不标就少一层保护。
 */
const READONLY = Object.freeze({ readOnlyHint: true, openWorldHint: false });

export const TOOLS = [
  {
    name: 'echo',
    description: '把一段文字原样回显，并给出字数。示例扩展的最小工具，用来验证链路通不通。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要回显的文字' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: READONLY,
  },
  {
    name: 'now',
    description: '看现在的本地时间。format=text 给人看（默认），format=iso 给程序看。',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['text', 'iso'], description: '输出格式，默认 text' },
        timeZone: { type: 'string', description: 'IANA 时区，比如 Asia/Shanghai；不填就用本机时区' },
      },
      additionalProperties: false,
    },
    annotations: READONLY,
  },
  {
    name: 'dice',
    description: '掷骰子。演示数字参数的范围约束与参数校验：面数 2–1000，个数 1–10。',
    inputSchema: {
      type: 'object',
      properties: {
        sides: { type: 'integer', minimum: 2, maximum: 1000, description: '几面骰，默认 6' },
        count: { type: 'integer', minimum: 1, maximum: 10, description: '掷几个，默认 1' },
      },
      additionalProperties: false,
    },
    annotations: READONLY,
  },
  {
    name: 'remember',
    description: '把一句话写进这个扩展自己的记忆（ext:demo-ext 命名空间）。演示扩展怎么调宿主 /v1 —— 需要令牌，且只写得进自己的命名空间。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的一句话，建议 50 字以内' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: 'whoami',
    description: '回显宿主认到的令牌身份（扩展 id 与 scope）。用来确认扩展有没有连上宿主、拿到的是哪把令牌。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READONLY,
  },
];

/* ------------------------------------------------------------------ */
/* §2 参数校验                                                         */
/* ------------------------------------------------------------------ */

/**
 * MCP 客户端**不会**替你拒未知字段：模型把 `text` 写成 `txt`，schema 校验
 * 过了（因为没写 required 的字段可以不出现），你的代码拿到 undefined —— 于是
 * 「工具没反应」。所以第一件事永远是：白名单 + 报错。
 */
function argsOf(raw, allowed) {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const unknown = Object.keys(a).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new ToolError(`不认识的参数：${unknown.join('、')}`, `只认：${allowed.join('、')}`);
  }
  return a;
}

function intOf(value, { def, min, max, name }) {
  if (value === undefined || value === null || value === '') return def;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ToolError(`${name} 要是数字，收到的是「${value}」`);
  const t = Math.round(n);
  if (t < min || t > max) throw new ToolError(`${name} 要在 ${min}–${max} 之间，收到 ${t}`);
  return t;
}

/* ------------------------------------------------------------------ */
/* §3 调宿主 /v1                                                       */
/* ------------------------------------------------------------------ */

/**
 * 宿主 launcher 会往这个进程注入三个变量（其它一概不给）：
 *   ROOST_API_TOKEN  这个扩展专属的 Bearer 令牌（明文只在宿主的 secrets/ 里）
 *   ROOST_API_URL    /v1 的基地址，形如 http://127.0.0.1:8123/v1
 *   ROOST_EXT_ID     扩展 id
 *
 * 能调什么由令牌的 scope 决定，写在 plugin.json 的 `scopes` 里；不写就只有
 * `memory:write` + `state:read`。`/v1/say`（替机器人说话）**扩展一律调不了**，
 * 这条是硬拦，不是配置。
 */
const API = String(process.env.ROOST_API_URL || '').replace(/\/+$/, '');
const TOKEN = String(process.env.ROOST_API_TOKEN || '');

async function callHost(path, { method = 'GET', body } = {}) {
  if (!API) throw new ToolError('这个进程没拿到 ROOST_API_URL', '只有在宿主的 MCP 连接里跑才有；手动 --call 时这段必然失败，属正常。');
  if (!TOKEN) throw new ToolError('这个进程没拿到令牌（ROOST_API_TOKEN 是空的）', '宿主里通常是 secrets 缺失：去面板看「扩展鉴权失败」，或重装一次扩展。');

  const r = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });

  let data = null;
  try { data = await r.json(); } catch { /* 非 JSON 就留 null */ }

  if (r.status === 401) throw new ToolError('令牌无效或已吊销（401）', '去面板「扩展 → 已装扩展」看鉴权失败提示，重装可换新令牌。');
  if (r.status === 403) throw new ToolError(`权限不够（403）：${data?.message ?? path}`, '这个端点要的 scope 没在 plugin.json 里声明，或这一步被设计成不开放给扩展。');
  if (!r.ok) throw new ToolError(`宿主返回 ${r.status}：${data?.message ?? '没有说明'}`);
  return data ?? {};
}

/* ------------------------------------------------------------------ */
/* §4 工具实现                                                         */
/* ------------------------------------------------------------------ */

async function toolEcho(raw) {
  const a = argsOf(raw, ['text']);
  const text = String(a.text ?? '');
  if (!text) throw new ToolError('text 是空的', '给一段要回显的文字，比如 {"text":"你好"}');
  return clamp(`回显：${text}\n字数：${Array.from(text).length}`);
}

async function toolNow(raw) {
  const a = argsOf(raw, ['format', 'timeZone']);
  const format = a.format === 'iso' ? 'iso' : 'text';
  const tz = a.timeZone ? String(a.timeZone) : undefined;
  const now = new Date();

  if (format === 'iso') return now.toISOString();

  let text;
  try {
    text = now.toLocaleString('zh-CN', { timeZone: tz, hour12: false });
  } catch {
    // 时区写错是最常见的参数错误：给模型一条能自己改对的话，而不是抛栈。
    throw new ToolError(`不认识的时区「${tz}」`, '用 IANA 名字，比如 Asia/Shanghai、UTC。');
  }
  return `${text}（时区 ${tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
}

async function toolDice(raw) {
  const a = argsOf(raw, ['sides', 'count']);
  const sides = intOf(a.sides, { def: 6, min: 2, max: 1000, name: 'sides' });
  const count = intOf(a.count, { def: 1, min: 1, max: 10, name: 'count' });
  const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
  const sum = rolls.reduce((x, y) => x + y, 0);
  return `${count}d${sides}：${rolls.join(' + ')}${count > 1 ? ` = ${sum}` : ''}`;
}

async function toolRemember(raw) {
  const a = argsOf(raw, ['text']);
  const text = String(a.text ?? '').trim();
  if (!text) throw new ToolError('text 是空的');
  if (Array.from(text).length > 200) throw new ToolError('一句话别超过 200 字', '要记长内容请分几条。');

  // extId 由令牌决定，body 里不传（传了也会被宿主忽略并记 warn）。
  const r = await callHost('/memory/ext.add', { method: 'POST', body: { fact: text } });
  return r.ok
    ? `记下了（命名空间 ext:demo-ext，现在共 ${r.total ?? '?'} 条）`
    : `没记住：${r.message ?? '宿主没说原因'}`;
}

async function toolWhoami() {
  const r = await callHost('/whoami');
  const scopes = Array.isArray(r.scopes) && r.scopes.length ? r.scopes.join('、') : '（无）';
  return `令牌 id：${r.id ?? '?'}\n扩展：${r.extId ?? '（面板发放的客户端令牌，不绑扩展）'}\nscope：${scopes}`;
}

const HANDLERS = {
  echo: toolEcho,
  now: toolNow,
  dice: toolDice,
  remember: toolRemember,
  whoami: toolWhoami,
};

/* ------------------------------------------------------------------ */
/* §5 协议：四个方法                                                   */
/* ------------------------------------------------------------------ */

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg ?? {};

  // 通知（没有 id）不回复。宿主一定会发 notifications/initialized，别当错误回。
  if (id === undefined || id === null) return;

  if (method === 'initialize') {
    return ok(id, {
      // 回客户端请求的版本：写死会把更新一点的客户端挡回去。
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER,
    });
  }

  if (method === 'ping') return ok(id, {});

  if (method === 'tools/list') return ok(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const name = String(params?.name ?? '');
    const handler = HANDLERS[name];
    if (!handler) {
      // 工具不存在属于「协议层没这能力」，用 isError 也行；这里给 JSON-RPC 错误，
      // 是为了让日志里一眼能区分「模型点错名」和「工具自己失败」。
      return ok(id, { content: [{ type: 'text', text: `没有工具 ${name}（有：${Object.keys(HANDLERS).join('、')}）` }], isError: true });
    }
    try {
      const text = await handler(params?.arguments ?? {});
      return ok(id, { content: [{ type: 'text', text: String(text) }] });
    } catch (e) {
      // 业务失败 → isError，模型读得到原因，可以自己改参数重试。
      const message = e instanceof ToolError
        ? `${e.message}${e.hint ? `（${e.hint}）` : ''}`
        : `扩展出错了：${e?.message ?? e}`;
      log(`工具 ${name} 失败：${message}`);
      return ok(id, { content: [{ type: 'text', text: message }], isError: true });
    }
  }

  return fail(id, -32601, `没有方法 ${method}`);
}

/* ------------------------------------------------------------------ */
/* §6 两种运行方式：宿主 stdio / 本地手动                               */
/* ------------------------------------------------------------------ */

async function cli(argv) {
  if (argv.includes('--list')) {
    for (const t of TOOLS) console.log(`${t.name.padEnd(9)} ${t.description.slice(0, 50)}…`);
    return;
  }
  const i = argv.indexOf('--call');
  if (i < 0) {
    console.error('用法：node server.mjs [--list | --call <工具> <json>]');
    process.exitCode = 2;
    return;
  }
  const name = argv[i + 1];
  let args = {};
  try { args = JSON.parse(argv[i + 2] ?? '{}'); } catch {
    console.error('参数不是合法 JSON');
    process.exitCode = 2;
    return;
  }
  try {
    console.log(await HANDLERS[name](args));
  } catch (e) {
    console.error(`失败：${e?.message ?? e}${e?.hint ? `（${e.hint}）` : ''}`);
    process.exitCode = 1;
  }
}

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
      try { msg = JSON.parse(line); } catch {
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
  process.stdout.on('error', () => process.exit(0));
  log(`就绪（${TOOLS.length} 个工具）`);
}

const argv = process.argv.slice(2);
if (argv.length) {
  cli(argv).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
} else {
  serve();
}

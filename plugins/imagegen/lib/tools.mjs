/**
 * 工具面（0.2）：画、看、重发、试、删、自检
 * =========================================
 *
 * **扩展不会自己把图发进聊天**。宿主没给扩展「当前是哪个会话」这个信息
 * （MCP 的工具调用只带 arguments），所以它发不出、也不该猜。
 * 图存到自己目录后把**绝对路径**交给模型，由模型在回复里写
 * `<<image-alone: 路径>>` —— 出站动作层认识这个标记，会按当前会话发出去。
 *
 * 0.2 补了 `image_send`：路径里有中文、空格、盘符，模型手抄容易抄错，
 * 与其让它自己拼，不如给一个「编号 → 现成标记串」的工具，抄一行就行。
 *
 * `drawOnce()` 抽成导出函数，是为了让**面板上的「测试生图」按钮**
 * （跑在宿主进程里）和模型调的工具走同一条链路：同样的配额、同样的
 * 错误文案、同样的落盘与清理，不搞两套行为。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  bytesText, listPaintings, pathOf, prunePaintings, removePainting,
  resolveRef, savePainting,
} from './paint.mjs';
import { PaintError } from './errors.mjs';
import { countToday, refund, spend } from './state.mjs';
import { SIZE_OPTIONS, readyProblem, sizeFor } from './config.mjs';
import { generate } from './providers.mjs';

const TOOLS = [
  {
    name: 'image_gen',
    description:
      '画一张图。对方说「画个 xx」「给我画」「来张图」时用；也可以用来把自己刚才说的画面变成图。'
      + '画完会给你图的**绝对路径**和可直接复制的 `<<image-alone: 路径>>` 标记，'
      + '你必须在回复里把标记原样写出来（想图文同条就用 `<<image: 路径>>`）——不写标记，对方就收不到图。'
      + '画好之后**别描述画面细节**（你看不到自己画了什么），说一句「画好了」之类的就行。'
      + '`shape` 不填就用面板里设的构图；`ref` 只有想「照着之前那张改」时才填。'
      + '画之前可以先说一句「我去画一下」，别让对方干等。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, description: '要画什么。写清主体、动作、风格、光线；越具体越好' },
        shape: { type: 'string', enum: ['square', 'portrait', 'landscape', 'wide'], description: '构图：方 / 竖 / 横 / 宽；不填用设置里的' },
        size: { type: 'string', enum: SIZE_OPTIONS, description: '精确尺寸，如 1024x1536；填了就以它为准' },
        ref: { type: 'string', description: '参考图：画作库里的编号（#1 是最新那张）或文件名。整张画重画时才用' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    /** 会写本地文件、会花钱（按张计费）、每次结果都不同。别为了「看起来无害」写成只读。 */
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
  },
  {
    name: 'image_list',
    description:
      '看画作库里最近画过哪些图（编号 #1 是最新）。对方说「刚才那张再发一次」「你都画过什么」时用。'
      + '要把某一张再发一次，接着调 `image_send` 拿现成的标记串，别自己拼路径。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '要几条，默认 10' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'image_send',
    description:
      '把画作库里的一张图变成能直接写进回复的标记串。'
      + '说「刚才那张再发一次」「把 #2 发我」时用：先用 image_list 看编号，再用这个工具拿标记，'
      + '把返回的整行 `<<image-alone: 路径>>` **原样**写进回复（不改动、不加引号、不拆开）。'
      + '`style: inline` 会换成 `<<image: 路径>>`，图和文字同一条。'
      + '这个工具不画图、不花钱、不写文件，只做一次安全的编号查表。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '画作编号（#1 最新）、「最新」或文件名' },
        style: { type: 'string', enum: ['alone', 'inline'], description: 'alone = 单独发一条图（默认）；inline = 图文同条' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'image_test',
    description:
      '真画一张来验证接口通不通（花一次钱）。**只在要真验证时用**：对方说「生图是不是坏了」'
      + '「试试接口」，或者刚改完配置想确认。会返回走的哪条接口、花了多久、图多大；'
      + '画出来的图**也会存进画作库**，不想留就删掉。'
      + '只是问能力（会不会画、能不能画）不要用这个，先用 image_status 自检（不花钱）——'
      + '那种问题问的是能力，不是接口坏没坏。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '测什么，默认「一只橘猫，简笔画」' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
  },
  {
    name: 'image_delete',
    description:
      '从画作库里删掉一张（只删这个扩展自己目录里的图，删不到别处）。'
      + '必须显式确认：`confirm` 传 true。对方只是说「删了吧」而你还没确认是哪张时，先问一句。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '文件名，或编号 #1 / 最新' },
        confirm: { type: 'boolean', description: '确认删除，必须为 true' },
      },
      required: ['file', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'image_status',
    description:
      '看当前生图设置、今天画了几张、画作库有多少张、备用接口配了几条，以及现在到底能不能画。'
      + '对方问「你能画图吗」「你能画吗」「你还能画吗」「今天画了几张」「生图怎么又坏了」时**先用它**；'
      + '不画图、不花钱、不联网。配置缺什么它会直接说清去哪填。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const TOOL_NAMES = TOOLS.map((t) => t.name);

/** MCP 客户端不替我们拒未知字段：模型写错一个 key 就静默失效，所以这里硬拦。 */
function argsOf(raw, allowed) {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const unknown = Object.keys(a).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new PaintError(`不认识的参数：${unknown.join('、')}（只认 ${allowed.join('、')}）`);
  return a;
}

const pad = (n) => String(n).padStart(2, '0');

/** `2026-11-14 03:15`：工具结果里给人看的时间，别用 ISO 那串。 */
function whenText(ms) {
  if (!ms) return '时间不明';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 配置的人话摘要：出错时第一眼要看的就是「现在到底填了什么」。 */
export function describeConfig(cfg) {
  const where = cfg.provider === 'custom'
    ? `自定义接口 ${cfg.custom?.url || '(没填地址)'}`
    : `OpenAI 兼容 ${cfg.baseUrl ? `${cfg.baseUrl}/images/generations` : '(没填地址)'}`;
  const chain = cfg.fallbackEnabled === false
    ? '备用链已关'
    : cfg.fallbacks?.length ? `备用 ${cfg.fallbacks.length} 条` : '没有备用接口';
  const bits = [
    where,
    `模型 ${cfg.model || '(没填)'}`,
    `默认尺寸 ${cfg.size || SHAPE_TEXT(cfg.shape)}`,
    cfg.apiKey ? '密钥已配置' : '密钥未配置',
    cfg.stylePrompt ? '有固定风格' : '',
    chain,
    `超时 ${cfg.timeoutSec || 120} 秒`,
    cfg.dailyLimit > 0 ? `每日上限 ${cfg.dailyLimit} 张` : '不限量',
    cfg.maxKeep > 0 ? `画作库保留 ${cfg.maxKeep} 张` : '',
  ];
  return bits.filter(Boolean).join(' · ');
}

/** 构图表的中文名（摘要里用，别把 square 直接抛给主人看）。 */
function SHAPE_TEXT(shape) {
  return { square: '方', portrait: '竖', landscape: '横', wide: '宽' }[shape] ?? '方';
}

/**
 * 画一张：校验 → 参考图 → 配额 → 请求 → 落盘 → 清理 → 刷新面板。
 *
 * 导出给 `ui/main.mjs` 的「测试生图」按钮复用，两边共用同一套配额与错误文案。
 *
 * @returns {Promise<{file:string, path:string, bytes:number, via:string, ms:number,
 *                    prompt:string, size:string, left:number, usedRef:boolean}>}
 */
export async function drawOnce({
  cfg, dir, prompt, shape = '', size = '', ref = '',
  gen = generate, fetchImpl, log = () => {}, now = () => new Date(), onPaint = null,
}) {
  const outDir = join(dir, 'out');
  const text = String(prompt ?? '').trim();
  if (!text) throw new PaintError('prompt 是空的', { hint: '说要画什么' });
  /**
   * 没配置就别发请求，但要先说清缺什么。
   * 这条检查放在**参数校验之后**：模型把参数写错时，
   * 「不认识的参数 promt」比「还没填服务地址」有用得多。
   */
  const why = readyProblem(cfg);
  if (why) throw new PaintError(why, { hint: '面板「让ta画图」里填好就能画' });

  let image = null;
  if (ref) {
    if (!cfg.img2img) throw new PaintError('参考图功能关着', { hint: '面板「让ta画图」里打开「参考图改画」' });
    const hit = resolveRef({ dir: outDir, ref });
    if (!hit?.path) throw new PaintError(`画作库里没有「${ref}」这张`, { hint: '先用 image_list 看编号' });
    image = readFileSync(hit.path);
  }

  const size2 = sizeFor(cfg, { shape, size });
  const full = [cfg.stylePrompt, text].filter(Boolean).join('，');

  /** 先扣后画：工具调用是并发进来的，先查后扣会双花。画失败在下面退回。 */
  const quota = spend(outDir, { limit: cfg.dailyLimit, now: now() });
  if (!quota.ok) {
    throw new PaintError(`今天已经画了 ${quota.count} 张，到上限了`, {
      hint: `面板里能改「每天最多几张」（现在是 ${quota.limit}）`,
    });
  }

  let made;
  try {
    made = await gen({
      cfg: { ...cfg, size: size2 },
      prompt: full,
      image,
      fetchImpl,
      log,
      timeoutMs: Number(cfg.timeoutSec) > 0 ? Number(cfg.timeoutSec) * 1000 : undefined,
    });
  } catch (e) {
    refund(outDir, { now: now() });
    throw e;
  }

  const file = savePainting({ dir: outDir, buf: made.buf, prompt: text, now: now() });
  const path = file ? pathOf(outDir, file) : '';
  if (!path) log('图没存下来（不影响这次发送，画作库里会缺这一张）');

  /** 保留上限：只删自己按时间戳命名的文件，主人手动放进去的图不动 */
  if (Number(cfg.maxKeep) > 0) {
    try { prunePaintings({ dir: outDir, maxKeep: cfg.maxKeep }); } catch { /* 清理失败不影响这次出图 */ }
  }

  if (onPaint) {
    try {
      onPaint(listPaintings({ dir: outDir, limit: 50 }).items, {
        allowEmpty: true,
        result: { via: made.via, ms: made.ms, bytes: made.buf.length, path },
      });
    } catch { /* 面板刷新失败不影响生图 */ }
  }
  return {
    file, path, bytes: made.buf.length, via: made.via, ms: made.ms,
    prompt: text, size: size2, left: quota.left, usedRef: Boolean(image),
  };
}

/** 编号 → 可直接写进回复的标记串。路径只从画作库查表得到，不接受外部路径。 */
export function markerOf({ dir, ref, style = 'alone' } = {}) {
  const hit = resolveRef({ dir, ref });
  if (!hit?.path) throw new PaintError(`画作库里没有「${ref}」这张`, { hint: '先用 image_list 看编号' });
  const tag = style === 'inline' ? 'image' : 'image-alone';
  return { marker: `<<${tag}: ${hit.path}>>`, path: hit.path, file: hit.file };
}

/**
 * @param {object} o
 * @param {object} o.cfg        `readConfig()` 的结果（活引用，面板改了会原地更新）
 * @param {string} o.dir        扩展自己的目录（画作存 `<dir>/out`）
 * @param {(m:string)=>void} [o.log]
 * @param {() => Date} [o.now]
 * @param {(items:object[])=>void} [o.onPaint] 画完/删完后回调，给面板数据用
 * @param {Function} [o.gen] 生图实现，默认 `providers.generate`（测试可换成假的）
 */
export function createToolbox({ cfg, dir, fetchImpl, log = () => {}, now = () => new Date(), onPaint = null, gen = generate }) {
  const outDir = join(dir, 'out');
  const gallery = (limit = 10) => listPaintings({ dir: outDir, limit });
  const draw = (args) => drawOnce({
    cfg, dir, fetchImpl, log, now, onPaint, gen,
    prompt: args.prompt, shape: args.shape, size: args.size, ref: args.ref,
  });

  const handlers = {
    async image_gen(args) {
      const a = argsOf(args, ['prompt', 'shape', 'size', 'ref']);
      const r = await draw(a);
      const head = r.path
        ? `画好了：${r.path}`
        : '画好了，但**没能存进画作库**（存盘失败），这张发不出去了——再画一次试试。';
      const info = `${r.size} · ${bytesText(r.bytes)} · 用时 ${(r.ms / 1000).toFixed(1)} 秒 · ${r.via}`;
      const tail = r.left >= 0 ? `今天还能画 ${r.left} 张。` : '';
      const how = r.path
        ? `\n把它发给对方：回复里原样写 <<image-alone: ${r.path}>>（想跟文字同一条就用 <<image: ${r.path}>>）`
        : '';
      return `${head}${how}\n${info}${tail ? `\n${tail}` : ''}\n画好之后别描述画面细节——你看不到这张图。`;
    },

    async image_list(args) {
      const a = argsOf(args, ['limit']);
      const n = Math.min(50, Math.max(1, Math.round(Number(a.limit) || 10)));
      const { items, total } = gallery(n);
      if (!items.length) return '画作库还是空的：这个扩展还没画过图。用 image_gen 画一张。';
      const lines = items.map((it, i) => `#${i + 1} ${whenText(it.at)} ${it.prompt || '(没记提示词)'} · ${bytesText(it.bytes)}`);
      const today = countToday(outDir, now());
      const quota = cfg.dailyLimit > 0 ? `　今天已画 ${today}/${cfg.dailyLimit} 张` : `　今天已画 ${today} 张`;
      return `画作库最近 ${items.length} 张（共 ${total} 张，${quota}）：\n${lines.join('\n')}\n要重发某张就调 image_send 拿标记串，别自己拼路径。`;
    },

    async image_send(args) {
      const a = argsOf(args, ['file', 'style']);
      const r = markerOf({ dir: outDir, ref: a.file, style: a.style === 'inline' ? 'inline' : 'alone' });
      return [
        `找到了：${r.file}`,
        `把下面这一行**原样**写进回复（别改、别拆、别加引号）：`,
        r.marker,
        a.style === 'inline' ? '图和这句话会同一条发出去。' : '这张图会单独发一条；想图文同条就把 style 换成 inline。',
      ].join('\n');
    },

    async image_test(args) {
      const a = argsOf(args, ['prompt']);
      const prompt = String(a.prompt ?? '').trim() || '一只橘猫，简笔画';
      const r = await draw({ prompt });
      return [
        '接口通了。',
        `配置：${describeConfig(cfg)}`,
        `这次走的是：${r.via}，${r.size}，${bytesText(r.bytes)}，${(r.ms / 1000).toFixed(1)} 秒。`,
        r.path ? `图存在：${r.path}（要发就写 <<image-alone: ${r.path}>>；不想留就 image_delete）` : '图没能存下来。',
      ].join('\n');
    },

    async image_delete(args) {
      const a = argsOf(args, ['file', 'confirm']);
      if (a.confirm !== true) throw new PaintError('没确认就不删', { hint: '先问清楚是哪一张，再传 confirm: true' });
      const hit = resolveRef({ dir: outDir, ref: a.file });
      if (!hit?.file) throw new PaintError(`画作库里没有「${a.file}」`, { hint: '先用 image_list 看编号' });
      const r = removePainting(outDir, hit.file);
      if (r.ok && onPaint) {
        /** 删光最后一张也要让面板变空，所以这里是明确的 allowEmpty 场景 */
        try { onPaint(gallery(50).items, { allowEmpty: true }); } catch { /* 同上 */ }
      }
      return r.ok ? `删掉了：${hit.file}` : `没删成：${r.message}`;
    },

    async image_status(args) {
      argsOf(args, []);
      const { total } = gallery(1);
      const today = countToday(outDir, now());
      const why = readyProblem(cfg);
      const chain = cfg.fallbackEnabled === false
        ? '备用链关着'
        : cfg.fallbacks?.length
          ? cfg.fallbacks.map((f, i) => `备用 ${i + 1} ${f.baseUrl}（${f.model}）`).join('；')
          : '没配备用接口';
      return [
        describeConfig(cfg),
        `今天已画 ${today} 张${cfg.dailyLimit > 0 ? ` / 上限 ${cfg.dailyLimit} 张` : ''}；画作库共 ${total} 张。`,
        `参考图改画：${cfg.img2img ? '开' : '关'}；${chain}。`,
        why ? `⚠ 现在还画不了：${why}` : '✓ 配置看起来能画（密钥对不对只有真发一次才知道）。',
      ].join('\n');
    },
  };

  return {
    tools: TOOLS,
    gallery,
    outDir,
    async call(name, args) {
      const fn = handlers[name];
      if (!fn) throw new PaintError(`没有工具 ${name}`, { hint: `可用：${TOOL_NAMES.join('、')}` });
      log(`调用 ${name} ${JSON.stringify(args ?? {}).slice(0, 160)}`);
      return fn(args);
    },
  };
}

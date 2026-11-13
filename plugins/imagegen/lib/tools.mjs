/**
 * 工具面：画一张、看画过什么、试一次接口、删一张
 * ==============================================
 *
 * **扩展不会自己把图发进聊天**。宿主没给扩展「当前是哪个会话」这个信息
 * （MCP 的工具调用只带 arguments），所以它发不出、也不该猜。
 * 图存到自己目录后把**绝对路径**交给模型，由模型在回复里写
 * `<<image-alone: 路径>>` —— 出站动作层认识这个标记，会按当前会话发出去。
 *
 * 这条链子还有个额外好处：发不发、跟哪句话一起发，由模型按语境决定，
 * 而不是画完就往群里甩一张图。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { bytesText, listPaintings, pathOf, removePainting, resolveRef, savePainting } from './paint.mjs';
import { PaintError } from './errors.mjs';
import { countToday, refund, spend } from './state.mjs';
import { SIZE_OPTIONS, readyProblem, sizeFor } from './config.mjs';
import { generate } from './providers.mjs';

const TOOLS = [
  {
    name: 'image_gen',
    description:
      '画一张图。对方说「画个 xx」「给我画」「来张图」时用；也可以用来把自己刚才说的画面变成图。'
      + '画完会给你图的**绝对路径**，你必须在回复里写 `<<image-alone: 路径>>` 把它发出去'
      + '（想图文同条就用 `<<image: 路径>>`）——不写标记，对方就收不到图。'
      + '画好之后**别描述画面细节**（你看不到自己画了什么），说一句「画好了」之类的就行。'
      + '`shape` 不填就用面板里设的构图；`ref` 只有想「照着之前那张改」时才填。',
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
    /**
     * 会写本地文件、会花钱（按张计费）、每次结果都不同。
     * 注解是给宿主和第三方权限插件看的硬信号，别为了「看起来无害」写成只读。
     */
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
  },
  {
    name: 'image_list',
    description:
      '看画作库里最近画过哪些图（编号 #1 是最新）。对方说「刚才那张再发一次」「你都画过什么」时用。'
      + '返回每一项的编号、时间、当时的提示词、尺寸和路径；要重发就直接在回复里写 `<<image-alone: 路径>>`。',
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
    name: 'image_test',
    description:
      '真画一张来验证接口通不通（花一次钱）。对方说「你能画图吗」「生图是不是坏了」「试试接口」，'
      + '或者你刚改完配置想确认时用。会返回走的哪条接口、花了多久、图多大；'
      + '画出来的图**也会存进画作库**，不想留就删掉。',
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
  const bits = [
    where,
    `模型 ${cfg.model || '(没填)'}`,
    `默认尺寸 ${cfg.size || SHAPE_TEXT(cfg.shape)}`,
    cfg.apiKey ? '密钥已配置' : '密钥未配置',
    cfg.stylePrompt ? '有固定风格' : '',
    cfg.fallbacks?.length ? `备用 ${cfg.fallbacks.length} 条` : '没有备用接口',
    cfg.dailyLimit > 0 ? `每日上限 ${cfg.dailyLimit} 张` : '不限量',
  ];
  return bits.filter(Boolean).join(' · ');
}

/** 构图表的中文名（摘要里用，别把 square 直接抛给主人看）。 */
function SHAPE_TEXT(shape) {
  return { square: '方', portrait: '竖', landscape: '横', wide: '宽' }[shape] ?? '方';
}

/**
 * @param {object} o
 * @param {object} o.cfg        `readConfig()` 的结果
 * @param {string} o.dir        扩展自己的目录（画作存 `<dir>/out`）
 * @param {Function} [o.fetchImpl]
 * @param {(m:string)=>void} [o.log]
 * @param {() => Date} [o.now]
 * @param {(items:object[])=>void} [o.onPaint] 画完/删完后回调，给面板数据用
 * @param {Function} [o.gen] 生图实现，默认 `providers.generate`（测试可换成假的）
 */
export function createToolbox({ cfg, dir, fetchImpl, log = () => {}, now = () => new Date(), onPaint = null, gen = generate }) {
  /** 画作统一放 `out/`：扩展目录里只有它是「数据」，其余是代码 */
  const outDir = join(dir, 'out');
  const gallery = (limit = 10) => listPaintings({ dir: outDir, limit });

  /** 画一张，落盘，返回 {file, path, bytes, via, ms}。 */
  async function draw({ prompt, shape = '', size = '', ref = '' }) {
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

    const quota = spend(outDir, { limit: cfg.dailyLimit, now: now() });
    if (!quota.ok) {
      throw new PaintError(`今天已经画了 ${quota.count} 张，到上限了`, {
        hint: `面板里能改「每天最多几张」（现在是 ${quota.limit}）`,
      });
    }

    let made;
    try {
      made = await gen({ cfg: { ...cfg, size: size2 }, prompt: full, image, fetchImpl, log });
    } catch (e) {
      refund(outDir, { now: now() });
      throw e;
    }

    const file = savePainting({ dir: outDir, buf: made.buf, prompt: text, now: now() });
    const path = file ? pathOf(outDir, file) : '';
    if (!path) log('图没存下来（不影响这次发送，画作库里会缺这一张）');
    if (onPaint) {
      try { onPaint(gallery(20).items); } catch { /* 面板刷新失败不影响这次生图 */ }
    }
    return { file, path, bytes: made.buf.length, via: made.via, ms: made.ms, prompt: text, size: size2, left: quota.left };
  }

  const handlers = {
    async image_gen(args) {
      const a = argsOf(args, ['prompt', 'shape', 'size', 'ref']);
      const r = await draw(a);
      const head = r.path
        ? `画好了：${r.path}`
        : '画好了，但**没能存进画作库**（存盘失败），这张发不出去了——再画一次试试。';
      const info = `${r.size} · ${bytesText(r.bytes)} · 用时 ${(r.ms / 1000).toFixed(1)} 秒 · ${r.via}`;
      const tail = r.left >= 0 ? `今天还能画 ${r.left} 张。` : '';
      const how = r.path ? `\n把它发给对方：回复里写 <<image-alone: ${r.path}>>（想跟文字同一条就用 <<image: ${r.path}>>）` : '';
      return `${head}${how}\n${info}${tail ? `\n${tail}` : ''}\n画好之后别描述画面细节——你看不到这张图。`;
    },

    async image_list(args) {
      const a = argsOf(args, ['limit']);
      const n = Math.min(50, Math.max(1, Math.round(Number(a.limit) || 10)));
      const { items, total } = gallery(n);
      if (!items.length) return '画作库还是空的：这个扩展还没画过图。用 image_gen 画一张。';
      const lines = items.map((it, i) => `#${i + 1} ${whenText(it.at)} ${it.prompt || '(没记提示词)'} · ${bytesText(it.bytes)}\n    路径：${pathOf(outDir, it.file) || it.file}`);
      const today = countToday(outDir, now());
      const quota = cfg.dailyLimit > 0 ? `　今天已画 ${today}/${cfg.dailyLimit} 张` : `　今天已画 ${today} 张`;
      return `画作库最近 ${items.length} 张（共 ${total} 张，${quota}）：\n${lines.join('\n')}`;
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
        try { onPaint(gallery(20).items); } catch { /* 同上 */ }
      }
      return r.ok ? `删掉了：${hit.file}` : `没删成：${r.message}`;
    },
  };

  return {
    tools: TOOLS,
    /** 画完顺手把面板数据刷新一份（零额外请求） */
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

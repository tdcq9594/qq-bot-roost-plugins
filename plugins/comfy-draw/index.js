// 本地绘图（ComfyUI）—— 用你自己电脑上的 ComfyUI 出图，画完直接发到会话。
//
// ── 设计要点（为什么这么写）──────────────────────────────────────────────
//   · 不依赖任何本机特有路径：ComfyUI 装在哪、输出在哪，全部从 Comfy Desktop
//     自己的配置里读（settings.json / installations.json / instance-model-paths），
//     读到了直接用，读不到才让用户在面板手填 —— 「装好就能用」和「特殊环境能覆盖」两头都占。
//   · 只走 HTTP：探测、提交、取图都调 ComfyUI 的公开接口，不 import 它的代码，
//     也不要求和机器人共用同一个 Python 环境。
//   · 串行出图：ComfyUI 一次只画一张，插件这里也只排一条链（enqueue），
//     否则自己的并发会把队列数字搅乱，「前面还有 N 张」就变成假话。
//   · 提示与出图分开走：进度、报错用 say()（立刻发，不攒批），
//     图和尺寸说明用 replyImage —— 两条路各有各的失败方式，别互相拖累。
import fs from 'node:fs';
import {
  resolveConfig,
  resetPathCache,
  ensureService,
  detectArch,
  buildGraph,
  submitAndWait,
  resolveImagePath,
  rememberImage,
  producedImages,
  safePrefix,
  pruneImages,
  getQueue,
  listModelsAll,
  discover,
  discoverPaths,
} from './lib/comfy-engine.js';

/**
 * 插件版本。
 *
 * 注意：`export default` 里的 `version` 必须是**字面量**，不能写成 `version: VERSION`——
 * scripts/check-versions.mjs 和 scripts/build-index.mjs 都用正则读源码，引用常量读不到，
 * CI 会直接判「读不到 version」，索引也生成不出来。所以这里升版本要同步改那一处，
 * test/basic.mjs 会断言两者一致，改漏了本地测试就红。
 */
export const VERSION = '1.0.2';

/** 官方群聊被动回复窗口：从收到消息算起 5 分钟，超了就只能走主动额度。 */
const PASSIVE_WINDOW_MS = 5 * 60 * 1000;
const MAX_COUNT = 4;
const MAX_PROMPT_CHARS = 2000;
const MIN_DIM = 256;
const MAX_DIM = 2560;
const DEFAULT_MAX_IMAGE_MB = 8;

/** 已含质量标签就不再自动补，避免出现 "masterpiece, best quality, masterpiece, ..." */
const QUALITY_TAG = /\b(masterpiece|best quality|good quality|normal quality|absurdres|highres|score_[1-9])\b/i;

/**
 * 「安全出图」附加的负向词。
 *
 * 为什么要有这个开关：图的最终去向是 QQ，而官方接口对图片有机器审核 ——
 * 只发给自己看的人可以关掉。
 */
const SAFE_NEGATIVE = 'nsfw, nude, nipples, explicit, sex, lingerie, cleavage, panties, see-through';

export const DEFAULTS = {
  enabled: true,
  keywords: 'ai绘图',
  modelName: '',
  clipName: '',
  clipName2: '',
  clipType: 'stable_diffusion',
  vaeName: '',
  baseUrl: '',
  autoStart: true,
  comfyDir: '',
  pythonExe: '',
  outputDir: '',
  defaultSize: '',
  steps: 0,
  cfg: 0,
  sampler: 'auto',
  scheduler: 'auto',
  negativePrompt: 'worst quality, low quality, blurry, jpeg artifacts, watermark, signature, text, username',
  autoQualityPrefix: true,
  notifyStart: true,
  caption: true,
  safeMode: true,
  count: 1,
  cooldownSec: 20,
  timeoutMs: 180000,
  startTimeoutMs: 150000,
  maxImageMB: 8,
  filenamePrefix: 'roost',
  keepImages: 200,
};

const clamp = (n, lo, hi) => {
  const v = Number.isFinite(Number(n)) ? Math.round(Number(n)) : lo;
  return Math.min(hi, Math.max(lo, v));
};

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * 取出一个配置项的**值**。
 *
 * 面板给的是值（数字、字符串、布尔），但 `npm run test:plugin` 用的夹具
 * （src/plugin/testkit.js）会把清单里的字段定义原样递进来 —— 那里每个键都是
 * `{ type, default, desc }`。两种形态都认，否则本地一跑全是 [object Object]，
 * 排查时会以为是插件读配置写错了。
 */
function configValue(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && 'default' in v ? v.default : v;
}

/** 每次现读配置 + 兜底：面板保存后立刻生效，不需要重载插件。 */
export function readCfg(ctx) {
  const raw = ctx?.config || {};
  const at = (k) => configValue(raw[k]);
  const pick = (k) => {
    const v = at(k);
    return v === undefined || v === null || v === '' ? DEFAULTS[k] : v;
  };
  return {
    enabled: pick('enabled') !== false,
    keywords: String(pick('keywords') || 'ai绘图'),
    modelName: String(at('modelName') || '').trim(),
    clipName: String(at('clipName') || '').trim(),
    clipName2: String(at('clipName2') || '').trim(),
    clipType: String(pick('clipType') || 'stable_diffusion').trim(),
    vaeName: String(at('vaeName') || '').trim(),
    baseUrl: String(at('baseUrl') || '').trim(),
    autoStart: pick('autoStart') !== false,
    comfyDir: String(at('comfyDir') || '').trim(),
    pythonExe: String(at('pythonExe') || '').trim(),
    outputDir: String(at('outputDir') || '').trim(),
    defaultSize: String(at('defaultSize') || '').trim(),
    steps: clamp(num(at('steps'), 0), 0, 150),
    cfg: clamp(num(at('cfg'), 0), 0, 30),
    sampler: String(pick('sampler') || 'auto'),
    scheduler: String(pick('scheduler') || 'auto'),
    negativePrompt: String(at('negativePrompt') ?? DEFAULTS.negativePrompt),
    autoQualityPrefix: at('autoQualityPrefix') !== false,
    notifyStart: at('notifyStart') !== false,
    caption: at('caption') !== false,
    safeMode: at('safeMode') !== false,
    count: clamp(num(at('count'), 1), 1, MAX_COUNT),
    cooldownSec: clamp(num(at('cooldownSec'), 20), 0, 600),
    timeoutMs: clamp(num(at('timeoutMs'), DEFAULTS.timeoutMs), 30000, 1800000),
    startTimeoutMs: clamp(num(at('startTimeoutMs'), 150000), 30000, 600000),
    maxImageMB: clamp(num(at('maxImageMB'), DEFAULT_MAX_IMAGE_MB), 1, 60),
    filenamePrefix: String(pick('filenamePrefix') || 'roost'),
    keepImages: clamp(num(at('keepImages'), 200), 0, 5000),
  };
}

/** 关键词表：逗号 / 顿号 / 空格都算分隔符。 */
export function parseKeywords(spec) {
  const parts = String(spec || '')
    .split(/[,，、;；|]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return parts.length ? parts : ['ai绘图'];
}

/**
 * 从消息里认出「ai绘图 + 需求」。
 *
 * 认这几种写法：`ai绘图+一只猫`、`ai绘图 一只猫`、`AI绘图：一只猫`、
 * `ai 绘图 一只猫`（关键词中间可以有空格）。关键词后面什么都没有 = 只拿到了
 * 触发词、没拿到需求，交给调用方回用法提示。
 */
export function parseTrigger(text, keywords) {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  for (const kw of keywords) {
    // 关键词里每个字符之间都允许有空白：有人写成「ai 绘图」「ai绘 图」。
    // 逐字符放宽而不是整体放宽，避免把「aid绘图」「ai说绘图」这类误当成触发。
    const pattern = [...kw].map(escapeRe).join('\\s*');
    const re = new RegExp(pattern, 'i');
    const m = re.exec(lower);
    if (!m) continue;
    let rest = raw.slice(m.index + m[0].length);
    // 去掉紧随其后的分隔符与空白（+ ＋ : ： - — 逗号 顿号 括号）
    rest = rest.replace(/^[\s+＋:：,，、\-—~～!！。.()（）[\]【】"“”'']+/, '').trim();
    return { hit: true, keyword: kw, rest };
  }
  return { hit: false, keyword: '', rest: '' };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseSize(raw) {
  const m = /^\s*(\d{2,5})\s*[x×*]\s*(\d{2,5})\s*$/i.exec(String(raw || ''));
  if (!m) return null;
  const wantWidth = Number(m[1]);
  const wantHeight = Number(m[2]);
  const width = clamp(wantWidth, MIN_DIM, MAX_DIM);
  const height = clamp(wantHeight, MIN_DIM, MAX_DIM);
  return {
    width,
    height,
    // 被钳过就把实情带回去：静默把 30000x30000 改成 2560 再画，用户只会觉得
    //「我写的尺寸没生效」或者「插件把参数吃了」，比直接告诉他清楚得多。
    clamped: width !== wantWidth || height !== wantHeight,
    requested: { width: wantWidth, height: wantHeight },
  };
}

export function withQualityPrefix(prompt, enabled) {
  if (!enabled) return prompt;
  if (QUALITY_TAG.test(prompt)) return prompt;
  return `masterpiece, best quality, ${prompt}`;
}

export function humanize(error) {
  if (!error) return '未知错误';
  const msg = String(error.message || error);
  if (/ECONNREFUSED|ECONNRESET/i.test(msg)) {
    return '连不上 ComfyUI（服务没在运行，或端口对不上）。打开 Comfy Desktop 再试，或检查「ComfyUI 地址」';
  }
  if (/ENOENT/i.test(msg)) {
    return '找不到文件或程序路径，请检查设置页里的 ComfyUI 目录 / Python 解释器 / 出图目录';
  }
  if (/fetch failed|socket hang up|other side closed/i.test(msg)) {
    return '与 ComfyUI 的连接中断（它可能刚崩了）。重试一次看看';
  }
  return msg;
}

export function formatModelList(lists, max = 10) {
  const parts = [];
  const ckpt = lists?.checkpoints || [];
  const unet = lists?.unet || [];
  if (ckpt.length) {
    parts.push(`单文件模型 ${ckpt.slice(0, max).join('、')}` + (ckpt.length > max ? ` 等 ${ckpt.length} 个` : ''));
  }
  if (unet.length) {
    parts.push(
      `拆分模型（要另配编码器/VAE）${unet.slice(0, max).join('、')}` +
        (unet.length > max ? ` 等 ${unet.length} 个` : ''),
    );
  }
  return parts.join('；') || '（一个模型都没有）';
}

const defaultConfig = {
  enabled: {
    type: 'boolean',
    default: true,
    label: '启用绘图',
    desc: '总开关；关掉后关键词不再触发，/绘图 也只回一句「已关闭」（状态查询会一起停，这是有意的：关掉就是不响应）',
  },
  keywords: {
    type: 'string',
    default: 'ai绘图',
    label: '触发关键词',
    desc: '消息里出现它就画。写成「ai绘图」时，群友发「ai绘图+一只猫」就会照「一只猫」画。多个关键词用逗号分隔',
  },
  modelName: {
    type: 'string',
    default: '',
    label: '模型文件名',
    desc: '必填。填 ComfyUI 里显示的完整模型名（含扩展名）。填错时会把 ComfyUI 现有的模型名全列出来，照抄即可。单文件 checkpoint 和拆分模型（只有扩散部分的）都支持，脚本自动判断',
  },
  clipName: {
    type: 'string',
    default: '',
    label: '文本编码器（拆分模型才要）',
    desc: '只有「模型文件名」属于拆分模型时才需要填，填 models/text_encoders 里显示的文件名（含扩展名）。单文件 checkpoint 请留空',
  },
  clipName2: {
    type: 'string',
    default: '',
    label: '第二个文本编码器（双编码器才要）',
    desc: 'FLUX / SD3 / SDXL 这类拆分模型要两个编码器，把第二个的文件名填这里；填了会自动改用双编码器加载节点。单编码器模型请留空',
  },
  clipType: {
    type: 'string',
    default: 'stable_diffusion',
    label: 'CLIP 类型（拆分模型才要）',
    desc: 'Qwen-Image 系（含 Anima）用 stable_diffusion，SD3 用 sd3，FLUX 用 flux，Wan 用 wan，SDXL 用 sdxl。拿不准就打开该模型的官方工作流看它的 CLIP 加载节点选的是什么',
  },
  vaeName: {
    type: 'string',
    default: '',
    label: 'VAE（拆分模型才要）',
    desc: '填 models/vae 里显示的文件名（含扩展名）。单文件 checkpoint 请留空',
  },
  baseUrl: {
    type: 'string',
    default: '',
    label: 'ComfyUI 地址',
    desc: '留空 = 自动探测本机 8188~8199（推荐，Comfy Desktop 换端口也能找到）。也可写死，如 http://127.0.0.1:8188',
  },
  autoStart: {
    type: 'boolean',
    default: true,
    label: '自动拉起 ComfyUI',
    desc: '开着时：检测不到 ComfyUI 就在后台静默启动它（约 10~30 秒就绪，无窗口）。关掉则只提示手动启动',
  },
  comfyDir: {
    type: 'string',
    default: '',
    label: 'ComfyUI 程序目录',
    desc: '含 main.py 的目录。留空自动从 Comfy Desktop 的配置里找（推荐）。只有装在非常规位置时才需要手动填',
  },
  pythonExe: {
    type: 'string',
    default: '',
    label: 'Python 解释器',
    desc: '留空自动找 ComfyUI 自带的解释器（.venv 或 standalone-env，推荐）。手动填通常形如 <ComfyUI 目录>\\.venv\\Scripts\\python.exe',
  },
  outputDir: {
    type: 'string',
    default: '',
    label: '出图目录',
    desc: 'ComfyUI 把图画到哪个文件夹，插件就去那里取图。留空自动读 Comfy Desktop 的设置（推荐）。换了便携版 ComfyUI、或提示「出图文件不在了」时，才需要手动指到这里',
  },
  defaultSize: {
    type: 'string',
    default: '',
    label: '默认出图尺寸',
    desc: '格式 宽x高。留空 = 按模型架构自动（单文件模型 1024x1024，拆分模型 832x1216）。也可填 1216x832、1152x1536。宽高建议取 8 的倍数（ComfyUI 的 EmptyLatentImage 会向下取整到 8，812 会变成 808，和标注对不上）。尺寸对某些模型很敏感，出图异常时先换 1024x1024 试',
  },
  steps: {
    type: 'number',
    default: 0,
    min: 0,
    max: 150,
    label: '采样步数',
    desc: '填 0 = 自动（默认 30）。一般 20~50，越高细节越多、越慢',
  },
  cfg: {
    type: 'number',
    default: 0,
    min: 0,
    max: 30,
    label: 'CFG 提示词权重',
    desc: '填 0 = 自动（拆分模型 4，单文件模型 7.5）。普通模型 CFG 太低会出灰糊图，新式拆分模型太高会过曝',
  },
  sampler: {
    type: 'select',
    default: 'auto',
    options: ['auto', 'euler', 'er_sde', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde_gpu', 'dpmpp_sde', 'heun', 'ddim', 'uni_pc'],
    label: '采样器',
    desc: 'auto = 按模型架构自动选（拆分模型 euler，单文件模型 dpmpp_2m）。不确定就留 auto',
  },
  scheduler: {
    type: 'select',
    default: 'auto',
    options: ['auto', 'sgm_uniform', 'karras', 'simple', 'normal', 'beta', 'linear_quadratic', 'exponential'],
    label: '调度器',
    desc: 'auto = 按模型架构自动选（拆分模型 sgm_uniform，单文件模型 karras）',
  },
  negativePrompt: {
    type: 'string',
    default: DEFAULTS.negativePrompt,
    label: '默认负向提示词',
    desc: '每张图都会用。用来压制模糊、水印、文字等常见瑕疵，可按模型喜好调整',
  },
  autoQualityPrefix: {
    type: 'boolean',
    default: true,
    label: '自动补质量标签',
    desc: '开启后，若提示词里没有任何质量标签，自动在最前面补 masterpiece, best quality',
  },
  notifyStart: {
    type: 'boolean',
    default: true,
    label: '画图时先打声招呼',
    desc: '开启后动手画之前先发一句「🎨 画着，稍等」；队列里已有别的任务时会说明「前面还有 N 张在画」。一张要等 30~60 秒，不说一声很容易被当成机器人卡死',
  },
  caption: {
    type: 'boolean',
    default: true,
    label: '图上带一句尺寸说明',
    desc: '默认开。纯图消息（正文为空）更容易被官方接口判成「内容违规」而发不出去，带一句「🎨 832×1216」反而更稳。关掉就只有图',
  },
  safeMode: {
    type: 'boolean',
    default: true,
    label: '安全出图（压擦边）',
    desc: '默认开：自动往负向词里加 nsfw / nude / 露点 等词。官方对图片有机器审核，擦边图会被判「消息内容违规」直接退回，表现是机器人一声不响。关掉后不压擦边，被拦与插件无关',
  },
  count: {
    type: 'number',
    default: 1,
    min: 1,
    max: MAX_COUNT,
    label: '一次画几张',
    desc: '默认 1。多张会明显变慢（排队是按张算的），非必要别超过 2',
  },
  cooldownSec: {
    type: 'number',
    default: 20,
    min: 0,
    max: 600,
    label: '同一会话冷却（秒）',
    desc: '同一群里两次绘图的最短间隔，防刷屏。0 = 不限制',
  },
  timeoutMs: {
    type: 'number',
    default: 180000,
    min: 30000,
    max: 1800000,
    label: '单张出图超时（毫秒）',
    desc: '默认 180000（3 分钟）。为什么不是 5 分钟：官方群聊被动回复窗口只有 5 分钟，而这里等的时间 = 自动拉起（最长 150 秒）+ 排队 + 出图，压到 3 分钟才留得下发送余量。慢机器可以调大，但超过 5 分钟那张图很可能因窗口过期发不出去',
  },
  startTimeoutMs: {
    type: 'number',
    default: 150000,
    min: 30000,
    max: 600000,
    label: '等待启动超时（毫秒）',
    desc: '默认 150000。自动拉起 ComfyUI 后最多等这么久',
  },
  maxImageMB: {
    type: 'number',
    default: 8,
    min: 1,
    max: 60,
    label: '图片体积上限（MB）',
    desc: '默认 8。超过就不发送，避免把协议端搞挂',
  },
  filenamePrefix: {
    type: 'string',
    default: 'roost',
    label: '文件名前缀',
    desc: '本插件生成的图以此前缀命名（默认 roost），清理旧图时只删自己的，不碰你手动画的图。至少 3 个字符、不能含 \\ / : 等路径符号——太短的前缀会撞上别人的图，带斜杠则会写进子目录',
  },
  keepImages: {
    type: 'number',
    default: 200,
    min: 0,
    max: 5000,
    label: '保留旧图数量',
    desc: '默认 200。超出后删最旧的、且是本插件生成过的图（按进程记录，不靠文件名猜）。填 0 = 不清理，自己管',
  },
};

export default {
  id: 'comfy-draw',
  name: '本地绘图 (ComfyUI)',
  version: '1.0.2', // 必须是字面量，与上面的 VERSION 同步（test/basic.mjs 会断言）
  // 市场列表只读 description，且要求「一句话、不超过 60 字」——详细说明留在 README，
  // 这里放长文会让插件市场里出现一大段介绍（build-index.mjs 会原样灌进索引）。
  shortDesc: '用本机 ComfyUI 出图并发到群里',
  description: '发「ai绘图+一只猫」，它就用你电脑上的 ComfyUI 画出来并直接发到会话',
  icon: '🎨',
  frameworkVersion: '>=0.6.13',
  priority: 20,
  config: defaultConfig,

  setup(ctx) {
    const log = ctx.logger;
    const temps = new Map(); // chatId -> 上次出图时间戳
    let stats = { draws: 0, images: 0, failed: 0, last: '', lastCost: 0 };
    let chain = Promise.resolve(); // ComfyUI 串行，这里也串行，别把队列数字搅乱
    let dashboardTimer = null;
    let busy = 0;

    const refreshDashboard = () => {
      if (dashboardTimer) return;
      dashboardTimer = setTimeout(() => {
        dashboardTimer = null;
        try {
          const c = readCfg(ctx);
          ctx.setDashboard?.({
            metrics: [
              { label: '出图次数', value: stats.draws },
              { label: '发出图片', value: stats.images },
              { label: '失败', value: stats.failed },
              { label: '正在画', value: busy },
              { label: '最近用时', value: stats.lastCost ? `${stats.lastCost}s` : '—' },
              { label: '模型', value: c.modelName || '未填' },
              { label: '最近一次', value: stats.last || '—' },
            ],
            note: `关键词「${parseKeywords(c.keywords)[0]}」触发；/绘图 状态 看 ComfyUI 连接`,
          });
        } catch {
          /* 面板不是关键路径 */
        }
      }, 2000);
    };

    /**
     * 发一句话（进度提示 / 报错）。
     *
     * 必须用 replyNow：msg.reply 只是把文本塞进缓冲，等本次处理结束（或下一次
     * flushReplies）才统一发出。出图要几十秒，攒批的提示等于没提示 —— 群里先安静
     * 半分钟，等图发出去那一刻才蹦出一句「画着，稍等」，正好是配置项想避免的场面。
     * replyImage 内部确实会先 flush 一次，但那是「发图之前」的最后一刻，太晚了。
     *
     * 老宿主没有 replyNow 时退回 reply：至少不丢提示，只是又变回攒批。
     * 失败绝不抛 —— 提示发不出去不该把出图一起搞失败。
     */
    const say = async (msg, text) => {
      if (!text) return;
      try {
        if (typeof msg.replyNow === 'function') await msg.replyNow(text);
        else await msg.reply(text);
      } catch (error) {
        log.warn(`提示没发出去（不影响出图）：${humanize(error)}`);
      }
    };

    /** 被动回复窗口还剩多少毫秒（从收到消息算起 5 分钟）。 */
    const windowLeftMs = (msg) =>
      Math.max(0, PASSIVE_WINDOW_MS - (Date.now() - Number(msg.receivedAt || Date.now())));

    /** 串行执行：同一时刻只有一个任务在跑，后面的排队等。 */
    const enqueue = (job) => {
      const run = chain.then(job, job);
      chain = run.catch(() => {});
      return run;
    };

    const sendImages = async (msg, c, images, size, cost, seed) => {
      let sent = 0;
      const problems = [];
      const maxBytes = Math.max(1, c.maxImageMB) * 1024 * 1024;
      // 取图路径必须用「合并了自动发现」的配置：面板里 outputDir 留空时，
      // readCfg 给的是空串，光靠它会拼出相对路径，于是明明画好了却报「文件不在了」。
      const rc = resolveConfig(c);
      for (const img of images) {
        // ComfyUI 返回的 subfolder/filename 是不可信输入（baseUrl 允许填远程地址）：
        // resolveImagePath 会把两段都取 basename，并把结果锁在出图目录里。
        let file = '';
        try {
          file = resolveImagePath(rc, img);
        } catch (error) {
          problems.push(humanize(error));
          continue;
        }
        rememberImage(file);
        let bytes = 0;
        try {
          bytes = fs.statSync(file).size;
        } catch {
          problems.push(`出图文件不在了：${img.filename}（检查「出图目录」是否与 Comfy Desktop 一致）`);
          continue;
        }
        if (bytes > maxBytes) {
          problems.push(
            `${img.filename} 有 ${(bytes / 1048576).toFixed(1)}MB，超过上限 ${c.maxImageMB}MB，没发出来`,
          );
          continue;
        }
        try {
          // 注意：roost 的 replyImage 内部把发送异常**吞掉**了，失败时返回 null 而不是抛错
          // （src/message.js:786-789 只写一条 ERROR 日志）。所以这里必须看返回值，
          // 否则会出现「日志说发出去了、群里却什么都没有」。
          // 带一句极短的正文：纯图消息（正文是空串/空格）在官方接口那边更容易被
          // 判成「内容违规」，塞一句无意义但与图相关的说明反而稳。
          const result = await msg.replyImage(file, {
            local: true,
            text: c.caption ? `🎨 ${size.width}×${size.height}` : '',
          });
          if (!result) {
            // 这里只能说「可能」，因为框架把发送错误码吞在日志里，只回一个 null。
            // 但窗口剩多少是我们自己算得出来的 —— 摊开列原因，比一口咬定「审核违规」
            // 强：窗口过期、主动额度用完、限流、审核，四种情况的处理方式完全不同。
            const left = windowLeftMs(msg);
            const why =
              left <= 0
                ? '被动回复窗口已过期（官方 5 分钟，从收到消息算起）—— 让群友重新发一次最快，重画是白等'
                : `发送被平台拒绝（窗口只剩 ${Math.round(left / 1000)} 秒；也可能是主动额度用完 / 被限流 / 内容审核判违规，具体错误码在日志里）`;
            problems.push(`${why}；图已存在本机：${file}`);
            continue;
          }
          sent += 1;
        } catch (error) {
          problems.push(`${humanize(error)}（图已存本地：${file}）`);
        }
      }
      if (sent) {
        stats.images += sent;
        log.info(`出图并发送 ${sent} 张，用时 ${cost}s（${size.width}x${size.height}，seed=${seed}）`);
        // 只在成功发出去之后清理 —— 失败时那些图还得留着让人手动取回。
        // 第三个参数是「本进程产出过的路径」：清理只认这些，不靠文件名前缀猜。
        try {
          pruneImages(rc, (m) => log.info(m), producedImages());
        } catch {
          /* 清理失败不影响主流程 */
        }
      }
      return { sent, problems };
    };

    /** 真正的画图流程：从关键词到图片落地。 */
    const draw = async (msg, c, prompt, sizeArg, count) => {
      const positive = withQualityPrefix(prompt, c.autoQualityPrefix);
      const negative = [String(c.negativePrompt || '').trim(), c.safeMode ? SAFE_NEGATIVE : '']
        .filter(Boolean)
        .join(', ');
      const startedAt = Date.now();

      const service = await ensureService(resolveConfig(c), (m) => log.info(m));
      if (service.started) log.info(`本轮自动拉起了 ComfyUI：${service.base}`);

      const det = await detectArch(service.base, c.modelName);
      if (det.error) {
        return {
          ok: false,
          text:
            `${det.error}。ComfyUI 里现在有 —— ${formatModelList(det.lists)}。` +
            '到面板「插件 → 本地绘图」把「模型文件名」改成上面列出的名字（要连扩展名一起复制）。' +
            '如果列表是空的，说明模型还没下载到 ComfyUI。',
        };
      }
      if (det.arch === 'split' && (!c.clipName || !c.vaeName)) {
        return {
          ok: false,
          text:
            '这是拆分模型（只有扩散部分），还需要填「文本编码器」和「VAE」两个文件名。' +
            '它们通常在 ComfyUI 的 models/text_encoders 和 models/vae 里。' +
            'FLUX / SD3 / SDXL 这类还要填「第二个文本编码器」和对应的「CLIP 类型」。',
        };
      }

      // 架构已知，这才定最终尺寸：显式指定 > 面板填的 > 按架构给默认值。
      // 拆分模型的默认竖图用 832×1216：宽高都是 8 的倍数，ComfyUI 的
      // EmptyLatentImage 不会偷偷向下取整（812 会被截成 808，出图和标注就对不上）。
      const explicit = parseSize(sizeArg);
      const chosen =
        explicit ||
        parseSize(c.defaultSize) ||
        (det.arch === 'checkpoint'
          ? { width: 1024, height: 1024 }
          : { width: 832, height: 1216 });
      const size = { width: chosen.width, height: chosen.height };
      if (chosen.clamped) {
        await say(
          msg,
          `尺寸 ${chosen.requested.width}×${chosen.requested.height} 超出允许范围，已按 ${size.width}×${size.height} 出图（范围 ${MIN_DIM}~${MAX_DIM}）。`,
        );
      }

      if (c.notifyStart) {
        const q = await getQueue(service.base);
        const ahead = q.running + q.pending;
        await say(msg, ahead > 0 ? `前面还有 ${ahead} 张在画，排队等着` : '🎨 画着，稍等');
      }

      const seed = Math.floor(Math.random() * 4294967295);
      const graph = buildGraph(c, {
        arch: det.arch,
        positive,
        negative,
        width: size.width,
        height: size.height,
        seed,
        // 前缀再过一遍：带斜杠/冒号时 SaveImage 会写进子目录，
        // 清理那边只扫得到顶层，等于永远清不掉。非法就用默认前缀。
        prefix: safePrefix(c.filenamePrefix) || 'roost',
        batchSize: count,
      });
      log.info(`提交出图：${size.width}x${size.height} ×${count} seed=${seed} 架构=${det.arch} ${service.base}`);
      const images = await submitAndWait(service.base, graph, c.timeoutMs, (m) => log.info(m));
      const cost = ((Date.now() - startedAt) / 1000).toFixed(1);

      const { sent, problems } = await sendImages(msg, c, images, size, cost, seed);
      if (!sent) {
        return {
          ok: false,
          text:
            `图画出来了，但一张都没能发出去：${problems.join('；') || '未知原因'}。` +
            '画图本身没白跑（图就在上面那个路径里），别急着重画。' +
            '若是窗口过期就重发一次触发词；若是审核打回，把面板「安全出图」打开、描述写稳一点再试；' +
            '若连一句话都没回，那是发送链路断了，看 logs 里的 message 报错。',
        };
      }
      const notes = problems.length ? `（另有 ${problems.length} 张没能发出：${problems.join('；')}）` : '';
      return { ok: true, text: `画好了 ${sent} 张，用时约 ${cost} 秒${notes}`, cost: Number(cost), size };
    };

    // ── 关键词触发 ────────────────────────────────────────────────────────
    ctx.on('message', async (msg) => {
      const c = readCfg(ctx);
      if (!c.enabled || msg.isBot || msg.isCommand) return;

      const { hit, rest, keyword } = parseTrigger(msg.content, parseKeywords(c.keywords));
      if (!hit) return;

      msg.claim?.('comfy-draw');

      if (!rest) {
        await say(
          msg,
          `要画什么？像这样写：「${keyword}+一只银发少女，黑色和服，樱花背景」。` +
            `想指定尺寸就在后面加 832x1216 这类写法。`,
        );
        return;
      }
      if (rest.length > MAX_PROMPT_CHARS) {
        await say(msg, `描述太长了（${rest.length} 字），压到 ${MAX_PROMPT_CHARS} 字以内再试。`);
        return;
      }

      const now = Date.now();
      const last = temps.get(msg.chatId) || 0;
      if (c.cooldownSec > 0 && now - last < c.cooldownSec * 1000) {
        const wait = Math.ceil((c.cooldownSec * 1000 - (now - last)) / 1000);
        await say(msg, `刚画过，等 ${wait} 秒再画（面板里能改这个冷却）。`);
        return;
      }
      temps.set(msg.chatId, now);
      if (temps.size > 500) {
        for (const [k, v] of temps) if (now - v > 600000) temps.delete(k);
      }

      if (!c.modelName) {
        await say(
          msg,
          '还没填模型文件名。到 DSH 面板「插件 → 本地绘图 (ComfyUI)」把 ComfyUI 里显示的' +
            '模型名（含扩展名）填进「模型文件名」，再试一次。',
        );
        return;
      }

      // 需求里可能顺带写了尺寸，比如「ai绘图+一只猫 832x1216」
      let prompt = rest;
      let sizeArg = '';
      const sizeInPrompt = /(\d{2,5}\s*[x×*]\s*\d{2,5})\s*$/.exec(prompt);
      if (sizeInPrompt && parseSize(sizeInPrompt[1])) {
        sizeArg = sizeInPrompt[1];
        prompt = prompt.slice(0, sizeInPrompt.index).trim();
      }

      stats.draws += 1;
      stats.last = `${msg.userName || msg.userId || '有人'}：${prompt.slice(0, 18)}`;
      busy += 1;
      refreshDashboard();
      try {
        const result = await enqueue(() => draw(msg, c, prompt, sizeArg, c.count));
        if (result.ok) {
          stats.lastCost = result.cost;
          // 成功也要说一句：原来只有图和图上那句尺寸，用户不知道「画了几张、用了多久、
          // 有没有哪张没发出去」。replyNow 才不会等到本轮结束才冒出来。
          await say(msg, result.text);
        } else {
          stats.failed += 1;
          log.warn(`本地绘图失败：${result.text}`);
          await say(msg, `本地绘图失败：${result.text}`);
        }
      } catch (error) {
        stats.failed += 1;
        log.warn(`本地绘图失败：${humanize(error)}`);
        await say(msg, `本地绘图失败：${humanize(error)}`);
      } finally {
        busy -= 1;
        refreshDashboard();
      }
    });

    // ── 命令 ──────────────────────────────────────────────────────────────
    ctx.command('绘图 [操作]', { desc: '本地绘图：状态 / 模型 / 测试 / 清缓存' }, async (msg) => {
      const c = readCfg(ctx);
      const action = String(msg.args?.[0] || '').trim().toLowerCase();

      // 总开关要在这里也生效：配置说明写的是「关掉后都不响应」，
      // 而原来只有关键词分支检查了 enabled，命令分支照样能出图 —— 文档和代码两张皮。
      // 只留一句说明，不暴露状态细节：关掉就是不响应。
      if (!c.enabled) {
        await msg.reply('本地绘图已在面板里关闭。到 DSH 面板「插件 → 本地绘图」把「启用绘图」打开再用。');
        return;
      }

      if (!action) {
        const detected = await discover(resolveConfig(c)).catch(() => null);
        const paths = discoverPaths();
        await msg.reply(
          [
            `本地绘图 v${VERSION}｜${c.enabled ? '已启用' : '已关闭'}`,
            `关键词：${c.keywords}`,
            `模型：${c.modelName || '（未填，去面板填模型文件名）'}`,
            `ComfyUI：${detected ? `${detected.base}（v${detected.version}）` : '没在运行'}`,
            `程序目录：${paths.comfyDir || '（没找到 Comfy Desktop）'}`,
            `出图目录：${c.outputDir || paths.outputDir || '（未知）'}`,
            `尺寸：${c.defaultSize || '自动'}｜步数 ${c.steps || '自动'}｜CFG ${c.cfg || '自动'}｜一次 ${c.count} 张`,
            `累计：出图 ${stats.draws} 次 / 发出 ${stats.images} 张 / 失败 ${stats.failed} 次`,
          ].join('\n'),
        );
        return;
      }

      if (action === '模型' || action === '模型列表') {
        try {
          const service = await ensureService(resolveConfig(c), (m) => log.info(m));
          const lists = await listModelsAll(service.base);
          const line = (label, arr) => `${label}（${arr.length}）：${arr.length ? arr.join('、') : '空'}`;
          await msg.reply(
            [
              `ComfyUI ${service.base}`,
              line('单文件模型 checkpoints', lists.checkpoints),
              line('拆分模型 diffusion_models', lists.unet),
              line('文本编码器 text_encoders', lists.clip),
              line('VAE', lists.vae),
              '',
              '把要用的那个名字（含扩展名）连到面板「模型文件名」里。',
            ].join('\n'),
          );
        } catch (error) {
          await msg.reply(`读模型列表失败：${humanize(error)}`);
        }
        return;
      }

      if (action === '测试') {
        const isAdmin = ctx.isOwner?.(msg.userId) || (await ctx.can(msg, 'admin'));
        if (!isAdmin) {
          await msg.reply('测试会占用显卡，只有群管理能动。');
          return;
        }
        const result = await enqueue(() => draw(msg, c, 'a cat sitting on a windowsill, soft sunlight', '', 1));
        if (result.ok) await say(msg, `测试成功：${result.text}`);
        else await say(msg, `测试失败：${result.text}`);
        return;
      }

      if (action === '清') {
        const isAdmin = ctx.isOwner?.(msg.userId) || (await ctx.can(msg, 'admin'));
        if (!isAdmin) {
          await msg.reply('清理会删文件，只有群管理能动。');
          return;
        }
        resetPathCache();
        const n = pruneImages(resolveConfig(readCfg(ctx)), (m) => log.info(m), producedImages());
        await msg.reply(`已清理 ${n} 张旧图，路径缓存也重置了（下次会重新探测 ComfyUI 目录）。`);
        return;
      }

      await msg.reply('不认识的用法。可用：/绘图、/绘图 模型、/绘图 测试、/绘图 清');
    });

    ctx.menu('本地绘图 (ComfyUI)', [
      { text: 'ai绘图+一只猫', desc: '让机器人用本机 ComfyUI 画出来并直接发到会话（不用 @）' },
      { text: '/绘图', desc: '看状态：模型、ComfyUI 地址、出图目录、累计次数' },
      { text: '/绘图 模型', desc: '列出 ComfyUI 里现成的模型名，填面板时照抄' },
      { text: '/绘图 测试', desc: '用固定提示词画一张，验证链路是否通（管理员）' },
      { text: '/绘图 清', desc: '清理自己生成的旧图并重置路径缓存（管理员）' },
    ]);

    // 启动时把自动发现的路径打出来：装好之后「到底认没认出来」全靠这行，
    // 否则用户只会在第一次画图时吃一个看不懂的报错。
    try {
      const c0 = readCfg(ctx);
      const p = discoverPaths();
      log.info(
        `本地绘图已加载｜ComfyUI ${p.comfyDir || '(未找到 Comfy Desktop)'}` +
          `｜解释器 ${p.pythonExe || '(未找到)'}｜出图目录 ${p.outputDir || '(未知)'}` +
          `｜模型 ${c0.modelName || '(未填)'}｜关键词 ${c0.keywords}`,
      );
      if (!c0.modelName) log.warn('还没填模型文件名：填好之前画图会直接报错（面板「插件 → 本地绘图」）');
    } catch (error) {
      log.warn(`启动自检失败：${humanize(error)}`);
    }
    refreshDashboard();

    ctx.onTeardown?.(() => {
      if (dashboardTimer) clearTimeout(dashboardTimer);
      dashboardTimer = null;
    });
  },
};

export const internals = {
  readCfg,
  parseKeywords,
  parseTrigger,
  parseSize,
  withQualityPrefix,
  formatModelList,
  humanize,
  safePrefix,
  VERSION,
  DEFAULTS,
};

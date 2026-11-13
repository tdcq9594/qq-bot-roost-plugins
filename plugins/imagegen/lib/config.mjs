/**
 * 设置：面板存的两份东西 → 一份能直接用的配置
 * ============================================
 *
 * 宿主把非敏感项拼成 JSON 放进 `ROOST_EXT_CONFIG`，敏感项（这里只有密钥）
 * 按 `ROOST_EXT_SECRET_<KEY>` 单独注入子进程环境。扩展**自己不做持久化**：
 * 存在哪、怎么加密都是宿主的事（`ext-config.js`），扩展只读环境变量。
 *
 * 解析一律「容错到底」：配置坏了不该让扩展起不来。MCP server 起不来，
 * 模型那边看到的是「工具全消失」，用户完全不知道是哪个字段写错了；
 * 而按默认值起、等真调用时再给一句「还没填地址」，问题就落到了人眼能看见的地方。
 * 所以这里出错只往 stderr 写一行，然后继续。
 */

/** 密钥字段名 → env 变量名。与宿主 `ext-config.js` 的 `secretEnvOf()` 同一套规则。 */
export function secretEnv(key) {
  return `ROOST_EXT_SECRET_${String(key).replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}

/** 构图表：只映射「明确选了」的那几种，未选就交给 size 设置。 */
export const SHAPE_SIZE = Object.freeze({
  square: '1024x1024',
  portrait: '1024x1536',
  landscape: '1536x1024',
  wide: '1536x864',
});

/** 面板和工具都能选的尺寸；自定义接口想用别的 WxH 也照收（见 normalizeSize）。 */
export const SIZE_OPTIONS = Object.freeze([
  '512x512', '768x1024', '1024x768', '1024x1024',
  '1024x1536', '1536x1024', '1536x864', '2048x2048', '4096x4096',
]);

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 模型/面板都可能把布尔写成字符串，别让 `=== true` 判空。 */
function boolOf(v, def) {
  if (typeof v === 'boolean') return v;
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (['false', '0', 'no', 'off', '否', '关'].includes(s)) return false;
  if (['true', '1', 'yes', 'on', '是', '开'].includes(s)) return true;
  return def;
}

/** 字符串：去空白、限长（面板已校验，这里防手改 config.json）。 */
function strOf(v, def = '', max = 512) {
  const s = String(v ?? '').trim();
  return (s || def).slice(0, max);
}

/** 整数：越界夹回来，NaN 用默认值。 */
function intOf(v, def, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** `1024×768` / `1024*768` / `1024 x 768` 统一成 `1024x768`；认不出返回空串。 */
export function normalizeSize(value) {
  const s = String(value ?? '').trim().toLowerCase().replace(/[×*]/g, 'x').replace(/\s+/g, '');
  if (!s) return '';
  const m = /^(\d{3,5})x(\d{3,5})$/.exec(s);
  return m ? `${m[1]}x${m[2]}` : '';
}

/**
 * 这次请求实际用哪个尺寸。
 *
 * 优先级：工具显式传的 size > 工具传的构图表 > 设置里的 size > 1024x1024。
 * 构图表里没有的键（比如模型瞎写 `vertical`）一律当没选，**不静默换一个**
 * ——悄悄改尺寸比报错更气人：用户要竖图，拿到方的还得自己再画一次。
 */
export function sizeFor(cfg, { shape = '', size = '' } = {}) {
  const asked = normalizeSize(size);
  if (asked) return asked;
  const byShape = SHAPE_SIZE[String(shape ?? '').trim()];
  if (byShape) return byShape;
  const setSize = normalizeSize(cfg?.size);
  if (setSize) return setSize;
  const bySetting = SHAPE_SIZE[String(cfg?.shape ?? '')];
  return bySetting || SHAPE_SIZE.square;
}

/**
 * 备用接口：每行一个，写成 `地址|模型`（只写地址就沿用主模型）。
 *
 * 为什么用「一行一条」而不是面板里的结构化列表：宿主配置只支持
 * 到 `array<string>`（`ext-config.js` 的 array.items 只能是标量），
 * 没有「对象数组」。用竖线分隔是这里唯一的可用形状，解析时对空格宽容些。
 */
export function parseFallbacks(raw, mainModel = '') {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const one of list) {
    const line = String(one ?? '').trim();
    if (!line) continue;
    const [urlRaw, modelRaw] = line.split('|');
    const baseUrl = String(urlRaw ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(baseUrl)) continue;
    const model = String(modelRaw ?? '').trim() || mainModel;
    if (!model) continue;
    /** 同一地址同一个模型没必要试两次 */
    if (out.some((f) => f.baseUrl === baseUrl && f.model === model)) continue;
    out.push({ baseUrl, model });
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * 自定义接口的参数表：每行 `键=值`，值里可以有 `{prompt}` 之类的占位符。
 * 用 `=` 而不是 `:` —— URL 和 JSON 里冒号太多了，`=` 出现在参数名里的概率近乎零。
 */
export function parseParams(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const one of list) {
    const line = String(one ?? '').trim();
    if (!line) continue;
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (!key) continue;
    out.push({ key, value: line.slice(at + 1).trim() });
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * 把环境变量读成配置。
 *
 * @param {Record<string,string|undefined>} [env] 默认 `process.env`（测试可注入）
 * @param {(m:string)=>void} [log]
 */
export function readConfig(env = process.env, log = () => {}) {
  let raw = {};
  try {
    const parsed = JSON.parse(String(env?.ROOST_EXT_CONFIG || '{}'));
    if (isObj(parsed)) raw = parsed;
    else log('ROOST_EXT_CONFIG 不是对象，按空配置启动');
  } catch (e) {
    log(`ROOST_EXT_CONFIG 不是合法 JSON，按空配置启动：${e?.message ?? e}`);
  }

  const provider = raw.provider === 'custom' ? 'custom' : 'openai';
  const model = strOf(raw.model, 'gpt-image-1', 80);
  const shape = Object.hasOwn(SHAPE_SIZE, String(raw.shape ?? '')) ? String(raw.shape) : 'square';
  const size = normalizeSize(raw.size) || '';

  const cfg = {
    provider,
    baseUrl: strOf(raw.baseUrl, '', 300).replace(/\/+$/, ''),
    /** 只从环境变量读，绝不从 ROOST_EXT_CONFIG 读（那里不该有密钥） */
    apiKey: strOf(env?.[secretEnv('apiKey')], '', 200),
    model,
    shape,
    size,
    stylePrompt: strOf(raw.stylePrompt, '', 200),
    img2img: boolOf(raw.img2img, true),
    /** 0 = 不限；面板给的是「每天最多几张」 */
    dailyLimit: intOf(raw.dailyLimit, 20, 0, 200),
    custom: {
      url: strOf(raw.customUrl, '', 500),
      method: String(raw.customMethod ?? 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST',
      params: parseParams(raw.customParams),
      bodyType: String(raw.customBodyType ?? '').toLowerCase() === 'form' ? 'form' : 'json',
      responsePath: strOf(raw.customResponsePath, '', 120),
    },
    fallbacks: parseFallbacks(raw.fallbacks, model),
  };
  return cfg;
}

/**
 * 当前配置能不能画。
 *
 * 返回空串 = 能；否则是一句人话（会原样进工具结果，所以别写术语）。
 * 刻意**不**在这里判断密钥对不对——那只有真发一次请求才知道，
 * 猜错方向的提示比不给提示更浪费人的时间。
 */
export function readyProblem(cfg) {
  if (cfg?.provider === 'custom') {
    if (!cfg.custom?.url) return '自定义生图接口地址还没填：面板「让ta画图」→ 接口地址';
    return '';
  }
  if (!cfg?.baseUrl) return '还没填生图服务地址：面板「让ta画图」→ 服务地址';
  if (!cfg?.model) return '还没填模型名：面板「让ta画图」→ 模型';
  return '';
}

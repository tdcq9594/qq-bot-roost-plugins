/**
 * weather-card —— 天气播报（Roost 版）
 *
 * 移植自 QQ Agent 的同名插件。功能对齐：
 *   · 问「上海天气」「今天天气怎么样」→ 回一张天气卡图片（一行一个地区）
 *   · 数据源可换：wttr.in（免密钥，默认）/ OpenWeatherMap / 和风天气 / 自建接口
 *   · 今日温度区间、未来三天、逐小时、日出日落、空气质量、宜/不宜 各自独立开关
 *   · 每天定时把天气卡发到指定群
 *   · 暴露 AI 工具 get_weather_card，让模型来调
 *
 * 与原版不同的地方（平台差异，不是功能删减）：
 *   · 渲染：Electron 离屏 → 本机 Edge/Chrome 无头截图（lib/render.js），找不到就回退文字版
 *   · 发图：OneBot → Roost 的 msg.replyImageBuffer / api.sendMedia
 *   · 目标：QQ 号 → 群 openid（官方接口不提供群号，只能填 openid）
 *   · 触发：原版靠 AI 判断；这里额外提供关键词与命令，没接 AI 插件也能用
 *
 * ── 关于 lib/ 的修改与热重载 ───────────────────────────────────
 *
 * 下面的 import **故意不带 `?v=N` 查询串**，lib/ 内部互相引用也不带。
 *
 * 之前入口写了 `./lib/sources.js?v=2`、而 card.js 里写的是 `./sources.js`，
 * 同一个文件因为 specifier 不同被 ESM 当成**两个模块**各实例化一份：
 * sources.js 里 5 个模块级缓存 Map 分成两套，按量计费的缓存命中率凭空减半
 * （同一地区同一小时可能走两条不同缓存路径、多打一次接口）。
 *
 * 而「改 lib 就递增入口的 ?v=N」这个约定本身也修不好它 —— 递增只会让入口重新
 * 加载 render.js，render.js 内部那句 `./png.js` 的 URL 始终不变，照样命中旧模块。
 * 4 个文件互相引用，靠手工递增必然漏。
 *
 * 所以选择：**全链路统一不带查询串**，每个模块全局只有一个实例；
 * 代价是改 lib/ 下任意文件后需要**重启 Roost 进程**，热重载只对 index.js 本身生效。
 * test/module-identity.mjs 会断言「相对 import 不许带查询串」，防止以后又写回去。
 */
import {
  getSource, describe,
} from './lib/sources.js';
import {
  applyDayPrefs, buildWeatherHtml, textCard, cardSummary, rangeText, pageBgOf,
} from './lib/card.js';
import { renderHtmlToPng, findBrowser } from './lib/render.js';

/**
 * 版本号必须是字面量，不能写成 `version: VERSION` ——
 * scripts/check-versions.mjs 用正则读源码，引用常量读不到。升版本要同步改两处。
 */
export const VERSION = '1.0.3';

const MAX_REGIONS = 6;
const PASSIVE_WINDOW_MS = 5 * 60 * 1000;

export const DEFAULTS = {
  enabled: true,
  source: 'wttr',
  apiKey: '',
  apiHost: '',
  todayRange: true,
  forecast: false,
  hourly: true,
  sun: true,
  indices: false,
  air: false,
  dailyRequestLimit: 300,
  apiUrl: '',
  customMap: '',
  customHeaders: '',
  regions: '北京',
  broadcastTime: '',
  broadcastTargets: '',
  theme: 'dark',
  cacheMinutes: 15,
  keywords: '天气',
  cooldownSec: 8,
  browserPath: '',
};

/* ── 配置：每次现读 + 兜底，面板保存后立刻生效 ──────────────────────── */

/**
 * 取一个配置项的**值**。
 * 面板给的是值，但 `npm run test:plugin` 的夹具会把字段定义原样递进来（{type,default,desc}），
 * 两种形态都认，否则本地一跑全是 [object Object]，排查时会以为是读配置写错了。
 */
function configValue(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && 'default' in v ? v.default : v;
}

export function readCfg(ctx) {
  const raw = ctx?.config || {};
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const v = configValue(raw[k]);
    out[k] = v === undefined || v === null ? DEFAULTS[k] : v;
  }
  out.cacheMinutes = Math.max(2, Number(out.cacheMinutes) || 15);
  out.dailyRequestLimit = Math.max(0, Number(out.dailyRequestLimit) || 0);
  out.cooldownSec = Math.max(0, Number(out.cooldownSec) || 0);
  return out;
}

/* ── 解析：坏输入一律降级，不抛错 ─────────────────────────────────── */

/**
 * 地区列表。分隔符放宽：换行 / 逗号（中英）/ 顿号 / 分号（中英）都认。
 * 空格故意不切开，保护「New York」「杭州 西湖」这类带空格的完整地名。
 *
 * **先去重再截断**：反过来写的话 `北京,北京,上海,杭州,成都,武汉,西安` 会先被截成
 * 前 6 个（含重复的北京），去重后只剩 5 个 —— 用户看上去「少了一个地区」，
 * 而且重复项排在前面时越严重。
 */
export function parseRegions(input, fallback = '北京') {
  const SEP = /\r?\n|[,，、;；]+/;
  const arg = String(input ?? '').trim();
  const list = [...new Set(
    (arg ? arg.split(SEP) : String(fallback ?? '北京').split(SEP))
      .map((s) => s.trim()).filter(Boolean),
  )];
  return list.slice(0, MAX_REGIONS);
}

/** 触发关键词（「天气」「天气预报」…），逗号/换行分隔。 */
export function parseKeywords(s) {
  const list = String(s ?? '').split(/\r?\n|[,，、;；\s]+/).map((x) => x.trim()).filter(Boolean);
  return list.length ? list : ['天气'];
}

/** 播报时间：支持多个（"09:30,12:30,21:30"），非法项跳过，规范成 HH:MM。 */
export function parseBroadcastTimes(s) {
  return String(s ?? '')
    .split(/[,，、;；\s]+/)
    .map((x) => x.trim())
    // 必须卡范围：^\d{1,2}:\d{2}$ 会把 "25:99" 也认成合法时间
    .filter((x) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(x))
    // 规范化：去重键要跟用户写法无关，否则 "9:30" 和 "09:30" 会被当成两个点
    .map((x) => {
      const [h, m] = x.split(':');
      return `${String(Number(h)).padStart(2, '0')}:${m}`;
    });
}

/**
 * 播报目标：群 openid。
 * 原版填 QQ 群号（纯数字）；官方接口根本不提供群号，只有 32 位十六进制的 openid，
 * 所以这里按 openid 校验（字母数字，≥16 位），并明确不认纯短数字，免得用户填了群号还以为配好了。
 */
export function parseTargets(s) {
  return String(s ?? '')
    .split(/\r?\n|[,，、;；\s]+/).map((x) => x.trim())
    .filter((x) => /^[A-Za-z0-9_-]{16,64}$/.test(x));
}

const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * 从消息里抠出地区。
 *   「上海天气」→ 上海      「天气 上海」→ 上海      「北京和杭州的天气」→ 北京,杭州
 *   「今天天气怎么样」→ ''（没点名，用默认列表）    「天气」→ ''
 * 点名了才传，没点名返回空串让调用方用设置里的列表。
 */
export function extractRegion(text, keywords = ['天气']) {
  let t = String(text ?? '').trim();
  if (!t) return '';
  // 去掉命令前缀与关键词本身
  t = t.replace(/^[/.\\]+/, '');
  for (const k of [...keywords].sort((a, b) => b.length - a.length)) {
    t = t.split(k).join(' ');
  }
  // 去掉疑问/时间/语气废话，剩下的才可能是地名
  t = t
    .replace(/今天|今日|明天|后天|现在|当前|目前|这几天|未来|最近|实时|怎么样|怎样|如何|咋样|好吗|吗|呢|呀|啊|吧|的|是|查询|查一下|查查|查|看看|看下|看|帮我|请问|请|告诉我|想知道|知道|多少度|几度|温度|预报|会不会下雨|下雨|冷不冷|热不热|适合|洗车/g, ' ')
    .replace(/[?？!！。.,，、;；:：~～]+/g, ' ')
    .trim();
  if (!t) return '';
  // 「北京和杭州」「北京 上海」→ 逗号分隔
  const parts = t.split(/和|与|跟|及|还有|以及|\s+/).map((s) => s.trim()).filter(Boolean);
  // 排除明显不是地名的碎片（单字语气词、纯数字）
  const good = parts.filter((p) => !/^\d+$/.test(p) && p.length <= 12);
  return good.slice(0, MAX_REGIONS).join(',');
}

/**
 * 关键词触发的最长句长。
 *
 * 40 字太宽：聊天里讲一件长事顺口提到「天气」也会弹一张卡，属于打断别人说话。
 * 真实查询都很短 —— 「上海天气」「今天天气怎么样」「明天会下雨吗」都在 10 字以内，
 * 留到 20 字已经能覆盖「明天上海天气适合穿什么衣服」这类带需求的问法，
 * 又能挡住叙述性长句。想放宽就在关键词里写更长的词（等于要求 @ 才触发）。
 */
const MAX_QUERY_CHARS = 20;

/** 这句话是不是在问天气（关键词触发用）。只认「含关键词」，且不是别的命令。 */
export function isWeatherQuery(text, keywords = ['天气']) {
  const t = String(text ?? '').trim();
  if (!t || t.length > MAX_QUERY_CHARS) return false; // 长句多半是聊天里顺口提了一句，别插嘴
  if (/^[/.\\]/.test(t)) return false;   // 命令走命令路由
  return keywords.some((k) => t.includes(k));
}

/* ── 数据获取（带内存缓存 + 每日请求闸门）──────────────────────────── */

/**
 * 每日请求闸门。和风 2025-04-01 起取消免费订阅改按量计费：超 5 万次/月**照常返回数据、
 * 按 ¥0.0007/次 计费，且不拦截**，所以这道闸门是钱包没钱时唯一的硬保护。
 * dailyRequestLimit = 0 表示不限；跨日自动清零；缓存命中不计数。
 */
function quotaState(ctxState) {
  const q = ctxState.quota;
  if (!q || q.day !== localDay()) ctxState.quota = { day: localDay(), used: 0 };
  return ctxState.quota;
}

export function checkDailyQuota(ctxState, limit) {
  const q = quotaState(ctxState);
  if (limit > 0 && q.used >= limit) {
    throw new Error(`今日天气请求已达上限（${q.used}/${limit} 次），为控制按量计费已停止请求 —— 明天 0 点自动恢复，或在插件设置里调高上限`);
  }
  return { limit, used: q.used };
}

/**
 * 取一个地区的天气。
 * @param {object} deps { state, cfg, fetchRef, warnOnce }
 */
export async function fetchWeather(region, deps) {
  const { state, cfg, fetchRef } = deps;
  const now = Date.now();
  const src = getSource(cfg.source);
  const keepMs = cfg.cacheMinutes * 60000;
  state.cache ??= new Map();
  // 缓存键带数据源：换数据源后旧数据必须立刻失效，否则「改了设置没变化」最难排查
  const key = `${src.id}::${region}`;
  const hit = state.cache.get(key);
  // 跨日必须失效：days[0]/[1] 是「今天/明天」，昨天的缓存会让「今天 N~M°」其实是昨天的
  // 另一条失效条件：两个开关都关时取的那份缓存里根本没有多日数据，之后用户打开开关，
  // 照常复用就会「开了设置、卡片上还是没有」
  const needDays = cfg.forecast !== false || cfg.todayRange !== false;
  const staleForDays = needDays && hit?.data?.daysRequested === false;
  if (hit && hit.day === localDay() && now - hit.at < keepMs && !staleForDays) {
    return { ...applyDayPrefs([hit.data], cfg)[0], cached: true };
  }

  const { limit } = checkDailyQuota(state, cfg.dailyRequestLimit);
  const d = await src.fetch(region, cfg, fetchRef);
  if (d?.temp == null) throw new Error(`${src.label} 没返回温度字段（检查地区名或字段映射）`);

  const { _insecure, _requests, ...safe } = d;
  /**
   * 兜底按 1 次算。
   *
   * 各数据源都会报 `_requests`，但**第三方/自建接口的字段是用户自己填的**，
   * 万一哪天新增一个源忘了报，`Number(undefined) > 0` 就是 false ——
   * 计数永远停在 0，每日上限静默失效。宁可少算成 1 次，也不能变成不计数。
   */
  const cost = Math.max(1, Number(_requests) || 1);
  if (limit > 0) {
    quotaState(state).used += cost;
    deps.persist?.(); // 已用计数要跨重启保留，否则重启就能绕过当日上限
  }
  // 只提示一次：播报循环会把同一句话刷满日志
  if (_insecure && !state.warnedInsecure) {
    state.warnedInsecure = true;
    deps.warn?.('天气自建接口用的是 http://，密钥会明文过网 —— 能换 https 就换');
  }

  // 缓存存**裁剪前**的完整数据，来回切开关不用重新请求；对外返回时才按开关裁剪
  const data = { ...safe, source: src.id, fetchedAt: now, cached: false };
  state.cache.set(key, { at: now, day: localDay(), data });
  return applyDayPrefs([data], cfg)[0];
}

/** 并发上限：几个地区一起查，但别一次打满数据源（和风按量计费，wttr 也会限流）。 */
async function fetchMany(regions, deps) {
  const rows = [];
  const failed = [];
  for (const r of regions) {
    try { rows.push(await fetchWeather(r, deps)); } catch (e) { failed.push(`${r}（${e.message}）`); }
  }
  return { rows, failed };
}

/* ── 出图 ───────────────────────────────────────────────────────── */

async function makeCard(rows, cfg, log) {
  const theme = cfg.theme === 'light' ? 'light' : 'dark';
  const html = buildWeatherHtml(rows, { theme, cacheMinutes: cfg.cacheMinutes });
  // bg 必须与卡片底色一致：渲染器靠它裁掉截图底部的纯背景行
  return renderHtmlToPng(html, { browser: cfg.browserPath, bg: pageBgOf(theme), log });
}

/** 被动回复窗口还剩多少（毫秒）。窗口过期后发图会降级成主动消息，要提前知道。 */
const windowLeftMs = (msg) => {
  const at = Number(msg?.receivedAt) || 0;
  return at ? Math.max(0, at + PASSIVE_WINDOW_MS - Date.now()) : PASSIVE_WINDOW_MS;
};

/* ── 插件 ───────────────────────────────────────────────────────── */

const configSchema = {
  enabled: { type: 'boolean', default: true, label: '启用天气查询', desc: '关闭后不响应查询、不做定时播报。' },
  source: {
    type: 'select',
    default: 'wttr',
    options: ['wttr', 'openweather', 'qweather', 'custom'],
    label: '天气数据源',
    desc: 'wttr = wttr.in（免密钥、开箱即用，但省份名会解析到随机小地方）；openweather = OpenWeatherMap（需 Key）；'
      + 'qweather = 和风天气（需 Key + 专属 API Host，国内地名最准、支持到县级。⚠️ 按量计费：每月 5 万次免费额度，超出按 ¥0.0007/次 计费，不拦截）；'
      + 'custom = 自建接口（填下面的 URL 模板与字段映射）。换数据源后旧缓存立即失效。',
  },
  apiKey: { type: 'string', default: '', label: 'API Key', desc: 'openweather / qweather / 自建接口用到。自建接口时会填进 URL 模板的 {key}。用 wttr 时留空即可。' },
  apiHost: {
    type: 'string', default: '', label: '和风天气 API Host',
    desc: '仅数据源 = qweather 时必填。和风已废弃共享域名 devapi/geoapi.qweather.com，改用每个账号独有的 API Host（形如 xxxx.re.qweatherapi.com）。'
      + '控制台 https://console.qweather.com/setting 的「设置」页复制，只填域名，不用写 https://。填错会返回 403 Invalid Host。',
  },
  dailyRequestLimit: {
    type: 'number', default: 300, min: 0, label: '每日请求上限（0 = 不限）',
    desc: '计费保护闸门：当天累计请求数达到上限后就不再请求，防止异常循环刷出天价账单（和风超额不拦截、照常扣费）。查询命中缓存不计入。',
  },
  apiUrl: { type: 'string', default: '', label: '自建接口 URL 模板', desc: '仅数据源 = custom 时生效。支持 {region}（自动 URL 编码）和 {key} 两个占位符，必须以 http:// 或 https:// 开头。' },
  customMap: {
    type: 'textarea', default: '', label: '自建接口字段映射（JSON）',
    desc: '用点号路径告诉插件去返回 JSON 的哪里取值，数组下标直接写数字。只有 temp 必填。'
      + '例：{"temp":"main.temp","feels":"main.feels_like","humidity":"main.humidity","wind":"wind.speed","text":"weather.0.description"}。'
      + '温度按摄氏度、风速按 km/h、气压按 hPa。可选：windDir / pressure / sunrise / sunset / days / hours / indices / air。',
  },
  customHeaders: { type: 'string', default: '', label: '自建接口额外请求头', desc: '格式「请求头名: 值」，多个用分号隔开，例：X-Api-Key: abc123; Accept: application/json。' },
  cacheMinutes: { type: 'number', default: 15, min: 2, label: '数据缓存（分钟）', desc: '同一地区缓存多久，避免频繁查询。最小 2。跨日自动失效。' },
  regions: { type: 'string', default: '北京', label: '默认地区列表', desc: '默认查询/播报的地区，逗号、顿号、分号或换行分隔，最多 6 个。查单独地区不用改这里，直接说「上海天气」。wttr.in 对省份名解析不准，换和风或改成具体城市名。' },
  todayRange: { type: 'boolean', default: true, label: '附带今日温度区间', desc: '今天最高/最低。wttr / OpenWeather / 自建一次请求本来就带，开了不花钱；和风会因此多一次请求。' },
  forecast: { type: 'boolean', default: false, label: '附带未来三天预报', desc: '和风里它与「今日温度区间」是同一个接口 /v7/weather/3d，两个开关任意一个开着就多花 1 次请求，想彻底省掉必须两个都关。' },
  hourly: { type: 'boolean', default: true, label: '附带逐小时走势', desc: '卡片多一条走势（12 个点）。仅和风会多花一次请求（按「地区+整点」缓存）。wttr / OpenWeather 只有 3 小时粒度，图上会如实标注「每 3 小时」。地区超过 3 个时不画。' },
  sun: { type: 'boolean', default: true, label: '附带日出日落时刻', desc: '和风下优先从 3d 接口白拿；拿不到才单独请求并按天缓存。' },
  indices: { type: 'boolean', default: false, label: '附带今日「宜 / 不宜」生活指数', desc: '运动、洗车、钓鱼、旅游、晾晒等。仅和风支持，多 1 次请求，按「地区+日期」缓存。' },
  air: { type: 'boolean', default: false, label: '附带空气质量', desc: 'AQI、等级、PM2.5。仅和风支持，按「地区+整点」缓存。香港等境外地区用当地标准，卡片会标出标准名，不能和内地 AQI 横向比数字。' },
  theme: { type: 'select', default: 'dark', options: ['dark', 'light'], label: '卡片配色', desc: 'dark 深色（默认）/ light 浅色。' },
  keywords: { type: 'string', default: '天气', label: '触发关键词', desc: '群里说一句含这些词的短话（≤20 字）就触发，逗号分隔。太长的话聊天里顺口提一句也会弹卡，容易打断人。留空 = 只响应 /天气 命令。' },
  cooldownSec: { type: 'number', default: 8, min: 0, label: '同一会话冷却（秒）', desc: '防止有人连发刷屏。0 = 不限。' },
  broadcastTime: { type: 'string', default: '', label: '每日播报时间', desc: '如 07:30，可填多个（09:30,12:30,21:30）。留空 = 不自动播报。⚠️ 机器人必须在那个时间点处于运行状态，错过了不补发。' },
  broadcastTargets: { type: 'string', default: '', label: '播报发到哪些群（群 openid）', desc: '官方接口不提供群号，这里填群的 openid（32 位字母数字）。在目标群里发 /天气 绑定播报 即可自动登记，不用手抄。逗号/空格/换行分隔。' },
  browserPath: { type: 'string', default: '', label: '浏览器路径（可选）', desc: '渲染卡片用本机 Edge / Chrome 无头模式。留空自动找；找不到就回退文字版。例：C:/Program Files/Google/Chrome/Application/chrome.exe' },
};

export default {
  id: 'weather-card',
  name: '天气播报',
  version: '1.0.3', // 必须是字面量，与上面的 VERSION 同步
  shortDesc: '问一句「上海天气」回一张天气卡，可定时播报',
  // 市场索引要求 description 一句话、不超过 60 字；详细说明留在 README
  description: '问「上海天气」「今天天气怎么样」就回一张天气卡图片，支持多地区、四大天气源与每日定时播报',
  icon: '🌤️',
  /**
   * `ctx.registerTool`（跨插件 AI 工具）是 **0.8.6** 才引入的（RELEASE_NOTES: v0.8.6）。
   * 其余用到的 API 在 0.6.10 就有。
   *
   * 这里用的是 `ctx.registerTool?.()` 可选调用，低版本不会崩、但也**不会注册工具**，
   * 用户看到的是「装上了，AI 却不会查天气」且没有任何报错。与其静默降级，
   * 不如把要求写清楚：0.8.6 以下直接拒绝加载，面板上会显示明确的版本不符提示。
   */
  frameworkVersion: '>=0.8.6',
  priority: 10,
  config: configSchema,

  setup(ctx) {
    const log = ctx.logger;
    // 热重载会重建模块，模块顶层变量全丢；要跨重载保留的放 ctx.state
    ctx.state.w ??= { cache: new Map(), cooldown: new Map(), sentToday: { day: '', done: [] }, stats: { queries: 0, cards: 0, text: 0, broadcasts: 0, failed: 0, last: '' } };
    const state = ctx.state.w;
    let rendering = Promise.resolve(); // 浏览器一次只开一个：并发开几个会把机器拖死

    /**
     * 跨重启保留的两样东西：**今日已播报**和**今日请求数**。
     *
     * 只放内存的话有两个真实故障：
     *   ① 在播报点之后 2 小时内重启 → sentToday 清空 → 重启后立刻把当天的播报再发一遍；
     *   ② 重启后 dailyRequestLimit 已用计数归零 → 按量计费那天可能超支。
     * 都落到 ctx.storage（`data/bots/<机器人>/plugins/weather-card.json`）。
     */
    const PERSIST_KEY = 'weather:persist';
    let persistChain = Promise.resolve();
    const persistState = () => {
      // 串行化：并发写同一个键会互相覆盖，串起来后最后一次一定是最新值
      persistChain = persistChain.catch(() => {}).then(async () => {
        try {
          await ctx.storage.set(PERSIST_KEY, { sentToday: state.sentToday, quota: state.quota || null });
        } catch (e) {
          log.warn(`天气状态落盘失败：${e?.message || e}`);
        }
      });
      return persistChain;
    };

    // 启动时读回。**不 await**：读盘慢的话会拖住插件加载，而这两样东西晚一拍生效没有影响
    ctx.storage.get(PERSIST_KEY, null).then((saved) => {
      if (!saved || typeof saved !== 'object') return;
      const t = saved.sentToday;
      // 只认今天的：昨天的「已播报」不该挡住今天的播报
      if (t && t.day === localDay()) {
        // 老版本字段叫 times（只到时间点粒度），读旧存档时补成新结构
        state.sentToday = { day: t.day, done: Array.isArray(t.done) ? t.done : Array.isArray(t.times) ? t.times.map(String) : [] };
      }
      // 配额同理：跨天必须归零，不能把昨天的用量带进今天
      if (saved.quota && saved.quota.day === localDay() && Number.isFinite(Number(saved.quota.used))) {
        state.quota = { day: saved.quota.day, used: Number(saved.quota.used) };
      }
    }).catch(() => {});

    const deps = () => ({ state, cfg: readCfg(ctx), fetchRef: fetch, warn: (m) => log.warn(m), persist: persistState, render: ctx._renderCard });

    /* 面板指标 */
    let dashTimer = null;
    const refreshDashboard = () => {
      if (dashTimer) return;
      dashTimer = setTimeout(() => {
        dashTimer = null;
        try {
          const c = readCfg(ctx);
          ctx.setDashboard?.({
            metrics: [
              { label: '查询次数', value: state.stats.queries },
              { label: '发出天气卡', value: state.stats.cards },
              { label: '文字版', value: state.stats.text },
              { label: '定时播报', value: state.stats.broadcasts },
              { label: '失败', value: state.stats.failed },
              { label: '数据源', value: getSource(c.source).label.replace(/\s*（.*?）\s*/g, '') },
              { label: '今日请求', value: `${quotaState(state).used}${c.dailyRequestLimit ? `/${c.dailyRequestLimit}` : ''}` },
              { label: '最近一次', value: state.stats.last || '—' },
            ],
            note: `默认地区：${parseRegions('', c.regions).join('、')}\n播报：${c.broadcastTime || '未设置'}　浏览器：${findBrowser(c.browserPath) ? '已找到' : '未找到（回退文字版）'}`,
          });
        } catch { /* 面板不是关键路径 */ }
      }, 1500);
    };

    /**
     * 查一次天气并发出去。
     * @param {object} msg 触发消息（定时播报时为 null）
     * @returns {Promise<{ok:boolean, mode:'image'|'text'|'none', rows?:object[], failed?:string[]}>}
     */
    async function answer(msg, regionArg, { silent = false } = {}) {
      const cfg = readCfg(ctx);
      const regions = parseRegions(regionArg, cfg.regions);
      if (!regions.length) {
        if (!silent) await msg.reply('没配地区列表，也不知道要查哪里。直接说「上海天气」就行');
        return { ok: false, mode: 'none' };
      }
      state.stats.queries += 1;
      const { rows, failed } = await fetchMany(regions, deps());
      if (!rows.length) {
        state.stats.failed += 1;
        /**
         * 关键词触发时不报错。
         *
         * 群里聊「今天天气真好」「这鬼天气热死了」也会命中关键词，
         * 抠出来的"地名"是 真好 / 这鬼 / 热死了 —— 查不到之后如果照常回一句
         * 「天气服务暂时连不上：真好（…）」，就是拿报错刷屏插嘴。
         * 这种情况只记日志；用户是**真的想查**时用 /天气 命令，那条一定会回话。
         */
        if (silent) log.info(`关键词触发但查不到地区（${regions.join('/')}）：${failed.join('；')}`);
        else await msg.reply(`天气服务暂时连不上：${failed.join('；')}`);
        return { ok: false, mode: 'none', failed };
      }
      state.stats.last = rows.map((r) => r.region).join('/').slice(0, 24);

      // 渲染串行化：并发起多个无头浏览器会把机器拖死
      const renderFn = deps().render || makeCard;
      const png = await (rendering = rendering.catch(() => {}).then(() => renderFn(rows, cfg, (m) => log.warn(m))));
      if (png) {
        const sent = await msg.replyImageBuffer(png);
        if (sent) {
          state.stats.cards += 1;
          if (failed.length) await msg.reply(`没查到的：${failed.join('、')}`);
          refreshDashboard();
          return { ok: true, mode: 'image', rows, failed };
        }
        // 发图失败（窗口过期 / 额度 / 审核）要说清楚，别一口咬定是哪一种
        const left = windowLeftMs(msg);
        log.warn(`天气卡发送失败（窗口剩 ${Math.round(left / 1000)}s），回退文字版`);
      }
      // 文字兜底：整条发
      await msg.reply(textCard(rows) + (failed.length ? `\n没查到的：${failed.join('、')}` : ''));
      state.stats.text += 1;
      refreshDashboard();
      return { ok: true, mode: 'text', rows, failed };
    }

    /**
     * 冷却：同一会话 N 秒内只响应一次。
     *
     * 返回 { blocked, rollback }：**查询失败时要把时间戳回滚**。
     * 不留回滚口的话，用户把地名打错（或网络抖一下）之后，8 秒内重发正确地名
     * 会被静默吞掉 —— 看上去就是「机器人坏了一阵」。
     */
    function beginCooldown(msg, cfg) {
      if (!cfg.cooldownSec) return { blocked: false, rollback: () => {} };
      const key = String(msg.groupId || msg.userId || '');
      const last = state.cooldown.get(key) || 0;
      if (Date.now() - last < cfg.cooldownSec * 1000) return { blocked: true, rollback: () => {} };
      const prev = state.cooldown.get(key);
      state.cooldown.set(key, Date.now());
      if (state.cooldown.size > 500) state.cooldown.delete(state.cooldown.keys().next().value);
      return {
        blocked: false,
        rollback: () => {
          if (prev === undefined) state.cooldown.delete(key);
          else state.cooldown.set(key, prev);
        },
      };
    }

    /* ── 命令 ─────────────────────────────────────────────────── */
    ctx.command('天气 [地区...]', { desc: '查天气并回一张天气卡；/天气 绑定播报 登记当前群为播报目标' }, async (msg) => {
      const cfg = readCfg(ctx);
      if (!cfg.enabled) return msg.reply('天气功能已关闭（在面板的插件设置里打开）');
      const first = String(msg.args?.[0] || '');

      // 子命令：登记 / 取消播报目标
      if (first === '绑定播报' || first === '取消播报') {
        if (msg.kind !== 'group') return msg.reply('这个只能在群里用：播报是发到群的');
        /**
         * ⚠️ `ctx.can()` 是 **async**（context.js: `async can(msg, need)`），
         * 返回 Promise。写成 `if (!ctx.can(msg, 1))` 的话 `!Promise` 恒为 false ——
         * 校验直接失效，群里**任何普通成员**都能改掉 broadcastTargets。
         * 这类「少了 await」在同步返回值上看不出问题，只有换成 async 才暴露，
         * 所以这里必须 await，并且用 testkit 的 `can: async () => false` 锁一条测试。
         */
        if (!(await ctx.can(msg, 1))) return msg.reply('需要管理员才能改播报目标');
        const cur = parseTargets(cfg.broadcastTargets);
        const gid = String(msg.groupId);
        const next = first === '绑定播报' ? [...new Set([...cur, gid])] : cur.filter((x) => x !== gid);
        await ctx.setConfig({ broadcastTargets: next.join(',') });
        return msg.reply(first === '绑定播报'
          ? `已登记本群为天气播报目标${cfg.broadcastTime ? `（每天 ${parseBroadcastTimes(cfg.broadcastTime).join('、')}）` : '。还没设播报时间，到面板里填「每日播报时间」'}`
          : '已取消本群的天气播报');
      }
      if (first === '状态') {
        const c = cfg;
        return msg.reply([
          `天气播报 v${VERSION}`,
          `数据源：${getSource(c.source).label}`,
          `默认地区：${parseRegions('', c.regions).join('、')}`,
          `播报：${parseBroadcastTimes(c.broadcastTime).join('、') || '未设置'} → ${parseTargets(c.broadcastTargets).length} 个群`,
          `浏览器：${findBrowser(c.browserPath) ? '已找到（出图片）' : '没找到（只能发文字版）'}`,
          `今日请求：${quotaState(state).used}${c.dailyRequestLimit ? `/${c.dailyRequestLimit}` : ''}`,
        ].join('\n'));
      }

      const cd = beginCooldown(msg, cfg);
      if (cd.blocked) return true;
      msg.claim?.('weather-card');
      const r = await answer(msg, msg.args.join(','));
      if (!r.ok) cd.rollback(); // 失败不该占着冷却，用户改个地名重发要能立刻生效
      return true;
    });

    /* ── 关键词触发：「上海天气」「今天天气怎么样」 ──────────────── */
    ctx.on('message', async (msg) => {
      if (msg.isCommand) return;
      const cfg = readCfg(ctx);
      if (!cfg.enabled) return;
      const kws = parseKeywords(cfg.keywords);
      if (!String(cfg.keywords || '').trim()) return; // 留空 = 只响应命令
      // 群里没 @ 机器人的话，短句里含「天气」也触发 —— 这是原版「问一句就回」的体验
      if (!isWeatherQuery(msg.content, kws)) return;
      const cd = beginCooldown(msg, cfg);
      if (cd.blocked) return true;
      msg.claim?.('weather-card');
      /**
       * silent = true：这条是**聊天里顺口提一句**触发的，不是明确的下令。
       * 抠错地名（"天气真好" → "真好"）或数据源抽风时只记日志、不在群里报错。
       * 真出错也不回滚冷却 —— 否则一句话里带"天气"就反复触发，反而更吵。
       */
      try {
        await answer(msg, extractRegion(msg.content, kws), { silent: true });
      } catch (e) {
        state.stats.failed += 1;
        log.error(`天气查询失败：${e?.message || e}`);
      }
      return true;
    });

    /* ── AI 工具：让模型来调 ──────────────────────────────────── */
    ctx.registerTool?.({
      name: 'get_weather_card',
      description:
        '查天气并发一张天气卡图片**直接发送到当前会话**（一行一个地区：图标、当前温度、体感、湿度、风向风力、气压、日出日落；并按设置带上今日温度区间、未来三天、逐小时走势、空气质量、今日宜/不宜），不需要再调用发送工具。'
        + '用户点名了地区（如「上海天气」「北京和杭州的天气」）就传 region（多个用逗号分隔）；没点名就不传，用默认地区列表。'
        + '用户问「今天天气怎么样」「多少度」「明天/后天会下雨吗」「下午几点最热」「明天穿什么」时调用。'
        + '返回结果里带未来三天和逐小时摘要，可以直接据此回答；摘要里没有的别编。'
        // 明说「每个地区都要点到」：模型看不见图，默认只会复述清单里的第一个地区，
        // 查了 5 个只说 1 个，用户以为另外 4 个没查到
        + '⚠️ 返回里有几个地区，回复里就要提到几个地区（一行一个也行，一句话挨个点名也行），只报地名+温度+天气，不要漏。'
        + '不要复述卡片上的细节（湿度、风力、气压、逐小时等，图上都印着）；用户追问时再按摘要回答。'
        + '摘要里没给到的信息一律如实说查不到、别外推：没给未来三天就说当前没开预报；日出日落是当地时间，不要换算时区。',
      parameters: {
        type: 'object',
        properties: {
          region: { type: 'string', description: '地区名，支持中文地名（北京、上海、杭州西湖）。多个用逗号分隔。不传 = 用插件设置的默认地区列表。' },
        },
      },
      timeoutMs: 60000,
      async execute(args, call) {
        const cfg = readCfg(ctx);
        if (!cfg.enabled) throw new Error('天气功能已关闭');
        const regions = parseRegions(args?.region, cfg.regions);
        state.stats.queries += 1;
        const { rows, failed } = await fetchMany(regions, deps());
        // 失败就 throw：调用方是 AI 插件，它要把「工具报错了」回填给模型让它圆回来
        if (!rows.length) throw new Error(`天气服务暂时连不上：${failed.join('；')}`);

        const msg = call?.msg;
        if (msg?.replyImageBuffer) {
          const renderFn = deps().render || makeCard;
          const png = await (rendering = rendering.catch(() => {}).then(() => renderFn(rows, cfg, (m) => log.warn(m))));
          if (png && await msg.replyImageBuffer(png)) {
            state.stats.cards += 1;
            refreshDashboard();
            // 必须带摘要：模型看不见图，用户追问「后天热不热」只能靠这段文本回答
            return cardSummary(rows, failed);
          }
        }
        // 没有可发图的载体 / 渲染失败：把文字版整个交给模型，由它转述
        state.stats.text += 1;
        return textCard(rows) + (failed.length ? `\n没查到的：${failed.join('、')}` : '');
      },
    });

    /* ── 定时播报 ─────────────────────────────────────────────── */
    /**
     * 到点就播。每 30 秒看一次：「当前时刻 ≥ 播报点 且 这个时间点这个群还没发过」就发。
     * 用「≥」而不是「==」：轮询可能在那一分钟里恰好错过（机器忙、事件循环卡了一下），
     * 判等的话当天就漏了；用 ≥ 配合去重，迟到几十秒也能补上。
     *
     * 三处必须做对，否则就是「重复刷屏」或「该发的没发」：
     *   ① 重入锁：一轮里要发 N 个地区 + 冷启动浏览器，可能超过 30 秒。没有锁的话
     *      第二轮会在第一轮还没记账时进来，所有群收到两遍。
     *   ② 去重粒度到「时间点 + 群」：只记时间点的话 G1 成功就把整个点标记完成，
     *      G2 当天再也不会补发；只记群的话又会让「同一个点」跨不过去。
     *   ③ 一个群都没发出去不能记账：记了就当成「已完成」，当天再也不补发。
     */
    let broadcasting = false;
    async function broadcastTick() {
      if (broadcasting) return; // ① 上一轮还没跑完，直接跳过这一拍
      const cfg = readCfg(ctx);
      if (!cfg.enabled) return;
      const times = parseBroadcastTimes(cfg.broadcastTime);
      const targets = parseTargets(cfg.broadcastTargets);
      if (!times.length || !targets.length) return;

      broadcasting = true;
      try {
        const today = localDay();
        if (state.sentToday.day !== today) state.sentToday = { day: today, done: [] };
        state.sentToday.done ??= []; // 老版本存的是 times，读旧存档时兜一下
        const sent = new Set(state.sentToday.done);

        const now = new Date();
        const due = times.find((t) => {
          const [h, m] = t.split(':').map(Number);
          if (!(now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m))) return false;
          // 这个点下还有群没发，才算「待处理」；全发完了就不再进循环
          return targets.some((gid) => !sent.has(`${t}::${gid}`));
        });
        if (!due) return;

        // 迟到太久就不补了：播报 09:30，机器 21:00 才起，发一条「早上好」就是笑话
        const [dh, dm] = due.split(':').map(Number);
        const lateMin = (now.getHours() * 60 + now.getMinutes()) - (dh * 60 + dm);
        if (lateMin > 120) {
          // 标成已处理（按群粒度补齐），免得每 30 秒都判一遍
          for (const gid of targets) if (!sent.has(`${due}::${gid}`)) state.sentToday.done.push(`${due}::${gid}`);
          await persistState();
          log.info(`播报点 ${due} 已过 ${lateMin} 分钟，不补发`);
          return;
        }

        const regions = parseRegions('', cfg.regions);
        const { rows, failed } = await fetchMany(regions, deps());
        if (!rows.length) { log.warn(`播报取天气全部失败：${failed.join('；')}`); return; }
        const renderFn = deps().render || makeCard;
        const png = await (rendering = rendering.catch(() => {}).then(() => renderFn(rows, cfg, (m) => log.warn(m))));

        // 只发给「这个时间点还没收到过」的群：G1 成功、G2 失败时，下一拍只会重试 G2
        let sentOk = 0;
        for (const gid of targets) {
          const key = `${due}::${gid}`;
          if (sent.has(key)) continue;
          try {
            if (png) {
              const up = await ctx.api.uploadMedia('group', gid, { fileType: 1, fileData: png.toString('base64'), reuse: false });
              if (!up?.file_info) throw new Error('上传未返回 file_info');
              await ctx.api.sendGroup(gid, { msgType: 7, media: { file_info: up.file_info } });
            } else {
              /**
               * 纯文字走 `ctx.push`，不走 `ctx.api.sendGroup`。
               *
               * 图片必须走 uploadMedia + sendGroup（push 只发文本），这条绕不开；
               * 但文字这条路走 push 才对得上账：框架的主动消息额度、限流、
               * 投递账本归属都挂在 outbound 上，直调底层 api 会绕过统计 ——
               * 用户查「今天主动消息用了多少」时数字对不上。
               */
              await ctx.push(gid, textCard(rows), { kind: 'group', requestId: `weather:${due}:${gid}` });
            }
            // ② 每成功一个群立刻记账并落盘：中途崩溃也不会重发已成功的群
            state.sentToday.done.push(key);
            sent.add(key);
            await persistState();
            sentOk += 1;
            log.info(`天气播报已发 → 群 ${gid.slice(0, 8)}…`);
          } catch (e) {
            log.error(`天气播报到群 ${gid.slice(0, 8)}… 失败：${e?.message || e}`);
          }
        }
        if (sentOk > 0) state.stats.broadcasts += 1;
        refreshDashboard();
      } finally {
        broadcasting = false;
      }
    }

    ctx.schedule('weather-broadcast', 30 * 1000, () => broadcastTick().catch((e) => log.error(`播报循环出错：${e?.message || e}`)));

    ctx.menu('天气播报', [
      { text: '直接说「上海天气」', desc: '不用加前缀，回一张天气卡' },
      { text: '直接说「今天天气怎么样」', desc: '没点名地区就用默认地区列表' },
      { text: '「北京和杭州的天气」', desc: '多地区一行一个，最多 6 个' },
      { cmd: '天气 绑定播报', desc: '管理员在群里发，登记本群为每日播报目标' },
      { cmd: '天气 状态', desc: '看数据源、播报设置、浏览器是否可用' },
    ]);

    ctx.onTeardown?.(() => { if (dashTimer) clearTimeout(dashTimer); });
    refreshDashboard();
    log.info(`天气播报已加载 v${VERSION}｜数据源 ${getSource(readCfg(ctx).source).label}｜浏览器 ${findBrowser(readCfg(ctx).browserPath) ? '可用' : '未找到→文字版'}`);
  },
};

// 给测试用的出口
export const internals = {
  readCfg, parseRegions, parseKeywords, parseBroadcastTimes, parseTargets, extractRegion, isWeatherQuery,
  fetchWeather, checkDailyQuota, describe, rangeText,
};

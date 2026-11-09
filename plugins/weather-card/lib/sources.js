/**
 * 天气数据源（可切换 / 可自建）
 *
 * 移植自 QQ Agent 的 weather-card/sources.js。纯函数 + 数据源表，不依赖任何框架 API，
 * 所以逻辑和原版一致：解析、归一、缓存、请求计数都在这里。
 *
 * ── 契约 ──────────────────────────────────────────────────────────────
 * 每个数据源：{ id, label, needsKey, doc, fetch(region, cfg, fetchRef) -> normalized }
 * normalized（缺字段一律 null，渲染端有守卫）：
 *   region 原始查询名 / resolved 数据源实际解析到的地点（用于暴露错配）
 *   temp feels humidity wind       数值（摄氏 / % / km/h）
 *   code   WWO 天气码（没有就 null，交给 text 兜底）
 *   text   数据源给的文字描述
 *   todayMax todayMin tomorrowMax tomorrowMin / tomorrowWet
 *   days   未来三天：[{ date, label, min, max, text, wet, pop }]
 *   hours  逐小时：[{ time:'HH:MM', temp, text, pop }]
 *   _requests 本次实际发出的 HTTP 请求数（内部字段，上层用于每日限额统计）
 */

const num = (v) => {
  if (v == null || v === '') return null; // Number(null) === 0，不挡的话「没给」会变成 0°
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* ── 风向 / 日月时刻：各源格式不一，统一在这里归一 ────────────────── */

const DIR_CN = ['北', '东北偏北', '东北', '东北偏东', '东', '东南偏东', '东南', '东南偏南',
  '南', '西南偏南', '西南', '西南偏西', '西', '西北偏西', '西北', '西北偏北'];

/** 度数 → 16 方位中文。角度是「风从哪来」的方位（气象学惯例）。 */
export function degToDir(deg) {
  // 必须先把 null / '' 挡掉：Number(null) === 0 会被当成正北，
  // 接口没给风向时卡片上会凭空出现「北风」。
  if (deg == null || deg === '') return '';
  const d = Number(deg);
  if (!Number.isFinite(d)) return '';
  const idx = Math.round((((d % 360) + 360) % 360) / 22.5) % 16;
  return DIR_CN[idx];
}

const DIR_EN = { N: 0, NNE: 1, NE: 2, ENE: 3, E: 4, ESE: 5, SE: 6, SSE: 7, S: 8, SSW: 9, SW: 10, WSW: 11, W: 12, WNW: 13, NW: 14, NNW: 15 };
/** 英文缩写（N / NNE / WSW…）→ 中文。wttr.in 给的是这个。 */
export function dirToCn(s) {
  const k = String(s || '').trim().toUpperCase();
  if (!(k in DIR_EN)) return '';
  return DIR_CN[DIR_EN[k]];
}

/** "06:14 PM" → "18:14"；24 小时制与 ISO 原样取 HH:MM。 */
export function toHm(s) {
  const raw = String(s ?? '').trim();
  if (!raw) return '';
  const iso = raw.match(/(\d{2}):(\d{2}):?(\d{2})?/);
  if (/T\d{2}:\d{2}/.test(raw) && iso) return `${iso[1]}:${iso[2]}`;
  const m = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return '';
  let h = Number(m[1]);
  const ampm = (m[3] || '').toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/* ── 进程内缓存（和风按量计费：省一次请求是一次）──────────────────── */

/** 地名 → 城市 id：对应关系不会变，进程内缓存即可 */
const geoCache = new Map();
/** 日出日落：键带日期，每地区每天最多 1 次 */
const sunCache = new Map();
/** 逐小时：键到小时，同一小时内拿到的完全一样 */
const hourCache = new Map();
/** 生活指数：键带日期 */
const idxCache = new Map();
/** 空气质量：键到小时 */
const airCache = new Map();

/** 测试用：清空全部缓存 */
export function resetSourceCaches() {
  for (const c of [geoCache, sunCache, hourCache, idxCache, airCache]) c.clear();
}

/**
 * 清掉过期键，避免这些模块级 Map 无限增长。
 *
 * 这几种缓存的键里都带了日期或整点（`::20261109` / `::2026-11-09T18`），
 * 过了那天/那小时就再也不会命中 —— 只涨不落，跑几个月就是一万条死键。
 * geoCache 是「地名 → 城市 id」，不会有"过期"一说，但用户乱试地名能把它撑大，
 * 所以只做数量上限（超了丢最早的，Map 的插入顺序就是 LRU 的近似）。
 */
function pruneCaches() {
  const dayKey = localDayOf(new Date()).replace(/-/g, '');
  const hourKey = `${localDayOf(new Date())}T${String(new Date().getHours()).padStart(2, '0')}`;
  for (const [k] of sunCache) if (!k.endsWith(dayKey)) sunCache.delete(k);
  for (const [k] of idxCache) if (!k.endsWith(dayKey)) idxCache.delete(k);
  for (const [k] of hourCache) if (!k.includes(hourKey)) hourCache.delete(k);
  for (const [k] of airCache) if (!k.includes(hourKey)) airCache.delete(k);
  while (geoCache.size > 500) geoCache.delete(geoCache.keys().next().value);
}

/* ── 日期 / 逐小时归一 ─────────────────────────────────────────── */

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const localDayOf = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 'YYYY-MM-DD' → 「今天 / 明天 / 后天 / 周三」。认不出来返回空串（绝不写出 "Invalid Date"）。 */
export function dayLabel(dateStr) {
  const m = String(dateStr ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(d.getTime())) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff < 0 || diff > 6) return `${d.getMonth() + 1}/${d.getDate()}`;
  return WEEK_CN[d.getDay()];
}

/** 逐小时抽样：每隔 step 个取 1 个，最多 count 个。 */
export function thinHours(hours, { count = 12, step = 1 } = {}) {
  const list = (hours || []).filter((h) => h && h.time);
  const out = [];
  for (let i = 0; i < list.length && out.length < count; i += Math.max(1, step)) out.push(list[i]);
  return out;
}

/**
 * 生活指数归一：收成 [{ name, cat, text }]，并**只保留能判断「适宜/不适宜」的**。
 *
 * 按 category 关键词筛而不是按指数名硬编码：和风 16 条里 category 语义不统一
 * （运动=「较适宜」、穿衣=「热」、紫外线=「弱」、过敏=「极易发」），
 * 只有带「适宜 / 不宜」字样的才回答得了「今天适合干什么」。
 */
export function parseIndices(list) {
  const arr = Array.isArray(list) ? list : (list ? [list] : []);
  return arr
    .map((d) => ({
      name: String(d?.name ?? d?.type ?? '').replace(/指数$/, '').trim(),
      cat: String(d?.category ?? d?.level ?? '').trim(),
      text: String(d?.text ?? d?.desc ?? '').trim(),
    }))
    .filter((x) => x.name && /适宜|不宜/.test(x.cat));
}

/**
 * 和风新版空气质量（/airquality/v1/current）→ 统一结构。
 *
 * 两个坑：
 *  1) indexes 里**可能有多个标准**。香港返回的是 hk-epd「AQHI (HK)=5」，
 *     跟内地 cn-mee 的 0-500 不是一个量级 —— 优先取中国标准，并把标准名带出去标注。
 *  2) 首要污染物是对象，空气优秀时是 **null** —— 别当成「未知」往外写。
 */
export function parseAir(j) {
  const list = Array.isArray(j?.indexes) ? j.indexes : [];
  const flat = j?.aqi != null ? j : null; // 自建接口可能是扁平结构
  const ix = list.find((x) => x?.code === 'cn-mee') || list[0] || flat;
  if (!ix || ix.aqi == null) return null;
  const conc = (code, flatKey) => {
    if (flat) return num(j[flatKey]);
    const p = (Array.isArray(j?.pollutants) ? j.pollutants : []).find((x) => x?.code === code);
    return num(p?.concentration?.value);
  };
  return {
    aqi: num(ix.aqiDisplay ?? ix.aqi),
    category: String(ix.category ?? '').trim(),
    level: num(ix.level),
    standard: String(ix.name ?? ix.code ?? '').trim(),
    isCn: String(ix.code ?? '') === 'cn-mee',
    primary: String(ix.primaryPollutant?.name ?? ix.primaryPollutant?.fullName ?? '').trim(),
    pm25: conc('pm2p5', 'pm25'),
    pm10: conc('pm10', 'pm10'),
    advice: String(ix?.health?.advice?.generalPopulation ?? ix?.health?.effect ?? '').trim(),
  };
}

/** 降水概率/量 → 是否算有降水。各家给的是 0-1、0-100 或毫米数，只做粗判。 */
const wetOf = (pop, text) => {
  if (pop != null) {
    const p = Number(pop);
    if (Number.isFinite(p)) return p > 0;
  }
  return /雨|雪|雷|rain|snow|drizzle|shower|thunder/i.test(String(text ?? ''));
};

/** 降水天气码判定。雾（143/248/260）不算，雪与雷雪要算。 */
export function isWetCode(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return false;
  return (c >= 176 && c <= 230) || (c >= 263 && c <= 377) || (c >= 386 && c <= 395);
}

/* ── 天气码 → 中文 + emoji ─────────────────────────────────────── */
export function codeToCn(code) {
  const c = Number(code) || 113;
  if (c === 113) return { cn: '晴', icon: '☀️' };
  if (c === 116) return { cn: '局部多云', icon: '⛅' };
  if (c === 119) return { cn: '多云', icon: '☁️' };
  if (c === 122) return { cn: '阴', icon: '☁️' };
  if (c === 143 || c === 248 || c === 260) return { cn: '雾', icon: '🌫️' };
  if (c === 149) return { cn: '霾', icon: '🌫️' };
  // 先判「是不是降水」再分雨雪雷：旧实现用 includes 白名单，漏了 323-338 整段，
  // 「小雪/中雪/大雪/暴雪」全掉到兜底显示成「多云」，北方冬天天天踩。
  if (!isWetCode(c)) return { cn: '多云', icon: '⛅' };
  if (c === 200 || c === 386 || c === 389) return { cn: '雷阵雨', icon: '⛈️' };
  if (c === 392 || c === 395) return { cn: '雷雪', icon: '⛈️' };
  if (c === 227 || c === 230) return { cn: '暴雪', icon: '🌨️' };
  if (c === 179 || c === 182 || c === 185 || c === 362 || c === 365) return { cn: '雨夹雪', icon: '🌨️' };
  if (c === 311 || c === 314 || c === 317 || c === 320) return { cn: '冻雨', icon: '🌧️' };
  if ((c >= 323 && c <= 350) || c === 368 || c === 371 || c === 374 || c === 377) return { cn: '雪', icon: '❄️' };
  return { cn: '雨', icon: '🌧️' };
}

/* ── 文字描述 → 中文 + emoji（没有天气码的数据源用）──────────────── */
const TEXT_RULES = [
  [/雷|thunder/i, { cn: '雷阵雨', icon: '⛈️' }],
  [/雪|snow|sleet|blizzard|冰雹|hail|冰粒/i, { cn: '雪', icon: '❄️' }],
  [/雨|rain|drizzle|shower|precipitation/i, { cn: '雨', icon: '🌧️' }],
  [/雾|霾|haze|fog|mist|smog|烟|沙尘|sand|dust/i, { cn: '霾', icon: '🌫️' }],
  [/阴|overcast/i, { cn: '阴', icon: '☁️' }],
  [/多云|partly|cloud/i, { cn: '多云', icon: '⛅' }],
  [/晴|sunny|clear/i, { cn: '晴', icon: '☀️' }],
];

export function textToCn(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  for (const [re, out] of TEXT_RULES) if (re.test(s)) return out;
  return { cn: s, icon: '🌡️' };
}

/** 优先用天气码，没有码就退回文字描述。 */
export function describe(row) {
  if (row && Number.isFinite(Number(row.code)) && Number(row.code)) return codeToCn(row.code);
  return textToCn(row?.text) || { cn: '—', icon: '🌡️' };
}

/* ── 自建接口用的小工具 ──────────────────────────────────────────── */

const pick = (obj, keys) => {
  for (const k of keys) { const v = obj?.[k]; if (v != null && v !== '') return v; }
  return undefined;
};

/** 时间字段 → "HH:MM"。可能是 "15:00"、ISO 串、也可能是 10 位 unix 秒。 */
const hmOf = (v) => {
  if (v == null || v === '') return '';
  const s = String(v);
  if (/^\d{10}$/.test(s)) {
    const d = new Date(Number(s) * 1000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return toHm(s);
};

/** 日期字段 → "YYYY-MM-DD"。三种写法都要认。 */
const dateOf = (v) => {
  if (v == null || v === '') return '';
  const s = String(v);
  if (/^\d{10}$/.test(s)) return localDayOf(Number(s) * 1000);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  return s.slice(0, 10);
};

/** 按 "a.b.0.c" / "a[0].b" 取深层字段。取不到返回 undefined（区别于 null = 没配）。 */
export function pickPath(obj, path) {
  if (!path) return undefined;
  let cur = obj;
  for (const raw of String(path).split('.').filter(Boolean)) {
    if (cur == null) return undefined;
    const m = /^([A-Za-z_$][\w$]*)\[(\d+)\]$/.exec(raw);
    if (m) {
      cur = cur[m[1]];
      if (cur == null) return undefined;
      cur = cur[Number(m[2])];
    } else {
      cur = cur[raw];
    }
  }
  return cur;
}

/**
 * 错误消息里的 URL 脱敏。
 *
 * 为什么把整个 query 丢掉，而不是「只打码 key/token 这几个参数名」：
 * 猜参数名永远猜不全（apikey= / access_token= / appkey= / secret= 都会漏）。
 * 而这条错误会一路进工具返回 → 进模型上下文 → 被复述到群里，密钥就这么泄了。
 * 所以只保留「能定位是哪个接口」的最小信息：协议 + 主机 + 路径。
 */
export function redactUrl(u) {
  const raw = String(u ?? '');
  try {
    const p = new URL(raw);
    // 把 key 写在路径上的接口（/v1/<key>/weather）也打码：≥20 位纯 token 字符的段视为凭据
    const path = p.pathname.split('/')
      .map((seg) => (/^[A-Za-z0-9_-]{20,}$/.test(seg) ? '***' : seg))
      .join('/');
    return `${p.protocol}//${p.host}${path}${p.search ? '?<查询参数已省略>' : ''}`;
  } catch {
    return raw.replace(/[?#].*$/, '').slice(0, 60) || '(无 URL)';
  }
}

async function getJson(fetchRef, url, { timeout = 20000, headers } = {}) {
  const res = await fetchRef(url, { signal: AbortSignal.timeout(timeout), ...(headers ? { headers } : {}) });
  if (!res.ok) throw new Error(`HTTP ${res.status}（${redactUrl(url)}）`);
  return res.json();
}

/* ══ 数据源实现 ═══════════════════════════════════════════════════ */

export const SOURCES = {
  /* ── wttr.in：免密钥，开箱即用 ───────────────────────────────── */
  wttr: {
    id: 'wttr',
    label: 'wttr.in（免密钥，默认）',
    needsKey: false,
    doc: '免密钥、中文地名直查。缺点是省份名会解析到随机小地方，且不支持经纬度。',
    async fetch(region, cfg, fetchRef) {
      const j = await getJson(fetchRef, `https://wttr.in/${encodeURIComponent(region)}?format=j1`);
      const c = j?.current_condition?.[0];
      const w0 = j?.weather?.[0];
      const w1 = j?.weather?.[1];
      if (!c || !w0) throw new Error('wttr.in 返回缺字段');
      const area = j?.nearest_area?.[0];

      // 逐小时：wttr.in 只有 3 小时档，不是真逐小时。跳过今天已过去的档，再取 8 档 ≈ 24 小时。
      const curH = new Date().getHours();
      const hours = [];
      for (const w of (j?.weather || []).slice(0, 2)) {
        for (const h of (w.hourly || [])) {
          const hh = String(h?.time ?? '').padStart(4, '0').slice(0, 2);
          if (hours.length === 0 && Number(hh) < curH) continue;
          hours.push({
            time: `${hh}:00`,
            temp: num(h?.tempC),
            text: String(h?.weatherDesc?.[0]?.value ?? '').trim(),
            pop: num(h?.chanceofrain),
          });
        }
      }
      // 未来三天：daily 没有总体描述，取正午那一档（hourly[4] ≈ 12:00）代表白天
      const days = (j?.weather || []).slice(0, 3).map((w) => {
        const noon = w?.hourly?.[4] || w?.hourly?.[0] || {};
        return {
          date: String(w?.date ?? ''),
          label: dayLabel(w?.date),
          min: num(w?.mintempC),
          max: num(w?.maxtempC),
          text: String(noon?.weatherDesc?.[0]?.value ?? '').trim(),
          wet: (w?.hourly || []).some((h) => isWetCode(h?.weatherCode)),
          pop: num(noon?.chanceofrain),
        };
      }).filter((d) => d.label);

      return {
        region,
        resolved: [area?.areaName?.[0]?.value, area?.country?.[0]?.value].filter(Boolean).join(' / '),
        temp: num(c.temp_C),
        feels: num(c.FeelsLikeC),
        humidity: num(c.humidity),
        wind: num(c.windspeedKmph),
        code: num(c.weatherCode),
        text: c?.weatherDesc?.[0]?.value || '',
        todayMax: num(w0.maxtempC),
        todayMin: num(w0.mintempC),
        tomorrowMax: num(w1?.maxtempC),
        tomorrowMin: num(w1?.mintempC),
        tomorrowWet: w1 ? (w1.hourly || []).some((h) => isWetCode(h.weatherCode)) : null,
        windDir: dirToCn(c?.winddir16Point) || degToDir(c?.winddirDegree),
        pressure: num(c?.pressure),
        sunrise: toHm(w0?.astronomy?.[0]?.sunrise),
        sunset: toHm(w0?.astronomy?.[0]?.sunset),
        // 实测是 UTC 且无时区字段，只原样展示，不换算 —— 换算错了比不显示更糟
        obsTime: c?.observation_time || '',
        days,
        daysRequested: true, // 一次请求本来就带多天，不额外花钱
        indices: [],
        air: null,
        hours: thinHours(hours, { count: 8 }),
        // 每日限额统计要**每个源都报**，不能只有和风报。漏了的话
        // wttr / openweather / custom 的「每日请求上限」形同虚设，永远是 0。
        _requests: 1,
      };
    },
  },

  /* ── OpenWeatherMap ─────────────────────────────────────────── */
  openweather: {
    id: 'openweather',
    label: 'OpenWeatherMap（需 Key）',
    needsKey: true,
    doc: '免费档够用。实况取 /data/2.5/weather，今日/明日温度由 /data/2.5/forecast（3 小时档）聚合。',
    async fetch(region, cfg, fetchRef) {
      const key = String(cfg.apiKey || '').trim();
      if (!key) throw new Error('openweather 需要填 API Key');
      const q = encodeURIComponent(region);
      const cur = await getJson(fetchRef,
        `https://api.openweathermap.org/data/2.5/weather?q=${q}&appid=${encodeURIComponent(key)}&units=metric&lang=zh_cn`);
      let fc = null;
      try {
        fc = await getJson(fetchRef,
          `https://api.openweathermap.org/data/2.5/forecast?q=${q}&appid=${encodeURIComponent(key)}&units=metric&lang=zh_cn`);
      } catch { /* 预报取不到就只显示实况，不整条失败 */ }

      const byDay = new Map();
      for (const it of fc?.list || []) {
        const ts = Number(it?.dt) * 1000;
        if (!Number.isFinite(ts)) continue;
        const d = localDayOf(ts);
        const bucket = byDay.get(d) || { max: null, min: null, wet: false, text: '', pop: null };
        const t = num(it?.main?.temp);
        if (t != null) {
          bucket.max = bucket.max == null ? t : Math.max(bucket.max, t);
          bucket.min = bucket.min == null ? t : Math.min(bucket.min, t);
        }
        // 当天总体描述：取离正午最近那一档
        const hourOf = new Date(ts).getHours();
        if (!bucket.text || Math.abs(hourOf - 12) < (bucket.noonGap ?? 99)) {
          bucket.noonGap = Math.abs(hourOf - 12);
          bucket.text = String(it?.weather?.[0]?.description ?? '').trim();
          bucket.pop = num(it?.pop);
        }
        for (const w of it?.weather || []) {
          const id = Number(w?.id);
          // OWM id：2xx 雷 3xx 毛毛雨 5xx 雨 6xx 雪；8xx 云不算降水
          if ((id >= 200 && id < 700) || /rain|snow|drizzle|thunder|storm/i.test(String(w?.main || w?.description || ''))) bucket.wet = true;
        }
        byDay.set(d, bucket);
      }
      const dayKeys = [...byDay.keys()].sort();
      const days = dayKeys.slice(0, 3).map((k) => {
        const b = byDay.get(k);
        return { date: k, label: dayLabel(k), min: b?.min ?? null, max: b?.max ?? null, text: b?.text || '', wet: !!b?.wet, pop: b?.pop ?? null };
      }).filter((d) => d.label);
      const hours = (fc?.list || []).slice(0, 8).map((it) => {
        const ts = Number(it?.dt) * 1000;
        const d = Number.isFinite(ts) ? new Date(ts) : null;
        return {
          time: d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '',
          temp: num(it?.main?.temp),
          text: String(it?.weather?.[0]?.description ?? '').trim(),
          pop: num(it?.pop),
        };
      });
      const today = dayKeys[0] ? byDay.get(dayKeys[0]) : null;
      const tmr = dayKeys[1] ? byDay.get(dayKeys[1]) : null;
      // sys.sunrise/sunset 是 UTC 秒，timezone（偏移秒）在同一响应里
      const sunAt = (s) => (s != null
        ? new Date((Number(s) + Number(cur?.timezone || 0)) * 1000).toISOString().slice(11, 16) : '');

      return {
        region,
        resolved: [cur?.name, cur?.sys?.country].filter(Boolean).join(' / '),
        temp: num(cur?.main?.temp),
        feels: num(cur?.main?.feels_like),
        humidity: num(cur?.main?.humidity),
        wind: num(cur?.wind?.speed != null ? Number(cur.wind.speed) * 3.6 : null), // m/s → km/h
        code: null,
        text: cur?.weather?.[0]?.description || '',
        todayMax: today?.max ?? null,
        todayMin: today?.min ?? null,
        tomorrowMax: tmr?.max ?? null,
        tomorrowMin: tmr?.min ?? null,
        tomorrowWet: tmr ? !!tmr.wet : null,
        windDir: degToDir(cur?.wind?.deg),
        pressure: num(cur?.main?.pressure),
        sunrise: toHm(sunAt(cur?.sys?.sunrise)),
        sunset: toHm(sunAt(cur?.sys?.sunset)),
        obsTime: cur?.dt ? new Date(Number(cur.dt) * 1000).toLocaleTimeString('zh-CN', { hour12: false }) : '',
        days,
        daysRequested: true,
        indices: [], // 免费档不含生活指数
        air: null,   // 空气质量是另一个接口且要付费档，没接
        hours: thinHours(hours, { count: 8 }),
        _requests: fc ? 2 : 1,
      };
    },
  },

  /* ── 和风天气（国内地名最准）───────────────────────────────── */
  qweather: {
    id: 'qweather',
    label: '和风天气 QWeather（需 Key + API Host，按量计费）',
    needsKey: true,
    doc: '国内地名解析最准，支持到县级。⚠️ 和风 2025-04-01 起取消免费订阅改按量计费：'
      + '每月 5 万次免费额度，超出照常返回数据但按量扣费，不拦截 —— 所以请求量要省着用。'
      + '另：已废弃共享域名 devapi/geoapi.qweather.com，改用每个账号专属的 API Host。',
    async fetch(region, cfg, fetchRef) {
      const key = String(cfg.apiKey || '').trim();
      if (!key) throw new Error('和风天气需要填 API Key');
      // 2026 年起和风给每个账号发专属 API Host，旧共享域名一律 403 INVALID HOST
      const host = String(cfg.apiHost || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
      if (!host) throw new Error('和风天气：还没填 API Host（控制台 → 设置里复制，形如 xxxx.re.qweatherapi.com）');
      if (/^(devapi|api|geoapi)\.qweather\.com$/i.test(host)) {
        throw new Error('和风天气：API Host 填的是废弃的共享域名，请去控制台 → 设置复制你的专属 Host');
      }
      const base = `https://${host}`;
      const k = encodeURIComponent(key);
      let n = 0; // 本次实际发出的请求数（交给上层做每日限额统计）

      const geoKey = `${host}::${region}`;
      let loc = geoCache.get(geoKey);
      if (!loc) {
        n++;
        const geo = await getJson(fetchRef,
          `${base}/geo/v2/city/lookup?location=${encodeURIComponent(region)}&key=${k}`);
        loc = geo?.location?.[0];
        if (!loc?.id) throw new Error(`和风天气查不到「${region}」（试试更具体的地名，如「闽侯」）`);
        geoCache.set(geoKey, loc);
        pruneCaches();
      }

      n++;
      const now = await getJson(fetchRef, `${base}/v7/weather/now?location=${encodeURIComponent(loc.id)}&key=${k}`);
      // 今日温度区间 + 未来三天是**同一个接口** /v7/weather/3d：任意一个开着就要发这次请求。
      // 想彻底省掉必须两个都关 —— 别写成两个 if，那会花两次钱。
      const needDays = cfg.forecast !== false || cfg.todayRange !== false;
      let fc = null;
      if (needDays) {
        n++;
        fc = await getJson(fetchRef, `${base}/v7/weather/3d?location=${encodeURIComponent(loc.id)}&key=${k}`)
          .catch(() => null);
      }
      const daily = fc?.daily || [];
      const d0 = daily[0];
      const d1 = daily[1];
      const wet = (d) => (d == null ? null : /雨|雪|雷|冰雹|雨夹雪/.test(`${d.textDay || ''}${d.textNight || ''}`));

      const days = daily.slice(0, 3).map((d) => ({
        date: String(d?.fxDate ?? ''),
        label: dayLabel(d?.fxDate),
        min: num(d?.tempMin),
        max: num(d?.tempMax),
        text: String(d?.textDay || d?.textNight || '').trim(),
        wet: wet(d) || Number(d?.precip) > 0,
        pop: null, // 和风 3d 不给降水概率，只有降水量
      })).filter((d) => d.label);

      let hours = [];
      if (cfg.hourly !== false) {
        const hKey = `${host}::${region}::${new Date().toISOString().slice(0, 13)}`;
        let h = hourCache.get(hKey);
        if (!h) {
          n++;
          h = await getJson(fetchRef,
            `${base}/v7/weather/24h?location=${encodeURIComponent(loc.id)}&key=${k}`).catch(() => null);
          if (h) hourCache.set(hKey, h);
          pruneCaches();
        }
        hours = thinHours((h?.hourly || []).map((x) => ({
          time: toHm(x?.fxTime),
          temp: num(x?.temp),
          text: String(x?.text ?? '').trim(),
          pop: num(x?.pop),
        })), { count: 12 });
      }

      // 本地日期键：必须用**本地**日期，toISOString() 是 UTC，北京时间 00:00-07:59 会拿到前一天
      const dayKey = localDayOf(new Date()).replace(/-/g, '');

      // 用 === true 而不是 !== false：这是**按量计费**项，老配置里没有这个键必须按「关」处理，
      // 否则一升级就悄悄多出一整套请求。
      let indices = [];
      if (cfg.indices === true) {
        const iKey = `${host}::${region}::${dayKey}`;
        let ix = idxCache.get(iKey);
        if (!ix) {
          n++;
          ix = await getJson(fetchRef,
            `${base}/v7/indices/1d?location=${encodeURIComponent(loc.id)}&type=0&key=${k}`).catch(() => null);
          if (ix) idxCache.set(iKey, ix);
          pruneCaches();
        }
        indices = parseIndices(ix?.daily || ix?.indices || []);
      }

      // 空气质量：新版 /airquality/v1/current/{lat}/{lon}，**按经纬度查**，不是城市 id。
      // 城市 lookup 的返回里本来就带 lat/lon，不用多花一次请求。
      // 新版不返回 code 字段，成败全看 HTTP 状态码（400=该坐标无数据、401=密钥/Host 错）。
      let air = null;
      // 坐标缺失时拼成 /current/undefined/undefined 会白花一次请求换回 400，
      // 而 400 又被 catch 掉 —— 「静默烧钱还查不到」，所以先挡住。
      if (cfg.air === true && loc.lat != null && loc.lat !== '' && loc.lon != null && loc.lon !== '') {
        const aKey = `${host}::${region}::${new Date().toISOString().slice(0, 13)}`;
        let a = airCache.get(aKey);
        if (!a) {
          n++;
          a = await getJson(fetchRef,
            `${base}/airquality/v1/current/${encodeURIComponent(loc.lat)}/${encodeURIComponent(loc.lon)}?key=${k}`)
            .catch(() => null);
          if (a) airCache.set(aKey, a);
          pruneCaches();
        }
        air = parseAir(a);
      }

      // 日出日落：3d 的 daily[0] 里本来就带了，白拿；没开预报才单独查（按天缓存）
      let sunrise = toHm(d0?.sunrise);
      let sunset = toHm(d0?.sunset);
      // 判「两个都要」而不是只判日落：只判日落的话日出永远是空的
      if (cfg.sun !== false && (!sunset || !sunrise)) {
        const sKey = `${host}::${region}::${dayKey}`;
        let s = sunCache.get(sKey);
        if (!s) {
          n++;
          s = await getJson(fetchRef,
            `${base}/v7/astronomy/sun?location=${encodeURIComponent(loc.id)}&date=${dayKey}&key=${k}`).catch(() => null);
          if (s) sunCache.set(sKey, s);
          pruneCaches();
        }
        // 只在真拿到数据时才覆盖：请求失败直接赋值会把 d0 取到的值抹成空串
        if (s) {
          sunrise = toHm(s?.sunrise) || sunrise;
          sunset = toHm(s?.sunset) || sunset;
        }
      }

      return {
        region,
        resolved: [loc.name, loc.adm1, loc.country].filter(Boolean).join(' / '),
        temp: num(now?.now?.temp),
        feels: num(now?.now?.feelsLike),
        humidity: num(now?.now?.humidity),
        wind: num(now?.now?.windSpeed),
        windDir: String(now?.now?.windDir || '').trim() || degToDir(now?.now?.wind360),
        pressure: num(now?.now?.pressure),
        sunrise,
        sunset,
        code: null,
        text: now?.now?.text || '',
        todayMax: num(d0?.tempMax),
        todayMin: num(d0?.tempMin),
        tomorrowMax: num(d1?.tempMax),
        tomorrowMin: num(d1?.tempMin),
        tomorrowWet: wet(d1),
        obsTime: now?.now?.obsTime ? String(now.now.obsTime).slice(11, 16) : '',
        days,
        hours,
        indices,
        air,
        // 这次取数有没有去拿多日数据（缓存复用的判断依据）：两个开关都关时是 false，
        // 之后用户打开任一开关，旧缓存必须失效重取，否则卡片空白会被误判成「设置没生效」。
        daysRequested: needDays,
        _requests: n,
      };
    },
  },

  /* ── 自建接口：URL 模板 + 字段映射 ─────────────────────────── */
  custom: {
    id: 'custom',
    label: '自建 / 其他接口（自己填 URL 与字段映射）',
    needsKey: false,
    doc: '填一个 URL 模板（{region} {key} 占位）和 JSON 字段映射，任意返回 JSON 的天气接口都能接。',
    async fetch(region, cfg, fetchRef) {
      const tpl = String(cfg.apiUrl || '').trim();
      if (!tpl) throw new Error('自建接口还没填 URL');
      const url = tpl
        .replace(/\{region\}/g, encodeURIComponent(region))
        .replace(/\{key\}/g, encodeURIComponent(String(cfg.apiKey || '')));
      // 只放行 http/https：这是「往外发请求」的入口，file://、data: 之类不该出现
      if (!/^https?:\/\//i.test(url)) throw new Error('自建接口 URL 必须以 http:// 或 https:// 开头');

      const headers = parseHeaders(cfg.customHeaders);
      const j = await getJson(fetchRef, url, { headers });
      const map = parseMap(cfg.customMap);
      // 密钥走 http 明文：局域网自建是合法用法，不阻断，但提示一次
      const encodedKey = encodeURIComponent(String(cfg.apiKey || '').trim());
      const insecure = /^http:\/\//i.test(url) && encodedKey.length > 0 && url.includes(encodedKey);

      const arrAt = (p) => { const v = pickPath(j, p); return Array.isArray(v) ? v : []; };
      const days = arrAt(map.days).slice(0, 3).map((d) => {
        const dd = String(pick(d, ['date', 'fxDate', 'day', 'dt', 'datetime']) ?? '');
        const dtxt = String(pick(d, ['text', 'textDay', 'description', 'condition', 'weather']) ?? '').trim();
        return {
          date: dateOf(dd),
          label: dayLabel(dateOf(dd)),
          min: num(pick(d, ['tempMin', 'temp_min', 'tmin', 'minTemp', 'min', 'mintempC', 'low'])),
          max: num(pick(d, ['tempMax', 'temp_max', 'tmax', 'maxTemp', 'max', 'maxtempC', 'high'])),
          text: dtxt,
          wet: wetOf(pick(d, ['pop', 'precip', 'precipitation']), dtxt),
          pop: num(pick(d, ['pop', 'precip', 'precipitation'])),
        };
      }).filter((d) => d.label);
      const hours = thinHours(arrAt(map.hours).map((h) => {
        const ht = String(pick(h, ['text', 'description', 'condition', 'weather']) ?? '').trim();
        return {
          time: hmOf(pick(h, ['time', 'fxTime', 'dt', 'datetime', 'hour'])),
          temp: num(pick(h, ['temp', 'tempC', 'temperature', 'feelsLike'])),
          text: ht,
          pop: num(pick(h, ['pop', 'precip', 'precipitation'])),
        };
      }), { count: 12 });

      const text = String(pickPath(j, map.text) ?? pickPath(j, map.tomorrowText) ?? '').trim();
      const wetRaw = map.tomorrowWet ? pickPath(j, map.tomorrowWet) : undefined;
      let tomorrowWet = null;
      if (wetRaw !== undefined) {
        // 支持布尔 / 数字（降水量、概率）/ "true" / 含雨雪字样的文字
        tomorrowWet = typeof wetRaw === 'boolean' ? wetRaw
          : typeof wetRaw === 'number' ? wetRaw > 0
            : /^(true|1|yes)$/i.test(String(wetRaw).trim()) || /雨|雪|雷|rain|snow/i.test(String(wetRaw));
      } else if (map.tomorrowText) {
        const t = String(pickPath(j, map.tomorrowText) ?? '');
        tomorrowWet = t ? /雨|雪|雷|rain|snow|drizzle|shower/i.test(t) : null;
      }

      return {
        region,
        resolved: map.resolved ? String(pickPath(j, map.resolved) ?? '') : '',
        temp: num(pickPath(j, map.temp)),
        feels: num(pickPath(j, map.feels)),
        humidity: num(pickPath(j, map.humidity)),
        wind: num(pickPath(j, map.wind)),
        // 风向：中文直接用；度数（0-360）或英文缩写（N/SW…）帮忙转
        windDir: map.windDir
          ? (dirToCn(pickPath(j, map.windDir)) || degToDir(pickPath(j, map.windDir))
            || String(pickPath(j, map.windDir) ?? '').trim())
          : '',
        pressure: num(pickPath(j, map.pressure)),
        sunrise: map.sunrise ? toHm(pickPath(j, map.sunrise)) : '',
        sunset: map.sunset ? toHm(pickPath(j, map.sunset)) : '',
        code: num(pickPath(j, map.code)),
        text,
        todayMax: num(pickPath(j, map.todayMax)),
        todayMin: num(pickPath(j, map.todayMin)),
        tomorrowMax: num(pickPath(j, map.tomorrowMax)),
        tomorrowMin: num(pickPath(j, map.tomorrowMin)),
        tomorrowWet,
        obsTime: map.obsTime ? String(pickPath(j, map.obsTime) ?? '') : '',
        days,
        hours,
        daysRequested: true,
        indices: parseIndices(arrAt(map.indices)),
        air: map.air ? parseAir(pickPath(j, map.air)) : null,
        _insecure: insecure,
        _requests: 1,
      };
    },
  },
};

/* ── 设置解析（坏输入一律降级，不抛错）──────────────────────────── */
export function parseMap(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(String(raw));
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

/** "A: b" 一行一个（面板是单行输入框，所以分号也当分隔符）→ headers 对象。解析不了的行跳过。 */
export function parseHeaders(raw) {
  const out = {};
  for (const line of String(raw ?? '').split(/\r?\n|[;；]+/)) {
    const m = /^\s*([\w-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return Object.keys(out).length ? out : undefined;
}

export function getSource(id) {
  return SOURCES[String(id || '').trim()] || SOURCES.wttr;
}

export const internals = { num, pickPath, parseMap, parseHeaders, isWetCode, textToCn, describe, localDayOf, wetOf };

/**
 * 天气卡：数据整形 + HTML + 文字版 + 给模型的摘要
 *
 * 全是纯函数，不碰网络、不碰文件、不碰框架，可以在纯 Node 里直接单测。
 * 移植自 QQ Agent 的 weather-card/index.js，逻辑一致。
 */
import { describe, textToCn, getSource } from './sources.js';

export const CARD_W = 720;

const hhmm = (ts) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 温度区间文案："18~29°" / 只有最高就 "29°" / 都没有就空串（绝不渲染 null）。 */
export const rangeText = (lo, hi) => {
  const has = (v) => v != null && v !== '';
  return has(hi) ? (has(lo) ? `${lo}~${hi}°` : `${hi}°`) : '';
};

/** 文字 → emoji（多日 / 逐小时没有天气码，只能按文字归类）。 */
const iconOfText = (s) => (textToCn(s)?.icon || '🌡️');

/**
 * 文字 → 中文。
 *
 * wttr.in 和 OpenWeatherMap 返回的是英文（"Partly Cloudy" / "Overcast" / "light rain"），
 * 而卡片和文字版是中文界面 —— 直接用原文会在中文卡片里冒出英文单词。
 * 认不出来的原样返回（自建接口本来就可能是中文，或用户就想看原文）。
 */
const cnText = (s) => {
  const raw = String(s ?? '').trim();
  if (!raw) return '';
  const hit = textToCn(raw);
  // textToCn 认不出来时会把原文当 cn 返回，那种情况保留原文即可
  return hit?.cn || raw;
};

/**
 * 逐小时数据的时间间隔（小时）。
 *
 * wttr.in 和 OpenWeatherMap 免费档只有 3 小时粒度 —— 图上写「逐小时」就是撒谎，
 * 所以按真实间隔标注。
 *
 * **不能只看前两个点**：数据可能跨午夜（18:00 → 次日 12:00），也可能某些点缺失，
 * 取第一段差会算出「每 18 小时」这种明显不对的结论。这里取全部相邻间隔里的**最小正值**，
 * 它才是这组数据的真实粒度；缺失点不会把它拉大。
 */
export function hourStepOf(hours) {
  if (!Array.isArray(hours) || hours.length < 2) return 1;
  const mins = (s) => {
    const [h, m] = String(s).split(':').map(Number);
    return (Number(h) || 0) * 60 + (Number(m) || 0);
  };
  const gaps = [];
  for (let i = 1; i < hours.length; i += 1) {
    let d = mins(hours[i].time) - mins(hours[i - 1].time);
    if (d <= 0) d += 24 * 60; // 跨午夜
    if (d > 0) gaps.push(d);
  }
  if (!gaps.length) return 1;
  return Math.max(1, Math.round(Math.min(...gaps) / 60));
}

/** 地区多了卡片会高得离谱，默认只在 ≤3 个地区时画逐小时条。 */
const shouldShowHours = (rows, opt) => opt?.showHours ?? (rows.length <= 3);

/** 生活指数按「宜 / 不宜」分两组。先判「不宜」：「较不宜」里也带「适宜」两字。 */
export function splitIndices(list) {
  const arr = Array.isArray(list) ? list : [];
  const ok = [];
  const no = [];
  for (const x of arr) {
    const cat = String(x?.cat ?? '');
    if (!x?.name) continue;
    if (/不宜/.test(cat)) no.push(x);
    else if (/适宜/.test(cat)) ok.push(x);
  }
  return { ok, no };
}

const cut = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * 一行「宜 X·Y ／ 不宜 Z」文案。两组都空返回空串。
 * why=true（给模型的摘要）会在不宜那组后附上第一条的原因，否则用户追问
 * 「为什么不宜洗车」时模型只能编。
 */
export function indexLine(r, { max = 5, why = false } = {}) {
  const { ok, no } = splitIndices(r?.indices);
  const parts = [];
  if (ok.length) parts.push(`宜 ${ok.slice(0, max).map((x) => x.name).join('·')}`);
  if (no.length) {
    const reason = why && no[0]?.text ? `（${cut(no[0].text, 18)}）` : '';
    parts.push(`不宜 ${no.slice(0, max).map((x) => x.name).join('·')}${reason}`);
  }
  return parts.join(why ? '，' : '　');
}

/** 一行「空气 优，AQI 44，PM2.5 8」（给模型看的）。没有数据返回空串。 */
export function airLine(r) {
  const a = r?.air;
  if (!a || a.aqi == null) return '';
  // 非中国标准必须带标准名（香港 AQHI=5 跟内地 AQI=44 不是一个量级）
  const unit = (a.isCn === false && a.standard) ? a.standard : 'AQI';
  const parts = [`空气 ${a.category || '—'}，${unit} ${a.aqi}`];
  if (a.pm25 != null) parts.push(`PM2.5 ${a.pm25}`);
  if (a.primary) parts.push(`首要污染物 ${a.primary}`);
  return parts.join('，');
}

/**
 * 按「今日温度区间 / 未来三天」两个开关裁剪取到的数据。
 *
 * 事后裁剪而不是让数据源只返回需要的：wttr / OpenWeather / 自建接口一次请求就把多天
 * 全带回来了，本来就免费。只有和风是多花请求的，那边在取数时已经省了。
 *
 *   今天 + 未来 → 三格小条（今天/明天/后天）
 *   只要未来   → 两格小条（明天/后天）
 *   只要今天   → 地区名下面一行「今天 18~29°」
 *   都不要     → 只留实况
 */
export function applyDayPrefs(rows, cfg = {}) {
  const wantToday = cfg.todayRange !== false;
  const wantForecast = cfg.forecast !== false;
  // 「今天」用 label 判定而不是下标：返回的 days 不一定从今天开始
  const isToday = (d) => d?.label === '今天';
  return rows.map((r) => {
    const all = (r?.days || []).filter((d) => d && d.label);
    // 只开「今日温度区间」时故意让 days 为空：走「今天 N~M°」那一行，比单独一格好看
    const days = (wantToday && wantForecast)
      ? all
      : wantForecast ? all.filter((d) => !isToday(d)) : [];
    return {
      ...r,
      days,
      todayMin: wantToday ? r?.todayMin : null,
      todayMax: wantToday ? r?.todayMax : null,
      tomorrowMin: wantForecast ? r?.tomorrowMin : null,
      tomorrowMax: wantForecast ? r?.tomorrowMax : null,
      tomorrowWet: wantForecast ? r?.tomorrowWet : null,
    };
  });
}

/* ── 卡片 HTML ──────────────────────────────────────────────────── */

export const THEMES = {
  dark: {
    pageBg: '#0e1014', cardBg: '#14171d', border: '#262b35',
    rowBg: '#1b1f27', title: '#e8eaee', badge: '#8b93a1', section: '#6f7887',
    label: '#7f8896', value: '#eef0f4', sub: '#6f7887', accent: '#4c8dff',
    warm: '#f0a35e', cool: '#6fc3ff', ok: '#79cf8e', no: '#e8917d',
  },
  light: {
    pageBg: '#eef1f5', cardBg: '#ffffff', border: '#dfe4ec',
    rowBg: '#f5f7fa', title: '#1c2430', badge: '#6a7484', section: '#8b94a4',
    label: '#6a7484', value: '#171e28', sub: '#8b94a4', accent: '#2f6fe0',
    warm: '#d97a2b', cool: '#2b8fd9', ok: '#2f7d4a', no: '#c0392b',
  },
};

/** AQI 等级配色（level 1-6 = 优/良/轻度/中度/重度/严重）。深浅各一套：绿色在深卡上要提亮、白卡上要压暗。 */
const AIR_COLORS = {
  dark: ['#5ed48f', '#e9c95e', '#f19a4d', '#ea6350', '#bb5c96', '#ad4d4d'],
  light: ['#2b9c58', '#9c7a00', '#c96a19', '#c9372a', '#8d3d78', '#8a3030'],
};
const airColor = (level, theme) => {
  const i = Math.min(6, Math.max(1, Number(level) || 1)) - 1;
  return AIR_COLORS[theme === 'light' ? 'light' : 'dark'][i];
};

/** 主题对应的页面底色。渲染器要拿它裁掉截图底部空白，两边必须是同一个值。 */
export function pageBgOf(theme) {
  return (THEMES[theme] || THEMES.dark).pageBg;
}

/**
 * HTML 转义。
 *
 * 单引号也转 —— 当前属性全用双引号，所以 `'` 在这里暂时不是必需的；
 * 但哪天有人把某个属性改成 `style='...'`，少这一条的转义就是个注入面。
 * 一次转全，比记着「这里只能用双引号」可靠。
 */
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);

/**
 * @param {object[]} rows
 * @param {{scale?:number, theme?:'dark'|'light', showHours?:boolean, cacheMinutes?:number, now?:Date}} opt
 */
export function buildWeatherHtml(rows, { scale = 2, theme = 'dark', showHours, cacheMinutes = 15, now = new Date() } = {}) {
  const t = THEMES[theme] || THEMES.dark;
  const s = (n) => n * scale;
  const dateStr = `${now.getMonth() + 1} 月 ${now.getDate()} 日`;
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  const tempColor = (v) => (v >= 30 ? t.warm : v <= 5 ? t.cool : t.accent);
  // 卡片上要显示数据取到的时刻，否则「今天几度」到底是几点的数据用户无从判断
  const latestAt = rows.reduce((m, r) => Math.max(m, Number(r?.fetchedAt) || 0), 0);
  // 取出现最多的数据源而不是 rows[0]：署名是用来判断「这数据可不可信」的，不能张冠李戴
  const tally = new Map();
  for (const r of rows) tally.set(r?.source || 'wttr', (tally.get(r?.source || 'wttr') || 0) + 1);
  const topSrc = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'wttr';
  const srcLabel = rows.length ? getSource(topSrc).label.replace(/\s*（.*?）\s*/g, '') : '天气服务';

  // 自建接口只填 temp 是合法用法，其余字段会是 null —— 不守卫会渲染成「体感 null°」
  const has = (v) => v != null && v !== '';
  const withHours = shouldShowHours(rows, { showHours });

  const rowHtml = rows.map((r) => {
    const w = describe(r);
    const tmr = rangeText(r.tomorrowMin, r.tomorrowMax)
      ? `明天 ${rangeText(r.tomorrowMin, r.tomorrowMax)}${r.tomorrowWet ? ' · 有降水 ☔' : ''}` : '';
    // 数据源实际解析到的地点跟查询名不一样就标出来 —— wttr.in 对省份名会飘到随机小地方
    const resolved = r.resolved && r.resolved !== r.region ? `（${r.resolved}）` : '';
    const ds = (r.days || []).filter((d) => d && d.label);
    const today = !ds.length && rangeText(r.todayMin, r.todayMax) ? `今天 ${rangeText(r.todayMin, r.todayMax)}` : '';
    const stats = [
      has(r.feels) ? `体感 ${r.feels}°` : '',
      has(r.humidity) ? `湿度 ${r.humidity}%` : '',
    ].filter(Boolean).join(' · ');
    const stats2 = [
      has(r.wind) ? `${has(r.windDir) ? `${r.windDir} ` : ''}${r.wind} km/h` : (has(r.windDir) ? r.windDir : ''),
      has(r.pressure) ? `${r.pressure} hPa` : '',
      has(r.sunrise) ? `日出 ${r.sunrise}` : '',
      has(r.sunset) ? `日落 ${r.sunset}` : '',
    ].filter(Boolean).join(' · ');
    const daysHtml = ds.length ? `
      <div class="rdays">${ds.slice(0, 3).map((d) => `
        <div class="dcell">
          <div class="dl">${esc(d.label)}</div>
          <div class="di">${esc(iconOfText(d.text))}</div>
          <div class="dt">${esc(rangeText(d.min, d.max))}${d.wet ? ' ☔' : ''}</div>
        </div>`).join('')}</div>` : '';
    const hs = (r.hours || []).filter((h) => h && h.time && h.temp != null);
    const step = hourStepOf(hs);
    const hoursHtml = (withHours && hs.length >= 2) ? `
  <div class="rhours">
    <div class="hcap">${step === 1 ? '逐小时' : `每 ${step} 小时`} · 未来 ${(hs.length - 1) * step} 小时</div>
    <div class="hrow">${hs.map((h) => `
      <div class="hcell">
        <div class="ht">${esc(h.time)}</div>
        <div class="hi">${esc(iconOfText(h.text))}</div>
        <div class="hp">${esc(h.temp)}°</div>
      </div>`).join('')}</div>
  </div>` : '';
    const { ok, no } = splitIndices(r.indices);
    const idxHtml = (ok.length || no.length) ? `
      <div class="ridx">${
        (ok.length ? `<span class="iok">宜 ${esc(ok.slice(0, 5).map((x) => x.name).join('·'))}</span>` : '')
        + (no.length ? `<span class="ino">不宜 ${esc(no.slice(0, 5).map((x) => x.name).join('·'))}</span>` : '')
      }</div>` : '';
    // 非中国标准（如香港 AQHI (HK)=5「中」）必须把标准名标出来，否则被误读成「香港空气比北京好十倍」
    const a = r.air;
    const airHtml = (a && a.aqi != null) ? `
      <div class="rair">
        <span class="alevel" style="color:${airColor(a.level, theme)}">空气 ${esc(a.category || '—')}</span>
        <span class="anum">${a.isCn === false && a.standard ? esc(a.standard) : 'AQI'} ${esc(a.aqi)}</span>
        ${a.pm25 != null ? `<span class="anum">PM2.5 ${esc(a.pm25)}</span>` : ''}
        ${a.primary ? `<span class="anum">首要 ${esc(a.primary)}</span>` : ''}
      </div>` : '';
    return `
  <div class="row">
    <div class="ric">${esc(w.icon)}</div>
    <div class="rmain">
      <div class="rname">${esc(r.region)}${esc(resolved)}</div>
      <div class="rcond">${esc(w.cn)}${today ? ` · ${today}` : ''}</div>
      ${daysHtml || `<div class="rsub">${esc(tmr || ' ')}</div>`}
      ${airHtml}
      ${idxHtml}
    </div>
    <div class="rstats">
      ${has(r.temp) ? `<div class="rtemp" style="color:${tempColor(r.temp)}">${esc(r.temp)}°</div>` : ''}
      ${stats ? `<div class="rstat">${esc(stats)}</div>` : ''}
      ${stats2 ? `<div class="rstat">${esc(stats2)}</div>` : ''}
    </div>
  </div>${hoursHtml}`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html { overflow:hidden; }
  html,body { background:${t.pageBg}; }
  body { width:${s(CARD_W)}px; font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC","Segoe UI",sans-serif; -webkit-font-smoothing:antialiased; }
  .card { width:${s(CARD_W)}px; background:${t.cardBg}; border:1px solid ${t.border};
          border-radius:${s(16)}px; padding:${s(24)}px ${s(24)}px ${s(18)}px; }
  .head { display:flex; align-items:center; justify-content:space-between; margin-bottom:${s(16)}px; }
  .h1 { color:${t.title}; font-size:${s(19)}px; font-weight:600; }
  .badge { color:${t.badge}; font-size:${s(13)}px; }
  .row { display:flex; align-items:center; gap:${s(14)}px; background:${t.rowBg};
         border:1px solid ${t.border}; border-radius:${s(12)}px;
         padding:${s(14)}px ${s(16)}px; margin-bottom:${s(10)}px; }
  /* 只放 emoji 的元素字体栈必须把彩色 emoji 字体放最前：☀️(U+2600) 这类老码位在
     Segoe UI 里有黑色文字版字形，Chromium/Windows 会优先命中，深色卡上几乎看不见。 */
  .ric { font-family:"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif;
         font-size:${s(34)}px; width:${s(44)}px; text-align:center; flex:none; }
  .rmain { flex:1; min-width:0; }
  .rname { color:${t.title}; font-size:${s(17)}px; font-weight:600; }
  .rcond { color:${t.label}; font-size:${s(13)}px; margin-top:${s(4)}px; }
  .rsub { color:${t.sub}; font-size:${s(12)}px; margin-top:${s(2)}px; min-height:${s(15)}px; }
  .ridx { display:flex; gap:${s(12)}px; margin-top:${s(4)}px; font-size:${s(11.5)}px; flex-wrap:wrap; }
  .iok { color:${t.ok}; }
  .ino { color:${t.no}; }
  .rair { display:flex; gap:${s(10)}px; margin-top:${s(4)}px; font-size:${s(11.5)}px; flex-wrap:wrap; align-items:baseline; }
  .alevel { font-weight:600; }
  .anum { color:${t.sub}; }
  .rdays { display:flex; gap:${s(6)}px; margin-top:${s(8)}px; }
  .dcell { flex:1; background:${t.cardBg}; border:1px solid ${t.border}; border-radius:${s(8)}px;
           padding:${s(5)}px 0 ${s(4)}px; text-align:center; }
  .dl { color:${t.label}; font-size:${s(10.5)}px; }
  .di { font-family:"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif;
        font-size:${s(16)}px; line-height:1.35; }
  .dt { color:${t.value}; font-size:${s(11)}px; }
  .rhours { background:${t.rowBg}; border:1px solid ${t.border}; border-radius:${s(12)}px;
            padding:${s(8)}px ${s(8)}px ${s(6)}px; margin:${s(-4)}px 0 ${s(10)}px; }
  .hcap { color:${t.sub}; font-size:${s(10)}px; margin-bottom:${s(4)}px; }
  .hrow { display:flex; }
  .hcell { flex:1; text-align:center; min-width:0; }
  .ht { color:${t.sub}; font-size:${s(9.5)}px; }
  .hi { font-family:"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif;
        font-size:${s(14)}px; line-height:1.4; }
  .hp { color:${t.value}; font-size:${s(10.5)}px; }
  .rstats { text-align:right; flex:none; }
  .rtemp { font-size:${s(30)}px; font-weight:700; line-height:1; }
  .rstat { color:${t.label}; font-size:${s(11.5)}px; margin-top:${s(6)}px; }
  .foot { margin-top:${s(6)}px; color:${t.sub}; font-size:${s(11)}px; text-align:center; }
</style></head>
<body>
<div class="card">
  <div class="head"><div class="h1">🌤️ 今日天气</div><div class="badge">${esc(dateStr)} · 周${esc(week)}</div></div>
  ${rowHtml}
  <div class="foot">${esc(srcLabel)}${latestAt ? ` · 更新于 ${esc(hhmm(latestAt))}` : ''} · 每 ${Math.max(2, Number(cacheMinutes) || 15)} 分钟刷新</div>
</div>
</body></html>`;
}

/* ── 文字版兜底 ─────────────────────────────────────────────────── */
export function textCard(rows, now = new Date()) {
  const latestAt = rows.reduce((m, r) => Math.max(m, Number(r?.fetchedAt) || 0), 0);
  const lines = [`🌤️ 天气 · ${now.getMonth() + 1}月${now.getDate()}日${latestAt ? ` · 更新于 ${hhmm(latestAt)}` : ''}`];
  for (const r of rows) {
    const w = describe(r);
    const ds = (r.days || []).filter((d) => d && d.label);
    const parts = [];
    // 有三天数据就不重复写今天/明天
    if (!ds.length) {
      if (r.todayMax != null) parts.push(`今天 ${r.todayMin != null ? `${r.todayMin}~` : ''}${r.todayMax}°`);
      if (r.tomorrowMax != null) parts.push(`明天 ${r.tomorrowMin != null ? `${r.tomorrowMin}~` : ''}${r.tomorrowMax}°${r.tomorrowWet ? '有降水 ☔' : ''}`);
    }
    const resolved = r.resolved && r.resolved !== r.region ? `（数据源解析为 ${r.resolved}）` : '';
    const temp = r.temp != null ? ` ${r.temp}°` : '';
    const feels = r.feels != null ? `（体感 ${r.feels}°）` : '';
    const extras = [
      r.wind != null ? `${r.windDir ? `${r.windDir} ` : ''}${r.wind} km/h` : (r.windDir || ''),
      r.pressure != null ? `气压 ${r.pressure} hPa` : '',
      r.sunrise ? `日出 ${r.sunrise}` : '',
      r.sunset ? `日落 ${r.sunset}` : '',
    ].filter(Boolean).join('，');
    const idx = indexLine(r, { why: true });
    const air = airLine(r);
    lines.push(`${w.icon} ${r.region}${resolved} ${w.cn || cnText(r.text)}${temp}${feels}`
      + (parts.length ? `，${parts.join('，')}` : '')
      + (extras ? `，${extras}` : '')
      + (air ? `，${air}` : '')
      + (idx ? `，${idx}` : ''));
    if (ds.length) {
      lines.push(`　未来三天：${ds.map((d) =>
        `${d.label} ${rangeText(d.min, d.max)}${d.wet ? '☔' : ''}${d.text ? ` ${cnText(d.text)}` : ''}`).join(' / ')}`);
    }
    // 逐小时最多 6 个点，够回答「下午会不会下雨 / 几点最热」
    const hs = (r.hours || []).filter((h) => h && h.time && h.temp != null).slice(0, 6);
    if (hs.length >= 2) {
      const step = hourStepOf(hs);
      lines.push(`　${step === 1 ? '逐小时' : `每${step}小时`}：${hs.map((h) => `${h.time} ${h.temp}°${h.text ? ` ${cnText(h.text)}` : ''}`).join(' → ')}`);
    }
  }
  return lines.join('\n');
}

/**
 * 一行地区的文字摘要（给模型看的）。
 * 只写「当前几度什么天」不够：模型看不到卡片图，用户追问「后天呢」「下午会不会下雨」
 * 时它只能瞎编。所以未来三天、逐小时、日出日落、空气、宜忌都带上。
 */
export function briefOf(r) {
  const ds = (r.days || []).filter((d) => d && d.label);
  const hs = (r.hours || []).filter((h) => h && h.time && h.temp != null).slice(0, 6);
  const days = ds.length
    ? `，未来三天 ${ds.map((d) => `${d.label} ${rangeText(d.min, d.max)}${d.wet ? '☔' : ''}`).join(' / ')}` : '';
  const hours = hs.length >= 2
    ? `，${hourStepOf(hs) === 1 ? '逐小时' : `每${hourStepOf(hs)}小时`} ${hs.map((h) => `${h.time} ${h.temp}°`).join(' → ')}` : '';
  const idx = indexLine(r, { why: true });
  const air = airLine(r);
  const sun = [r.sunrise ? `日出 ${r.sunrise}` : '', r.sunset ? `日落 ${r.sunset}` : ''].filter(Boolean).join(' ');
  return `${r.region} ${r.temp != null ? `${r.temp}°` : ''}${describe(r).cn}${days}${hours}`
    + `${sun ? `，${sun}` : ''}${air ? `，${air}` : ''}${idx ? `，${idx}` : ''}`;
}

/**
 * 图片发出去之后回给模型的那段文本（模型看不见图，这是它唯一的依据）。
 *
 * 多地区必须**一行一个**：一行用「；」连起来的话，查了 5 个地区、卡片 5 行全对，
 * 模型回复里却只提第一个。分行 + 开头报「共 N 个地区」，模型才有可自查的清单。
 */
export function cardSummary(rows, failed = []) {
  return `天气卡已发出（共 ${rows.length} 个地区）：\n`
    + rows.map((r) => `· ${briefOf(r)}`).join('\n')
    // 部分失败也要点名：不说的话模型会以为这些地区也查到了，拿别的地区的数据去回答「上海呢」
    + (failed.length ? `\n没查到的：${failed.join('、')}（这几个没数据，别猜）` : '');
}

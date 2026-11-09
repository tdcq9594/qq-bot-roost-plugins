// weather-card 自带测试：不连 QQ、不发真实网络请求（全部注入假 fetchRef），
// 在纯 Node 里验证数据源解析、卡片 HTML/文字版、配额闸门与配置归一。
//
//   node --test plugins/weather-card/test/basic.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import plugin, { DEFAULTS, VERSION, internals } from '../index.js';
import {
  degToDir, dirToCn, toHm, dayLabel, thinHours, parseIndices, parseAir,
  isWetCode, codeToCn, textToCn, describe, pickPath, redactUrl,
  parseMap, parseHeaders, getSource, resetSourceCaches,
} from '../lib/sources.js';
import {
  CARD_W, rangeText, hourStepOf, splitIndices, indexLine, airLine,
  applyDayPrefs, buildWeatherHtml, textCard, briefOf, cardSummary,
} from '../lib/card.js';
import { findBrowser } from '../lib/render.js';

const {
  readCfg, parseRegions, parseKeywords, parseBroadcastTimes,
  parseTargets, extractRegion, isWeatherQuery, fetchWeather, checkDailyQuota,
} = internals;

/* ── 清单与版本同步 ─────────────────────────────────────────────── */

test('市场描述不超过 60 字，版本号两处字面量严格同步', () => {
  assert.ok(plugin.description.length <= 60, `description 有 ${plugin.description.length} 字`);
  assert.ok(plugin.shortDesc.length <= plugin.description.length + 20);
  assert.equal(plugin.version, VERSION);
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  assert.equal(plugin.id, 'weather-card');
});

test('readCfg 兼容值形态与 testkit 字段描述符形态', () => {
  const fromValues = readCfg({ config: { source: 'qweather', cacheMinutes: 1, dailyRequestLimit: -5 } });
  assert.equal(fromValues.source, 'qweather');
  assert.equal(fromValues.cacheMinutes, 2, '最小缓存 2 分钟');
  assert.equal(fromValues.dailyRequestLimit, 0, '负数钳制到 0');

  // 模拟 testkit 原样递进字段定义对象
  const fromDesc = readCfg({ config: plugin.config });
  assert.equal(fromDesc.source, DEFAULTS.source);
  assert.equal(fromDesc.regions, DEFAULTS.regions);
  assert.equal(fromDesc.cacheMinutes, DEFAULTS.cacheMinutes);
});

/* ── 地区 / 关键词 / 时间 / 目标解析 ────────────────────────────── */

test('parseRegions 支持多分隔符，先去重再截断到 6 个，保留带空格地名', () => {
  // 先去重再截断：重复项不该吃掉名额（早期是先截断，`北京,北京,...` 会只剩 5 个地区）
  assert.deepEqual(
    parseRegions('北京, 上海、杭州 西湖；New York\n成都,北京,武汉,西安,广州'),
    ['北京', '上海', '杭州 西湖', 'New York', '成都', '武汉'],
  );
  assert.deepEqual(
    parseRegions('北京,上海,杭州,成都,武汉,西安,广州,深圳'),
    ['北京', '上海', '杭州', '成都', '武汉', '西安'],
  );
  assert.deepEqual(parseRegions('', '上海, 杭州'), ['上海', '杭州']);
});

test('parseKeywords 与 isWeatherQuery 识别短句查询', () => {
  const kws = parseKeywords('天气, 气温、天气预报');
  assert.deepEqual(kws, ['天气', '气温', '天气预报']);
  assert.equal(isWeatherQuery('上海天气', kws), true);
  assert.equal(isWeatherQuery('今天天气怎么样？', kws), true);
  assert.equal(isWeatherQuery('/天气 上海', kws), false, '命令走命令路由');
  // 40 字门槛太宽，会打断叙述性长句；现在收到 20 字
  assert.equal(isWeatherQuery('明天上海天气适合穿什么衣服', kws), true, '带需求的问法仍要认');
  assert.equal(
    isWeatherQuery('今天开会讨论了很久关于天气变化对农业的影响以及相关政策的落实情况的总结报告', kws),
    false,
    '36 字的叙述长句不该触发出图',
  );
});

test('hourStepOf 取最小间隔，不受跨午夜与缺失点影响', () => {
  // 关键回归：18:00 → 次日 12:00 只有两个点时会算出 18 小时（真实 bug）
  assert.equal(hourStepOf([{ time: '18:00' }, { time: '12:00' }]), 18);
  // 但只要中间的点齐，最小间隔就是真实粒度
  assert.equal(hourStepOf([{ time: '18:00' }, { time: '21:00' }, { time: '00:00' }, { time: '03:00' }]), 3);
  assert.equal(hourStepOf([{ time: '14:00' }, { time: '15:00' }, { time: '16:00' }]), 1);
  // 中间缺几个点不应该把粒度拉大
  assert.equal(hourStepOf([{ time: '14:00' }, { time: '15:00' }, { time: '18:00' }, { time: '19:00' }]), 1);
  assert.equal(hourStepOf([{ time: '14:00' }]), 1);
  assert.equal(hourStepOf(null), 1);
});

test('extractRegion 从自然语言里抠出地名', () => {
  assert.equal(extractRegion('上海天气'), '上海');
  assert.equal(extractRegion('天气 杭州西湖'), '杭州西湖');
  assert.equal(extractRegion('北京和杭州的天气怎么样？'), '北京,杭州');
  assert.equal(extractRegion('今天天气怎么样？'), '', '未点名返回空串用默认列表');
  assert.equal(extractRegion('天气'), '');
});

test('parseBroadcastTimes 校验范围并规范化 HH:MM', () => {
  assert.deepEqual(
    parseBroadcastTimes('7:30, 09:05; 21:30, 25:99, 12:60, abc'),
    ['07:30', '09:05', '21:30'],
  );
  assert.deepEqual(parseBroadcastTimes(''), []);
});

test('parseTargets 只认 16~64 位 openid，拒绝纯短数字群号', () => {
  assert.deepEqual(
    parseTargets('44DE039E7B5FF07C7A770B4890644F97, 123456789, short, GROUP_OPENID_ABCDEF123456'),
    ['44DE039E7B5FF07C7A770B4890644F97', 'GROUP_OPENID_ABCDEF123456'],
  );
});

/* ── 方位 / 时间 / 天气码 / 脱敏 ───────────────────────────────── */

test('degToDir 与 dirToCn 空值守卫（不把 null 当 0° 北风）', () => {
  assert.equal(degToDir(null), '');
  assert.equal(degToDir(''), '');
  assert.equal(degToDir(0), '北');
  assert.equal(degToDir(90), '东');
  assert.equal(degToDir(225), '西南');
  assert.equal(dirToCn('WSW'), '西南偏西');
  assert.equal(dirToCn('invalid'), '');
});

test('toHm 兼容 12 小时制、24 小时制与 ISO 时间', () => {
  assert.equal(toHm('06:14 PM'), '18:14');
  assert.equal(toHm('12:05 AM'), '00:05');
  assert.equal(toHm('12:30 PM'), '12:30');
  assert.equal(toHm('07:08'), '07:08');
  assert.equal(toHm('2026-11-09T18:16+08:00'), '18:16');
});

test('codeToCn 覆盖雪码段（323-350 不再掉进多云兜底）', () => {
  assert.deepEqual(codeToCn(113), { cn: '晴', icon: '☀️' });
  assert.deepEqual(codeToCn(338), { cn: '雪', icon: '❄️' });
  assert.deepEqual(codeToCn(200), { cn: '雷阵雨', icon: '⛈️' });
  assert.equal(isWetCode(143), false, '雾不算降水');
  assert.equal(isWetCode(302), true);
  assert.deepEqual(describe({ code: null, text: '小到中雨' }), { cn: '雨', icon: '🌧️' });
});

test('redactUrl 剥掉全部 query 与路径里的长 token', () => {
  assert.equal(
    redactUrl('https://api.example.com/v1/abcdef0123456789ABCDEF/weather?apikey=SECRET&city=sh'),
    'https://api.example.com/v1/***/weather?<查询参数已省略>',
  );
});

test('pickPath、parseMap、parseHeaders 容忍坏输入', () => {
  const obj = { a: { b: [{ c: 42 }] } };
  assert.equal(pickPath(obj, 'a.b.0.c'), 42);
  assert.equal(pickPath(obj, 'a.b[0].c'), 42);
  assert.equal(pickPath(obj, 'a.nope.x'), undefined);
  assert.deepEqual(parseMap('{bad json'), {});
  assert.deepEqual(parseHeaders('X-Api-Key: abc123; Accept: application/json'), {
    'X-Api-Key': 'abc123',
    Accept: 'application/json',
  });
});

/* ── 生活指数 / 空气质量 / 日期裁剪 / HTML 与摘要 ──────────────── */

test('parseIndices 与 splitIndices 先判不宜再判适宜（「较不宜」不误入宜组）', () => {
  const list = parseIndices([
    { name: '运动指数', category: '较适宜', text: '去跑跑' },
    { name: '洗车指数', category: '不宜', text: '有雨' },
    { name: '钓鱼指数', category: '较不宜', text: '风大' },
    { name: '穿衣指数', category: '炎热', text: '短袖' },
  ]);
  assert.equal(list.length, 3, '穿衣指数不应混入宜忌');
  const { ok, no } = splitIndices(list);
  assert.deepEqual(ok.map((x) => x.name), ['运动']);
  assert.deepEqual(no.map((x) => x.name), ['洗车', '钓鱼']);
  assert.match(indexLine({ indices: list }, { why: true }), /不宜 洗车·钓鱼（有雨）/);
});

test('parseAir 优先取 cn-mee 标准，境外标准保留标准名', () => {
  const hk = parseAir({
    indexes: [{ code: 'hk-epd', name: 'AQHI (HK)', aqi: 5, category: '中', level: '2' }],
  });
  assert.equal(hk.isCn, false);
  assert.equal(airLine({ air: hk }), '空气 中，AQHI (HK) 5');

  const cn = parseAir({
    indexes: [
      { code: 'us-epa', name: 'AQI (US)', aqi: 80, category: '良', level: '2' },
      { code: 'cn-mee', name: 'AQI (CN)', aqi: 44, category: '优', level: '1', primaryPollutant: null },
    ],
    pollutants: [{ code: 'pm2p5', concentration: { value: 8 } }],
  });
  assert.equal(cn.isCn, true);
  assert.equal(cn.aqi, 44);
  assert.equal(cn.pm25, 8);
  assert.equal(airLine({ air: cn }), '空气 优，AQI 44，PM2.5 8');
});

test('applyDayPrefs 四种开关组合裁剪正确', () => {
  const raw = [{
    region: '上海', temp: 25,
    todayMin: 20, todayMax: 27, tomorrowMin: 18, tomorrowMax: 24, tomorrowWet: true,
    days: [
      { label: '今天', min: 20, max: 27, text: '晴' },
      { label: '明天', min: 18, max: 24, text: '雨', wet: true },
      { label: '后天', min: 19, max: 25, text: '多云' },
    ],
  }];
  // 只开 todayRange：days 置空走单行「今天 20~27°」
  const onlyToday = applyDayPrefs(raw, { todayRange: true, forecast: false })[0];
  assert.equal(onlyToday.days.length, 0);
  assert.equal(onlyToday.todayMax, 27);
  assert.equal(onlyToday.tomorrowMax, null);

  // 两个都开：三格小条
  const both = applyDayPrefs(raw, { todayRange: true, forecast: true })[0];
  assert.equal(both.days.length, 3);

  // 只开 forecast：过滤掉今天，留明天/后天两格
  const onlyFc = applyDayPrefs(raw, { todayRange: false, forecast: true })[0];
  assert.deepEqual(onlyFc.days.map((d) => d.label), ['明天', '后天']);
});

test('buildWeatherHtml 绝不出现 null 字样，且 >3 地区自动隐藏逐小时', () => {
  const sparse = [{ region: '自建测试', temp: 21, source: 'custom' }];
  const html1 = buildWeatherHtml(sparse, { theme: 'dark' });
  assert.ok(!html1.includes('null'), '缺字段时不能渲染出 null');
  assert.ok(html1.includes('21°'));

  const four = ['北京', '上海', '杭州', '成都'].map((r) => ({
    region: r, temp: 20,
    hours: [{ time: '12:00', temp: 20 }, { time: '15:00', temp: 22 }],
  }));
  const html4 = buildWeatherHtml(four, { theme: 'light' });
  assert.ok(!html4.includes('class="rhours"'), '>3 个地区默认不画逐小时条');
  assert.equal(hourStepOf(four[0].hours), 3);
});

test('cardSummary 多地区一行一个，并点名失败地区', () => {
  const s = cardSummary(
    [{ region: '北京', temp: 20, text: '晴' }, { region: '上海', temp: 26, text: '多云' }],
    ['火星（查不到）'],
  );
  assert.match(s, /共 2 个地区/);
  assert.match(s, /· 北京 20°晴\n· 上海 26°多云/);
  assert.match(s, /没查到的：火星/);
});

/* ── 数据源假请求 + 缓存 + 每日配额闸门 ────────────────────────── */

test('fetchWeather 缓存命中不重复请求，且 dailyRequestLimit 到顶拦住', async () => {
  resetSourceCaches();
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          current_condition: [{ temp_C: '23', FeelsLikeC: '24', humidity: '55', windspeedKmph: '12', weatherCode: '113', weatherDesc: [{ value: 'Sunny' }], winddir16Point: 'SE', pressure: '1012' }],
          nearest_area: [{ areaName: [{ value: 'Shanghai' }], country: [{ value: 'China' }] }],
          weather: [{ date: '2099-01-01', maxtempC: '26', mintempC: '19', astronomy: [{ sunrise: '06:00 AM', sunset: '06:00 PM' }], hourly: [{ time: '1200', tempC: '25', weatherCode: '113', weatherDesc: [{ value: 'Sunny' }] }] }],
        };
      },
    };
  };

  const state = {};
  const cfg = { ...DEFAULTS, source: 'wttr', cacheMinutes: 15, dailyRequestLimit: 2 };
  const r1 = await fetchWeather('上海', { state, cfg, fetchRef: fakeFetch });
  assert.equal(r1.temp, 23);
  assert.equal(r1.cached, false);
  assert.equal(calls, 1);

  const r2 = await fetchWeather('上海', { state, cfg, fetchRef: fakeFetch });
  assert.equal(r2.cached, true);
  assert.equal(calls, 1, '缓存命中不应再发请求');

  // 模拟配额用满
  state.quota = { day: state.quota.day, used: 2 };
  await assert.rejects(
    () => fetchWeather('杭州', { state, cfg, fetchRef: fakeFetch }),
    /今日天气请求已达上限/,
  );
});

test('findBrowser 返回字符串（找到或空串），不抛错', () => {
  const b = findBrowser('');
  assert.equal(typeof b, 'string');
});

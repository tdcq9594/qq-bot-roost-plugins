/**
 * B 站网页端接口客户端（只读）
 * ============================
 *
 * 只做「看不做」：搜索、榜单、视频信息、字幕、热评、弹幕、UP 主。
 * 写接口（评论 / 弹幕 / 点赞 / 改资料）一行都没有 —— 这是本扩展的
 * **第一道安全边界**：模型即使被标题或评论里的注入文本带偏，也找不到
 * 任何能对外说话的注册工具。
 *
 * 移植自 aurabot `src/bili/api.js` 的只读部分（MIT 思路，零依赖重写），
 * 补了 B 站 2026 年的风控细节：
 *   · 没有 buvid3 时先申请（`x/frontend/finger/spi`），否则搜索直接 412；
 *   · 视频详情与搜索走 WBI 签名版，未签名的旧接口经常被风控；
 *   · 请求之间随机间隔 0.5–0.9 s，避免一轮里几十个请求同一秒打出去；
 *   · 命中 412 / -352 后进程内退避 10 分钟，不再继续撞墙。
 *
 * 零外部依赖，只用 Node 内置能力。
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** WBI 的 mixin 表：把 img_key + sub_key 混成 32 位。 */
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

/** 这些错误码说明「今天先别刷了」，统一翻成人话。 */
const PAUSE_CODES = {
  '-101': 'B 站说没登录（Cookie 失效了）',
  '-111': 'Cookie 里的 bili_jct 不对',
  '-352': '被 B 站风控了',
  '-412': '被 B 站风控了',
  '-509': '请求太频繁，被 B 站限流了',
  12015: 'B 站要求验证码',
};

const EXT_ROOT = dirname(fileURLToPath(import.meta.url));
/** 扩展自己的目录：清单与 cookie.txt 都在这里。 */
export const EXT_DIR = dirname(EXT_ROOT);

export class BiliError extends Error {
  constructor(message, { code = 0, pause = false, hint = '' } = {}) {
    super(message);
    this.name = 'BiliError';
    this.code = code;
    this.pause = pause;
    this.hint = hint;
  }
}

const stripHtml = (s) => String(s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&#39;/g, "'");

/** 把用户粘贴的 Cookie 解析成键值；只认 B 站用得到的几个。 */
export function parseCookie(raw) {
  const out = {};
  for (const part of String(raw || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3', 'buvid4', 'sid'].includes(k)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

/** WBI 签名：参数按字典序拼好，末尾接 mixin 的 md5。 */
export function wbiSign(params, imgKey, subKey, now = Date.now()) {
  const raw = imgKey + subKey;
  const mixin = MIXIN.map((i) => raw[i]).join('').slice(0, 32);
  const p = { ...params, wts: Math.round(now / 1000) };
  const query = Object.keys(p)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${query}&w_rid=${createHash('md5').update(query + mixin).digest('hex')}`;
}

/**
 * 从链接或文字里认视频号：BV / av / b23 短链 / 番剧 ep、ss。
 * 短链要再跳一次才能拿到真实地址。
 */
export function findVideoId(text) {
  const s = String(text || '');
  const bv = s.match(/\b(BV[0-9A-Za-z]{10})\b/);
  if (bv) return { bvid: bv[1] };
  const av = s.match(/\bav(\d{3,})\b/i);
  if (av) return { aid: av[1] };
  const ep = s.match(/\bep(\d{3,})\b/i);
  if (ep) return { ep: ep[1] };
  const ss = s.match(/\bss(\d{3,})\b/i);
  if (ss) return { ss: ss[1] };
  const short = s.match(/https?:\/\/(?:b23\.tv|bili2233\.cn|b23\.wtf)\/[0-9A-Za-z]+/);
  if (short) return { short: short[0] };
  return null;
}

/** 秒 → 12:34 / 1:02:03 */
export function clockOf(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** 播放量 → 12.3万 / 1.2亿 */
export function playCount(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return `${(v / 1e8).toFixed(1).replace(/\.0$/, '')}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1).replace(/\.0$/, '')}万`;
  return String(v);
}

/** 发布时间 → 3天前 / 11-08 */
export function agoOf(ms, now = Date.now()) {
  if (!ms) return '';
  const d = Math.floor((now - ms) / 86400_000);
  if (d <= 0) {
    const h = Math.floor((now - ms) / 3600_000);
    if (h <= 0) return '刚刚';
    return `${h}小时前`;
  }
  if (d < 30) return `${d}天前`;
  const dt = new Date(ms);
  return `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 创建一个 API 客户端。
 * @param {object} o
 * @param {() => string} o.getCookie 返回原始 Cookie 头（空串 = 匿名）
 */
export function createBiliApi({ getCookie = () => '', log = () => {}, fetchImpl = fetch, cookieFile = join(EXT_DIR, 'cookie.txt') } = {}) {
  let wbi = null;            // { img, sub, at }
  let buvid = '';
  let lastCall = 0;
  let pausedUntil = 0;
  const cache = new Map();   // key -> { at, ttl, value }

  /** cookie.txt 按 mtime 热读：用户改完文件不用重启扩展。 */
  let cookieCache = { at: 0, file: '', text: '' };
  function cookieText() {
    let mtime = 0;
    try { mtime = statSync(cookieFile).mtimeMs; } catch { /* 没有文件就走匿名 */ }
    if (mtime && mtime !== cookieCache.at) {
      try {
        cookieCache = { at: mtime, file: cookieFile, text: readFileSync(cookieFile, 'utf8').trim() };
        log(`已载入 cookie.txt（${cookieCache.text ? '登录态' : '空文件'}）`);
      } catch (e) {
        log(`读 cookie.txt 失败：${e?.message ?? e}`);
      }
    }
    return cookieCache.text || getCookie() || '';
  }

  const cookieHeader = () => {
    const c = parseCookie(cookieText());
    if (!c.buvid3 && buvid) c.buvid3 = buvid;
    return Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; ');
  };

  function cached(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = fn();
    cache.set(key, { at: Date.now(), ttl, value });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return value;
  }

  /** 请求节流：两次 B 站请求之间随机停 0.5–0.9 s。 */
  async function throttle() {
    const wait = lastCall + rand(500, 900) - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
  }

  /**
   * `pauseOn412` 只给核心接口用。旁路接口（字幕 / 评论 / 弹幕 / UP 主空间）
   * 被风控不该把整个进程停十分钟 —— 那是「一个可选字段拿不到，整轮都废了」。
   */
  async function raw(url, { method = 'GET', headers = {}, timeoutMs = 12000, signal, redirect, pauseOn412 = true } = {}) {
    if (Date.now() < pausedUntil) {
      const left = Math.ceil((pausedUntil - Date.now()) / 60_000);
      throw new BiliError(`B 站还在风控期（约 ${left} 分钟），先别刷了`, { pause: true, hint: '等一会儿或者换个时间再试，别连着撞。' });
    }
    await throttle();
    const timeout = AbortSignal.timeout(timeoutMs);
    const r = await fetchImpl(url, {
      method,
      redirect,
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com', cookie: cookieHeader(), ...headers },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (r.status === 412 || r.status === 403) {
      if (pauseOn412) pausedUntil = Date.now() + 10 * 60_000;
      throw new BiliError(`B 站拒绝了这次请求（风控 ${r.status}）`, {
        code: r.status,
        pause: pauseOn412,
        hint: pauseOn412 ? '十分钟内别再刷，通常是短时间请求太多或没带 buvid。' : '',
      });
    }
    return r;
  }

  async function req(url, opts = {}) {
    const r = await raw(url, opts);
    const type = String(r.headers?.get?.('content-type') || '');
    if (type && !type.includes('json')) {
      throw new BiliError(`B 站回了一个网页而不是数据（HTTP ${r.status}），多半是被风控了`, { code: r.status });
    }
    let j;
    try {
      j = await r.json();
    } catch {
      throw new BiliError(`B 站回了个看不懂的东西（HTTP ${r.status}）`, { code: r.status });
    }
    const code = Number(j?.code);
    if (code !== 0) {
      const why = PAUSE_CODES[String(code)];
      const doPause = Boolean(why) && opts?.pauseOn412 !== false;
      if (doPause) pausedUntil = Date.now() + 10 * 60_000;
      throw new BiliError(`${why ?? 'B 站返回错误'}（code ${code}${j?.message ? `：${j.message}` : ''}）`, {
        code,
        pause: doPause,
        hint: doPause ? '先停下来，过十分钟再试；反复撞会加重风控。' : '',
      });
    }
    return j.data;
  }

  /** 没有 buvid3 时申请一个：搜索等接口缺了它会被直接风控。 */
  async function ensureBuvid() {
    if (buvid || parseCookie(cookieText()).buvid3) return;
    try {
      const d = await req('https://api.bilibili.com/x/frontend/finger/spi');
      buvid = d?.b_3 || '';
    } catch (e) {
      log(`申请 buvid 失败：${e?.message ?? e}`);
    }
  }

  /** 登录态 + WBI 签名用的两个 key（没登录也能拿到 key）。 */
  function nav() {
    return cached('nav', 10 * 60_000, async () => {
      const r = await raw('https://api.bilibili.com/x/web-interface/nav');
      const j = await r.json();
      const d = j?.data || {};
      const keyOf = (u) => String(u || '').split('/').pop().split('.')[0];
      if (d.wbi_img) wbi = { img: keyOf(d.wbi_img.img_url), sub: keyOf(d.wbi_img.sub_url), at: Date.now() };
      return {
        isLogin: Boolean(d.isLogin),
        uname: d.uname || '',
        mid: d.mid || 0,
        vip: Boolean(d.vipStatus),
      };
    });
  }

  async function signed(base, params) {
    if (!wbi || Date.now() - wbi.at > 6 * 3600_000) await nav();
    if (!wbi) throw new BiliError('拿不到 B 站的签名 key（nav 接口没返回 wbi_img）', { hint: '可能是网络或风控，过一会儿再试。' });
    const sep = base.includes('?') ? '&' : '?';
    return base + sep + wbiSign(params, wbi.img, wbi.sub);
  }

  /** 搜索视频。order: play / pubdate / dm / default */
  async function search(keyword, { order = 'play', limit = 6 } = {}) {
    await ensureBuvid();
    const orderMap = { play: 'click', pubdate: 'pubdate', dm: 'dm', default: 'totalrank' };
    const url = () => signed('https://api.bilibili.com/x/web-interface/wbi/search/type', {
      search_type: 'video', keyword, page: 1, order: orderMap[order] ?? 'click',
    });
    const mapOf = (d) => (d?.result || [])
      .filter((v) => v && v.bvid)
      .slice(0, limit)
      .map((v) => ({
        bvid: v.bvid,
        title: stripHtml(v.title),
        author: stripHtml(v.author),
        play: Number(v.play) || 0,
        danmaku: Number(v.video_review) || 0,
        duration: v.duration,
        pubdate: (Number(v.pubdate) || 0) * 1000,
        desc: stripHtml(v.description).slice(0, 160),
      }));

    let rows = mapOf(await req(await url()));
    // B 站在「连着好几个请求」时会回 code 0 + 空 result（软限流），等一下就正常。
    if (!rows.length) {
      await sleep(800);
      rows = mapOf(await req(await url()));
    }
    return rows;
  }

  /** 按昵称找 UP 主：[{mid, name, fans, sign, videos}] */
  async function searchUser(keyword, { limit = 5 } = {}) {
    await ensureBuvid();
    const d = await req(await signed('https://api.bilibili.com/x/web-interface/wbi/search/type', {
      search_type: 'bili_user', keyword, page: 1,
    }));
    return (d?.result || [])
      .filter((u) => u && u.mid)
      .slice(0, limit)
      .map((u) => ({
        mid: u.mid,
        name: stripHtml(u.uname),
        fans: Number(u.fans) || 0,
        sign: stripHtml(u.usign || '').slice(0, 60),
        videos: Number(u.videos) || 0,
      }));
  }

  /** 综合热门。 */
  async function hot({ ps = 20 } = {}) {
    await ensureBuvid();
    const d = await req(`https://api.bilibili.com/x/web-interface/popular?ps=${ps}&pn=1`);
    return (d?.list || []).map((v) => ({
      bvid: v.bvid,
      title: v.title,
      author: v.owner?.name || '',
      play: Number(v.stat?.view) || 0,
      like: Number(v.stat?.like) || 0,
      duration: Number(v.duration) || 0,
      pubdate: (Number(v.pubdate) || 0) * 1000,
      desc: String(v.desc || '').slice(0, 160),
      tname: v.tname || '',
    }));
  }

  /**
   * 每周必看。`number` 不传就是最新一期。
   *
   * 为什么用这个而不是「分区排行榜」：`ranking/v2?rid=N` 现在返回的是
   * 2025-03-31 那一周的冻结快照（rid 4 / 36 / 188 实测同一天），拿它当
   * 「现在游戏区第一」会当场露馅。每周必看是官方运营的固定栏目，日期真实。
   */
  async function weekly({ number = 0 } = {}) {
    await ensureBuvid();
    let issue = Number(number) || 0;
    if (!issue) {
      const d = await req('https://api.bilibili.com/x/web-interface/popular/series/list');
      issue = Number(d?.list?.[0]?.number) || 0;
      if (!issue) throw new BiliError('拿不到每周必看的期数');
    }
    const d = await req(`https://api.bilibili.com/x/web-interface/popular/series/one?number=${issue}`);
    const items = (d?.list || []).map((v) => ({
      bvid: v.bvid,
      title: v.title,
      author: v.owner?.name || '',
      play: Number(v.stat?.view) || 0,
      duration: Number(v.duration) || 0,
      pubdate: (Number(v.pubdate) || 0) * 1000,
    }));
    return { number: issue, name: d?.config?.name || '', subject: d?.config?.subject || '', items };
  }

  /** 视频详情。 */
  async function view({ bvid, aid }) {
    await ensureBuvid();
    const d = await req(await signed('https://api.bilibili.com/x/web-interface/wbi/view', bvid ? { bvid } : { aid }));
    return {
      bvid: d.bvid,
      aid: d.aid,
      cid: d.cid,
      title: stripHtml(d.title),
      desc: stripHtml(d.desc || '').slice(0, 600),
      author: stripHtml(d.owner?.name || ''),
      authorMid: d.owner?.mid || 0,
      play: Number(d.stat?.view) || 0,
      like: Number(d.stat?.like) || 0,
      coin: Number(d.stat?.coin) || 0,
      fav: Number(d.stat?.favorite) || 0,
      reply: Number(d.stat?.reply) || 0,
      danmakuCount: Number(d.stat?.danmaku) || 0,
      pubdate: (Number(d.pubdate) || 0) * 1000,
      duration: Number(d.duration) || 0,
      tname: d.tname || '',
      pages: Array.isArray(d.pages) ? d.pages.length : 1,
    };
  }

  /** 字幕全文（优先中文；AI 字幕要登录才有）。拿不到返回 ''。 */
  async function subtitle({ bvid, aid, cid }) {
    try {
      const d = await req(await signed('https://api.bilibili.com/x/player/wbi/v2', { ...(bvid ? { bvid } : { aid }), cid }), { pauseOn412: false });
      const list = d?.subtitle?.subtitles || [];
      const pick = list.find((s) => /zh|中文/.test(`${s.lan}${s.lan_doc}`)) || list[0];
      if (!pick?.subtitle_url) return { text: '', lang: '' };
      const url = pick.subtitle_url.startsWith('//') ? `https:${pick.subtitle_url}` : pick.subtitle_url;
      // 字幕地址来自接口返回值，只认 B 站自己的域名 —— 别让它把请求带到别处去。
      if (!/^https:\/\/[\w.-]*\.(hdslb\.com|bilibili\.com)\//i.test(url)) {
        log(`字幕地址不是 B 站域名，跳过：${url.slice(0, 80)}`);
        return { text: '', lang: '' };
      }
      const r = await raw(url, { timeoutMs: 12000, pauseOn412: false });
      const j = await r.json();
      const text = (j?.body || []).map((x) => String(x.content || '')).join(' ').replace(/\s+/g, ' ').trim();
      return { text, lang: pick.lan_doc || pick.lan || '' };
    } catch (e) {
      log(`拿字幕失败：${e?.message ?? e}`);
      return { text: '', lang: '', error: String(e?.message ?? e) };
    }
  }

  /** 热门评论（主楼）。 */
  async function comments(aid, { limit = 5 } = {}) {
    try {
      const d = await req(await signed('https://api.bilibili.com/x/v2/reply/wbi/main', {
        type: 1, oid: aid, mode: 3, plat: 1, web_location: 1315875,
      }), { pauseOn412: false });
      return (d?.replies || []).slice(0, limit).map((r) => ({
        name: stripHtml(r.member?.uname || ''),
        text: stripHtml(r.content?.message || '').slice(0, 160),
        like: Number(r.like) || 0,
        replies: Number(r.rcount) || 0,
      }));
    } catch (e) {
      log(`拿评论失败：${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * 弹幕抽样（旧版 list.so，返回 deflate 压缩的 XML）。
   * 只取前 N 条并按时间排序 —— 我们要的是「弹幕在刷什么」的体感，不是全量。
   */
  async function danmaku(cid, { limit = 8 } = {}) {
    try {
      const r = await raw(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, { timeoutMs: 12000, pauseOn412: false });
      const buf = Buffer.from(await r.arrayBuffer());
      const xml = buf.toString('utf8');
      if (!/<d p=/.test(xml)) return [];
      const rows = [...xml.matchAll(/<d p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g)].map((m) => {
        const parts = m[1].split(',');
        return { sec: Number(parts[0]) || 0, text: stripHtml(m[2]).slice(0, 60) };
      });
      // 均匀抽：从头到尾各取几条，比只取开头更能看出全片在聊什么
      const step = Math.max(1, Math.floor(rows.length / limit));
      return rows.filter((_, i) => i % step === 0).slice(0, limit).sort((a, b) => a.sec - b.sec);
    } catch (e) {
      log(`拿弹幕失败：${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * UP 主资料 + 最近投稿。
   *
   * `space/wbi/acc/info` 与 `space/wbi/arc/search` 的反爬很硬：带上一堆
   * `dm_img_*` 参数反而 412，裸参数（只 sign mid/ps/pn）才是通的 —— 这是
   * 实测出来的，别「补全」参数。资料用 `web-interface/card`（不需要 WBI）。
   */
  async function up({ mid, limit = 5 }) {
    await ensureBuvid();
    const card = await req(`https://api.bilibili.com/x/web-interface/card?mid=${mid}&photo=false`, { pauseOn412: false })
      .then((d) => d?.card || null)
      .catch(() => null);

    let videos = [];
    try {
      const d = await req(await signed('https://api.bilibili.com/x/space/wbi/arc/search', { mid, ps: limit, pn: 1 }), {
        pauseOn412: false,
        headers: { referer: `https://space.bilibili.com/${mid}/video` },
      });
      videos = (d?.list?.vlist || []).slice(0, limit).map((v) => ({
        bvid: v.bvid,
        title: stripHtml(v.title),
        play: Number(v.play) || 0,
        pubdate: (Number(v.created) || 0) * 1000,
        length: v.length,
      }));
    } catch (e) {
      log(`拿 UP 主投稿失败：${e?.message ?? e}`);
    }

    if (!card) throw new BiliError(`查不到 UP 主 ${mid}`, { hint: '可能是号写错了，或者空间被 B 站风控了。' });
    return {
      mid: card.mid,
      name: stripHtml(card.name || ''),
      sign: stripHtml(card.sign || '').slice(0, 120),
      level: card.level_info?.current_level || 0,
      fans: Number(card.fans) || 0,
      archive: Number(card.archive_count) || 0,
      videos,
    };
  }

  /** 番剧：ep 单集 / ss 整季，返回标题、集数与当前集。 */
  async function bangumi({ ep, ss }) {
    const param = ep ? `ep_id=${ep}` : `season_id=${ss}`;
    const r = await raw(`https://api.bilibili.com/pgc/view/web/season?${param}`, { timeoutMs: 12000 });
    const j = await r.json();
    const d = j?.result;
    if (j?.code !== 0 || !d) throw new BiliError(`番剧信息拿不到（code ${j?.code}）`, { code: j?.code || 0 });
    const eps = (d.episodes || []).map((x) => ({ id: x.id, title: x.title, long: x.long_title, cover: x.cover }));
    const cur = ep ? eps.find((x) => String(x.id) === String(ep)) : eps[0];
    return {
      title: d.title,
      type: d.type_name || '番剧',
      desc: stripHtml(d.evaluate || '').slice(0, 300),
      total: eps.length,
      current: cur ? { ...cur, link: `https://www.bilibili.com/bangumi/play/ep${cur.id}` } : null,
      episodes: eps.slice(0, 12),
    };
  }

  /** b23.tv 短链跳一下拿真实地址（只跟随 B 站自己的域名）。 */
  async function resolveShort(url) {
    const r = await raw(url, { redirect: 'manual', timeoutMs: 8000 });
    return r.headers.get('location') || '';
  }

  return {
    nav, search, searchUser, hot, weekly, view, subtitle, comments, danmaku, up, bangumi, resolveShort,
    /** 给工具层用的登录态（带 10 分钟缓存）。 */
    account: () => nav().catch(() => ({ isLogin: false, uname: '', mid: 0, vip: false })),
    /** 只读状态：给 --status 自检用。 */
    state: () => ({ hasCookie: Boolean(cookieText()), pausedUntil, cache: cache.size, wbi: Boolean(wbi), buvid: Boolean(buvid) }),
  };
}

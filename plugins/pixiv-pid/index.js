/**
 * Pixiv 发图（pixiv-pid）
 * ======================
 *
 * 群里有人发「pid 12345678」「PID:12345678」「pixiv id 12345678」「作品号 12345678」
 * 或者直接贴 pixiv 作品链接，机器人就把那张图取回来、连同作品号发到当前会话。
 *
 * 取图链路（这台机器上实测过）：
 *   https://pixiv.re/{pid}.png  →  HTTP 200, image/jpeg（3.8s 左右，大陆可直连）
 *   https://i.pixiv.re/{pid}.png →  HTTP 404（❌ 这个域名只认带日期的完整路径：
 *                                    /img-original/img/YYYY/MM/DD/HH/MM/SS/{pid}_p0.jpg，
 *                                    光给 PID 拼不出来，别改回去）
 *
 * 为什么不直接把 URL 丢给平台去下载：
 *   ① 平台下载失败时没有任何回调，群里就是一句「图片发送失败」，查不出原因；
 *   ② pixiv.re 出错时会返回一张 HTML 错误页，平台会把它当图片上传，表现成「发出去个坏图」；
 *   ③ 本地落盘之后能复用、能看大小/尺寸、能限流，重发同一张几乎零成本。
 *   所以统一「插件自己下载 → 校验 magic → 落盘缓存 → 用本地路径发」。
 *
 * 关于元信息（标题/画师）：
 *   api.lolicon.app 的 `pids[]` 参数**不生效**（实测传 100000000 会返回一个完全
 *   不相干的随机作品），所以没法用它按 PID 反查标题；pixiv.net 的 /ajax/illust/{pid}
 *   在大陆直连不通。因此说明文字只放「Pixiv #PID + 图片尺寸」——这是能保证正确的部分，
 *   与其贴一个可能是别人的标题，不如不贴。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** 单张图最大 20MB —— 再大就没什么意思了，也省得把上传托死 */
const MAX_BYTES = 20 * 1024 * 1024;

/** 允许的扩展名（按 content-type / magic 归一化之后） */
const EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const DEFAULTS = {
  enabled: true,
  /** 一条消息里最多发几张（防止有人刷一串 pid 把额度打光） */
  maxPerMessage: 2,
  /** 本地缓存上限（张） */
  cacheFiles: 500,
  /** 图文同一条发（框架 >=0.6.13 才有 text 选项） */
  caption: true,
  /** 认不认 pixiv 作品链接 */
  allowLink: true,
  /** 触发前缀，逗号分隔 */
  prefixes: 'pid,pixiv id,pixivid,作品号,插画号,illust id,illustid',
  /** 取图地址模板，{pid} 会被替换 */
  sourceTemplate: 'https://pixiv.re/{pid}.png',
  /** 单张下载超时 */
  timeoutMs: 20000,
  /** 同一张图在同一个会话里 N 秒内重复发就不理（防止复读机） */
  dedupeSec: 60,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

function num(v, d, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, n));
}

function bool(v, d) {
  if (v === undefined || v === null || v === '') return d;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'on', '开', '是'].includes(s)) return true;
  if (['false', '0', 'no', 'off', '关', '否'].includes(s)) return false;
  return d;
}

/**
 * 触发前缀的切分。
 *
 * ⚠️ 这里**不能按空格切**：默认前缀里有「pixiv id」「illust id」这种带空格的写法，
 * 按空白切开就变成 `pixiv`、`id` 两个词 —— 而单独一个 `id` 会让
 * 「我的 id 12345678」这类日常聊天误触发（实测踩过）。所以只认显式分隔符。
 */
function list(v) {
  return String(v ?? '')
    .split(/[,，、;；|]+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * 读配置：**每次现读**，面板改完立刻生效（和 reply-judge 同一套做法）。
 * 夹具/面板没给值时全部落到 DEFAULTS，避免拿到一堆 undefined。
 */
function readCfg(ctx) {
  const c = ctx?.config ?? {};
  const pick = (k) => (c[k] === undefined || c[k] === null || c[k] === '' ? DEFAULTS[k] : c[k]);
  return {
    enabled: bool(c.enabled, DEFAULTS.enabled),
    maxPerMessage: num(pick('maxPerMessage'), DEFAULTS.maxPerMessage, 1, 5),
    cacheFiles: num(pick('cacheFiles'), DEFAULTS.cacheFiles, 10, 5000),
    caption: bool(c.caption, DEFAULTS.caption),
    allowLink: bool(c.allowLink, DEFAULTS.allowLink),
    prefixes: list(pick('prefixes')).length ? list(pick('prefixes')) : list(DEFAULTS.prefixes),
    sourceTemplate: String(pick('sourceTemplate') || DEFAULTS.sourceTemplate).trim(),
    timeoutMs: num(pick('timeoutMs'), DEFAULTS.timeoutMs, 3000, 60000),
    dedupeSec: num(pick('dedupeSec'), DEFAULTS.dedupeSec, 0, 3600),
  };
}

/* ------------------------------------------------------------------ */
/* 从文本里抠 PID                                                      */
/* ------------------------------------------------------------------ */

/** 正则里的元字符转义 —— 前缀是用户可配的，得防「pid(x)」这种写法把正则写炸 */
function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 做触发用的正则。
 *
 * 形态（实测覆盖常见写法）：
 *   pid 12345678 / PID:12345678 / pid12345678 / pid#12345678
 *   pixiv id 12345678 / 作品号 12345678 / 插画号12345678 / illust id 12345678
 *   https://www.pixiv.net/artworks/12345678 （allowLink 时）
 *   https://www.pixiv.net/i/12345678、?illust_id=12345678
 *   https://pixiv.re/12345678.png、.../12345678_p0_master1200.jpg
 *
 * 关键：前后都用 `(?<!\d)` / `(?!\d)` 卡住，避免把「20241103」这种日期、
 * 「1234567890123」这种长号截一段当 PID。
 */
export function buildTrigger(cfg) {
  const prefixes = (cfg?.prefixes?.length ? cfg.prefixes : list(DEFAULTS.prefixes));
  const pre = prefixes.sort((a, b) => b.length - a.length).map(esc).join('|');
  const parts = [
    // 前缀 + 可选分隔符 + 数字
    `(?<![0-9a-z])(?:${pre})\\s*[:：#\\-－_]*\\s*(\\d{4,12})(?![0-9])`,
  ];
  if (cfg?.allowLink !== false) {
    parts.push(
      `pixiv\\.net\\/(?:[a-z]{2}\\/)?(?:artworks|i)\\/(\\d{4,12})(?![0-9])`,
      `[?&]illust_id=(\\d{4,12})(?![0-9])`,
      `(?:i\\.)?pixiv\\.re\\/(\\d{4,12})(?![0-9])`,
      `\\/(\\d{4,12})_p\\d+`, // pximg 直链里的 xxx_p0
    );
  }
  return new RegExp(parts.join('|'), 'gi');
}

/**
 * 一条消息里所有 PID（去重、保序）。
 * 只做「能找到什么」，要不要发由调用方按 maxPerMessage 决定。
 */
export function extractPids(text, cfg) {
  const s = String(text ?? '');
  if (!s.trim()) return [];
  const re = buildTrigger(cfg);
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const pid = m.slice(1).find(Boolean);
    if (pid && !out.includes(pid)) out.push(pid);
    if (m.index === re.lastIndex) re.lastIndex += 1; // 空匹配保险，别死循环
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 尺寸探测（只认 magic，不引第三方库）                                 */
/* ------------------------------------------------------------------ */

/** JPEG：扫 SOFn 段 */
function jpegSize(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** 从文件头读出宽高与真实格式；认不出来返回 null（那就别发） */
export function probeImage(buf) {
  if (!buf || buf.length < 12) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: '.png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const s = jpegSize(buf);
    return { ext: '.jpg', w: s?.w ?? 0, h: s?.h ?? 0 };
  }
  // GIF
  if (buf.subarray(0, 3).toString('latin1') === 'GIF') {
    return { ext: '.gif', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  // WebP（VP8 / VP8L / VP8X 三种头）
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    const kind = buf.subarray(12, 16).toString('latin1');
    if (kind === 'VP8 ' && buf.length > 30) {
      return { ext: '.webp', w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
    if (kind === 'VP8L' && buf.length > 25) {
      const b = buf.readUInt32LE(21);
      return { ext: '.webp', w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X' && buf.length > 30) {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { ext: '.webp', w, h };
    }
    return { ext: '.webp', w: 0, h: 0 };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 下载                                                                */
/* ------------------------------------------------------------------ */

function describeHttp(status, pid) {
  if (status === 404 || status === 410) {
    return `Pixiv #${pid} 取不到：作品已删除，或者只允许登录后查看（R18 常见）`;
  }
  if (status === 403) return `Pixiv #${pid} 取不到：图床 403，可能需要登录态`;
  if (status === 429) return `Pixiv #${pid} 取不到：图床限流了，过一会儿再试`;
  return `Pixiv #${pid} 取不到：图床返回 HTTP ${status}`;
}

function describeNetError(e, timeoutMs) {
  const m = String(e?.message ?? e);
  if (/abort|timeout/i.test(m)) return `下载超时（${Math.round(timeoutMs / 1000)} 秒没响应）`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return `域名解析失败（${m}）`;
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i.test(m)) return `连接失败（${m}）`;
  return m;
}

export default {
  id: 'pixiv-pid',
  name: 'Pixiv 发图',
  version: '1.0.1',
  description: '群里出现「pid 12345678」就把那张 Pixiv 插画取回来发到会话，带缓存防重',
  // 图文同一条依赖 replyImage 的 text 选项
  frameworkVersion: '>=0.6.13',
  priority: 40,

  config: {
    enabled: { type: 'boolean', default: true, label: '启用 Pixiv 发图', desc: '关掉后既不响应关键词，也不响应 /pid 命令。' },
    maxPerMessage: { type: 'number', default: 2, min: 1, max: 5, label: '一条消息最多发几张', desc: '有人一次刷一串 pid 时，只发前 N 张（默认 2，上限 5）。' },
    caption: { type: 'boolean', default: true, label: '图片带上作品号说明', desc: '开启后说明文字（Pixiv #号码 · 尺寸）和图片走同一条消息。' },
    allowLink: { type: 'boolean', default: true, label: '认 pixiv 作品链接', desc: '开启后 https://www.pixiv.net/artworks/12345678 这类链接也能触发。' },
    prefixes: { type: 'string', default: DEFAULTS.prefixes, label: '触发前缀', desc: '逗号分隔，默认 pid、pixiv id、作品号、插画号、illust id。' },
    sourceTemplate: { type: 'string', default: DEFAULTS.sourceTemplate, label: '取图地址模板', desc: '{pid} 会替换成作品号。默认 https://pixiv.re/{pid}.png（实测可用）。不要改成 i.pixiv.re/{pid}.png —— 那个域名只认带日期的完整路径，光给号码会 404。' },
    timeoutMs: { type: 'number', default: 20000, min: 3000, max: 60000, label: '下载超时（毫秒）', desc: '单张图超过这个时间就放弃。' },
    cacheFiles: { type: 'number', default: 500, min: 10, max: 5000, label: '本地缓存上限（张）', desc: '超过后自动删最久没发过的，重发同一张会重新下载。' },
    dedupeSec: { type: 'number', default: 60, min: 0, max: 3600, label: '重复抑制（秒）', desc: '同一张图在一个会话里 N 秒内被再要一次就不理，避免复读刷屏。0 = 不抑制。' },
  },

  async setup(ctx) {
    const log = ctx.logger;
    const DIR = ctx.dataDir;
    const CACHE_DIR = path.join(DIR, 'pid-cache');
    const INDEX_FILE = path.join(DIR, 'pid-index.json');

    await fs.mkdir(CACHE_DIR, { recursive: true });

    /* ---------------- 缓存索引 ---------------- */

    /** index: { items: [{ pid, file, size, w, h, at, used }] } */
    let index = { items: [] };
    try {
      index = JSON.parse(await fs.readFile(INDEX_FILE, 'utf8'));
      if (!Array.isArray(index.items)) index.items = [];
    } catch {
      /* 第一次跑，没有索引 */
    }
    const byPid = new Map(index.items.map((it) => [String(it.pid), it]));

    /** 串行 + 原子写：同一时刻只有一次落盘，且不会留下半截 JSON */
    let saving = Promise.resolve();
    const saveIndex = () => {
      saving = saving
        .then(async () => {
          const tmp = `${INDEX_FILE}.tmp`;
          await fs.writeFile(tmp, JSON.stringify(index, null, 1), 'utf8');
          await fs.rename(tmp, INDEX_FILE);
        })
        .catch((e) => log.warn(`[pixiv-pid] 索引写入失败：${e.message}`));
      return saving;
    };

    /** 超过上限就删最久没用的（文件 + 索引一起删） */
    async function prune() {
      const max = readCfg(ctx).cacheFiles;
      if (index.items.length <= max) return;
      index.items.sort((a, b) => (a.used ?? 0) - (b.used ?? 0) || a.at - b.at);
      const drop = index.items.splice(0, index.items.length - max);
      for (const it of drop) {
        byPid.delete(String(it.pid));
        await fs.unlink(path.join(CACHE_DIR, it.file)).catch(() => {});
      }
      log.info(`[pixiv-pid] 缓存超限，清掉 ${drop.length} 张`);
    }

    /* ---------------- 发送统计（面板用） ---------------- */

    const stat = {
      ok: 0,
      fail: 0,
      cacheHit: 0,
      recent: /** @type {string[]} */ ([]),
    };
    const pushRecent = (line) => {
      stat.recent.unshift(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${line}`);
      if (stat.recent.length > 8) stat.recent.length = 8;
    };

    let dashTimer = null;
    const refreshDashboard = () => {
      if (dashTimer) return;
      dashTimer = setTimeout(() => {
        dashTimer = null;
        try {
          ctx.setDashboard({
            metrics: [
              { label: '发送成功', value: stat.ok },
              { label: '发送失败', value: stat.fail },
              { label: '缓存命中', value: stat.cacheHit },
              { label: '缓存张数', value: index.items.length, unit: '张' },
            ],
            note: stat.recent.length ? `最近：${stat.recent.slice(0, 3).join('；')}` : '还没有人发过 pid',
          });
        } catch {
          /* 面板挂了不影响发图 */
        }
      }, 2000);
      if (typeof dashTimer.unref === 'function') dashTimer.unref();
    };

    /* ---------------- 重复抑制 ---------------- */

    /** `${chatId}:${pid}` -> 上次发送时间 */
    const sentAt = new Map();
    const recentlySent = (chatId, pid) => {
      const cfg = readCfg(ctx);
      if (!cfg.dedupeSec) return false;
      const at = sentAt.get(`${chatId}:${pid}`) || 0;
      return Date.now() - at < cfg.dedupeSec * 1000;
    };
    const markSent = (chatId, pid) => {
      sentAt.set(`${chatId}:${pid}`, Date.now());
      if (sentAt.size > 500) {
        const cutoff = Date.now() - 3600_000;
        for (const [k, v] of sentAt) if (v < cutoff) sentAt.delete(k);
      }
    };

    /* ---------------- 取一张图 ---------------- */

    /**
     * 把一张图弄到本地。
     * 返回 { file, size, w, h, hit } 或抛错（`e.friendly` 里是给人看的话）。
     */
    async function fetchImage(pid) {
      const cfg = readCfg(ctx);

      // 命中缓存：直接用，顺便把 used 抬一下（LRU 依据）
      const hit = byPid.get(String(pid));
      if (hit) {
        const file = path.join(CACHE_DIR, hit.file);
        try {
          await fs.access(file);
          hit.used = Date.now();
          stat.cacheHit += 1;
          void saveIndex();
          return { file, size: hit.size, w: hit.w, h: hit.h, hit: true };
        } catch {
          // 文件被手动删了：把索引里的残条清掉再重新下
          byPid.delete(String(pid));
          index.items = index.items.filter((it) => String(it.pid) !== String(pid));
        }
      }

      const url = String(cfg.sourceTemplate).replaceAll('{pid}', String(pid));
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
      let resp;
      try {
        resp = await fetch(url, {
          headers: { 'user-agent': UA, accept: 'image/*', referer: 'https://www.pixiv.net/' },
          signal: ac.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        const msg = describeNetError(e, cfg.timeoutMs);
        const err = new Error(msg);
        err.friendly = msg;
        throw err;
      }

      if (!resp.ok) {
        clearTimeout(timer);
        const msg = describeHttp(resp.status, pid);
        const err = new Error(`HTTP ${resp.status}`);
        err.friendly = msg;
        throw err;
      }

      /**
       * ⚠️ 超时定时器要留到**正文读完**才清。
       * fetch() 在收到响应头时就 resolve 了，之后读 body 完全不受 signal 约束——
       * 实测 pixiv.re 冷门作品「头部秒回、正文传 20 秒」，如果按原样在拿到
       * 响应头时就 clearTimeout，设的超时就形同虚设（一张 6.6MB 的图真等了 22 秒）。
       */
      let buf;
      try {
        buf = Buffer.from(await resp.arrayBuffer());
      } catch (e) {
        const msg = describeNetError(e, cfg.timeoutMs);
        const err = new Error(msg);
        err.friendly = `Pixiv #${pid} 图片本体没下完：${msg}`;
        throw err;
      } finally {
        clearTimeout(timer);
      }

      if (!buf.length) {
        const err = new Error('empty');
        err.friendly = `Pixiv #${pid} 取回来是空文件`;
        throw err;
      }
      if (buf.length > MAX_BYTES) {
        const err = new Error('too large');
        err.friendly = `Pixiv #${pid} 有 ${(buf.length / 1048576).toFixed(1)}MB，太大了不发`;
        throw err;
      }

      // 图床出错时会返回 HTML 错误页 —— 这里必须拦，否则会发出去一张坏图
      const probe = probeImage(buf);
      if (!probe) {
        const type = String(resp.headers.get('content-type') ?? '');
        const err = new Error(`not an image: ${type}`);
        err.friendly = `Pixiv #${pid} 取回来的不是图片（${type || '未知类型'}）`;
        throw err;
      }

      const ext = EXT_BY_TYPE[String(resp.headers.get('content-type') ?? '').toLowerCase()] || probe.ext;
      const file = `${pid}${ext}`;
      const dest = path.join(CACHE_DIR, file);
      await fs.writeFile(dest, buf);

      const item = {
        pid: String(pid),
        file,
        size: buf.length,
        w: probe.w,
        h: probe.h,
        at: Date.now(),
        used: Date.now(),
      };
      byPid.set(String(pid), item);
      index.items = index.items.filter((it) => String(it.pid) !== String(pid));
      index.items.push(item);
      await prune();
      await saveIndex();
      log.info(`[pixiv-pid] #${pid} 下载完成 ${file}（${(buf.length / 1024).toFixed(0)}KB ${probe.w}×${probe.h}）`);
      return { file: dest, size: buf.length, w: probe.w, h: probe.h, hit: false };
    }

    /** 排队：一个人连发三个 pid 时别同时建立三条连接 */
    let chain = Promise.resolve();
    const enqueue = (fn) => {
      const p = chain.then(fn, fn);
      chain = p.catch(() => {});
      return p;
    };

    function captionOf(pid, info) {
      const parts = [`Pixiv #${pid}`];
      if (info?.w && info?.h) parts.push(`${info.w}×${info.h}`);
      if (info?.size) parts.push(`${(info.size / 1024).toFixed(0)}KB`);
      return parts.join(' · ');
    }

    /**
     * 取一张并发送。返回 true = 发出去了（或这张图刚发过，主动跳过）。
     * 所有错误都在这里变成一句话回给用户，绝不冒到事件循环外面。
     */
    async function sendOne(msg, pid, { force = false } = {}) {
      const cfg = readCfg(ctx);
      const chatId = msg.chatId || msg.groupId || '';

      if (!force && recentlySent(chatId, pid)) {
        log.debug(`[pixiv-pid] #${pid} 刚发过，跳过`);
        return true;
      }

      let info;
      try {
        info = await enqueue(() => fetchImage(pid));
      } catch (e) {
        stat.fail += 1;
        const why = e?.friendly || e?.message || String(e);
        pushRecent(`#${pid} 失败：${why}`);
        refreshDashboard();
        await msg.reply(why);
        return false;
      }

      const text = cfg.caption ? captionOf(pid, info) : '';
      let sent = null;
      try {
        sent = await msg.replyImage(info.file, { local: true, ...(text ? { text } : {}) });
      } catch (e) {
        log.warn(`[pixiv-pid] #${pid} 发送异常：${e.message}`);
      }

      if (sent === null || sent === undefined) {
        stat.fail += 1;
        pushRecent(`#${pid} 发送失败（上传没成功）`);
        refreshDashboard();
        await msg.reply(`图下好了但没发出去（官方上传接口失败）。\n${text || `Pixiv #${pid}`}\n本地已缓存：${path.basename(info.file)}`);
        return false;
      }

      stat.ok += 1;
      markSent(chatId, pid);
      pushRecent(`#${pid} 已发送${info.hit ? '（缓存）' : ''}`);
      refreshDashboard();
      return true;
    }

    /* ---------------- 被动触发 ---------------- */

    ctx.on('message', async (msg) => {
      const cfg = readCfg(ctx);
      if (!cfg.enabled) return false;
      if (msg.isBot === true || msg.raw?.author?.bot === true) return false;

      const pids = extractPids(msg.content, cfg);
      if (!pids.length) return false;

      const picked = pids.slice(0, cfg.maxPerMessage);
      log.info(`[pixiv-pid] ${msg.kind === 'group' ? '群' : '私聊'}消息里发现 PID：${picked.join(', ')}${pids.length > picked.length ? `（另有 ${pids.length - picked.length} 个超出上限）` : ''}`);

      /**
       * **先认领再下载**，不能等图发完。
       *
       * 认领是「这条我接了，别人别管」：框架在派发给每个监听器之前才检查
       * `skipBecauseClaimed`，所以只要在下载开始前认领，排在我后面、
       * 优先级更低的 ai-chat（priority −100）就不会再拿这条消息去聊天。
       * 反过来，等下载完（冷门作品要 20 秒）再 claim，ai-chat 早就凑上来了，
       * 群里会先冒一句莫名其妙的聊天回复，然后才出图。
       */
      msg.claim?.();

      for (const pid of picked) {
        // 一张一张发：图多的时候连着传容易撞官方限流
        await sendOne(msg, pid);
        if (picked.length > 1) await sleep(600);
      }
      return true;
    });

    /* ---------------- 命令 ---------------- */

    /** 取图命令：私聊、群聊、任何场景都能用（指令天然绕过 reply-judge 的闸门） */
    ctx.command('pid [号码]', {
      desc: '按 Pixiv 作品号发图（可写多个，空格分隔）',
      usage: '/pid 12345678',
    }, async (msg) => {
      const cfg = readCfg(ctx);
      if (!cfg.enabled) {
        await msg.reply('Pixiv 发图功能关着，去面板「插件 → Pixiv 发图 → 设置」打开 enabled。');
        return;
      }
      const args = (msg.args ?? []).map((s) => String(s).trim()).filter(Boolean);
      if (!args.length) {
        await msg.reply('用法：/pid 12345678\n也可以直接在群里发「pid 12345678」。');
        return;
      }
      const pids = [];
      for (const a of args) {
        const found = extractPids(a, cfg);
        if (found.length) pids.push(...found);
        else if (/^\d{4,12}$/.test(a)) pids.push(a); // 光给数字也认
      }
      const uniq = [...new Set(pids)].slice(0, cfg.maxPerMessage);
      if (!uniq.length) {
        await msg.reply('没看懂这个号码。用法：/pid 12345678');
        return;
      }
      for (const pid of uniq) {
        await sendOne(msg, pid, { force: true });
        if (uniq.length > 1) await sleep(600);
      }
    });

    /** 状态 / 清缓存 */
    ctx.command('pixiv', { desc: 'Pixiv 发图：看状态 / 清缓存', usage: '/pixiv [清]' }, async (msg) => {
      const cfg = readCfg(ctx);
      const sub = String((msg.args ?? [])[0] ?? '').trim();
      const needAdmin = async () => {
        try {
          if (ctx.isOwner?.(msg.userId)) return true;
          return Boolean(await ctx.can?.(msg, 'admin'));
        } catch {
          return false;
        }
      };

      if (sub === '清' || sub === 'clean') {
        if (!(await needAdmin())) {
          await msg.reply('清缓存要管理员。');
          return;
        }
        const n = index.items.length;
        for (const it of index.items) {
          await fs.unlink(path.join(CACHE_DIR, it.file)).catch(() => {});
        }
        index.items = [];
        byPid.clear();
        await saveIndex();
        await msg.reply(n ? `清掉了 ${n} 张缓存。` : '缓存本来就是空的。');
        return;
      }

      const total = index.items.reduce((s, it) => s + (it.size ?? 0), 0);
      await msg.reply(
        [
          `Pixiv 发图：${cfg.enabled ? '开' : '关'}｜缓存 ${index.items.length}/${cfg.cacheFiles} 张（${(total / 1048576).toFixed(1)}MB）`,
          `触发：「pid 12345678」「作品号 12345678」${cfg.allowLink ? '、pixiv 作品链接' : ''}（一条最多 ${cfg.maxPerMessage} 张）`,
          `取图源：${cfg.sourceTemplate}`,
          `本次运行：成功 ${stat.ok} · 失败 ${stat.fail} · 缓存命中 ${stat.cacheHit}`,
          '清缓存：/pixiv 清（管理员）',
        ].join('\n'),
      );
    });

    ctx.menu('Pixiv 发图', [
      { text: '群里发「pid 12345678」即可发图', desc: '也认 pixiv 作品链接、作品号、插画号' },
      { text: '/pid 12345678', desc: '手动按号码取图（可一次给多个）' },
      { text: '/pixiv', desc: '看缓存和统计' },
      { cmd: '/pixiv 清', desc: '清空本地图片缓存（管理员）' },
    ]);

    // 面板先推一份空数据，免得打开就是「暂无数据」
    refreshDashboard();

    log.info(
      `[pixiv-pid] 已就绪：触发前缀 ${readCfg(ctx).prefixes.join('/')}｜一条最多 ${readCfg(ctx).maxPerMessage} 张｜缓存上限 ${readCfg(ctx).cacheFiles} 张`,
    );
  },
};

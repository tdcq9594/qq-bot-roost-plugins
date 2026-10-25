/**
 * 二次元图 v2.0
 * ==============
 *
 * 发一张二次元图片到群里，图片和出处文字走**同一条消息**发出
 * （msg_type=7 富媒体消息自带的 content 字段，见框架 replyImage 的 text 选项）。
 *
 * 图源：夜轻 ACG API（https://api.yppp.net，文档 https://www.yeqing.net/blog/acg-api/）
 *
 *   pc    横图      https://api.yppp.net/pc?return=json
 *   pe    竖图      https://api.yppp.net/pe?return=json
 *   random 随机横竖（默认）
 *
 * 为什么不直接用自适应接口 /api：它按 User-Agent 判断跳 pc 还是 pe，
 * 机器人侧的 UA 不是移动端，调它永远落到 pc，还多一次 302。要竖图就
 * 直接调 pe。
 *
 * 和 v1（Lolicon 图源）的差别：
 *   1. 图源换成夜轻 API：国内腾讯云 CDN，不需要 key，?return=json
 *      直接给元数据。但它**不做去重**（官方原话「懒得做去重」），
 *      所以缓存按 URL 文件名去重，补货循环连续拿到重复图就收手。
 *   2. 没有标题/画师/pid 了，出处只剩「横图 2290×1200」这样的尺寸信息。
 *   3. 图片和出处合并成一条消息发出（v1 是先发图再发一句话，两条）。
 *
 * 缓存 / LRU 回收 / 后台补货 / 发送次数轮转的机制沿用 v1。
 *
 * 图片来源为互联网收集（QQ 群、壁纸网站等），可能包含 AIGC 作品，
 * API 未提供内容分级参数。请遵守原站规定，不要用于商业用途。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** 夜轻 ACG API：国内可直连，不需要 key */
const BASE = 'https://api.yppp.net';

/** 单张图最大 8MB——再大官方接口也传不动 */
const MAX_BYTES = 8 * 1024 * 1024;

/** 允许的图片扩展名 */
const EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/** 横/竖图的中文叫法，出处文字用 */
const TYPE_LABEL = { pc: '横图', pe: '竖图' };

/**
 * 图源限流：官方规定 10 秒内超过 20 次请求会触发 30 秒速率限制。
 * 留点余量——滑窗里攒到 18 次就排队等，不踩线。
 * 只统计 API 元数据请求，图片本体在 list.yppp.net，不占这里的额度。
 */
const RATE_WINDOW = 10_000;
const RATE_MAX = 18;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: 'anime-img',
  name: '二次元图',
  version: '2.0.0',
  description: '来张二次元图：夜轻图源拉取 → 本地缓存 → 图文同一条发到群里',
  // 图文同一条依赖框架 replyImage 的 text 选项（0.6.13 起）
  frameworkVersion: '>=0.6.13',

  async setup(ctx) {
    const log = ctx.logger;

    /** 配置（面板「插件 → 二次元图 → 设置」可改） */
    const cfg = {
      /**
       * 图类型：pc 横图 / pe 竖图 / random 随机横竖。
       * 面板存进来可能是字符串，甚至手打的大小写，这里统一小写比较。
       */
      type: 'random',
      /** 缓存上限（张） */
      maxFiles: 200,
      /** 缓存少于这个数就在后台补货 */
      minPool: 5,
      /** 单次拉取的超时 */
      timeoutMs: 25000,
      ...ctx.config,
    };

    const timeoutMs = () => Math.max(1000, Number(cfg.timeoutMs) || 25000);
    const maxFiles = () => Math.max(1, Number(cfg.maxFiles) || 200);

    const DIR = ctx.dataDir;
    const CACHE_DIR = path.join(DIR, 'imgcache');
    const INDEX_FILE = path.join(DIR, 'index.json');

    await fs.mkdir(CACHE_DIR, { recursive: true });

    /* ---------------- 缓存索引 ---------------- */

    /** items: [{ file, id, type, w, h, size, at, used }] */
    let index = { items: [] };
    try {
      index = JSON.parse(await fs.readFile(INDEX_FILE, 'utf8'));
      if (!Array.isArray(index.items)) index.items = [];
    } catch {
      /* 第一次跑，没有索引 */
    }

    /**
     * 索引写入：串行 + 原子。
     *
     * 串行：两次请求同时改索引，后写的不能把前一次盖掉。
     * 原子：先写 .tmp 再改名——直接 writeFile 的话，正好在写一半时被读到
     * （或进程被杀）会留下半截 JSON，下次启动整个索引就废了。
     */
    let saving = Promise.resolve();
    const saveIndex = () => {
      saving = saving.then(async () => {
        const tmp = `${INDEX_FILE}.tmp`;
        try {
          await fs.writeFile(tmp, JSON.stringify(index, null, 1), 'utf8');
          await fs.rename(tmp, INDEX_FILE);
        } catch (e) {
          log.warn(`[anime] 索引写入失败: ${e.message}`);
          await fs.unlink(tmp).catch(() => {});
        }
      });
      return saving;
    };

    /* ---------------- 图源 ---------------- */

    /** 图源限流滑窗：记最近的请求时间，超了排队等 */
    let apiTimes = [];
    async function rateLimit() {
      for (;;) {
        const now = Date.now();
        apiTimes = apiTimes.filter((t) => now - t < RATE_WINDOW);
        if (apiTimes.length < RATE_MAX) {
          apiTimes.push(now);
          return;
        }
        const wait = RATE_WINDOW - (now - apiTimes[0]) + 50;
        log.info(`[anime] 图源请求太密，等 ${Math.ceil(wait / 1000)} 秒`);
        await sleep(wait);
      }
    }

    /** 这次要横图还是竖图 */
    function pickType() {
      const t = String(cfg.type ?? 'random').trim().toLowerCase();
      if (t === 'pc' || t === 'pe') return t;
      return Math.random() < 0.5 ? 'pc' : 'pe';
    }

    /** 问 API 要一张图的元数据 */
    async function fetchMeta() {
      await rateLimit();
      const type = pickType();
      const r = await fetch(`${BASE}/${type}?return=json`, {
        signal: AbortSignal.timeout(timeoutMs()),
        headers: { 'user-agent': 'qq-bot-roost/anime-img' },
      });
      if (!r.ok) throw new Error(`图源返回 ${r.status}`);
      const j = await r.json();
      // 官方成功时 code 是字符串 "200"；失败时没有 acgurl
      if (String(j?.code) !== '200' || !j?.acgurl) {
        throw new Error(`图源没返回图片（code=${j?.code ?? '?'}）`);
      }
      return {
        type,
        url: String(j.acgurl),
        w: Number(j.width) || 0,
        h: Number(j.height) || 0,
        ext: normExt(j.size),
      };
    }

    /** 官方 size 字段给的是扩展名（"png" / "jpg"），不是字节数 */
    function normExt(s) {
      const e = String(s ?? '').trim().toLowerCase().replace(/^\./, '');
      return EXTS.has(`.${e}`) ? e : '';
    }

    /**
     * 缓存 id：图片 URL 的文件名主干。
     * 夜轻的图床文件名形如 `2025-10-4fa10e18f4b501b44ac16a481591009c.png`，
     * 日期 + 哈希，天然不重样，拿来当 id 正合适。
     */
    function idOf(url) {
      let stem = '';
      try {
        stem = path.basename(new URL(url).pathname).replace(/\.[^./]+$/, '');
      } catch {
        /* url 解析不了就退化成固定 id，反正还会按内容去重 */
      }
      const clean = stem.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
      return clean || 'img';
    }

    /** 扩展名优先看 URL，其次看 API 的 size 字段；都不认就返回空 */
    function extOf(url, fallback) {
      try {
        const e = path.extname(new URL(url).pathname).toLowerCase();
        if (EXTS.has(e)) return e;
      } catch {
        /* 同上 */
      }
      return fallback ? `.${fallback}` : '';
    }

    /**
     * 拉一张图进缓存。
     *
     * 返回 { item, fresh }：
     *   fresh=true  新下载的
     *   fresh=false 图源给了张缓存里已有的图（夜轻不去重，这很常见）
     *   item=null   格式不支持，这一张作废
     *
     * 调用方靠 fresh 判断「补货有没有进展」——不然图源一直给重复图时，
     * 「补到 N 张」的循环会永远停不下来。
     */
    async function download(meta) {
      const id = idOf(meta.url);
      const hit = index.items.find((x) => x.id === id);
      if (hit) return { item: hit, fresh: false };

      const ext = extOf(meta.url, meta.ext);
      if (!ext) return { item: null, fresh: false };

      const file = `${id}${ext}`;
      const dest = path.join(CACHE_DIR, file);

      const r = await fetch(meta.url, {
        signal: AbortSignal.timeout(timeoutMs()),
        headers: { 'user-agent': 'qq-bot-roost/anime-img' },
      });
      if (!r.ok) throw new Error(`图片下载失败 ${r.status}`);
      const type = String(r.headers.get('content-type') ?? '');
      if (!type.startsWith('image/')) throw new Error(`不是图片: ${type}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new Error('图片是空的');
      if (buf.length > MAX_BYTES) throw new Error(`图片太大（${(buf.length / 1048576).toFixed(1)}MB）`);

      await fs.writeFile(dest, buf);
      const item = {
        file,
        id,
        type: meta.type,
        w: meta.w,
        h: meta.h,
        size: buf.length,
        at: Date.now(),
        used: 0,
      };
      index.items.push(item);
      await prune();
      await saveIndex();
      log.info(`[anime] 缓存新图 ${file}（${(buf.length / 1024).toFixed(0)}KB）`);
      return { item, fresh: true };
    }

    /** 拉一张图进缓存（要新元数据） */
    const fetchOne = async () => download(await fetchMeta());

    /** 超上限就删最久没用的 */
    async function prune() {
      const max = maxFiles();
      if (index.items.length <= max) return;
      index.items.sort((a, b) => a.used - b.used || a.at - b.at);
      const drop = index.items.splice(0, index.items.length - max);
      for (const it of drop) {
        await fs.unlink(path.join(CACHE_DIR, it.file)).catch(() => {});
      }
      log.info(`[anime] 缓存超限，清掉 ${drop.length} 张`);
    }

    /** 从缓存里挑一张（最久没发的优先，保证轮转） */
    function pickCached() {
      if (!index.items.length) return null;
      const alive = [...index.items].sort((a, b) => a.used - b.used || a.at - b.at);
      return alive[0];
    }

    /**
     * 连续补货到 n 张（启动时用）。
     *
     * 图源不去重，连续拿到重复图就认为没进展：攒够 3 次 Miss 就收手，
     * 不然「补到 5 张」在图源图少的时候会变成死循环。
     * 中途失败就停——图源不通的话没必要死磕。
     */
    async function fillTo(n) {
      const target = Math.min(n, maxFiles());
      let miss = 0;
      while (index.items.length < target && miss < 3) {
        try {
          const { item, fresh } = await fetchOne();
          if (!item) miss += 1; // 格式不支持，换一张
          else if (fresh) miss = 0;
          else miss += 1; // 重复图，没进展
        } catch (e) {
          log.warn(`[anime] 补货失败: ${e.message}`);
          return;
        }
      }
    }

    /**
     * 发完图顺手再攒一张，往 maxFiles 长。
     *
     * 两道闸：同时只跑一个、两次之间至少隔 10 秒。
     * 没有冷却的话，用户连点几次就会连着打好几次图源。
     */
    let prefetching = false;
    let lastPrefetchAt = 0;
    const PREFETCH_GAP = 10_000;
    function ensurePool() {
      if (prefetching) return;
      if (Date.now() - lastPrefetchAt < PREFETCH_GAP) return;
      if (index.items.length >= maxFiles()) return;
      prefetching = true;
      lastPrefetchAt = Date.now();
      (async () => {
        try {
          await fetchOne();
        } catch (e) {
          log.warn(`[anime] 补货失败: ${e.message}`);
        } finally {
          prefetching = false;
        }
      })();
    }

    /* ---------------- 指令 ---------------- */

    /** 出处文字：新图源没有标题/画师，能给的就是横竖和尺寸 */
    const line = (it, fresh = false) => {
      const label = TYPE_LABEL[it.type] ?? '图';
      const dim = it.w && it.h ? ` ${it.w}×${it.h}` : '';
      return `${label}${dim}${fresh ? ' · 刚收录' : ''}`;
    };

    /** 发一张图：先挑缓存，没有再拉；图和出处同一条消息 */
    async function sendOne(msg) {
      let item = pickCached();
      let fresh = false;

      if (item) {
        // 文件被手动删过？跳过这条，重新拉
        try {
          await fs.access(path.join(CACHE_DIR, item.file));
        } catch {
          index.items = index.items.filter((x) => x.file !== item.file);
          await saveIndex();
          item = null;
        }
      }

      if (!item) {
        try {
          const r = await fetchOne();
          item = r.item;
          fresh = r.fresh;
        } catch (e) {
          await msg.reply(`图源没响应：${e.message}\n过会儿再试，或者检查这台机器能不能访问 api.yppp.net`);
          return;
        }
      }
      if (!item) {
        await msg.reply('这张图格式不支持（只收 jpg/png/gif/webp），换一张试试。');
        return;
      }

      item.used = (item.used ?? 0) + 1;
      await saveIndex();

      const caption = line(item, fresh);
      // text 会和图片走同一条富媒体消息；框架 < 0.6.13 会忽略 text（只发图），
      // 所以插件在 frameworkVersion 里卡了 >=0.6.13，不会走到那条路
      const sent = await msg.replyImage(path.join(CACHE_DIR, item.file), { local: true, text: caption });
      if (sent === null || sent === undefined) {
        // 图片没发出去（上传失败/额度），退回一句话，别让用户干等
        await msg.reply(`图没发出去（可能是官方接口上传失败）。\n${caption}\n本地已经缓存好了，过会儿再试。`);
        return;
      }

      ensurePool();
    }

    ctx.command('来张图', { desc: '随机来一张，出处和图同条发出' }, sendOne);
    ctx.command('二次元', { desc: '同 来张图' }, sendOne);
    ctx.command('acg', { desc: '同 来张图' }, sendOne);

    ctx.command('图库', { desc: '看本地缓存了多少张图' }, async (msg) => {
      const n = index.items.length;
      if (!n) {
        await msg.reply('图库还是空的，发一次 /来张图 就会开始攒。');
        return;
      }
      const total = index.items.reduce((s, it) => s + (it.size ?? 0), 0);
      const newest = index.items.reduce((a, b) => (a.at > b.at ? a : b));
      const oldest = index.items.reduce((a, b) => (a.at < b.at ? a : b));
      const pc = index.items.filter((it) => it.type === 'pc').length;
      const pe = n - pc;
      const fmt = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false });
      await msg.reply(
        [
          `图库：${n} 张，共 ${(total / 1048576).toFixed(1)}MB（横图 ${pc} · 竖图 ${pe}）`,
          `最早 ${fmt(oldest.at)} · 最新 ${fmt(newest.at)}`,
          `上限 ${maxFiles()} 张，超了会自动删最久没发过的。`,
        ].join('\n'),
      );
    });

    ctx.command('清图库', { desc: '清空本地图片缓存（管理员）', admin: true }, async (msg) => {
      const n = index.items.length;
      for (const it of index.items) {
        await fs.unlink(path.join(CACHE_DIR, it.file)).catch(() => {});
      }
      index.items = [];
      await saveIndex();
      await msg.reply(n ? `清掉了 ${n} 张缓存。` : '图库本来就是空的。');
    });

    /**
     * 菜单补充说明。
     *
     * 命令会自动进「指令」组（可点击），这里只放 v2 起用户能感觉到的变化。
     * **不在这里重复列命令**——那会和「指令」组撞车，/help 里同一个功能
     * 出现两遍，看着像 bug。条目不带 cmd，渲染出来是不可点的说明文字
     * （同 dice 插件「说明」组的做法）。
     */
    ctx.menu('二次元图', [
      { text: '图和出处同一条消息发出', desc: 'v2 起；以前是先发图、再补一句出处' },
      { text: '横图 / 竖图可切换', desc: '面板「插件 → 二次元图 → 设置」改 type' },
      { text: '图源是夜轻 ACG API', desc: 'api.yppp.net，国内 CDN，无需 key' },
    ]);

    // 启动时悄悄补到 minPool，第一张图不用等
    void fillTo(Number(cfg.minPool) || 5);
  },
};

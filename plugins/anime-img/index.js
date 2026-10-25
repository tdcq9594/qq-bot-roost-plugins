/**
 * 二次元图 v1.0
 * ==============
 *
 * 发一张二次元图片到群里。三条原则：
 *
 *   1. **国内图源**：用 Lolicon API（国内团队维护，https://api.lolicon.app），
 *      返回 JSON，带标题/作者/尺寸/pid，不用抓 HTML。
 *   2. **本地缓存**：第一次拉到就存到插件自己的目录（ctx.dataDir），
 *      之后优先发缓存里的。好处有俩：图源慢了不用每次等十几秒；
 *      官方接口上传本地文件比让它去拉远程 URL 稳（远程拉不动就发不出去）。
 *   3. **LRU 回收**：缓存上限默认 200 张，超了先删最久没被发过的。
 *
 * 指令：
 *   /来张图        随机发一张（缓存空了会现拉）
 *   /图库          看缓存里有多少张、占多大
 *   /清图库        清空缓存（管理员）
 *
 * 图片来源是 pixiv 上的作品，API 只返回 r18=false 的。请遵守原站规定，
 * 不要用于商业用途。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** Lolicon API：国内可直连，返回 JSON */
const LOLICON = 'https://api.lolicon.app/setu/v2';

/** 单张图最大 8MB——再大官方接口也传不动 */
const MAX_BYTES = 8 * 1024 * 1024;

/** 允许的图片扩展名 */
const EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

export default {
  id: 'anime-img',
  name: '二次元图',
  version: '1.0.0',
  description: '来张二次元图：国内图源拉取 → 本地缓存 → 发到群里',
  frameworkVersion: '>=0.6.0',

  async setup(ctx) {
    const log = ctx.logger;

    /** 配置（面板「插件 → 二次元图 → 设置」可改） */
    const cfg = {
      /** 图源，目前只实现 lolicon */
      source: 'lolicon',
      /** 缓存上限（张） */
      maxFiles: 200,
      /** 缓存少于这个数就在后台补货 */
      minPool: 5,
      /** 单次拉取的超时 */
      timeoutMs: 25000,
      ...ctx.config,
    };

    const DIR = ctx.dataDir;
    const CACHE_DIR = path.join(DIR, 'imgcache');
    const INDEX_FILE = path.join(DIR, 'index.json');

    await fs.mkdir(CACHE_DIR, { recursive: true });

    /* ---------------- 缓存索引 ---------------- */

    /** items: [{ file, pid, title, author, w, h, size, at, used }] */
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

    /* ---------------- 拉图 ---------------- */

    /** 问 API 要一张图的元数据 */
    async function fetchMeta() {
      const url = `${LOLICON}?r18=0&size=regular&num=1`;
      const r = await fetch(url, {
        signal: AbortSignal.timeout(cfg.timeoutMs),
        headers: { 'user-agent': 'qq-bot-roost/anime-img' },
      });
      if (!r.ok) throw new Error(`图源返回 ${r.status}`);
      const j = await r.json();
      if (j?.error) throw new Error(`图源报错: ${j.error}`);
      const d = j?.data?.[0];
      if (!d) throw new Error('图源没返回数据（可能是 r18 过滤后为空）');
      const imgUrl = d.urls?.regular || d.urls?.original || d.urls?.small;
      if (!imgUrl) throw new Error('图源没给图片地址');
      return {
        pid: d.pid,
        p: d.p ?? 0,
        title: String(d.title ?? '').trim(),
        author: String(d.author ?? '').trim(),
        w: d.width ?? 0,
        h: d.height ?? 0,
        url: imgUrl,
      };
    }

    /** 下载到缓存目录，返回索引条目；失败返回 null */
    async function download(meta) {
      const ext = path.extname(new URL(meta.url).pathname).toLowerCase();
      if (!EXTS.has(ext)) return null;

      const file = `${meta.pid}_${meta.p}.${ext.replace('.', '')}`;
      const dest = path.join(CACHE_DIR, file);

      // 已经在缓存里（同一个 pid）就不重复下
      const exists = index.items.find((x) => x.file === file);
      if (exists) return exists;

      const r = await fetch(meta.url, {
        signal: AbortSignal.timeout(cfg.timeoutMs),
        headers: {
          'user-agent': 'qq-bot-roost/anime-img',
          // pixiv 的图床对 referer 敏感，带上原站
          referer: 'https://www.pixiv.net/',
        },
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
        pid: meta.pid,
        title: meta.title,
        author: meta.author,
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
      return item;
    }

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
      const alive = index.items.filter((it) => it.used >= 0);
      if (!alive.length) return null;
      alive.sort((a, b) => a.used - b.used || a.at - b.at);
      return alive[0];
    }

    /** 缓存上限（配置可能是字符串，兜一下） */
    const maxFiles = () => Math.max(1, Number(cfg.maxFiles) || 200);

    /**
     * 连续补货到 n 张（启动时用）。
     * 中途失败就停——图源不通的话没必要死磕。
     */
    async function fillTo(n) {
      const target = Math.min(n, maxFiles());
      while (index.items.length < target) {
        try {
          await download(await fetchMeta());
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
          await download(await fetchMeta());
        } catch (e) {
          log.warn(`[anime] 补货失败: ${e.message}`);
        } finally {
          prefetching = false;
        }
      })();
    }

    /* ---------------- 指令 ---------------- */

    const line = (it) => {
      const bits = [it.title || '无题', it.author ? `by ${it.author}` : '', `pixiv ${it.pid}`];
      return bits.filter(Boolean).join(' · ');
    };

    /** 发一张图：先挑缓存，没有再拉 */
    async function sendOne(msg) {
      let item = pickCached();
      let fromCache = Boolean(item);

      if (item) {
        // 文件被手动删过？跳过这条，重新拉
        try {
          await fs.access(path.join(CACHE_DIR, item.file));
        } catch {
          index.items = index.items.filter((x) => x.file !== item.file);
          item = null;
          fromCache = false;
        }
      }

      if (!item) {
        try {
          item = await download(await fetchMeta());
        } catch (e) {
          await msg.reply(`图源没响应：${e.message}\n过会儿再试，或者检查这台机器能不能访问 api.lolicon.app`);
          return;
        }
      }
      if (!item) {
        await msg.reply('这张图格式不支持（只收 jpg/png/gif/webp），换一张试试。');
        return;
      }

      item.used = (item.used ?? 0) + 1;
      await saveIndex();

      const sent = await msg.replyImage(path.join(CACHE_DIR, item.file), { local: true });
      if (sent === null || sent === undefined) {
        // 图片没发出去（上传失败/额度），退回一句话，别让用户干等
        await msg.reply(`图没发出去（可能是官方接口上传失败）。\n${line(item)}\n本地已经缓存好了，过会儿再试。`);
        return;
      }

      await msg.reply(line(item) + (fromCache ? '' : ' · 刚收录'));
      ensurePool();
    }

    ctx.command('来张图', { desc: '随机来一张二次元图' }, sendOne);
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
      const fmt = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false });
      await msg.reply(
        [
          `图库：${n} 张，共 ${(total / 1048576).toFixed(1)}MB`,
          `最早 ${fmt(oldest.at)} · 最新 ${fmt(newest.at)}`,
          `上限 ${cfg.maxFiles} 张，超了会自动删最久没发过的。`,
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

    ctx.menu('二次元图', [
      { text: '来张图', desc: '随机一张' },
      { text: '图库', desc: '缓存统计' },
    ]);

    // 启动时悄悄补到 minPool，第一张图不用等
    void fillTo(Number(cfg.minPool) || 5);
  },
};

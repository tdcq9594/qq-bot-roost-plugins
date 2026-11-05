// 禁漫漫画下载（jm-comic）—— roost 插件
//
// 群里出现「jm123456」这类 ID（或 18comic 的 album/photo 链接），机器人就把这本
// 从站点拉下来：还原竖切打乱 → 合成 PDF → 把文件发回提出请求的会话。
import fsp from 'node:fs/promises';
import path from 'node:path';

import { createClient, normalizeAlbumId, sanitizeSegment, imageFileName } from './engine.js';
import { findFfmpeg, resetFfmpegCache, ffmpegHint, segmentationNum, toJpeg } from './image.js';
import { writePdf } from './pdf.js';

const CACHE_FRESH_MS = 12 * 60 * 60 * 1000; // 成品 12 小时内直接重发
const TASK_KEEP = 50;

export const DEFAULTS = {
  enabled: true,
  outputFormat: 'pdf',
  descramble: true,
  pdfQuality: 85,
  pdfMaxDim: 0,
  allChapters: true,
  maxPages: 500,
  concurrency: 4,
  timeoutSec: 30,
  uploadTarget: 'request',
  maxFileMB: 90,
  keepDays: 7,
  apiDomains: '',
  proxy: '',
  progress: true,
  ffmpegPath: '',
};

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};

/** 读配置：面板没给值（夹具、首次加载）时用 DEFAULTS 兜底。 */
export function readCfg(ctx) {
  const c = ctx?.config ?? {};
  const pick = (k, ok) => {
    const v = c[k];
    if (v === undefined || v === null) return DEFAULTS[k];
    if (typeof ok === 'function') return ok(v) ? v : DEFAULTS[k];
    return v;
  };
  return {
    enabled: pick('enabled', (v) => typeof v === 'boolean'),
    outputFormat: pick('outputFormat', (v) => v === 'pdf' || v === 'images'),
    descramble: pick('descramble', (v) => typeof v === 'boolean'),
    pdfQuality: clamp(pick('pdfQuality'), 30, 95, DEFAULTS.pdfQuality),
    pdfMaxDim: clamp(pick('pdfMaxDim'), 0, 4000, DEFAULTS.pdfMaxDim),
    allChapters: pick('allChapters', (v) => typeof v === 'boolean'),
    maxPages: clamp(pick('maxPages'), 1, 2000, DEFAULTS.maxPages),
    concurrency: clamp(pick('concurrency'), 1, 8, DEFAULTS.concurrency),
    timeoutSec: clamp(pick('timeoutSec'), 5, 180, DEFAULTS.timeoutSec),
    uploadTarget: pick('uploadTarget', (v) => ['request', 'group', 'private', 'none'].includes(v)),
    maxFileMB: clamp(pick('maxFileMB'), 10, 190, DEFAULTS.maxFileMB),
    keepDays: clamp(pick('keepDays'), 0, 365, DEFAULTS.keepDays),
    apiDomains: String(pick('apiDomains') ?? ''),
    proxy: String(pick('proxy') ?? ''),
    progress: pick('progress', (v) => typeof v === 'boolean'),
    ffmpegPath: String(pick('ffmpegPath') ?? ''),
  };
}

/**
 * 从一句话里认出本来该下哪本。
 * · 链接（album/photo）一定能认；
 * · `jm123456` / `JM-123456` / `禁漫 123456` 能认；
 * · 纯数字只在「@了机器人」时才认 —— 否则群里随便一个数字都会被当成本子号。
 */
export function parseTrigger(text, { addressed = false } = {}) {
  const s = String(text ?? '').trim();
  if (!s) return '';

  const link = s.match(/(?:18comic\.[a-z]+|jm-comic\d?\.[a-z]+)\/(?:album|photo)\/(\d{2,9})/i);
  if (link) return link[1];

  const tag = s.match(/(?:^|[^\w])(?:jm|禁漫|本子)\s*[-_#:：]?\s*(\d{2,9})(?!\d)/i);
  if (tag) return tag[1];

  if (addressed) {
    const bare = s.replace(/@\S+/g, ' ').match(/(?:^|\s)(\d{4,9})(?:\s|$)/);
    if (bare) return bare[1];
  }
  return '';
}

function fmtBytes(n) {
  if (!n) return '0B';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function fmtTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${s % 60} 秒`;
}

function humanError(error) {
  const msg = String(error?.message ?? error ?? '未知错误');
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|超时/.test(msg)) {
    return `${msg}（网络或域名问题，可在设置里填「备用站点域名」或代理）`;
  }
  return msg;
}

/** 简单并发闸门：最多同时跑 n 个。 */
function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n) return;
    const job = queue.shift();
    if (!job) return;
    active++;
    job().finally(() => {
      active--;
      next();
    });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push(() => Promise.resolve().then(fn).then(resolve, reject));
      next();
    });
}

const sleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export default {
  id: 'jm-comic',
  name: '禁漫下载',
  version: '1.0.0',
  icon: '📚',
  shortDesc: '发「jm123456」就把这本漫画下好、还原、合成 PDF 发回会话',
  description: '群里发禁漫 ID（jm123456 / 18comic 链接），后台下载整本、还原竖切打乱、合成 PDF 并发回会话',
  frameworkVersion: '>=0.6.13',
  priority: 60,
  config: {
    enabled: { type: 'boolean', default: true, label: '启用下载', desc: '总开关；关掉后命令和关键词都不响应' },
    outputFormat: {
      type: 'select',
      default: 'pdf',
      options: ['pdf', 'images'],
      label: '输出格式',
      desc: 'pdf = 合成一本 PDF 发出去；images = 只把原图落盘（不上传，省流量）',
    },
    descramble: { type: 'boolean', default: true, label: '还原竖切打乱', desc: '按站点返回的 scramble_id 还原；关掉最快，但新本子的图是乱的' },
    pdfQuality: { type: 'number', default: 85, min: 30, max: 95, label: 'PDF 画质', desc: '嵌入 JPEG 的质量，数字越小体积越小' },
    pdfMaxDim: { type: 'number', default: 0, min: 0, max: 4000, label: 'PDF 单页最长边', desc: '0 = 保持原尺寸；填 1600 能显著减小体积' },
    allChapters: { type: 'boolean', default: true, label: '多章节全下', desc: '关掉只下第一章' },
    maxPages: { type: 'number', default: 500, min: 1, max: 2000, label: '每话最多页数', desc: '防止超长本子把磁盘写满' },
    concurrency: { type: 'number', default: 4, min: 1, max: 8, label: '同时下载几张', desc: '建议不超过 8，太大容易被站点限速' },
    timeoutSec: { type: 'number', default: 30, min: 5, max: 180, label: '单次请求超时（秒）', desc: '网络慢可以调大' },
    uploadTarget: {
      type: 'select',
      default: 'request',
      options: ['request', 'group', 'private', 'none'],
      label: '文件上传到哪',
      desc: 'request = 传回提出请求的会话；none = 只落盘不上传',
    },
    maxFileMB: { type: 'number', default: 90, min: 10, max: 190, label: '单文件上限（MB）', desc: '超过就先降画质重压一次；仍超限则只落盘' },
    keepDays: { type: 'number', default: 7, min: 0, max: 365, label: '本地保留天数', desc: '0 = 永不清理；超出天数的成品会在启动时被删掉' },
    apiDomains: { type: 'string', default: '', label: '备用站点域名', desc: '站点域名失效时填可用的，空格或逗号分隔（如 18comic.vip）' },
    proxy: { type: 'string', default: '', label: '下载走代理', desc: '如 http://127.0.0.1:7890；留空直连。需要运行环境里有 undici' },
    progress: { type: 'boolean', default: true, label: '在群里报进度', desc: '关掉只报开始与结果' },
    ffmpegPath: { type: 'string', default: '', label: 'ffmpeg 路径', desc: '一般不用填。会自动找 PATH 与 C:/ffmpeg/bin；找不到时填 bin 目录或 exe 路径' },
  },

  setup(ctx) {
    const log = ctx.logger;
    const root = path.join(ctx.dataDir || '.', 'jm');
    const tasks = new Map(); // albumId -> task
    let stats = { downloads: 0, files: 0, pages: 0, failed: 0, last: '' };
    let dashboardTimer = null;

    const ensureRoot = async () => {
      await fsp.mkdir(path.join(root, 'raw'), { recursive: true }).catch(() => {});
      await fsp.mkdir(path.join(root, 'pages'), { recursive: true }).catch(() => {});
    };

    const refreshDashboard = () => {
      if (dashboardTimer) return;
      dashboardTimer = setTimeout(async () => {
        dashboardTimer = null;
        const running = [...tasks.values()].filter((t) => t.state === 'running').length;
        const queued = [...tasks.values()].filter((t) => t.state === 'queued').length;
        try {
          ctx.setDashboard?.({
            metrics: [
              { label: '下载中', value: running },
              { label: '排队', value: queued },
              { label: '累计本数', value: stats.downloads },
              { label: '累计页数', value: stats.pages },
              { label: '发出文件', value: stats.files },
              { label: '失败', value: stats.failed },
              { label: '最近一次', value: stats.last || '—' },
            ],
            note: '发 jm<编号> 开始下载；/jm 状态 看队列',
          });
        } catch {
          /* 面板不是关键路径 */
        }
      }, 2000);
      dashboardTimer.unref?.();
    };

    const groups = {
      async list() {
        return (await ctx.storage.get('groups', [])) || [];
      },
      async add(chatId) {
        const list = await groups.list();
        if (!list.includes(chatId)) {
          list.push(chatId);
          await ctx.storage.set('groups', list);
        }
      },
      async remove(chatId) {
        const list = (await groups.list()).filter((x) => x !== chatId);
        await ctx.storage.set('groups', list);
      },
      async clear() {
        await ctx.storage.set('groups', []);
      },
      async allowed(chatId, kind) {
        if (kind !== 'group') return true; // 私聊不受白名单限制
        const list = await groups.list();
        return list.length === 0 || list.includes(chatId);
      },
    };

    /** 只有机主/群管能改开关类设置。 */
    const canManage = async (msg) => {
      try {
        if (ctx.isOwner?.(msg.userId)) return true;
        return Boolean(await ctx.can?.(msg, 'admin'));
      } catch {
        return false;
      }
    };

    const makeClient = (cfg) =>
      createClient({
        fetchImpl: globalThis.fetch,
        timeoutMs: () => cfg.timeoutSec * 1000,
        domains: cfg.apiDomains,
        proxy: cfg.proxy,
        warn: (m) => log.warn(`[jm-comic] ${m}`),
      });

    const reply = async (msg, text) => {
      try {
        await msg.reply?.(text);
      } catch (error) {
        log.warn(`[jm-comic] 回话失败：${error?.message ?? error}`);
      }
    };

    const progressOut = (task, text) => {
      if (!task.cfg.progress) return;
      const now = Date.now();
      if (now - (task.lastProgressAt || 0) < 15000) return;
      task.lastProgressAt = now;
      ctx.push?.(task.chatId, text, { kind: task.kind === 'group' ? 'group' : 'c2c' })?.catch?.(() => {});
    };

    /** 让一个任务停下来等「继续」。 */
    const waitIfPaused = async (task) => {
      while (task.state === 'paused') {
        if (task.canceled) return false;
        await sleep(600);
      }
      return !task.canceled;
    };

    const dirOf = (albumId) => path.join(root, 'raw', `jm-${albumId}`);

    // ───────────────────────── 主流程 ─────────────────────────

    async function runTask(task) {
      const cfg = task.cfg;
      task.state = 'running';
      task.startedAt = Date.now();
      refreshDashboard();

      const client = makeClient(cfg);
      const ff = await findFfmpeg(cfg.ffmpegPath);
      if (!ff.found) throw new Error(ffmpegHint(ff));

      const album = await client.albumInfo(task.albumId);
      task.title = album.name;
      const chapters = [];
      if (cfg.allChapters && album.series.length) {
        for (const ch of album.series) chapters.push({ id: ch.id, name: ch.name || `第${chapters.length + 1}话` });
      } else if (album.series.length) {
        const ch = album.series[0];
        chapters.push({ id: ch.id, name: ch.name || '第1话' });
      } else {
        chapters.push({ id: album.id, name: album.name });
      }
      task.chapters = chapters.length;
      task.totalPages = 0;

      if (cfg.progress) {
        await ctx.push?.(
          task.chatId,
          `开始下载 JM${album.id}《${album.name}》— ${chapters.length} 话`,
          { kind: task.kind === 'group' ? 'group' : 'c2c' },
        );
      }

      const workDir = dirOf(album.id);
      const pageDir = path.join(workDir, 'pages');
      await fsp.mkdir(pageDir, { recursive: true });

      const concurrency = limiter(cfg.concurrency);
      const pageFiles = [];
      let downloaded = 0;
      let failed = 0;
      let pageIndex = 0;

      for (let ci = 0; ci < chapters.length; ci++) {
        if (!(await waitIfPaused(task))) break;
        const chapter = chapters[ci];
        let photo;
        try {
          photo = await client.photoInfo(chapter.id);
        } catch (error) {
          failed++;
          log.warn(`[jm-comic] 章节 ${chapter.id} 信息取不到：${error?.message ?? error}`);
          continue;
        }
        const names = photo.images.slice(0, cfg.maxPages);
        const scrambleId = cfg.descramble ? await client.fetchScrambleId(chapter.id) : 0;
        const rawDir = path.join(workDir, 'raw', `c${String(ci + 1).padStart(2, '0')}`);
        await fsp.mkdir(rawDir, { recursive: true });

        const jobs = names.map((name, idx) => {
          const seq = pageIndex + idx + 1;
          const jpg = path.join(pageDir, `${String(seq).padStart(5, '0')}.jpg`);
          return { name, seq, jpg, raw: path.join(rawDir, imageFileName(name, idx + 1)) };
        });
        pageIndex += names.length;
        task.totalPages = pageIndex;

        await Promise.all(
          jobs.map((job) =>
            concurrency(async () => {
              if (!(await waitIfPaused(task))) return;
              try {
                const buf = await client.fetchImage(chapter.id, job.name);
                await fsp.writeFile(job.raw, buf);
                const num = cfg.descramble ? segmentationNum(scrambleId, album.id, job.name) : 0;
                const out = await toJpeg({
                  file: job.raw,
                  outFile: job.jpg,
                  ff,
                  num,
                  maxDim: cfg.pdfMaxDim,
                  quality: cfg.pdfQuality,
                  timeoutMs: Math.max(30000, cfg.timeoutSec * 2000),
                  log: (m) => log.warn(`[jm-comic] ${m}`),
                });
                if (!out.ok) throw new Error(out.error || '转码失败');
                pageFiles[job.seq - 1] = job.jpg;
                downloaded++;
              } catch (error) {
                failed++;
                log.warn(`[jm-comic] 第 ${job.seq} 页失败：${humanError(error)}`);
              } finally {
                task.done = downloaded + failed;
                task.failed = failed;
                progressOut(task, `JM${album.id} 进度 ${task.done}/${task.totalPages}（失败 ${failed}）`);
                refreshDashboard();
              }
            }),
          ),
        );
      }

      const pages = pageFiles.filter(Boolean);
      if (!pages.length) throw new Error('一张图都没下下来（域名/网络问题？）');
      if (task.canceled) throw new Error('任务已取消');

      task.state = 'packing';
      refreshDashboard();

      const safeTitle = sanitizeSegment(album.name || `JM${album.id}`);
      let outFile = path.join(workDir, `JM${album.id}-${safeTitle}.pdf`);

      if (cfg.outputFormat === 'images') {
        outFile = path.join(workDir, `JM${album.id}-${safeTitle}.txt`);
        await fsp.writeFile(
          outFile,
          `JM${album.id} ${album.name}\n共 ${pages.length} 页\n\n${pages.join('\n')}\n`,
          'utf8',
        );
      } else {
        const made = await writePdf({
          outFile,
          pages: pages.map((file) => ({ file })),
          onProgress: ({ done, total }) => progressOut(task, `JM${album.id} 合成 PDF ${done}/${total}`),
        });
        if (!made.ok) throw new Error(made.error || 'PDF 合成失败');
      }

      let size = (await fsp.stat(outFile)).size;
      const limit = cfg.maxFileMB * 1024 * 1024;

      // 超限就先降画质重压一次（只对 PDF 有意义）
      if (cfg.outputFormat === 'pdf' && size > limit) {
        const lowerQuality = Math.max(45, cfg.pdfQuality - 25);
        const dim = cfg.pdfMaxDim || 1800;
        log.warn(`[jm-comic] PDF ${fmtBytes(size)} 超过 ${cfg.maxFileMB}MB，按画质 ${lowerQuality} 重压`);
        const tmp = outFile.replace(/\.pdf$/, '.small.pdf');
        const retryPages = [];
        for (const p of pages) {
          const small = p.replace(/\.jpg$/, '.small.jpg');
          const r = await toJpeg({
            file: p,
            outFile: small,
            ff,
            num: 0,
            maxDim: dim,
            quality: lowerQuality,
            timeoutMs: 60000,
            log: () => {},
          });
          retryPages.push({ file: r.ok ? small : p });
        }
        const again = await writePdf({ outFile: tmp, pages: retryPages });
        if (again.ok) {
          await fsp.rename(tmp, outFile).catch(() => {});
          size = (await fsp.stat(outFile)).size;
        }
      }

      task.bytes = size;
      task.pages = pages.length;
      stats.downloads += 1;
      stats.pages += pages.length;
      stats.last = `JM${album.id} ${fmtBytes(size)}`;

      // ── 交付 ──
      let delivered = 'none';
      const target = cfg.uploadTarget;
      if (target !== 'none' && size <= 200 * 1024 * 1024) {
        try {
          if (target === 'request' && task.msg?.replyFile) {
            const r = await task.msg.replyFile(outFile, {
              local: true,
              text: `JM${album.id}《${album.name}》 ${pages.length} 页 · ${fmtBytes(size)}`,
            });
            if (r === null) throw new Error('发送失败（可能是文件超限或额度用尽）');
            delivered = 'request';
          } else {
            const scene = target === 'private' || task.kind !== 'group' ? 'c2c' : 'group';
            const chatId = scene === 'group' ? task.groupId || task.chatId : task.userId || task.chatId;
            await ctx.push?.(chatId, `JM${album.id}《${album.name}》已生成：${fmtBytes(size)}（${outFile}）`, {
              kind: scene === 'group' ? 'group' : 'c2c',
            });
            delivered = 'notice';
          }
        } catch (error) {
          log.error(`[jm-comic] 上传失败：${error?.message ?? error}`);
          await ctx.push?.(task.chatId, `PDF 已经生成（${fmtBytes(size)}），但发送失败：${humanError(error)}`, {
            kind: task.kind === 'group' ? 'group' : 'c2c',
          });
        }
      }

      task.state = task.canceled ? 'canceled' : 'done';
      task.finishedAt = Date.now();
      task.file = outFile;
      task.delivered = delivered;
      if (delivered === 'request' || delivered === 'notice') stats.files += 1;
      refreshDashboard();

      await ctx.push?.(
        task.chatId,
        `JM${album.id}《${album.name}》好了：${pages.length} 页 / ${fmtBytes(size)}，耗时 ${fmtTime(Date.now() - task.startedAt)}` +
          (failed ? `，${failed} 页失败` : ''),
        { kind: task.kind === 'group' ? 'group' : 'c2c' },
      );
    }

    /** 起一个任务（同 ID 已在跑就复用）。 */
    function startTask({ albumId, msg, cfg, kind, chatId, userId, groupId, userName }) {
      const id = normalizeAlbumId(albumId);
      if (!id) throw new Error('不认识这个编号');

      const existing = tasks.get(id);
      if (existing && (existing.state === 'running' || existing.state === 'queued' || existing.state === 'paused')) {
        return { task: existing, reused: true };
      }

      const task = {
        albumId: id,
        state: 'queued',
        cfg,
        msg,
        kind,
        chatId,
        groupId,
        userId,
        userName,
        done: 0,
        totalPages: 0,
        failed: 0,
        createdAt: Date.now(),
        canceled: false,
        lastProgressAt: 0,
      };
      tasks.set(id, task);
      refreshDashboard();

      runTask(task).catch(async (error) => {
        task.state = 'failed';
        task.error = humanError(error);
        task.finishedAt = Date.now();
        stats.failed += 1;
        refreshDashboard();
        log.error(`[jm-comic] JM${id} 失败：${task.error}`);
        await ctx.push?.(chatId, `JM${id} 下载失败：${task.error}`, {
          kind: kind === 'group' ? 'group' : 'c2c',
        });
      });

      return { task, reused: false };
    }

    /** 成品缓存：12 小时内已生成过就直接重发。 */
    async function cachedFile(albumId) {
      const dir = dirOf(albumId);
      try {
        const names = await fsp.readdir(dir);
        for (const name of names) {
          if (!/^JM\d+.*\.(pdf|txt)$/i.test(name)) continue;
          const full = path.join(dir, name);
          const st = await fsp.stat(full);
          if (Date.now() - st.mtimeMs < CACHE_FRESH_MS) return { file: full, bytes: st.size };
        }
      } catch {
        /* 目录不存在 = 没缓存 */
      }
      return null;
    }

    async function library() {
      const out = [];
      try {
        const dirs = await fsp.readdir(path.join(root, 'raw'), { withFileTypes: true });
        for (const d of dirs) {
          if (!d.isDirectory()) continue;
          const dir = path.join(root, 'raw', d.name);
          const names = await fsp.readdir(dir).catch(() => []);
          const file = names.find((n) => /^JM\d+.*\.(pdf|txt)$/i.test(n));
          if (!file) continue;
          const st = await fsp.stat(path.join(dir, file)).catch(() => null);
          if (!st) continue;
          out.push({ name: file, bytes: st.size, at: st.mtimeMs });
        }
      } catch {
        /* 空库 */
      }
      return out.sort((a, b) => b.at - a.at);
    }

    async function cleanup(force = false) {
      const cfg = readCfg(ctx);
      if (!force && !cfg.keepDays) return 0;
      const days = force ? 0 : cfg.keepDays;
      const cutoff = Date.now() - days * 86400_000;
      let removed = 0;
      try {
        const dirs = await fsp.readdir(path.join(root, 'raw'), { withFileTypes: true });
        for (const d of dirs) {
          if (!d.isDirectory()) continue;
          const dir = path.join(root, 'raw', d.name);
          const st = await fsp.stat(dir).catch(() => null);
          if (!st) continue;
          if (st.mtimeMs < cutoff) {
            await fsp.rm(dir, { recursive: true, force: true });
            removed++;
          }
        }
      } catch {
        /* 目录不存在 */
      }
      if (removed) log.info(`[jm-comic] 清理了 ${removed} 个过期目录`);
      return removed;
    }

    function taskLine(t) {
      const name = t.title ? `《${t.title}》` : '';
      const stateMap = {
        queued: '排队',
        running: '下载中',
        packing: '合成中',
        paused: '已暂停',
        done: '已完成',
        failed: '失败',
        canceled: '已取消',
      };
      const state = stateMap[t.state] || t.state;
      const prog = t.totalPages ? ` ${t.done}/${t.totalPages}` : '';
      const err = t.state === 'failed' && t.error ? ` — ${t.error}` : '';
      return `JM${t.albumId}${name} ${state}${prog}${err}`;
    }

    // ───────────────────────── 命令 ─────────────────────────

    ctx.command('jm [内容]', { desc: '下载禁漫本子（jm编号 / 链接），或看状态' }, async (msg) => {
      const cfg = readCfg(ctx);
      const arg = String(msg.args?.[0] ?? '').trim();
      const rest = String(msg.content || '').replace(/^\/?jm\s*/i, '').trim();

      if (!cfg.enabled && !['开', '状态'].includes(arg)) {
        await msg.reply('下载功能在面板里被关掉了（插件 → 禁漫下载 → 启用下载）');
        return;
      }
      if (!(await groups.allowed(msg.chatId, msg.kind))) {
        await msg.reply('这个群还没开 JM：让管理员发「/jm 开」');
        return;
      }

      // 无参数 / 状态
      if (!rest || arg === '状态') {
        const list = [...tasks.values()].filter((t) => ['queued', 'running', 'packing', 'paused'].includes(t.state));
        const ff = await findFfmpeg(cfg.ffmpegPath);
        const head = ff.found
          ? `可用：${ff.ffmpeg}`
          : `⚠️ ${ffmpegHint(ff)}`;
        const body = list.length ? list.map((t) => `· ${taskLine(t)}`).join('\n') : '当前没有任务';
        await msg.reply(`禁漫下载\n${head}\n${body}\n\n用法：/jm 123456 · /jm 暂停 <编号> · /jm 列表 · /jm 开|关`);
        return;
      }

      if (/^(列表|本地|书架)$/.test(arg)) {
        const items = await library();
        if (!items.length) {
          await msg.reply('本地还没有成品');
          return;
        }
        const lines = items.slice(0, 20).map((it, i) => `${i + 1}. ${it.name} ${fmtBytes(it.bytes)}`);
        await msg.reply(`本地成品（${items.length} 本）\n${lines.join('\n')}`);
        return;
      }

      if (/^开$/.test(arg)) {
        if (!(await canManage(msg))) {
          await msg.reply('只有机主/群管能开关');
          return;
        }
        if (msg.kind !== 'group') {
          await msg.reply('私聊本来就能用，不用开');
          return;
        }
        await groups.add(msg.chatId);
        await msg.reply('这个群已开启 JM');
        return;
      }

      if (/^关$/.test(arg)) {
        if (!(await canManage(msg))) {
          await msg.reply('只有机主/群管能开关');
          return;
        }
        await groups.remove(msg.chatId);
        const left = await groups.list();
        await msg.reply(left.length ? '这个群已关闭 JM' : '已关闭，且白名单为空 —— 现在所有群都可以用（发 /jm 开 可改成白名单模式）');
        return;
      }

      if (/^(群列表|白名单)$/.test(arg)) {
        const list = await groups.list();
        await msg.reply(list.length ? `已开启的群：\n${list.join('\n')}` : '白名单为空 = 所有群都能用');
        return;
      }

      if (/^(全开|所有群开放)$/.test(arg)) {
        if (!(await canManage(msg))) {
          await msg.reply('只有机主/群管能改');
          return;
        }
        await groups.clear();
        await msg.reply('已恢复：所有群都可以用 JM');
        return;
      }

      if (/^(清|清理)$/.test(arg)) {
        if (!(await canManage(msg))) {
          await msg.reply('只有机主/群管能清理');
          return;
        }
        const removed = await cleanup(true);
        resetFfmpegCache();
        await msg.reply(`已清空本地成品目录（${removed} 个）`);
        return;
      }

      // 暂停 / 继续 / 删除
      const sub = rest.match(/^(暂停|继续|取消|删除)\s*(.+)?$/);
      if (sub) {
        const [, action, targetRaw] = sub;
        const id = normalizeAlbumId(targetRaw || '');
        if (!id) {
          await msg.reply('要给编号，例如 /jm 暂停 422444');
          return;
        }
        const task = tasks.get(id);
        if (!task) {
          await msg.reply(`没有 JM${id} 的任务`);
          return;
        }
        if (action === '暂停') {
          if (task.state === 'running' || task.state === 'queued') {
            task.state = 'paused';
            await msg.reply(`JM${id} 已暂停（发 /jm 继续 ${id} 恢复）`);
          } else {
            await msg.reply(`JM${id} 现在是「${task.state}」，不用暂停`);
          }
          refreshDashboard();
          return;
        }
        if (action === '继续') {
          if (task.state === 'paused') {
            task.state = 'running';
            await msg.reply(`JM${id} 继续`);
          } else {
            await msg.reply(`JM${id} 没在暂停中`);
          }
          refreshDashboard();
          return;
        }
        // 取消 / 删除
        if (!(await canManage(msg))) {
          await msg.reply('只有机主/群管能删除');
          return;
        }
        task.canceled = true;
        task.state = 'canceled';
        tasks.delete(id);
        await fsp.rm(dirOf(id), { recursive: true, force: true }).catch(() => {});
        await msg.reply(`JM${id} 已取消并删除本地文件`);
        refreshDashboard();
        return;
      }

      // 其余都当作要下载的编号/链接
      const albumId = normalizeAlbumId(rest) || parseTrigger(rest);
      if (!albumId) {
        await msg.reply('没认出编号。用法：/jm 123456 或直接发 jm123456');
        return;
      }
      await handleDownload({ msg, cfg, albumId });
    });

    async function handleDownload({ msg, cfg, albumId }) {
      const cached = await cachedFile(albumId);
      if (cached && cfg.uploadTarget !== 'none' && msg.replyFile) {
        const r = await msg
          .replyFile(cached.file, { local: true, text: `JM${albumId} 已在本机（12 小时内），直接发给你` })
          .catch(() => null);
        if (r !== null) {
          stats.files += 1;
          refreshDashboard();
          return;
        }
      }

      const { task, reused } = startTask({
        albumId,
        msg,
        cfg,
        kind: msg.kind,
        chatId: msg.chatId,
        groupId: msg.groupId,
        userId: msg.userId,
        userName: msg.userName,
      });

      if (reused) {
        await reply(msg, `JM${albumId} 已经在处理了（${task.state}），完成后会发出来`);
        return;
      }
      await reply(
        msg,
        `收到 JM${albumId}，开始后台处理` +
          (cfg.descramble ? '（会还原竖切打乱）' : '') +
          (cfg.outputFormat === 'pdf' ? '，完成后发 PDF' : '，只落盘不上传'),
      );
    }

    // ───────────────────────── 关键词 ─────────────────────────

    ctx.on('message', async (msg) => {
      try {
        if (msg.isCommand || msg.isBot) return;
        const cfg = readCfg(ctx);
        if (!cfg.enabled) return;
        if (!(await groups.allowed(msg.chatId, msg.kind))) return;

        const text = String(msg.content || '');
        const addressed = Boolean(msg.addressed || msg.mentioned);
        const albumId = parseTrigger(text, { addressed });
        if (!albumId) return;

        msg.claim?.('jm-comic');
        await handleDownload({ msg, cfg, albumId });
        return true;
      } catch (error) {
        log.warn(`[jm-comic] 关键词处理出错：${error?.message ?? error}`);
        return false;
      }
    });

    ctx.menu('禁漫下载', [
      { text: '/jm 123456', desc: '下载这本（也可直接发 jm123456）' },
      { text: '/jm 状态', desc: '看队列与进度' },
      { text: '/jm 暂停 <编号> · /jm 继续 <编号>', desc: '暂停 / 继续' },
      { text: '/jm 列表', desc: '本地已下好的' },
      { text: '/jm 开 | 关 | 群列表 | 全开', desc: '按群开关（需群管）' },
      { text: '/jm 清', desc: '清空本地成品（需群管）' },
    ]);

    ctx.onTeardown?.(() => {
      if (dashboardTimer) clearTimeout(dashboardTimer);
      for (const t of tasks.values()) t.canceled = true;
    });

    // 启动自检 + 定期清理
    (async () => {
      await ensureRoot();
      const cfg = readCfg(ctx);
      const ff = await findFfmpeg(cfg.ffmpegPath);
      log.info(
        `[jm-comic] 已就绪：${ff.found ? `ffmpeg ${ff.ffmpeg}` : '没找到 ffmpeg（还原/PDF 不可用）'}；` +
          `输出 ${cfg.outputFormat}；并发 ${cfg.concurrency}`,
      );
      await cleanup();
      const timer = setInterval(() => cleanup().catch(() => {}), 6 * 3600_000);
      timer.unref?.();
      ctx.onTeardown?.(() => clearInterval(timer));
      refreshDashboard();
    })().catch((error) => log.warn(`[jm-comic] 启动自检失败：${error?.message ?? error}`));

    return {
      tasks,
      startTask,
      parseTrigger,
      library,
      cleanup,
      groups,
      stats: () => ({ ...stats }),
      dataRoot: root,
    };
  },
};

export const internals = { readCfg, parseTrigger, DEFAULTS, fmtBytes };

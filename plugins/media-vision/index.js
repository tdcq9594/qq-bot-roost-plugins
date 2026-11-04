/**
 * 识图与看视频 v1.0.0
 * ==================
 *
 * 模型只看得见图。可 QQ 里真正每天出现的东西是**视频**和**几兆的截图**：
 *   · 视频 → 下游只看到一句「（发了一段视频）」
 *   · 大图 / bmp / heic → 超过下游的 2MB 上限，直接被跳过，等于没发
 *
 * 这个插件的职责很单纯：**在消息进业务之前，把它换成模型真能看的东西**。
 *   · 视频 → ffmpeg 均匀抽 N 帧静图 → 顶替掉原视频附件
 *   · 过大的图 / 模型不吃的格式 → 缩放重压成 JPEG → 顶替掉原图
 *   · 换掉之后，下游（ai-chat 的 collectImages）照旧按「图片」处理，
 *     它一行代码都不用改，人格/记忆/情绪也全都还在
 *
 * ── 为什么是中间件，而不是又一个「会说话」的插件 ───────────────────────
 * 如果这个插件自己去调模型、自己回话，群里就会出现两个脑子：
 * 一个懂人设会接梗，一个只会报菜名。感知归感知，说话归说话——
 * 所以它只改 `msg`，不 claim、不回话，拦截/放行都交给后面的插件。
 *
 * ── 为什么图片要经由本地 HTTP 暴露 ────────────────────────────────────
 * 下游是拿着 `attachments[].url` 自己 `fetch` 的，所以「本地有文件」
 * 必须变成「有个地址能 GET」。细节和三种备选方案的取舍见 server.js 文件头。
 */

import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';

import { createMediaServer } from './server.js';
import {
  findFfmpeg, ffmpegHint, probeVideo, extractFrames, normalizeImage,
  downloadTo, sniffImage, guessVideoExt, makeTempDir, removeDir, resetFfmpegCache,
} from './media.js';

/** 面板默认值：用户改了配置就用他的，没改就用这里的 */
const DEFAULTS = {
  enabled: true,
  frames: 4,
  deepFrames: 8,
  maxWidth: 768,
  quality: 4,
  imageMaxKB: 1800,
  maxImageMB: 20,
  imageWidth: 1280,
  maxImages: 4,
  maxVideoMB: 40,
  timeoutSec: 30,
  keepMin: 10,
  ffmpegPath: '',
  note: '',
};

/** 下游（ai-chat）能直接吃的格式，别的一律转 JPEG */
const OK_IMAGE_MIME = /^image\/(png|jpe?g|webp|gif)$/i;

/** 一次消息最多处理几个附件（防呆：有人一次甩 20 张） */
const MAX_ITEMS = 8;

/**
 * 读配置 + 兜底。
 *
 * 为什么要兜底：测试夹具不给 config 默认值，真机上老版本配置里也可能
 * 没有新加的键。不兜底的话 `c.frames` 是 undefined，`Number(undefined)` 是 NaN，
 * 最后表现成「抽 0 帧、什么也没发生」——最难查的那种静默失效。
 */
function readCfg(ctx) {
  const raw = ctx?.config ?? {};
  const num = (k, min, max) => {
    const v = Number(raw[k]);
    const n = Number.isFinite(v) ? v : DEFAULTS[k];
    return Math.max(min, Math.min(max, n));
  };
  const bool = (k) => (typeof raw[k] === 'boolean' ? raw[k] : DEFAULTS[k]);
  const str = (k) => (typeof raw[k] === 'string' ? raw[k] : raw[k] == null ? DEFAULTS[k] : String(raw[k]));
  return {
    enabled: bool('enabled'),
    frames: Math.round(num('frames', 1, 12)),
    deepFrames: Math.round(num('deepFrames', 1, 12)),
    maxWidth: Math.round(num('maxWidth', 160, 1600)),
    maxImageMB: Math.round(num('maxImageMB', 1, 60)),
    maxImages: Math.round(num('maxImages', 1, 12)),
    quality: Math.round(num('quality', 2, 31)),
    imageMaxKB: Math.round(num('imageMaxKB', 100, 20000)),
    imageWidth: Math.round(num('imageWidth', 160, 2048)),
    maxVideoMB: Math.round(num('maxVideoMB', 1, 200)),
    timeoutSec: Math.round(num('timeoutSec', 5, 180)),
    keepMin: Math.round(num('keepMin', 1, 240)),
    ffmpegPath: str('ffmpegPath').trim(),
    note: str('note').trim(),
  };
}

/** 附件是不是视频：官方给 `content_type: video/mp4`，有时塞在 file 里 */
export function isVideoAttachment(a) {
  if (!a) return false;
  if (a.type === 'video') return true;
  if (a.type === 'file' && /^video\//i.test(String(a.contentType ?? ''))) return true;
  return false;
}

/** 附件是不是图片 */
export function isImageAttachment(a) {
  return Boolean(a && a.type === 'image' && a.url);
}

/**
 * 这条消息值不值得动手。
 *
 * 只处理「对着机器人说的」：@ 了、在免@窗口里、或者私聊。
 * 群里别人互发的视频不去碰——那是隐私，也是白烧 CPU。
 */
export function shouldHandle(msg, { deep = false } = {}) {
  if (!msg) return false;
  const list = Array.isArray(msg.attachments) ? msg.attachments : [];
  const hasMedia = list.some((a) => isVideoAttachment(a) || isImageAttachment(a));
  if (!hasMedia) return false;
  if (deep) return true;
  return Boolean(msg.addressed || msg.mentioned || msg.kind === 'c2c');
}

/**
 * 处理一条消息里的媒体，返回新的 attachments + 一句给模型看的说明。
 *
 * 纯函数式地返回结果、不直接改 msg —— 这样测试可以拿假消息跑，
 * 也方便出问题时把「原附件 / 新附件 / 说明」一起打进日志。
 *
 * @param {object} o
 * @param {object} o.msg
 * @param {object} o.cfg
 * @param {object} o.server 媒体服务
 * @param {string} o.tmpDir
 * @param {(s:string)=>void} [o.log]
 * @param {boolean} [o.deep]
 * @returns {Promise<{attachments:Array, notes:string[], stats:object}>}
 */
export async function transformMedia({
  msg,
  cfg,
  server,
  tmpDir,
  log = () => {},
  deep = false,
  ffOverride,
}) {
  const list = Array.isArray(msg?.attachments) ? msg.attachments : [];
  const stats = { videos: 0, frames: 0, imagesChecked: 0, imagesFixed: 0, failed: 0 };
  const notes = [];

  // ffOverride 只给测试用：传 null 模拟「本机没有 ffmpeg」
  const ff = ffOverride !== undefined ? ffOverride : await findFfmpeg(cfg.ffmpegPath);

  // 下游（ai-chat）一条消息最多看几张图，超出的会被它自己截掉。
  // 所以帧数要给「已有的图」让位：一张图 + 一条视频 = 3 帧 + 1 张图，
  // 不然用户自己发的那张就白发了。
  const imagesAhead = list.filter((a) => isImageAttachment(a)).length;
  const frameBudget = Math.max(1, cfg.maxImages - imagesAhead);
  const keep = [];
  const out = [];
  let videosSeen = 0;

  for (const a of list.slice(0, MAX_ITEMS)) {
    /* ---------------- 视频：抽帧顶替 ---------------- */
    if (isVideoAttachment(a)) {
      videosSeen += 1;
      stats.videos += 1;
      if (!ff) {
        out.push(a);
        notes.push('（这段视频看不了：本机没有 ffmpeg）');
        continue;
      }
      if (!a.url) {
        out.push(a);
        continue;
      }
      const want = deep ? cfg.deepFrames : Math.min(cfg.frames, frameBudget);
      const src = path.join(tmpDir, `v${videosSeen}${guessVideoExt(a.contentType)}`);
      const startedAt = Date.now();
      try {
        const dl = await downloadTo(a.url, src, {
          maxBytes: cfg.maxVideoMB * 1024 * 1024,
          timeoutMs: cfg.timeoutSec * 1000,
          headers: { referer: 'https://q.qq.com/' },
        });
        const info = await probeVideo(src, ff.ffmpeg, ff.ffprobe, Math.min(cfg.timeoutSec, 20) * 1000);
        const got = await extractFrames({
          file: src,
          outDir: tmpDir,
          ffmpeg: ff.ffmpeg,
          count: want,
          maxWidth: cfg.maxWidth,
          quality: cfg.quality,
          duration: info.duration,
          timeoutMs: Math.max(8000, cfg.timeoutSec * 1000),
        });
        if (!got.files.length) {
          // 一帧都没抽出来（容器坏了 / 编码不认识）：退回原附件，
          // 让下游至少还能说一句「你发了个视频」，而不是彻底静默
          out.push(a);
          notes.push('（这段视频没能抽出画面，可能是格式不认识或文件损坏）');
          stats.failed += 1;
          log(`视频抽帧全失败：${(a.contentType || '')} ${dl.bytes}B`);
          continue;
        }
        let published = 0;
        for (const f of got.files) {
          const url = await server.publish(f);
          if (!url) continue;
          keep.push(f);
          published += 1;
          out.push({
            // 换成图片附件：下游按图片处理，自然就看见了
            type: 'image',
            url,
            filename: `frame-${published}.jpg`,
            contentType: 'image/jpeg',
            size: 0,
            width: 0,
            height: 0,
            wavUrl: '',
            asrText: '',
            raw: { fromVideo: true, at: got.times[published - 1] ?? 0 },
          });
        }
        stats.frames += published;
        const secs = info.duration ? `，约 ${info.duration.toFixed(1)} 秒` : '';
        notes.push(
          published
            ? `（其中的视频${secs}，已经抽成 ${published} 张静帧放在图片里：这些是截帧，帧与帧之间的过程看不到）`
            : '（视频抽帧没能交出去）',
        );
        log(`视频 → ${published} 帧，耗时 ${Date.now() - startedAt}ms，源 ${Math.round(dl.bytes / 1024)}KB`);
      } catch (e) {
        out.push(a);
        stats.failed += 1;
        notes.push('（这段视频没取到：下载失败或太大）');
        log(`视频处理失败：${e?.message ?? e}`);
      } finally {
        try { await fsp.unlink(src); } catch { /* 已经是临时文件 */ }
      }
      continue;
    }

    /* ---------------- 图片：只在「下游会丢」的时候动手 ---------------- */
    if (isImageAttachment(a)) {
      stats.imagesChecked += 1;
      const tooBig = Number(a.size) > cfg.imageMaxKB * 1024;
      const oddType = a.contentType ? !OK_IMAGE_MIME.test(String(a.contentType)) : false;
      // 正常情况下不动它：ai-chat 自己会下载转 base64，我们插手只是多一次转码
      if (!tooBig && !oddType) {
        out.push(a);
        continue;
      }
      if (!ff) {
        out.push(a);
        continue;
      }
      const src = path.join(tmpDir, `i${stats.imagesChecked}`);
      const dst = path.join(tmpDir, `i${stats.imagesChecked}-fix.jpg`);
      try {
        const dl = await downloadTo(a.url, src, {
          maxBytes: cfg.maxImageMB * 1024 * 1024,
          timeoutMs: cfg.timeoutSec * 1000,
        });
        const buf = await fsp.readFile(src);
        if (!sniffImage(buf)) throw new Error('取回来的不是图片（可能是错误页）');
        const fixed = await normalizeImage({
          file: src,
          outFile: dst,
          ffmpeg: ff.ffmpeg,
          maxWidth: cfg.imageWidth,
          quality: 3,
          timeoutMs: Math.max(8000, cfg.timeoutSec * 1000),
        });
        if (!fixed.ok) throw new Error(fixed.error || '转码失败');
        const url = await server.publish(dst);
        if (!url) throw new Error('图片服务没起来');
        keep.push(dst);
        stats.imagesFixed += 1;
        out.push({ ...a, url, contentType: 'image/jpeg', size: fixedSize(await statSize(dst)) });
        log(`图片已重整：${Math.round(dl.bytes / 1024)}KB → ${Math.round((await statSize(dst)) / 1024)}KB`);
      } catch (e) {
        out.push(a);
        log(`图片重整失败，保留原图：${e?.message ?? e}`);
      } finally {
        try { await fsp.unlink(src); } catch { /* ignore */ }
      }
      continue;
    }

    out.push(a);
  }

  if (cfg.note) notes.push(`（${cfg.note}）`);
  return { attachments: out, notes, stats, keep };
}

/** 取文件大小；拿不到就是 0（面板显示用，不值得为它抛错） */
async function statSize(file) {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return 0;
  }
}

function fixedSize(n) {
  return Number.isFinite(n) ? n : 0;
}

/**
 * 插件主体。
 */
export default {
  id: 'media-vision',
  name: '识图与看视频',
  version: '1.0.1',
  shortDesc: '把视频抽成帧、把过大的图压小，让 AI 真的看见图和视频',
  description: '视频抽帧、大图压小，让会回话的 AI 真能看清消息里的图和视频',
  icon: '👁️',
  frameworkVersion: '>=0.6.13',
  /** 排在 ai-chat（-100）之前没关系——中间件是先于所有监听器跑的，这里只影响同优先级的顺序 */
  priority: 30,

  config: {
    enabled: { type: 'boolean', default: true, label: '启用', desc: '关掉之后完全不动消息，视频回到「（发了一段视频）」' },
    frames: { type: 'number', default: 4, min: 1, max: 12, label: '视频抽帧数', desc: '越多越能还原过程，token 也越贵。普通看 4 帧够用' },
    deepFrames: { type: 'number', default: 8, min: 1, max: 12, label: '深看抽帧数', desc: '用 /识图 深看 之后那一条消息用这个数量' },
    maxWidth: { type: 'number', default: 768, min: 160, max: 1600, label: '帧宽上限', desc: '默认 768。太小看不清细节，太大费 token' },
    quality: { type: 'number', default: 4, min: 2, max: 31, label: '帧画质(2-31)', desc: '数字越小越清晰、文件越大。默认 4' },
    imageMaxKB: { type: 'number', default: 1800, min: 100, max: 20000, label: '图片超过多大就压', desc: '超过这个大小才重整。下游上限是 2MB，留点余量' },
    maxImageMB: { type: 'number', default: 20, min: 1, max: 60, label: '图片大小上限(MB)', desc: '超过这个大小直接放弃（连下都不下）' },
    imageWidth: { type: 'number', default: 1280, min: 160, max: 2048, label: '压图宽度', desc: '重整后的宽度上限' },
    maxImages: { type: 'number', default: 4, min: 1, max: 12, label: '一条消息最多几张图', desc: '和 ai-chat 的「最多看图」保持一致。消息里已有图时，视频帧会让位' },
    maxVideoMB: { type: 'number', default: 40, min: 1, max: 200, label: '视频大小上限(MB)', desc: '超过就直接放弃，别把磁盘和带宽吃光' },
    timeoutSec: { type: 'number', default: 30, min: 5, max: 180, label: '单个媒体超时(秒)', desc: '下载和抽帧各自的上限' },
    keepMin: { type: 'number', default: 10, min: 1, max: 240, label: '临时图保留(分钟)', desc: '抽出来的帧只在下游取走前有效，过期自动删' },
    ffmpegPath: { type: 'string', default: '', label: 'ffmpeg 路径', desc: '一般不用填，留空会自动找：PATH 里的 ffmpeg、%FFMPEG_PATH%、C:/D:/E:/ffmpeg/bin、Chocolatey、Scoop、WinGet 装的，以及 macOS/Linux 的 /usr/bin 等。都找不到就填 ffmpeg.exe 所在的文件夹（如 D:/tools/ffmpeg/bin），填到 exe 也行。Windows 最简单：搜 gyan.dev 下 full 版解压，把 bin 文件夹路径粘到这里，不用安装、不用改环境变量' },
    note: { type: 'string', default: '', label: '附加提示', desc: '填了会跟在图片说明后面一起交给模型，比如「这是监控截图」' },
  },

  setup(ctx) {
    const log = (m) => ctx.logger.info(`[media-vision] ${m}`);
    const warn = (m) => ctx.logger.warn(`[media-vision] ${m}`);

    /** 统计，给面板和 /识图 状态用 */
    const stats = {
      videos: 0,
      frames: 0,
      imagesFixed: 0,
      failed: 0,
      lastAt: 0,
      lastMs: 0,
      lastText: '',
    };

    const tmpRoot = path.join(ctx.dataDir || path.join(os.tmpdir(), 'roost-media-vision'), 'tmp');

    // 图片服务跟着插件生命周期：懒启动，teardown 关掉
    const server = createMediaServer({
      ttlMs: Math.max(60_000, readCfg(ctx).keepMin * 60_000),
      log: warn,
    });

    /** 深看窗口：/识图 深看 之后 2 分钟内的一条媒体消息用深看配置 */
    let deepUntil = 0;

    /**
     * 定期扫临时目录。
     *
     * 抽出来的帧要被下游 `fetch` 一次，所以处理完不能立刻删；但也不能永远留着
     * ——一次 8 帧、群里一天几十条视频，几百兆是很快的。按目录 mtime 淘汰，
     * 保留时间就是配置里的「临时图保留(分钟)」。
     */
    let sweepTimer = null;
    async function sweepTmp() {
      let names = [];
      try {
        names = await fsp.readdir(tmpRoot);
      } catch {
        return;
      }
      const cutoff = Date.now() - readCfg(ctx).keepMin * 60_000;
      for (const name of names) {
        const dir = path.join(tmpRoot, name);
        try {
          const st = await fsp.stat(dir);
          if (st.isDirectory() && st.mtimeMs < cutoff) await removeDir(dir);
        } catch { /* 正好被删了 */ }
      }
    }
    sweepTmp().catch(() => {});
    sweepTimer = setInterval(() => { sweepTmp().catch(() => {}); }, 5 * 60_000);
    sweepTimer.unref?.();

    let dashboardTimer = null;
    function pushDashboard() {
      if (typeof ctx.setDashboard !== 'function') return;
      if (dashboardTimer) return;
      dashboardTimer = setTimeout(() => {
        dashboardTimer = null;
        const c = readCfg(ctx);
        const s = server.stats();
        const rate = stats.videos + stats.imagesFixed;
        ctx.setDashboard({
          metrics: [
            { label: '看过视频', value: stats.videos, unit: '段' },
            { label: '抽出的帧', value: stats.frames, unit: '张' },
            { label: '重整的图', value: stats.imagesFixed, unit: '张' },
            { label: '失败', value: stats.failed, unit: '次' },
            { label: '抽帧数', value: `${c.frames}/${c.deepFrames}`, unit: '帧' },
            { label: '图片服务', value: s.ready ? `:${s.port}` : '未启动', unit: '' },
            {
              label: '最近一次',
              value: stats.lastAt ? `${new Date(stats.lastAt).toLocaleTimeString('zh-CN')} · ${stats.lastMs}ms` : '还没有',
              unit: '',
            },
          ],
          note: rate
            ? `上次处理：${stats.lastText || '—'}；临时图保留 ${c.keepMin} 分钟，ffmpeg ${c.ffmpegPath || '自动探测'}`
            : '等第一条带图/视频的消息。视频会抽成静帧后再交给模型，模型看到的是「某些瞬间」而不是连续画面。',
        });
      }, 2000);
      dashboardTimer.unref?.();
    }
    pushDashboard();

    /* ---------------- 核心：中间件 ---------------- */

    ctx.use('media', async (scope, next) => {
      const msg = scope?.msg;
      try {
        const c = readCfg(ctx);
        const deep = Date.now() < deepUntil;
        // 指令不碰：`/pid`、`/来张图` 这类命令的返回值跟附件无关，
        // 动了只会多一次下载/转码。机器人自己说的话也跳过。
        if (msg?.isCommand || msg?.isBot) {
          await next();
          return;
        }
        if (!c.enabled || !shouldHandle(msg, { deep })) {
          await next();
          return;
        }
        const startedAt = Date.now();
        const tmpDir = await makeTempDir(tmpRoot);
        try {
          const r = await transformMedia({ msg, cfg: c, server, tmpDir, log: warn, deep });
          if (r.stats.videos || r.stats.imagesFixed) {
            // 换掉附件：视频变成静帧、大图变成小图
            msg.attachments = r.attachments;
            if (r.notes.length) {
              /**
               * 说明补进正文。
               *
               * 不补的话模型只看到「用户发了几张图」，会以为图是用户自己贴的；
               * 补了它才知道「这是那段视频里的截帧」，措辞自然会变成
               * 「某一帧里」而不是断言连续过程。这是 QQ Agent 那版的经验。
               */
              const note = r.notes.join('');
              msg.content = `${String(msg.content || '')}${msg.content ? '\n' : ''}${note}`;
            }
            stats.videos += r.stats.videos;
            stats.frames += r.stats.frames;
            stats.imagesFixed += r.stats.imagesFixed;
            stats.failed += r.stats.failed;
            stats.lastAt = Date.now();
            stats.lastMs = stats.lastAt - startedAt;
            stats.lastText = [
              r.stats.videos ? `${r.stats.videos} 段视频` : '',
              r.stats.frames ? `${r.stats.frames} 帧` : '',
              r.stats.imagesFixed ? `${r.stats.imagesFixed} 张图重整` : '',
            ].filter(Boolean).join(' / ') || '无变化';
            if (deep) deepUntil = 0;
            pushDashboard();
          }
        } finally {
          // 帧已经交给图片服务（它读的是同一个文件），所以不能马上删；
          // 这里只清掉源视频/源图这类中间文件，帧文件由 TTL 兜底
          await removeDirUnlessKept(tmpDir);
        }
      } catch (e) {
        // 中间件抛错会被框架记成「插件崩了」并继续，但那样我们失去控制；
        // 自己吞掉、记一条日志、正常放行，是更稳的选择
        warn(`处理媒体出错，原样放行：${e?.stack || e?.message || e}`);
      }
      await next();
    });

    /**
     * 清临时目录里除「还要给下游读的帧」之外的东西。
     *
     * 简单做法是整个目录留给 TTL，但视频源文件几十兆，留着没意义；
     * 所以这里只删「不是 .jpg」的文件（源视频/源图都是无扩展或原名）。
     */
    async function removeDirUnlessKept(dir) {
      try {
        const list = await fsp.readdir(dir);
        for (const name of list) {
          if (/\.jpg$/i.test(name)) continue;
          await fsp.rm(path.join(dir, name), { force: true, recursive: true });
        }
      } catch { /* 目录没了 */ }
    }

    /* ---------------- 命令 ---------------- */

    ctx.command('识图', { desc: '识图与看视频：状态 / 深看 / 开关', usage: '/识图 [深看|帧数 N|开|关|清]' }, async (msg) => {
      const c = readCfg(ctx);
      const sub = String(msg.args?.[0] ?? '').trim();
      const arg = String(msg.args?.[1] ?? '').trim();

      if (!sub) {
        const ff = await findFfmpeg(c.ffmpegPath);
        const s = server.stats();
        const lines = [
          `👁️ 识图与看视频`,
          `状态：${c.enabled ? '开' : '关'}；视频抽 ${c.frames} 帧（深看 ${c.deepFrames} 帧），帧宽 ${c.maxWidth}`,
          `图片：超过 ${c.imageMaxKB}KB 才压缩到 ${c.imageWidth} 宽`,
          `视频上限：${c.maxVideoMB}MB，单个超时 ${c.timeoutSec}s`,
          `ffmpeg：${ffmpegHint(ff)}`,
          `图片服务：${s.ready ? `127.0.0.1:${s.port}，在册 ${s.files} 个文件` : '未启动（第一次用图时才起）'}`,
          `累计：视频 ${stats.videos} 段 / 抽出 ${stats.frames} 帧 / 重整图 ${stats.imagesFixed} 张 / 失败 ${stats.failed} 次`,
          `用法：/识图 深看 —— 下一条带图/视频的消息多抽几帧、并要求逐帧描述`,
        ];
        await msg.reply(lines.join('\n'));
        return;
      }

      if (sub === '深看') {
        deepUntil = Date.now() + 120_000;
        await msg.reply(`好，下一条带图或视频的消息我仔细看（${c.deepFrames} 帧，两分钟内有效）`);
        return;
      }

      // 下面都是写操作
      const allowed = ctx.isOwner?.(msg.userId) || (await ctx.can(msg, 'admin'));
      if (!allowed) {
        await msg.reply('这个要管理员才能改。');
        return;
      }

      if (sub === '开' || sub === '关') {
        await ctx.setConfig({ enabled: sub === '开' });
        await msg.reply(`识图已${sub}。`);
        return;
      }
      if (sub === '帧数') {
        const n = Math.round(Number(arg));
        if (!Number.isFinite(n) || n < 1 || n > 12) {
          await msg.reply('帧数给个 1~12 的整数，例如 /识图 帧数 6');
          return;
        }
        await ctx.setConfig({ frames: n });
        await msg.reply(`好，以后视频抽 ${n} 帧。`);
        return;
      }
      if (sub === '清') {
        server.clear();
        resetFfmpegCache();
        await removeDir(tmpRoot);
        await msg.reply('临时图片和抽帧缓存都清掉了，ffmpeg 会重新探测一次。');
        return;
      }
      await msg.reply('认识的子命令：深看 / 帧数 N / 开 / 关 / 清');
    });

    ctx.menu('识图与看视频', [
      { cmd: '/识图', desc: '看状态（ffmpeg、抽帧数、累计）' },
      { cmd: '/识图 深看', desc: '下一条图/视频仔细看（多抽几帧）' },
      { cmd: '/识图 帧数 6', desc: '改默认抽帧数（管理员）' },
      { cmd: '/识图 开', desc: '开/关（管理员）' },
      { text: '带视频 @我 说「看看这个」', desc: '自动抽帧后交给 AI 描述' },
    ]);

    /* ---------------- 收尾 ---------------- */
    ctx.onTeardown?.(() => {
      server.close();
      if (dashboardTimer) clearTimeout(dashboardTimer);
      if (sweepTimer) clearInterval(sweepTimer);
      log('已卸载：图片服务已关闭');
    });

    // 启动时就探一次 ffmpeg：早一点把「没装」写进日志，比用户第一次发视频才发现强
    findFfmpeg(readCfg(ctx).ffmpegPath).then((ff) => {
      if (ff) log(`已就绪：${ffmpegHint(ff)}；默认抽 ${readCfg(ctx).frames} 帧`);
      else warn(`没找到 ffmpeg，视频将无法抽帧。${ffmpegHint(null)}`);
    }).catch(() => {});
  },

  /** 测试用：把容易出错的纯函数暴露出来 */
  internals: { readCfg, isVideoAttachment, isImageAttachment, shouldHandle, transformMedia, DEFAULTS },
};

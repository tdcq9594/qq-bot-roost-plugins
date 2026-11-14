/**
 * 抽一帧存成本地图片（0.3）
 * ==========================
 *
 * 和「卡片」同一条边界：扩展**不自己发图**，只把抽到的帧存好、把**绝对路径**
 * 交给模型，由它在回复里写 `<<image-alone: 路径>>`（宿主出站动作层负责上传）。
 *
 * 文件刻意不放在扩展目录里：市场索引的 sha256 是整个插件目录算的，
 * 运行时多一张 jpg 就会让 `build-index --check` 变脏。默认写系统临时目录下的
 * `dsh-bili-shots/`，要固定位置就在面板填「截图目录」。
 *
 * ffmpeg 直接读 B 站 CDN 流并 seek 抽帧，不下载整片；没 ffmpeg / 拿不到流 /
 * 超时都只返回一句能照着改的原因，不影响这轮说话。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { BiliError, UA, clockOf } from './api.mjs';

/** CDN 地址只认 https 的公网域名：别让接口返回的地址把 ffmpeg 带到内网去。 */
export function safeStreamUrl(u) {
  const s = String(u ?? '').trim();
  if (!/^https:\/\//i.test(s)) return '';
  try {
    const h = new URL(s).hostname.toLowerCase();
    if (!h || h === 'localhost'
      || /^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(h)) return '';
    if (h.endsWith('.local') || h.endsWith('.internal')) return '';
    return s;
  } catch {
    return '';
  }
}

/** 优先 H.264、短边尽量够看、带宽最低的那路；没有 DASH 就退回 durl。 */
export function pickStream(pu) {
  const list = (pu?.video || []).filter((v) => safeStreamUrl(v?.baseUrl));
  if (list.length) {
    const avc = list.filter((v) => /^avc/i.test(String(v.codecs || '')));
    const pool = avc.length ? avc : list;
    const decent = pool.filter((v) => Math.min(Number(v.width) || 0, Number(v.height) || 0) >= 360);
    return (decent.length ? decent : pool)
      .slice().sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0))[0].baseUrl;
  }
  return (pu?.durl || []).map((d) => safeStreamUrl(d.url)).find(Boolean) || '';
}

/**
 * 找 ffmpeg：面板填了路径就先用它（真的存在才算），否则靠 PATH。
 * `probeImpl` 是给测试用的，别在 CI 里真起外部进程。
 */
export function findFfmpeg(configured = '', { probeImpl = null } = {}) {
  const c = String(configured ?? '').trim();
  if (c && existsSync(c)) return c;
  if (c) return '';
  const probe = probeImpl || ((cmd) => {
    try { return spawnSync(cmd, ['-version'], { windowsHide: true, timeout: 3000 }).status === 0; }
    catch { return false; }
  });
  return probe(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') ? 'ffmpeg' : '';
}

/** 从流里抽一帧 JPEG。失败返回 null（不抛），调用方负责说人话。 */
export function grabFrame(ffmpeg, url, at, {
  width = 512, timeoutMs = 15_000, maxBytes = 2 * 1024 * 1024, spawnImpl = spawn,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    let proc;
    try {
      proc = spawnImpl(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        /** B 站 CDN 要 Referer，否则 403 */
        '-headers', `Referer: https://www.bilibili.com/\r\nUser-Agent: ${UA}\r\n`,
        '-rw_timeout', String(timeoutMs * 1000),
        '-protocol_whitelist', 'http,https,tcp,tls,crypto',
        '-ss', String(Math.max(0, Math.round(Number(at) || 0))), '-i', url,
        '-frames:v', '1', '-an', '-vf', `scale=${width}:-2`,
        '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1',
      ], { windowsHide: true });
    } catch {
      return finish(null);
    }
    const out = [];
    let bytes = 0;
    const stop = () => { try { proc.kill(); } catch { /* 已经退了 */ } finish(null); };
    timer = setTimeout(stop, timeoutMs);
    proc.stdout?.on('data', (d) => {
      if (settled) return;
      bytes += d.length;
      if (bytes > maxBytes) return stop();
      out.push(d);
    });
    /** 必须挂上，否则 ffmpeg 的 stderr 写满了会把管道堵死 */
    proc.stderr?.on('data', () => {});
    proc.on?.('error', () => { clearTimeout(timer); finish(null); });
    proc.on?.('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      finish(code === 0 && buf.length > 500 && buf[0] === 0xff && buf[1] === 0xd8 ? buf : null);
    });
    if (!proc.on) finish(null);
  });
}

export function createShots({
  dir = '', keep = 12, width = 512, ffmpegPath = '',
  api, log = () => {}, spawnImpl = spawn, probeImpl = null,
} = {}) {
  const root = String(dir || '').trim() || join(os.tmpdir(), 'dsh-bili-shots');
  const max = Math.max(1, Math.min(50, Math.round(Number(keep) || 12)));

  /**
   * `ffmpegPath` 可以是字符串，也可以是**函数**。
   *
   * 必须是函数的原因：ffmpeg 现在装在宿主的共享目录，用户在面板点「装 ffmpeg」
   * 之后，扩展进程并不会重启。创建时算死的话，装好了也永远读空值，
   * 表现就是「明明装了，抽帧还报没 ffmpeg」——只能靠重启扩展才好，
   * 而用户根本不知道要重启。
   */
  const ffmpegOf = typeof ffmpegPath === 'function' ? ffmpegPath : () => ffmpegPath;

  /** 只删自己命名规则的 jpg，别把用户放在同目录的其它文件清掉。 */
  function prune() {
    try {
      const files = readdirSync(root)
        .filter((f) => /^BV[0-9A-Za-z]{10}-\d+\.jpg$/.test(f))
        .map((f) => ({ f, at: statSync(join(root, f)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
      for (const { f } of files.slice(max)) {
        try { unlinkSync(join(root, f)); } catch { /* 被别的进程删了就算了 */ }
      }
    } catch (e) {
      log(`清理旧截图失败（不影响这次）：${e?.message ?? e}`);
    }
  }

  return {
    dir: root,
    ffmpegStatus() {
      const ffmpeg = findFfmpeg(ffmpegOf(), { probeImpl });
      return { ready: Boolean(ffmpeg), ffmpeg, dir: root };
    },

    /** @returns {{path:string, text:string}} 绝对路径 + 模型可直接抄的标记 */
    async take({ info, at = 0 }) {
      const bvid = String(info?.bvid ?? '');
      if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw new BiliError('没有 BV 号，没法抽帧');
      const cid = Number(info?.cid) || 0;
      if (!cid) throw new BiliError('这个视频没有 cid，没法抽帧', { hint: '番剧要用具体某一集。' });

      const sec = Math.max(0, Math.min(Math.round(Number(at) || 0), Math.max(0, Math.floor(Number(info?.duration) || 0) - 1)));
      const ffmpeg = findFfmpeg(ffmpegOf(), { probeImpl });
      if (!ffmpeg) {
        throw new BiliError('没找到 ffmpeg，抽不了帧', {
          hint: '面板「表达 → 刷 B 站」顶部有「装 ffmpeg」按钮，点一下装到框架共享目录，所有扩展一起用。',
        });
      }

      const pu = await api.playurl({ bvid, cid });
      const url = pickStream(pu);
      if (!url) throw new BiliError('拿不到这个视频的播放流', {
        hint: '没登录 / 会员限定 / 风控都可能；换个视频或填好 Cookie 再试。',
      });

      const buf = await grabFrame(ffmpeg, url, sec, { width, spawnImpl });
      if (!buf) throw new BiliError('抽帧没成功', {
        hint: 'CDN 不支持 seek、超时或 ffmpeg 版本太旧都可能导致；换个时间点再试。',
      });

      try {
        mkdirSync(root, { recursive: true });
        const path = join(root, `${bvid}-${sec}.jpg`);
        writeFileSync(path, buf);
        prune();
        const text = [
          `抽到了《${info.title || bvid}》${clockOf(sec)} 的那一帧，存在：`,
          path,
          '',
          '想把这张图发给对方，就在回复里**原样写**下面这行（单独发一条图）：',
          `<<image-alone: ${path}>>`,
          '',
          '（也可以写 `<<image: 路径>>` 让图和这句话排在同一条；不发就不写。）',
        ].join('\n');
        return { path, text };
      } catch (e) {
        throw new BiliError(`截图存不下来：${e?.message ?? e}`, {
          hint: '面板里换一个可写的「截图目录」。',
        });
      }
    },
  };
}

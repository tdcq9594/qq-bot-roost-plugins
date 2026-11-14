/**
 * B 站扫码登录（官方接口 + 本地生成二维码）
 * ============================================================
 *
 * 走 B 站 passport 官方的二维码接口，**不起浏览器**：
 *
 *   GET  /x/passport-login/web/qrcode/generate   拿 `{ url, qrcode_key }`
 *   GET  /x/passport-login/web/qrcode/poll?qrcode_key=…   查扫码进度
 *
 * 早先的做法是起一个 headless Chrome 打开登录页、用 CDP 截整页图——
 * 那张图里二维码只占一小块，缩到面板宽度后每个模块不到 1 像素，
 * 手机扫不动。改用官方接口后，本地按 URL 直接画出干净的二维码，
 * 尺寸和纠错级别都由我们说了算。
 *
 * 二维码用 `lib/qr-encode.mjs` 的 `createQr()`：**装了共享依赖里的
 * `qrcode` 就用它**（成熟库，版本 1–40 都覆盖），没装就退回内置编码器。
 * 两条路都出 PNG，写 `ui/qr.png`，页面用 `/ext-pages` 取。
 *
 * 为什么不把图片塞进 `ui-data.json` 的 meta：那个字段对值长度有上限，
 * 一张 PNG 的 base64 塞不进去；而 `ui/qr.png` 本来就在构建脚本的
 * 跳过名单里，不会污染索引哈希。
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createQr, qrToPng } from './qr-encode.mjs';

const GEN_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';

/** 带上 referer：这两个接口不校验登录态，但会看来源 */
const HEADERS = {
  referer: 'https://www.bilibili.com/',
  origin: 'https://www.bilibili.com',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

/** 二维码有效期（B 站给 180 秒），到点直接判过期，省得白轮询 */
const TTL_MS = 180_000;

/**
 * 从 `Set-Cookie` 里挑出登录需要的那几个。
 *
 * 只取 `SESSDATA` / `bili_jct` / `DedeUserID`：其它（buvid、分享用的）
 * 要么和登录无关，要么每次会话都在变，写进文件只会让「粘贴的 Cookie
 * 和扫码产生的」越来越不一致。
 */
function pickCookies(setCookies) {
  const want = new Set(['SESSDATA', 'bili_jct', 'DedeUserID']);
  const out = [];
  for (const line of setCookies) {
    const first = String(line).split(';')[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (want.has(name) && value) out.push(`${name}=${value}`);
  }
  return out.join('; ');
}

/**
 * @param {{root: string, log?: Function, depsDir?: string, fetchImpl?: Function}} o
 *   `root` 是扩展目录（二维码写 `root/ui/qr.png`）；`depsDir` 是宿主的
 *   共享依赖目录（有 `qrcode` 就用它，没有就用内置编码器）
 */
export function createQrLogin({ root, log = () => {}, depsDir = '', fetchImpl = fetch } = {}) {
  /** 一次只维持一个会话：面板上就一个二维码 */
  let session = null;

  const qrFile = () => join(root, 'ui', 'qr.png');

  function clearQrFile() {
    try {
      unlinkSync(qrFile());
    } catch { /* 没有就算了 */ }
  }

  async function start() {
    clearQrFile();
    let j;
    try {
      const r = await fetchImpl(GEN_URL, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
      j = await r.json();
    } catch (e) {
      return { ok: false, state: 'error', message: `连不上 B 站：${e?.message ?? e}` };
    }
    if (j?.code !== 0 || !j?.data?.url) {
      return { ok: false, state: 'error', message: `接口返回异常（code=${j?.code ?? '?'}）` };
    }

    let png;
    let source = 'builtin';
    try {
      const qr = createQr(j.data.url, { depsDir, ec: 'L' });
      source = qr.source;
      /** scale 8：41 模块 → 392px，手机上扫得动；再大对屏幕显示没意义 */
      png = qrToPng(qr, { scale: 8, margin: 4 });
    } catch (e) {
      return { ok: false, state: 'error', message: `二维码生成失败：${e?.message ?? e}` };
    }

    try {
      mkdirSync(dirname(qrFile()), { recursive: true });
      writeFileSync(qrFile(), png);
    } catch (e) {
      return { ok: false, state: 'error', message: `二维码写盘失败：${e?.message ?? e}` };
    }

    session = { key: String(j.data.qrcode_key), at: Date.now() };
    log(`扫码会话 ${session.key.slice(0, 8)} 已出码（${source}，${png.length} 字节）`);
    return { ok: true, state: 'waiting', id: session.key.slice(0, 8), at: session.at, source };
  }

  /**
   * 查一次进度。
   *
   * `data.code`：0 成功 / 86101 未扫码 / 86090 已扫码待确认 / 86038 已过期。
   */
  async function poll() {
    if (!session) return { ok: false, state: 'idle', message: '没有进行中的扫码' };

    if (Date.now() - session.at > TTL_MS) {
      session = null;
      clearQrFile();
      return { ok: true, state: 'expired', message: '二维码过期了，重新点一次「扫码登录」' };
    }

    let r;
    let j;
    try {
      r = await fetchImpl(`${POLL_URL}?qrcode_key=${encodeURIComponent(session.key)}`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(10_000),
      });
      j = await r.json();
    } catch (e) {
      /** 网络抖一下不算失败：保持等待，下一次再查 */
      return { ok: true, state: 'waiting', message: `查询失败（${e?.message ?? e}），继续等` };
    }

    const code = Number(j?.data?.code);
    if (code === 0) {
      /**
       * `getSetCookie()` 是 Node 20+ 的；老版本退回整串再按逗号切。
       * 只在这条成功路径上用得到，平时不会走到。
       */
      const raw = typeof r.headers.getSetCookie === 'function'
        ? r.headers.getSetCookie()
        : String(r.headers.get('set-cookie') || '').split(/,(?=[^;]+=)/);
      const cookie = pickCookies(raw);
      if (!cookie) {
        session = null;
        clearQrFile();
        return { ok: false, state: 'error', message: '登录成功了但没拿到 Cookie，重试一次' };
      }
      try {
        writeFileSync(join(root, 'cookie.txt'), `${cookie}\n`, 'utf8');
      } catch (e) {
        session = null;
        return { ok: false, state: 'error', message: `Cookie 写入失败：${e?.message ?? e}` };
      }
      session = null;
      clearQrFile();
      log('扫码登录成功，cookie.txt 已更新');
      return { ok: true, state: 'done', message: '登录成功，cookie 已写入' };
    }

    if (code === 86038) {
      session = null;
      clearQrFile();
      return { ok: true, state: 'expired', message: '二维码已过期，重新点一次「扫码登录」' };
    }
    if (code === 86090) {
      return { ok: true, state: 'scanned', message: '已扫码，在手机上点确认' };
    }
    return { ok: true, state: 'waiting', message: '等手机扫码' };
  }

  function cancel() {
    session = null;
    clearQrFile();
    return { ok: true, state: 'cancelled' };
  }

  return { start, poll, cancel, hasSession: () => Boolean(session), qrFile, exists: () => existsSync(qrFile()) };
}

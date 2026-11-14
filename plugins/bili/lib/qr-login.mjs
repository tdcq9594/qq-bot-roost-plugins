/**
 * B 站扫码登录（headless 浏览器 + CDP）
 * ============================================================
 *
 * 做法照 aurabot 的 `src/bili/qr-login.js`：起一个独立的 headless 浏览器，
 * 打开 passport 登录页，把二维码截下来交给面板；主人扫完确认后，从同一个
 * 调试会话里取 cookie（SESSDATA / bili_jct），写进扩展自己的 `cookie.txt`。
 *
 * 为什么不用 B 站官方的 `qrcode/generate` 接口：那个接口只给一个 URL，
 * 要在面板上显示得自己画二维码（零依赖下要内置一个编码器）；而 headless
 * 浏览器方案不需要任何额外依赖，且拿到的是**真实登录态**（含设备指纹）。
 *
 * 三条硬约束：
 *   1. 只写 `cookie.txt`（0.3 就兼容的文件，`api.mjs` 按 mtime 热读），
 *      不碰宿主 config，也不打印任何 cookie 值。
 *   2. 每个会话一个临时 profile，结束就删；浏览器进程整组杀掉，避免残留。
 *   3. 二维码图存 `ui/qr.png`，构建脚本已把它排除在索引哈希之外。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TTL_MS = 180_000;
const LOGIN_URL = 'https://passport.bilibili.com/login';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/** 找可用的 Chromium 内核浏览器：环境变量 → 常见安装位置 → PATH */
export function findBrowser() {
  const fromEnv = String(process.env.BILI_CHROME_BIN || '').trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = process.platform === 'win32'
    ? [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const p of candidates) if (existsSync(p)) return p;
  return '';
}

/** 极简 CDP 客户端：只用到 send，够截图和取 cookie */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      let m = null;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (!m || !m.id || !this.pending.has(m.id)) return;
      const { resolve, reject } = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message || 'CDP 调用失败'));
      else resolve(m.result);
    });
  }

  static connect(url, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error('连不上浏览器调试端口')), timeoutMs);
      timer.unref?.();
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new Cdp(ws)); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连不上浏览器调试端口')); }, { once: true });
    });
  }

  send(method, params = {}, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.ws.close(); } catch { /* 已关 */ }
    this.pending.clear();
  }
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try { child.kill('SIGKILL'); } catch { /* Windows 上可能已经退出 */ }
}

async function waitForPort(profile, timeoutMs = 15_000) {
  const file = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const line = readFileSync(file, 'utf8').split(/\r?\n/)[0].trim();
      const port = Number(line);
      if (port > 0) return port;
    }
    await sleep(120);
  }
  return 0;
}

async function pageWs(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
      const list = await r.json();
      const page = Array.isArray(list) ? list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) : null;
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  return '';
}

/**
 * 一个扫码会话。`start()` 出码，`poll()` 查状态，`cancel()` 收摊。
 *
 * @param {{ root: string, log?: Function }} opts `root` 是扩展目录，二维码写 `root/ui/qr.png`
 */
export function createQrLogin({ root, log = () => {} } = {}) {
  /** @type {Map<string, {child:any, profile:string, cdp:Cdp|null, at:number}>} */
  const sessions = new Map();

  const cleanup = (s) => {
    try { s.cdp?.close(); } catch { /* 忽略 */ }
    s.cdp = null;
    killTree(s.child);
    s.child = null;
    try { rmSync(s.profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 占用中，系统回收 */ }
  };

  const qrFile = () => join(root, 'ui', 'qr.png');

  async function start() {
    const bin = findBrowser();
    if (!bin) {
      return { ok: false, state: 'error', message: '没找到 Chrome / Edge；装一个，或在设置里填 BILI_CHROME_BIN' };
    }
    /** 一次只留一个会话：连点两次不该起两个浏览器 */
    for (const [, s] of sessions) cleanup(s);
    sessions.clear();

    const id = randomUUID().slice(0, 8);
    const profile = join(tmpdir(), `dsh-bili-qr-${id}`);
    mkdirSync(profile, { recursive: true });
    const child = spawn(bin, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      `--user-data-dir=${profile}`,
      '--window-size=430,760',
      '--remote-debugging-port=0',
      `--user-agent=${UA}`,
      LOGIN_URL,
    ], { stdio: 'ignore', windowsHide: true });

    const s = { child, profile, cdp: null, at: Date.now() };
    sessions.set(id, s);

    const port = await waitForPort(profile);
    if (!port) {
      cleanup(s);
      sessions.delete(id);
      return { ok: false, state: 'error', message: '浏览器没起来（调试端口没开）' };
    }
    const wsUrl = await pageWs(port);
    if (!wsUrl) {
      cleanup(s);
      sessions.delete(id);
      return { ok: false, state: 'error', message: '浏览器起来了但找不到页面' };
    }
    try {
      s.cdp = await Cdp.connect(wsUrl);
      await s.cdp.send('Page.enable');
      /** 等登录页把二维码渲染出来；固定等 3 秒比轮询 DOM 稳 */
      await sleep(3000);
      const shot = await s.cdp.send('Page.captureScreenshot', { format: 'png' });
      const dir = join(root, 'ui');
      mkdirSync(dir, { recursive: true });
      writeFileSync(qrFile(), Buffer.from(shot.data, 'base64'));
      log(`扫码会话 ${id} 已出码`);
      return { ok: true, state: 'waiting', id, at: s.at };
    } catch (e) {
      cleanup(s);
      sessions.delete(id);
      return { ok: false, state: 'error', message: `截图失败：${e?.message ?? e}` };
    }
  }

  /** 查一次登录态；拿到票就写 cookie.txt 并结束会话 */
  async function poll() {
    const alive = [...sessions.entries()].filter(([, s]) => Date.now() - s.at < TTL_MS);
    if (!alive.length) {
      for (const [, s] of sessions) cleanup(s);
      sessions.clear();
      return { ok: true, state: 'expired', message: '二维码过期了，重新生成一个' };
    }
    for (const [id, s] of alive) {
      if (!s.cdp) continue;
      try {
        const r = await s.cdp.send('Network.getCookies', {
          urls: ['https://www.bilibili.com', 'https://passport.bilibili.com'],
        }, 8000);
        const map = new Map((r?.cookies || []).map((c) => [c.name, c.value]));
        const sess = map.get('SESSDATA');
        const csrf = map.get('bili_jct');
        if (!sess || !csrf) continue;
        /** 只写 cookie.txt：扩展按 mtime 热读，不需要重启 */
        const line = `SESSDATA=${sess}; bili_jct=${csrf}\n`;
        writeFileSync(join(root, 'cookie.txt'), line, 'utf8');
        cleanup(s);
        sessions.delete(id);
        try { unlinkSync(qrFile()); } catch { /* 没有就算了 */ }
        log('扫码登录成功，cookie.txt 已更新');
        return { ok: true, state: 'done', message: '登录成功，cookie 已写入' };
      } catch { /* 页面还没登录，下一轮再查 */ }
    }
    return { ok: true, state: 'waiting' };
  }

  function cancel() {
    for (const [, s] of sessions) cleanup(s);
    sessions.clear();
    try { unlinkSync(qrFile()); } catch { /* 没有就算了 */ }
    return { ok: true, state: 'cancelled' };
  }

  return { start, poll, cancel, hasSession: () => sessions.size > 0, qrFile };
}

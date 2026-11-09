/**
 * 天气卡渲染：HTML → PNG
 *
 * 原版靠 Electron 离屏窗口截图；Roost 是纯 Node、没有 Electron，
 * 所以改用**本机已装的 Edge / Chrome 无头模式**（--headless=new）。零依赖，Windows 自带 Edge。
 *
 * 流程（两次启动浏览器）：
 *   1. --dump-dom 先跑一遍，页面里的脚本把内容高度写进 <title>，读回来。
 *      不能用固定窗口：矮卡会底部留一大截空白，高卡会被截断。
 *   2. 按量出的高度 --screenshot。
 *
 * 找不到浏览器 / 渲染失败一律返回 null，调用方回退文字版 —— 渲染是锦上添花，不能让查天气整个失败。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CARD_W } from './card.js';
import { cropBottom } from './png.js';

const CANDIDATES = [
  process.env.WEATHER_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);

/** 找一个能用的浏览器。用户在配置里填了路径就优先用它。 */
export function findBrowser(custom = '') {
  const list = [String(custom || '').trim(), ...CANDIDATES].filter(Boolean);
  for (const p of list) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 下一个 */ }
  }
  return '';
}

/**
 * 杀掉浏览器进程树。
 *
 * Windows 上 `child.kill('SIGKILL')` 只终结外层 msedge.exe/chrome.exe，
 * Chromium 派生出的 GPU / Renderer 子进程会活着并**锁住 profile 目录**，
 * 于是 finally 里的 rmSync 抛 EBUSY（被 catch 吞掉），%TEMP% 下攒一堆
 * `roost-weather-*` 目录和僵尸进程。所以 Windows 走 taskkill /T 连子进程一起收。
 */
function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      // /T = 连同子进程，/F = 强制。不 await：清理不该拖慢主流程
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' })
        .on('error', () => { try { child.kill(); } catch { /* 已退出 */ } });
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* 进程已退出 */ }
}
/**
 * 跑一次浏览器，返回 { code, out }。
 * 超时必须杀掉：无头浏览器卡死会留下一个吃内存的僵尸进程，每次查天气攒一个。
 */
function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out }); } };
    const timer = setTimeout(() => {
      killTree(child); // Windows 必须连子进程一起收，否则 profile 目录被锁、rmSync EBUSY
      finish(-1);
    }, timeoutMs);
    child.stdout.on('data', (c) => { if (out.length < 4 * 1024 * 1024) out += c; });
    child.on('error', () => finish(-2));
    child.on('close', (code) => finish(code ?? 0));
    // 兜底：即便正常退出，也把可能残留的子树收掉（taskkill 对已退出 PID 无副作用）
  });
}

/** 注入脚本：把内容高度写进 <title>，--dump-dom 读回来（仅两次启动的兜底路径用）。 */
const MEASURE = `<script>addEventListener('load',()=>{
  const c=document.querySelector('.card');
  const pad=parseFloat(getComputedStyle(document.body).paddingBottom||0);
  const h=Math.ceil(Math.max(document.body.scrollHeight,document.body.offsetHeight,c?c.getBoundingClientRect().bottom+pad:0));
  document.title='H='+h;
})</script>`;

/**
 * 一次高窗口截图后的窗口高度。
 * 6 个地区 + 逐小时条大约 1600px，4000 足够；真超了会被下面的「内容触底」检查发现并回退。
 */
const TALL = 4000;

/**
 * @param {string} html buildWeatherHtml 的产物
 * @param {{browser?:string, scale?:number, timeoutMs?:number, bg?:string, log?:(m:string)=>void}} opt
 * @returns {Promise<Buffer|null>}
 */
export async function renderHtmlToPng(html, { browser = '', scale = 2, timeoutMs = 25000, bg = '#0e1014', log = () => {} } = {}) {
  const bin = findBrowser(browser);
  if (!bin) { log('没找到 Edge / Chrome，天气卡回退文字版（可在设置里填「浏览器路径」）'); return null; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-weather-'));
  const htmlPath = path.join(dir, 'card.html');
  const pngPath = path.join(dir, 'card.png');
  const profile = path.join(dir, 'profile');
  const base = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--disable-extensions', '--disable-background-networking', '--mute-audio',
    `--user-data-dir=${profile}`,
    /**
     * 设备像素比固定 1，**不能再叠一层放大**。
     * buildWeatherHtml 已经把所有 px 乘过 scale（卡片宽 = 720×scale CSS 像素），
     * 这里若再 --force-device-scale-factor=scale，等于放大两次：
     * 宽度变成 2880、4 倍面积，上传慢、QQ 还会二次压缩把字压糊。
     */
    '--force-device-scale-factor=1',
  ];
  const url = `file:///${htmlPath.replace(/\\/g, '/')}`;
  const shot = async (height) => {
    try { fs.rmSync(pngPath, { force: true }); } catch { /* 没有就算了 */ }
    await run(bin, [...base, `--window-size=${CARD_W * scale},${height}`, `--screenshot=${pngPath}`, url], timeoutMs);
    const png = fs.existsSync(pngPath) ? fs.readFileSync(pngPath) : null;
    return png && png.length > 2000 && png.readUInt32BE(0) === 0x89504e47 ? png : null;
  };

  try {
    fs.writeFileSync(htmlPath, html);

    /**
     * 主路径：**只启动一次浏览器**。给一个很高的窗口，再把底部纯背景裁掉。
     *
     * 之前是两次启动（--dump-dom 量高度 → --screenshot），一张卡 2~4 秒，
     * 而两次冷启动本身就占了大头。裁图的代价只有一次解压 + 重编码，几十毫秒。
     */
    const tall = await shot(TALL);
    if (tall) {
      try {
        const cropped = cropBottom(tall, bg);
        const h = cropped.readUInt32BE(20);
        // 内容顶到了窗口底部 = 窗口不够高、卡片被截断 → 回退到量高度的老路
        if (h < TALL - 4) return cropped;
        log('卡片内容触到窗口底部，改用测量模式重出');
      } catch (e) {
        // 裁剪失败不能直接放弃：整张高图也能发，只是底部有空白。
        // 但空白太多，所以还是走量高度那条路更稳。
        log(`裁剪失败（${e?.message || e}），改用测量模式`);
      }
    }

    /** 兜底：两次启动，先量真实高度再按高度截图。 */
    fs.writeFileSync(htmlPath, html.replace('</body>', `${MEASURE}</body>`));
    const m = await run(bin, [...base, '--virtual-time-budget=2500', '--dump-dom', `--window-size=${CARD_W * scale},400`, url], timeoutMs);
    const hit = /<title>H=(\d+)<\/title>/.exec(m.out);
    const h = Math.max(160, (hit ? Number(hit[1]) : 900) + 2);
    const png = await shot(h);
    if (!png) { log('天气卡截图为空，回退文字版'); return null; }
    return png;
  } catch (e) {
    log(`天气卡渲染失败：${e?.message || e}`);
    return null;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响主流程 */ }
  }
}

/** 读 PNG 的宽高（测试与日志用）。 */
export function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

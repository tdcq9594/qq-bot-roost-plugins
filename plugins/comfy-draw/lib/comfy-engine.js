// ComfyUI 交互层 —— 路径自动发现 / 端口探测 / 自动拉起 / 提交工作流 / 取回出图。
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const PORT_RANGE_START = 8188;
const PORT_RANGE_END = 8199;
const PROBE_TIMEOUT_MS = 1200;
const POLL_INTERVAL_MS = 2000;
/** 拉起失败后的冷却：这段时间内不再尝试，避免「连点几下就拉起一堆半死进程」。 */
const START_COOLDOWN_MS = 30000;

/** 让并发调用共享同一次启动尝试，避免群里刷屏时拉起一堆 ComfyUI 进程。 */
let startPromise = null;
let lastStartFailAt = 0;
let lastStartError = '';

// ── 底层 HTTP ─────────────────────────────────────────────────────────────

export function httpRequest(url, { method = 'GET', body = null, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`非法地址：${url}`));
      return;
    }
    // 协议必须跟着地址走：配置里能填 https（反向代理 / 远程机器），
    // 固定用 http 模块去连 https 端口只会得到一个莫名其妙的 socket hang up。
    const secure = target.protocol === 'https:';
    const lib = secure ? https : http;
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = lib.request(
      {
        hostname: target.hostname,
        port: target.port || (secure ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    // 超时必须显式销毁请求：否则回环上一个半死不活的连接会把这个 Promise 挂死，
    // 表现为调用永远不返回（没有超时、没有报错）。
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时（${timeoutMs}ms）`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getJson(url, timeoutMs = 10000) {
  const res = await httpRequest(url, { timeoutMs });
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}：${res.text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`返回的不是 JSON：${res.text.slice(0, 200)}`);
  }
}

/** 安全读一个 json 文件；读不到/解析不了都返回 fallback，绝不抛。 */
function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// ── 路径自动发现 ──────────────────────────────────────────────────────────

/**
 * 找 Comfy Desktop 生成的模型路径配置。
 * 文件名带实例 id（形如 inst-1234567890.yaml），重建实例后会变，
 * 所以按修改时间取最新的那个，而不是写死文件名。
 */
export function findModelPathsYaml(desktopDir) {
  const base = path.join(desktopDir, 'instance-model-paths');
  try {
    const files = fs.readdirSync(base).filter((f) => f.toLowerCase().endsWith('.yaml'));
    if (!files.length) return '';
    files.sort(
      (a, b) => fs.statSync(path.join(base, b)).mtimeMs - fs.statSync(path.join(base, a)).mtimeMs,
    );
    return path.join(base, files[0]);
  } catch {
    return '';
  }
}

/** 挑一个存在的解释器；全都找不到时给出「预期位置」，让报错能指导用户手填。 */
function pickPython(comfyDir, installPath) {
  const winCandidates = [
    path.join(comfyDir, '.venv', 'Scripts', 'python.exe'),
    path.join(installPath || '', 'standalone-env', 'python.exe'),
    path.join(comfyDir, 'standalone-env', 'python.exe'),
  ];
  const nixCandidates = [
    path.join(comfyDir, '.venv', 'bin', 'python'),
    path.join(installPath || '', 'standalone-env', 'bin', 'python'),
    path.join(comfyDir, 'standalone-env', 'bin', 'python'),
  ];
  const list = process.platform === 'win32' ? winCandidates : nixCandidates;
  for (const p of list) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* 继续试下一个 */
    }
  }
  return list[0] || '';
}

/**
 * 从 Comfy Desktop 自己的配置里推出全部路径（同步，纯读文件）。
 * 只依赖 %APPDATA%\\Comfy Desktop\\ 这个固定位置。
 */
let pathCache = null;
let pathCacheAt = 0;
const PATH_CACHE_TTL_MS = 30000;

export function discoverPaths(desktopDir) {
  // 缓存 30 秒：状态查询会被频繁调用，而这里每次都要读两个 json + 扫一个目录。
  if (pathCache && Date.now() - pathCacheAt < PATH_CACHE_TTL_MS) return pathCache;
  const dir = desktopDir || defaultDesktopDir();
  const found = {
    comfyDir: '',
    pythonExe: '',
    outputDir: '',
    inputDir: '',
    modelPathsYaml: '',
    installPath: '',
    desktopDir: dir,
  };

  // settings.json —— 输入/输出目录在这里，与实例无关
  const settings = readJsonSafe(path.join(dir, 'settings.json'), {});
  if (settings && typeof settings === 'object') {
    if (settings.outputDir) found.outputDir = String(settings.outputDir);
    if (settings.inputDir) found.inputDir = String(settings.inputDir);
  }

  // installations.json —— 实例装在哪
  let installs = readJsonSafe(path.join(dir, 'installations.json'), []);
  if (!Array.isArray(installs)) installs = [];
  // 优先取「状态正常」的实例；没有就退回第一个带 installPath 的
  const inst =
    installs.find((i) => i?.status === 'installed' && i.installPath) ||
    installs.find((i) => i?.installPath);
  if (inst) {
    found.installPath = String(inst.installPath);
    // Desktop 的实际仓库根在 <installPath>\\ComfyUI
    const candidate = path.join(found.installPath, 'ComfyUI');
    found.comfyDir = fs.existsSync(path.join(candidate, 'main.py')) ? candidate : found.installPath;
    found.pythonExe = pickPython(found.comfyDir, found.installPath);
  }

  found.modelPathsYaml = findModelPathsYaml(dir);
  pathCache = found;
  pathCacheAt = Date.now();
  return found;
}

export function defaultDesktopDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || '', 'Comfy Desktop');
  }
  if (process.platform === 'darwin') {
    return path.join(process.env.HOME || '', 'Library', 'Application Support', 'Comfy Desktop');
  }
  return path.join(process.env.HOME || '', '.config', 'Comfy Desktop');
}

/** 让设置改了之后立刻生效，不用等 30 秒缓存过期。 */
export function resetPathCache() {
  pathCache = null;
  pathCacheAt = 0;
}

/**
 * 把用户填的配置和自动发现的结果合起来：**用户填了的以用户为准**，
 * 留空的用发现值。这样「照默认装好就能用」和「特殊环境能手动覆盖」两头都占。
 */
export function resolveConfig(raw) {
  const auto = discoverPaths(raw?.desktopDir);
  const pick = (key) => String(raw?.[key] ?? '').trim() || auto[key] || '';
  return {
    ...(raw || {}),
    comfyDir: pick('comfyDir'),
    pythonExe: pick('pythonExe'),
    outputDir: pick('outputDir'),
    inputDir: pick('inputDir'),
    modelPathsYaml: pick('modelPathsYaml'),
    _auto: auto,
  };
}

// ── 端口探测 ──────────────────────────────────────────────────────────────

/** 探测某个完整地址上是否坐着 ComfyUI。不是 ComfyUI（或压根没开）都返回 null。 */
async function probeBase(base, timeoutMs = PROBE_TIMEOUT_MS) {
  const url = String(base || '').replace(/\/+$/, '');
  if (!url) return null;
  try {
    const data = await getJson(`${url}/system_stats`, timeoutMs);
    const version = data?.system?.comfyui_version;
    if (!version) return null;
    const device =
      Array.isArray(data.devices) && data.devices[0] ? String(data.devices[0].name || '') : '';
    let port = 0;
    try {
      const t = new URL(url);
      port = Number(t.port) || (t.protocol === 'https:' ? 443 : 80);
    } catch {
      /* 端口只用于排序与展示，解析不了就留 0 */
    }
    return { base: url, port, version, device };
  } catch {
    return null;
  }
}

/** 探测本机单个端口（扫端口用）。 */
function probePort(port, timeoutMs = PROBE_TIMEOUT_MS) {
  return probeBase(`http://127.0.0.1:${port}`, timeoutMs);
}

async function scanLocalPorts() {
  const ports = [];
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p += 1) ports.push(p);
  // 并发探测：顺序扫 12 个端口最坏要十几秒，而群里等人出图时这十几秒是白等的
  const results = await Promise.all(ports.map((p) => probePort(p)));
  const alive = results.filter(Boolean);
  if (!alive.length) return null;
  // 有多个实例时选端口最小的（通常是主实例，另一个多半是残留）
  alive.sort((a, b) => a.port - b.port);
  return alive[0];
}

function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0';
}

/**
 * 找到可用的 ComfyUI 实例。
 *   · baseUrl 留空 → 扫本机 8188~8199（Comfy Desktop 换端口也能找到）
 *   · baseUrl 填了 → **直接探测这个地址本身**（含远程主机与 https），
 *     不再「拿远程端口去问 127.0.0.1」——那是把配置项的含义解释错了。
 *   · 填了但没写端口、又是本机 → 仍然扫端口（用户只说「本机」时，端口由我们找）
 */
export async function discover(cfg) {
  const fixed = String(cfg.baseUrl || '').trim();
  if (!fixed) return scanLocalPorts();

  let target;
  try {
    target = new URL(fixed);
  } catch {
    return null;
  }
  if (!target.port && isLoopbackHost(target.hostname)) return scanLocalPorts();
  return probeBase(fixed, 4000);
}

// ── 自动拉起 ──────────────────────────────────────────────────────────────

/**
 * 只透传真正需要的环境变量。
 *
 * 整包继承 process.env 等于把机器人进程的全部环境（各种 token、代理口令、
 * 云厂商密钥……）原样交给一个第三方 Python 程序；而 ComfyUI 实际只需要
 * 系统路径、临时目录、用户目录和几个 CUDA/Python 变量。
 */
const ENV_PASSTHROUGH = [
  'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR',
  'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'USERNAME', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'COMPUTERNAME',
  'HOME', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'CUDA_PATH', 'CUDA_HOME', 'HF_HOME', 'HF_ENDPOINT', 'PYTHONPATH',
];

function childEnv() {
  const out = {};
  for (const key of ENV_PASSTHROUGH) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  // 中文 Windows 上 sys.stdout 默认是 GBK，而 ComfyUI 的插件日志里常有 ✓ ✗ 这类
  // 字符：一打印就 UnicodeEncodeError，整个进程在「启动中」直接死掉，现象就是
  //「自动拉起失败 / 启动了但一直不就绪」。强制子进程用 UTF-8 才能起来。
  out.PYTHONIOENCODING = 'utf-8';
  out.PYTHONUTF8 = '1';
  return out;
}

/** 读 ComfyUI 自己的日志尾部。启动失败时真正的原因基本都在这里。 */
export function tailComfyLog(cfg, lines = 8) {
  const file = path.join(String(cfg.comfyDir || ''), 'user', 'comfyui.log');
  try {
    const text = fs.readFileSync(file, 'utf8');
    const rows = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return rows.slice(-Math.max(1, lines)).join(' / ');
  } catch {
    return '';
  }
}

function startBackend(cfg, log) {
  const comfyDir = String(cfg.comfyDir || '').trim();
  const pythonExe = String(cfg.pythonExe || '').trim();
  const mainPy = path.join(comfyDir, 'main.py');

  if (!fs.existsSync(mainPy)) {
    throw new Error(
      `找不到 ComfyUI 主程序：${mainPy}。` +
        '请确认装的是 Comfy Desktop；若装在特殊位置，到面板手动填「ComfyUI 程序目录」。',
    );
  }
  if (!fs.existsSync(pythonExe)) {
    throw new Error(`找不到 Python 解释器：${pythonExe || '(空)'}。请在面板检查「Python 解释器」。`);
  }

  const port = PORT_RANGE_START;
  // --listen 127.0.0.1：不写这个参数时 ComfyUI 可能监听 0.0.0.0，
  // 自动拉起的服务就暴露到局域网了 —— 本机自用的服务不该有对外入口。
  const args = [mainPy, '--port', String(port), '--listen', '127.0.0.1', '--disable-auto-launch'];
  if (cfg.modelPathsYaml) args.push('--extra-model-paths-config', String(cfg.modelPathsYaml));
  if (cfg.outputDir) args.push('--output-directory', String(cfg.outputDir));
  if (cfg.inputDir) args.push('--input-directory', String(cfg.inputDir));

  log(`启动 ComfyUI：${pythonExe} ${args.join(' ')}`);
  const child = spawn(pythonExe, args, {
    cwd: comfyDir,
    detached: true, // 脱离本进程：机器人重启不该把 ComfyUI 一起带走
    stdio: 'ignore', // 不占管道，ComfyUI 自己会写 user/comfyui.log
    windowsHide: true, // 不弹控制台窗口（它是后台服务，不是给人看的）
    env: childEnv(),
  });
  child.unref();

  // 记住它死了没有：ComfyUI 因为显存不足 / 自定义节点报错秒退时，不监听 exit
  // 就只能干等满 startTimeoutMs（默认 150 秒），然后看到一句「启动了但没就绪」，
  // 真正原因还埋在日志里。
  const state = { exited: false, code: null, signal: null, reason: '', logTail: '' };
  const noteExit = (reason) => {
    state.exited = true;
    state.reason = reason;
    state.logTail = tailComfyLog(cfg);
    log(
      `ComfyUI 进程退出（${reason}）` + (state.logTail ? `，日志尾部：${state.logTail}` : ''),
    );
  };
  child.once('exit', (code, signal) => {
    state.code = code;
    state.signal = signal;
    noteExit(`code=${code ?? 'null'} signal=${signal ?? 'null'}`);
  });
  child.once('error', (error) => {
    state.code = 'spawn-error';
    noteExit(error?.message || String(error));
  });

  return { child, state };
}

async function waitReady(cfg, timeoutMs, log, state) {
  const total = Math.max(10000, Number(timeoutMs) || 150000);
  const deadline = Date.now() + total;
  let waited = 0;
  while (Date.now() < deadline) {
    const found = await discover(cfg);
    if (found) {
      log(`ComfyUI 已就绪（${found.base}，v${found.version}，等待 ${Math.round(waited / 1000)}s）`);
      return found;
    }
    // 进程已经没了就别再空等：把退出码和日志尾部一起报出来，用户才知道是
    // 显存不够还是某个自定义节点崩了。
    if (state?.exited) {
      const tail = state.logTail || tailComfyLog(cfg);
      throw new Error(
        `自动拉起的 ComfyUI 启动后立刻退出了（${state.reason || '原因未知'}）。` +
          (tail
            ? `ComfyUI 日志最后几行：${tail}`
            : '去 ComfyUI 目录下的 user/comfyui.log 看具体报错（多半是显存不够或自定义节点不兼容）。'),
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    waited += POLL_INTERVAL_MS;
  }
  throw new Error(
    `启动了 ComfyUI 但 ${Math.round(total / 1000)} 秒内没就绪。` +
      '首次启动要加载运行库，慢一些正常；若反复如此，请手动打开 Comfy Desktop 看它报什么错。',
  );
}

/**
 * 保证有可用的 ComfyUI：先找现成的（可能用户自己开着 Desktop），找不到再拉起。
 * 返回 { base, port, version, started }。
 */
export async function ensureService(cfg, log = () => {}) {
  const existing = await discover(cfg);
  if (existing) return { ...existing, started: false };

  if (cfg.autoStart === false) {
    throw new Error('ComfyUI 没有运行。请打开 Comfy Desktop，或把「自动拉起 ComfyUI」打开。');
  }

  // 冷却：上次拉起失败后 30 秒内不再重试。
  // 否则群里几个人连着发关键词，每次 discover 都「没在跑」→ 每次都拉起一个新进程，
  // 上一批半死的进程还占着显存和端口，现场只会越来越乱。
  const sinceFail = Date.now() - lastStartFailAt;
  if (lastStartError && sinceFail < START_COOLDOWN_MS) {
    throw new Error(
      `刚才自动拉起 ComfyUI 失败了，${Math.ceil((START_COOLDOWN_MS - sinceFail) / 1000)} 秒后才会再试：${lastStartError}`,
    );
  }

  if (!startPromise) {
    startPromise = (async () => {
      const { state } = startBackend(cfg, log);
      return waitReady(cfg, cfg.startTimeoutMs, log, state);
    })();
    // 完成后清空，让下一次「发现没在跑」时能重新尝试启动
    startPromise.catch(() => {}).finally(() => {
      startPromise = null;
    });
  }
  try {
    const found = await startPromise;
    lastStartError = '';
    return { ...found, started: true };
  } catch (error) {
    lastStartFailAt = Date.now();
    lastStartError = String(error?.message || error).slice(0, 300);
    throw error;
  }
}

// ── 模型清单与架构探测 ────────────────────────────────────────────────────

async function listOptions(base, nodeType, field) {
  try {
    const info = await getJson(`${base}/object_info/${nodeType}`, 15000);
    const list = info?.[nodeType]?.input?.required?.[field]?.[0];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** 一次问齐四类清单：给「/绘图 模型」命令用，也让报错能列出可选模型。 */
export async function listModelsAll(base) {
  const [checkpoints, unet, clip, vae] = await Promise.all([
    listOptions(base, 'CheckpointLoaderSimple', 'ckpt_name'),
    listOptions(base, 'UNETLoader', 'unet_name'),
    listOptions(base, 'CLIPLoader', 'clip_name'),
    listOptions(base, 'VAELoader', 'vae_name'),
  ]);
  return { checkpoints, unet, clip, vae };
}

/**
 * 判断用户填的模型该走哪条加载路径。
 *
 * 不额外开一个「架构」配置项，是因为用户根本答不上来自己那个文件属于哪种 ——
 * 直接问 ComfyUI「这个文件名出现在哪个加载器里」就完了，答案唯一且准确：
 *   · 出现在 CheckpointLoaderSimple 的 ckpt_name 里 → 单文件 checkpoint（市面多数模型）
 *   · 出现在 UNETLoader 的 unet_name 里            → 只有扩散部分，要另配编码器/VAE
 * 找不到时把两份可用清单一起带回去，让报错本身就能指导用户改。
 */
export async function detectArch(base, modelName) {
  const want = String(modelName || '').trim();
  const [checkpoints, unet] = await Promise.all([
    listOptions(base, 'CheckpointLoaderSimple', 'ckpt_name'),
    listOptions(base, 'UNETLoader', 'unet_name'),
  ]);
  const lists = { checkpoints, unet };

  if (!want) return { error: '还没指定模型文件', lists };
  if (checkpoints.includes(want)) return { arch: 'checkpoint', lists };
  if (unet.includes(want)) return { arch: 'split', lists };
  return { error: `ComfyUI 里找不到模型「${want}」`, lists };
}

// ── 工作流 ────────────────────────────────────────────────────────────────

/**
 * 组装 API 格式的工作流图。
 * 两条加载路径汇合之后完全一样：CLIPTextEncode ×2 → KSampler → VAEDecode → SaveImage。
 *   单文件 checkpoint：CheckpointLoaderSimple 一次给出 MODEL(0) / CLIP(1) / VAE(2)
 *   拆分模型（扩散部分、文本编码器、VAE 是三份独立文件的那些）：
 *     UNETLoader + CLIPLoader + VAELoader 三个装载器
 *
 * 拆分路线里 CLIPLoader 的 type 可能填着一个看着完全不搭的值（语言模型编码器却填
 * "stable_diffusion" 之类）—— 那是因为 ComfyUI 对这类编码器是按权重里的 state_dict
 * 自动识别，type 字段不参与判定。
 *
 * 采样参数留空时按架构给默认：拆分模型（新式 DiT）用 euler + sgm_uniform + CFG 4，
 * 老式 checkpoint 用 dpmpp_2m + karras + CFG 7.5 —— 后者 CFG 低了会出灰糊图。
 */
export function buildGraph(cfg, { arch, positive, negative, width, height, seed, prefix, batchSize = 1 }) {
  const isCkpt = arch === 'checkpoint';
  // "auto" 与留空同义：按架构挑默认值。之所以在枚举里放一个 auto 而不是用空串，
  // 是因为面板的 enum 必须带 options，空串在下拉框里表现很怪。
  const pick = (val, forCkpt, forSplit) => {
    const s = String(val ?? '').trim();
    return !s || s === 'auto' ? (isCkpt ? forCkpt : forSplit) : s;
  };
  const sampling = {
    steps: Number(cfg.steps) > 0 ? Number(cfg.steps) : 30,
    cfg: Number(cfg.cfg) > 0 ? Number(cfg.cfg) : isCkpt ? 7.5 : 4,
    sampler_name: pick(cfg.sampler, 'dpmpp_2m', 'euler'),
    scheduler: pick(cfg.scheduler, 'karras', 'sgm_uniform'),
  };

  const graph = {
    4: { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['1', 1] } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['1', 1] } },
    6: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: batchSize } },
    7: {
      class_type: 'KSampler',
      inputs: {
        seed,
        ...sampling,
        denoise: 1,
        model: ['1', 0],
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0],
      },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['1', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: ['8', 0] } },
  };

  if (isCkpt) {
    return {
      1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: String(cfg.modelName) } },
      ...graph,
    };
  }

  // 拆分模型：三个装载器各自的输出接到上面那张图的对应槽位。
  //
  // 文本编码器有**两个不同的装载节点，不能混用**：
  //   单编码器 → CLIPLoader      （type 取 stable_diffusion / qwen_image / wan ...）
  //   双编码器 → DualCLIPLoader  （type 取 flux / sd3 / sdxl / hunyuan_video ...）
  // 两边的 type 枚举**完全不重叠**（CLIPLoader 没有 flux/sdxl，DualCLIPLoader 没有
  // stable_diffusion），用错节点会直接报 invalid clip type。
  // FLUX / SD3 / SDXL 的拆分版都属于双编码器，所以按「有没有填第二个编码器」自动切节点，
  const clipType = String(cfg.clipType || '').trim() || 'stable_diffusion';
  const clip2 = String(cfg.clipName2 || '').trim();
  const clipNode = clip2
    ? {
        class_type: 'DualCLIPLoader',
        inputs: { clip_name1: String(cfg.clipName), clip_name2: clip2, type: clipType, device: 'default' },
      }
    : {
        class_type: 'CLIPLoader',
        inputs: { clip_name: String(cfg.clipName), type: clipType, device: 'default' },
      };

  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: String(cfg.modelName), weight_dtype: 'default' } },
    2: clipNode,
    3: { class_type: 'VAELoader', inputs: { vae_name: String(cfg.vaeName) } },
    ...graph,
    4: { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['2', 0] } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['2', 0] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
  };
}

// ── 提交与等待 ────────────────────────────────────────────────────────────

function collectImages(outputs) {
  const list = [];
  for (const node of Object.values(outputs || {})) {
    for (const img of node?.images || []) {
      if (img?.filename) list.push(img);
    }
  }
  return list;
}

function describeNodeErrors(body) {
  try {
    const json = JSON.parse(body);
    if (json?.error) return JSON.stringify(json.error).slice(0, 400);
    if (json?.node_errors && Object.keys(json.node_errors).length) {
      return JSON.stringify(json.node_errors).slice(0, 400);
    }
  } catch {
    /* 不是 JSON，走原文 */
  }
  return String(body || '').slice(0, 400);
}

/**
 * 看一眼 ComfyUI 现在的队列，好知道这次要等多久。
 */
export async function getQueue(base) {
  try {
    const data = await getJson(`${base}/queue`, 8000);
    return {
      running: Array.isArray(data?.queue_running) ? data.queue_running.length : 0,
      pending: Array.isArray(data?.queue_pending) ? data.queue_pending.length : 0,
    };
  } catch {
    // 查不到就当没排队。这只是个提示，不该因为它挡住出图。
    return { running: 0, pending: 0 };
  }
}

/** 提交工作流并等到出图，返回图片描述数组 [{ filename, subfolder, type }]。 */
export async function submitAndWait(base, graph, timeoutMs, log = () => {}) {
  const res = await httpRequest(`${base}/prompt`, {
    method: 'POST',
    body: { prompt: graph, client_id: randomUUID() },
    timeoutMs: 30000,
  });
  if (res.status !== 200) {
    throw new Error(`提交任务被拒绝（HTTP ${res.status}）：${describeNodeErrors(res.text)}`);
  }
  let promptId = '';
  try {
    promptId = JSON.parse(res.text)?.prompt_id || '';
  } catch {
    /* 下面统一处理 */
  }
  if (!promptId) throw new Error(`提交任务失败：没有返回 prompt_id（${res.text.slice(0, 200)}）`);

  const deadline = Date.now() + Math.max(10000, Number(timeoutMs) || 300000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let entry;
    try {
      const data = await getJson(`${base}/history/${promptId}`, 15000);
      entry = data?.[promptId];
    } catch {
      continue; // 轮询期间服务偶尔抖动不该直接判死
    }
    if (!entry?.status?.completed) continue;

    if (entry.status.status_str === 'error') {
      const errs = (entry.status.messages || []).filter((m) => m?.[0] === 'execution_error');
      throw new Error(`出图失败：${JSON.stringify(errs).slice(0, 400) || 'ComfyUI 报告执行错误'}`);
    }
    const images = collectImages(entry.outputs);
    if (!images.length) throw new Error('出图流程跑完了，但没有任何图片输出');
    log(`出图完成：${images.length} 张（prompt_id ${promptId.slice(0, 8)}）`);
    return images;
  }

  // 超时清理要做两件事，缺一不可：
  //   ① /interrupt —— 打断正在跑的那张（**全局**操作，共享 ComfyUI 上会连带
  //      打断别人的任务；这是接口本身的限制，只能接受并写进提示里）；
  //   ② /queue delete —— 把自己这个 promptId 从**等待队列**里摘掉。
  //      只发 interrupt 的话，排队的这条之后照样会执行：白占显存、产出一批
  //      没人取的图，还会让后来者的「前面还有 N 张」一直不归零。
  await httpRequest(`${base}/interrupt`, { method: 'POST', body: {}, timeoutMs: 8000 }).catch(() => {});
  await httpRequest(`${base}/queue`, {
    method: 'POST',
    body: { delete: [promptId] },
    timeoutMs: 8000,
  }).catch(() => {});
  throw new Error(
    `出图超时（等了 ${Math.round(timeoutMs / 1000)} 秒）。任务已中断并从队列移除。` +
      '首次出图要加载模型会明显偏慢；若经常超时，可调大「单张出图超时」，或降低尺寸/步数。',
  );
}

// ── 出图落地 ──────────────────────────────────────────────────────────────

/**
 * 把 ComfyUI 返回的图片描述拼成本机绝对路径。
 *
 * 这里必须当成**不可信输入**处理：baseUrl 允许填远程地址，那 subfolder / filename
 * 就是外人能控制的字符串。`../../Windows` + `win.ini` 拼出来是 C:\\Windows\\win.ini，
 * 插件会把系统文件当图发到群里。所以两段都只取 basename（丢掉所有目录分隔与上跳），
 * 再把结果锁死回出图目录里。
 */
export function resolveImagePath(cfg, img) {
  const outDir = path.resolve(String(cfg.outputDir || '').trim());
  const sub = path.basename(String(img?.subfolder || '').trim());
  const name = path.basename(String(img?.filename || '').trim());
  if (!name || name === '.' || name === '..') throw new Error('ComfyUI 没有返回可用的文件名');
  const file = sub && sub !== '.' && sub !== '..' ? path.join(outDir, sub, name) : path.join(outDir, name);
  const rel = path.relative(outDir, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`出图路径越界，已拒绝读取：${img?.subfolder || ''}/${img?.filename || ''}`);
  }
  return file;
}

/** 本进程产出过的图片绝对路径。清理时优先只删这些，比只看前缀准得多。 */
const produced = new Set();

export function rememberImage(file) {
  if (file) produced.add(file);
}

export function producedImages() {
  return produced;
}

/**
 * 文件名前缀的合法性：至少 3 个字符，且不能含路径分隔符。
 *
 *   · 短前缀（如 `a`）会匹配到别人同前缀的图 → 误删；
 *   · 前缀里带 `/` 时 SaveImage 会写进子目录，而清理只扫顶层 → 永远清不到；
 *   · 带 `../` 更是直接把清理范围放到出图目录之外。
 * 不合法就别清，让用户去改配置，比默默删错文件好。
 */
export function safePrefix(raw) {
  const p = String(raw ?? '').replace(/[\\/:*?"<>|]/g, '').trim();
  return p.length >= 3 ? p : '';
}

/**
 * 清理自己生成的旧图。
 *  只删「本进程产出的」+ 前缀匹配的 —— 用户自己在 Comfy Desktop 里画的图不会被碰。
 *  没有产出记录时（比如刚重启），退回按前缀扫顶层目录（仅当前缀合法）。
 */
export function pruneImages(cfg, log = () => {}, known = null) {
  const keep = Number(cfg.keepImages) || 0;
  if (keep <= 0) return 0;
  const outDir = String(cfg.outputDir || '').trim();
  if (!outDir) return 0;
  const prefix = safePrefix(cfg.filenamePrefix);
  if (!prefix) {
    log('文件名前缀少于 3 个字符（或含路径分隔符），已跳过清理：短前缀会误删别人的图');
    return 0;
  }
  const absOut = path.resolve(outDir);
  const matchName = (name) => name.startsWith(`${prefix}_`) && /\.(png|jpg|jpeg|webp)$/i.test(name);
  const inside = (full) => {
    const rel = path.relative(absOut, full);
    return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
  };

  try {
    let files;
    const recorded = known && typeof known[Symbol.iterator] === 'function' ? [...known] : [];
    if (recorded.length) {
      // 有产出记录：只认这些文件（它们可能在出图目录的一级子目录里）
      files = recorded
        .map((full) => path.resolve(String(full)))
        .filter((full) => inside(full) && matchName(path.basename(full)))
        .map((full) => {
          let m = 0;
          try {
            m = fs.statSync(full).mtimeMs;
          } catch {
            /* 已经被人删了 */
          }
          return { file: full, name: path.basename(full), m };
        })
        .filter((x) => x.m > 0);
    } else {
      files = fs
        .readdirSync(absOut)
        .filter(matchName)
        .map((f) => ({ file: path.join(absOut, f), name: f, m: fs.statSync(path.join(absOut, f)).mtimeMs }));
    }

    files.sort((a, b) => b.m - a.m); // 新的在前
    const stale = files.slice(keep);
    for (const item of stale) {
      try {
        fs.unlinkSync(item.file);
        produced.delete(item.file);
      } catch {
        /* 单个删不掉不影响其它 */
      }
    }
    if (stale.length) log(`清理了 ${stale.length} 张旧图（保留最近 ${keep} 张）`);
    return stale.length;
  } catch {
    return 0;
  }
}

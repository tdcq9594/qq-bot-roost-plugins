/**
 * 扩展自持的卡片 / 预设存储。
 *
 * 三条硬约束（都是验证报告打出来的）：
 *
 *  1. **跨进程互斥**：面板动作（宿主进程）和 MCP 子进程会同时写同一个文件。
 *     只做「读整库 → 改 → 写整库」会丢更新：两边都读到旧库，后写的覆盖先写的。
 *     所以每次修改都要拿锁（`wx` 独占创建锁文件），拿不到就重试。
 *  2. **损坏不能静默清零**：以前读失败一律当空库，用户保存一次就把原数据覆盖没了。
 *     现在只有「文件不存在」才算首次运行；解析失败会保留原文件、改名成
 *     `.corrupt-*` 备份并抛错，调用方看到的是明确错误而不是空列表。
 *  3. **原子替换**：写临时文件再 rename，保证不会留下半份 JSON。
 */

import {
  readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync, openSync, closeSync, unlinkSync, existsSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 路径**每次现取**，不在模块加载时定格。
 *
 * 加载期取值的问题：宿主可能在运行期改 `ROOST_LAUNCHER_DIR`，而且同一个模块
 * 被不同 specifier 引入时会得到不同实例、各自抓一份旧路径——表现是「明明存了，
 * 另一个入口读不到」。现取一行 env，代价可以忽略。
 */
const stateDir = () => String(process.env.ROOST_LAUNCHER_DIR || join(homedir(), '.dsh', 'dsh-roost'));
export const stateFile = () => join(stateDir(), 'persona-scope-ext.json');
const lockFile = () => `${stateFile()}.lock`;

const DEFAULTS = { version: 1, cards: [], presets: [] };

const str = (v, max = 40_000) => String(v ?? '').slice(0, max);

function normalizeItem(raw, kind) {
  const it = raw && typeof raw === 'object' ? raw : {};
  return {
    id: String(it.id || '').trim() || `${kind}-${randomUUID().slice(0, 8)}`,
    name: str(it.name, 60).trim() || (kind === 'card' ? '未命名人设卡' : '未命名预设'),
    text: str(it.text),
    enabled: it.enabled !== false,
    /**
     * 这张卡要不要受人设成长影响。
     *
     * 默认 **false**（opt-in）：成长是别人（persona-grow）写进来的内容，
     * 不该在用户没要求时悄悄混进专属人设里。
     */
    growth: it.growth === true,
    /**
     * 插件侧原始字段（`role` / `when` / `targets`）。
     * **落盘时必须带着**：丢了它，完整导入再导出会把 assistant 预设写成 system。
     */
    ...(it._plugin && typeof it._plugin === 'object' ? { _plugin: { ...it._plugin } } : {}),
  };
}

/** 数据损坏：带上可恢复的文件路径，让调用方能原样告诉用户 */
export class StateCorruptError extends Error {
  constructor(file, backup, cause) {
    super(`素材文件损坏，已保留备份为 ${backup}，没有覆盖原数据（原因：${cause}）`);
    this.name = 'StateCorruptError';
    this.code = 'STATE_CORRUPT';
    this.file = file;
    this.backup = backup;
  }
}

export function loadState() {
  let raw;
  try {
    raw = readFileSync(stateFile(), 'utf8');
  } catch (e) {
    // 只有「不存在」才是首次运行；权限 / 被占用等异常要显式报出来，不能假装空库
    if (e?.code === 'ENOENT') return { ...DEFAULTS, cards: [], presets: [] };
    throw Object.assign(new Error(`素材文件读不出来：${e?.message ?? e}`), { code: 'STATE_UNREADABLE' });
  }

  try {
    const j = JSON.parse(raw);
    return {
      version: 1,
      cards: (Array.isArray(j?.cards) ? j.cards : []).map((x) => normalizeItem(x, 'card')),
      presets: (Array.isArray(j?.presets) ? j.presets : []).map((x) => normalizeItem(x, 'preset')),
    };
  } catch (e) {
    /**
     * 解析失败：**先备份再抛错**，绝不返回空库。
     * 返回空库的后果是「用户下一次保存把原有卡片全删了」，而且没有任何提示。
     */
    /**
     * **复制**而不是移走：原文件留在原位，任何一次保存都会继续撞上这个坏文件
     * 并报错——不存在「静默从空库重新开始」的窗口。用户改好或删掉它即可恢复。
     */
    const backup = `${stateFile()}.corrupt-${Date.now()}`;
    try { copyFileSync(stateFile(), backup); } catch { /* 备份失败也要抛原错误 */ }
    throw new StateCorruptError(stateFile(), existsSync(backup) ? backup : '(备份失败)', e?.message ?? String(e));
  }
}

/** 不加锁的写：只给已持锁的调用方用 */
function writeUnlocked(next) {
  const body = {
    version: 1,
    cards: (next?.cards ?? []).map((x) => normalizeItem(x, 'card')),
    presets: (next?.presets ?? []).map((x) => normalizeItem(x, 'preset')),
  };
  const file = stateFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return body;
}

/** 直接写（不加锁）：保留旧签名，供「已经算好整份」的调用方使用 */
export function saveState(next) {
  return writeUnlocked(next);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 跨进程临界区。
 *
 * 用 `wx` 独占创建锁文件：拿到就是拿到了，拿不到说明另一个进程正在写。
 * 超时（默认 3 秒）就放弃并**抛错**——静默跳过写会让用户以为保存成功了。
 * 锁文件带 pid 与时间戳，超过 10 秒视为陈旧锁（进程崩了留下的），直接接管。
 */
export async function withLock(fn, { timeoutMs = 3000, staleMs = 10_000 } = {}) {
  mkdirSync(dirname(stateFile()), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let fd = null;

  for (;;) {
    try {
      fd = openSync(lockFile(), 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
      break;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      // 陈旧锁：持锁进程已经不在了
      try {
        const st = statSync(lockFile());
        if (Date.now() - st.mtimeMs > staleMs) { unlinkSync(lockFile()); continue; }
      } catch { /* 锁刚好被释放，重试 */ }
      if (Date.now() > deadline) {
        throw Object.assign(new Error('素材文件正被另一个进程写入，请稍后重试'), { code: 'STATE_LOCKED' });
      }
      await sleep(25);
    }
  }

  try {
    return await fn();
  } finally {
    try { if (fd !== null) closeSync(fd); } catch { /* 已关 */ }
    try { unlinkSync(lockFile()); } catch { /* 已被接管 */ }
  }
}

/** 在锁里做「读 → 改 → 写」 */
export async function mutate(fn) {
  return withLock(async () => {
    const cur = loadState();
    const { next, result } = await fn(cur);
    const saved = writeUnlocked(next ?? cur);
    return { saved, result };
  });
}

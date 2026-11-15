/**
 * 跨进程文件锁（0.2 修复）
 * ========================
 *
 * 为什么需要它：扩展目录里的 `state.json` / `ui-data.json` / `gallery.json`
 * 有**两个写者**——MCP 子进程和宿主进程内的面板动作（`ui/main.mjs`）。
 * `tmp + rename` 只保证「一次写是原子的」，保证不了「读 → 改 → 写」这三步
 * 原子的：两个进程都读到 `count=0`，各自写 `count=1`，结果是 1 不是 2。
 * 按张收钱的生图服务上，这就是同一次限额被画了三张。
 *
 * 做法：`openSync(path, 'wx')` 是跨进程原子的「创建且仅在不存在时成功」，
 * 拿到的那一个进程独占读-改-写，其余同步等一小会儿再抢。
 * 全部业务代码都是同步 fs（不 await），持锁时间只有几毫秒，
 * 所以用 `Atomics.wait` 做同步微睡眠即可，不需要 async 锁队列。
 *
 * ## owner token（第二轮对抗测试逼出来的）
 *
 * 只判断「锁文件够旧就 unlink」是有竞态的：P1 刚 open 成功建了新锁，
 * P2 恰好判完陈旧并执行 unlink，把 **P1 的新锁**删了，于是 P2 也能 open
 * 成功 —— 两个进程同时进临界区（实测 100 轮里 5–7 轮双花）。
 *
 * 所以每次抢到锁都写一个唯一 token，退避 1ms 后**读回校验**：
 * 文件里不是自己的 token，就说明锁被别人删/抢了，重新竞争，绝不进临界区。
 * 释放时也只在 token 仍匹配时 unlink，避免删掉别人重建的锁。
 * 这样即使 unlink 与 open 交错，互斥依然成立。
 *
 * ## 兜底
 *   · Windows 上锁文件正被 unlink 时 `openSync('wx')` 会抛 **EPERM/EACCES/EBUSY**
 *     （不是 EEXIST）——这类必须当竞争重试，直接退化会丢更新；
 *   · 随机退避 + 5 秒上限，避免高频争用下某个进程一直饿死；
 *   · 真的拿不到（目录被占成文件、磁盘异常）才退化为无锁并**记日志**：
 *     配额与面板状态是省钱/展示用途，不该把一次生图变成故障。
 */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** 同步睡一会儿，不阻塞其它进程的锁释放（Atomics.wait 不占 CPU） */
export function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
  } catch { /* 环境不支持就退化为忙等，反正每次只等几毫秒 */ }
}

/**
 * @param {string} dir 数据所在目录（扩展目录或 out/）
 * @param {string} name 被保护的文件名，锁文件名是 `<name>.lock`
 * @param {() => T} fn 同步的「读-改-写」闭包
 * @param {{timeoutMs?:number, staleMs?:number, log?:Function}} [opts]
 * @returns {T} fn 的返回值
 */
export function withFileLock(dir, name, fn, { timeoutMs = 5000, staleMs = 8000, log = () => {} } = {}) {
  /**
   * 目录建不起来（比如 `out/` 被人放了个同名文件、磁盘满了）就退化为无锁：
   * 配额和面板状态都不该变成新的故障点，生图存盘失败还有自己的如实文案。
   */
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    log(`⚠ ${name} 的数据目录建不起来（${e?.code ?? e?.message}），这次退化为无锁执行`);
    return fn();
  }

  const lock = join(dir, `${name}.lock`);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + timeoutMs;
  let fd = null;

  for (;;) {
    try {
      fd = openSync(lock, 'wx');
      writeSync(fd, token);
      /**
       * 给「另一个进程把我这个新锁当陈旧锁删掉」留一个可观测窗口。
       * 读回不是自己的 token（或文件已不存在）就重新抢，绝不进临界区。
       */
      sleepSync(1);
      let owner = '';
      try { owner = readFileSync(lock, 'utf8'); } catch { owner = ''; }
      if (owner !== token) {
        try { closeSync(fd); } catch { /* 已经关了 */ }
        fd = null;
        continue;
      }
      break;
    } catch (e) {
      const code = e?.code;
      const competing = ['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(code);
      if (!competing) {
        log(`⚠ 拿不到 ${name} 的文件锁（${code ?? e?.message}），这次退化为无锁执行`);
        return fn();
      }
      if (code === 'EEXIST') {
        /** 锁文件可能是被强杀的进程留下的，够旧就删掉让竞争重来 */
        try {
          const st = statSync(lock);
          if (Date.now() - st.mtimeMs > staleMs) {
            try { unlinkSync(lock); } catch { /* 别人先删了 */ }
            continue;
          }
        } catch {
          /** stat 失败 = 锁刚被释放，直接再抢一次 */
          continue;
        }
      }
      if (Date.now() >= deadline) {
        log(`⚠ 拿不到 ${name} 的文件锁（等了 ${timeoutMs}ms），这次退化为无锁执行`);
        return fn();
      }
      /** 随机退避：固定间隔会让同一个进程在高频争用下一直饿死 */
      sleepSync(2 + Math.floor(Math.random() * 7));
    }
  }

  try {
    return fn();
  } finally {
    try { closeSync(fd); } catch { /* 已经关了 */ }
    /** 只删自己的锁：别人的锁（重建过的）不能动 */
    try {
      if (readFileSync(lock, 'utf8') === token) unlinkSync(lock);
    } catch { /* 文件已经不在了 */ }
  }
}

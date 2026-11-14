/**
 * 面板按钮 → 扩展执行（0.5）
 * ============================================================
 *
 * 扩展页面的按钮由宿主渲染，点击后宿主只把**动作名**放进队列；
 * 扩展自己轮询 `GET /v1/ext-ui/actions` 取走执行。宿主不认识这些动作，
 * 扩展也不需要在面板里放代码 —— 两边的边界都不动。
 *
 * 为什么是轮询而不是让宿主回调扩展：
 *   stdio 扩展没有端口，宿主拿不到它；让它为了几个按钮起一个 HTTP 服务，
 *   等于给每台机器多开一个监听口，收益不抵风险。轮询最多晚 2 秒，
 *   这几个动作（刷新热门 / 刷一轮 / 查登录）本来也不是毫秒级交互。
 *
 * 取动作是**读即消费**：宿主那边取走就清空，所以这里失败一次不会重放。
 * 失败只记日志，不重试 —— 「现在刷一轮」重试三次等于连刷三轮。
 */

export function createUiActions({
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 8000,
  intervalMs = 2000,
  handlers = {},
  log = () => {},
} = {}) {
  const base = String(env?.ROOST_API_URL || '').replace(/\/+$/, '');
  const token = String(env?.ROOST_API_TOKEN || '');
  let stopped = true;
  let busy = false;
  /** 长轮询挂多久；宿主那边上限 30 秒，这里留一秒余量 */
  const WAIT_MS = 25_000;

  async function poll(waitMs = 0) {
    if (!base || !token || busy) return { ok: false, why: '通道未就绪' };
    busy = true;
    try {
      const qs = waitMs > 0 ? `?wait=${Math.round(waitMs)}` : '';
      const r = await fetchImpl(`${base}/ext-ui/actions${qs}`, {
        headers: { authorization: `Bearer ${token}` },
        /** 长轮询时请求会挂 25 秒，超时必须比它长，否则每 8 秒就断一次 */
        signal: AbortSignal.timeout(waitMs > 0 ? waitMs + 8_000 : timeoutMs),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) {
        /** 通道没开 / 令牌缺 scope 时会一直 403；只在第一次记，避免日志刷屏 */
        if (r.status === 403 || r.status === 404) log(`动作通道不可用（HTTP ${r.status}）`);
        return { ok: false, why: `HTTP ${r.status}` };
      }
      const list = Array.isArray(j.actions) ? j.actions : [];
      for (const it of list) {
        const name = String(it?.action ?? '');
        const fn = handlers[name];
        if (typeof fn !== 'function') {
          log(`收到没有处理函数的动作：${name}`);
          continue;
        }
        try {
          await fn(it);
          log(`动作「${name}」执行完成`);
        } catch (e) {
          log(`动作「${name}」执行失败：${e?.message ?? e}`);
        }
      }
      return { ok: true, count: list.length };
    } catch {
      /** 宿主没起来时每 2 秒一条错误会盖住真正的日志，这里静默 */
      return { ok: false, why: '网络错误' };
    } finally {
      busy = false;
    }
  }

  return {
    get available() { return Boolean(base && token); },
    poll,
    /**
     * 长轮询循环：一次请求最多挂 25 秒，返回后立刻再来。
     * 动作一入队宿主就唤醒，所以点按钮到执行之间基本没有固定延迟。
     */
    async loop() {
      while (!stopped) {
        try { await poll(WAIT_MS); } catch { /* 网络抖动：下一轮继续 */ }
        if (stopped) break;
        await new Promise((r) => { const t = setTimeout(r, 250); t.unref?.(); });
      }
    },
    start() {
      if (!stopped || !base || !token) return false;
      stopped = false;
      void this.loop();
      return true;
    },
    stop() { stopped = true; },
  };
}

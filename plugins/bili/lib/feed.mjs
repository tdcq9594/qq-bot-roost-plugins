/**
 * 定时刷（0.3，默认关）
 * =====================
 *
 * **只预热，不主动推消息。** 定时器做的事只有两件：拉一次热门喂给 `hot`
 * 的缓存、顺手刷新面板数据。它不会往任何会话发东西 —— 扩展拿不到
 * 「当前是哪个会话」，`/v1/proactive` 触发的是宿主自己的主动搭话，
 * 内容不受扩展控制，拿它来「推视频」等于让她莫名其妙冒一句。
 *
 * 为什么默认关：0.2.0 的 README 里写过一条真实判断 —— MCP server 是长驻
 * 进程，装了就一直打 B 站接口，412 是迟早的事，而用户可能一天都不打开面板。
 * 所以 `feedIntervalMin=0` 不开；开了也还有三道闸：
 *   · 活跃时段（`feedActiveHours`，如 `9-23`）—— `/v1/state` 里**没有**
 *     清醒时段，那份判定在宿主 `shouldFire()`，扩展看不到，别硬猜；
 *   · 刷新前先探一次 `/v1/state`：宿主没在线就别白打 B 站；
 *   · B 站自己报的 412 退避期（`api.state().pausedUntil`）内跳过。
 *
 * 刷到的东西只留在**内存**里（`feed` 工具读它），不落盘：市场索引的 sha256
 * 按整个插件目录算，运行时多一个 JSON 就会让 `build-index --check` 变脏。
 */

import { inActiveHours } from './config.mjs';

/** 最小间隔 15 分钟：比这还密就是拿扩展当爬虫用。 */
export const MIN_FEED_MINUTES = 15;

/**
 * 探宿主是否在线。`/v1/state` 只要 `state:read`（扩展默认就有），
 * 不需要额外声明 scope；手动 `--call` 时没有这两个 env 属正常，直接跳过。
 */
export function createHostState(env = process.env) {
  const base = String(env?.ROOST_API_URL || '').replace(/\/+$/, '');
  const token = String(env?.ROOST_API_TOKEN || '');
  return async function hostState({ fetchImpl = fetch } = {}) {
    if (!base || !token) return { ok: false, why: '没有 ROOST_API_URL / ROOST_API_TOKEN（手动调用时正常）' };
    try {
      const r = await fetchImpl(`${base}/state`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      const j = await r.json().catch(() => null);
      return { ok: r.status === 200 && j?.ok === true, status: r.status, mood: j?.mood ?? null };
    } catch (e) {
      return { ok: false, why: String(e?.message ?? e) };
    }
  };
}

export function createFeed({
  cfg, api, onFresh = () => {},
  hostState = async () => ({ ok: true }),
  log = () => {}, now = () => Date.now(),
  intervalImpl = setInterval, clearImpl = clearInterval,
} = {}) {
  const minutes = Math.round(Number(cfg?.feedIntervalMin) || 0);
  const enabled = cfg?.enabled !== false && minutes >= MIN_FEED_MINUTES;
  let timer = null;
  let running = false;
  let items = [];
  let last = { at: 0, count: 0, error: '', hostMood: null, reason: '' };

  async function tick(reason = '定时') {
    if (running) return { ok: false, why: '上一轮还没结束' };
    /** 用注入的 `now()`；测试才验得了「半夜不刷」这道闸 */
    if (!inActiveHours(cfg?.feedActiveHours, new Date(now()))) {
      last = { ...last, reason: '不在活跃时段' };
      return { ok: false, why: `不在活跃时段（${cfg?.feedActiveHours || '全天'}）` };
    }
    const hs = await hostState();
    if (!hs.ok) {
      const why = `宿主没在线：${hs.why ?? `HTTP ${hs.status}`}`;
      last = { ...last, reason: why };
      return { ok: false, why };
    }
    const paused = Number(api?.state?.()?.pausedUntil) || 0;
    if (paused > now()) {
      const why = `B 站风控退避中（还剩 ${Math.ceil((paused - now()) / 60_000)} 分钟）`;
      last = { ...last, reason: why };
      return { ok: false, why };
    }

    running = true;
    try {
      const got = await api.hot({ ps: Number(cfg?.hotPoolSize) || 20 });
      if (!Array.isArray(got) || !got.length) throw new Error('热门池是空的');
      items = got;
      onFresh(got);
      last = { at: now(), count: got.length, error: '', hostMood: hs.mood ?? null, reason };
      log(`定时刷完成：${got.length} 条（${reason}）`);
      return { ok: true, count: got.length };
    } catch (e) {
      const why = String(e?.message ?? e);
      last = { ...last, error: why, reason: '这一轮没刷成' };
      log(`定时刷失败（不影响使用）：${why}`);
      return { ok: false, why };
    } finally {
      running = false;
    }
  }

  function start() {
    if (!enabled || timer) return false;
    timer = intervalImpl(() => { tick().catch(() => {}); }, minutes * 60_000);
    /** 别让一个定时器把 stdio 子进程吊住：宿主关管道时进程要能自己退 */
    timer?.unref?.();
    return true;
  }

  function stop() {
    if (timer) clearImpl(timer);
    timer = null;
  }

  return {
    enabled,
    minutes,
    /**
     * 启动预热 / `hot` 工具顺手喂进来的那批：只填内存，不额外发请求，
     * 也不算「定时刷成功过一轮」。这样第一个周期没到时 `feed` 也有东西可看。
     */
    seed(got, reason = '预热') {
      if (!Array.isArray(got) || !got.length) return false;
      items = got;
      last = { at: now(), count: got.length, error: '', hostMood: null, reason };
      return true;
    },
    /** 给 `feed` 工具：最近一次成功刷到的那批 */
    items: () => items.slice(),
    state: () => ({ ...last, enabled, minutes, activeHours: String(cfg?.feedActiveHours || ''), items: items.length }),
    tick,
    start,
    stop,
  };
}

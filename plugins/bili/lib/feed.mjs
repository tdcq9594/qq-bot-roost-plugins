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
 * 一轮的筛子：播放量门槛、只看最近几天。
 *
 * `pubdate` 是**秒**（B 站接口），而 `now` 是毫秒——这里统一换算，
 * 别在调用方各写一遍（写错就会「只看最近 7 天」把一切都筛掉）。
 *
 * @param {object[]} list
 * @param {{minViews?: number, maxAgeDays?: number, now?: number}} [o]
 */
export function filterItems(list, { minViews = 0, maxAgeDays = 0, now = Date.now() } = {}) {
  const items = Array.isArray(list) ? list : [];
  const min = Math.max(0, Number(minViews) || 0);
  const days = Math.max(0, Number(maxAgeDays) || 0);
  if (!min && !days) return items.slice();
  return items.filter((v) => {
    if (min && (Number(v?.play) || 0) < min) return false;
    if (days) {
      const pub = Number(v?.pubdate) || 0;
      /** 没有发布时间的不拦（有些接口不给），否则会被静默筛光 */
      if (pub) {
        const pubMs = pub > 1e12 ? pub : pub * 1000;
        if (now - pubMs > days * 86_400_000) return false;
      }
    }
    return true;
  });
}

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
  /** 每次 tick 前调一次：用来热读宿主刚保存的配置（见 lib/live-config.mjs） */
  beforeTick = null,
  /** 今天已经刷了几轮（`feedMaxRunsPerDay` 用它判断）；由调用方从面板数据里取 */
  runsToday = () => 0,
} = {}) {
  /**
   * **现算，不再在创建时算死**。
   *
   * 0.6 起配置可以在运行期改（面板保存 → 扩展热读，不用重启子进程）。
   * 创建时把 `minutes` 抠出来存成常量，改完设置定时器还是老间隔，
   * 表现就是「改了刷的频率没反应，得重启」。
   */
  const minutesNow = () => Math.round(Number(cfg?.feedIntervalMin) || 0);
  const enabledNow = () => cfg?.enabled !== false && minutesNow() >= MIN_FEED_MINUTES;
  /** 当前定时器是按多少分钟起的：用来判断「间隔变了要重起」 */
  let timerMinutes = 0;
  let timer = null;
  let running = false;
  let items = [];
  let last = { at: 0, count: 0, error: '', hostMood: null, reason: '' };

  async function tick(reason = '定时') {
    /** 先热读配置：这一轮用的必须是面板上刚存下的值 */
    try {
      await beforeTick?.();
    } catch { /* 热读失败不该让这一轮不刷 */ }
    if (running) return { ok: false, why: '上一轮还没结束' };

    /**
     * 每天最多刷几轮：**只拦定时刷**。
     *
     * 手动点「现在刷一轮」是用户明确要的，被上限拦下来会让人以为按钮坏了。
     */
    const cap = Math.max(0, Number(cfg?.feedMaxRunsPerDay) || 0);
    if (cap && reason !== '手动') {
      const used = Number(runsToday()) || 0;
      if (used >= cap) {
        last = { ...last, reason: `今天已经刷了 ${used} 轮（上限 ${cap}）` };
        return { ok: false, why: `今天已经刷了 ${used} 轮，到上限了（${cap}）` };
      }
    }
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
      const raw = await api.hot({ ps: Number(cfg?.hotPoolSize) || 20 });
      if (!Array.isArray(raw) || !raw.length) throw new Error('热门池是空的');

      /** 先按「播放量 / 新鲜度」筛，再按「一轮看几个」截 */
      const filtered = filterItems(raw, {
        minViews: Number(cfg?.feedMinViews) || 0,
        maxAgeDays: Number(cfg?.feedMaxAgeDays) || 0,
        now: now(),
      });
      if (!filtered.length) {
        throw new Error(`筛得太严了：${raw.length} 条热门里一条都没剩（播放量门槛 / 只看最近）`);
      }
      const perRun = Math.max(1, Math.min(10, Number(cfg?.feedPerRun) || 6));
      const got = filtered.slice(0, perRun);
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
    if (timer) return false;
    const m = minutesNow();
    if (cfg?.enabled === false || m < MIN_FEED_MINUTES) return false;
    timerMinutes = m;
    timer = intervalImpl(() => { tick().catch(() => {}); }, m * 60_000);
    /** 别让一个定时器把 stdio 子进程吊住：宿主关管道时进程要能自己退 */
    timer?.unref?.();
    return true;
  }

  /**
   * 按当前配置对齐定时器：该开的开、该停的停、间隔变了就重起。
   * 配置热读之后调它一次，改设置就不用等重启。
   */
  function syncTimer() {
    const m = minutesNow();
    const on = cfg?.enabled !== false && m >= MIN_FEED_MINUTES;
    if (!on) {
      const had = Boolean(timer);
      stop();
      return had;
    }
    if (!timer || m !== timerMinutes) {
      stop();
      return start();
    }
    return false;
  }

  function stop() {
    if (timer) clearImpl(timer);
    timer = null;
  }

  return {
    /** getter：读的人随时拿到当前配置，而不是创建那一刻的值 */
    get enabled() { return enabledNow(); },
    get minutes() { return minutesNow(); },
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
    state: () => ({
      ...last,
      enabled: enabledNow(), minutes: minutesNow(),
      activeHours: String(cfg?.feedActiveHours || ''), items: items.length,
    }),
    tick,
    start,
    stop,
    syncTimer,
  };
}

/**
 * 配置解析（0.3）
 * ==============
 *
 * 宿主把面板里保存的**非敏感**值拼成 JSON 放在 `ROOST_EXT_CONFIG`，
 * 标了 `secret: true` 的 `cookie` 走 `ROOST_EXT_SECRET_COOKIE` 单独注入。
 * 扩展自己不做持久化：密钥明文只在宿主的 `secrets/` 里，进程退出就没了。
 *
 * 这里全部是纯函数，测试直接喂一个假 env，不用起宿主、不用联网。
 * 范围再夹一次：面板保存前会校验，但用户可能手改 `config.json`。
 */

/** 密钥字段名 → env 变量名。与宿主 `ext-config.js` 的 `secretEnvOf()` 同一套规则。 */
export function secretEnv(key) {
  return `ROOST_EXT_SECRET_${String(key).replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}

function strOf(v, def = '', max = 500) {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : def;
}

/** 夹到 [min,max] 的整数；空 / 非数字给默认值。 */
export function intOf(v, def, min, max) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function boolOf(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (['false', '0', 'no', 'off', '否'].includes(s)) return false;
  if (['true', '1', 'yes', 'on', '是'].includes(s)) return true;
  return def;
}

/**
 * 定时刷的活跃时段：`"9-23"`（白天）或 `"22-6"`（跨午夜）。
 * 留空 = 全天。写错格式按全天处理，别让一个手滑把功能悄悄关掉。
 *
 * 为什么不让扩展去读宿主的「醒着」配置：`/v1/state` 里只有
 * mood / bindings / lastBucket，**没有清醒时段**。那份判定在宿主
 * `shouldFire()` 里，扩展看不到，硬猜只会半夜照刷。
 */
export function parseActiveHours(raw) {
  const m = String(raw ?? '').trim().match(/^(\d{1,2})\s*[-~～]\s*(\d{1,2})$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start > 23 || end > 23 || start === end) return null;
  return { start, end };
}

export function inActiveHours(raw, now = new Date()) {
  const h = parseActiveHours(raw);
  if (!h) return true;
  const hour = now instanceof Date ? now.getHours() : new Date(Number(now) || Date.now()).getHours();
  /** 跨午夜：22-6 表示 22,23,0..5 */
  return h.start < h.end
    ? hour >= h.start && hour < h.end
    : hour >= h.start || hour < h.end;
}

export function readConfig(env = process.env) {
  let raw = {};
  try {
    const parsed = JSON.parse(String(env?.ROOST_EXT_CONFIG || '{}'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
  } catch {
    /* 配置坏了不该让扩展起不来，按默认值继续 */
  }
  return {
    /** 总开关：关掉后不定时刷、不推送、不跑写动作；工具仍然可用 */
    enabled: raw.enabled !== false,
    defaultLimit: intOf(raw.defaultLimit, 6, 1, 8),
    hotPoolSize: intOf(raw.hotPoolSize, 20, 10, 30),
    commentLimit: intOf(raw.commentLimit, 5, 1, 10),
    defaultDanmaku: boolOf(raw.defaultDanmaku, false),

    /** Cookie 明文：只从 secret env 来，绝不写进 ROOST_EXT_CONFIG */
    cookie: strOf(env?.[secretEnv('cookie')], '', 4000),

    /** 0 = 不定时刷。装了扩展就一直打 B 站接口是 412 的捷径，默认必须关 */
    feedIntervalMin: intOf(raw.feedIntervalMin, 0, 0, 240),
    feedActiveHours: strOf(raw.feedActiveHours, '', 20),
    /**
     * 一轮的筛子（对齐 aurabot 那页的四个滑条）。
     *
     * 都是「0 = 不限」，因为默认限制越多越容易让人以为「刷不到东西」。
     */
    feedPerRun: intOf(raw.feedPerRun, 6, 1, 10),
    feedMinViews: intOf(raw.feedMinViews, 0, 0, 10_000_000),
    feedMaxAgeDays: intOf(raw.feedMaxAgeDays, 0, 0, 365),
    feedMaxRunsPerDay: intOf(raw.feedMaxRunsPerDay, 0, 0, 48),

    ffmpegPath: strOf(raw.ffmpegPath, '', 300),
    shotWidth: intOf(raw.shotWidth, 512, 256, 1024),
    shotKeep: intOf(raw.shotKeep, 12, 1, 50),
    shotDir: strOf(raw.shotDir, '', 300),

    /* ---------------- 0.4：每个功能一个开关，默认全关 ---------------- */
    /** 主动推送：交给宿主的素材通道，由模型写措辞、宿主过门闸 */
    pushOwner: boolOf(raw.pushOwner, false),
    pushGroup: boolOf(raw.pushGroup, false),
    pushGroupTarget: strOf(raw.pushGroupTarget, '', 64),
    pushApproval: boolOf(raw.pushApproval, false),
    /** 素材里带 https 封面地址。不写 <<card:>>：主动轮次会抹平标记 */
    pushCover: boolOf(raw.pushCover, false),
    pushMinPlay: intOf(raw.pushMinPlay, 100000, 0, 10_000_000),
    pushDailyLimit: intOf(raw.pushDailyLimit, 20, 1, 200),
    pushPerFeed: intOf(raw.pushPerFeed, 1, 1, 5),

    /** 定时刷命中后自动抽一帧存本地；不主动发图 */
    autoShot: boolOf(raw.autoShot, false),

    /** 写动作：不注册 MCP 工具，只在定时刷内部跑；试运行默认开 */
    autoComment: boolOf(raw.autoComment, false),
    commentTemplate: strOf(raw.commentTemplate, '看着挺有意思，收藏了', 200),
    autoLike: boolOf(raw.autoLike, false),
    autoDanmaku: boolOf(raw.autoDanmaku, false),
    danmakuTemplate: strOf(raw.danmakuTemplate, '好看', 100),
    writeDryRun: boolOf(raw.writeDryRun, true),
    writeDailyLimit: intOf(raw.writeDailyLimit, 10, 1, 100),
  };
}

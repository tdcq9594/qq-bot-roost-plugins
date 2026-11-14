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
  /**
   * 「顺手截几张」是**开关 + 数量合成的一项**：清单最多 32 个配置字段，
   * 单独再放一个 boolean 会超（宿主 validateManifest 直接判清单无效，
   * 整个扩展从已装列表里消失——0.11.0 就是这么丢的）。
   */
  const autoShotCount = intOf(raw.autoShotCount, 0, 0, 10);
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
    /**
     * 让她自己在独立会话里看这一轮刷到的（`aiDecide`）。
     *
     * **默认关**：开一轮就多一次模型调用。关着时结果进待处理队列，
     * 等她下次调 `feed` 工具时接手——不会丢，只是晚一点。
     */
    aiDecide: boolOf(raw.aiDecide, false),
    /** 额外想看的方向：一行一个，刷的时候按关键词也搜几条 */
    feedKeywords: strOf(raw.feedKeywords, '', 400),

    ffmpegPath: strOf(raw.ffmpegPath, '', 300),
    /** 宽度固定 512：够看清又不慢；面板不再暴露（配置字段有上限） */
    shotWidth: 512,
    shotKeep: intOf(raw.shotKeep, 60, 1, 300),
    /**
     * 推给主人时顺手截一张的概率（百分比，0 = 从不）。
     *
     * 发不发得出去由**宿主**决定：宿主没有「主动消息带图」的通道，所以这里
     * 的做法是把截图路径写进素材，让模型自己决定要不要写 `<<image-alone:>>`
     * 发那张图。写清楚比假装能保证更诚实。
     */
    shotChance: intOf(raw.shotChance, 0, 0, 100),
    /**
     * 截图目录**固定用扩展自己的 `shots/`**。
     *
     * 面板只从扩展目录取图，指到别处等于「图库永远是空的」——这个坑
     * 比「能自定义路径」的收益大得多，所以直接不给配。
     */
    shotDir: '',

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

    /** 顺手截几张（0 = 不截）。`autoShot` 是派生值，写动作/推送那边照旧只看它 */
    autoShotCount,
    autoShot: autoShotCount > 0,

    /**
     * 写动作：不注册 MCP 工具，只在定时刷内部跑；试运行默认开。
     *
     * **没有模板**：评论和弹幕的话必须是她看过内容之后自己写的
     * （见 lib/ai-duty.mjs 的独立会话）。开着开关但她这轮没想去说，
     * 就不发——不再拿一句「这个视频不错」凑数。
     */
    autoComment: boolOf(raw.autoComment, false),
    /**
     * 主人的 B 站昵称：她自动评论 / 回复时会在末尾 @ 一下。
     *
     * 注意 B 站的 @ 只是**文本**，不会真的给对方发提醒（那是客户端行为），
     * 所以这里的作用是「让人看得见我提到了你」，不是通知。
     */
    ownerName: strOf(raw.ownerName, '', 40),
    autoLike: boolOf(raw.autoLike, false),
    /** 同上：弹幕内容由她决定，没有模板可填 */
    autoDanmaku: boolOf(raw.autoDanmaku, false),
    writeDryRun: boolOf(raw.writeDryRun, true),
    writeDailyLimit: intOf(raw.writeDailyLimit, 10, 1, 100),
  };
}

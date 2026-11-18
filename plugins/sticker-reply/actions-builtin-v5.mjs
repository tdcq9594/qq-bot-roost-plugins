/**
 * 面板动作（inprocess）。宿主 `import()` 本文件，点按钮时直接调。
 *
 * 只做参数翻译与结果整形；扫描/标注/判断都在 lib 里，MCP 那份共用同一套实现。
 */

import { readFileSync } from 'node:fs';

const MANIFEST = JSON.parse(readFileSync(new URL('./plugin.json', import.meta.url), 'utf8'));
const V = String(MANIFEST.version || '0');

const { setApiEnv, apiReady, apiWhy } = await import(`./lib/api.mjs?v=${V}`);
const store = await import(`./lib/store.mjs?v=${V}`);
const { decide, lastDecision } = await import(`./lib/judge.mjs?v=${V}`);
const builtin = await import(`./lib/builtin.mjs?v=${V}`);

/**
 * 包一层：**每次动作执行前重新同步凭据**。
 *
 * 宿主会缓存动作工厂，只在原地更新工厂拿到的那一个 `env` 对象。
 * 如果在 `createActions()` 里只同步一次，宿主轮换令牌后这里还拿着旧值，
 * 下一次请求就会 401。这里每次调用都从 `env` 重读一次。
 */
const makeWrap = (env) => (fn) => async (payload = {}) => {
  try {
    setApiEnv({ root: env?.ROOST_API_URL || '', token: env?.ROOST_API_TOKEN || '' });
    return { ok: true, data: await fn(payload || {}) };
  } catch (e) {
    return { ok: false, message: String(e?.message ?? e), data: { ok: false } };
  }
};

/** 缩略图：只接受已登记的图片 ID，按需返回 data URL */
function thumbOf(id) {
  const settings = store.loadSettings();
  const { images } = store.listAnnotated(settings);
  const hit = images.find((x) => x.id === String(id || ''));
  if (!hit) throw new Error('没有这个图片 ID');
  const buf = readFileSync(hit.path);
  const ext = (/\.(\w+)$/.exec(hit.path)?.[1] || 'jpeg').toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
  return { id: hit.id, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, bytes: buf.length };
}

export function createActions({ env = {}, log = () => {}, config = {} } = {}) {
  // 保留一个活引用：宿主后续会原地改这个对象的字段
  const liveEnv = env || {};
  setApiEnv({ root: liveEnv.ROOST_API_URL || '', token: liveEnv.ROOST_API_TOKEN || '' });
  const wrap = makeWrap(liveEnv);

  return {
    /** 列表：支持筛选与分页（页面自己做，这里给全量 + 统计） */
    list: wrap(async () => {
      const settings = store.loadSettings();
      const { images, errors, scannedAt } = store.listAnnotated(settings);
      const stats = {
        total: images.length,
        annotated: images.filter((i) => String(i.meaning || '').trim()).length,
        disabled: images.filter((i) => i.enabled === false).length,
        unannotated: images.filter((i) => !String(i.meaning || '').trim()).length,
      };
      return {
        settings,
        images: images.map((i) => ({
          id: i.id, file: i.file, name: i.name, meaning: i.meaning,
          tags: i.tags, scenes: i.scenes, avoid: i.avoid,
          enabled: i.enabled, origin: i.origin, sources: i.sources, size: i.size, missing: Boolean(i.missing),
        })),
        stats: { ...stats, missing: images.filter((i) => i.missing).length },
        errors, scannedAt,
        api: apiReady() ? 'ok' : apiWhy(),
        last: lastDecision(),
        library: builtin.libraryStatus(),
      };
    }),

    thumb: wrap(async (p) => thumbOf(p.id)),

    /** 保存一张图的标注（只写用户覆盖层） */
    save: wrap(async (p) => {
      const id = String(p.id || '');
      if (!id) throw new Error('缺 id');
      const patch = {
        name: String(p.name || '').slice(0, 40),
        meaning: String(p.meaning || '').slice(0, 300),
        tags: Array.isArray(p.tags) ? p.tags.map((t) => String(t).slice(0, 20)).slice(0, 12) : [],
        scenes: String(p.scenes || '').slice(0, 300),
        avoid: String(p.avoid || '').slice(0, 300),
        enabled: p.enabled !== false,
        editedAt: Date.now(),
      };
      const write = await store.mutateAnnotations((cur) => {
        cur.images[id] = { ...(cur.images[id] || {}), ...patch };
        return cur;
      });
      const library = await builtin.syncPublishedLibrary();
      return {
        id, saved: true, library,
        // 坏文件被重建时告诉页面：原件已备份到哪里
        corruptRebuilt: write.corruptRebuilt, backupPath: write.backupPath,
      };
    }),

    /** 设置：读或写（payload.patch） */
    settings: wrap(async (p) => {
      if (p && p.patch && typeof p.patch === 'object') {
        const next = store.saveSettings(p.patch);
        const library = await builtin.syncPublishedLibrary();
        return { settings: next, saved: true, library };
      }
      return { settings: store.loadSettings() };
    }),

    /** 重新扫描：清掉哈希缓存后重扫 */
    rescan: wrap(async () => {
      const settings = store.loadSettings();
      const { images, errors, scannedAt } = store.listAnnotated(settings);
      const library = await builtin.syncPublishedLibrary();
      return { count: images.length, errors, scannedAt, library };
    }),

    /** 用户自行在宿主页面开启并添加目录；这里只读配置。 */
    dependency: wrap(async () => builtin.checkBuiltinDependency()),

    exportLibrary: wrap(async () => builtin.exportLibrary()),

    /** 匹配测试：只判断不发送 */
    test: wrap(async (p) => {
      const message = String(p.message || '').trim();
      if (!message) throw new Error('先写一句测试消息');
      const history = Array.isArray(p.history) ? p.history : [];
      // 测试只验证判断能力，不要求已接入内置表情（否则没接入时无法调参）
      const out = await decide({ message, history, chatId: '', requireReady: false });
      let candidates = [];
      try {
        const settings = store.loadSettings();
        const { images } = store.listAnnotated(settings);
        const pool = images.filter((i) => i.enabled !== false && String(i.meaning || '').trim());
        const { pickCandidates } = await import(`./lib/judge.mjs?v=${V}`);
        candidates = pickCandidates(pool, message, { max: settings.maxCandidates })
          .map((c) => ({ id: c.id, name: c.name, meaning: c.meaning.slice(0, 60) }));
      } catch { /* 候选只是展示用 */ }
      return { result: out, candidates };
    }),
  };
}

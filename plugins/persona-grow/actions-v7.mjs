/**
 * 面板动作（inprocess）—— 版本 7。
 *
 * 只做三件事：接参数、调引擎、把结果翻译成人话。
 * 所有判定（预览不写、代际守卫、证据校验、只认活跃会话）都在 `lib/engine.mjs` 里，
 * 避免「页面一套、MCP 另一套」——之前 `analyzeAuto` 那次就是这么漏的。
 *
 * lib 一律带 `?v=<plugin.json 的 version>` 引入：宿主按 URL 缓存 ESM，
 * 版本号一变整组重载，不用每次换入口文件名。
 */

import { readFileSync } from 'node:fs';

const MANIFEST = JSON.parse(readFileSync(new URL('./plugin.json', import.meta.url), 'utf8'));
const V = String(MANIFEST.version || '0');

const { apiReady, apiWhy, setApiEnv } = await import(`./lib/api.mjs?v=${V}`);
const { listGroupsNamed } = await import(`./lib/analyze.mjs?v=${V}`);
const engine = await import(`./lib/engine.mjs?v=${V}`);

const wrap = (fn) => async (payload = {}) => {
  try {
    const data = await fn(payload || {});
    return { ok: data?.ok !== false, message: data?.message || '', data };
  } catch (e) {
    return { ok: false, message: String(e?.message ?? e), data: { ok: false } };
  }
};

export function createActions({ env = {}, log = () => {}, config = {} } = {}) {
  // 凭据写进 globalThis，页面动作与 MCP 的其它模块实例共用同一份
  setApiEnv({ root: env.ROOST_API_URL || '', token: env.ROOST_API_TOKEN || '' });

  return {
    list: wrap(async (payload) => ({ ok: true, groups: await listGroupsNamed({ force: payload?.refresh === true }) })),

    status: wrap(async (payload) => {
      const d = await engine.statusOf({ chatId: payload?.chatId || '' });
      return { ok: true, ...d, api: apiReady() ? 'ok' : apiWhy() };
    }),

    /** 预览：只跑分析，**不写状态、不切人格** */
    preview: wrap(async (payload) => {
      if (!apiReady()) throw new Error(`扩展与宿主的连接不可用：${apiWhy()}`);
      const r = await engine.growNow({ chatId: payload?.chatId || '', commit: false });
      return {
        ...r,
        message: r.skipped
          ? r.skipped
          : `预览：可新增 ${r.proposed} 条${r.dropped?.length ? `，丢弃 ${r.dropped.length} 条` : ''}（未写入）`,
      };
    }),

    grow: wrap(async (payload) => {
      if (!apiReady()) throw new Error(`扩展与宿主的连接不可用：${apiWhy()}`);
      const r = await engine.growNow({ chatId: payload?.chatId || '', commit: true });
      if (r.skipped) return { ...r, message: r.skipped };
      if (!r.added && !r.committed) return { ...r, message: r.note || '这次没有足够证据，未新增条目' };
      const extra = r.dropped?.length ? `（丢弃 ${r.dropped.length} 条不合格提议）` : '';
      return { ...r, message: `${r.added ? `新增 ${r.added} 条` : '无新增'}，已切到「${r.personaId}」${extra}` };
    }),

    restore: wrap(async (payload) => {
      const r = await engine.resetChat({ chatId: payload?.chatId || '' });
      return r.ok === false ? r : { ...r, message: `已清空并切回「${r.personaId}」` };
    }),
  };
}

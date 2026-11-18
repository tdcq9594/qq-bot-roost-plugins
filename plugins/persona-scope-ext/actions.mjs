/**
 * 面板动作（inprocess）。
 *
 * ## 返回协议：`{ok, message, data}` —— 少一层都不行
 *
 * 宿主转发给页面的业务内容**只取 `out.data`**（`host.js` 的
 * `data: out.data ?? null`）。动作直接返回 `{ok, cards, presets}` 时，页面拿到的
 * 是 `data: null` → 卡片永远显示 0 张，预览正文也丢掉。所以所有动作统一：
 *
 *     return { ok: true, message: '…', data: { …业务字段 } }
 *
 * ## 动作清单
 *
 * 宿主按 `plugin.json` 的 `ui.actions` 白名单校验，**没声明的动作一律 400
 * 「没有声明动作」**——动作函数存在不等于宿主允许调用。页面用到的每一个动作
 * 都必须在清单里。
 *
 * 与 MCP 服务端共用 `lib/ops.mjs`，判定只写一份。
 */

import { readFileSync } from 'node:fs';

const MANIFEST = JSON.parse(readFileSync(new URL('./plugin.json', import.meta.url), 'utf8'));
const V = String(MANIFEST.version || '0');

const ops = await import(`./lib/ops.mjs?v=${V}`);
const { apiReady, apiWhy, setApiEnv } = await import(`./lib/api.mjs?v=${V}`);

/**
 * 统一包一层：
 *  · 成功 → `{ok:true, message, data}`（data 是页面真正要的业务字段）
 *  · 失败 → `{ok:false, message}`，页面照原话显示
 */
const wrap = (fn) => async (payload) => {
  try {
    const r = await fn(payload || {});
    if (r && r.ok === false) return { ok: false, message: String(r.message || '动作失败') };
    const { ok, message, note, ...data } = r || {};
    return { ok: true, message: String(note || message || ''), data };
  } catch (e) {
    return { ok: false, message: String(e?.message ?? e) };
  }
};

export function createActions({ env = {}, log = () => {} } = {}) {
  /**
   * 传的是 env **引用**：宿主每次动作前原地更新它，轮换令牌后这里读到的就是新的。
   * 以前 `setApiEnv({root: env.X, token: env.Y})` 把值抠出来存，换发凭据后就一直用旧令牌。
   */
  setApiEnv(env);

  return {
    /** 一次拉全：本地卡片/预设 + 宿主人格库 + 现有绑定 */
    status: wrap(async (payload) => {
      // 每次动作都重新同步一次 env，防止宿主原地更新后我们还在看旧引用
      setApiEnv(env);
      const local = ops.listAll();
      if (!apiReady()) return { ok: true, ...local, hostError: `扩展与宿主的连接不可用：${apiWhy()}` };
      const host = await ops.statusOf({ senderId: payload.senderId || '' });
      /** 成长扩展是只读旁路：读失败也不能拖垮状态页 */
      let growth = { installed: false, chats: [] };
      try {
        growth = ops.growthInfo({ bySender: host.bySender, byChat: host.byChat, personas: host.personas });
      } catch (e) { growth = { installed: false, chats: [], error: String(e?.message ?? e) }; }
      let interop = { ok: false };
      try { interop = ops.interopStatus(); } catch (e) { interop = { ok: false, reason: String(e?.message ?? e) }; }
      /** 带 {{…}} 的人格会让整轮没有回复，必须主动报出来 */
      let broken = { ok: true, total: 0, broken: [] };
      try { broken = await ops.scanBrokenPersonas(); } catch { /* 读不到就跳过 */ }
      return {
        ok: true, ...local, ...host, api: 'ok', growth, interop,
        brokenPersonas: broken.broken,
        legacyBindings: ops.legacyBindings({ bySender: host.bySender || {} }),
      };
    }),

    saveCard: wrap(async (p) => { setApiEnv(env); return ops.saveCard(p); }),
    clearGrowth: wrap(async (p) => { setApiEnv(env); return ops.clearGrowthOf({ chatId: p.chatId }); }),
    enableInjection: wrap(async () => { setApiEnv(env); return ops.enableInjectionChannel(); }),
    removeCard: wrap(async (p) => { setApiEnv(env); return ops.removeCard(p); }),
    savePreset: wrap(async (p) => { setApiEnv(env); return ops.savePreset(p); }),
    removePreset: wrap(async (p) => { setApiEnv(env); return ops.removePreset(p); }),

    /** 预览：只拼装、不写宿主 */
    preview: wrap(async (p) => { setApiEnv(env); return ops.previewOf({ cardId: p.cardId, growthChatId: p.growthChatId || '', openid: p.openid || '', userLabel: p.userLabel || '' }); }),

    apply: wrap(async (p) => { setApiEnv(env); return ops.applyCard({ cardId: p.cardId, openid: p.openid, growthChatId: p.growthChatId || '', userLabel: p.userLabel || '' }); }),
    bind: wrap(async (p) => { setApiEnv(env); return ops.bind({ openid: p.openid, persona: p.persona }); }),
    unbind: wrap(async (p) => { setApiEnv(env); return ops.unbind({ openid: p.openid }); }),
    read: wrap(async (p) => { setApiEnv(env); return ops.readPersona({ id: p.id }); }),

    repairPersonas: wrap(async (p) => { setApiEnv(env); return ops.repairPersonas({ dryRun: p.dryRun === true }); }),

    /** 与 Roost 插件互通：导入 / 导出卡片与预设 */
    importPlugin: wrap(async (p) => { setApiEnv(env); return ops.importFromPlugin({ replace: p.replace === true }); }),
    exportPlugin: wrap(async () => { setApiEnv(env); return ops.exportToPlugin(); }),
  };
}

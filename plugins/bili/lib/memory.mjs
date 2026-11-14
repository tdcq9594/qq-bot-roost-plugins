/**
 * 往宿主记忆里记一笔（`/v1/memory/ext.add`）
 * ============================================================
 *
 * 扩展有自己的一份长期记忆（命名空间 `ext:<id>`），和主人聊天的记忆分开存。
 * 这里只用来记「我推过什么」——让 ta 下次不会把同一条视频再推一遍，
 * 也让她在聊天里能说「这个我之前给你看过」。
 *
 * **只记结果、不记素材**：刷到但没推出去的不记，否则一天二十条全是噪音，
 * 真到要回忆的时候反而找不到。
 *
 * 写不进去不报错：宿主可能没给 `memory:write` 这个 scope、可能没配记忆库，
 * 而这些都不该让「推送成功」变成失败。
 */

export function createExtMemory(env = process.env, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  const base = String(env?.ROOST_API_URL || '').replace(/\/+$/, '');
  const token = String(env?.ROOST_API_TOKEN || '');

  return {
    get available() { return Boolean(base && token); },

    /**
     * @param {string} fact 一句话事实（宿主会按 `ext:<id>` 归档）
     * @returns {Promise<{ok:boolean, why?:string}>}
     */
    async remember(fact) {
      const text = String(fact || '').trim();
      if (!text) return { ok: false, why: '空的' };
      if (!base || !token) return { ok: false, why: '没有 ROOST_API_URL / ROOST_API_TOKEN（手动跑扩展时正常）' };
      try {
        const r = await fetchImpl(`${base}/memory/ext.add`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ fact: text.slice(0, 300) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok || j?.ok === false) {
          /** 403 多半是没给 memory:write 的 scope，属于配置问题，不该刷日志 */
          return { ok: false, why: String(j?.message || `HTTP ${r.status}`).slice(0, 160) };
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, why: String(e?.message ?? e).slice(0, 160) };
      }
    },
  };
}

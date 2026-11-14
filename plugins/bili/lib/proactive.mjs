/**
 * 调宿主的「扩展主动消息素材通道」（0.4）
 * =======================================
 *
 * 扩展只交素材，**不指定会话、不写成品文案**：措辞由模型写，门闸、额度、
 * 审批、群授权全在宿主。这是 0.3 那条「只预热缓存」边界的正式替代。
 *
 * `ROOST_API_URL` 已经带 `/v1`（`feed.mjs` 探 `/state` 用的是同一个 base），
 * 所以这里是 `${base}/proactive/submit`，别再拼一遍前缀。
 */

export function createProactiveClient(env = process.env, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const base = String(env?.ROOST_API_URL || '').replace(/\/+$/, '');
  const token = String(env?.ROOST_API_TOKEN || '');

  return {
    get available() { return Boolean(base && token); },

    /**
     * @param {{cause:string,key:string,text:string,target?:string,approve?:boolean}} input
     * @returns {Promise<{ok:boolean,id?:string,delivery?:object,why?:string,retry?:boolean}>}
     */
    async submit(input = {}) {
      if (!base || !token) {
        return { ok: false, why: '没有 ROOST_API_URL / ROOST_API_TOKEN（手动跑扩展时正常）' };
      }
      try {
        const r = await fetchImpl(`${base}/proactive/submit`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            cause: String(input.cause || 'bili').slice(0, 40),
            key: String(input.key || '').slice(0, 120),
            text: String(input.text || '').slice(0, 2000),
            target: String(input.target || 'owner'),
            approve: Boolean(input.approve),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok || j?.ok === false) {
          return { ok: false, why: String(j?.message || `HTTP ${r.status}`).slice(0, 200) };
        }
        return {
          ok: true,
          id: String(j?.id || ''),
          delivery: j?.delivery ?? null,
          retry: Boolean(j?.retry),
        };
      } catch (e) {
        return { ok: false, why: String(e?.message ?? e).slice(0, 200) };
      }
    },
  };
}

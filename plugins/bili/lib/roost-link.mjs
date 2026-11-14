/**
 * 走 dsh-roost ⇄ roost 直连协议发消息 / 调框架插件工具
 * =====================================================
 *
 * 宿主把 `roost-host/1` 协议的可调用部分代理成 `/v1/roost.call`（见宿主
 * `ext-api-hooks.js`），扩展拿不到框架地址和令牌，只拿这一份受白名单约束的
 * 转发。这里就是扩展侧那个薄客户端。
 *
 * 为什么「测试分享」改走它：以前投的是 `/v1/proactive/submit`（素材通道），
 * 宿主会立刻 `drain()` → 开一次主动搭话模型 → 模型写措辞 → 再发。点一下
 * 要花一次模型调用，而且模型当时压根没看到视频素材（`awake.compose()` 重写
 * 了 prompt），结果常是 `<<skip>>`：钱花了、什么都没发出去、面板还报成功。
 *
 * 分享一张官方卡片不需要模型写字——标题/描述/链接/封面扩展早就拼好了。
 * 走 `msg.send` 直发，点一下就到主人私聊。
 */

const BASE_ENV = ['ROOST_API_URL', 'ROOST_API_TOKEN'];

export function createRoostLink(env = process.env, { fetchImpl = fetch, timeoutMs = 12_000 } = {}) {
  const base = String(env?.ROOST_API_URL || '').replace(/\/+$/, '');
  const token = String(env?.ROOST_API_TOKEN || '');

  return {
    get available() { return Boolean(base && token); },

    /**
     * 代转一次协议方法。
     * @returns {Promise<{ok:boolean, data?:any, why?:string}>}
     */
    async call(method, params = {}) {
      if (!base || !token) {
        return { ok: false, why: `宿主没注入 ${BASE_ENV.join(' / ')}（手动跑扩展时正常）` };
      }
      try {
        const r = await fetchImpl(`${base}/roost.call`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok || j?.ok === false) {
          return { ok: false, why: String(j?.message || `HTTP ${r.status}`).slice(0, 200) };
        }
        return { ok: true, data: j?.data ?? null };
      } catch (e) {
        return { ok: false, why: String(e?.message ?? e).slice(0, 200) };
      }
    },

    /** 列框架侧可调用的协议能力（含框架插件注册的 `tool.*`） */
    async capabilities() {
      if (!base || !token) return { ok: false, why: '没有 API 令牌' };
      try {
        const r = await fetchImpl(`${base}/roost.capabilities`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        const j = await r.json().catch(() => null);
        return r.ok && j?.ok ? { ok: true, data: j } : { ok: false, why: String(j?.message || `HTTP ${r.status}`) };
      } catch (e) {
        return { ok: false, why: String(e?.message ?? e).slice(0, 200) };
      }
    },

    /**
     * 把一张官方图文卡片直接发给主人，不跑模型。
     *
     * `target: 'owner'` 由宿主解析成主人 openid，扩展不该也不需要知道它。
     * 成功判据是框架真的回了 `msgId`（或 `pending` 审核中），不是「请求没报错」。
     */
    async sendCard(card, { text = '' } = {}) {
      const r = await this.call('msg.send', {
        target: 'owner',
        ...(text ? { content: String(text).slice(0, 200) } : {}),
        card,
      });
      if (!r.ok) return { ok: false, why: r.why };
      const d = r.data && typeof r.data === 'object' ? r.data : {};
      if (!d.msgId && !d.id && !d.pending) {
        return { ok: false, why: `框架没回消息 id：${JSON.stringify(d).slice(0, 120)}` };
      }
      return { ok: true, id: String(d.msgId || d.id || ''), pending: Boolean(d.pending) };
    },
  };
}

/**
 * 让她自己刷 B 站（独立会话）
 * ============================================================
 *
 * 定时刷是扩展的定时器在跑，那个时候**没有模型在场**——只能拉数据。
 * 之前只能把结果丢进待处理队列等她下次醒来，等于「刷到的东西要等下次聊天
 * 才可能被看见」。
 *
 * 这里补上真正的一环：**开一个独立会话专门做这件事**。
 *
 *   /v1/agent.new              建一个干净会话（不挂工具、不接主聊天）
 *   /v1/agent.prompt?wait=1    投一段材料，同步拿回她的输出
 *
 * 为什么不让她在那个会话里直接调 comment 工具：`agent.new` 建出来的会话
 * **只挂系统提示词片段，不挂工具**（见 `agent-v1.js` 的 `createOne`）。
 * 所以走「她输出结构化 JSON，这里照着执行」——和 aurabot 的 duty 循环
 * 同一个路子，好处是执行边界清楚：她只能通过这份 JSON 表达意图，
 * 真正动手的还是扩展，额度、试运行、风控一道都不少。
 *
 * 代价是每轮一次模型调用，所以配置项 `aiDecide` **默认关**，开了会明说。
 */

const SESSION_ID = 'bili';

/** 她在这个会话里的身份与输出格式 */
const SECTION = `你是「刷 B 站」的值班员。每次会收到一批刚刷到的视频材料（标题、UP、播放量、简介，可能还有字幕节选和热评）。

按顺序逐个看，对每一条想清楚三件事：

1. 你的感受——一句话，像发朋友圈那样，不要复述标题。
2. 要不要去评论区说句话。想说的话，写出真正要发出去的那一句（口语、短、不超过 40 字）；不想说就留空字符串。
3. 要不要分享给主人。想分享就写一句你会对主人说的话；不想就留空。

只输出一个 JSON 数组，每条一个对象，字段固定：

[{"bvid":"BV号","feeling":"…","comment":"…","share":"…","remember":"…"}]

规则：
- 不想评论 / 不想分享就写 ""，**不要**省略字段，也**不要**编造填充。
- \`remember\` 只写「以后还用得上的事」（比如主人的口味、你发现的规律），不是这条视频的内容摘要；没有就写 ""。
- 不要输出 JSON 以外的任何内容，不要用 markdown 代码块包起来。
- 拿不准的事宁可不做：评论和分享都是对外的，宁可少说一句。`;

/**
 * 与 `createProactiveClient` / `createExtMemory` 同一个形状：
 * 第一个参数是 env，第二个是可选实现（测试注入用）。
 *
 * @param {object} [env] 读 `ROOST_API_URL` / `ROOST_API_TOKEN`
 * @param {{fetchImpl?: Function, log?: Function, timeoutMs?: number}} [o]
 */
export function createBrowseSession(env = process.env, {
  fetchImpl = fetch, log = () => {}, timeoutMs = 90_000,
} = {}) {
  const base = String(env?.ROOST_API_URL || '').replace(/\/+$/, '');
  const token = String(env?.ROOST_API_TOKEN || '');
  let ready = false;
  /** 会话里已经说过的话会累积，太长会挤掉新材料的空间 —— 定期重建 */
  let turns = 0;

  const call = async (path, body, { method = 'POST', wait = false } = {}) => {
    const url = `${base}${path}${wait ? (path.includes('?') ? '&' : '?') + 'wait=1' : ''}`;
    const r = await fetchImpl(url, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || j?.ok === false) {
      const why = String(j?.message || `HTTP ${r.status}`).slice(0, 200);
      const err = new Error(why);
      err.status = r.status;
      throw err;
    }
    return j;
  };

  async function ensure() {
    if (ready) return true;
    try {
      await call('/agent.new', {
        clientId: 'bili',
        persist: false,
        sessionId: SESSION_ID,
        sections: [{ name: 'bili-duty', order: 880, text: SECTION }],
      });
      ready = true;
      turns = 0;
      log('刷 B 站的独立会话已建好');
      return true;
    } catch (e) {
      /** 会话已存在（上一轮建的还没关）也算成功 */
      if (/已存在|already/i.test(String(e?.message ?? ''))) {
        ready = true;
        return true;
      }
      throw e;
    }
  }

  return {
    get available() { return Boolean(base && token); },

    /**
     * 把一批视频交给她，拿回她的决定。
     *
     * @param {string} material 已经排好版的材料（标题/UP/播放/简介…）
     * @returns {Promise<{ok:boolean, items?:object[], why?:string}>}
     */
    async decide(material) {
      if (!base || !token) return { ok: false, why: '没有 ROOST_API_URL / ROOST_API_TOKEN（手动跑扩展时正常）' };
      try {
        await ensure();
        const j = await call('/agent.prompt', {
          sessionId: SESSION_ID,
          text: `这一轮刷到的视频：\n\n${String(material || '').slice(0, 6000)}`,
        }, { wait: true });
        turns += 1;
        /** 聊了太多轮就重建，别让历史把新材料挤出去 */
        if (turns >= 12) { ready = false; turns = 0; }
        return { ok: true, items: parseDecisions(j?.text) };
      } catch (e) {
        const status = Number(e?.status) || 0;
        /**
         * 403 多半是没给 `agent:write` 这个 scope。这不是「这轮失败了」，
         * 是「这个功能没被授权」——关掉开关，别每轮都撞一次。
         */
        if (status === 403 || /scope|forbidden|权限/i.test(String(e?.message ?? ''))) {
          ready = false;
          return { ok: false, why: `没拿到 agent:write 权限：${e?.message ?? e}` };
        }
        /** 会话可能被别处关掉了：下次重建 */
        ready = false;
        return { ok: false, why: String(e?.message ?? e).slice(0, 200) };
      }
    },

    /** 用完关掉（扩展退出前调用，避免留一个空会话） */
    async close() {
      if (!ready) return;
      ready = false;
      try {
        await call('/agent.close', { sessionId: SESSION_ID });
      } catch { /* 已经没了就算了 */ }
    },
  };
}

/**
 * 从她的回复里抠出 JSON 数组。
 *
 * 模型偶尔会包一层 ```json、或者在前面写一句「好的」——所以先找第一个
 * `[` 到最后一个 `]`，再解析。解不出来就是**什么都不做**，绝不能猜。
 */
export function parseDecisions(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({
      bvid: String(x.bvid ?? '').trim(),
      feeling: String(x.feeling ?? '').trim().slice(0, 120),
      comment: String(x.comment ?? '').trim().slice(0, 200),
      share: String(x.share ?? '').trim().slice(0, 300),
      remember: String(x.remember ?? '').trim().slice(0, 200),
    }))
    .filter((x) => /^BV[0-9A-Za-z]{10}$/.test(x.bvid) && (x.feeling || x.comment || x.share || x.remember))
    .slice(0, 10);
}

/** 给独立会话的材料：一行一条，够她判断，又不至于把上下文撑爆 */
export function materialOfVideos(items = []) {
  return (Array.isArray(items) ? items : []).slice(0, 8).map((v, i) => [
    `${i + 1}. 《${String(v?.title ?? '').slice(0, 70)}》`,
    `   ${v?.bvid ?? ''} · UP：${String(v?.author ?? '?').slice(0, 24)} · 播放 ${Number(v?.play) || 0}`,
    v?.tname ? `   分区：${String(v.tname).slice(0, 12)}` : '',
    v?.desc ? `   简介：${String(v.desc).slice(0, 160)}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

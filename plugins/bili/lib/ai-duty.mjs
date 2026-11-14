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
3. 要不要发一条弹幕。想发就写出那一句（口语、更短，不超过 20 字）；不想就留空。
4. 要不要分享给主人。想分享就写一句你会对主人说的话；不想就留空。

只输出**一个 JSON 对象**，两个字段：

{"items":[{"bvid":"BV号","feeling":"…","comment":"…","danmaku":"…","share":"…","remember":"…"}],"replies":[]}

- items：每条视频一个对象，就是上面那五个字段。
- replies：只在材料里出现「有人回了你」时才有内容，格式
  [{"id":"材料里给的那个 id","text":"你要回的那一句"}]。没有就写空数组。

规则：
- 不想评论 / 不想发弹幕 / 不想分享就写空字符串，**不要**省略字段，也**不要**编造填充。
- **没有模板可套**：这三个字段会原样发到 B 站，写什么就发什么。看过材料再写；没感觉就留空，没人要求你每条都说话。
- \`remember\` 只写「以后还用得上的事」（比如主人的口味、你发现的规律），不是这条视频的内容摘要；没有就写 ""。
- 不要输出 JSON 以外的任何内容，不要用 markdown 代码块包起来。
- 有人回了你的时候：只有对方说的是**真的在对你说**（问你、接你的话、夸你或骂你）才回；
  只是路过、复读、或者你没什么可说的就别回。回复同样是公开发出去的。
- 拿不准的事宁可不做：评论、弹幕、回复和分享都是对外的，宁可少说一句。`;

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
    async decide(material, { replies = [] } = {}) {
      if (!base || !token) return { ok: false, why: '没有 ROOST_API_URL / ROOST_API_TOKEN（手动跑扩展时正常）' };
      try {
        await ensure();
        /**
         * 回复清单单独一段：它和「这一轮刷到的视频」是两件事，
         * 混在一起模型会拿评论当视频材料去「感受」。
         */
        const list = Array.isArray(replies) ? replies.slice(0, 6) : [];
        const replyBlock = list.length
          ? `\n\n【有人回了你】\n${list.map((r, i) => (
            `${i + 1}. ${r.name || '有人'} 在《${String(r.title || '').slice(0, 40)}》下回你：「${String(r.text || '').slice(0, 120)}」  id=${r.id}`
          )).join('\n')}\n想回就写进 replies（id 用上面那个）；不想回就写空数组。`
          : '';
        const j = await call('/agent.prompt', {
          sessionId: SESSION_ID,
          text: `这一轮刷到的视频：\n\n${String(material || '').slice(0, 5600)}${replyBlock}`,
        }, { wait: true });
        turns += 1;
        /** 聊了太多轮就重建，别让历史把新材料挤出去 */
        if (turns >= 12) { ready = false; turns = 0; }
        const parsed = parsePayload(j?.text);
        return { ok: true, items: parsed.items, replies: parsed.replies };
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
 * 从她的回复里抠出 JSON。
 *
 * 期望是 `{ items: [...], replies: [...] }`，但模型有时还是给一个纯数组
 * （旧提示词的习惯），两种都认：
 *   · 对象 → 分别取 items / replies；
 *   · 数组 → 整个当 items。
 *
 * 解析失败一律返回空，**绝不猜**：她的每一句话都可能真的发到 B 站上。
 */
function extractJson(raw) {
  const s = String(raw ?? '');
  const oStart = s.indexOf('{');
  const aStart = s.indexOf('[');
  /**
   * 按**先出现的那个括号**判断形态。
   *
   * 不能「先试对象再试数组」：纯数组 `[{"bvid":…}]` 里也有 `{`，
   * 从第一个 `{` 切到最后一个 `}` 能解析成功，于是整段被当成一个对象，
   * `items` 取不到 —— 老格式（数组）会静默变成「这轮她什么都没想做」。
   */
  if (aStart >= 0 && (oStart < 0 || aStart < oStart)) {
    const aEnd = s.lastIndexOf(']');
    if (aEnd > aStart) {
      try { return JSON.parse(s.slice(aStart, aEnd + 1)); } catch { return null; }
    }
    return null;
  }
  if (oStart >= 0) {
    const oEnd = s.lastIndexOf('}');
    if (oEnd > oStart) {
      try { return JSON.parse(s.slice(oStart, oEnd + 1)); } catch { return null; }
    }
  }
  return null;
}

/** 视频决策：只认 BV 号合法、且至少表达了一件事的 */
function parseItems(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({
      bvid: String(x.bvid ?? '').trim(),
      feeling: String(x.feeling ?? '').trim().slice(0, 120),
      comment: String(x.comment ?? '').trim().slice(0, 200),
      danmaku: String(x.danmaku ?? '').trim().slice(0, 100),
      share: String(x.share ?? '').trim().slice(0, 300),
      remember: String(x.remember ?? '').trim().slice(0, 200),
    }))
    .filter((x) => /^BV[0-9A-Za-z]{10}$/.test(x.bvid) && (x.feeling || x.comment || x.danmaku || x.share || x.remember))
    .slice(0, 10);
}

/** 回复：id 必须是数字串，text 不能空 */
export function parseReplies(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({ id: String(x.id ?? '').trim(), text: String(x.text ?? '').trim().slice(0, 200) }))
    .filter((x) => /^\d{1,20}$/.test(x.id) && x.text)
    .slice(0, 5);
}

export function parsePayload(text) {
  const j = extractJson(text);
  if (Array.isArray(j)) return { items: parseItems(j), replies: [] };
  if (j && typeof j === 'object') {
    return { items: parseItems(j.items), replies: parseReplies(j.replies) };
  }
  return { items: [], replies: [] };
}

/** 只要视频决策时用这个（兼容老调用与测试） */
export function parseDecisions(text) {
  return parsePayload(text).items;
}

/**
 * 给独立会话的材料：一行一条，够她判断，又不至于把上下文撑爆。
 *
 * `descriptions` 是「看画面」拿到的描述（bvid → 文本）。有就多一行，
 * 没有就不写——绝不写「画面：无」，那会让她以为视频是黑屏。
 */
export function materialOfVideos(items = [], { descriptions = null } = {}) {
  const descOf = (bvid) => {
    try { return String(descriptions?.get?.(String(bvid ?? '')) ?? '').trim(); } catch { return ''; }
  };
  return (Array.isArray(items) ? items : []).slice(0, 8).map((v, i) => [
    `${i + 1}. 《${String(v?.title ?? '').slice(0, 70)}》`,
    `   ${v?.bvid ?? ''} · UP：${String(v?.author ?? '?').slice(0, 24)} · 播放 ${Number(v?.play) || 0}`,
    v?.tname ? `   分区：${String(v.tname).slice(0, 12)}` : '',
    v?.desc ? `   简介：${String(v.desc).slice(0, 160)}` : '',
    descOf(v?.bvid) ? `   画面：${descOf(v?.bvid).slice(0, 500)}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

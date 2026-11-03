/**
 * 通用宿主适配器：把消息推给一个 HTTP 端点，然后等它回话。
 *
 * `webhook` 和 `dsh` 两个适配器共用这份实现——它们的**传输方式一样**，
 * 区别只在默认地址和默认参数：
 *   · webhook：用户自己填地址，任何能收 HTTP 的服务都能接
 *   · dsh    ：地址默认指向 dsh-roost 插件，额外带一点 DSH 的偏好
 *
 * 为什么合并成一个文件而不是复制两份：协议只有一份（见
 * docs/AI宿主插件方案.md 第五节），复制两份以后改协议一定会漏一边。
 */

import { hostPayload } from '../inbound.js';

/** 拼接 URL，避免出现 `//inbound` 或漏斜杠 */
export function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = String(path || '').replace(/^\/+/, '');
  return p ? `${b}/${p}` : b;
}

/**
 * @param {object} p
 * @param {string} p.name 适配器名（webhook / dsh），报错信息里会用到
 * @param {string|(() => string)} p.url 宿主接收地址（传函数则每次现读，改配置立刻生效）
 * @param {string|(() => string)} [p.token] 共享密钥（宿主 `server.token`）；空表示宿主不校验
 * @param {object} p.bridge 回话通道（adapter/bridge.js）
 * @param {() => string} p.publicUrl 面板对外地址，用来拼回话 URL
 * @param {(s:string)=>void} [p.log]
 * @param {(msgs:object[])=>object[]} [p.trimHistory] 把 messages 剪成协议里的 history
 */
export function createHostAdapter({ name, url, token, bridge, publicUrl, log = () => {}, trimHistory = (m) => m }) {
  /** 字符串和取值函数都认——上层想让配置改动立刻生效就传函数 */
  const read = (v) => (typeof v === 'function' ? v() : v);

  return {
    name,

    /**
     * @param {object} p
     * @param {object[]} p.messages 完整对话（含 system），给需要上下文的宿主
     * @param {AbortSignal} [p.signal]
     * @param {object} [p.msg] 原始 Roost 消息（整形用）
     * @param {object} [p.chat] { kind, chatId }
     * @returns {Promise<{text:string, usage:null, model:string}>}
     */
    async chat({ messages = [], signal, msg, chat, sender, system, images, markdown, said, batch }) {
      const target = String(read(url) || '').trim();
      /**
       * 密钥只读一次存下来。
       *
       * 读两次（先判空再取值）在传的是取值函数时可能拿到两个不同的值——
       * 判空时为真、真正发出去时是空串，于是「明明配了密钥却是 401」。
       */
      const tokenValue = String(read(token) || '').trim();
      if (!target) {
        throw new Error(`还没填宿主的接收地址（面板 → 「${name} 地址」）`);
      }
      if (!msg) {
        // 理论上不会发生：index.js 每次都会把 msg 传进来。
        // 真发生了说明调用方漏传，早点炸比拿空消息去问宿主强。
        throw new Error('适配器缺少原始消息，无法整形');
      }

      /**
       * 四段耗时的时间点。宿主那边会把它们和「自己什么时候开始/结束」拼起来：
       *   recv  内核收到事件（框架打的时间戳）
       *   start 插件准备完、准备发请求
       * 剩下两段（生成、回发）宿主和 ai-chat 各自量。
       */
      const startedAt = Date.now();
      const evt = bridge.create({ signal });

      const payload = hostPayload(msg, {
        // 框架生成的链路 id，一路带到宿主，四段日志才能串起来
        trace: msg.traceId || '',
        id: evt.id,
        token: evt.token,
        replyUrl: joinUrl(publicUrl(), '/api/plugins/ai-chat/r/reply'),
        expiresAt: Date.now() + 180_000,
        history: trimHistory(messages),
        sender,
        system,
        images,
        /**
         * 通道能力。宿主据此决定「能不能发只在 markdown 里生效的东西」
         * （目前就是 @ 人的标签）。`undefined` 表示调用方没说 → 宿主按默认 true 处理。
         */
        channel: {
          markdown: markdown !== false,
          /**
           * 发文件通道打通了没有（`qq_send_file`）。
           *
           * **必须显式声明**：老版本 ai-chat 的 `/r/reply` 根本不读 `files`
           * 字段，收到也照回 200。宿主会以为发成功了、模型会跟人说「发你了」，
           * 然后什么都没有——比直接说「发不了」糟得多。
           * 所以宿主那边按 `=== true` 判，缺了就一律当不支持。
           *
           * 值取「框架真的有 `replyFile` 吗」而不是写死 `true`：
           * 框架版本不一致时如实说自己不会，别替它打保票。
           */
          files: typeof msg?.replyFile === 'function',
        },
        /**
         * 这一轮真正要交出去的正文。
         *
         * 合并窗口攒过的话，它是 `batch.text`（可能有好几行、每行带发言人），
         * 而不是 `msg.content`（只有最后那一句）。
         */
        said,
        batch,
        /**
         * 这一批对应的所有 eventId（场景片段，阶段 4）。
         *
         * 合并窗口攒过几句时是**多条**——一批消息合成一轮对话，
         * 记忆的出处也该是这一批，不是最后那一句。
         * `msg.eventId` 是框架入账时挂在消息上的，没开账本时就是空的。
         */
        eventIds: (batch?.items ?? []).map((x) => x?.msg?.eventId).filter(Boolean),
      });

      // 顺带把「这一轮是谁在跟谁说」也带上，宿主不用自己猜
      payload.chat.kind = chat?.kind ?? payload.chat.kind;
      payload.adapter = name;
      payload.t = { recv: Number(msg.receivedAt) || 0, start: startedAt };

      const res = await fetch(joinUrl(target, 'inbound'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          /**
           * 宿主的 `server.token` 配了就一定要带。
           *
           * 以前这里只发 content-type，而宿主在 token 非空时要求这个头——
           * 于是「设了密钥」等于「消息一条都推不进去」，两边都不报错，
           * 表现只是机器人突然不回话。
           */
          ...(tokenValue ? { 'x-roost-token': tokenValue } : {}),
        },
        body: JSON.stringify(payload),
        signal,
      }).catch((e) => {
        // 连不上是最常见的情况（宿主没开），把话说清楚
        throw new Error(`连不上宿主（${target}）：${e?.message ?? e}`);
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`宿主拒绝了这条消息（HTTP ${res.status}）${detail ? `：${detail.slice(0, 120)}` : ''}`);
      }

      const r = await evt.promise;
      /**
       * 这一轮要发的文件。**先取出来再判空**——因为「只发文件不说话」是
       * 正常行为（对方要文件，她直接给就行，不用再客套一句）。
       * 以前这里一刀切 `if (!text) throw`，那种用法会整轮报错、文件也没了。
       */
      const files = Array.isArray(r?.files) ? r.files.map(String).filter(Boolean) : [];
      const replyText = String(r?.text ?? '').trim();
      if (!replyText && !files.length) throw new Error('宿主回了空内容');
      log(`[${name}] 事件 ${evt.id.slice(0, 12)} 收到回话 ${replyText.length} 字${files.length ? ` + ${files.length} 个文件` : ''}`);
      return {
        text: replyText,
        /**
         * 多段回话的**原始分段**（宿主用 `done:false` 逐段发时才有）。
         *
         * 只有一段时给 `null`——让调用方走老路径（`planChunks` 切长文本），
         * 这样普通宿主和 QQ 的流式发送行为一个字都不会变。
         */
        parts:
          Array.isArray(r.parts) && r.parts.length > 1
            ? r.parts.map((p) => String(p ?? '').trim()).filter(Boolean)
            : null,
        /**
         * 和 `parts` **一一对应**的幂等键（阶段 5）。
         *
         * 注意它和上面那个 `parts` 的过滤**不同步**——`parts` 在这里过滤了空串，
         * `requestIds` 是原样带出来的。所以 index.js 那边要按**原始 parts 的索引**
         * 绑定，不能按过滤后的索引取，否则会整体错位。
         */
        requestIds: Array.isArray(r.requestIds) ? r.requestIds.map(String) : [],
        /** 要发出去的文件（绝对路径），由 index.js 在正文之后统一发 */
        files,
        usage: null,
        model: name,
      };
    },
  };
}

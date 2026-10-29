/**
 * 宿主回话通道。
 *
 * webhook / dsh 适配器都要做同一件事：把消息推给宿主，然后**等它回话**。
 * 「等」不能靠猜——得有一个挂起表 + 一次性令牌，否则任何知道地址的人
 * 都能往群里发消息。
 *
 * 流程：
 *   1. 插件推消息给宿主，带上 `id` 和一次性 `token`
 *   2. 宿主回 `POST /api/plugins/ai-chat/r/reply { id, token, text }`
 *   3. 这里校验 token、拼起来、resolve 掉那个 Promise
 *
 * 没有第 3 步的超时兜底，用户会看到一个永远「正在输入」的机器人。
 */

import { randomUUID } from 'node:crypto';

/** 默认等多久。宿主（尤其带工具调用的）可能想很久，给足 3 分钟 */
export const DEFAULT_TTL_MS = 180_000;

/** 单次事件最多收几段回话（`done:false` 分段用），防止宿主刷爆 */
const MAX_PARTS = 8;

export function createBridge({ log = () => {}, ttlMs = DEFAULT_TTL_MS } = {}) {
  /** @type {Map<string, object>} */
  const pending = new Map();

  /**
   * 登记一次「等回话」。
   *
   * @param {object} [opts]
   * @param {number} [opts.ttlMs] 这次等多久
   * @param {AbortSignal} [opts.signal] 用户 /停止 时直接放弃
   * @returns {{ id: string, token: string, promise: Promise<{text:string}> }}
   */
  function create({ ttlMs: ttl = ttlMs, signal } = {}) {
    const id = `evt_${randomUUID()}`;
    const token = randomUUID();

    /** 整个事件就这一个对象，挂起表里存的就是它本身（不能存副本，否则状态不同步） */
    const entry = {
      id,
      token,
      parts: [],
      /** 和 parts 一一对应的幂等键（阶段 5）。没有就空串 */
      requestIds: [],
      settled: false,
      timer: null,
      onAbort: null,
      settle: null,
    };

    entry.promise = new Promise((resolve, reject) => {
      entry.settle = { resolve, reject };
    });

    /**
     * 挂一个空 catch。
     *
     * 调用方不一定每一条都会 await（比如推给宿主的请求本身失败了，
     * 就再也不会去等回话）。没有这个空 catch 的话，超时/卸载时
     * 拒绝的 Promise 会变成 unhandled rejection，把进程带崩。
     * 原 Promise 仍然可以正常 await。
     */
    entry.promise.catch(() => {});

    const finish = (fn, arg) => {
      if (entry.settled) return;
      entry.settled = true;
      clearTimeout(entry.timer);
      if (entry.onAbort && signal) signal.removeEventListener('abort', entry.onAbort);
      pending.delete(id);
      fn(arg);
    };

    entry.timer = setTimeout(() => {
      // 已经收到半截的，就把半截交出去，比直接报错强
      if (entry.parts.length) {
        finish(entry.settle.resolve, {
          text: entry.parts.join('\n'),
          parts: entry.parts.slice(),
          requestIds: entry.requestIds.slice(),
        });
      } else {
        finish(entry.settle.reject, new Error(`宿主 ${Math.max(1, Math.round(ttl / 1000))} 秒没回话`));
      }
    }, ttl);
    entry.timer.unref?.();

    if (signal) {
      entry.onAbort = () => finish(entry.settle.reject, Object.assign(new Error('已停止'), { name: 'AbortError' }));
      if (signal.aborted) entry.onAbort();
      else signal.addEventListener('abort', entry.onAbort, { once: true });
    }

    pending.set(id, entry);
    return { id, token, promise: entry.promise };
  }

  /**
   * 宿主回话。返回给 HTTP 层的结果。
   *
   * @param {object} body `{ id, token, text, done, markdown }`
   * @returns {{ code: number, body: object }}
   */
  function handleReply(body = {}) {
    const id = String(body.id ?? '');
    const token = String(body.token ?? '');
    const text = String(body.text ?? '');

    const entry = pending.get(id);
    if (!entry) {
      // 最常见的原因：超时了（用户早就看到「出错了」），或者宿主重试
      return { code: 404, body: { ok: false, error: '没有这个待回话的事件（可能已超时）' } };
    }
    if (entry.token !== token) {
      return { code: 403, body: { ok: false, error: '回话令牌不对' } };
    }

    if (text) {
      if (entry.parts.length >= MAX_PARTS) {
        log(`事件 ${id.slice(0, 12)} 回话段数超限，丢弃后面的`);
      } else {
        entry.parts.push(text);
        /**
         * `requestIds` **必须和 `parts` 同步 push**。
         *
         * 后面 index.js 是按「第 i 段」去取「第 i 个幂等键」的，
         * 两边长度一旦不一致，索引就整体错位——把 A 段的 id 用到 B 段上，
         * 幂等语义变成「A 发过了所以 B 不发」，比不做幂等更糟。
         */
        entry.requestIds.push(String(body.requestId ?? '').slice(0, 120));
      }
    }

    // done !== false 才算说完；不传就当说完了（简单调用方不用管这个字段）
    const finished = body.done !== false;
    if (finished) {
      entry.settled = true;
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.settle.resolve({
        text: entry.parts.join('\n'),
        /**
         * **原始分段也要交出去**。
         *
         * `text` 是拼好的全文，够简单调用方用；但「模型决定分几条说」
         * 这件事只有分段本身能表达——拼完再交给 `planChunks`，
         * 而它只在超过 1800 字时才切，短的两段会被合成一条，
         * 模型对条数的控制就白费了。所以这里原样带一份。
         */
        parts: entry.parts.slice(),
        /** 和 parts 一一对应；空串表示这一段没有幂等键 */
        requestIds: entry.requestIds.slice(),
        markdown: Boolean(body.markdown),
      });
    }

    return { code: 200, body: { ok: true, parts: entry.parts.length } };
  }

  return {
    create,
    handleReply,
    get size() {
      return pending.size;
    },
    /** 插件卸载时清干净，别把定时器留在后台 */
    dispose() {
      for (const [, e] of pending) {
        clearTimeout(e.timer);
        if (!e.settled) {
          e.settled = true;
          e.settle.reject(Object.assign(new Error('插件已卸载'), { name: 'AbortError' }));
        }
      }
      pending.clear();
    },
  };
}

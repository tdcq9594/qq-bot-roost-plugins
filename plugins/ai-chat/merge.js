/**
 * 消息合并：把连着发的几句话攒成一段再回。
 *
 * 为什么需要：真人不会在你打字打到一半时插话。不合并的话，
 * 对方「在吗」→「问你个事」→「那个报错怎么办」会被回三次，
 * 或者更糟：第一条还在想，后两条被 busy 锁直接丢掉。
 *
 * 两个参数：
 *   waitSec —— 停多久算说完（每来一条重新计时）
 *   maxSec  —— 最多等多久（从第一条算，对方一直发也不会无限等）
 *
 * 只把**第一条**的等待者放行去回答，其余直接返回 null——
 * 否则三条消息会各自触发一轮模型调用，等于没合并。
 */

export function createMerger({ waitSec = 1.5, maxSec = 6, now = () => Date.now() } = {}) {
  /** chatId -> { items, waitTimer, maxTimer, waiters } */
  const pending = new Map();

  function flush(chatId) {
    const b = pending.get(chatId);
    if (!b) return;
    pending.delete(chatId);
    clearTimeout(b.waitTimer);
    clearTimeout(b.maxTimer);

    const items = b.items.slice();
    if (!items.length) return;

    // 多人发言时标上是谁说的，否则模型分不清谁在问
    const text =
      items.length === 1
        ? items[0].text
        : items
            .map((it) => (it.name ? `${it.name}：${it.text}` : it.text))
            .join('\n');

    const batch = {
      text,
      count: items.length,
      /** 回复挂到最后一条上：它的 msg_id 最新，被动回复窗口最稳 */
      msg: items[items.length - 1].msg,
      senders: [...new Set(items.map((it) => it.name).filter(Boolean))],
    };

    // 只放行第一个，其余的告诉调用方「这次不归你」
    b.waiters.forEach((w, i) => {
      try {
        w(i === 0 ? batch : null);
      } catch {}
    });
  }

  return {
    /**
     * 把一条消息放进合并窗口。
     *
     * @param {object} p
     * @param {string} p.chatId
     * @param {object} p.msg
     * @param {string} p.text
     * @param {string} [p.name] 发言人
     * @param {boolean} [p.force] 被 @ 时不等待，立刻回
     * @returns {Promise<object|null>} 轮到你就拿到 batch，否则 null
     */
    add({ chatId, msg, text, name = '', force = false }) {
      if (force) {
        return Promise.resolve({ text, count: 1, msg, senders: name ? [name] : [] });
      }

      let b = pending.get(chatId);
      if (!b) {
        b = { items: [], waiters: [], waitTimer: null, maxTimer: null, firstAt: now() };
        pending.set(chatId, b);
      }

      b.items.push({ msg, text, name, at: now() });

      const p = new Promise((resolve) => b.waiters.push(resolve));

      // 每来一条重新计时：说到一半就别急着回
      clearTimeout(b.waitTimer);
      b.waitTimer = setTimeout(() => flush(chatId), waitSec * 1000);
      b.waitTimer.unref?.();

      // 从第一条算的最长等待，只设一次
      if (!b.maxTimer) {
        const left = Math.max(0, maxSec * 1000 - (now() - b.firstAt));
        b.maxTimer = setTimeout(() => flush(chatId), left);
        b.maxTimer.unref?.();
      }

      return p;
    },

    /** 立刻把某个会话攒着的发出去 */
    flush(chatId) {
      flush(chatId);
    },

    /** 全部放出去（插件卸载时用，别让等着的 handler 永远挂着） */
    flushAll() {
      for (const id of [...pending.keys()]) flush(id);
    },

    /** 正在攒的会话数，面板/测试用 */
    get size() {
      return pending.size;
    },
  };
}

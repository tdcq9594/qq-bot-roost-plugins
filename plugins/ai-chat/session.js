/**
 * 会话存储：每个 chatId 一份上下文。
 *
 * 为什么不放 ctx.storage：对话历史是**易失**的（闲置就回收），
 * 存盘既没必要也拖慢每轮。真正要留的（人设、记忆）在 profile.js 里走 storage。
 */

export class ChatStore {
  constructor({ historyLimit = 10, idleMs = 30 * 60_000 } = {}) {
    /** @type {Map<string, {messages:object[], lastAt:number, busy:boolean, controller:AbortController|null, rounds:number}>} */
    this.map = new Map();
    this.historyLimit = historyLimit;
    this.idleMs = idleMs;
  }

  get(chatId) {
    let s = this.map.get(chatId);
    if (!s) {
      s = { messages: [], lastAt: Date.now(), busy: false, controller: null, rounds: 0 };
      this.map.set(chatId, s);
    }
    s.lastAt = Date.now();
    return s;
  }

  reset(chatId) {
    this.map.delete(chatId);
  }

  /**
   * 裁上下文：保留 system + 最近 N 轮。
   *
   * 按「条数」而不是「token 数」裁是有意的——数 token 要引依赖或写估算器，
   * 而 10 轮对绝大多数模型都安全。
   */
  trim(s) {
    const keep = Math.max(2, this.historyLimit * 2);
    if (s.messages.length <= keep + 1) return;
    const hasSystem = s.messages[0]?.role === 'system';
    const sys = hasSystem ? [s.messages[0]] : [];
    const rest = hasSystem ? s.messages.slice(1) : s.messages;
    s.messages = [...sys, ...rest.slice(-keep)];
  }

  /** 回收闲置会话（正在生成的不动） */
  evictIdle(now = Date.now()) {
    let n = 0;
    for (const [id, s] of this.map) {
      if (s.busy) continue;
      if (now - s.lastAt > this.idleMs) {
        this.map.delete(id);
        n += 1;
      }
    }
    return n;
  }
}

/**
 * 每个会话的「说话节奏」状态：冷却、配额、忙碌锁。
 *
 * 跟 ChatStore 分开是因为职责不同：那个管上下文（要裁剪、要回收），
 * 这个管「别太吵」（要时间戳、要计数）。
 */
export class PaceStore {
  constructor({ cooldownSec = 20, maxRepliesPerMin = 3 } = {}) {
    /** @type {Map<string, {lastReplyAt:number, replyTimes:number[], busy:boolean, controller:AbortController|null}>} */
    this.map = new Map();
    this.cooldownSec = cooldownSec;
    this.maxRepliesPerMin = maxRepliesPerMin;
  }

  get(chatId) {
    let s = this.map.get(chatId);
    if (!s) {
      s = { lastReplyAt: 0, replyTimes: [], busy: false, controller: null };
      this.map.set(chatId, s);
    }
    return s;
  }

  /** 记一次「真的回了」 */
  markReply(chatId, now = Date.now()) {
    const s = this.get(chatId);
    s.lastReplyAt = now;
    s.replyTimes = [...(s.replyTimes ?? []).filter((t) => now - t < 60_000), now];
  }

  /** 清掉过期计数，别让 Map 无限长 */
  sweep(now = Date.now()) {
    for (const [id, s] of this.map) {
      s.replyTimes = (s.replyTimes ?? []).filter((t) => now - t < 60_000);
      if (!s.busy && !s.replyTimes.length && now - s.lastReplyAt > 10 * 60_000) this.map.delete(id);
    }
  }
}

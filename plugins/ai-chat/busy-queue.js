/**
 * 忙态攒着的消息。
 *
 * 一轮模型跑到一半、又来新消息时，原来的做法是等最多 30 秒；真等不到就
 * `busyDropped` 丢掉——那几句话从此没人理。这里只做一个「攒着」的容器：
 * 等不到就把消息放进来，等 busy 释放（finally）时一次取空、串行重入。
 *
 * 单独成文件是为了能测：这块不抛异常，只会在超时那一刻悄悄丢消息。
 */
export function createBusyQueue() {
  let items = [];
  return {
    /** @returns {number} 攒了几条 */
    push(item) {
      items.push(item);
      return items.length;
    },
    /** 取空并返回；调用方负责串行重入，避免几条同时抢 busy 锁 */
    drain() {
      const out = items;
      items = [];
      return out;
    },
    get size() {
      return items.length;
    },
  };
}

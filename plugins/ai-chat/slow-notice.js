/**
 * 慢回复先回一句（E5）
 * ====================
 *
 * 模型 / 慢工具跑得久时，QQ 那边一个字都没有，用户会以为她掉线了；
 * 被动回复窗口还在走（群 5min / 私 60min），拖太久结果就只能走主动消息。
 *
 * 做法：调模型前起一个计时器，超过 `sec` 秒还没回就先 `msg.replyNow()`
 * 发一句「我看看，稍等一下」；模型回来后立刻取消。`replyNow` 是框架的
 * 立即发送（绕过合并窗口、不占主动额度），所以这一句不会挤掉最终回复。
 *
 * 抽成纯函数是为了能直接测「0 关掉 / 到点发 / 取消后不发」，
 * 不用把 adapter 也假一遍。
 */

/**
 * @param {{replyNow?:(text:string)=>any, sec?:number, text?:string,
 *          timer?:Function, clear?:Function}} opts
 *        `timer/clear` 可注入，测试用假时钟
 * @returns {{cancel:()=>void}}
 */
export function startSlowNotice({
  replyNow,
  sec,
  text = '我看看，稍等一下',
  timer = setTimeout,
  clear = clearTimeout,
} = {}) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0 || typeof replyNow !== 'function') {
    return { cancel() {} };
  }
  let fired = false;
  const handle = timer(() => {
    fired = true;
    try {
      const r = replyNow(text);
      /** 发送失败静默：预告只是锦上添花，不能把这一轮带崩 */
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* 同上 */ }
  }, n * 1000);
  return {
    cancel() {
      if (!fired) clear(handle);
    },
  };
}

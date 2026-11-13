/**
 * 一个「能说人话」的错误
 * ======================
 *
 * 生图失败的原因分两种：
 *   · 主人能修的（地址没填、密钥过期、接口不认这个尺寸）——要给出去哪儿改；
 *   · 修不了的（对方接口 500、网络断了）——要说清是**哪一步**断的。
 *
 * 模型看到的只有工具结果。抛一个带栈的 Error，它只会照抄半句英文给用户；
 * 所以这里强制每个错误都带上 `hint`（怎么修 / 下一步做什么）。
 */
export class PaintError extends Error {
  /**
   * @param {string} message 给模型看的一句话（中文、说清发生了什么）
   * @param {{hint?:string, status?:number, cause?:unknown}} [opts]
   *        `status` 是上游 HTTP 状态码，0 表示没走到 HTTP（配置/参数问题）
   */
  constructor(message, { hint = '', status = 0, cause } = {}) {
    super(message);
    this.name = 'PaintError';
    this.hint = String(hint || '');
    this.status = Number(status) || 0;
    if (cause !== undefined) this.cause = cause;
  }
}

/** 工具结果里那条错误文案：`原因（怎么修）`，和 bili 扩展保持同一个形状。 */
export function textOf(e) {
  if (e instanceof PaintError) return `${e.message}${e.hint ? `（${e.hint}）` : ''}`;
  return `扩展出错了：${e?.message ?? e}`;
}

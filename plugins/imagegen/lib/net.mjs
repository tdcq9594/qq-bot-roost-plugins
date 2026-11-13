/**
 * 取图：把「一个地址」变成 Buffer
 * ==============================
 *
 * 生图接口有两种交付方式：base64 塞在 JSON 里，或者给一个 CDN 链接让你自己下。
 * 后者常见的坑是**慢**：实测有服务出图后 20 秒才把文件准备好，默认超时
 * 直接把「已经画好、正在传」判成失败，用户看到「接口没返回图片」，
 * 白等一次还白花一次钱。所以这里的超时是 120 秒，并且单独限字节数（20MB）。
 *
 * **不拦内网地址**：本地 ComfyUI / SD WebUI 的 OpenAI 代理就长在
 * 127.0.0.1 上，那是正常用法。这里只保证「协议是 http(s)、别把内存吃爆」。
 */

const MAX_BYTES = 20 * 1024 * 1024;

/**
 * 按文件头判图片类型。
 *
 * 不用扩展名、也不信 `content-type`：CDN 常把 png 标成
 * `application/octet-stream`，而某些错误页会标成 `image/png`。
 * 只有魔数（文件头）是图片自己说了算的那部分。
 */
export function sniffMime(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return '';
}

/** `data:image/png;base64,…` → Buffer；不是这种形式返回 null。 */
export function decodeDataUrl(v) {
  const m = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(String(v ?? '').trim());
  if (!m) return null;
  try {
    return Buffer.from(m[1], 'base64');
  } catch {
    return null;
  }
}

/**
 * 下载一张图。
 *
 * @param {string} url
 * @param {{maxBytes?:number, timeoutMs?:number, fetchImpl?:Function}} [opts]
 * @returns {Promise<Buffer>}
 */
export async function fetchImage(url, { maxBytes = MAX_BYTES, timeoutMs = 120_000, fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  const href = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(href)) throw new Error(`不是能下载的图片地址：${href.slice(0, 80)}`);

  const r = await doFetch(href, {
    method: 'GET',
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`下载图片失败：HTTP ${r.status}`);

  /**
   * 先看 `content-length`，能在读之前就拒掉大文件；
   * 没有这个头（分块传输）就边读边数，超了立刻放弃 —— 别等下完再判。
   */
  const declared = Number(r.headers?.get?.('content-length')) || 0;
  if (declared > maxBytes) throw new Error(`图片太大：${Math.round(declared / 1024 / 1024)}MB（上限 ${Math.round(maxBytes / 1024 / 1024)}MB）`);

  if (!r.body || typeof r.arrayBuffer !== 'function') {
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`图片太大（上限 ${Math.round(maxBytes / 1024 / 1024)}MB）`);
    return buf;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of r.body) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`图片太大（上限 ${Math.round(maxBytes / 1024 / 1024)}MB）`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

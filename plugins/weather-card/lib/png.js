/**
 * 极简 PNG 解码 / 编码（只做渲染管线需要的那一小块）
 *
 * 为什么要自己写：卡片是**一次高窗口截图**再裁掉底部背景，
 * 这样只需要启动一次浏览器（两次冷启动约 2~4 秒，减半）。
 * 而裁图必须有「解像素 → 重编码」，引第三方库就把「零依赖」这条打破了。
 *
 * 支持范围（够用就停）：
 *   · 解码 8 位、colorType 2(RGB) / 6(RGBA)、非隔行 —— Chromium 截图就是这两种之一。
 *   · 编码 8 位 RGB / RGBA，只用 filter 0（None）。压不压缩无所谓，卡本来就不大。
 * 遇到不支持的类型直接抛错，调用方回退到「两次启动」的老路，不会静默出错图。
 */
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* ── CRC32（PNG 每个 chunk 都要）────────────────────────────── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ── 解码 ───────────────────────────────────────────────────── */

/**
 * @returns {{width:number, height:number, channels:number, data:Buffer}}
 *   data 是紧密排列的像素（channels = 3 或 4）
 */
export function decodePng(buf) {
  if (!buf || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('不是 PNG');

  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }

  if (bitDepth !== 8) throw new Error(`不支持的位深 ${bitDepth}`);
  if (colorType !== 2 && colorType !== 6) throw new Error(`不支持的颜色类型 ${colorType}`);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');
  if (!width || !height) throw new Error('PNG 缺 IHDR');

  channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('PNG 数据不完整');

  const out = Buffer.allocUnsafe(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.from(line); // 复制，别改到 inflate 的原始 buffer
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = cur[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`不支持的 filter ${filter}`);
      cur[x] = v & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, channels, data: out };
}

/* ── 编码 ───────────────────────────────────────────────────── */

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, body])), 0);
  return Buffer.concat([len, t, body, crc]);
}

/**
 * @param {{width:number,height:number,channels:number,data:Buffer}} img
 */
export function encodePng({ width, height, channels, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;                        // bit depth
  ihdr[9] = channels === 4 ? 6 : 2;   // color type
  ihdr[10] = 0;                       // compression
  ihdr[11] = 0;                       // filter method
  ihdr[12] = 0;                       // interlace

  const stride = width * channels;
  // 每行前面补一个 filter 字节 0
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── 裁掉底部纯背景 ─────────────────────────────────────────── */

/** '#0e1014' → [14,16,20]。认不出来返回 null（调用方就不裁）。 */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * 从底部裁掉与背景色相同的整行。
 *
 * 卡片底部以下的区域就是 pageBg 纯色（body 背景），所以「从下往上数第一行
 * 存在非背景像素」就是内容底边。左右两侧同理但不是整行纯色，不用管。
 *
 * @param {Buffer} png
 * @param {string} bgHex 背景色
 * @param {{tolerance?:number, margin?:number, minHeight?:number}} opt
 * @returns {Buffer} 裁剪后的 PNG
 */
export function cropBottom(png, bgHex, { tolerance = 4, margin = 2, minHeight = 40 } = {}) {
  const bg = hexToRgb(bgHex);
  if (!bg) return png;
  const img = decodePng(png);
  const { width, height, channels, data } = img;
  const stride = width * channels;

  // 只看几列就够（横向抽样）：整行都是背景才裁，抽样不会误判
  const cols = [];
  for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 12))) cols.push(x);

  const isBgRow = (y) => cols.every((x) => {
    const i = y * stride + x * channels;
    return Math.abs(data[i] - bg[0]) <= tolerance
      && Math.abs(data[i + 1] - bg[1]) <= tolerance
      && Math.abs(data[i + 2] - bg[2]) <= tolerance;
  });

  let bottom = height;
  while (bottom > minHeight && isBgRow(bottom - 1)) bottom -= 1;
  // 留一点余量，免得卡片圆角被切出锯齿
  bottom = Math.min(height, bottom + margin);
  if (bottom >= height) return png; // 没有可裁的

  const cut = data.subarray(0, bottom * stride);
  return encodePng({ width, height: bottom, channels, data: cut });
}

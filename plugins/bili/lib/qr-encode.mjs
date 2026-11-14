/**
 * 零依赖二维码编码器（Byte 模式，版本 1–10，四档纠错）
 * ============================================================
 *
 * 为什么自己写：B 站扫码走的是官方接口
 * （`/x/passport-login/web/qrcode/generate` 返回一个 131 字节的 URL），
 * 需要在本地把这段 URL 画成二维码。框架的硬约束是**零依赖**——
 * 装一个 `qrcode` 包就等于给每个装扩展的人多一份供应链风险。
 *
 * 只实现 Byte 模式是刻意的：二维码登录永远是 URL，不需要数字/字母数字
 * 模式的压缩收益；少一套模式选择就少一类边界。
 *
 * 输出是**位矩阵**，绘制交给调用方（SVG 或 PNG 都行）。这样这份代码
 * 只有编码逻辑，没有渲染耦合，也方便拿真实实现逐位对照测试。
 *
 * 参考：ISO/IEC 18004。各处标注了「规范第 X 节」，方便对照。
 */

import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** 纠错级别 → 格式信息里的两位（规范表 12） */
const EC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

/**
 * RS 分块表（规范表 9）：`[每块纠错码字数, [[块数, 每块数据码字数], ...]]`。
 * 只有版本 1–10：URL 最长也就两百来字节，再大的版本既没必要，
 * 抄错的概率还高（41×41 到 57×57 已经足够 131 字节）。
 */
const RS_BLOCKS = {
  1: { L: [7, [[1, 19]]], M: [10, [[1, 16]]], Q: [13, [[1, 13]]], H: [17, [[1, 9]]] },
  2: { L: [10, [[1, 34]]], M: [16, [[1, 28]]], Q: [22, [[1, 22]]], H: [28, [[1, 16]]] },
  3: { L: [15, [[1, 55]]], M: [26, [[1, 44]]], Q: [18, [[2, 17]]], H: [22, [[2, 13]]] },
  4: { L: [20, [[1, 80]]], M: [18, [[2, 32]]], Q: [26, [[2, 24]]], H: [16, [[4, 9]]] },
  5: { L: [26, [[1, 108]]], M: [24, [[2, 43]]], Q: [18, [[2, 15], [2, 16]]], H: [22, [[2, 11], [2, 12]]] },
  6: { L: [18, [[2, 68]]], M: [16, [[4, 27]]], Q: [24, [[4, 19]]], H: [28, [[4, 15]]] },
  7: { L: [20, [[2, 78]]], M: [18, [[4, 31]]], Q: [18, [[2, 14], [4, 15]]], H: [26, [[4, 13], [1, 14]]] },
  8: { L: [24, [[2, 97]]], M: [22, [[2, 38], [2, 39]]], Q: [22, [[4, 18], [2, 19]]], H: [26, [[4, 14], [2, 15]]] },
  9: { L: [30, [[2, 116]]], M: [22, [[3, 36], [2, 37]]], Q: [20, [[4, 16], [4, 17]]], H: [24, [[4, 12], [4, 13]]] },
  10: { L: [18, [[2, 68], [2, 69]]], M: [26, [[4, 43], [1, 44]]], Q: [24, [[6, 19], [2, 20]]], H: [28, [[6, 15], [2, 16]]] },
};

/** 对齐图案中心坐标（规范附录 E）；版本 1 没有 */
const ALIGN = {
  1: [],
  2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/* ------------------------------------------------------------------ */
/* GF(256)：二维码的 RS 纠错在 GF(2^8) 上做，本原多项式 0x11D        */
/* ------------------------------------------------------------------ */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

/** 生成多项式 g(x) = (x-α^0)(x-α^1)…(x-α^(n-1))，系数从高到低 */
function rsGenerator(n) {
  let poly = [1];
  for (let i = 0; i < n; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** 对一块数据算纠错码字（多项式长除法取余） */
function rsEncode(data, ecCount) {
  const gen = rsGenerator(ecCount);
  const res = new Array(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecCount; i += 1) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

/* ------------------------------------------------------------------ */
/* 数据编码                                                            */
/* ------------------------------------------------------------------ */

/** 模式指示符：Byte = 0100（规范表 2） */
const MODE_BYTE = 0b0100;

/** 字符计数字段位数：版本 1–9 是 8 位，10–26 是 16 位 */
const countBits = (version) => (version <= 9 ? 8 : 16);

/** 某版本某级别的数据容量（字节） */
function dataCapacity(version, ec) {
  const [, groups] = RS_BLOCKS[version][ec];
  return groups.reduce((sum, [count, words]) => sum + count * words, 0);
}

/** 选最小的、装得下 `byteLen` 的版本 */
function pickVersion(byteLen, ec) {
  for (let v = 1; v <= 10; v += 1) {
    /** 模式 4 位 + 计数位 + 数据位，要能塞进容量 */
    const need = 4 + countBits(v) + byteLen * 8;
    if (need <= dataCapacity(v, ec) * 8) return v;
  }
  throw new Error(`内容太长（${byteLen} 字节），这个编码器只到版本 10`);
}

/** 把字节串按规范编码成最终码字序列（含纠错与交织） */
function buildCodewords(bytes, version, ec) {
  const cap = dataCapacity(version, ec);
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((val >> i) & 1);
  };

  push(MODE_BYTE, 4);
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);

  /** 终止符最多 4 位，然后补到字节边界（规范 8.4.9） */
  const capBits = cap * 8;
  const term = Math.min(4, capBits - bits.length);
  for (let i = 0; i < term; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j += 1) v = (v << 1) | bits[i + j];
    data.push(v);
  }
  /** 剩下的用 0xEC / 0x11 交替填满（规范 8.4.9） */
  const PAD = [0xec, 0x11];
  let k = 0;
  while (data.length < cap) {
    data.push(PAD[k % 2]);
    k += 1;
  }

  const [ecPerBlock, groups] = RS_BLOCKS[version][ec];
  const dataBlocks = [];
  const ecBlocks = [];
  let pos = 0;
  for (const [count, words] of groups) {
    for (let i = 0; i < count; i += 1) {
      const block = data.slice(pos, pos + words);
      pos += words;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, ecPerBlock));
    }
  }

  /** 交织（规范 8.6）：先按列取数据，再按列取纠错 */
  const out = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const b of ecBlocks) out.push(b[i]);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 矩阵布局                                                            */
/* ------------------------------------------------------------------ */

function newMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(false));
}

/** 画定位图案（三个角）与分隔符 */
function placeFinder(m, fn, size) {
  const corners = [[0, 0], [size - 7, 0], [0, size - 7]];
  for (const [r0, c0] of corners) {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
          && (dr === 0 || dr === 6 || dc === 0 || dc === 6);
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        m[r][c] = inRing || inCore;
        fn[r][c] = true;
      }
    }
  }
}

/** 时序图案（第 6 行 / 第 6 列，黑白交替） */
function placeTiming(m, fn, size) {
  for (let i = 8; i < size - 8; i += 1) {
    const on = i % 2 === 0;
    if (!fn[6][i]) { m[6][i] = on; fn[6][i] = true; }
    if (!fn[i][6]) { m[i][6] = on; fn[i][6] = true; }
  }
}

/** 对齐图案（5×5，中心在给定坐标） */
function placeAlign(m, fn, version, size) {
  const centers = ALIGN[version] || [];
  for (const r of centers) {
    for (const c of centers) {
      /** 与三个定位图案重叠的位置不画（规范说这些位置跳过） */
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          m[r + dr][c + dc] = on;
          fn[r + dr][c + dc] = true;
        }
      }
    }
  }
}

/** 预留格式信息区域（真正的值等掩码后再填） */
function reserveFormat(fn, size) {
  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) fn[8][i] = true;
    fn[i][8] = true;
  }
  for (let i = 0; i < 8; i += 1) {
    fn[8][size - 1 - i] = true;
    fn[size - 1 - i][8] = true;
  }
  /** 固定的暗模块（规范 8.9） */
  fn[size - 8][8] = true;
}

/** 版本信息区域（版本 7 起才有）；这里最大到 10，所以只预留 */
function reserveVersion(fn, version, size) {
  if (version < 7) return;
  for (let i = 0; i < 6; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      fn[size - 11 + j][i] = true;
      fn[i][size - 11 + j] = true;
    }
  }
}

/** 按之字形把码字填进矩阵（规范 8.7.3） */
function placeData(m, fn, codewords, size) {
  let bitIndex = 0;
  const total = codewords.length * 8;
  const bitAt = (i) => {
    if (i >= total) return 0;
    const byte = codewords[i >> 3];
    return (byte >> (7 - (i & 7))) & 1;
  };

  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    /** 第 6 列是时序图案，整列跳过（规范要求两列一组往左退时避开） */
    if (col === 6) col = 5;
    for (let n = 0; n < size; n += 1) {
      const row = upward ? size - 1 - n : n;
      for (let k = 0; k < 2; k += 1) {
        const c = col - k;
        if (fn[row][c]) continue;
        m[row][c] = bitAt(bitIndex) === 1;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

/** 掩码条件（规范表 10） */
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** 掩码罚分（规范表 11 的四条规则）：分数越低越好 */
function penalty(m, size) {
  let score = 0;

  /** 规则 1：同色连续 ≥5 */
  const runScore = (line) => {
    let s = 0;
    let run = 1;
    for (let i = 1; i < line.length; i += 1) {
      if (line[i] === line[i - 1]) {
        run += 1;
      } else {
        if (run >= 5) s += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) s += 3 + (run - 5);
    return s;
  };
  const rows = [];
  const cols = [];
  for (let i = 0; i < size; i += 1) {
    rows.push(m[i]);
    const col = [];
    for (let j = 0; j < size; j += 1) col.push(m[j][i]);
    cols.push(col);
  }
  for (const line of rows) score += runScore(line);
  for (const line of cols) score += runScore(line);

  /** 规则 2：2×2 同色块 */
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  /** 规则 3：形如 1011101 且一侧有 4 个空白的图案 */
  const PAT = [true, false, true, true, true, false, true];
  const matchAt = (line, i) => PAT.every((v, k) => line[i + k] === v);
  const rule3 = (line) => {
    let s = 0;
    for (let i = 0; i + 7 <= line.length; i += 1) {
      if (!matchAt(line, i)) continue;
      const before = line.slice(Math.max(0, i - 4), i);
      const after = line.slice(i + 7, i + 11);
      const blankBefore = before.length === 4 && before.every((v) => v === false);
      const blankAfter = after.length === 4 && after.every((v) => v === false);
      if (blankBefore || blankAfter) s += 40;
    }
    return s;
  };
  for (const line of rows) score += rule3(line);
  for (const line of cols) score += rule3(line);

  /** 规则 4：黑模块占比偏离 50% */
  let dark = 0;
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) if (m[r][c]) dark += 1;
  const total = size * size;
  const ratio = (dark * 100) / total;
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

/** BCH(15,5) 算格式信息（规范 8.9） */
function formatBits(ec, mask) {
  const data = (EC_FORMAT_BITS[ec] << 3) | mask;
  let rem = data << 10;
  const G = 0b10100110111;
  for (let i = 4; i >= 0; i -= 1) {
    if ((rem >> (i + 10)) & 1) rem ^= G << i;
  }
  return ((data << 10) | rem) ^ 0b101010000010010;
}

/** 把格式信息写到两处固定位置 */
function writeFormat(m, size, ec, mask) {
  const bits = formatBits(ec, mask);
  const bit = (i) => ((bits >> i) & 1) === 1;

  /**
   * 15 位分两处，**一处全在第 8 列、一处全在第 8 行**。
   *
   * 这两块极容易写成「行列镜像」（都是 15 个位置、看起来都对称），
   * 但扫描器按固定坐标读，写反了整张码一个字节都解不出来——
   * 表现就是「能看见二维码、扫一下没反应」。
   */
  /** 第 8 列：b0–b5 从上往下，b6/b7 跳过时序行，b8–b14 从最底行往上 */
  for (let i = 0; i <= 5; i += 1) m[i][8] = bit(i);
  m[7][8] = bit(6);
  m[8][8] = bit(7);
  for (let i = 8; i <= 14; i += 1) m[size - 15 + i][8] = bit(i);

  /** 第 8 行：b0–b7 从最右列往左，b8 在 (8,7)，b9–b14 继续往左到 (8,0) */
  for (let i = 0; i <= 7; i += 1) m[8][size - 1 - i] = bit(i);
  m[8][7] = bit(8);
  for (let i = 9; i <= 14; i += 1) m[8][15 - i - 1] = bit(i);

  /** 固定的暗模块 */
  m[size - 8][8] = true;
}

/** BCH(18,6) 算版本信息（版本 7+，规范 8.10） */
function versionBits(version) {
  let rem = version << 12;
  const G = 0b1111100100101;
  for (let i = 5; i >= 0; i -= 1) {
    if ((rem >> (i + 12)) & 1) rem ^= G << i;
  }
  return (version << 12) | rem;
}

function writeVersion(m, size, version) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const on = ((bits >> i) & 1) === 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    m[size - 11 + c][r] = on;
    m[r][size - 11 + c] = on;
  }
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把一个字符串编成二维码位矩阵。
 *
 * @param {string} text UTF-8 文本（二维码登录就是那条 URL）
 * @param {{ec?: 'L'|'M'|'Q'|'H', mask?: number}} [o]
 *   `mask` 只在测试里用（强制某个掩码，方便和参考实现逐位对照）；
 *   正常调用不传，按罚分自动选最优。
 * @returns {{version:number, size:number, ec:string, mask:number, modules:boolean[][]}}
 *   `modules[row][col]`，`true` = 黑
 */
export function encodeQr(text, { ec = 'L', mask: forcedMask = null } = {}) {
  const level = String(ec).toUpperCase();
  /**
   * 注意 `M` 的格式位是 **0**：用 `!EC_FORMAT_BITS[level]` 判断会把它当成
   * 「不认识」，直接把 M 级别判死。
   */
  if (!Object.prototype.hasOwnProperty.call(EC_FORMAT_BITS, level)) {
    throw new Error(`不认识的纠错级别：${ec}`);
  }

  const bytes = Array.from(Buffer.from(String(text ?? ''), 'utf8'));
  if (!bytes.length) throw new Error('内容为空');

  const version = pickVersion(bytes.length, level);
  const size = 17 + 4 * version;

  const m = newMatrix(size);
  const fn = newMatrix(size);

  placeFinder(m, fn, size);
  placeTiming(m, fn, size);
  placeAlign(m, fn, version, size);
  reserveFormat(fn, size);
  reserveVersion(fn, version, size);

  const codewords = buildCodewords(bytes, version, level);
  placeData(m, fn, codewords, size);

  /** 八种掩码各算一次罚分，取最低的（规范 8.8.2） */
  let bestMask = 0;
  let best = null;
  let bestScore = Infinity;
  const tried = [];
  for (let mask = 0; mask < 8; mask += 1) {
    if (forcedMask !== null && mask !== forcedMask) continue;
    const trial = m.map((row) => row.slice());
    const cond = MASKS[mask];
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        /** 功能图案不参与掩码 */
        if (fn[r][c]) continue;
        if (cond(r, c)) trial[r][c] = !trial[r][c];
      }
    }
    const score = penalty(trial, size);
    tried.push({ mask, score });
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      best = trial;
    }
  }
  if (!best) throw new Error(`掩码只能用 0–7，收到 ${forcedMask}`);

  writeFormat(best, size, level, bestMask);
  writeVersion(best, size, version);

  return { version, size, ec: level, mask: bestMask, modules: best };
}

/** 位矩阵画成 SVG 字符串（能直接塞进 `<img src="data:image/svg+xml;...">`） */
export function qrToSvg(qr, { scale = 6, margin = 4, dark = '#111', light = '#fff' } = {}) {
  const { modules, size } = qr;
  const dim = (size + margin * 2) * scale;
  const rects = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!modules[r][c]) continue;
      rects.push(`<rect x="${(c + margin) * scale}" y="${(r + margin) * scale}" width="${scale}" height="${scale}"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
    + `<g fill="${dark}">${rects.join('')}</g>`
    + '</svg>';
}

/** 给 `<img src>` 用：base64 编码的 SVG data URL */
export function qrToDataUrl(qr, opts) {
  const svg = qrToSvg(qr, opts);
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/* ------------------------------------------------------------------ */
/* PNG 输出（`node:zlib` 是内置模块，仍然零依赖）                      */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * 位矩阵画成 PNG（8 位灰度，无调色板）。
 *
 * 为什么是 PNG 而不是内联 SVG：二维码要塞进 `ui-data.json` 的 meta 里，
 * 那个字段对值长度有上限；一串 `<rect>` 的 SVG 动辄几十 KB，而 PNG 压缩后
 * 只有一两 KB，还可以直接当文件用 `<img src>` 引。
 *
 * @param {{modules:boolean[][], size:number}} qr
 * @param {{scale?:number, margin?:number}} [o]
 * @returns {Buffer}
 */
export function qrToPng(qr, { scale = 8, margin = 4 } = {}) {
  const size = qr.size;
  const dim = (size + margin * 2) * scale;

  /** 每行前面一个 filter 字节（0 = None），后面是灰度像素 */
  const raw = Buffer.alloc(dim * (dim + 1));
  let p = 0;
  for (let y = 0; y < dim; y += 1) {
    raw[p] = 0;
    p += 1;
    const r = Math.floor(y / scale) - margin;
    for (let x = 0; x < dim; x += 1) {
      const c = Math.floor(x / scale) - margin;
      const dark = r >= 0 && c >= 0 && r < size && c < size && qr.modules[r][c];
      raw[p] = dark ? 0 : 255;
      p += 1;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0);
  ihdr.writeUInt32BE(dim, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 0;   // 灰度
  ihdr[10] = 0;  // 压缩方式
  ihdr[11] = 0;  // filter 方式
  ihdr[12] = 0;  // 非隔行

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* 优先用开源实现（共享依赖里的 `qrcode`），没有才退回上面那份内置的   */
/* ------------------------------------------------------------------ */

/** 每个 deps 目录只 require 一次 */
const npmLibCache = new Map();

/**
 * 尝试加载共享依赖里的 `qrcode`（周下载千万级的成熟库）。
 *
 * 为什么不是"必须装"：扫码是面板上一个按钮，为它加一道「先点安装」的
 * 前置步骤，体验比偶尔的边界差异更糟。所以这里的策略是**能借就借、
 * 借不到自己扛**——装上开源库就用它（版本 11–40、多模式分段都覆盖），
 * 没装就用内置编码器（版本 1–10、Byte 模式，二维码登录足够）。
 */
function loadNpmQr(depsDir) {
  const dir = String(depsDir || '').trim();
  if (!dir) return null;
  if (npmLibCache.has(dir)) return npmLibCache.get(dir);
  let lib = null;
  try {
    const req = createRequire(join(dir, 'package.json'));
    lib = req('qrcode');
  } catch {
    /** 没装、装坏了、版本不对：都退回内置，不让扫码不可用 */
    lib = null;
  }
  npmLibCache.set(dir, lib);
  return lib;
}

/** 扁平数组按行切成二维 */
function toRows(flat, size) {
  const rows = [];
  for (let r = 0; r < size; r += 1) {
    const row = new Array(size);
    for (let c = 0; c < size; c += 1) row[c] = flat[r * size + c] === 1;
    rows.push(row);
  }
  return rows;
}

/**
 * 生成二维码：**有开源库就优先用开源库**。
 *
 * @param {string} text
 * @param {{depsDir?: string, ec?: 'L'|'M'|'Q'|'H'}} [o] `depsDir` 是宿主的共享依赖目录
 * @returns {{version:number,size:number,ec:string,mask:number,modules:boolean[][],source:string}}
 */
export function createQr(text, { depsDir = '', ec = 'L' } = {}) {
  const lib = loadNpmQr(depsDir);
  if (lib && typeof lib.create === 'function') {
    const q = lib.create(String(text), { errorCorrectionLevel: ec });
    const size = q.modules.size;
    return {
      version: q.version,
      size,
      ec: String(ec).toUpperCase(),
      mask: Number(q.maskPattern) || 0,
      modules: toRows(q.modules.data, size),
      source: 'npm:qrcode',
    };
  }
  return { ...encodeQr(text, { ec }), source: 'builtin' };
}

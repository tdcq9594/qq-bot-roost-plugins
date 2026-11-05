// jm-comic 的 PDF 合成：把一串 JPEG 写成一个 PDF，不依赖任何 npm 包。
// 原始 JPEG 字节当作图像流塞进去，不用解码、不用 zlib、体积也最小。
// 参考 Pillow 的行为：每张图一页，页面尺寸 = 像素 / 150dpi * 72pt。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { jpegInfo } from './image.js';

const HEADER = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1');

class Sink {
  constructor(file) {
    this.stream = fs.createWriteStream(file);
    this.offset = 0;
    this.error = null;
    this.stream.on('error', (e) => {
      this.error = e;
    });
  }

  async write(buf) {
    if (this.error) throw this.error;
    this.offset += buf.length;
    if (!this.stream.write(buf)) {
      await new Promise((resolve, reject) => {
        this.stream.once('drain', resolve);
        this.stream.once('error', reject);
      });
    }
  }

  async close() {
    await new Promise((resolve, reject) => {
      this.stream.end((err) => (err ? reject(err) : resolve()));
    });
  }
}

function pad10(n) {
  return String(n).padStart(10, '0');
}

/**
 * @param {object} opts
 * @param {string} opts.outFile
 * @param {Array<{file:string}>} opts.pages 按页顺序的 JPEG 路径
 * @param {number} [opts.dpi=150]
 * @param {Function} [opts.onProgress] ({done,total}) => void
 * @returns {Promise<{ok:boolean, bytes?:number, pages?:number, skipped?:Array, error?:string}>}
 */
export async function writePdf({ outFile, pages, dpi = 150, onProgress }) {
  const list = Array.isArray(pages) ? pages : [];
  if (!list.length) return { ok: false, error: '没有可写入 PDF 的图片' };

  // 先把每页的宽高读出来（也顺便跳过坏图），避免写到一半才发现某页没尺寸
  const ready = [];
  const skipped = [];
  for (const page of list) {
    const file = typeof page === 'string' ? page : page?.file;
    if (!file) continue;
    try {
      const buf = await fsp.readFile(file);
      const info = jpegInfo(buf);
      if (!info || !info.width || !info.height) {
        skipped.push({ file, error: '不是可识别的 JPEG' });
        continue;
      }
      ready.push({ file, buf, width: info.width, height: info.height, components: info.components || 3 });
    } catch (error) {
      skipped.push({ file, error: error?.message ?? String(error) });
    }
  }
  if (!ready.length) return { ok: false, error: '全部图片都读不出来，无法生成 PDF', skipped };

  const total = ready.length;
  const objects = 2 + total * 3; // 1 catalog + 1 pages + 每页 3 个对象
  const sink = new Sink(outFile);
  const offsets = new Array(objects + 1).fill(0);

  const startObj = () => sink.offset;

  const writeObj = async (num, header, stream) => {
    offsets[num] = startObj();
    await sink.write(Buffer.from(`${num} 0 obj\n${header}\n`, 'latin1'));
    if (stream) {
      await sink.write(stream);
      await sink.write(Buffer.from('\n', 'latin1'));
    }
    await sink.write(Buffer.from('endobj\n', 'latin1'));
  };

  try {
    await sink.write(HEADER);

    // 1: Catalog
    await writeObj(1, '<< /Type /Catalog /Pages 2 0 R >>');

    // 2: Pages
    const kids = ready.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
    await writeObj(2, `<< /Type /Pages /Count ${total} /Kids [${kids}] >>`);

    for (let i = 0; i < total; i++) {
      const page = ready[i];
      const pageObj = 3 + i * 3;
      const contentObj = pageObj + 1;
      const imageObj = pageObj + 2;

      const wPt = Math.max(1, (page.width * 72) / dpi);
      const hPt = Math.max(1, (page.height * 72) / dpi);
      const fmt = (n) => (Math.round(n * 100) / 100).toString();

      await writeObj(
        pageObj,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(wPt)} ${fmt(hPt)}] ` +
          `/Resources << /XObject << /Im0 ${imageObj} 0 R >> /ProcSet [/PDF /ImageC] >> ` +
          `/Contents ${contentObj} 0 R >>`,
      );

      const content = `q ${fmt(wPt)} 0 0 ${fmt(hPt)} 0 0 cm /Im0 Do Q`;
      const contentBuf = Buffer.from(content, 'latin1');
      await writeObj(
        contentObj,
        `<< /Length ${contentBuf.length} >>\nstream`,
        Buffer.concat([contentBuf, Buffer.from('\nendstream', 'latin1')]),
      );

      const cs = page.components === 1 ? '/DeviceGray' : page.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
      const imageHeader =
        `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
        `/ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.buf.length} >>\nstream`;
      await writeObj(
        imageObj,
        imageHeader,
        Buffer.concat([page.buf, Buffer.from('\nendstream', 'latin1')]),
      );

      if (typeof onProgress === 'function' && (i % 10 === 0 || i === total - 1)) {
        try {
          onProgress({ done: i + 1, total });
        } catch {
          /* 进度回调出错不影响写盘 */
        }
      }
    }

    // 交叉引用表
    const xrefStart = sink.offset;
    let xref = `xref\n0 ${objects + 1}\n0000000000 65535 f\r\n`;
    for (let n = 1; n <= objects; n++) xref += `${pad10(offsets[n] || 0)} 00000 n\r\n`;
    await sink.write(Buffer.from(xref, 'latin1'));
    const trailer =
      `trailer\n<< /Size ${objects + 1} /Root 1 0 R >>\n` + `startxref\n${xrefStart}\n%%EOF\n`;
    await sink.write(Buffer.from(trailer, 'latin1'));

    await sink.close();
    const st = await fsp.stat(outFile);
    if (!st.size) return { ok: false, error: 'PDF 生成了但大小为 0', skipped };
    return { ok: true, bytes: st.size, pages: total, skipped };
  } catch (error) {
    try {
      await sink.close();
    } catch {
      /* ignore */
    }
    return { ok: false, error: `PDF 写入失败：${error?.message ?? error}`, skipped };
  }
}

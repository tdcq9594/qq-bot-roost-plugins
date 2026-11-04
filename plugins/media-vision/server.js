/**
 * 临时图片站：把刚准备好的图片用一个短 URL 暴露出来，给下游插件下载。
 *
 * ── 为什么非要一个 HTTP 服务 ──────────────────────────────────────────
 * 下游（ai-chat 的 collectImages）只认 `attachments[].url`，它自己 `fetch`
 * 回来转 base64。所以「本地有一张图」这件事必须变成「一个能 GET 到的地址」。
 *
 * 三个备选都不行：
 *   · `data:image/jpeg;base64,...` —— fetch 认得，但 ai-chat 会把 URL 原样
 *     拼进提示词，6 万字符的 base64 等于当场把上下文撑爆；
 *   · `ctx.registerRoute()` —— 走面板鉴权（key / 同源校验），
 *     ai-chat 是个内部 fetch，不带任何凭据，必然 401；
 *   · 写进静态目录 —— 面板静态目录在 asar 里，而且要重启才认。
 *
 * 所以自己起一个只监听 127.0.0.1 的小服务：随机端口 + 随机路径段 + 只读白名单，
 * 三个条件叠起来，同机上的别的进程也猜不到地址。
 *
 * 生命周期跟着插件走：`teardown` 里 close，重载不会漏端口。
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 一个文件最多被取几次就作废（下游会重试/预取，给点余量） */
const MAX_HITS = 12;

/**
 * @param {object} [o]
 * @param {number} [o.ttlMs] 文件多久后过期（默认 10 分钟）
 * @param {number} [o.maxFiles] 同时在册的文件上限
 * @param {(s:string)=>void} [o.log]
 */
export function createMediaServer({ ttlMs = 10 * 60_000, maxFiles = 400, log = () => {} } = {}) {
  /** id -> { file, ext, at, hits } */
  const files = new Map();
  /** 路径段：猜不到就不可能命中 */
  const token = randomUUID().replace(/-/g, '');
  let server = null;
  let port = 0;
  let sweep = null;
  let starting = null;

  function sweepOnce() {
    const now = Date.now();
    for (const [id, hit] of files) {
      if (now - hit.at > ttlMs) files.delete(id);
    }
    // 兜底：真有人疯狂喂图时，先丢最老的
    while (files.size > maxFiles) {
      const oldest = [...files.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) break;
      files.delete(oldest[0]);
    }
  }

  function ensure() {
    if (server) return Promise.resolve(true);
    if (starting) return starting;
    starting = new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        try {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD' });
            return res.end();
          }
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const parts = url.pathname.split('/').filter(Boolean);
          // 期望 /<token>/<id>.<ext>
          if (parts.length !== 2 || parts[0] !== token) {
            res.writeHead(404);
            return res.end();
          }
          const id = parts[1].replace(/\.[a-z0-9]+$/i, '');
          const hit = files.get(id);
          if (!hit) {
            res.writeHead(404);
            return res.end();
          }
          let buf;
          try {
            buf = fs.readFileSync(hit.file);
          } catch {
            files.delete(id);
            res.writeHead(410);
            return res.end();
          }
          hit.hits += 1;
          if (hit.hits > MAX_HITS) files.delete(id);
          res.writeHead(200, {
            'content-type': hit.ext === 'png' ? 'image/png' : hit.ext === 'webp' ? 'image/webp' : 'image/jpeg',
            'content-length': String(buf.length),
            'cache-control': 'no-store',
          });
          if (req.method === 'HEAD') return res.end();
          res.end(buf);
          return;
        } catch (e) {
          try { res.writeHead(500); res.end(); } catch { /* 断了 */ }
          log(`图片服务处理出错：${e?.message ?? e}`);
        }
      });
      s.on('error', (e) => {
        log(`图片服务起不来：${e?.message ?? e}`);
        server = null;
        resolve(false);
      });
      s.listen(0, '127.0.0.1', () => {
        server = s;
        port = s.address()?.port || 0;
        sweep = setInterval(sweepOnce, 60_000);
        sweep.unref?.();
        log(`图片服务已就绪：http://127.0.0.1:${port}（仅本机）`);
        resolve(true);
      });
    });
    return starting;
  }

  return {
    /** 起服务；返回是否可用 */
    ensure,
    /** 当前是否已就绪 */
    get ready() {
      return Boolean(server);
    },
    get port() {
      return port;
    },
    /** 换个文件就能拿到新地址，文件名随便起（扩展名决定 content-type） */
    add(file) {
      if (!server) return '';
      const ext = String(path.extname(file)).replace('.', '').toLowerCase() || 'jpg';
      const id = randomUUID().replace(/-/g, '').slice(0, 24);
      files.set(id, { file, ext, at: Date.now(), hits: 0 });
      if (files.size > maxFiles) sweepOnce();
      return `http://127.0.0.1:${port}/${token}/${id}.${ext}`;
    },
    /** 登记之后拿到地址（服务没起就顺手起，失败返回空串） */
    async publish(file) {
      const ok = await ensure();
      if (!ok) return '';
      return this.add(file);
    },
    stats() {
      return { port, files: files.size, ready: Boolean(server) };
    },
    clear() {
      files.clear();
    },
    close() {
      if (sweep) clearInterval(sweep);
      sweep = null;
      files.clear();
      starting = null;
      const s = server;
      server = null;
      port = 0;
      if (s) {
        try { s.close(); } catch { /* 已经关了 */ }
      }
    },
  };
}

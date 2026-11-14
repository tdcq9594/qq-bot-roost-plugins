/**
 * 目录内容哈希（与框架 src/hashdir.js 同一套算法）
 * ================================================
 *
 * 抽成独立模块，是为了让 `test/hash-consistency.mjs` 能和框架的
 * `src/hashdir.js` 各算一遍、断言逐字节一致——两份实现一旦漂移，
 * 就会出现「索引由一份生成、由另一份校验 → 所有用户安装 sha256 失败」。
 *
 * 插件仓库要能单独 clone 下来就能跑，所以这里不 import 框架代码，
 * 保持一份自包含实现；一致性靠测试守，而不是靠共享代码。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** 不参与哈希的东西：依赖目录、缓存、VCS/IDE 元数据（每台机器都不一样） */
const SKIP_DIRS = new Set([
  'node_modules', '.venv', 'venv', '__pycache__', '.git', '.idea', '.vscode',
  /**
   * `deps/` 是 0.5.x 的旧位置（当时 ffmpeg 装在扩展自己目录里）。
   * 现在改由宿主统一装在数据目录，扩展里不会再生成；这条留着只为
   * 「装过旧版本、还没清理」的机器不会因此 `--check` 报红。
   */
  'deps',
  /**
   * `shots/` 是图库目录：刷一轮自动抽的帧会落在这里，面板从 `/ext-pages`
   * 取缩略图。内容每次运行都不同，算进哈希会让 `--check` 永远红。
   */
  'shots',
]);
const SKIP_FILES = new Set([
  '.deps.json', '.DS_Store', 'Thumbs.db',
  /** 面板数据与扫码二维码：运行时生成，内容每次不同，算进哈希会让 --check 永远失败 */
  'ui-data.json', 'qr.png', 'cookie.txt',
  /** 「谁回了 ta」的清单：运行时写入，内容随时在变 */
  'replies.json',
  /** 「已经回过的评论」名单：运行时写入 */
  'replied.json',
  /** 刷到但模型还没看过的一批：运行时状态，随时在变 */
  'pending.json',
]);

/** 文本文件 CRLF 折成 LF；二进制原样（判定依据同 git：有没有 NUL 字节） */
function normalize(buf) {
  if (buf.includes(0)) return buf;
  if (!buf.includes(0x0d)) return buf;
  return Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

async function collect(root) {
  const out = [];
  const walk = async (dir, prefix) => {
    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (it.isDirectory()) {
        if (SKIP_DIRS.has(it.name)) continue;
        await walk(path.join(dir, it.name), prefix ? `${prefix}/${it.name}` : it.name);
      } else if (it.isFile()) {
        if (SKIP_FILES.has(it.name)) continue;
        out.push(prefix ? `${prefix}/${it.name}` : it.name);
      }
      // 符号链接一律跳过：可能指向仓库外，内容不稳定
    }
  };
  await walk(root, '');
  return out.sort();
}

export async function hashDir(dir) {
  const files = await collect(dir);
  const h = crypto.createHash('sha256');
  for (const rel of files) {
    const buf = normalize(await fs.readFile(path.join(dir, rel)));
    h.update(rel);
    h.update('\0');
    h.update(String(buf.length));
    h.update('\0');
    h.update(buf);
    h.update('\0');
  }
  return h.digest('hex');
}

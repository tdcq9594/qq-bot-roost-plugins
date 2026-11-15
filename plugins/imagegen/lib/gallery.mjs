/**
 * 画作画廊（0.2）
 * ==============
 *
 * 宿主的声明式界面 `meta` 只支持一层标量对象，塞不进数组；而扩展自带页面
 * 可以走宿主的通用静态路由 `/ext-pages?id=<id>&file=<相对路径>` 读任意文件
 * （含 png/jpg/webp，见宿主 `host.js` 的 `/ext-pages`）。所以：
 *
 *   · `ui-data.json`  → 状态标量（今日几张、上次结果），给声明式表格用
 *   · `gallery.json`  → 画作数组，给扩展自己的页面用
 *   · `out/<文件名>`  → 图片本体，页面拼成缩略图 URL
 *
 * 之前 0.1 的判断是「要显示缩略图得宿主补一个静态文件路由」——那条路由
 * 后来有了（B 站扩展的截图库就是走它），所以这一版不用碰宿主一行代码。
 *
 * 写盘一律 tmp + rename：页面随时可能来读，不能读到半截 JSON。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bytesText } from './paint.mjs';
import { whenText } from './ui-data.mjs';
import { sleepSync, withFileLock } from './lock.mjs';

export const GALLERY_FILE = 'gallery.json';

/**
 * 画作列表 → 页面行。
 *
 * `file` 是**相对扩展目录**的路径（`out/xxx.png`），页面拿它直接拼
 * `/ext-pages?id=imagegen&file=out%2Fxxx.png`；`name` 是纯文件名，
 * 删除动作和 `resolveRef()` 只认这个，不认路径。
 */
export function galleryRows(items = []) {
  const list = Array.isArray(items) ? items : [];
  return list.map((it, i) => {
    const name = String(it?.file ?? '').slice(0, 160);
    return {
      no: i + 1,
      file: `out/${name}`,
      name,
      prompt: String(it?.prompt ?? '').slice(0, 120) || '(没记提示词)',
      when: whenText(it?.at),
      bytes: Number(it?.bytes) || 0,
      size: bytesText(it?.bytes),
    };
  });
}

export function createGallery({ dir, log = () => {} } = {}) {
  const file = () => join(dir, GALLERY_FILE);

  return {
    file,
    /**
     * 从画作列表整份重写（数组不存在「局部 patch」这回事）。
     * 与 ui-data.json 同理：两个进程都会写，加锁 + Windows EPERM 短重试。
     */
    write(items = []) {
      return withFileLock(dir, GALLERY_FILE, () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const tmp = `${file()}.${process.pid}.${attempt}.tmp`;
          try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(tmp, `${JSON.stringify({ updatedAt: Date.now(), items: galleryRows(items) }, null, 0)}\n`, 'utf8');
            renameSync(tmp, file());
            return true;
          } catch (e) {
            const retryable = ['EPERM', 'EACCES', 'EBUSY'].includes(e?.code);
            if (!retryable || attempt === 2) {
              log(`画廊写盘失败：${e?.message ?? e}`);
              return false;
            }
            sleepSync(5 + attempt * 10);
          } finally {
            /** 同上：失败的 tmp 每轮回收 */
            try { unlinkSync(tmp); } catch { /* rename 成功后本来就不在了 */ }
          }
        }
        return false;
      }, { log });
    },
    read() {
      try {
        const j = JSON.parse(readFileSync(file(), 'utf8'));
        return Array.isArray(j?.items) ? j.items : [];
      } catch {
        return [];
      }
    },
  };
}

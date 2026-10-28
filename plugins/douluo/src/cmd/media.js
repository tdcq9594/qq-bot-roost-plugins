/**
 * 图文同条消息
 * ============
 *
 * 关键点：QQ 官方的富媒体消息（`msg_type=7`）自带 `content` 字段，
 * 所以**图 + 文可以在同一条消息里**，不用「先发一段文字再发一张图」。
 * 框架把它封成了 `msg.replyImage(src, { text })`。
 *
 * 图片地址两种写法（面板「内容表」里的 image 列直接填）：
 *   1. `https://…`        → 远程图，框架会缓存 file_info（同 URL 两天只传一次）
 *   2. `wuhun/lanyincao.png` → 本地图，相对 `data/bots/<bot>/plugins/douluo/images/`
 *
 * 为什么以「内容表字段」而不是「程序渲染」：本机没有渲染器（render 插件的
 * @napi-rs/canvas 没装），而武魂立绘/地图这种图本来就该是美术资源，
 * 让运营在面板里填 URL 或丢文件进去，比程序画更像回事，也不用加原生依赖。
 *
 * 失败即降级：上传失败/图丢了/开关关掉，一律返回 false，调用方退回纯文本。
 * 群里发不出图时玩家至少还能看到文字，不会一片空白。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function createMedia({ ctx, dataDir }) {
  const imgDir = path.join(dataDir, 'images');
  /**
   * 插件自带的图库（随插件分发）。
   * 机器人自己的 `images/` 优先——运营在面板/脚本里补的图会覆盖掉自带图；
   * 找不到才回落到这里，这样「装了插件就有图」，不用先跑一遍生成脚本。
   */
  const bundledDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'images');
  try {
    fs.mkdirSync(imgDir, { recursive: true });
  } catch {
    /* 建不了目录就让所有图都解析失败，不影响文字 */
  }

  const enabled = () => ctx.config?.images !== false;

  /** 把内容表里填的地址解析成 { src, local }；解析不出来返回 null */
  function resolve(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return { src: s, local: false };

    // 本地图：相对 images 目录（也允许写绝对路径，方便调试）
    const candidates = path.isAbsolute(s) ? [s] : [path.join(imgDir, s), path.join(bundledDir, s)];
    for (const p of candidates) {
      try {
        if (fs.statSync(p).isFile()) return { src: p, local: true };
      } catch {
        /* 试下一个 */
      }
    }
    return null;
  }

  return {
    enabled,
    imgDir,
    resolve,

    /** 这条内容有没有可用图片 */
    has(raw) {
      return enabled() && resolve(raw) !== null;
    },

    /**
     * 发一条图文同条消息。
     * @returns {Promise<boolean>} 成功 true；开关关掉 / 没图 / 发送失败 → false
     */
    async send(msg, { image, text }) {
      if (!enabled()) return false;
      const r = resolve(image);
      if (!r) return false;
      try {
        // 注意：text 会作为这条富媒体消息的 content，与图同一条发出
        const out = await msg.replyImage(r.src, { local: r.local, text: String(text ?? '') });
        return Boolean(out);
      } catch (e) {
        ctx.logger?.warn?.(`发图失败（已降级为纯文本）：${e.message}`);
        return false;
      }
    },
  };
}

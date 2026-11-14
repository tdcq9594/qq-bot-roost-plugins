/**
 * 进程内动作（`ui.runtime: "inprocess"`）
 * ============================================================
 *
 * 这个文件由**宿主进程** import，不是 MCP server 的一部分。宿主调它的
 * `createActions()`，拿到一组函数直接绑到面板按钮上——点一下就是一次
 * 普通函数调用，没有队列、没有轮询、返回值立刻回到页面。
 *
 * 放这里的只该是「一次调用就能完成、不依赖扩展运行态」的动作：
 *   · 刷新热门（拉一次接口 + 写面板数据）
 *   · 检查登录（问一次 nav 接口）
 *   · 查 ffmpeg 在不在（读宿主共享目录，纯本地）
 *
 * 依赖扩展进程状态的动作（刷一轮 feed、发弹幕、推送）**留在 MCP 侧**——
 * 它们要读 feed 的缓存、推送的额度、风控的暂停标记，这些只存在于扩展进程里。
 * 模块里没实现的动作，宿主会自动回落到队列，所以这里可以只放一部分。
 *
 * **ffmpeg 不在这里装**：它现在装到宿主的共享目录（`<数据目录>/deps`），
 * 由面板的 `sharedDeps.install` 负责。扩展只负责「找得到就说可用」。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBiliApi } from '../lib/api.mjs';
import { createUiData } from '../lib/ui-data.mjs';
import { ffmpegState } from '../lib/ffmpeg.mjs';

/** `ui/main.mjs` 的上一级就是扩展根目录（ui/ 的父目录） */
const HERE = fileURLToPath(new URL('..', import.meta.url));

/**
 * @param {{ config?: object, log?: Function, id?: string }} ctx
 * @returns {Record<string, (payload?: object) => Promise<{ok:boolean,message:string,data?:any}>>}
 */
export function createActions({ config = {}, log = () => {} } = {}) {
  /**
   * Cookie：宿主进程里没有 `ROOST_EXT_SECRET_COOKIE`（那是给 MCP 子进程的），
   * 所以这里读扩展自己的 `cookie.txt`。扫码登录写的就是这个文件。
   */
  const getCookie = () => {
    try {
      return readFileSync(join(HERE, 'cookie.txt'), 'utf8').split(/\r?\n/)[0].trim();
    } catch {
      return '';
    }
  };

  const api = createBiliApi({ log, getCookie });
  const ui = createUiData({ dir: HERE, log });

  return {
    async refresh_hot() {
      const items = await api.hot({ ps: Number(config.hotPoolSize) || 20 });
      const list = Array.isArray(items) ? items : [];
      ui.fromPool(list);
      return { ok: true, message: `已刷新 ${list.length} 条`, data: { count: list.length } };
    },

    async check_login() {
      const a = await api.account();
      const logged = Boolean(a?.isLogin);
      return {
        ok: true,
        message: logged ? `已登录：${a.uname}` : '没登录（只能看，不能评论）',
        data: { isLogin: logged, uname: String(a?.uname || '') },
      };
    },

    /** 页面想知道 ffmpeg 现在有没有，不用等一次动作 */
    async ffmpeg_state() {
      const s = ffmpegState({ root: HERE, configured: config?.ffmpegPath });
      return { ok: true, message: s.ready ? '可用（宿主共享目录）' : '没装', data: s };
    },
  };
}

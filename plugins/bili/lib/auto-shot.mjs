/**
 * 刷完一轮顺手抽几帧（面板「截图库」的数据来源）
 * ============================================================
 *
 * 两个进程都要用（宿主里的「现在刷一轮」、MCP 子进程的定时刷），所以抽成
 * 一份。逻辑很短，但有几个必须一致的细节：
 *
 *   · 热门池里只有 `bvid`，没有 `cid`；抽帧要 cid，得先 `view()` 一次；
 *   · 默认只抽 2 个——每多一个就多一次接口 + 一次 ffmpeg，按钮会明显变慢；
 *   · 没 ffmpeg、单个视频失败都**跳过**，绝不让「这一轮刷成功了」变成失败；
 *   · 抽完重写 `shots/index.json`，面板才能看到新图。
 */

import { bumpStats } from './stats.mjs';
import { countShots, writeIndex } from './gallery.mjs';

/**
 * @param {{api: object, shots: object, ui: object, config: object, log?: Function}} o
 *   `config` 要传**活引用**（进程内那份），这样开关改了立刻生效
 * @returns {(items: object[]) => Promise<number>} 返回真正截成功的张数
 */
export function createAutoShot({ api, shots, ui, config, log = () => {} } = {}) {
  return async function autoShot(items) {
    if (!config?.autoShot) return 0;
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return 0;

    const want = Math.max(0, Math.min(10, Number(config.autoShotCount) || 2));
    if (!want) return 0;
    /** 没装 ffmpeg 就别白跑一遍接口 */
    if (!shots.ffmpegStatus().ready) return 0;

    let done = 0;
    for (const it of list.slice(0, want)) {
      const bvid = String(it?.bvid || '');
      if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) continue;
      try {
        const v = await api.view({ bvid });
        const dur = Math.max(1, Math.floor(Number(v?.duration) || 0));
        /** 取 1/3 处：开头常有黑帧/片头，截出来一片黑 */
        const at = Math.max(1, Math.min(Math.floor(dur / 3), Math.max(1, dur - 1)));
        await shots.take({ info: v, at });
        done += 1;
      } catch (e) {
        log(`自动抽帧跳过 ${bvid}：${e?.message ?? e}`);
      }
    }

    if (done) {
      writeIndex({ dir: shots.dir, limit: Number(config.shotKeep) || 60 });
      bumpStats(ui, { shots: done });
      /** 面板标题上的「n / 上限」 */
      try {
        ui.setMeta({ gallery: { count: countShots({ dir: shots.dir }), limit: Number(config.shotKeep) || 60 } });
      } catch { /* 只影响显示 */ }
    }
    return done;
  };
}

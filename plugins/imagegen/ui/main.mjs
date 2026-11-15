/**
 * 进程内动作（`ui.runtime: "inprocess"`）
 * ============================================================
 *
 * 这个文件由**宿主进程** import，不是 MCP server 的一部分。宿主调
 * `createActions()` 拿到一组函数直接绑到面板按钮上——点一下就是一次
 * 普通函数调用，没有队列、没有轮询，返回值立刻回到页面。
 *
 * 和 MCP 侧共用 `lib/` 里的同一套逻辑（`drawOnce` / `markerOf` /
 * `createUiData`），所以「面板上测试生图」和「模型调 image_gen」
 * 是同一条链路：同样的配额、同样的错误文案、同样的落盘与清理。
 *
 * 两个必须记住的边界：
 *   1. **`config` / `secrets` 是活引用**，宿主每次点击前原地更新
 *      （见宿主 `ext-inprocess.js` 的 `ctxOf`）。所以每次动作现算配置，
 *      不要在 `createActions()` 里把值抠出来存成局部变量。
 *   2. **两个进程写同一份 `ui-data.json`**：这里所有写入都走
 *      `setMeta()` / `fromGallery()` 的「先读回再合并」，不要整份覆盖。
 *
 * 面板按钮这条通道有 150 秒上限（宿主 `extensions.ui.action`），
 * 所以 `test_draw` 把生图超时夹到 120 秒，留出返回和写盘的余量。
 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { readConfig, readyProblem } from '../lib/config.mjs';
import { textOf } from '../lib/errors.mjs';
import { createGallery } from '../lib/gallery.mjs';
import { listPaintings, removePainting, resolveRef } from '../lib/paint.mjs';
import { countToday } from '../lib/state.mjs';
import { createToolbox, drawOnce, markerOf } from '../lib/tools.mjs';
import { createUiData, whenText } from '../lib/ui-data.mjs';

/** `ui/main.mjs` 的上一级就是扩展根目录 */
const HERE = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(HERE, 'out');

/** 面板按钮 → 进程内动作：清单里的 `ui.actions` 必须和这里一字不差，由 test/ui-actions.mjs 守门 */
export const ACTION_IDS = ['test_draw', 'refresh', 'delete', 'send', 'status'];

/** 页面画廊里的 `file` 是 `out/xxx.png`，工具只认纯文件名，两种都接下来 */
function bareName(v) {
  return String(v ?? '').trim().replace(/^out[\\/]/i, '');
}

/**
 * @param {{ config?: object, secrets?: object, log?: Function }} ctx
 * @returns {Record<string, (payload?: object) => Promise<{ok:boolean,message:string,data?:any}>>}
 */
export function createActions({ config = {}, secrets = {}, log = () => {} } = {}) {
  const ui = createUiData({ dir: HERE, log });
  const gal = createGallery({ dir: HERE, log });

  /** 每次点击现算：面板上刚改的设置、刚粘的密钥，下一次点就是新值 */
  function cfgOf() {
    const c = readConfig({
      ROOST_EXT_CONFIG: JSON.stringify(config || {}),
      ROOST_EXT_SECRET_APIKEY: String(secrets?.apiKey ?? ''),
    }, log);
    c.timeoutSec = Math.min(Number(c.timeoutSec) || 120, 120);
    return c;
  }

  /** 与 MCP 子进程的 `syncPanel()` 同形状：两份数据文件一起刷 */
  function sync(items, opts, cfg) {
    const { total } = listPaintings({ dir: OUT, limit: 1000, cap: 1000 });
    ui.fromGallery(items, { allowEmpty: opts?.allowEmpty !== false });
    gal.write(items);
    const meta = {
      today: countToday(OUT),
      dailyLimit: Number(cfg.dailyLimit) || 0,
      total,
      ready: readyProblem(cfg) || '配置看起来能画',
    };
    if (opts?.result) {
      const r = opts.result;
      meta.lastResult = r.path ? '画好了' : '画好了，但没存进画作库';
      meta.lastVia = String(r.via ?? '');
      meta.lastMs = Math.round(Number(r.ms) || 0);
      meta.lastAt = whenText(Date.now());
    }
    ui.setMeta(meta);
  }

  function itemsOf(limit = 50) {
    return listPaintings({ dir: OUT, limit }).items;
  }

  return {
    /**
     * 「测试生图」：真画一张、花一次钱、可能要等一两分钟。
     * 按钮是同步等结果的（宿主通道 150 秒），不要在页面里再做轮询。
     */
    async test_draw(payload = {}) {
      const cfg = cfgOf();
      const why = readyProblem(cfg);
      if (why) return { ok: false, message: `还画不了：${why}` };
      const prompt = String(payload?.prompt ?? '').trim() || '一只橘猫，简笔画';
      try {
        const r = await drawOnce({
          cfg, dir: HERE, prompt, log,
          onPaint: (items, opts) => sync(items, opts, cfg),
        });
        return {
          ok: true,
          message: `接口通了：${r.via} · ${r.size} · ${(r.ms / 1000).toFixed(1)} 秒${r.path ? '' : '（图没存下来）'}`,
          data: {
            file: r.file, path: r.path, via: r.via, ms: r.ms, bytes: r.bytes,
            marker: r.path ? `<<image-alone: ${r.path}>>` : '',
          },
        };
      } catch (e) {
        const msg = textOf(e);
        ui.setMeta({ lastResult: `失败：${msg}`, lastAt: whenText(Date.now()) });
        return { ok: false, message: msg };
      }
    },

    /** 画作库重扫一遍（主人可能手动往 out/ 里放了图，或删了图） */
    async refresh() {
      const cfg = cfgOf();
      const items = itemsOf(50);
      sync(items, { allowEmpty: true }, cfg);
      const { total } = listPaintings({ dir: OUT, limit: 1000, cap: 1000 });
      return {
        ok: true,
        message: `刷新完成：最近 ${items.length} 张，共 ${total} 张`,
        data: { total, today: countToday(OUT) },
      };
    },

    /** 删一张：必须带 confirm，且只从画作库查表，不接受任意路径 */
    async delete(payload = {}) {
      if (payload?.confirm !== true) return { ok: false, message: '没确认就不删' };
      const ref = bareName(payload?.file);
      const hit = resolveRef({ dir: OUT, ref });
      if (!hit?.file) return { ok: false, message: `画作库里没有「${ref}」` };
      const r = removePainting(OUT, hit.file);
      if (!r.ok) return { ok: false, message: r.message };
      sync(itemsOf(50), { allowEmpty: true }, cfgOf());
      return { ok: true, message: `删掉了：${hit.file}` };
    },

    /** 编号 → 现成的标记串，页面只负责展示/复制，不自己拼路径 */
    async send(payload = {}) {
      const ref = bareName(payload?.file);
      try {
        const r = markerOf({ dir: OUT, ref, style: payload?.style === 'inline' ? 'inline' : 'alone' });
        return {
          ok: true,
          message: '把下面这一行原样写进回复就会发出去',
          data: { marker: r.marker, path: r.path, file: r.file },
        };
      } catch (e) {
        return { ok: false, message: textOf(e) };
      }
    },

    /** 自检：不画图、不花钱、不联网，复用 MCP 侧的 image_status 文案 */
    async status() {
      const cfg = cfgOf();
      const box = createToolbox({ cfg, dir: HERE, log });
      const message = await box.call('image_status', {});
      return {
        ok: true,
        message,
        data: { ready: readyProblem(cfg) || '配置看起来能画' },
      };
    },
  };
}

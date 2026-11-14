/**
 * 「刷到了，但模型还没看过」的队列
 * ============================================================
 *
 * 定时刷是扩展的定时器在跑，那时候**没有模型在场**——只能拉数据、写面板。
 * 真要「看过内容再决定评论/弹幕/分享」，得等模型下一次醒来。这个文件就是
 * 两者之间的交接单：
 *
 *   刷完 → 写进这里 → 模型下次调 `feed` 工具时看到「有 3 条没处理过」
 *        → 它自己决定调 comment / like / push，或者什么都不做
 *
 * 为什么不在定时器里直接叫模型：那需要给扩展一条带工具的模型通道
 * （`/v1/agent.prompt` 可以，但每轮一次完整回合，成本和会话污染都不小）。
 * 交接单模式零额外调用，而且决策权确实在模型手上。
 *
 * 只记**没处理过**的：模型调过 feed 看过一遍就算处理，再刷到才会重新进来。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'pending.json';
/** 只记最靠前的这些：热门榜一次 20 条，全留着等于让模型读一份清单 */
const MAX = 20;

export function createPending({ dir, log = () => {} } = {}) {
  const file = () => join(dir, FILE);

  function load() {
    try {
      const j = JSON.parse(readFileSync(file(), 'utf8'));
      return {
        updatedAt: Number(j?.updatedAt) || 0,
        items: Array.isArray(j?.items) ? j.items : [],
        seen: Array.isArray(j?.seen) ? j.seen : [],
      };
    } catch {
      return { updatedAt: 0, items: [], seen: [] };
    }
  }

  function save(next) {
    try {
      const tmp = `${file()}.tmp`;
      /** 先写临时文件再改名：面板和工具随时可能来读，别让谁读到半截 JSON */
      writeFileSync(tmp, `${JSON.stringify({ ...next, updatedAt: Date.now() }, null, 0)}\n`, 'utf8');
      renameSync(tmp, file());
      return true;
    } catch (e) {
      log(`待处理队列写盘失败：${e?.message ?? e}`);
      return false;
    }
  }

  return {
    /** 刷完一轮：把这一批记进去（`seen` 保留最近 500 个，别无限长） */
    add(items) {
      const list = Array.isArray(items) ? items : [];
      if (!list.length) return 0;
      const cur = load();
      const seen = new Set(cur.seen);
      const known = new Set(cur.items.map((x) => x.bvid));
      const fresh = list
        .filter((v) => /^BV[0-9A-Za-z]{10}$/.test(String(v?.bvid ?? '')))
        /** 已经处理过的就不再进来，否则每轮都提示「有新的」，很快就变成噪音 */
        .filter((v) => !seen.has(String(v.bvid)) && !known.has(String(v.bvid)))
        .slice(0, MAX)
        .map((v) => ({
          bvid: String(v.bvid),
          title: String(v.title ?? '').slice(0, 80),
          author: String(v.author ?? '').slice(0, 30),
          play: Number(v.play) || 0,
          at: Date.now(),
        }));
      if (!fresh.length) return 0;
      const merged = [...fresh, ...cur.items].slice(0, MAX);
      save({ items: merged, seen: cur.seen });
      log(`待模型处理：新增 ${fresh.length} 条`);
      return fresh.length;
    },

    /**
     * 模型看过一遍：返回清单并标记为已处理。
     *
     * 「看即处理」是刻意的——如果要求模型显式确认，它忘一次就会永远看到
     * 同一批，反而更吵。
     */
    take() {
      const cur = load();
      if (!cur.items.length) return [];
      const bvids = cur.items.map((x) => x.bvid);
      save({ items: [], seen: [...cur.seen, ...bvids].slice(-500) });
      return cur.items;
    },

    /** 只看不动（面板用） */
    peek() {
      return load();
    },
  };
}

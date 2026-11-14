/**
 * 让她自己看这一轮（独立会话）
 * ============================================================
 *
 * 原来这段逻辑长在 `server.mjs` 里，只有 MCP 子进程的定时刷能用到。结果是
 * 面板上点「现在刷一轮」只拉数据、不产生感想——「ta 刷过什么」永远空的。
 *
 * 抽到这里以后两个入口共用同一套：
 *
 *   · MCP 子进程的定时刷（`ROOST_API_TOKEN` 由 launcher 注入）；
 *   · 宿主进程里的面板按钮（宿主在 `extensions.ui.action` 里现传同样的变量）。
 *
 * 她只能在独立会话里**表达意图**（输出 JSON），真正动手的是这一侧：
 * 试运行、每日额度、风控暂停全在 `write` / `submit` 里，她绕不过去。
 *
 * 每轮一次模型调用，所以**定时刷**由 `cfg.aiDecide` 把关（默认关，关着
 * 的时候材料留在 `pending` 队列，等主聊天里模型自己调 `feed` 接手）；
 * 面板上手动点「现在刷一轮」传 `force: true`，不受这个开关影响——
 * 用户明确按了按钮，就该真的开会话，别让一个默认关的开关把按钮变哑。
 */

import { createBrowseSession, materialOfVideos, shareMaterial } from './ai-duty.mjs';
import { cardOf } from './card.mjs';
import { lookAt } from './vision.mjs';
import { withMention } from './write.mjs';

/**
 * @param {object} o
 * @param {object} o.api B 站接口
 * @param {object} o.shots 抽帧器（看画面要用）
 * @param {object} o.cfg 配置（**活引用**，面板改了立刻生效）
 * @param {object} o.write 写动作层
 * @param {object} o.submit 主动素材通道
 * @param {object} [o.memory] 宿主记忆
 * @param {object} o.replied 「已经回过的评论」记录
 * @param {object} [o.history] 刷过什么的账本
 * @param {object} [o.pending] 待处理队列
 * @param {(patch: object) => void} [o.bump] 今日计数（`bumpStats` 的包装）
 * @param {(patch: object) => void} [o.setMeta] 面板状态
 * @param {object} [o.env] 读 `ROOST_API_URL` / `ROOST_API_TOKEN`
 * @param {Function} [o.systemTurn] 宿主内部系统会话轮次；有它就不走 HTTP 三步
 * @param {object} [o.roostLink] 宿主直连协议客户端；分享优先发官方图文卡片
 * @param {Function} [o.log]
 */
export function createSelfBrowse({
  api,
  shots,
  cfg,
  write,
  submit,
  memory = null,
  replied,
  history = null,
  pending = null,
  bump = () => {},
  setMeta = () => {},
  env = process.env,
  systemTurn = null,
  roostLink = null,
  log = () => {},
} = {}) {
  const session = createBrowseSession(env, { log, systemTurn });
  let busy = false;

  /** 取「有人回了她」的清单，去掉已经回过的（B 站会一直留着同一条） */
  async function freshReplies() {
    try {
      const list = await api.replyFeed({ limit: 15 });
      return (Array.isArray(list) ? list : []).filter((x) => x.id && x.root && !replied.has(x.id));
    } catch (e) {
      log(`查「有人回了她」失败（不影响这一轮）：${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * 看画面（`cfg.vision`）：只对本轮前两条抽帧 + 让模型描述。
   *
   * 只做两条是因为每条要抽 3~6 帧、再跑一次模型——一轮做十条会让「刷一轮」
   * 从几秒变成几分钟。抽帧写进图库，面板「截图库」也能看到。
   */
  async function describe(items) {
    const out = new Map();
    if (!cfg.vision) return out;
    for (const v of items.slice(0, 2)) {
      const bvid = String(v?.bvid ?? '');
      if (!bvid) continue;
      try {
        const info = await api.view({ bvid });
        const d = await lookAt({ v, info, shots, cfg, env, log });
        if (d) out.set(bvid, d);
      } catch (e) {
        log(`看画面失败 ${bvid}（不影响这一轮）：${e?.message ?? e}`);
      }
    }
    if (out.size) log(`看画面：${out.size} 条有了画面描述`);
    return out;
  }

  /**
   * 跑一轮。
   *
   * @param {object[]} items 这一轮刷到的视频
   * @param {{force?: boolean}} [opts]
   *   `force` = 面板里手动点的「现在刷一轮」。
   *
   *   **`aiDecide` 只管定时刷，不管手动刷。** 对齐 aurabot 的
   *   `bili.run({ force: true })`：用户在面板上明确点了一下，就是要她
   *   真的去看、开那个独立会话；此时被一个默认关着的开关挡回去，
   *   表现出来就是「点了没反应、也没开刷 B 站会话」。
   *   定时刷是后台自己跑的、可能一小时好几次，才需要开关省模型调用。
   *
   * @returns {Promise<{ok: boolean, why?: string, watched?: number}>}
   *   `ok:false` 表示「这一步没做成」，**不影响刷到数据这件事本身**——
   *   调用方不该把它当整轮失败。
   */
  async function run(items, { force = false } = {}) {
    if (!cfg.aiDecide && !force) return { ok: false, why: '「让她自己看」关着（只影响定时刷）' };
    if (busy) return { ok: false, why: '上一轮还没看完' };
    if (!Array.isArray(items) || !items.length) return { ok: false, why: '没有可看的视频' };
    busy = true;
    try {
      const replies = await freshReplies();
      const descriptions = await describe(items);

      const r = await session.decide(materialOfVideos(items, { descriptions }), { replies });
      if (!r.ok) {
        log(`她这轮没看成：${r.why}`);
        /** 没看成也把材料留在待处理队列里，别丢 */
        pending?.add(items);
        return { ok: false, why: String(r.why || '没看成') };
      }
      /** 视频可以一条都不评论，但「有人回了她」仍然要处理，所以不能在这里直接 return */
      if (!r.items.length && !(r.replies || []).length) {
        log('她这轮看完，什么都没想做');
        return { ok: true, watched: 0 };
      }

      const byBvid = new Map(items.map((v) => [String(v?.bvid ?? ''), v]));
      const rows = [];
      /** 她这轮总共想做的事，回调给面板做一句概括 */
      const tally = { comment: 0, danmaku: 0, share: 0 };

      for (const d of r.items) {
        const v = byBvid.get(d.bvid);
        if (!v) continue;
        const acts = [];
        const title = String(v.title ?? '');

        /**
         * 评论和弹幕：**话是她自己写的**，这里只负责发。
         *
         * 两个开关各管一条出口：`autoComment` / `autoDanmaku` 关着就不发——
         * 她可以想，但主人没允许这条出口。一次 `view` 同时拿 aid 和 cid，
         * 别为了评论、弹幕各查一遍热门接口。
         */
        if (d.comment || d.danmaku) {
          let info = null;
          try {
            info = await api.view({ bvid: d.bvid });
          } catch (e) {
            log(`她想对 ${d.bvid} 说话但拿不到视频信息：${e?.message ?? e}`);
          }
          const aid = Number(info?.aid) || 0;
          const cid = Number(info?.cid) || 0;
          const dur = Math.max(1, Math.floor(Number(info?.duration) || 0));

          if (d.comment && cfg.autoComment && aid) {
            try {
              const w = await write.comment(aid, withMention(d.comment, cfg.ownerName));
              if (w?.ok && !w.dryRun) { bump({ comments: 1 }); acts.push('comment'); tally.comment += 1; }
            } catch (e) {
              log(`她想评论 ${d.bvid} 但没发出去：${e?.message ?? e}`);
            }
          }
          if (d.danmaku && cfg.autoDanmaku && cid) {
            try {
              /** 1/3 处：开头常有片头，结尾可能没画面 */
              const at = Math.max(1, Math.floor(dur / 3));
              const w = await write.danmaku(cid, d.danmaku, at * 1000);
              if (w?.ok && !w.dryRun) { bump({ danmaku: 1 }); acts.push('danmaku'); tally.danmaku += 1; }
            } catch (e) {
              log(`她想发弹幕 ${d.bvid} 但没发出去：${e?.message ?? e}`);
            }
          }
        }

        /**
         * 分享 = 一张官方图文卡片直发主人。
         *
         * 以前把她写的那句话当「素材」投给主动搭话模型改写：模型既看不到
         * 视频，素材里也没有链接，最后只发出一句「刷到个…要不要看看」，
         * 主人问链接时她只能说「我这儿只剩个标题」。卡片四段（标题/描述/
         * 跳转/封面）扩展手里全有，模型一个字都不用凑；她那句话写进卡片
         * 描述，链接由 `card.url` 带着，点一下就能开。
         */
        if (d.share) {
          let shared = false;
          if (roostLink?.available) {
            try {
              const { card } = cardOf(v);
              /**
               * 官方 msg_type=8 不带正文，宿主 `narrowMsgSend` 也会把 content
               * 清空。她写的那句话改成卡片描述：不额外多占一条主动额度，
               * 主人点开卡片前就能看见，链接仍在 card.url 里。
               */
              if (d.share) card.description = String(d.share).slice(0, 200);
              const r = await roostLink.sendCard(card);
              if (r?.ok) shared = true;
              else log(`她想分享 ${d.bvid} 但卡片没发出去：${String(r?.why || '未知原因')}`);
            } catch (e) {
              log(`她想分享 ${d.bvid} 但卡片拼不出来：${e?.message ?? e}`);
            }
          }
          /** 没直连能力（MCP 旧宿主 / 手动跑）才回退素材通道，且素材必须带链接 */
          if (!shared) {
            try {
              const r = await submit.submit({
                cause: '她刷 B 站看到的',
                key: `${d.bvid}|owner`,
                text: shareMaterial(v, d.share),
                target: 'owner',
              });
              shared = Boolean(r?.ok);
              if (!shared) log(`她想分享 ${d.bvid} 但素材没投出去：${String(r?.why || '未知原因')}`);
            } catch (e) {
              log(`她想分享 ${d.bvid} 但素材通道失败：${e?.message ?? e}`);
            }
          }
          if (shared) {
            bump({ shares: 1 });
            acts.push('share');
            tally.share += 1;
          }
        }
        if (d.remember && memory?.available) {
          await memory.remember(d.remember);
        }

        /**
         * **每条都记一行**，哪怕她什么都没做：这条记录回答的是
         * 「她刚才看了什么」，感想只是其中的一栏。没感想就退而用她
         * 真发出去的那句话，都没有就只留标题。
         */
        rows.push({
          at: Date.now(),
          kind: 'watch',
          bvid: d.bvid,
          title,
          text: d.feeling || (acts.includes('comment') ? d.comment : '') || d.danmaku || d.share || '',
          acts,
        });
      }

      /**
       * 回别人回她的评论。
       *
       * 只认**材料里给过的那几条 id**：模型有时会编 id，拿它对不上就直接跳过——
       * 否则可能回到别的视频、别的楼层去。楼层信息（oid/root/parent）也全用
       * 扩展这边查到的，绝不采信模型。
       */
      let replyN = 0;
      for (const rep of r.replies || []) {
        if (!cfg.autoComment) break;
        const src = replies.find((x) => String(x.id) === String(rep.id));
        if (!src) continue;
        try {
          const w = await write.comment(Number(src.oid) || 0, withMention(rep.text, cfg.ownerName), {
            root: Number(src.root) || 0,
            parent: Number(src.parent) || 0,
          });
          if (w?.ok) {
            replied.add(src.id);
            replyN += 1;
            if (!w.dryRun) {
              bump({ replies: 1 });
              rows.push({
                at: Date.now(),
                kind: 'reply',
                bvid: '',
                title: String(src.title || ''),
                text: String(rep.text || ''),
                acts: [],
              });
            }
          }
        } catch (e) {
          log(`她想回 ${src.id} 但没发出去：${e?.message ?? e}`);
        }
      }

      if (history && rows.length) history.add(rows);

      const top = rows.find((x) => x.kind === 'watch' && x.text);
      setMeta({
        ai: {
          lastAt: Date.now(),
          count: rows.filter((x) => x.kind === 'watch').length,
          top: String(top?.text || ''),
          title: String(top?.title || ''),
        },
      });
      log(`她看完了这一轮：${rows.length} 条看了，${tally.comment} 条评论，${tally.danmaku} 条弹幕，`
        + `${replyN} 条回复，${tally.share} 条分享`);
      return { ok: true, watched: rows.length };
    } catch (e) {
      log(`她自己刷 B 站失败（不影响这一轮）：${e?.message ?? e}`);
      return { ok: false, why: String(e?.message ?? e).slice(0, 200) };
    } finally {
      busy = false;
    }
  }

  return {
    run,
    get available() { return session.available; },
    get busy() { return busy; },
    close: () => session.close(),
  };
}

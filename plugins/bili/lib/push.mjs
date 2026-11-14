/**
 * 定时刷之后做什么（0.4）
 * =======================
 *
 * 0.3 的 `onFresh` 只做两件事：喂 hot 缓存、刷面板。0.4 在这之后按开关
 * 派生三类动作，每类各有自己的闸：
 *
 *   ① 主动推送 —— 投素材给宿主 `/v1/proactive/submit`，由模型写措辞、宿主过门闸
 *   ② 抽帧入库 —— 只存本地，等有人在群里开口时用 `shot` 工具发（主动轮次
 *      里 `speakup.fire()` 会把 `<<...>>` 标记抹平，图片/卡片标记发不出去）
 *   ③ 写动作   —— 评论 / 点赞 / 弹幕，**不注册成 MCP 工具**，只在定时刷内部跑
 *
 * 所有开关默认关，写动作还额外 `writeDryRun` 默认开。装了扩展 ≠ 同意被推送，
 * 更 ≠ 同意拿你的账号去留言。
 */

const dayOf = (t) => new Date(t).toDateString();
const linkOf = (bvid) => `https://www.bilibili.com/video/${bvid}`;
const playText = (n) => {
  const v = Number(n) || 0;
  return v >= 10000 ? `${(v / 10000).toFixed(1)} 万` : String(v);
};

/** 模板里只替换 {title} / {author}，别让外部文本变成代码 */
export function fillTemplate(tpl, v) {
  return String(tpl ?? '')
    .replaceAll('{title}', String(v?.title ?? '').slice(0, 40))
    .replaceAll('{author}', String(v?.author ?? '').slice(0, 30))
    .trim()
    .slice(0, 200);
}

export function materialOf(v, { withCover = false } = {}) {
  const lines = [
    `刚刷到《${String(v?.title ?? '').slice(0, 60)}》`,
    `UP：${String(v?.author ?? '?').slice(0, 30)} · 播放 ${playText(v?.play)}`
      + (v?.tname ? ` · ${String(v.tname).slice(0, 12)}` : ''),
    v?.desc ? `简介：${String(v.desc).slice(0, 80)}` : '',
    `链接：${linkOf(v?.bvid ?? '')}`,
  ];
  /** 封面是 https 地址，给模型当素材；不写成 <<card:>> 标记（见文件头②） */
  if (withCover && /^https:\/\//i.test(String(v?.cover ?? ''))) {
    lines.push(`封面：${String(v.cover).slice(0, 300)}`);
  }
  return lines.filter(Boolean).join('\n');
}

export function createPush({
  cfg, api, shots, submit, write,
  /** 宿主记忆（可选）：推成功记一笔，下次别推同一条、聊天里也能回忆 */
  memory = null,
  log = () => {}, now = () => Date.now(),
} = {}) {
  let day = '';
  let pushed = 0;
  let writes = 0;
  const seen = new Set();
  let last = { at: 0, reason: '', picked: 0, delivered: 0, writes: 0, errors: [] };

  function roll() {
    const d = dayOf(now());
    if (d !== day) { day = d; pushed = 0; writes = 0; seen.clear(); }
  }

  /** 命中门槛 + 去重。只挑这一轮里最靠前的几条，别把整池 20 条全推了 */
  function pick(items) {
    roll();
    const min = Math.max(0, Number(cfg?.pushMinPlay) || 0);
    const max = Math.max(1, Math.min(5, Math.round(Number(cfg?.pushPerFeed) || 1)));
    const out = [];
    for (const v of Array.isArray(items) ? items : []) {
      const bvid = String(v?.bvid ?? '').trim();
      if (!/^BV[0-9A-Za-z]{10}$/.test(bvid) || seen.has(bvid)) continue;
      if ((Number(v?.play) || 0) < min) continue;
      out.push(v);
      if (out.length >= max) break;
    }
    return out;
  }

  async function deliver(v, reason) {
    const text = materialOf(v, { withCover: Boolean(cfg?.pushCover) });
    const targets = [];
    if (cfg?.pushOwner) targets.push({ target: 'owner', approve: false });
    if (cfg?.pushGroup && String(cfg?.pushGroupTarget || '').trim()) {
      targets.push({
        target: `group:${String(cfg.pushGroupTarget).trim()}`,
        approve: Boolean(cfg?.pushApproval),
      });
    }
    if (!targets.length) return { delivered: 0, why: '没开任何推送开关' };
    if (!submit?.available) return { delivered: 0, why: '宿主素材通道不可用（没令牌或没地址）' };

    let n = 0;
    const errors = [];
    for (const t of targets) {
      if (pushed >= Math.max(1, Number(cfg?.pushDailyLimit) || 20)) {
        errors.push('今日推送额度用完了');
        break;
      }
      /**
       * key 要带上 target：宿主队列按 (extId, key) 去重，同一条视频同时推
       * 私聊和群是两个独立投递。只写 BV 号的话，第一条还没结算（门闸没过 /
       * 等审批）时第二条会被 409「这条已经排过了」吃掉。
       */
      const r = await submit.submit({
        cause: '刷到好视频', key: `${String(v?.bvid ?? '')}|${t.target}`,
        text, target: t.target, approve: t.approve,
      });
      if (r.ok) { n += 1; pushed += 1; }
      else errors.push(`${t.target}：${r.why}`);
    }
    if (n) {
      log(`推送素材《${v?.title}》：${n} 条（${reason}）`);
      /**
       * 记一笔「推过什么」。
       *
       * 只在**真投递出去**之后记：交素材成功但被门闸挡下、等审批的，
       * 记了会变成「她记得推过、其实主人没看到」。
       * 写不进去不影响这次推送（宿主可能没给 memory:write 的 scope）。
       */
      if (memory?.available) {
        const title = String(v?.title ?? '').slice(0, 60);
        const who = String(v?.author ?? '').slice(0, 30);
        void memory
          .remember(`刷 B 站时推过《${title}》（UP：${who || '?'}，${String(v?.bvid ?? '')}），${n} 条`)
          .catch(() => {});
      }
    }
    return { delivered: n, errors };
  }

  /**
   * 写动作：只做**不需要文案**的那一个——点赞。
   *
   * 评论和弹幕曾经在这里按模板填（「{title} 挺好」），那就是假互动：
   * 她根本没看过内容。现在这两件事只在 `aiDecideTask` 里做，话由她
   * 在独立会话里看过简介/字幕/热评之后自己写（见 lib/ai-duty.mjs）；
   * 开关依旧是 `autoComment` / `autoDanmaku`，只是没有模板可填了。
   *
   * dryRun 也占当日次数，否则一个开着试运行的循环会刷出无数条日志。
   */
  async function actions(v) {
    const want = [];
    if (cfg?.autoLike) want.push(['like', '']);
    if (!want.length || !write) return { writes: 0, errors: [] };

    const limit = Math.max(1, Math.min(100, Number(cfg?.writeDailyLimit) || 10));
    const errors = [];
    let n = 0;
    let info = null;
    try { info = await api?.view?.({ bvid: String(v?.bvid ?? '') }); }
    catch (e) { errors.push(`读视频信息失败：${e?.message ?? e}`); }
    const aid = Number(info?.aid) || 0;
    const cid = Number(info?.cid) || 0;
    if (!aid && !cid) errors.push('这个视频拿不到 aid / cid，跳过写动作');

    for (const [kind, text] of want) {
      if (writes >= limit) { errors.push('今日写操作额度用完了'); break; }
      if (kind === 'like' && !aid) continue;
      if (kind === 'danmaku' && !cid) continue;
      const why = write.state?.()?.paused;
      if (why) { errors.push(why); break; }
      try {
        const r = kind === 'like' ? await write.like(aid) : await write.danmaku(cid, text);
        writes += 1;
        n += 1;
        if (r?.dryRun) log(`试运行 ${kind}《${v?.title}》（没真发）`);
      } catch (e) {
        errors.push(`${kind}：${e?.message ?? e}`);
      }
    }
    return { writes: n, errors };
  }

  /** 定时刷的 onFresh 回调。整体吞错：刷 B 站成功但推送失败，不该让这轮算失败 */
  async function onFresh(items, reason = '定时') {
    roll();
    /** 总开关只挡自动推送；工具手动补推仍然可用 */
    if (cfg?.enabled === false) return { ok: false, why: '总开关关着', picked: 0, delivered: 0, writes: 0, errors: [] };
    const got = pick(items);
    let delivered = 0;
    let didWrites = 0;
    const errors = [];
    for (const v of got) {
      seen.add(String(v.bvid));
      try {
        const d = await deliver(v, reason);
        delivered += d.delivered;
        errors.push(...(d.errors || []));
      } catch (e) { errors.push(`推送：${e?.message ?? e}`); }
      try {
        const w = await actions(v);
        didWrites += w.writes;
        errors.push(...(w.errors || []));
      } catch (e) { errors.push(`写动作：${e?.message ?? e}`); }
      /** 抽帧只存本地；失败不影响推送（多数机器没装 ffmpeg） */
      if (cfg?.autoShot && shots?.take) {
        try {
          const info = await api?.view?.({ bvid: String(v.bvid) });
          if (info?.cid) await shots.take({ info: { ...v, ...info }, at: 3 });
        } catch (e) { errors.push(`抽帧：${e?.message ?? e}`); }
      }
    }
    last = {
      at: now(), reason, picked: got.length,
      delivered, writes: didWrites,
      errors: errors.slice(0, 8),
    };
    return last;
  }

  /** 手动试一次：拿最近一批里最靠前的一条投出去，不看定时刷的 seen */
  async function pushOne(v, reason = '手动') {
    if (!v?.bvid) return { ok: false, why: '最近没有刷到视频' };
    const d = await deliver({ ...v, bvid: String(v.bvid) }, reason);
    return { ok: d.delivered > 0, ...d };
  }

  function state() {
    roll();
    return {
      switches: {
        pushOwner: Boolean(cfg?.pushOwner), pushGroup: Boolean(cfg?.pushGroup),
        pushApproval: Boolean(cfg?.pushApproval), pushCover: Boolean(cfg?.pushCover),
        autoShot: Boolean(cfg?.autoShot),
        autoComment: Boolean(cfg?.autoComment), autoLike: Boolean(cfg?.autoLike),
        autoDanmaku: Boolean(cfg?.autoDanmaku), writeDryRun: cfg?.writeDryRun !== false,
      },
      channel: Boolean(submit?.available),
      today: { pushed, writes, pushLimit: Number(cfg?.pushDailyLimit) || 20, writeLimit: Number(cfg?.writeDailyLimit) || 10 },
      last,
    };
  }

  return { onFresh, pushOne, state, pick, materialOf, fillTemplate, _reset: () => { pushed = 0; writes = 0; seen.clear(); last = { at: 0, reason: '', picked: 0, delivered: 0, writes: 0, errors: [] }; } };
}

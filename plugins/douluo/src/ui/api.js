/**
 * 面板接口（REST）
 * ================
 *
 * 挂在 `/api/plugins/douluo/r/...`，走框架的 ctx.registerRoute。
 * 鉴权、CSRF、同源校验全部复用面板那一套，这里只管业务。
 *
 * 约定：
 *   - 返回普通对象 → 200 + JSON
 *   - 返回 json(code, data) → 指定状态码
 *   - 抛错 → 框架统一转成 500 + 错误信息
 */
export function registerRoutes(ctx, { content, players, db, economy, balance, mail }) {
  const log = ctx.logger;

  /* ---------------- 插件设置（前缀等） ---------------- */

  ctx.registerRoute('GET', '/settings', async () => ({
    prefix: String(ctx.config?.prefix ?? '/'),
    seedOnEmpty: ctx.config?.seedOnEmpty !== false,
    images: ctx.config?.images !== false,
    // 本地图目录，面板上提示运营把图丢这儿
    imagesDir: ctx.state.media?.imgDir ?? '',
    // 指令清单，给面板展示「现在有哪些词可用」
    verbs: Object.keys(ctx.state.verbs ?? {}),
  }));

  ctx.registerRoute('PATCH', '/settings', async ({ body, json }) => {
    const patch = {};
    if (body?.prefix !== undefined) {
      const p = String(body.prefix).trim().slice(0, 4);
      if (!p) return json(400, { error: '前缀不能为空' });
      if (/\s/.test(p)) return json(400, { error: '前缀不能包含空格' });
      patch.prefix = p;
    }
    if (body?.seedOnEmpty !== undefined) patch.seedOnEmpty = Boolean(body.seedOnEmpty);
    if (body?.images !== undefined) patch.images = Boolean(body.images);
    if (!Object.keys(patch).length) return json(400, { error: '没有要改的项' });
    await ctx.setConfig(patch);
    log.info(`插件设置已更新：${JSON.stringify(patch)}`);
    return {
      ok: true,
      config: { prefix: String(ctx.config?.prefix ?? '/'), images: ctx.config?.images !== false },
    };
  });

  /* ---------------- 概览 ---------------- */

  ctx.registerRoute('GET', '/stats', async () => {
    const s = players.stats();
    const tables = content.counts();
    return {
      players: s.players,
      todayNew: s.todayNew,
      active24h: s.active24h,
      gold: s.gold,
      coupon: s.coupon,
      contentTables: tables.length,
      contentRows: tables.reduce((n, t) => n + t.rows, 0),
      tables,
      dataDir: db.dataDir,
      pack: content.db.prepare("SELECT value FROM content_meta WHERE key='pack'").get()?.value ?? '',
    };
  });

  /* ---------------- 内容表 ---------------- */

  ctx.registerRoute('GET', '/content/:table', async ({ params, query, json }) => {
    try {
      return json(200, content.list(params.table, { q: query.q, page: query.page, size: query.size }));
    } catch (e) {
      return json(400, { error: e.message });
    }
  });

  ctx.registerRoute('POST', '/content/:table', async ({ params, body, json }) => {
    try {
      return json(200, content.insert(params.table, body?.row ?? body ?? {}));
    } catch (e) {
      return json(400, { error: e.message });
    }
  });

  ctx.registerRoute('PATCH', '/content/:table', async ({ params, body, json }) => {
    try {
      const pk = body?.pk ?? {};
      return json(200, content.update(params.table, pk, body?.row ?? {}));
    } catch (e) {
      return json(400, { error: e.message });
    }
  });

  ctx.registerRoute('DELETE', '/content/:table', async ({ params, body, json }) => {
    try {
      return json(200, content.remove(params.table, body?.pk ?? {}));
    } catch (e) {
      return json(400, { error: e.message });
    }
  });

  /* ---------------- 数值系数 ---------------- */

  ctx.registerRoute('GET', '/cfg', async () => {
    const rows = content.db.prepare('SELECT key, value, type, desc FROM cfg ORDER BY key').all();
    return { rows };
  });

  ctx.registerRoute('PATCH', '/cfg', async ({ body, json }) => {
    const key = String(body?.key ?? '').trim();
    const value = body?.value;
    if (!key) return json(400, { error: '缺少 key' });
    const r = content.db.prepare('UPDATE cfg SET value = ? WHERE key = ?').run(String(value), key);
    if (!r.changes) return json(404, { error: `没有这个系数：${key}` });
    return { ok: true };
  });

  /* ---------------- 玩家 ---------------- */

  ctx.registerRoute('GET', '/players', async ({ query }) => players.list({ q: query.q, page: query.page, size: query.size }));

  ctx.registerRoute('GET', '/players/:openid', async ({ params, json }) => {
    const d = players.detail(params.openid);
    if (!d) return json(404, { error: '没有这个玩家' });
    return d;
  });

  ctx.registerRoute('POST', '/players/:openid/give', async ({ params, body, json }) => {
    try {
      const out = players.give(params.openid, {
        kind: body?.kind,
        id: body?.id,
        qty: body?.qty,
        reason: body?.reason || '面板发放',
      });
      log.info(`面板给 ${params.openid} 发放 ${body?.kind} ${body?.qty}`);
      return json(200, out);
    } catch (e) {
      return json(400, { error: e.message });
    }
  });

  ctx.registerRoute('DELETE', '/players/:openid', async ({ params, json }) => {
    try {
      return json(200, players.remove(params.openid));
    } catch (e) {
      return json(400, { error: e.message });
    }
  });

  /* ---------------- 流水 ---------------- */

  ctx.registerRoute('GET', '/tx', async ({ query }) => ({ rows: players.recentTx(query.limit || 100) }));

  /* ---------------- 邮件（运营补发） ---------------- */

  ctx.registerRoute('POST', '/players/:openid/mail', async ({ params, body, json }) => {
    const p = players.get(params.openid);
    if (!p) return json(404, { error: '没有这个玩家' });
    const rewards = typeof body?.rewards === 'string' ? (() => {
      try {
        return JSON.parse(body.rewards);
      } catch {
        return null;
      }
    })() : body?.rewards;
    if (rewards === null) return json(400, { error: '奖励不是合法 JSON' });
    const r = mail.send(params.openid, {
      title: String(body?.title ?? '系统邮件').slice(0, 60),
      body: String(body?.body ?? '').slice(0, 400),
      attachments: rewards ?? {},
    });
    return { ok: true, id: r.id };
  });

  ctx.registerRoute('GET', '/players/:openid/mail', async ({ params }) => {
    const p = players.get(params.openid);
    if (!p) return { rows: [] };
    return {
      unclaimed: mail.countUnclaimed(params.openid),
      rows: mail.list(params.openid, { limit: 20 }).map((m) => ({
        id: m.id,
        title: m.title,
        claimed: m.claimed,
        createdAt: m.created_at,
        summary: mail.summary(m.attach).join(' · '),
      })),
    };
  });

  /* ---------------- 数值体检 ---------------- */

  ctx.registerRoute('GET', '/balance', async ({ query }) => {
    const levels = String(query.levels ?? '')
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= 99);
    const samples = Math.min(300, Math.max(10, Number(query.samples) || 60));
    return balance.report({ levels: levels.length ? levels : undefined, samples });
  });

  ctx.registerRoute('GET', '/balance/check', async ({ query }) => {
    const samples = Math.min(300, Math.max(10, Number(query.samples) || 80));
    return balance.check({ samples });
  });

  /* ---------------- 经济 ---------------- */

  ctx.registerRoute('GET', '/economy', async () => ({
    ...economy.overview(),
    shops: economy.shops().map((s) => ({ id: s.id, name: s.name, currency: s.currency, desc: s.desc })),
    prizeCount: economy.prizes().length,
  }));

  ctx.registerRoute('GET', '/cdk', async () => ({
    rows: db.game
      .prepare('SELECT code, max_uses, used, expire_at, created_at FROM cdk ORDER BY created_at DESC LIMIT 100')
      .all(),
  }));

  ctx.registerRoute('POST', '/cdk', async ({ body, json }) => {
    const code = String(body?.code ?? '').trim();
    if (!code) return json(400, { error: '兑换码不能为空' });
    if (!/^[A-Za-z0-9_-]{2,32}$/.test(code)) return json(400, { error: '只能用字母数字下划线短横线，2–32 位' });
    let rewards = body?.rewards;
    if (typeof rewards === 'string') {
      try {
        rewards = JSON.parse(rewards);
      } catch {
        return json(400, { error: '奖励不是合法 JSON' });
      }
    }
    try {
      return economy.createCdk(code, rewards ?? {}, {
        maxUses: Number(body?.maxUses ?? 1),
        expireHours: Number(body?.expireHours ?? 0),
      });
    } catch (e) {
      return json(400, { error: e.message });
    }
  });

  /* ---------------- 下拉选项（给前端填 id 用） ---------------- */

  ctx.registerRoute('GET', '/options', async () => ({
    wuhun: content.db.prepare('SELECT id, name FROM wuhun WHERE enabled = 1 ORDER BY id').all(),
    item: content.db.prepare('SELECT id, name, kind FROM item WHERE enabled = 1 ORDER BY id').all(),
    monster: content.db.prepare('SELECT id, name FROM monster WHERE enabled = 1 ORDER BY id').all(),
    map: content.db.prepare('SELECT id, name FROM map WHERE enabled = 1 ORDER BY id').all(),
    title: content.db.prepare('SELECT id, name FROM title WHERE enabled = 1 ORDER BY id').all(),
    skill: content.db.prepare('SELECT id, name FROM skill WHERE enabled = 1 ORDER BY id').all(),
    equip: content.db.prepare('SELECT id, name, kind, part FROM equip WHERE enabled = 1 ORDER BY kind, id').all(),
    companion: content.db.prepare('SELECT id, name, kind, rarity FROM companion WHERE enabled = 1 ORDER BY kind, id').all(),
  }));
}

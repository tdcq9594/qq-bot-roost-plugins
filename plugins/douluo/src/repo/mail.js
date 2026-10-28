/**
 * 邮件
 * ====
 *
 * 解决的问题：**玩家不在场时发生的收益，他不知道自己拿到了。**
 *
 * 典型场景：
 *   - 拍卖成交，卖家在睡觉 → 钱直接进钱包，他永远不知道卖了多少钱
 *   - 运营补发 / 活动奖励 → 直接加背包，玩家没有"收到东西"的感觉
 *   - 出错补偿 → 没有渠道，只能口头说"已经给你加了"
 *
 * 走邮件之后：上线能看到「你有 3 封未读」、能追查、能过期。
 * 附件统一走 `EconomyRepo.trade()` 发放，所以流水和背包/钱包永远一致。
 */
const now = () => Date.now();

export class MailRepo {
  constructor(game, content, players, economy) {
    this.db = game;
    this.content = content;
    this.players = players;
    this.economy = economy;
  }

  #cfg() {
    return this.content.allCfg();
  }

  /** 发一封邮件（attachments 可以是空对象，纯通知） */
  send(openid, { title = '', body = '', attachments = {} } = {}) {
    const cfg = this.#cfg();
    const days = Math.max(0, Number(cfg.mail_keep_days ?? 30));
    const r = this.db
      .prepare(
        `INSERT INTO mail (openid, title, body, attachments, created_at, expire_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        String(openid),
        String(title).slice(0, 60),
        String(body).slice(0, 400),
        JSON.stringify(attachments ?? {}),
        now(),
        days ? now() + days * 86400_000 : 0,
      );
    return { id: Number(r.lastInsertRowid) };
  }

  /** 批量发（按名字找 openid 的批量由调用方处理） */
  sendMany(openids, payload) {
    let n = 0;
    for (const id of openids) {
      this.send(id, payload);
      n += 1;
    }
    return n;
  }

  list(openid, { limit = 10, onlyUnclaimed = false } = {}) {
    const where = onlyUnclaimed ? 'AND claimed = 0' : '';
    return this.db
      .prepare(`SELECT * FROM mail WHERE openid = ? ${where} ORDER BY claimed, id DESC LIMIT ?`)
      .all(String(openid), Math.min(50, limit))
      .map((m) => ({ ...m, attach: safeJson(m.attachments) }));
  }

  countUnclaimed(openid) {
    return this.db
      .prepare('SELECT COUNT(*) n FROM mail WHERE openid = ? AND claimed = 0')
      .get(String(openid)).n;
  }

  /** 附件摘要，给列表显示用 */
  summary(attach) {
    const out = [];
    if (Number(attach.gold)) out.push(`魂币 ${attach.gold}`);
    if (Number(attach.coupon)) out.push(`点券 ${attach.coupon}`);
    for (const it of attach.items ?? []) {
      const nm = this.content.db.prepare('SELECT name FROM item WHERE id = ?').get(Number(it.id));
      out.push(`${nm?.name ?? '物品'} × ${it.qty ?? 1}`);
    }
    for (const e of attach.equips ?? []) {
      const nm = this.content.db.prepare('SELECT name FROM equip WHERE id = ?').get(Number(e));
      out.push(`${nm?.name ?? '装备'} × 1`);
    }
    for (const c of attach.companions ?? []) {
      const nm = this.content.db.prepare('SELECT name FROM companion WHERE id = ?').get(Number(c));
      out.push(`${nm?.name ?? '伙伴'} × 1`);
    }
    return out;
  }

  /**
   * 领取一封。附件走 economy.trade，所以和别的产出走同一条账。
   * 已经领过的不会重复发（claimed 是唯一门闩）。
   */
  claim(openid, mailId) {
    const m = this.db.prepare('SELECT * FROM mail WHERE id = ? AND openid = ?').get(Number(mailId), String(openid));
    if (!m) return { error: 'not_found' };
    if (Number(m.claimed) === 1) return { error: 'already', title: m.title };
    const attach = safeJson(m.attachments);

    try {
      this.economy.trade(String(openid), {
        gain: {
          gold: Number(attach.gold ?? 0),
          coupon: Number(attach.coupon ?? 0),
          items: Array.isArray(attach.items) ? attach.items : [],
          equips: Array.isArray(attach.equips) ? attach.equips : [],
          companions: Array.isArray(attach.companions) ? attach.companions : [],
        },
        reason: `邮件领取 #${m.id}`,
      });
    } catch (e) {
      return { error: 'trade', message: e.message };
    }
    this.db.prepare('UPDATE mail SET claimed = 1, read = 1 WHERE id = ?').run(m.id);
    return { ok: true, title: m.title, got: this.summary(attach) };
  }

  /** 一键领取全部 */
  claimAll(openid) {
    const rows = this.db
      .prepare('SELECT id FROM mail WHERE openid = ? AND claimed = 0 ORDER BY id')
      .all(String(openid));
    const got = [];
    let count = 0;
    for (const r of rows) {
      const res = this.claim(openid, r.id);
      if (res.ok) {
        count += 1;
        got.push(...res.got);
      }
    }
    return { ok: true, count, got };
  }

  markRead(openid, mailId) {
    this.db.prepare('UPDATE mail SET read = 1 WHERE id = ? AND openid = ?').run(Number(mailId), String(openid));
  }

  /** 清掉过期且已领的邮件（省空间，不影响未领的） */
  purgeExpired() {
    const r = this.db
      .prepare('DELETE FROM mail WHERE expire_at > 0 AND expire_at < ? AND claimed = 1')
      .run(now());
    return r.changes;
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

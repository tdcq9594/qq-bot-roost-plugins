/**
 * 经济数据层
 * ==========
 *
 * 核心洞察：商城购买、拍卖成交、抽奖、CDK 兑换、银行存取 —— 本质都是
 * **一次「付出 A 换到 B」的交易**。所以这里只有一个 `trade()`，
 * 其余全是它的薄封装。
 *
 * 同类插件给每个商城写一遍「扣钱、给物品、检查余额」，7 个商城就是 7 份逻辑，
 * 改一处漏三处。这里所有货币/物品变动都必须过 `trade()`，
 * 于是「余额不够」「物品不够」的判断只有一份，tx_log 也只有一条路径。
 *
 * 两条硬规则：
 *   1. 所有写操作在**一个事务**里完成（`withTx`），半途失败不会出现「扣了钱没给货」
 *   2. 每一笔货币/物品变动都写 `tx_log`，面板能追到每一分钱
 */
import { withTx } from './player.js';

const now = () => Date.now();

export class EconomyRepo {
  constructor(game, content, players) {
    this.db = game;
    this.content = content;
    this.players = players;
    // 由 index.js 注入（和 MailRepo 互相依赖，用后置注入避免循环构造）
    this.mail = null;
  }

  #cfg() {
    return this.content.allCfg();
  }

  /** 统一调整货币并记账（gold / coupon 通用） */
  #adjust(openid, kind, delta, reason) {
    const d = Math.trunc(Number(delta) || 0);
    if (!d) return null;
    const col = kind === 'coupon' ? 'coupon' : 'gold';
    const p = this.players.get(openid);
    if (!p) throw new Error('你还没有角色');
    const next = Math.max(0, Number(p[col]) + d);
    this.db.prepare(`UPDATE player SET ${col} = ? WHERE openid = ?`).run(next, openid);
    this.db
      .prepare('INSERT INTO tx_log (openid, kind, ref_id, delta, balance, reason, at) VALUES (?,?,?,?,?,?,?)')
      .run(openid, kind, 0, d, next, String(reason ?? ''), now());
    return next;
  }

  /* ================= 核心交易 ================= */

  /**
   * 一次交易：先校验，再在一个事务里扣/发。
   *
   * @param {string} openid
   * @param {{pay?:{gold?:number,coupon?:number,items?:Array<{id:number,qty:number}>},
   *          gain?:{gold?:number,coupon?:number,items?:Array,equips?:number[],companions?:number[]},
   *          reason?:string}} opt
   */
  trade(openid, { pay = {}, gain = {}, reason = '' } = {}) {
    const p = this.players.get(openid);
    if (!p) throw new Error('你还没有角色');

    /**
     * pay 和 gain **分开记**，不做净额对冲。
     *
     * 早期版本把「花 100 又中 100」合成一条 0 变动的流水，结果审计时
     * 这笔交易直接消失了——玩家问「我抽奖扣的钱呢」，账上查不到。
     * 现在付出和收入各记一条，余额曲线能对上。
     */
    const payGold = Number(pay.gold ?? 0);
    const payCoupon = Number(pay.coupon ?? 0);
    if (payGold > 0 && Number(p.gold) < payGold) {
      throw new Error(`魂币不够（需要 ${payGold}，你有 ${p.gold}）`);
    }
    if (payCoupon > 0 && Number(p.coupon) < payCoupon) {
      throw new Error(`点券不够（需要 ${payCoupon}，你有 ${p.coupon}）`);
    }
    for (const it of pay.items ?? []) {
      const cur = this.db.prepare('SELECT qty FROM inventory WHERE openid = ? AND item_id = ?').get(openid, Number(it.id));
      if (Number(cur?.qty ?? 0) < Number(it.qty)) {
        const nm = this.content.db.prepare('SELECT name FROM item WHERE id = ?').get(Number(it.id));
        throw new Error(`${nm?.name ?? '物品'} 不够（需要 ${it.qty}，你有 ${cur?.qty ?? 0}）`);
      }
    }

    return withTx(this.db, () => {
      this.#adjust(openid, 'gold', -payGold, reason);
      this.#adjust(openid, 'coupon', -payCoupon, reason);
      this.#adjust(openid, 'gold', Number(gain.gold ?? 0), reason);
      this.#adjust(openid, 'coupon', Number(gain.coupon ?? 0), reason);
      for (const it of pay.items ?? []) this.players.addItem(openid, Number(it.id), -Number(it.qty), reason);
      for (const it of gain.items ?? []) this.players.addItem(openid, Number(it.id), Number(it.qty), reason);
      for (const e of gain.equips ?? []) this.players.grantEquip(openid, Number(e), reason);
      for (const c of gain.companions ?? []) this.players.grantCompanion(openid, Number(c), reason);
      const after = this.players.get(openid);
      return { ok: true, gold: after.gold, coupon: after.coupon };
    });
  }

  /* ================= 商城 ================= */

  shops() {
    return this.content.db.prepare('SELECT * FROM shop WHERE enabled = 1 ORDER BY id').all();
  }

  /** 货架：把物品名/描述/可卖价一起带上 */
  shopItems(shopId) {
    const cfg = this.#cfg();
    const rate = Number(cfg.sell_rate ?? 0.5);
    return this.content.db
      .prepare(
        `SELECT si.*, i.name, i.desc, i.kind AS item_kind, i.price AS base_price, i.use_scene
           FROM shop_item si JOIN item i ON i.id = si.item_id
          WHERE si.shop_id = ? AND i.enabled = 1
          ORDER BY si.sort, si.item_id`,
      )
      .all(Number(shopId))
      .map((r) => ({ ...r, sell_price: Math.max(1, Math.round(Number(r.base_price) * rate)) }));
  }

  /** 找商城：给名字按名字，没给就在所有商城里找有这件货的 */
  #resolveShop(shopName, itemName) {
    const shops = this.shops();
    if (shopName) {
      const s = shops.find((x) => x.name === shopName);
      return s ?? null;
    }
    if (!itemName) return shops[0] ?? null;
    for (const s of shops) {
      const hit = this.content.db
        .prepare('SELECT 1 AS ok FROM shop_item si JOIN item i ON i.id = si.item_id WHERE si.shop_id = ? AND i.name = ?')
        .get(s.id, itemName);
      if (hit) return s;
    }
    return null;
  }

  buy(openid, { shopName = '', itemName, qty = 1 }) {
    const n = Math.max(1, Math.trunc(Number(qty) || 1));
    const shop = this.#resolveShop(shopName, itemName);
    // 没指定商城又找不到货：是「没这个物品」，不是「商城没开」
    if (!shop) return { error: shopName ? 'no_shop' : 'no_item', name: shopName || itemName };

    const row = this.content.db
      .prepare(
        `SELECT si.*, i.name FROM shop_item si JOIN item i ON i.id = si.item_id
          WHERE si.shop_id = ? AND i.name = ? AND i.enabled = 1`,
      )
      .get(shop.id, String(itemName));
    if (!row) return { error: 'no_item', name: itemName, shop: shop.name };
    if (Number(row.stock) >= 0 && Number(row.stock) < n) {
      return { error: 'no_stock', name: row.name, left: Number(row.stock) };
    }

    const total = Number(row.price) * n;
    const currency = shop.currency === 'coupon' ? 'coupon' : 'gold';
    try {
      this.trade(openid, {
        pay: { [currency]: total },
        gain: { items: [{ id: row.item_id, qty: n }] },
        reason: `购买 ${row.name}×${n}（${shop.name}）`,
      });
    } catch (e) {
      return { error: 'trade', message: e.message };
    }
    if (Number(row.stock) >= 0) {
      this.content.db.prepare('UPDATE shop_item SET stock = stock - ? WHERE shop_id = ? AND item_id = ?').run(n, shop.id, row.item_id);
    }
    return { ok: true, item: row.name, qty: n, total, currency, shop: shop.name };
  }

  sell(openid, { itemName, qty = 1 }) {
    const n = Math.max(1, Math.trunc(Number(qty) || 1));
    const cfg = this.#cfg();
    const rate = Number(cfg.sell_rate ?? 0.5);
    const item = this.content.db.prepare('SELECT * FROM item WHERE name = ? AND enabled = 1').get(String(itemName));
    if (!item) return { error: 'no_item', name: itemName };
    if (!item.tradeable) return { error: 'not_tradeable', name: item.name };
    const price = Math.max(1, Math.round(Number(item.price) * rate)) * n;
    try {
      this.trade(openid, {
        pay: { items: [{ id: item.id, qty: n }] },
        gain: { gold: price },
        reason: `出售 ${item.name}×${n}`,
      });
    } catch (e) {
      return { error: 'trade', message: e.message };
    }
    return { ok: true, item: item.name, qty: n, gold: price };
  }

  /* ================= 银行 ================= */

  /** 取银行状态（顺便结息） */
  bank(openid) {
    let row = this.db.prepare('SELECT * FROM bank WHERE openid = ?').get(openid);
    if (!row) {
      this.db.prepare('INSERT INTO bank (openid, deposit, loan, last_interest_at) VALUES (?,0,0,?)').run(openid, now());
      row = this.db.prepare('SELECT * FROM bank WHERE openid = ?').get(openid);
    }
    return this.#accrue(openid, row);
  }

  /** 按周期结息：存款生息、贷款计费 */
  #accrue(openid, row) {
    const cfg = this.#cfg();
    const hours = Math.max(1, Number(cfg.bank_interest_hours ?? 24));
    const periodMs = hours * 3600_000;
    const elapsed = now() - Number(row.last_interest_at || 0);
    if (elapsed < periodMs) return row;

    const periods = Math.floor(elapsed / periodMs);
    const dRate = Number(cfg.bank_interest_rate ?? 0.01);
    const lRate = Number(cfg.loan_rate ?? 0.02);
    let deposit = Number(row.deposit);
    let loan = Number(row.loan);
    for (let i = 0; i < periods; i += 1) {
      deposit = Math.round(deposit * (1 + dRate));
      loan = Math.round(loan * (1 + lRate));
    }
    const last = Number(row.last_interest_at) + periods * periodMs;
    this.db.prepare('UPDATE bank SET deposit = ?, loan = ?, last_interest_at = ? WHERE openid = ?').run(deposit, loan, last, openid);
    return { ...row, deposit, loan, last_interest_at: last, accrued: periods };
  }

  deposit(openid, amount) {
    const n = Math.trunc(Number(amount) || 0);
    if (n <= 0) return { error: 'bad_amount' };
    const b = this.bank(openid);
    try {
      this.trade(openid, { pay: { gold: n }, reason: '银行存款' });
    } catch (e) {
      return { error: 'trade', message: e.message };
    }
    this.db.prepare('UPDATE bank SET deposit = deposit + ? WHERE openid = ?').run(n, openid);
    return { ok: true, deposit: Number(b.deposit) + n };
  }

  withdraw(openid, amount) {
    const n = Math.trunc(Number(amount) || 0);
    if (n <= 0) return { error: 'bad_amount' };
    const b = this.bank(openid);
    if (Number(b.deposit) < n) return { error: 'no_deposit', have: Number(b.deposit) };
    this.db.prepare('UPDATE bank SET deposit = deposit - ? WHERE openid = ?').run(n, openid);
    this.trade(openid, { gain: { gold: n }, reason: '银行取款' });
    return { ok: true, deposit: Number(b.deposit) - n };
  }

  loan(openid, amount) {
    const n = Math.trunc(Number(amount) || 0);
    if (n <= 0) return { error: 'bad_amount' };
    const b = this.bank(openid);
    const cap = 10000;
    if (Number(b.loan) + n > cap) return { error: 'over_cap', cap, have: Number(b.loan) };
    this.db.prepare('UPDATE bank SET loan = loan + ? WHERE openid = ?').run(n, openid);
    this.trade(openid, { gain: { gold: n }, reason: '银行贷款' });
    return { ok: true, loan: Number(b.loan) + n };
  }

  repay(openid, amount) {
    const n = Math.trunc(Number(amount) || 0);
    if (n <= 0) return { error: 'bad_amount' };
    const b = this.bank(openid);
    if (Number(b.loan) <= 0) return { error: 'no_loan' };
    const pay = Math.min(n, Number(b.loan));
    try {
      this.trade(openid, { pay: { gold: pay }, reason: '银行贷款还款' });
    } catch (e) {
      return { error: 'trade', message: e.message };
    }
    this.db.prepare('UPDATE bank SET loan = loan - ? WHERE openid = ?').run(pay, openid);
    return { ok: true, paid: pay, loan: Number(b.loan) - pay };
  }

  /* ================= 拍卖 ================= */

  /** 挂单：物品立刻从背包扣掉（避免一物多卖） */
  auctionList(openid, { itemName, qty = 1, price }) {
    const n = Math.max(1, Math.trunc(Number(qty) || 1));
    const p = Math.trunc(Number(price) || 0);
    if (p <= 0) return { error: 'bad_price' };
    const item = this.content.db.prepare('SELECT * FROM item WHERE name = ? AND enabled = 1').get(String(itemName));
    if (!item) return { error: 'no_item', name: itemName };
    if (!item.tradeable) return { error: 'not_tradeable', name: item.name };

    const cfg = this.#cfg();
    const hours = Math.max(1, Number(cfg.auction_hours ?? 24));
    try {
      this.trade(openid, { pay: { items: [{ id: item.id, qty: n }] }, reason: `拍卖上架 ${item.name}×${n}` });
    } catch (e) {
      return { error: 'trade', message: e.message };
    }
    const r = this.db
      .prepare(
        `INSERT INTO auction (seller, kind, ref_id, qty, price, currency, status, created_at, expire_at)
         VALUES (?,'item',?,?,?, 'gold','open',?,?)`,
      )
      .run(openid, item.id, n, p, now(), now() + hours * 3600_000);
    return { ok: true, id: Number(r.lastInsertRowid), item: item.name, qty: n, price: p, hours };
  }

  /** 过期处理：到期未卖出的自动下架并退回物品 */
  #expireAuctions() {
    const rows = this.db.prepare("SELECT * FROM auction WHERE status = 'open' AND expire_at <= ?").all(now());
    for (const a of rows) {
      this.db.prepare("UPDATE auction SET status = 'expired' WHERE id = ?").run(a.id);
      this.players.addItem(a.seller, a.ref_id, a.qty, `拍卖过期退回 #${a.id}`);
    }
    return rows.length;
  }

  auctions(limit = 10) {
    this.#expireAuctions();
    return this.db
      .prepare("SELECT * FROM auction WHERE status = 'open' ORDER BY id DESC LIMIT ?")
      .all(Math.min(50, Math.max(1, Number(limit) || 10)))
      .map((a) => {
        const item = this.content.db.prepare('SELECT name FROM item WHERE id = ?').get(a.ref_id);
        const seller = this.players.get(a.seller);
        return { ...a, itemName: item?.name ?? `#${a.ref_id}`, sellerName: seller?.name ?? '???' };
      });
  }

  myAuctions(openid) {
    this.#expireAuctions();
    return this.db
      .prepare('SELECT * FROM auction WHERE seller = ? ORDER BY id DESC LIMIT 20')
      .all(openid)
      .map((a) => {
        const item = this.content.db.prepare('SELECT name FROM item WHERE id = ?').get(a.ref_id);
        return { ...a, itemName: item?.name ?? `#${a.ref_id}` };
      });
  }

  /** 竞拍：买家付钱，卖家收钱（扣手续费），物品归买家 */
  auctionBid(openid, auctionId) {
    this.#expireAuctions();
    const a = this.db.prepare('SELECT * FROM auction WHERE id = ?').get(Number(auctionId));
    if (!a) return { error: 'no_auction' };
    if (a.status !== 'open') return { error: 'not_open', status: a.status };
    if (a.seller === openid) return { error: 'own' };

    const cfg = this.#cfg();
    const feeRate = Number(cfg.auction_fee_rate ?? 0.05);
    const price = Number(a.price);
    const income = Math.max(1, Math.round(price * (1 - feeRate)));

    try {
      this.trade(openid, {
        pay: { gold: price },
        gain: { items: [{ id: a.ref_id, qty: a.qty }] },
        reason: `拍卖成交 #${a.id}`,
      });
    } catch (e) {
      return { error: 'trade', message: e.message };
    }
    /**
     * 卖家收款走**邮件**，不是直接进钱包。
     * 卖家多半不在场，直接加钱他永远不知道自己卖了多少；走邮件上线能看到。
     */
    const item = this.content.db.prepare('SELECT name FROM item WHERE id = ?').get(a.ref_id);
    if (this.mail) {
      this.mail.send(a.seller, {
        title: '拍卖成交',
        body: `#${a.id} 的 ${item?.name ?? '物品'} 已卖出，扣 ${Math.round(feeRate * 100)}% 手续费。`,
        attachments: { gold: income },
      });
    } else {
      this.players.addGold(a.seller, income, `拍卖收入 #${a.id}`);
    }
    this.db.prepare("UPDATE auction SET status = 'sold', buyer = ? WHERE id = ?").run(openid, a.id);
    return { ok: true, item: item?.name ?? '', qty: a.qty, price, fee: price - income, seller: a.seller };
  }

  auctionCancel(openid, auctionId) {
    const a = this.db.prepare('SELECT * FROM auction WHERE id = ?').get(Number(auctionId));
    if (!a) return { error: 'no_auction' };
    if (a.seller !== openid) return { error: 'not_owner' };
    if (a.status !== 'open') return { error: 'not_open', status: a.status };
    this.db.prepare("UPDATE auction SET status = 'cancelled' WHERE id = ?").run(a.id);
    this.players.addItem(openid, a.ref_id, a.qty, `拍卖下架退回 #${a.id}`);
    return { ok: true };
  }

  /* ================= 抽奖 ================= */

  prizes() {
    return this.content.db.prepare('SELECT * FROM lottery_prize WHERE enabled = 1 ORDER BY id').all();
  }

  draw(openid, times = 1) {
    const n = Math.max(1, Math.min(10, Math.trunc(Number(times) || 1)));
    const cfg = this.#cfg();
    const cost = Math.max(0, Number(cfg.lottery_cost ?? 100)) * n;
    const pool = this.prizes();
    if (!pool.length) return { error: 'no_prize' };

    const p = this.players.get(openid);
    if (!p) return { error: 'no_player' };
    if (Number(p.gold) < cost) return { error: 'no_gold', need: cost, have: Number(p.gold) };

    // 先抽完再一次性发奖：避免中途失败出现「扣了钱只发一半」
    const results = [];
    for (let i = 0; i < n; i += 1) results.push(this.#pickPrize(pool));

    const gain = { items: [], equips: [], companions: [], gold: 0, coupon: 0 };
    for (const r of results) {
      if (r.kind === 'gold') gain.gold += Number(r.qty);
      else if (r.kind === 'coupon') gain.coupon += Number(r.qty);
      else if (r.kind === 'item') gain.items.push({ id: r.ref_id, qty: Number(r.qty) });
      else if (r.kind === 'equip') for (let k = 0; k < Number(r.qty); k += 1) gain.equips.push(r.ref_id);
      else if (r.kind === 'companion') for (let k = 0; k < Number(r.qty); k += 1) gain.companions.push(r.ref_id);
    }

    try {
      this.trade(openid, { pay: { gold: cost }, gain, reason: `抽奖 ×${n}` });
    } catch (e) {
      return { error: 'trade', message: e.message };
    }
    return { ok: true, cost, results };
  }

  #pickPrize(pool) {
    const total = pool.reduce((s, x) => s + Math.max(1, Number(x.weight)), 0);
    let roll = Math.random() * total;
    for (const x of pool) {
      roll -= Math.max(1, Number(x.weight));
      if (roll <= 0) return x;
    }
    return pool[pool.length - 1];
  }

  /* ================= 月卡 ================= */

  monthly(openid) {
    const row = this.db.prepare('SELECT * FROM monthly_card WHERE openid = ?').get(openid);
    const cfg = this.#cfg();
    const active = Boolean(row && Number(row.expire_at) > now());
    const canClaim = Boolean(active && Number(row.last_claim_at) < startOfToday());
    return {
      active,
      expireAt: Number(row?.expire_at ?? 0),
      lastClaimAt: Number(row?.last_claim_at ?? 0),
      canClaim,
      dailyGold: Number(cfg.monthly_card_daily_gold ?? 100),
      price: Number(cfg.monthly_card_price ?? 300),
      days: Number(cfg.monthly_card_days ?? 30),
    };
  }

  buyMonthly(openid) {
    const cfg = this.#cfg();
    const price = Number(cfg.monthly_card_price ?? 300);
    const days = Number(cfg.monthly_card_days ?? 30);
    const cur = this.db.prepare('SELECT * FROM monthly_card WHERE openid = ?').get(openid);
    const base = Math.max(now(), Number(cur?.expire_at ?? 0));
    try {
      this.trade(openid, { pay: { coupon: price }, reason: `购买月卡 ${days} 天` });
    } catch (e) {
      return { error: 'trade', message: e.message };
    }
    this.db
      .prepare(
        `INSERT INTO monthly_card (openid, expire_at, bought_at, last_claim_at) VALUES (?,?,?,?)
         ON CONFLICT(openid) DO UPDATE SET expire_at = excluded.expire_at, bought_at = excluded.bought_at`,
      )
      .run(openid, base + days * 86400_000, now(), Number(cur?.last_claim_at ?? 0));
    return { ok: true, expireAt: base + days * 86400_000, days, price };
  }

  claimMonthly(openid) {
    const m = this.monthly(openid);
    if (!m.active) return { error: 'not_active' };
    if (!m.canClaim) return { error: 'claimed' };
    this.db.prepare('UPDATE monthly_card SET last_claim_at = ? WHERE openid = ?').run(now(), openid);
    this.players.addGold(openid, m.dailyGold, '月卡每日领取');
    return { ok: true, gold: m.dailyGold };
  }

  /* ================= CDK ================= */

  redeem(openid, code) {
    const key = String(code ?? '').trim().toUpperCase();
    if (!key) return { error: 'bad_code' };
    const row = this.db.prepare('SELECT * FROM cdk WHERE code = ?').get(key);
    if (!row) return { error: 'no_code' };
    if (Number(row.expire_at) && Number(row.expire_at) < now()) return { error: 'expired' };
    if (Number(row.used) >= Number(row.max_uses)) return { error: 'used_up' };

    let reward = {};
    try {
      reward = JSON.parse(row.rewards || '{}');
    } catch {
      reward = {};
    }
    try {
      this.trade(openid, {
        gain: {
          gold: Number(reward.gold ?? 0),
          coupon: Number(reward.coupon ?? 0),
          items: Array.isArray(reward.items) ? reward.items : [],
          equips: Array.isArray(reward.equips) ? reward.equips : [],
          companions: Array.isArray(reward.companions) ? reward.companions : [],
        },
        reason: `兑换码 ${key}`,
      });
    } catch (e) {
      return { error: 'trade', message: e.message };
    }
    this.db
      .prepare('UPDATE cdk SET used = used + 1, used_by = ? WHERE code = ?')
      .run(`${row.used_by}${row.used_by ? ',' : ''}${openid}`, key);
    return { ok: true, reward };
  }

  /** 生成兑换码（面板用） */
  createCdk(code, rewards, { maxUses = 1, expireHours = 0 } = {}) {
    const key = String(code).trim().toUpperCase();
    if (!key) throw new Error('兑换码不能为空');
    this.db
      .prepare('INSERT INTO cdk (code, rewards, max_uses, used, expire_at, created_at) VALUES (?,?,?,0,?,?)')
      .run(key, JSON.stringify(rewards ?? {}), Math.max(1, Number(maxUses) || 1), expireHours ? now() + expireHours * 3600_000 : 0, now());
    return { ok: true, code: key };
  }

  /** 经济概览：面板首页要看的总量 */
  overview() {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(gold),0) gold, COALESCE(SUM(coupon),0) coupon FROM player')
      .get();
    const bankRow = this.db.prepare('SELECT COALESCE(SUM(deposit),0) dep, COALESCE(SUM(loan),0) loan FROM bank').get();
    const openAuctions = this.db.prepare("SELECT COUNT(*) n FROM auction WHERE status='open'").get().n;
    return { gold: row.gold, coupon: row.coupon, deposit: bankRow.dep, loan: bankRow.loan, openAuctions };
  }
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

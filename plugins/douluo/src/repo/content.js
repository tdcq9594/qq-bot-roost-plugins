/**
 * 内容库访问层
 * ============
 *
 * 全部内容表共用一个泛型 CRUD：列信息从 `PRAGMA table_info` 现取，
 * 所以以后加列**不用改这里，也不用改前端**——面板会自动多出输入框。
 *
 * 安全边界：
 *   - 表名必须存在于 sqlite_master（白名单），否则直接拒绝
 *   - 列名必须来自 PRAGMA 结果，不接受前端传来的任意列
 *   - 值统一走预处理语句的参数位，不拼字符串
 */

/** 这些表不给面板改：系统表 / 关联表（复合主键，单独处理） */
const READONLY_TABLES = new Set(['content_meta', 'monster_map']);

export class ContentRepo {
  constructor(db) {
    this.db = db;
    this._tables = null;
    this._cols = new Map();
  }

  /** 所有可管理的表名 */
  tables() {
    if (!this._tables) {
      this._tables = this.db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name`,
        )
        .all()
        .map((r) => r.name);
    }
    return this._tables;
  }

  has(table) {
    return this.tables().includes(String(table));
  }

  /** PRAGMA table_info → [{name, type, pk, notnull, dflt_value}] */
  columns(table) {
    if (!this.has(table)) throw new Error(`没有这张内容表：${table}`);
    if (!this._cols.has(table)) {
      this._cols.set(
        table,
        this.db
          .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
          .all()
          .map((c) => ({
            name: c.name,
            type: String(c.type || '').toUpperCase(),
            pk: Number(c.pk) > 0,
            notNull: Number(c.notnull) === 1,
            default: c.dflt_value,
          })),
      );
    }
    return this._cols.get(table);
  }

  /** 主键列名数组；复合主键会有多个 */
  pkOf(table) {
    return this.columns(table)
      .filter((c) => c.pk)
      .map((c) => c.name);
  }

  writable(table) {
    return this.has(table) && !READONLY_TABLES.has(table);
  }

  /**
   * 列表。`q` 会对所有 TEXT 列做 LIKE，够用且不用前端传字段名。
   */
  list(table, { q = '', page = 1, size = 50 } = {}) {
    if (!this.has(table)) throw new Error(`没有这张内容表：${table}`);
    const cols = this.columns(table);
    const where = [];
    const params = [];
    const kw = String(q || '').trim();
    if (kw) {
      const textCols = cols.filter((c) => c.type.includes('TEXT') || c.type === '').map((c) => c.name);
      if (textCols.length) {
        where.push('(' + textCols.map((c) => `${quoteIdent(c)} LIKE ?`).join(' OR ') + ')');
        for (let i = 0; i < textCols.length; i += 1) params.push(`%${kw}%`);
      }
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const pk = this.pkOf(table);
    const orderSql = pk.length ? ` ORDER BY ${pk.map(quoteIdent).join(', ')}` : '';

    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}${whereSql}`).get(...params).n;

    const lim = Math.min(500, Math.max(1, Number(size) || 50));
    const pg = Math.max(1, Number(page) || 1);
    const rows = this.db
      .prepare(`SELECT * FROM ${quoteIdent(table)}${whereSql}${orderSql} LIMIT ? OFFSET ?`)
      .all(...params, lim, (pg - 1) * lim);

    return { table, columns: cols, pk, rows, total, page: pg, size: lim, readonly: READONLY_TABLES.has(table) };
  }

  get(table, pkValues) {
    const pk = this.pkOf(table);
    if (!pk.length) return null;
    const where = pk.map((c) => `${quoteIdent(c)} = ?`).join(' AND ');
    return this.db.prepare(`SELECT * FROM ${quoteIdent(table)} WHERE ${where}`).get(...pk.map((c) => pkValues[c])) ?? null;
  }

  /** 只保留表里真实存在的列 */
  #pick(table, row) {
    const allowed = new Set(this.columns(table).map((c) => c.name));
    const out = {};
    for (const [k, v] of Object.entries(row ?? {})) {
      if (allowed.has(k)) out[k] = v;
    }
    return out;
  }

  insert(table, row) {
    if (!this.writable(table)) throw new Error(`${table} 不允许通过面板写入`);
    const data = this.#pick(table, row);
    const keys = Object.keys(data);
    if (!keys.length) throw new Error('没有可写入的字段');
    const sql = `INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(', ')})
                 VALUES (${keys.map(() => '?').join(', ')})`;
    const r = this.db.prepare(sql).run(...keys.map((k) => data[k]));
    this._tables = null;
    return { ok: true, id: Number(r.lastInsertRowid) };
  }

  update(table, pkValues, row) {
    if (!this.writable(table)) throw new Error(`${table} 不允许通过面板写入`);
    const pk = this.pkOf(table);
    if (!pk.length) throw new Error(`${table} 没有主键，无法定位记录`);
    const data = this.#pick(table, row);
    const keys = Object.keys(data).filter((k) => !pk.includes(k));
    if (!keys.length) throw new Error('没有需要更新的字段');
    const sql = `UPDATE ${quoteIdent(table)} SET ${keys.map((k) => `${quoteIdent(k)} = ?`).join(', ')}
                  WHERE ${pk.map((c) => `${quoteIdent(c)} = ?`).join(' AND ')}`;
    const r = this.db
      .prepare(sql)
      .run(...keys.map((k) => data[k]), ...pk.map((c) => pkValues[c]));
    return { ok: true, changes: Number(r.changes) };
  }

  remove(table, pkValues) {
    if (!this.writable(table)) throw new Error(`${table} 不允许通过面板删除`);
    const pk = this.pkOf(table);
    if (!pk.length) throw new Error(`${table} 没有主键，无法定位记录`);
    const where = pk.map((c) => `${quoteIdent(c)} = ?`).join(' AND ');
    const r = this.db.prepare(`DELETE FROM ${quoteIdent(table)} WHERE ${where}`).run(...pk.map((c) => pkValues[c]));
    return { ok: true, changes: Number(r.changes) };
  }

  /** 每张表的行数，给面板首页用 */
  counts() {
    const out = [];
    for (const t of this.tables()) {
      try {
        const n = this.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(t)}`).get().n;
        out.push({ table: t, rows: n, readonly: READONLY_TABLES.has(t) });
      } catch {
        out.push({ table: t, rows: 0, readonly: true });
      }
    }
    return out;
  }

  /** 读一个系数 */
  cfg(key, fallback = null) {
    const r = this.db.prepare('SELECT value, type FROM cfg WHERE key = ?').get(String(key));
    if (!r) return fallback;
    if (r.type === 'number') {
      const n = Number(r.value);
      return Number.isFinite(n) ? n : fallback;
    }
    if (r.type === 'bool') return r.value === '1' || r.value === 'true';
    return r.value;
  }

  /** 全部系数，转成 JS 值。业务层每次用的时候现取，改完即时生效 */
  allCfg() {
    const out = {};
    for (const r of this.db.prepare('SELECT key, value, type FROM cfg').all()) {
      if (r.type === 'number') {
        const n = Number(r.value);
        out[r.key] = Number.isFinite(n) ? n : 0;
      } else if (r.type === 'bool') {
        out[r.key] = r.value === '1' || r.value === 'true';
      } else {
        out[r.key] = r.value;
      }
    }
    return out;
  }
}

/** SQLite 标识符转义：只允许常规字符，再用双引号包起来 */
function quoteIdent(name) {
  const s = String(name);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error(`非法标识符：${s}`);
  return `"${s}"`;
}

/**
 * 加成汇总（纯函数）
 * ================
 *
 * 为什么不做成 `modifier` 表：加成是**推导数据**。
 * 一旦落表，穿装备/脱装备/改内容表都要记得同步，迟早对不上；
 * 而且「谁给了多少加成」随时能从 `equip_owned ⨝ equip` 算出来。
 * 所以这里做成一个纯函数：输入当前装备，输出加成明细。
 *
 * 这样面板能直接回答「我的攻击为什么是 4081」——
 * 基础 + 魂环 + 每件装备 + 套装，一条一条列出来。同类插件给不了这个。
 */

/** 参与加成的属性，顺序固定（面板按这个顺序展示） */
export const ATTRS = ['hp', 'mp', 'atk', 'def', 'spd', 'str', 'intel', 'dodge', 'crit', 'crit_dmg'];

/** 属性中文名，给面板和游戏内文案用 */
export const ATTR_LABEL = {
  hp: '生命',
  mp: '魂力',
  atk: '攻击',
  def: '防御',
  spd: '速度',
  str: '力量',
  intel: '智力',
  dodge: '闪避',
  crit: '暴击',
  crit_dmg: '暴伤',
};

/** 装备等级对属性的放大：每级 +10%（强化以后会用到） */
const LEVEL_RATE = 0.1;

const emptyFlat = () => Object.fromEntries(ATTRS.map((a) => [a, 0]));

/**
 * @param {{
 *   equipped?:object[], companions?:object[], setBonuses?:Array<{need:number,attrs:object,name:string}>,
 *   equipRate?:number, compRate?:number
 * }} p
 *        equipped / companions 每一项的字段名与内容表一致（atk/def/hp…），外加 level
 *        companions 里 kind='card' 的按「收集即生效」处理，其余按「出战才生效」——
 *        这个筛选由调用方做，这里只管汇总
 * @returns {{flat:object, sources:object[], sets:object[]}}
 */
export function collectModifiers({ equipped = [], companions = [], setBonuses = [], buffs = [], extras = [], equipRate = LEVEL_RATE, compRate = LEVEL_RATE } = {}) {
  const flat = emptyFlat();
  const sources = [];
  let mult = 0;

  const add = (list, type, rate) => {
    for (const e of list) {
      const lv = Math.max(1, Number(e.level ?? 1));
      const k = 1 + rate * (lv - 1);
      const attrs = {};
      for (const a of ATTRS) {
        const base = Number(e[a] ?? 0);
        if (!base) continue;
        const v = Math.round(base * k);
        attrs[a] = v;
        flat[a] += v;
      }
      if (Object.keys(attrs).length) {
        sources.push({
          type,
          id: e.equip_id ?? e.companion_id ?? e.id,
          name: e.name,
          kind: e.kind,
          part: e.part,
          level: lv,
          attrs,
        });
      }
    }
  };

  add(equipped, 'equip', equipRate);
  add(companions, 'companion', compRate);

  // 套装：setBonuses 由调用方按「已装备件数」算好传进来，这里只做汇总
  const sets = [];
  for (const b of setBonuses) {
    const attrs = {};
    for (const a of ATTRS) {
      const v = Number(b.attrs?.[a] ?? 0);
      if (!v) continue;
      attrs[a] = v;
      flat[a] += v;
    }
    if (Object.keys(attrs).length) {
      sources.push({ type: 'set', name: b.name, need: b.need, attrs });
      sets.push({ name: b.name, need: b.need, attrs });
    }
  }

  /**
   * extras：功法/血脉这类「学会就永久加」的来源。
   * 走独立通道而不是塞进 equipped，是因为它们不该吃装备的等级系数，
   * 也不该被乘区放大两次。
   */
  for (const x of extras) {
    const attrs = {};
    for (const a of ATTRS) {
      const v = Number(x.attrs?.[a] ?? 0);
      if (!v) continue;
      attrs[a] = v;
      flat[a] += v;
    }
    if (Object.keys(attrs).length) sources.push({ type: 'aptitude', name: x.name, attrs });
  }

  // 乘区来源：宗门等级这类按比例给的全属性增益
  for (const b of buffs) {
    const pct = Number(b.pct ?? 0);
    if (!pct) continue;
    mult += pct;
    sources.push({ type: 'buff', name: b.name, pct });
  }

  return { flat, mult, sources, sets };
}

/**
 * 从「已装备列表」算出套装效果。
 *
 * @param {object[]} equipped 每项含 set_id
 * @param {Map<number,{name:string,bonus:string}>} setTable
 * @returns {Array<{name:string, need:number, attrs:object}>}
 */
export function computeSetBonuses(equipped, setTable) {
  const countBySet = new Map();
  for (const e of equipped) {
    const sid = Number(e.set_id ?? 0);
    if (!sid) continue;
    countBySet.set(sid, (countBySet.get(sid) ?? 0) + 1);
  }

  const out = [];
  for (const [sid, count] of countBySet) {
    const meta = setTable.get(sid);
    if (!meta) continue;
    let bonus = {};
    try {
      bonus = JSON.parse(meta.bonus || '{}');
    } catch {
      bonus = {};
    }
    // 只取「件数 <= 当前件数」的最高档，多档可以叠加（2 件档 + 4 件档都生效）
    const tiers = Object.keys(bonus)
      .map((k) => ({ need: Number(k), attrs: bonus[k] }))
      .filter((t) => Number.isFinite(t.need) && t.need > 0 && count >= t.need)
      .sort((a, b) => a.need - b.need);
    for (const t of tiers) {
      out.push({ name: meta.name, need: t.need, attrs: t.attrs });
    }
  }
  return out;
}

/** 把 flat 加成描述成一行行文字，给「属性从哪来」用 */
export function describeSources(sources) {
  return sources.map((s) => {
    const parts = ATTRS.filter((a) => s.attrs[a]).map((a) => `${ATTR_LABEL[a]}+${s.attrs[a]}`);
    const tag = s.type === 'set' ? `套装 ${s.name}（${s.need} 件）` : s.name;
    return { tag, text: parts.join(' · ') };
  });
}

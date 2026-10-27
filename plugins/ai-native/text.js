/**
 * 中文分词（记忆检索和知识库共用）。
 *
 * 为什么不引分词库：中文没有空格，正经分词要么带词典（体积大）、要么上模型
 * （慢且要 Key）。群聊里的查询都很短（「他喜欢吃啥」「魂环怎么升」），
 * **双字组合 + 单字兜底**已经够用——比整串子串匹配强得多，又不用养一个 jieba。
 *
 * 权重：整段命中 > 拉丁词 > 中文双字 > 单字。
 * 单字必须留：「我的猫叫什么」里的「猫」两边都没有相同邻字，纯双字匹配会漏。
 * 代价是「我」「的」这类虚词会命中一切，所以配一张小停用词表压掉。
 */

const STOP_CHARS = new Set('我你他她它们的了是在有和就不也都这那什么吗呢啊吧着过很还个'.split(''));

/** 整段作为一个词的上限：太长就没有「整段命中」的意义了 */
const WHOLE_MAX = 8;

/**
 * 切成带权重的词条（可重复）。文档侧和查询侧共用同一个切法，
 * 否则两边词表对不上，BM25 的 tf/idf 全是 0。
 *
 * @returns {Array<{ t: string, w: number }>}
 */
function rawTerms(s) {
  const text = String(s || '').toLowerCase();
  const out = [];

  for (const w of text.match(/[a-z0-9_]{2,}/g) || []) out.push({ t: w, w: 1.5 });

  const segs = text.replace(/[^\u4e00-\u9fa5]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  for (const seg of segs) {
    if (seg.length <= WHOLE_MAX) out.push({ t: seg, w: 2 });
    for (let i = 0; i < seg.length; i++) {
      const ch = seg[i];
      if (!STOP_CHARS.has(ch)) out.push({ t: ch, w: 0.4 });
      if (i + 1 < seg.length) out.push({ t: seg.slice(i, i + 2), w: 1 });
    }
  }
  return out;
}

/** 文档侧：每个词出现几次（忽略权重，权重只作用在查询侧） */
export function termCounts(s) {
  const m = new Map();
  for (const { t } of rawTerms(s)) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** 查询侧：词 → 权重（同一词取最大权重） */
export function queryTerms(s) {
  const m = new Map();
  for (const { t, w } of rawTerms(s)) m.set(t, Math.max(m.get(t) ?? 0, w));
  return m;
}

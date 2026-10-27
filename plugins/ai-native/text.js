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

/**
 * 疑问词和客套话，只在**查询侧**剥掉。
 *
 * 为什么不剥文档：文档是陈述句，不会写「怎么」；而群里提问几乎都带
 * 「怎么 / 什么 / 多少 / 吗」。不剥的话这些词会占掉查询权重的一大半，
 * 把真正的主语稀释到覆盖率门槛以下——「魂骨怎么获得」就搜不到「魂骨规则」，
 * 而「今天股市怎么样」误命中「魂环怎么升」又必须被挡住。
 * 剥完两边才对得上：前者变成「魂骨 获得」直接命中，后者只剩「今天股市」完全落空。
 */
const ASK_WORDS =
  '为什么|为啥|怎么样|怎么办|怎么|怎样|如何|什么|啥|多少|哪些|哪个|哪里|哪儿|' +
  '有没有|是不是|能不能|可不可以|会不会|要不要|行不行|对不对|' +
  '请问|想问问|问一下|告诉我|一下';
const ASK_RE = new RegExp(ASK_WORDS, 'g');
/** 句末语气词，出现在查询里一律没有信息量 */
const PARTICLE_RE = /[吗呢吧啊呀哦嘛]+/g;

function stripAsk(s) {
  return String(s).replace(ASK_RE, ' ').replace(PARTICLE_RE, ' ');
}

/** 文档侧：每个词出现几次（忽略权重，权重只作用在查询侧） */
export function termCounts(s) {
  const m = new Map();
  for (const { t } of rawTerms(s)) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** 查询侧：词 → 权重（同一词取最大权重）。先剥疑问词，否则主语被稀释 */
export function queryTerms(s) {
  const m = new Map();
  for (const { t, w } of rawTerms(stripAsk(s))) m.set(t, Math.max(m.get(t) ?? 0, w));
  return m;
}

/**
 * 粗估 token 数。
 *
 * 为什么不装 tiktoken：它是 WASM 包（几 MB）+ 每种模型一套词表，而我们只需要
 * 「别把窗口撑爆」这个量级判断，差 20% 完全无所谓。经验值：中文 1 字≈1 token，
 * 英文/数字约 4 字符≈1 token，代码和 JSON 比自然语言费一点，所以给 3.6。
 *
 * 想更准的话：把这里的系数按自己主用模型的实际 usage 标定一次即可。
 */
export function estimateTokens(s) {
  const text = typeof s === 'string' ? s : JSON.stringify(s ?? '');
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    // 中日韩统一表意文字 + 全角标点，按字算
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 3.6);
}


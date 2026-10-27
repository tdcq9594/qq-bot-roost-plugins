/**
 * 知识库：把一个目录里的文本文件切块、建倒排索引，按 BM25 检索。
 * 配了 embedding 服务商就**再叠一层向量检索**，两路结果用 RRF 融合。
 *
 * 为什么默认不走向量：RAG 那套要额外的 Key、额外的网络请求、额外的钱，还得
 * 管一个向量库进程。而群机器人要回答的多半是「魂环怎么升」「指令有哪些」这种
 * **词面就能对上**的问题——BM25 在中文短查询上的效果并不比小模型 embedding
 * 差多少，成本却为零。
 *
 * 什么时候值得开向量：用户老用同义改写提问（「咋升级」对「如何提升」），
 * 或者文档里根本没有提问用的那个词。开的方式是填一个 embedding 模型名，
 * 不填就一直是纯 BM25——检索层可换，但默认不给你加成本。
 *
 * 目录：`<dataDir>/knowledge/`，支持 .md / .txt / .markdown / .log / .html。
 * 用户往里丢文件 → `/ai 知识 重建` 重新索引。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { termCounts, queryTerms } from './text.js';

const EXT = new Set(['.md', '.markdown', '.txt', '.log', '.html', '.htm']);
const MAX_FILE = 512 * 1024; // 单文件上限，别让一个巨型日志把内存吃满
const CHUNK = 400; // 每块目标字数
const OVERLAP = 60; // 相邻块重叠，避免答案正好被切断
const K1 = 1.2; // BM25 词频饱和参数（Lucene 默认）
const B = 0.75; // BM25 长度归一参数（Lucene 默认）
/** 命中门槛：这一段至少覆盖查询权重的多少比例，才认为「讲的是同一件事」 */
const MIN_COVER = 0.25;
/** RRF 融合常数（业界默认 60）：压住「某一路排第一」的优势，奖励两路都靠前 */
const RRF_K = 60;
/** 向量索引的块数上限：再大就别在机器人进程里算了，该上真向量库 */
const MAX_VEC_CHUNKS = 5000;

/**
 * 把 HTML 压成纯文本。
 *
 * 为什么不引 cheerio/jsdom：知识库里的 html 多半是文档导出页，要的只是正文，
 * 正则剥标签够用；引一个 DOM 解析器就为了这个，等于给零依赖插件加个依赖树。
 * 顺序很重要：先整块删 script/style（里面的 JS 会被当正文），再删标签。
 */
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // 块级标签换行，避免两段正文粘成一句
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 把长文切成块：先按空行分段，再把段落攒到 CHUNK 左右 */
function splitChunks(text) {
  const paras = String(text)
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let buf = '';
  const flush = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
    buf = '';
  };

  for (const p of paras) {
    if (p.length > CHUNK * 1.5) {
      // 单个段落太长：硬切，并留一点重叠
      flush();
      for (let i = 0; i < p.length; i += CHUNK - OVERLAP) {
        chunks.push(p.slice(i, i + CHUNK));
        if (i + CHUNK >= p.length) break;
      }
      continue;
    }
    if (buf.length + p.length + 2 > CHUNK) flush();
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  flush();
  return chunks;
}

export function createKnowledge({ conf, dataDir, log = {}, embed = null }) {
  const dir = path.join(dataDir, 'knowledge');
  /** @type {null | {chunks:Array, df:Map<string,number>, avgdl:number, docs:Array, at:number, vec:boolean}} */
  let idx = null;
  let building = null;
  /**
   * 每个文件切好的块，按 mtime+size 缓存。
   * 重建时没变的文件直接复用，不用重读重切——目录里堆了几十篇文档时
   * 「改一篇就全量重切」会明显卡一下。
   */
  const fileCache = new Map();

  /**
   * 向量缓存：按**块文本的 hash** 存，不是按文件名存。
   *
   * 为什么不按文件：改文档里一个字，整个文件的块号可能全变，按文件名缓存
   * 就得整篇重算；按文本 hash 存的话只有真正变了的那几块要重新请求，
   * 加一篇新文档也不会碰老文档的向量。落盘到 `.embeddings.json`
   * （点开头 + .json 不在 EXT 里，不会被当知识文件索引）。
   */
  const vecFile = path.join(dir, '.embeddings.json');
  let vecStore = null; // { model, map: Map<hash, Float32Array> }
  /** 上次向量失败的原因。非空就不再每轮重试，免得每句话都白等一次超时 */
  let vecBroken = '';

  const hashOf = (s) => createHash('sha256').update(s).digest('hex').slice(0, 20);

  /** 读 embedding 配置。面板里 json 类型可能存成字符串，这里统一消化 */
  function embeddingOf() {
    let e;
    try {
      e = conf()?.embedding;
    } catch {
      return null;
    }
    if (typeof e === 'string') {
      try {
        e = JSON.parse(e);
      } catch {
        return null;
      }
    }
    return e && typeof e === 'object' ? e : null;
  }

  async function loadVecStore(model) {
    if (vecStore && vecStore.model === model) return vecStore;
    vecStore = { model, map: new Map() };
    try {
      const raw = JSON.parse(await fs.readFile(vecFile, 'utf8'));
      // 换了向量模型维度就不一样，旧的全作废
      if (raw?.model === model && raw.map) {
        for (const [k, v] of Object.entries(raw.map)) {
          if (Array.isArray(v) && v.length) vecStore.map.set(k, Float32Array.from(v));
        }
      }
    } catch {
      /* 没有缓存文件是正常情况 */
    }
    return vecStore;
  }

  async function saveVecStore() {
    if (!vecStore) return;
    const map = {};
    for (const [k, v] of vecStore.map) map[k] = Array.from(v, (n) => Math.round(n * 1e5) / 1e5);
    await fs.writeFile(vecFile, JSON.stringify({ model: vecStore.model, at: Date.now(), map })).catch(
      (e) => log.warn?.('向量缓存写不进去：', e.message),
    );
  }

  /**
   * 给块补向量。已经算过的（hash 命中）直接复用，只请求新增的那些。
   * 任何失败都只是「这一轮没有向量」，不能让知识库整体不可用。
   */
  async function attachVectors(chunks) {
    if (!embed) return false;
    const model = String(embeddingOf()?.model || '').trim();
    if (!model) return false;
    if (chunks.length > MAX_VEC_CHUNKS) {
      log.warn?.(`知识库有 ${chunks.length} 块，超过向量索引上限 ${MAX_VEC_CHUNKS}，这次只用关键词检索`);
      return false;
    }
    if (vecBroken) {
      log.debug?.(`向量检索已停用（${vecBroken}）`);
      return false;
    }

    const store = await loadVecStore(model);
    const missing = [];
    const seen = new Set();
    for (const c of chunks) {
      c.hash = hashOf(c.text);
      const v = store.map.get(c.hash);
      if (v) c.vec = v;
      else if (!seen.has(c.hash)) {
        seen.add(c.hash);
        missing.push(c);
      }
    }

    if (missing.length) {
      log.info?.(`知识库要算 ${missing.length} 块向量（模型 ${model}）`);
      try {
        const vecs = await embed(missing.map((c) => c.text));
        if (!vecs || vecs.length !== missing.length) throw new Error('向量条数不对');
        missing.forEach((c, i) => {
          const f = Float32Array.from(vecs[i]);
          c.vec = f;
          store.map.set(c.hash, f);
        });
        await saveVecStore();
      } catch (e) {
        vecBroken = e.message;
        log.warn?.(`向量索引失败，本轮到关键词检索：${e.message}`);
        for (const c of chunks) delete c.vec;
        return false;
      }
    }
    return chunks.some((c) => c.vec);
  }

  async function build() {
    await fs.mkdir(dir, { recursive: true }).catch(() => {});

    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      log.warn?.('读不到知识库目录：', e.message);
    }

    const docs = [];
    const chunks = [];
    const seen = new Set();
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!EXT.has(ext)) continue;
      const full = path.join(dir, ent.name);
      try {
        const st = await fs.stat(full);
        if (st.size > MAX_FILE) {
          log.warn?.(`跳过超大文件 ${ent.name}（${Math.round(st.size / 1024)}KB）`);
          continue;
        }
        seen.add(full);
        const stamp = `${st.mtimeMs}:${st.size}`;
        const cached = fileCache.get(full);
        let parts;
        if (cached && cached.stamp === stamp) {
          parts = cached.parts;
        } else {
          let raw = await fs.readFile(full, 'utf8');
          if (ext === '.html' || ext === '.htm') raw = htmlToText(raw);
          parts = splitChunks(raw);
          fileCache.set(full, { stamp, parts, chars: raw.length });
        }
        for (const p of parts) chunks.push({ doc: ent.name, text: p });
        docs.push({
          name: ent.name,
          chunks: parts.length,
          chars: fileCache.get(full)?.chars ?? 0,
          at: st.mtimeMs,
        });
      } catch (e) {
        log.warn?.(`读不了 ${ent.name}：${e.message}`);
      }
    }
    // 删掉已经不存在的文件的缓存，别让 Map 无限长
    for (const k of fileCache.keys()) if (!seen.has(k)) fileCache.delete(k);

    // 倒排：算 df（有多少块含这个词）和平均块长
    const df = new Map();
    let totalLen = 0;
    for (const c of chunks) {
      const tf = termCounts(c.text);
      c.tf = tf;
      c.len = [...tf.values()].reduce((a, b) => a + b, 0);
      totalLen += c.len;
      for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    }

    // 向量：配了 embedding 才算。失败也只是退化成纯关键词，不影响可用性
    const hasVec = await attachVectors(chunks).catch((e) => {
      log.warn?.('向量索引异常：', e.message);
      return false;
    });

    idx = {
      chunks,
      df,
      avgdl: chunks.length ? totalLen / chunks.length : 0,
      docs,
      at: Date.now(),
      vec: hasVec,
    };
    if (chunks.length) {
      log.info?.(
        `知识库已索引 ${docs.length} 个文件 / ${chunks.length} 块${hasVec ? '（含向量）' : ''}`,
      );
    }
    return idx;
  }

  /** 第一次用到才建索引（启动时不阻塞），并发调用共用同一次构建 */
  async function load() {
    if (idx) return idx;
    if (!building) building = build().finally(() => (building = null));
    return building;
  }

  async function reload() {
    idx = null;
    return load();
  }

  /**
   * BM25 关键词榜。
   *
   * 光有 BM25 分数不够：中文短句里总有一两个词恰好出现在某段里（问「今天
   * 股市怎么样」，「怎么」正好命中「魂环怎么升」），分数不为零就返回，
   * 等于把无关段落硬塞给模型。
   *
   * 所以再加一道**覆盖率**门槛：这一段至少覆盖了查询权重的 25% 才算命中。
   * 用权重比而不是绝对分数，是因为 BM25 分数没有固定量纲——换个语料、
   * 换个块长就全变，写死阈值必然失灵。
   */
  function keywordRank(i, q) {
    const terms = queryTerms(q);
    let totalW = 0;
    for (const w of terms.values()) totalW += w;
    if (!totalW) return [];

    const N = i.chunks.length;
    const hits = [];
    for (const c of i.chunks) {
      let score = 0;
      let matchedW = 0;
      for (const [t, qw] of terms) {
        const tf = c.tf.get(t);
        if (!tf) continue;
        matchedW += qw;
        const df = i.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const norm = K1 * (1 - B + (B * c.len) / (i.avgdl || 1));
        score += idf * qw * ((tf * (K1 + 1)) / (tf + norm));
      }
      if (score > 0 && matchedW / totalW >= MIN_COVER) {
        hits.push({ c, score, cover: matchedW / totalW });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits;
  }

  /**
   * 向量榜：把查询也编码一次，和每块算余弦相似度。
   *
   * 为什么还要 minScore：向量检索**永远有结果**（哪怕问「今天天气」也会
   * 挑一个最像的），不设下限等于回到「什么都往模型嘴里塞」。
   * 阈值随模型不同会有差异（有的模型整体相似度偏高），所以做成可配。
   */
  async function vectorRank(i, q, want, minScore) {
    const [qv] = (await embed([q])) || [];
    if (!qv?.length) return [];
    const qf = Float32Array.from(qv);
    let qn = 0;
    for (const x of qf) qn += x * x;
    qn = Math.sqrt(qn) || 1;

    const hits = [];
    for (const c of i.chunks) {
      if (!c.vec || c.vec.length !== qf.length) continue;
      let dot = 0;
      let dn = 0;
      for (let k = 0; k < qf.length; k++) {
        dot += qf[k] * c.vec[k];
        dn += c.vec[k] * c.vec[k];
      }
      const sim = dot / (qn * (Math.sqrt(dn) || 1));
      if (sim >= minScore) hits.push({ c, score: sim });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, want);
  }

  /**
   * 检索：两路各自排序，用 RRF 融合。
   *
   * 为什么不是「分数加权平均」：BM25 分数没有上界（几分到几十都有），
   * 余弦相似度固定在 [-1,1]，两者相加必然被 BM25 单方面支配。
   * RRF 只看**名次**不看分数，天然免疫量纲问题，也没有需要标定的权重。
   */
  async function search(query, top = 3) {
    const i = await load();
    if (!i.chunks.length) return [];
    const q = String(query || '').trim();
    if (!q) return [];

    const want = Math.max(1, top);
    const kw = keywordRank(i, q);

    if (!i.vec) {
      return kw.slice(0, want).map((h) => ({
        doc: h.c.doc,
        text: h.c.text,
        score: h.score,
        cover: h.cover,
        via: '词',
      }));
    }

    const minScore = Number(embeddingOf()?.minScore) > 0 ? Number(embeddingOf().minScore) : 0.35;
    let vec = [];
    try {
      vec = await vectorRank(i, q, Math.max(want * 5, 20), minScore);
    } catch (e) {
      // 查询侧算向量失败：这一句退化成关键词，别把整轮回复拖垮
      vecBroken = e.message;
      log.warn?.(`查询向量化失败，本句只用关键词：${e.message}`);
    }
    if (!vec.length) {
      return kw.slice(0, want).map((h) => ({
        doc: h.c.doc,
        text: h.c.text,
        score: h.score,
        cover: h.cover,
        via: '词',
      }));
    }

    const fused = new Map();
    const add = (list, tag) => {
      list.forEach((h, r) => {
        const cur = fused.get(h.c) || { c: h.c, score: 0, via: [] };
        cur.score += 1 / (RRF_K + r + 1);
        cur.via.push(tag);
        fused.set(h.c, cur);
      });
    };
    add(kw, '词');
    add(vec, '义');

    return [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, want)
      .map((f) => ({ doc: f.c.doc, text: f.c.text, score: f.score, via: f.via.join('+') }));
  }

  async function stats() {
    const i = await load();
    return {
      dir,
      docs: i.docs,
      chunks: i.chunks.length,
      at: i.at,
      vec: Boolean(i.vec),
      vecModel: vecStore?.model || '',
      vecCached: vecStore ? vecStore.map.size : 0,
    };
  }

  return { dir, load, reload, search, stats, splitChunks };
}

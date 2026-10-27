/**
 * 知识库：把一个目录里的文本文件切块、建倒排索引，按 BM25 检索。
 *
 * 为什么不是「RAG」：RAG 通常指 embedding + 向量库，那要额外的 Key、额外的
 * 网络请求、额外的钱，还得管一个向量库进程。而群机器人要回答的多半是
 * 「魂环怎么升」「指令有哪些」这种**词面就能对上**的问题——BM25 在中文
 * 短查询上的效果并不比小模型 embedding 差多少，成本却为零。
 *
 * 什么时候该换向量：文档量上千、或者用户老用同义改写提问（「咋升级」
 * 对「如何提升」）。到那时候再加 embedding 也不冲突，检索层是可以换的。
 *
 * 目录：`<dataDir>/knowledge/`，支持 .md / .txt / .markdown / .log。
 * 用户往里丢文件 → `/ai 知识 重建` 重新索引。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { termCounts, queryTerms } from './text.js';

const EXT = new Set(['.md', '.markdown', '.txt', '.log']);
const MAX_FILE = 512 * 1024; // 单文件上限，别让一个巨型日志把内存吃满
const CHUNK = 400; // 每块目标字数
const OVERLAP = 60; // 相邻块重叠，避免答案正好被切断
const K1 = 1.2; // BM25 词频饱和参数（Lucene 默认）
const B = 0.75; // BM25 长度归一参数（Lucene 默认）
/** 命中门槛：这一段至少覆盖查询权重的多少比例，才认为「讲的是同一件事」 */
const MIN_COVER = 0.25;

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

export function createKnowledge({ conf, dataDir, log = () => {} }) {
  const dir = path.join(dataDir, 'knowledge');
  /** @type {null | {chunks:Array, df:Map<string,number>, avgdl:number, docs:Array, at:number}} */
  let idx = null;
  let building = null;

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
        const raw = await fs.readFile(full, 'utf8');
        const parts = splitChunks(raw);
        for (const p of parts) chunks.push({ doc: ent.name, text: p });
        docs.push({ name: ent.name, chunks: parts.length, chars: raw.length, at: st.mtimeMs });
      } catch (e) {
        log.warn?.(`读不了 ${ent.name}：${e.message}`);
      }
    }

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

    idx = {
      chunks,
      df,
      avgdl: chunks.length ? totalLen / chunks.length : 0,
      docs,
      at: Date.now(),
    };
    if (chunks.length) log.info?.(`知识库已索引 ${docs.length} 个文件 / ${chunks.length} 块`);
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
   * BM25 检索。
   *
   * 光有 BM25 分数不够：中文短句里总有一两个词恰好出现在某段里（问「今天
   * 股市怎么样」，「怎么」正好命中「魂环怎么升」），分数不为零就返回，
   * 等于把无关段落硬塞给模型。
   *
   * 所以再加一道**覆盖率**门槛：这一段至少覆盖了查询权重的 25% 才算命中。
   * 用权重比而不是绝对分数，是因为 BM25 分数没有固定量纲——换个语料、
   * 换个块长就全变，写死阈值必然失灵。
   */
  async function search(query, top = 3) {
    const i = await load();
    if (!i.chunks.length) return [];
    const q = String(query || '').trim();
    if (!q) return [];

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
        hits.push({ doc: c.doc, text: c.text, score, cover: matchedW / totalW });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(1, top));
  }

  async function stats() {
    const i = await load();
    return { dir, docs: i.docs, chunks: i.chunks.length, at: i.at };
  }

  return { dir, load, reload, search, stats, splitChunks };
}

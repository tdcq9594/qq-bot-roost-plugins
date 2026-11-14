/**
 * 「ta 刷过什么」的账本
 * ============================================================
 *
 * 面板上那一块要的是**一条一条的记录**：什么时间、点开看了哪个视频、
 * 她自己冒出来的那句话（感想），以及顺手做过什么（评论 / 弹幕 / 分享）。
 *
 * 为什么单独一个文件、不塞进 `ui-data.json` 的 `meta`：
 *
 *   · `meta` 是宿主透传的一层标量表，数组会被 `String()` 成
 *     `[object Object]`——回复列表（`replies.json`）踩过这个坑；
 *   · 这份记录会一直长（一天几十条），`meta` 每写一次都要整份重写，
 *     它混在里面会让「今天刷了几轮」这种小数字跟着变大文件。
 *
 * 所以照 `replies.json` 的样子单独落盘，面板用
 * `/ext-pages?id=bili&file=history.json` 直接读。
 *
 * ## 只记「她真的看了」的那些
 *
 * 定时器拉热门数据那一步不算「刷过」——没有模型在场，谈不上感想。
 * 只有独立会话把材料看完、她给了反应，才写一条。这和 aurabot 的
 * `history` 语义一致（那边也只有 duty 循环会写）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HISTORY_FILE = 'history.json';

/**
 * 一条记录最多留多久条。
 *
 * 60 条 ≈ 两三天，够看出「她最近在看什么」；再多面板一屏也放不下，
 * 而且每轮都要重写整份 JSON。真要看更早的，日志里有。
 */
export const KEEP = 60;

/** 允许的 kind（和 `plugin.json` 的说明、面板的中文标签一一对应） */
export const KINDS = Object.freeze(['watch', 'comment', 'danmaku', 'share', 'like', 'reply']);

/** 面板上显示的中文；未知 kind 原样显示，方便发现新加的类型 */
export const KIND_TEXT = Object.freeze({
  watch: '看了',
  comment: '评论',
  danmaku: '弹幕',
  share: '分享给你',
  like: '点赞',
  reply: '回复了别人',
});

/** 同一天的同一条视频只留最新的一条，避免刷两遍就出现两条一样的 */
const dayKey = (t) => new Date(Number(t) || Date.now()).toDateString();

/** 把可能是乱七八糟的输入收敛成一条干净记录；不合格返回 null */
function normRow(row) {
  if (!row || typeof row !== 'object') return null;
  const bvid = String(row.bvid ?? '').trim();
  const title = String(row.title ?? '').trim().slice(0, 120);
  const kind = KINDS.includes(String(row.kind)) ? String(row.kind) : 'watch';
  const text = String(row.text ?? '').trim().slice(0, 400);
  /** 没有 BV 也没有文字（比如「刷了一轮」这种空记录）就不要 */
  if (!bvid && !text) return null;
  const acts = Array.isArray(row.acts)
    ? row.acts
      .map((a) => (KINDS.includes(String(a)) ? String(a) : ''))
      .filter((a) => a && a !== kind)
      .slice(0, 4)
    : [];
  return { at: Number(row.at) || Date.now(), kind, bvid, title, text, acts };
}

/**
 * @param {{dir: string, keep?: number, log?: Function}} o
 */
export function createHistory({ dir = '', keep = KEEP, log = () => {} } = {}) {
  const file = () => join(dir, HISTORY_FILE);
  const cap = Math.max(10, Number(keep) || KEEP);

  /** 读到的永远是数组；文件坏了当空表（面板显示「还没有记录」而不是报错） */
  function read() {
    try {
      const j = JSON.parse(readFileSync(file(), 'utf8'));
      return Array.isArray(j?.items) ? j.items.filter((x) => x && typeof x === 'object') : [];
    } catch {
      return [];
    }
  }

  /**
   * 追加若干条。
   *
   * 合并规则：同一天 + 同 bvid + 同 kind 视为同一条，**新的覆盖旧的**
   * （位置也提到最前）——她连刷两轮同一批视频时，面板应该显示最新那句
   * 感想，而不是攒出一串重复行。
   *
   * 返回写完之后的全表，调用方不用再读一遍。
   */
  function add(rows) {
    const incoming = (Array.isArray(rows) ? rows : [rows]).map(normRow).filter(Boolean);
    if (!incoming.length) return read();

    const prev = read();
    const fresh = [];
    for (const it of incoming) {
      const sameDay = dayKey(it.at);
      const dup = (list, x) => list.findIndex(
        (p) => p.bvid && x.bvid && p.bvid === x.bvid && p.kind === x.kind && dayKey(p.at) === sameDay,
      );
      /** 先看本批里有没有重复（一轮里同一个 BV 出现两次） */
      const i = dup(fresh, it);
      if (i >= 0) { fresh.splice(i, 1); }
      fresh.push(it);
    }

    const kept = [];
    for (const it of fresh.concat(prev)) {
      const sameDay = dayKey(it.at);
      const hit = kept.findIndex(
        (p) => p?.bvid && it?.bvid && p.bvid === it.bvid && p.kind === it.kind && dayKey(p.at) === sameDay,
      );
      if (hit >= 0) continue;
      kept.push(it);
    }

    const items = kept
      .sort((a, b) => (Number(b?.at) || 0) - (Number(a?.at) || 0))
      .slice(0, cap);

    try {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file()}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ at: Date.now(), items }, null, 0)}\n`, 'utf8');
      renameSync(tmp, file());
    } catch (e) {
      log(`刷过什么写盘失败：${e?.message ?? e}`);
    }
    return items;
  }

  return { read, add, file, keep: cap };
}

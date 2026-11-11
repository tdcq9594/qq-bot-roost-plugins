/**
 * 把接口数据折成「模型读了就能接话」的文本。
 *
 * 三条约束：
 *  1. 单次工具返回**必须**压在 4 KB 以内 —— 宿主 `tools/post-execute`
 *     会在 4096 字节处截断（`src/ext-usage.js:31`），超了就是硬切，
 *     切在半句话上比短一点更糟。这里统一走 `clamp()`。
 *  2. 中文一个字 3 字节：3600 字节 ≈ 1200 个汉字，所以字幕只给节选、
 *     热评只给 4 条、简介截 150 字。
 *  3. 列表里给完整链接：模型不必自己拼 `https://www.bilibili.com/video/`。
 */

import { agoOf, clockOf, playCount } from './api.mjs';

/** 单次输出上限（字节）。留 500 字节余量给宿主的截断标注。 */
export const MAX_BYTES = 3600;

const bytes = (s) => Buffer.byteLength(String(s), 'utf8');

/** 按 UTF-8 字节截断，不切半个字。 */
export function clamp(text, max = MAX_BYTES) {
  const s = String(text ?? '');
  if (bytes(s) <= max) return s;
  const mark = '\n…（太长，截断了）';
  const budget = max - bytes(mark);
  let out = '';
  let used = 0;
  for (const ch of Array.from(s)) {
    const n = bytes(ch);
    if (used + n > budget) break;
    out += ch;
    used += n;
  }
  return out + mark;
}

const linkOf = (bvid) => `https://www.bilibili.com/video/${bvid}`;

/** 一行一个视频：标题 / UP / 播放 / 时长 / 发布时间 + 链接 */
function line(v, i) {
  const meta = [
    v.author ? `UP ${v.author}` : '',
    v.play ? `播放 ${playCount(v.play)}` : '',
    v.duration ? (typeof v.duration === 'number' ? clockOf(v.duration) : v.duration) : '',
    v.pubdate ? agoOf(v.pubdate) : '',
  ].filter(Boolean).join(' ｜ ');
  return `${i}. ${v.title}\n   ${meta}${meta ? ' ｜ ' : ''}${linkOf(v.bvid)}`;
}

export function fmtVideoList(items, { heading = '', withDesc = false } = {}) {
  if (!items?.length) return `${heading ? `${heading}\n` : ''}（没找到）`;
  const rows = items.map((v, i) => {
    const base = line(v, i + 1);
    return withDesc && v.desc ? `${base}\n   ${String(v.desc).replace(/\s+/g, ' ').slice(0, 90)}` : base;
  });
  return clamp([heading, ...rows].filter(Boolean).join('\n'));
}

export function fmtVideo(info, { subtitle = '', subtitleLang = '', comments = [], danmaku = [], loggedIn = false } = {}) {
  const stats = [
    info.author ? `UP：${info.author}` : '',
    `播放 ${playCount(info.play)}`,
    info.like ? `点赞 ${playCount(info.like)}` : '',
    info.danmakuCount ? `弹幕 ${playCount(info.danmakuCount)}` : '',
    info.reply ? `评论 ${playCount(info.reply)}` : '',
    clockOf(info.duration),
    agoOf(info.pubdate),
  ].filter(Boolean).join(' ｜ ');

  const out = [
    `《${info.title}》`,
    stats,
    linkOf(info.bvid),
  ];

  if (info.desc) out.push(`简介：${String(info.desc).replace(/\s+/g, ' ').slice(0, 150)}`);

  if (subtitle) {
    out.push(`字幕（${subtitleLang || '中文'}，节选）：${subtitle.replace(/\s+/g, ' ').slice(0, 420)}`);
  } else {
    out.push(`字幕：${loggedIn ? '这条视频没有字幕' : '没登录看不到 AI 字幕（只有标题、简介和热评）'}`);
  }

  if (danmaku.length) {
    out.push(`弹幕抽样：${danmaku.map((d) => `${clockOf(d.sec)} ${d.text}`).join(' / ')}`);
  }

  if (comments.length) {
    out.push('热评：');
    for (const c of comments.slice(0, 4)) {
      out.push(` - ${c.name}：${c.text}${c.like ? `（${playCount(c.like)} 赞）` : ''}`);
    }
  }

  return clamp(out.join('\n'));
}

export function fmtUp(up) {
  const head = [
    `UP：${up.name}（UID ${up.mid}）`,
    up.level ? `等级 ${up.level}` : '',
    `粉丝 ${playCount(up.fans)}`,
    up.archive ? `投稿 ${playCount(up.archive)}` : '',
  ].filter(Boolean).join(' ｜ ');

  const out = [head];
  if (up.sign) out.push(`签名：${up.sign}`);
  if (up.videos?.length) {
    out.push('最近投稿：');
    out.push(...up.videos.map((v) => {
      const meta = [v.play ? `播放 ${playCount(v.play)}` : '', v.length || '', v.pubdate ? agoOf(v.pubdate) : ''].filter(Boolean).join(' ｜ ');
      return `- ${v.title}${meta ? `（${meta}）` : ''}\n  ${linkOf(v.bvid)}`;
    }));
  } else {
    out.push('最近投稿：拿不到（B 站对空间接口风控比较严）');
  }
  return clamp(out.join('\n'));
}

export function fmtBangumi(b) {
  const out = [`《${b.title}》（${b.type}）｜ 共 ${b.total} 集`];
  if (b.desc) out.push(`简介：${b.desc.slice(0, 150)}`);
  if (b.current) {
    out.push(`当前：第 ${b.current.title} 集${b.current.long ? ` ${b.current.long}` : ''}`);
    out.push(b.current.link);
  }
  const eps = (b.episodes || []).map((e) => (e.long ? `${e.title}. ${e.long}` : String(e.title)));
  if (eps.length) out.push(`分集（前 ${eps.length} 集）：${eps.join(' / ')}`);
  return clamp(out.filter(Boolean).join('\n'));
}

/**
 * 把一条视频折成模型能直接抄进回复的 `<<card:>>` 串（0.3）。
 * ==========================================================
 *
 * 扩展**不自己发消息**：MCP 工具调用只带 arguments，拿不到「当前是哪个会话」，
 * 而 `/v1/send { card }` 必须有 target。所以这里只把四个字段拼好、按官方
 * 限制裁干净，返回一段可复制的标记；模型写在回复里，宿主出站动作层
 * 用 `channel.send({ card })` 发出去（msg_type=8）。
 *
 * 宿主的 `tuwenProblem()` 会再验一次，但那一步失败只会记日志、卡片不发了。
 * 与其让模型莫名其妙少一张卡片，不如在**工具里**就把长度 / https / 分隔符
 * 都收拾好，并把不合格的原因当场说清楚。
 */

import { BiliError } from './api.mjs';
import { playCount } from './api.mjs';

/** 竖线是 card 的字段分隔符，标题和描述里出现会把字段整体挪位。 */
const flat = (s) => String(s ?? '')
  .replace(/[|｜]/g, '·')
  .replace(/[<>]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const cut = (s, max) => {
  const chars = Array.from(flat(s));
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
};

const isHttps = (u) => /^https:\/\//i.test(String(u ?? '').trim());

/**
 * @param {object} v `api.view()` / `api.hot()` 的一条
 * @returns {{text:string, card:{title:string,description:string,url:string,picUrl:string}}}
 */
export function cardOf(v) {
  const bvid = String(v?.bvid ?? '').trim();
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
    throw new BiliError('这条没有正经的 BV 号，拼不出卡片链接', { hint: '番剧 / 短链要先换成普通视频。' });
  }
  const title = cut(v?.title || 'B 站视频', 50);
  if (!title) throw new BiliError('视频标题是空的，拼不出卡片');

  const bits = [
    v?.author ? `UP ${v.author}` : '',
    Number(v?.play) ? `播放 ${playCount(v.play)}` : '',
    v?.tname || '',
  ].filter(Boolean).join(' · ');
  /** 描述优先用简介，没有简介就用统计信息；两者都裁到 200 字 */
  const desc = cut(v?.desc || bits || `${title}｜点开看`, 200);
  if (!desc) throw new BiliError('卡片描述是空的');

  const url = `https://www.bilibili.com/video/${bvid}`;
  const picUrl = String(v?.cover ?? '').trim();
  if (!isHttps(picUrl)) {
    throw new BiliError('这个视频没有可用的 https 封面，发不了卡片', {
      hint: '官方卡片只收 https 图片地址；改用普通链接分享就好，别塞本地截图。',
    });
  }
  if (picUrl.length > 1024 || url.length > 1024) throw new BiliError('链接太长，发不了卡片');

  const card = { title, description: desc, url, picUrl };
  return {
    card,
    text: `<<card: ${title}|${desc}|${url}|${picUrl}>>`,
  };
}

/** 工具返回文案：给模型一句能直接照抄的话，别让它自己猜怎么发。 */
export function cardText(v) {
  const { text } = cardOf(v);
  return [
    '把下面这行**原样写进你的回复**，宿主会把它发成一张官方图文卡片；',
    '你还可以在同一条回复里照常说话，卡片会单独占一条消息：',
    '',
    text,
    '',
    '（四项用竖线分隔，别改写、别加引号；一轮最多写一张。）',
  ].join('\n');
}

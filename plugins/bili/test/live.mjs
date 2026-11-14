#!/usr/bin/env node
/**
 * 线上冒烟：真打 B 站接口，确认签名、字幕、弹幕、UP 主这几条链路没坏。
 *
 *   node test/live.mjs                # 用热门榜第一条当样本
 *   node test/live.mjs BV1gHWg6GEqj   # 指定样本
 *
 * 会真的发网络请求（不带登录也跑得通）；CI 不跑这个文件，只在手动联调时用。
 */
import { createBiliApi } from '../lib/api.mjs';
import { cardOf } from '../lib/card.mjs';
import { pickStream } from '../lib/shots.mjs';

const log = (m) => console.log(`  · ${m}`);
const api = createBiliApi({ log });
const t0 = Date.now();
const step = (name) => console.log(`\n[${((Date.now() - t0) / 1000).toFixed(1)}s] ${name}`);

try {
  step('登录态');
  console.log(await api.account());

  step('热门');
  const hot = await api.hot({ ps: 10 });
  console.log(`拿到 ${hot.length} 条，第一条：${hot[0]?.bvid} ${hot[0]?.title}`);
  console.log(`播放 ${hot[0]?.play} 时长 ${hot[0]?.duration}s UP ${hot[0]?.author}`);

  step('每周必看');
  const weekly = await api.weekly({});
  console.log(`第 ${weekly.number} 期「${weekly.name}」${weekly.subject}，${weekly.items.length} 条；第一条：${weekly.items[0]?.bvid} ${weekly.items[0]?.title}`);

  step('搜索');
  const found = await api.search('猫', { limit: 5 });
  console.log(`拿到 ${found.length} 条，第一条：${found[0]?.bvid} ${found[0]?.title}`);

  const target = process.argv[2] || hot[0]?.bvid;
  step(`视频详情 ${target}`);
  const info = await api.view({ bvid: target });
  console.log(`${info.title} / UP ${info.author} / 播放 ${info.play} / ${info.duration}s / ${info.tname}`);
  console.log(`封面：${info.cover || '（没有，card 会当场拒）'}`);

  step('卡片串（0.3，只拼字符串不发）');
  try {
    console.log(cardOf(info).text);
  } catch (e) {
    console.log(`拼不出：${e.message}${e.hint ? `（${e.hint}）` : ''}`);
  }

  step('播放流（0.3，shot 会用它抽帧）');
  try {
    const pu = await api.playurl({ bvid: info.bvid, cid: info.cid });
    console.log(`DASH 视频流 ${pu.video.length} 路 / durl ${pu.durl.length} 段；选中的：${pickStream(pu) ? '有' : '没有'}`);
  } catch (e) {
    console.log(`拿不到播放流：${e.message}${e.hint ? `（${e.hint}）` : ''}`);
  }

  step('字幕');
  const sub = await api.subtitle(info);
  console.log(sub.text ? `${sub.lang}，${sub.text.length} 字：${sub.text.slice(0, 60)}…` : `没有字幕（${sub.error ?? '接口没给'}）`);

  step('热评');
  const cs = await api.comments(info.aid, { limit: 5 });
  console.log(`${cs.length} 条；第一条：${cs[0]?.name}：${cs[0]?.text?.slice(0, 40)}`);

  step('弹幕');
  const dm = await api.danmaku(info.cid, { limit: 8 });
  console.log(`${dm.length} 条；样本：${dm.slice(0, 3).map((x) => x.text).join(' / ') || '（空）'}`);

  step('UP 主');
  const up = await api.up({ mid: info.authorMid, limit: 3 });
  console.log(`${up.name} 粉丝 ${up.fans}；最近投稿：${up.videos.map((v) => v.title).join(' | ') || '（无）'}`);

  step('状态');
  console.log(api.state());
  console.log('\n✓ 全部通过');
} catch (e) {
  console.error('\n✗ 失败：', e?.name, e?.message, e?.hint ?? '');
  process.exitCode = 1;
}

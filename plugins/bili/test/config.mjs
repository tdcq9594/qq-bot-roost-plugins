#!/usr/bin/env node
/**
 * 可调设置生效验证（不联网）。
 *
 *   node test/config.mjs
 *
 * 直接构造 toolbox 并把 `config` 传进去，用假 API 观察**实际传给下游的参数**。
 * 为什么不用起 server + 真接口：hot / weekly / search / video 全要联网，
 * CI 里不能依赖 B 站可用性；而「配置有没有被读到」这件事在 toolbox 边界就看得清。
 */
import assert from 'node:assert/strict';

import { createToolbox } from '../lib/tools.mjs';
import { readConfig } from '../lib/config.mjs';

const calls = [];

/** 20 条假视频，够 fmtVideoList 渲染。 */
const POOL = Array.from({ length: 20 }, (_, i) => ({
  bvid: `BV${i}`, title: `视频 ${i}`, author: `UP${i}`, play: 100 + i,
  duration: 60, pubdate: 0, url: `https://b23.tv/BV${i}`,
}));

const api = {
  async hot(opts) { calls.push(['hot', opts]); return POOL; },
  async weekly(opts) { calls.push(['weekly', opts]); return { number: 1, name: '', subject: '', items: POOL }; },
  async search(kw, opts) { calls.push(['search', opts]); return POOL; },
  async view() {
    return { aid: 1, cid: 2, bvid: 'BV1', title: 't', desc: '', author: 'a', play: 1, pubdate: 0, duration: 60 };
  },
  async account() { return { isLogin: false }; },
  async subtitle() { return { text: '', lang: '' }; },
  async comments(aid, opts) { calls.push(['comments', opts]); return []; },
  async danmaku(cid, opts) { calls.push(['danmaku', opts]); return []; },
  async resolveShort() { return 'BV1'; },
  async bangumi() { return {}; },
  async up() { return { name: 'u', mid: 1, items: [] }; },
};

const fail = [];
const check = (cond, label) => {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) fail.push(label);
};

// ---- 1. 默认值来自配置 ----
{
  calls.length = 0;
  const box = createToolbox({ api, config: { defaultLimit: 2, hotPoolSize: 12, commentLimit: 2, defaultDanmaku: true } });

  const hot = await box.call('hot', {});
  check(calls[0]?.[0] === 'hot' && calls[0]?.[1]?.ps === 12, 'hotPoolSize 传给 api.hot（ps）');
  /** `line()` 每条渲染两行（标题 + 元信息/链接），所以按编号数条数，不数行数。 */
  const n = (hot.match(/^\d+\. /gm) || []).length;
  check(n === 2, `defaultLimit=2 时只出 2 条（实际 ${n} 条）`);

  await box.call('video', { link: 'BV1xx411c7mD' });
  const c = calls.find((x) => x[0] === 'comments');
  check(c?.[1]?.limit === 2, 'commentLimit 传给 api.comments');
  check(calls.some((x) => x[0] === 'danmaku'), 'defaultDanmaku=true 时默认请求弹幕');
}

// ---- 2. 显式参数优先于配置 ----
{
  calls.length = 0;
  const box = createToolbox({ api, config: { defaultDanmaku: true } });
  await box.call('video', { link: 'BV1xx411c7mD', danmaku: false });
  check(!calls.some((x) => x[0] === 'danmaku'), '模型显式给 danmaku=false 时不请求弹幕');
}

// ---- 3. 配置非法 / 越界时退回默认并被夹住 ----
{
  calls.length = 0;
  const box = createToolbox({ api, config: { defaultLimit: 'abc', hotPoolSize: 9999, commentLimit: -5 } });
  const hot = await box.call('hot', {});
  check(calls[0]?.[1]?.ps === 30, `hotPoolSize 越界被夹到 30（实际 ${calls[0]?.[1]?.ps}）`);
  check((hot.match(/^\d+\. /gm) || []).length === 6, 'defaultLimit 非法时退回 6');

  calls.length = 0;
  const box2 = createToolbox({ api, config: { commentLimit: -5 } });
  await box2.call('video', { link: 'BV1xx411c7mD' });
  check(calls.find((x) => x[0] === 'comments')?.[1]?.limit === 1, 'commentLimit 负数被夹到 1');
}

// ---- 4. 完全不给 config 时行为和以前一致 ----
{
  calls.length = 0;
  const box = createToolbox({ api });
  const hot = await box.call('hot', {});
  check(calls[0]?.[1]?.ps === 20, '无配置时池子仍是 20');
  check((hot.match(/^\d+\. /gm) || []).length === 6, '无配置时默认 6 条');
  await box.call('video', { link: 'BV1xx411c7mD' });
  check(calls.find((x) => x[0] === 'comments')?.[1]?.limit === 5, '无配置时热评仍是 5 条');
  check(!calls.some((x) => x[0] === 'danmaku'), '无配置时默认不带弹幕');
}

// ---- 5. 工具 schema 没被配置改动（模型看到的面不变） ----
{
  const box = createToolbox({ api, config: { defaultLimit: 2 } });
  const hot = box.tools.find((t) => t.name === 'hot');
  assert.equal(hot.inputSchema.properties.limit.maximum, 8, '上限仍是 8');
}


/* ---------------- 0.4：开关默认值 ---------------- */

const c0 = readConfig({});
assert.equal(c0.pushOwner, false, '私聊推送默认关');
assert.equal(c0.pushGroup, false, '群推送默认关');
assert.equal(c0.pushApproval, false);
assert.equal(c0.autoComment, false, '写动作默认关');
assert.equal(c0.autoLike, false);
assert.equal(c0.autoDanmaku, false);
assert.equal(c0.writeDryRun, true, '写动作默认试运行 —— 这条别改');
assert.equal(c0.pushDailyLimit, 20);
assert.equal(c0.writeDailyLimit, 10);
assert.equal(c0.pushMinPlay, 100000);

const c1 = readConfig({ ROOST_EXT_CONFIG: JSON.stringify({
  pushOwner: 'true', pushGroupTarget: '123456789', writeDryRun: 'false', pushPerFeed: 3,
}) });
assert.equal(c1.pushOwner, true);
assert.equal(c1.pushGroupTarget, '123456789');
assert.equal(c1.writeDryRun, false, '用户显式关掉试运行才生效');
assert.equal(c1.pushPerFeed, 3);
console.log('✓ 0.4 开关默认值与覆盖');

console.log(fail.length ? `\n✗ ${fail.length} 项未通过` : '\n✓ 全部通过');
process.exit(fail.length ? 1 : 0);

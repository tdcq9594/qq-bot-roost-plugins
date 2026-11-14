import test from 'node:test';
import assert from 'node:assert/strict';
import { createPush, materialOf, fillTemplate } from '../lib/push.mjs';

const T = new Date('2026-11-14T10:00:00+08:00').getTime();
const POOL = [
  { bvid: 'BV1ZAWM61Eva', title: '第一条', author: 'UP甲', play: 500000, tname: '动画', desc: '好看', cover: 'https://i0.hdslb.com/a.jpg' },
  { bvid: 'BV1ZAWM61Evb', title: '第二条', author: 'UP乙', play: 300000, tname: '游戏', desc: '', cover: '' },
  { bvid: 'BV1ZAWM61Evc', title: '冷门', author: 'UP丙', play: 100, tname: '音乐', desc: '' },
];

function fakeSubmit() {
  const calls = [];
  return {
    calls,
    available: true,
    submit: async (x) => { calls.push(x); return { ok: true, id: `id${calls.length}` }; },
  };
}
const fakeApi = () => ({ view: async () => ({ aid: 123, cid: 456 }) });
const fakeWrite = () => ({
  calls: [],
  state: () => ({ paused: '' }),
  comment: async function (aid, text) { this.calls.push(['comment', aid, text]); return { ok: true, dryRun: true }; },
  like: async function (aid) { this.calls.push(['like', aid]); return { ok: true, dryRun: true }; },
  danmaku: async function (cid, text) { this.calls.push(['danmaku', cid, text]); return { ok: true, dryRun: true }; },
});
const cfg0 = (over = {}) => ({
  pushMinPlay: 100000, pushPerFeed: 1, pushDailyLimit: 20, writeDailyLimit: 10,
  pushOwner: false, pushGroup: false, pushApproval: false, pushCover: false,
  autoShot: false, autoComment: false, autoLike: false, autoDanmaku: false,
  commentTemplate: '{title} 挺好', danmakuTemplate: '好看', ...over,
});

test('materialOf：素材带标题/UP/播放/链接，封面只在开关开着时给', () => {
  const a = materialOf(POOL[0]);
  assert.match(a, /第一条/);
  assert.match(a, /UP甲/);
  assert.match(a, /50\.0 万/);
  assert.match(a, /https:\/\/www\.bilibili\.com\/video\/BV1ZAWM61Eva/);
  assert.doesNotMatch(a, /hdslb/);
  assert.match(materialOf(POOL[0], { withCover: true }), /hdslb/);
  assert.equal(fillTemplate('{title} / {author}', POOL[0]), '第一条 / UP甲');
});

test('默认全关：刷到一批也不投、不写、不抽帧', async () => {
  const sub = fakeSubmit();
  const w = fakeWrite();
  const push = createPush({ cfg: cfg0(), api: fakeApi(), submit: sub, write: w, now: () => T });
  const r = await push.onFresh(POOL);
  assert.equal(r.delivered, 0);
  assert.equal(r.writes, 0);
  assert.equal(sub.calls.length, 0);
  assert.equal(w.calls.length, 0);
  assert.equal(push.state().switches.pushOwner, false);
});

test('打开私聊推送：按播放门槛挑、每天同一个 BV 不重复推', async () => {
  const sub = fakeSubmit();
  const push = createPush({ cfg: cfg0({ pushOwner: true }), api: fakeApi(), submit: sub, now: () => T });
  const r = await push.onFresh(POOL);
  assert.equal(r.picked, 1, '冷门那条被门槛挡掉，每轮只挑 1 条');
  assert.equal(r.delivered, 1);
  assert.equal(sub.calls[0].target, 'owner');
  assert.match(sub.calls[0].text, /第一条/);
  assert.equal(sub.calls[0].key, 'BV1ZAWM61Eva|owner');
  const again = await push.onFresh(POOL);
  assert.equal(again.delivered, 1, '会换下一条，不复读第一条');
  assert.notEqual(sub.calls[1].key, sub.calls[0].key, '同一个 BV 号当天不重复投');
  const third = await push.onFresh(POOL);
  assert.equal(third.delivered, 0, '达标的都推过了、冷门的不够门槛，这轮就安静');
});

test('推群：带群号、按开关要求审批；缺群号就不发', async () => {
  const sub = fakeSubmit();
  const push = createPush({
    cfg: cfg0({ pushOwner: true, pushGroup: true, pushGroupTarget: '987654321', pushApproval: true }),
    api: fakeApi(), submit: sub, now: () => T,
  });
  await push.onFresh(POOL);
  assert.equal(sub.calls.length, 2);
  assert.equal(sub.calls[0].target, 'owner');
  assert.equal(sub.calls[0].approve, false, '私聊不攒待批');
  assert.equal(sub.calls[1].target, 'group:987654321');
  assert.equal(sub.calls[1].approve, true, '群分享按开关走审批');
  assert.notEqual(sub.calls[0].key, sub.calls[1].key, '宿主按 key 去重，两个目标不能撞同一个 key');

  const noGroup = fakeSubmit();
  const p2 = createPush({ cfg: cfg0({ pushOwner: true, pushGroup: true }), api: fakeApi(), submit: noGroup, now: () => T });
  await p2.onFresh(POOL);
  assert.equal(noGroup.calls.length, 1, '没填群号时只发私聊，别把 group: 空串投出去');
});

test('每日推送额度用完就停，写动作额度独立', async () => {
  const sub = fakeSubmit();
  const w = fakeWrite();
  const push = createPush({
    cfg: cfg0({ pushOwner: true, pushDailyLimit: 1, writeDailyLimit: 1, autoComment: true, autoLike: true }),
    api: fakeApi(), submit: sub, write: w, now: () => T,
  });
  await push.onFresh(POOL);
  assert.equal(sub.calls.length, 1);
  assert.equal(w.calls.length, 1, '写动作也受自己的额度管');
  const r = await push.pushOne(POOL[1], '手动');
  assert.equal(r.ok, false);
  assert.match(String(r.errors?.[0] || ''), /额度/);
  assert.equal(push.state().today.pushed, 1);
});

test('写动作：试运行也计数但不真发；模板替换后送到 write 层', async () => {
  const w = fakeWrite();
  const push = createPush({
    cfg: cfg0({ autoComment: true, autoLike: true, autoDanmaku: true }),
    api: fakeApi(), submit: fakeSubmit(), write: w, now: () => T,
  });
  const r = await push.onFresh(POOL);
  assert.equal(r.writes, 3);
  assert.deepEqual(w.calls.map((x) => x[0]), ['comment', 'like', 'danmaku']);
  assert.equal(w.calls[0][2], '第一条 挺好');
  assert.equal(push.state().switches.writeDryRun, true);
});

test('push_state / pushOne：手动补推与自检都能离线跑', async () => {
  const sub = fakeSubmit();
  const push = createPush({ cfg: cfg0({ pushOwner: true }), api: fakeApi(), submit: sub, now: () => T });
  const st = push.state();
  assert.equal(st.channel, true);
  assert.equal(st.switches.pushOwner, true);
  assert.equal(st.last.at, 0);
  const r = await push.pushOne(POOL[1], '手动');
  assert.equal(r.ok, true);
  assert.equal(sub.calls[0].key, 'BV1ZAWM61Evb|owner');
  assert.equal(push.state().today.pushed, 1);
});

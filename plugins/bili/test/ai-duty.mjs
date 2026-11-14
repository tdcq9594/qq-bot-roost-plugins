/**
 * 独立会话值班：她看过再决定，JSON 解析容错，执行边界在扩展这侧。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBrowseSession, materialOfVideos, shareMaterial, videoUrl, parseDecisions, parsePayload } from '../lib/ai-duty.mjs';
import { createSelfBrowse } from '../lib/self-browse.mjs';
import { createSeenStore } from '../lib/seen.mjs';
import { createPending } from '../lib/pending.mjs';

const BV = 'BV1xx411c7mD';

test('parseDecisions：标准 JSON 数组', () => {
  const out = parseDecisions(`[{"bvid":"${BV}","feeling":"这猫真懒","comment":"我家也这样","share":"看看这个","remember":"主人喜欢猫"}]`);
  assert.equal(out.length, 1);
  assert.equal(out[0].comment, '我家也这样');
  assert.equal(out[0].remember, '主人喜欢猫');
});

test('parseDecisions：弹幕是独立字段，没写就不发', () => {
  const withDm = parseDecisions(`[{"bvid":"${BV}","feeling":"","comment":"","danmaku":"这里好笑","share":"","remember":""}]`);
  assert.equal(withDm.length, 1);
  assert.equal(withDm[0].danmaku, '这里好笑');

  /** 只给弹幕也算表达了意见 */
  const only = parseDecisions(`[{"bvid":"${BV}","danmaku":"来了"}]`);
  assert.equal(only.length, 1);

  /** 四个字段全空就当没说话 */
  assert.deepEqual(parseDecisions(`[{"bvid":"${BV}","feeling":"","comment":"","danmaku":"","share":"","remember":""}]`), []);
});

test('parseDecisions：模型包了 code fence / 多说了两句也能抠出来', () => {
  const out = parseDecisions('好的，我看完了：\n```json\n[{"bvid":"' + BV + '","feeling":"有意思","comment":"","share":"","remember":""}]\n```');
  assert.equal(out.length, 1);
  assert.equal(out[0].feeling, '有意思');
  assert.equal(out[0].comment, '');
});

test('parseDecisions：坏 JSON / 非数组 / 缺 bvid 一律空，不猜', () => {
  assert.deepEqual(parseDecisions('[{"bvid":'), []);
  assert.deepEqual(parseDecisions('我看完了，都还行'), []);
  assert.deepEqual(parseDecisions('{"bvid":"x"}'), []);
  assert.deepEqual(parseDecisions(`[{"bvid":"not-a-bv","feeling":"x"}]`), []);
  /** 四个字段全空等于没表达意见，不该占位 */
  assert.deepEqual(parseDecisions(`[{"bvid":"${BV}"}]`), []);
});

test('materialOfVideos：一行一条，带 bvid 和播放量', () => {
  const text = materialOfVideos([
    { bvid: BV, title: '一只猫', author: '兔总裁s', play: 1234, desc: '窗台上打盹', tname: '动物' },
  ]);
  assert.match(text, /一只猫/);
  assert.match(text, new RegExp(BV));
  assert.match(text, /播放 1234/);
  assert.match(text, new RegExp(`链接：https://www\\.bilibili\\.com/video/${BV}`), '材料里必须给可点链接，否则她只能说「我这儿只剩个标题」');
});

test('videoUrl / shareMaterial：BV 不合法不给链接，回退素材带标题和链接', () => {
  assert.equal(videoUrl(BV), `https://www.bilibili.com/video/${BV}`);
  assert.equal(videoUrl('not-a-bv'), '');
  const text = shareMaterial(
    { bvid: BV, title: '一只猫', author: '兔总裁s' },
    '你要不要看看',
  );
  assert.match(text, /一只猫/);
  assert.match(text, new RegExp(`https://www\\.bilibili\\.com/video/${BV}`));
  assert.match(text, /你要不要看看/);
  assert.match(text, /兔总裁s/);
});

test('decide：建会话 + 投材料，拿回文本', async () => {
  const calls = [];
  const s = createBrowseSession(
    { ROOST_API_URL: 'http://127.0.0.1:1/v1', ROOST_API_TOKEN: 'tk' },
    {
      log: () => {},
      fetchImpl: async (url, opt) => {
        calls.push([url, opt]);
        if (url.endsWith('/agent.new')) return { ok: true, status: 200, json: async () => ({ ok: true, sessionId: 'bili' }) };
        return { ok: true, status: 200, json: async () => ({ ok: true, text: `[{"bvid":"${BV}","feeling":"好","comment":"","share":"","remember":""}]` }) };
      },
    },
  );
  const r = await s.decide('第 1 条');
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  assert.equal(calls[0][0], 'http://127.0.0.1:1/v1/agent.new');
  /** 第二次必须是同步等待（?wait=1），不然拿不到文本 */
  assert.match(calls[1][0], /agent\.prompt\?wait=1$/);
  assert.equal(JSON.parse(calls[1][1].body).sessionId, 'bili');
});

test('decide：会话已存在时复用，不报错', async () => {
  const s = createBrowseSession(
    { ROOST_API_URL: 'http://127.0.0.1:1/v1', ROOST_API_TOKEN: 'tk' },
    {
      log: () => {},
      fetchImpl: async (url) => {
        if (url.endsWith('/agent.new')) return { ok: false, status: 400, json: async () => ({ ok: false, message: '会话已存在：bili' }) };
        return { ok: true, status: 200, json: async () => ({ ok: true, text: '[]' }) };
      },
    },
  );
  const r = await s.decide('x');
  assert.equal(r.ok, true);
});

test('decide：没给 agent:write 时明确说权限，不反复重试', async () => {
  let news = 0;
  const s = createBrowseSession(
    { ROOST_API_URL: 'http://127.0.0.1:1/v1', ROOST_API_TOKEN: 'tk' },
    {
      log: () => {},
      fetchImpl: async (url) => {
        if (url.endsWith('/agent.new')) news += 1;
        return { ok: false, status: 403, json: async () => ({ ok: false, message: 'forbidden' }) };
      },
    },
  );
  const r = await s.decide('x');
  assert.equal(r.ok, false);
  assert.match(r.why, /agent:write|forbidden/);
});

test('待处理队列：加进去、取一次就清空，处理过的不再回来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-pending-'));
  try {
    const p = createPending({ dir, log: () => {} });
    assert.equal(p.add([{ bvid: BV, title: '一只猫' }]), 1);
    /** 同一条再刷到不算新增 */
    assert.equal(p.add([{ bvid: BV, title: '一只猫' }]), 0);

    const first = p.take();
    assert.equal(first.length, 1);
    assert.equal(first[0].bvid, BV);
    /** 看即处理：再取就没有了 */
    assert.equal(p.take().length, 0);
    /** 已经处理过的，下次刷到也不再进来 */
    assert.equal(p.add([{ bvid: BV, title: '一只猫' }]), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parsePayload：对象格式带 replies（新提示词）', () => {
  const r = parsePayload(`{"items":[{"bvid":"${BV}","comment":"好"}],"replies":[{"id":"123","text":"回你"}]}`);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].comment, '好');
  assert.equal(r.replies.length, 1);
  assert.equal(r.replies[0].id, '123');
});

test('parsePayload：纯数组仍兼容（模型偶尔按老格式写）', () => {
  const r = parsePayload(`[{"bvid":"${BV}","feeling":"x"}]`);
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.replies, []);
});

test('parsePayload：数组里的对象不会被当成根对象', () => {
  /**
   * 关键回归：`[{...}]` 里也有 `{`，若先按对象切，会切成单个对象、
   * items 取不到，整轮变成「她什么都没想做」。
   */
  const r = parsePayload(`好的：[{"bvid":"${BV}","share":"看这个"}]`);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].share, '看这个');
});

test('materialOfVideos：有画面描述就多一行，没有就不写「画面：无」', () => {
  const withDesc = materialOfVideos(
    [{ bvid: BV, title: '猫', author: 'up', play: 1 }],
    { descriptions: new Map([[BV, '橘猫在窗台上打盹。']]) },
  );
  assert.match(withDesc, /画面：橘猫在窗台上打盹。/);

  const without = materialOfVideos([{ bvid: BV, title: '猫', author: 'up', play: 1 }]);
  assert.equal(/画面：/.test(without), false, '没描述就整行不出现');
});

/**
 * 2026-11-14 第六轮：独立会话 `/v1/agent.*` 接连撞硬隔离、接口不符、
 * closed handle、no provider/model 把宿主带崩，而且按设计不写 sessions.json
 * —— 侧栏根本看不到窗口。改成宿主注入的 `systemTurn`（aurabot
 * `runSystemTurn` 的对等实现），一次调用跑完一轮，窗口常驻侧栏。
 */
test('有 systemTurn 时直接跑宿主系统会话，完全不发 HTTP', async () => {
  const calls = [];
  const s = createBrowseSession(
    { ROOST_API_URL: 'http://127.0.0.1:1', ROOST_API_TOKEN: 'x' },
    {
      fetchImpl: async () => { calls.push('http'); throw new Error('不该走 HTTP'); },
      systemTurn: async (name, text, opts) => {
        calls.push(name);
        assert.match(text, /值班员/, 'SECTION 要自己拼进正文，不再靠 sections 注册');
        assert.match(text, /这一轮刷到的视频/);
        assert.match(text, /不会发到聊天里/);
        assert.equal(opts.windowName, '刷B站', '窗口名要进 sessionTitle 认的 name 字段');
        return `{"items":[{"bvid":"${BV}","feeling":"有意思","comment":"","danmaku":"","share":"","remember":""}],"replies":[]}`;
      },
    },
  );
  assert.equal(s.available, true);
  const r = await s.decide('1. 一只猫');
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].feeling, '有意思');
  await s.close();
  assert.deepEqual(calls, ['bili'], 'close 不该关掉常驻窗口，也不该发 HTTP');
});

test('systemTurn 报错时如实返回原因，不假装成功', async () => {
  const s = createBrowseSession({}, {
    systemTurn: async () => { throw new Error('模型服务暂时不可用'); },
  });
  const r = await s.decide('材料');
  assert.equal(r.ok, false);
  assert.match(r.why, /模型服务暂时不可用/);
});

test('没有 systemTurn 时仍回退 /v1/agent.* 三步（MCP 子进程 / 旧宿主）', async () => {
  const seen = [];
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  const s = createBrowseSession(
    { ROOST_API_URL: 'http://127.0.0.1:17321/v1', ROOST_API_TOKEN: 't' },
    {
      fetchImpl: async (url) => {
        seen.push(String(url).split('?')[0].replace('http://127.0.0.1:17321/v1', ''));
        if (String(url).includes('/agent.new')) return json({ ok: true, sessionId: 'bili' });
        return json({ ok: true, text: `{"items":[],"replies":[]}` });
      },
    },
  );
  const r = await s.decide('材料');
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ['/agent.new', '/agent.prompt']);
});

/**
 * 2026-11-14：主人问「为什么没有链接」——以前把 `d.share` 一句话当素材投，
 * 扩展手里现成的标题 / BV / 封面全没带过去，模型只能回「只剩个标题」。
 * 现在分享统一走直连协议发官方图文卡片，回退路径也必须带链接。
 */
function shareHarness(roostLink) {
  const cards = [];
  const submits = [];
  const V = { bvid: BV, title: '一只猫', author: '兔总裁s', play: 1234, desc: '窗台上打盹', cover: 'https://i0.hdslb.com/a.jpg' };
  const self = createSelfBrowse({
    api: { replyFeed: async () => [], view: async () => ({ aid: 1, cid: 2, duration: 30 }) },
    shots: {},
    cfg: { aiDecide: true, vision: false, autoComment: false, autoDanmaku: false },
    write: { comment: async () => ({ ok: true }), danmaku: async () => ({ ok: true }) },
    submit: { submit: async (x) => { submits.push(x); return { ok: true }; } },
    roostLink,
    replied: { has: () => false },
    systemTurn: async () => `{"items":[{"bvid":"${BV}","feeling":"有意思","comment":"","danmaku":"","share":"你要不要看看","remember":""}],"replies":[]}`,
    log: () => {},
  });
  return { self, V, cards, submits };
}

test('她决定分享时发官方图文卡片：链接在 card.url，不再投主动搭话素材', async () => {
  const cards = [];
  const h = shareHarness({
    available: true,
    sendCard: async (card, opts) => { cards.push({ card, opts }); return { ok: true, id: 'm1' }; },
  });
  const r = await h.self.run([h.V], { force: true });
  assert.equal(r.ok, true);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].card.url, `https://www.bilibili.com/video/${BV}`);
  assert.equal(cards[0].card.picUrl, 'https://i0.hdslb.com/a.jpg');
  assert.match(cards[0].card.description, /你要不要看看/, '她写的话放进卡片描述，官方卡片不带正文');
  assert.equal(h.submits.length, 0, '卡片发出去了就不该再拉起主动搭话模型');
});

test('没有直连协议时回退素材通道，素材里必须带可点链接', async () => {
  const h = shareHarness(null);
  const r = await h.self.run([h.V], { force: true });
  assert.equal(r.ok, true);
  assert.equal(h.submits.length, 1);
  assert.match(h.submits[0].text, /一只猫/);
  assert.match(h.submits[0].text, new RegExp(`https://www\\.bilibili\\.com/video/${BV}`));
});

/* ---- 下一轮关键词（2026-11-14，对齐 aurabot duty.js 的 chooseKeywords）---- */

test('parsePayload：nextKeywords 收窄去重；老格式纯数组仍兼容', () => {
  const long = '很长的关键词'.repeat(10);
  const p = parsePayload(JSON.stringify({
    items: [], replies: [], nextKeywords: [' 折纸 ', '观鸟', '折纸', '', long],
  }));
  assert.deepEqual(p.nextKeywords, ['折纸', '观鸟']);
  assert.deepEqual(parsePayload('[]').nextKeywords, [], '老格式（纯数组）不该炸');
  assert.deepEqual(parsePayload('坏文本').nextKeywords, []);
});

test('值班轮次把 nextKeywords 带出来，模型不给就是空数组', async () => {
  const s = createBrowseSession({}, {
    systemTurn: async () => JSON.stringify({
      items: [], replies: [], nextKeywords: ['折纸', '观鸟'],
    }),
  });
  const r = await s.decide('材料');
  assert.equal(r.ok, true);
  assert.deepEqual(r.nextKeywords, ['折纸', '观鸟']);
});

test('她给的下轮关键词写回 seen，下一轮 feed 才拿得到', async () => {
  const seen = createSeenStore();
  const self = createSelfBrowse({
    api: { replyFeed: async () => [], view: async () => ({ aid: 1, cid: 2, duration: 30 }) },
    shots: {},
    cfg: { aiDecide: true, vision: false, autoComment: false, autoDanmaku: false },
    write: { comment: async () => ({ ok: true }), danmaku: async () => ({ ok: true }) },
    submit: { submit: async () => ({ ok: true }) },
    roostLink: null,
    seen,
    replied: { has: () => false },
    systemTurn: async () => JSON.stringify({
      items: [{ bvid: BV, feeling: '有意思', comment: '', danmaku: '', share: '', remember: '' }],
      replies: [],
      nextKeywords: ['折纸', '观鸟'],
    }),
    log: () => {},
  });
  const r = await self.run([{ bvid: BV, title: '一只猫', author: '兔总裁s', play: 1234 }], { force: true });
  assert.equal(r.ok, true);
  assert.deepEqual(seen.nextKeywords(), ['折纸', '观鸟']);
});

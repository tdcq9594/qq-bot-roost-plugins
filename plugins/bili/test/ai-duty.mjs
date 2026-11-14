/**
 * 独立会话值班：她看过再决定，JSON 解析容错，执行边界在扩展这侧。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBrowseSession, materialOfVideos, parseDecisions } from '../lib/ai-duty.mjs';
import { createPending } from '../lib/pending.mjs';

const BV = 'BV1xx411c7mD';

test('parseDecisions：标准 JSON 数组', () => {
  const out = parseDecisions(`[{"bvid":"${BV}","feeling":"这猫真懒","comment":"我家也这样","share":"看看这个","remember":"主人喜欢猫"}]`);
  assert.equal(out.length, 1);
  assert.equal(out[0].comment, '我家也这样');
  assert.equal(out[0].remember, '主人喜欢猫');
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

// ai-chat 的「发文件」通道：`/r/reply` 里的 `files` 字段 + 适配层对「只发文件不说话」的处理。
//
// 这块以前只有手测：宿主（dsh-roost 的 `qq_send_file`）把绝对路径挂进回话，
// 插件在轮末真正上传——中间任何一环把 `files` 丢了，用户看到的是
// 「模型跟我说发了，但什么都没有」。而这类失败**不报错**，控制台干干净净。
//
// 三条容易做错的语义，这里逐条钉死：
//   1. `done:false` + 只有文件 → **不能** resolve（那只是「攒着」，话还没说完）
//   2. `done:true`  + 只有文件 → resolve，`text` 是空串、`files` 非空
//   3. 超时且只有文件 → resolve（不是 reject）——「发个文件不说话」是正常用法
//
//   node --test test/ai-chat-files.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBridge } from '../plugins/ai-chat/adapter/bridge.js';
import { createHostAdapter } from '../plugins/ai-chat/adapter/host.js';

/**
 * 宿主侧（dsh-roost）一轮只挂一个文件，这里限 2 是给「别的宿主」兜底。
 * `bridge.js` 没导出这个常量，所以照抄数值——数值变了这条会红，那正是想要的。
 */
const MAX_FILES = 2;

/** 拿一个已经 create 过的 bridge 条目，外加它的 id / token */
const newEvent = (opts) => {
  const bridge = createBridge({ ttlMs: 60_000, ...opts });
  const evt = bridge.create();
  return { bridge, evt };
};

/** 等到「还没 settle」（给 `done:false` 那类用例用） */
const stillPending = async (p, ms = 30) => {
  const tag = await Promise.race([
    p.then(() => 'resolved', () => 'rejected'),
    new Promise((r) => setTimeout(() => r('pending'), ms)),
  ]);
  return tag === 'pending';
};

test('files：done:false 之后累积，done:true 时一次交出去', async () => {
  const { bridge, evt } = newEvent();
  bridge.handleReply({ id: evt.id, token: evt.token, text: '给你', done: false, files: ['/tmp/a.pdf'] });
  assert.equal(await stillPending(evt.promise), true, 'done:false 不该 resolve');

  bridge.handleReply({ id: evt.id, token: evt.token, done: true, files: ['/tmp/b.pdf'] });
  const r = await evt.promise;
  assert.equal(r.text, '给你');
  assert.deepEqual(r.files, ['/tmp/a.pdf', '/tmp/b.pdf']);
});

test('files：同一个路径重复上报只留一个', async () => {
  const { bridge, evt } = newEvent();
  bridge.handleReply({
    id: evt.id, token: evt.token, done: true,
    files: ['/tmp/a.pdf', '/tmp/a.pdf', ' /tmp/a.pdf '],
  });
  const r = await evt.promise;
  assert.deepEqual(r.files, ['/tmp/a.pdf'], '去重按「trim 之后」比');
});

test(`files：超过 ${MAX_FILES} 个就截断，多的丢掉而不是整批拒`, async () => {
  const logs = [];
  const bridge = createBridge({ ttlMs: 60_000, log: (m) => logs.push(m) });
  const evt = bridge.create();
  bridge.handleReply({
    id: evt.id, token: evt.token, done: true,
    files: ['/1', '/2', '/3', '/4'],
  });
  const r = await evt.promise;
  assert.deepEqual(r.files, ['/1', '/2']);
  assert.ok(logs.some((m) => m.includes('文件数超限')), '丢掉要留痕，否则「说了三个只来两个」查不出原因');
});

test('files：空串和非数组一律忽略，不影响正常收尾', async () => {
  const { bridge, evt } = newEvent();
  bridge.handleReply({
    id: evt.id, token: evt.token, text: '好', done: true,
    files: ['', '   ', null, undefined],
  });
  const r = await evt.promise;
  assert.equal(r.text, '好');
  assert.deepEqual(r.files, []);
});

test('files：done:true 且只带文件 → resolve 出 text:"" + files 非空', async () => {
  const { bridge, evt } = newEvent();
  bridge.handleReply({ id: evt.id, token: evt.token, done: true, files: ['/tmp/a.pdf'] });
  const r = await evt.promise;
  assert.equal(r.text, '');
  assert.deepEqual(r.files, ['/tmp/a.pdf']);
});

test('files：done:false 且只带文件 → 不 resolve（话还没说完）', async () => {
  const { bridge, evt } = newEvent();
  bridge.handleReply({ id: evt.id, token: evt.token, done: false, files: ['/tmp/a.pdf'] });
  assert.equal(await stillPending(evt.promise), true);
  bridge.dispose();
});

/**
 * `bridge` 里的超时定时器是 `unref()` 的（不能让一个待回话的事件吊住进程），
 * 所以等它的时候**得自己留一个 ref 的定时器**，否则事件循环先空掉，
 * node:test 会把「还没 settle」判成 cancelled。生产里不会这样，是因为
 * 真宿主总还有别的活（socket、定时清扫）在跑。
 */
const holdLoop = (ms) => {
  const t = setTimeout(() => {}, ms);
  return () => clearTimeout(t);
};

test('files：令牌不对时既不收文件也不收话（不能让猜到 id 的人往里塞路径）', async () => {
  const { bridge, evt } = newEvent();
  const r = bridge.handleReply({ id: evt.id, token: '错的', done: true, text: 'hi', files: ['/etc/passwd'] });
  assert.equal(r.code, 403);
  assert.equal(await stillPending(evt.promise), true, '被拒了就不能 settle');
  bridge.dispose();
});

test('files：超时且只有文件 → resolve，不是 reject', async () => {
  const bridge = createBridge({ ttlMs: 20 });
  const evt = bridge.create();
  const release = holdLoop(500);
  try {
    bridge.handleReply({ id: evt.id, token: evt.token, done: false, files: ['/tmp/a.pdf'] });
    const r = await evt.promise; // 抛出来就是失败：这里要的就是 resolve
    assert.equal(r.text, '');
    assert.deepEqual(r.files, ['/tmp/a.pdf']);
  } finally {
    release();
    bridge.dispose();
  }
});

test('bridge：一个文件都没有、也没说话，超时才是 reject', async () => {
  const bridge = createBridge({ ttlMs: 20 });
  const evt = bridge.create();
  const release = holdLoop(500);
  try {
    await assert.rejects(evt.promise, /没回话/);
  } finally {
    release();
    bridge.dispose();
  }
});

/* ---------------- 适配层：只回文件不能算「空内容」 ---------------- */

const msg = {
  kind: 'group',
  chatId: 'G1',
  groupId: 'G1',
  userId: 'U1',
  userName: '张三',
  groupName: '摸鱼群',
  content: '发我一份',
  /**
   * 真实 msg 一定有这个（框架 `message.js` 里 `msg.replyFile = ...`）。
   * 适配层用它的存在来判断「这条通道到底能不能发文件」，
   * 桩里缺了它，`channel.files` 会如实报 false。
   */
  replyFile: async () => ({ ok: true }),
};

/**
 * 造一个适配器，并拦住真实网络。
 *
 * `chat()` 是「先 POST 再去 await 回话」两段，所以桩里把 payload 存下来，
 * 用例自己拿 id / token 去 `handleReply` —— 和真宿主做的事一样。
 */
function harness({ ttlMs = 60_000 } = {}) {
  const bridge = createBridge({ ttlMs });
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response('', { status: 200 });
  };
  const adapter = createHostAdapter({
    name: 'dsh',
    url: 'http://127.0.0.1:9',
    bridge,
    publicUrl: () => 'http://127.0.0.1:9',
  });
  return {
    bridge,
    adapter,
    sent,
    restore: () => {
      globalThis.fetch = realFetch;
      bridge.dispose();
    },
  };
}

test('适配层：payload 里显式声明 channel.files（宿主靠 === true 判通道）', async () => {
  const h = harness();
  try {
    const p = h.adapter.chat({ messages: [], msg, chat: { kind: 'group', chatId: 'G1' } });
    await new Promise((r) => setTimeout(r, 10));
    const body = h.sent[0].body;
    assert.equal(body.channel.files, true, '缺了这个字段，dsh-roost 会一直答「这个版本发不了文件」');
    h.bridge.handleReply({ id: body.id, token: body.reply.token, text: '好', done: true });
    await p;
  } finally {
    h.restore();
  }
});

test('适配层：只回文件不抛「宿主回了空内容」', async () => {
  const h = harness();
  try {
    const p = h.adapter.chat({ messages: [], msg, chat: { kind: 'group', chatId: 'G1' } });
    await new Promise((r) => setTimeout(r, 10));
    const body = h.sent[0].body;
    h.bridge.handleReply({ id: body.id, token: body.reply.token, done: true, files: ['/tmp/a.pdf'] });
    const r = await p;
    assert.equal(r.text, '');
    assert.deepEqual(r.files, ['/tmp/a.pdf']);
    assert.equal(r.parts, null, '只有文件时不该伪造出分段');
    assert.equal(r.model, 'dsh');
  } finally {
    h.restore();
  }
});

test('适配层：文本和文件都空才抛「宿主回了空内容」', async () => {
  const h = harness();
  try {
    const p = h.adapter.chat({ messages: [], msg, chat: { kind: 'group', chatId: 'G1' } });
    await new Promise((r) => setTimeout(r, 10));
    const body = h.sent[0].body;
    h.bridge.handleReply({ id: body.id, token: body.reply.token, text: '   ', done: true, files: [] });
    await assert.rejects(p, /宿主回了空内容/);
  } finally {
    h.restore();
  }
});

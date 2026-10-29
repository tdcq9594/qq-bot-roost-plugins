/**
 * 长回复分块时的幂等键（`sendReply`）。
 *
 * 为什么专门测这个：账本的语义是「同一个 requestId 调多少次都只发第一次」
 * ——`delivery.claim` 第二次返回 `reuse`，`outbound.send` 拿到 `reuse`
 * 就直接回上次结果、**不打接口**。而 `sendReply` 以前给所有块发同一个
 * requestId，于是：
 *
 *   planChunks('很长的文本') → [块1, 块2, 块3]
 *   块1 → 真发
 *   块2 → reuse（静默丢弃）
 *   块3 → reuse（静默丢弃）
 *
 * 用户只看到第一块，调用方拿到 `sent: 3` 以为全发出去了。
 * 这是「操作报成功而数据在别处没发生」的又一例，所以断言不看返回值，
 * 看的是**每一块实际传给发送层的 requestId**。
 *
 *   node test/ai-chat-chunk-ids.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '../plugins/ai-chat');

const { sendReply, planChunks, MAX_CHUNK } = await import(
  pathToFileURL(path.join(PLUGIN, 'outbound.js')).href
);

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}${detail ? '  ' + detail : ''}`);
  }
};

/**
 * 假消息：把每次发送的 (正文, requestId) 记下来。
 *
 * 只实现 `sendReply` 真正会碰到的几个方法。`replyStream` 故意不给，
 * 让它走普通发送路径。
 */
function fakeMsg({ kind = 'group', markdownOk = true } = {}) {
  const calls = [];
  const msg = {
    kind,
    reply: async (text, opts) => {
      calls.push({ how: 'reply', text, requestId: opts?.requestId ?? '' });
      return { id: `m-${calls.length}` };
    },
    replyNow: async (text, opts) => {
      calls.push({ how: 'replyNow', text, requestId: opts?.requestId ?? '' });
      return { id: `m-${calls.length}` };
    },
    replyMarkdown: async (md, kb, opts) => {
      calls.push({ how: 'replyMarkdown', text: md?.content, requestId: opts?.requestId ?? '' });
      return markdownOk ? { id: `m-${calls.length}` } : null;
    },
  };
  return { msg, calls };
}

/** 造一段会被切成 n 块的长文本（每行比单块上限短，按行切） */
function longText(n) {
  const line = 'x'.repeat(Math.floor(MAX_CHUNK * 0.6));
  return Array.from({ length: n }, () => line).join('\n');
}

/* ---------------- 单块：行为必须和以前一模一样 ---------------- */

{
  const { msg, calls } = fakeMsg();
  await sendReply(msg, '短回复', { requestId: 'req-1' });
  ok('单块：只发一条', calls.length === 1, String(calls.length));
  ok('单块：requestId 原样传下去，不加后缀', calls[0].requestId === 'req-1', calls[0].requestId);
}

{
  const { msg, calls } = fakeMsg();
  await sendReply(msg, '短回复');
  ok('单块：没给 requestId 就一个都不带', calls[0].requestId === '', JSON.stringify(calls[0].requestId));
}

/* ---------------- 多块：每块一个 id ---------------- */

{
  const text = longText(3);
  const chunks = planChunks(text);
  ok('前置：这段文本确实会被切成 3 块', chunks.length === 3, String(chunks.length));

  const { msg, calls } = fakeMsg();
  await sendReply(msg, text, { requestId: 'req-2' });
  ok('多块：三块都发了（不是只有第一块）', calls.length === 3, String(calls.length));

  const ids = calls.map((c) => c.requestId);
  ok('多块：id 是 base#1 / base#2 / base#3', ids.join(',') === 'req-2#1,req-2#2,req-2#3', ids.join(','));
  ok('多块：互不相同（不然第 2 块起会被 reuse 丢掉）', new Set(ids).size === 3, String(new Set(ids).size));
}

{
  const text = longText(3);
  const a = fakeMsg();
  await sendReply(a.msg, text, { requestId: 'req-3' });
  const b = fakeMsg();
  await sendReply(b.msg, text, { requestId: 'req-3' });
  const ia = a.calls.map((c) => c.requestId).join(',');
  const ib = b.calls.map((c) => c.requestId).join(',');
  ok('多块：同一个 base 重发，派生出的 id 完全一致（重发才会命中 reuse）', ia === ib, `${ia} vs ${ib}`);
}

{
  const text = longText(3);
  const { msg, calls } = fakeMsg();
  await sendReply(msg, text);
  ok('多块：没给 requestId 时一个都不带（老调用方行为不变）', calls.every((c) => c.requestId === ''), JSON.stringify(calls.map((c) => c.requestId)));
}

/* ---------------- markdown 首块也要进账本 ---------------- */

{
  const { msg, calls } = fakeMsg();
  await sendReply(msg, '短回复', { requestId: 'req-md', markdown: true });
  ok('markdown：走 replyMarkdown 而不是 reply', calls[0].how === 'replyMarkdown', calls[0].how);
  ok('markdown：也带上了 requestId（以前这条路完全绕过账本）', calls[0].requestId === 'req-md', calls[0].requestId);
}

{
  const text = longText(2);
  const { msg, calls } = fakeMsg();
  await sendReply(msg, text, { requestId: 'req-md2', markdown: true });
  ok('markdown 多块：首块是 base#1', calls[0].requestId === 'req-md2#1', calls[0].requestId);
  ok('markdown 多块：第二块是 base#2', calls[1].requestId === 'req-md2#2', calls[1].requestId);
}

{
  // markdown 被拒（返回 null）→ 降级纯文本，**同一块不能换 id**，否则一次发送记两行
  const { msg, calls } = fakeMsg({ markdownOk: false });
  await sendReply(msg, '短回复', { requestId: 'req-md3', markdown: true });
  ok('markdown 降级：先试 markdown 再发纯文本', calls.length === 2, String(calls.length));
  ok('markdown 降级：两次用的是同一个 id', calls[0].requestId === calls[1].requestId, `${calls[0].requestId} / ${calls[1].requestId}`);
}

/* ---------------- 带按钮：一条发完，用 base id ---------------- */

{
  const { msg, calls } = fakeMsg();
  await sendReply(msg, '点一下', { requestId: 'req-kb', keyboard: { content: { rows: [] } } });
  ok('按钮：只发一条', calls.length === 1, String(calls.length));
  ok('按钮：用 base id，不加后缀（按钮只属于这一条消息）', calls[0].requestId === 'req-kb', calls[0].requestId);
}

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.log('失败项: ' + fails.join('、'));
  process.exit(1);
}

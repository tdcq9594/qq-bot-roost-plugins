// 宿主「群会话复用 → 发送者捕获过期」的修复验证
//
// dsh-roost 1.3.13 起上游自带 `mountedChat` + `refreshLiveChat`（`src/live-chat.js`），
// 本扩展不再需要往 node_modules 里打补丁。这里直接**跑上游的真实实现**，
// 而不是照抄一份语义——照抄的副本会漂移，测了等于没测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// 可选：指定 dsh-roost 源码/安装目录，未指定时跳过宿主源码契约检查。
const HOST_DIR = process.env.ROOST_HOST_DIR || '';
const HOST = `${HOST_DIR}/src/host.js`;
const LIVE_CHAT = `${HOST_DIR}/src/live-chat.js`;

const hasHost = existsSync(HOST);
const src = hasHost ? readFileSync(HOST, 'utf8') : '';

/** 宿主的按人优先级（`personas.js` 的纯函数，这里照抄一份防漂移） */
function pickPersonaId({ persona = {}, chatId = '', senderId = '' } = {}) {
  const bySender = persona?.bySender || {};
  const one = senderId ? bySender[senderId] : '';
  if (one) return String(one);
  const byChat = persona?.byChat || {};
  return String(byChat[chatId] || persona?.current || 'default');
}

test('宿主自己处理「已挂载 agent 每轮刷新 chat」', { skip: !hasHost }, () => {
  assert.ok(src.includes('const mountedChat = new WeakMap();'), '缺少 mountedChat');

  const body = src.slice(src.indexOf('function mount(agent, chat) {'));
  const head = body.slice(0, body.indexOf('const offs = []'));
  assert.ok(head.includes('const prevChat = mountedChat.get(agent);'), '没有取首挂的 chat');
  assert.ok(head.includes('refreshLiveChat(prevChat, chat)'), '没有用 refreshLiveChat 就地刷新');

  // 已挂载分支：先刷新，再 return，最后才是这次才新建的 set
  const iRefresh = head.indexOf('refreshLiveChat(prevChat, chat)');
  const iReturn = head.indexOf('return;', iRefresh);
  const iSet = body.indexOf('mountedChat.set(agent, chat)');
  assert.ok(iRefresh >= 0 && iReturn > iRefresh, '刷新之后必须早退');
  assert.ok(iSet > 0, '首挂时要记录 chat 对象');
  assert.ok(iSet > iReturn, '首挂的 set 应当在早退分支之后');
  /** 我们自己的本地补丁不该再存在（否则等于重复实现两套） */
  assert.ok(!src.includes('本地补丁'), '本地补丁仍在，应当删掉');
});

/* ── 用上游真实模块跑行为 ───────────────────────────── */

const liveChat = existsSync(LIVE_CHAT)
  ? await import(pathToFileURL(LIVE_CHAT).href)
  : null;

test('refreshLiveChat 存在于上游（1.3.13+ 的契约）', { skip: !liveChat }, () => {
  assert.equal(typeof liveChat.refreshLiveChat, 'function');
});

test('A 先发言后，B 不会继承 A 的专属人格；A 再发言仍然生效', { skip: !liveChat }, () => {
  const { refreshLiveChat } = liveChat;
  const persona = { current: 'group-default', byChat: {}, bySender: { A: 'persona-A' } };

  // 复刻 mount() 的语义：只挂一次，之后每轮原地刷新
  const mountedChat = new WeakMap();
  const mount = (agent, chat) => {
    const prev = mountedChat.get(agent);
    if (prev) return refreshLiveChat(prev, chat);
    mountedChat.set(agent, chat);
    return true;
  };

  const agent = { id: 'agent-of-group-1' };
  const resolve = () => {
    const c = mountedChat.get(agent);
    return pickPersonaId({ persona, chatId: c.chatId, senderId: c.senderId });
  };

  mount(agent, { chatId: 'group-1', senderId: 'A', kind: 'group' });
  assert.equal(resolve(), 'persona-A', 'A 的专属人格应当生效');

  mount(agent, { chatId: 'group-1', senderId: 'B', kind: 'group' });
  assert.equal(resolve(), 'group-default', 'B 不该拿到 A 的人格');

  mount(agent, { chatId: 'group-1', senderId: 'A', kind: 'group' });
  assert.equal(resolve(), 'persona-A', 'A 再说话仍然生效');
});

test('没有 senderId 的那一轮不会继承上一位说话人（形状对齐）', { skip: !liveChat }, () => {
  const { refreshLiveChat } = liveChat;
  const prev = { chatId: 'owner', senderId: 'A', kind: 'c2c' };
  // 主动搭话这类字面量没有 senderId
  refreshLiveChat(prev, { chatId: 'owner', kind: 'c2c' });
  assert.equal(prev.senderId, undefined, 'senderId 应当被清掉，否则按人绑定会串到主动开口那轮');
});

test('chat 被冻结时不抛错，只返回 false', { skip: !liveChat }, () => {
  const { refreshLiveChat } = liveChat;
  const frozen = Object.freeze({ chatId: 'x', senderId: 'A' });
  assert.doesNotThrow(() => refreshLiveChat(frozen, { chatId: 'x', senderId: 'B' }));
  assert.equal(refreshLiveChat(frozen, { chatId: 'x', senderId: 'B' }), false);
});

test('未绑定的 B 先挂载，随后 A 发言也能命中', { skip: !liveChat }, () => {
  const { refreshLiveChat } = liveChat;
  const persona = { current: 'group-default', byChat: {}, bySender: { A: 'persona-A' } };
  const mountedChat = new WeakMap();
  const mount = (agent, chat) => {
    const prev = mountedChat.get(agent);
    if (prev) return refreshLiveChat(prev, chat);
    mountedChat.set(agent, chat);
    return true;
  };

  const agent = { id: 'g2' };
  mount(agent, { chatId: 'group-2', senderId: 'B', kind: 'group' });
  const resolve = () => {
    const c = mountedChat.get(agent);
    return pickPersonaId({ persona, chatId: c.chatId, senderId: c.senderId });
  };
  assert.equal(resolve(), 'group-default');

  mount(agent, { chatId: 'group-2', senderId: 'A', kind: 'group' });
  assert.equal(resolve(), 'persona-A', 'A 的绑定必须能命中');
});

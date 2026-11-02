// ai-chat 传给宿主的 `chat.name`：群只取群名、私聊只取昵称，**不互相兜底**。
//
// 这条分支以前零测试。它出过一次真事故：`groupName || userName` 让群会话标题
// 变成发消息人的昵称，私聊又退成 openid——面板上一排会话分不出谁是谁。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hostPayload } from '../plugins/ai-chat/inbound.js';

const group = (over = {}) => ({
  kind: 'group',
  chatId: 'G1',
  groupId: 'G1',
  content: 'hi',
  groupName: '摸鱼群',
  userName: '张三',
  ...over,
});

const c2c = (over = {}) => ({
  kind: 'c2c',
  chatId: 'U1',
  content: 'hi',
  groupName: '',
  userName: '张三',
  ...over,
});

const build = (msg) => hostPayload(msg, { id: 'm1', token: 't', replyUrl: '', expiresAt: 0 });

test('群名：群会话用群名，不拿发送者昵称兜底', () => {
  assert.equal(build(group()).chat.name, '摸鱼群');
});

test('群名：群名拿不到就留空（由宿主兜底成「群 xxxxxx」），不能退成昵称', () => {
  assert.equal(build(group({ groupName: '' })).chat.name, '');
  assert.notEqual(build(group({ groupName: '' })).chat.name, '张三');
});

test('群名：私聊用昵称，不拿群名兜底', () => {
  assert.equal(build(c2c()).chat.name, '张三');
});

test('群名：私聊没昵称就留空，不能退成 openid', () => {
  const p = build(c2c({ userName: '' }));
  assert.equal(p.chat.name, '');
  assert.notEqual(p.chat.name, 'U1');
});

test('群名：kind 只分 c2c 和群，其余一律当群', () => {
  assert.equal(build(group()).chat.kind, 'group');
  assert.equal(build(c2c()).chat.kind, 'c2c');
  assert.equal(build(group({ kind: 'guild' })).chat.kind, 'group');
});

// 卡片串：四项必须拼对，不然宿主那边只会被 tuwenProblem 拦掉、卡片静默不发。
// 不联网、不起 server。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cardOf, cardText } from '../lib/card.mjs';
import { BiliError, httpsOf } from '../lib/api.mjs';

const V = {
  bvid: 'BV1ZAWM61Evb',
  title: '每 天 亿 遍 防止早恋',
  author: '兔总裁s',
  play: 1_954_000,
  tname: '动画',
  desc: '窗台上打盹的猫，很治愈',
  cover: 'https://i0.hdslb.com/bfs/archive/cover.jpg',
};

test('cardOf：四段拼好，链接是 https、封面原样带过去', () => {
  const { card, text } = cardOf(V);
  assert.match(text, /^<<card: .+>>$/);
  assert.equal(card.url, 'https://www.bilibili.com/video/BV1ZAWM61Evb');
  assert.equal(card.picUrl, V.cover);
  assert.equal(card.title, V.title);
  assert.equal(card.description, V.desc);
  const parts = text.slice(8, -2).split('|');
  assert.equal(parts.length, 4, '竖线只用来分四个字段');
  assert.ok(parts.every((p) => p.trim()), '四项都不能空');
});

test('cardOf：标题/描述里的竖线、尖括号、换行都不许破坏标记', () => {
  const { text, card } = cardOf({ ...V, title: 'A｜B <标签>\n第二行', desc: '上|下｜左\n右' });
  assert.doesNotMatch(card.title, /[|｜<>\n]/);
  assert.doesNotMatch(card.description, /[|｜<>\n]/);
  assert.equal(text.slice(8, -2).split('|').length, 4);
});

test('cardOf：按官方口径裁到 50 / 200 字（按字符不是字节）', () => {
  const { card } = cardOf({ ...V, title: '猫'.repeat(80), desc: '狗'.repeat(300) });
  assert.equal([...card.title].length, 50);
  assert.equal([...card.description].length, 200);
});

test('cardOf：没 desc 时用 UP / 播放 / 分区兜底，不会发出空描述', () => {
  const { card } = cardOf({ ...V, desc: '' });
  assert.match(card.description, /兔总裁s/);
  assert.match(card.description, /195\.4万/);
  assert.match(card.description, /动画/);
});

test('cardOf：封面不是 https / 没有 BV 号就当场拒，别让模型抄一段废标记', () => {
  assert.throws(() => cardOf({ ...V, cover: '//i0.hdslb.com/a.jpg' }), (e) => e instanceof BiliError && /https 封面/.test(e.message));
  assert.throws(() => cardOf({ ...V, cover: '' }), (e) => e instanceof BiliError && Boolean(e.hint));
  assert.throws(() => cardOf({ ...V, bvid: 'ep12345' }), (e) => e instanceof BiliError);
});

test('httpsOf：热门榜给的 http:// 封面要升成 https，否则 cardOf 当场拒', () => {
  assert.equal(
    httpsOf('http://i0.hdslb.com/bfs/archive/a.jpg'),
    'https://i0.hdslb.com/bfs/archive/a.jpg',
    'popular 接口给的 pic 是 http，不升级就永远发不出卡片',
  );
  assert.equal(httpsOf('//i0.hdslb.com/bfs/archive/a.jpg'), 'https://i0.hdslb.com/bfs/archive/a.jpg');
  assert.equal(httpsOf('https://i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg', '已经是 https 的别动');
  const { card } = cardOf({ ...V, cover: httpsOf('http://i0.hdslb.com/bfs/archive/a.jpg') });
  assert.match(card.picUrl, /^https:\/\//);
});

test('cardText：把「原样写进回复」说清楚，模型不必猜怎么发', () => {
  const s = cardText(V);
  assert.match(s, /原样写进你的回复/);
  assert.match(s, /<<card: /);
  assert.match(s, /一轮最多写一张/);
  assert.ok(s.length < 3600, '别被宿主的 4KB 截断');
});

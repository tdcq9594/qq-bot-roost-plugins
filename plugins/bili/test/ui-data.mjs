// 面板数据文件的纯函数部分：字段名必须和 plugin.json 的 ui.view.fields 对上。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { rowsOf, createUiData, UI_FILE } from '../lib/ui-data.mjs';

/** 用 fileURLToPath：`URL.pathname` 会把空格编码成 %20、Windows 上还带前导斜杠 */
const HERE = fileURLToPath(new URL('..', import.meta.url));

test('rowsOf：只产出清单里声明的字段，且都是标量', () => {
  const rows = rowsOf([{
    bvid: 'BV1xx', title: '标题', author: 'UP', play: 1954321, duration: 73,
    pubdate: 1700000000000, tname: '游戏', cover: 'https://i0.hdslb.com/a.jpg',
  }]);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.title, '标题');
  assert.equal(r.author, 'UP');
  assert.equal(r.playText, '195.4万');
  assert.equal(r.durText, '1:13');
  assert.equal(r.area, '游戏');
  assert.equal(r.url, 'https://www.bilibili.com/video/BV1xx');
  assert.equal(r.cover, 'https://i0.hdslb.com/a.jpg');
  assert.equal(r.at, 1700000000000);
  /** 每个值都必须是标量：宿主会把对象/数组清空 */
  for (const v of Object.values(r)) {
    assert.ok(['string', 'number'].includes(typeof v), `${typeof v} 不是标量`);
  }
});

test('rowsOf：播放量与时长的人话写法', () => {
  assert.equal(rowsOf([{ play: 999 }])[0].playText, '999');
  assert.equal(rowsOf([{ play: 10000 }])[0].playText, '1.0万');
  assert.equal(rowsOf([{ play: 120000000 }])[0].playText, '1.2亿');
  assert.equal(rowsOf([{ duration: 3725 }])[0].durText, '1:02:05');
  assert.equal(rowsOf([{ duration: 5 }])[0].durText, '0:05');
});

test('rowsOf：脏数据不炸，缺 bvid 就没有链接', () => {
  const r = rowsOf([{}, null, { title: 'x' }]);
  assert.equal(r.length, 3);
  assert.equal(r[0].url, '');
  assert.equal(r[0].title, '');
  assert.equal(rowsOf(null).length, 0);
});

test('写盘：空池不覆盖旧数据（一次失败不该把面板清空）', () => {
  /** 写到系统临时目录：别在扩展目录里留垃圾 */
  const dir = mkdtempSync(join(tmpdir(), 'bili-ui-'));
  try {
    const ui = createUiData({ dir });
    assert.equal(ui.fromPool([]), false);
    assert.equal(ui.fromPool([{ bvid: 'BV1', title: 't' }]), true);
    const saved = JSON.parse(readFileSync(join(dir, UI_FILE), 'utf8'));
    assert.equal(saved.rows.length, 1);
    assert.ok(saved.updatedAt > 0);
    /** 再喂空池：文件还在 */
    ui.fromPool([]);
    assert.equal(JSON.parse(readFileSync(join(dir, UI_FILE), 'utf8')).rows.length, 1);
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch { /* 系统回收 */ }
  }
});

test('清单里的字段名与 rowsOf 的输出一一对应（改一边就要改另一边）', () => {
  const manifest = JSON.parse(readFileSync(join(HERE, 'plugin.json'), 'utf8'));
  const declared = manifest.ui.view.fields.map((f) => f.key).sort();
  const produced = Object.keys(rowsOf([{ bvid: 'x' }])[0]).sort();
  assert.deepEqual(declared, produced, '声明了但没产出（或反过来）都会让面板空白');
});

test('setMeta 是两层合并：不抹掉另一个写入方的字段', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-ui-'));
  try {
    const ui = createUiData({ dir, log: () => {} });
    /** 模拟 MCP 子进程先写：定时刷的开/关与间隔 */
    ui.write(rowsOf([{ bvid: 'BV1xx411c7mD' }]), {
      feed: { enabled: true, minutes: 30, lastAt: 1, count: 3 },
      account: { isLogin: true, uname: 'x' },
    });

    /** 进程内动作后写：它只知道「刚刷了一次」 */
    ui.setMeta({ feed: { lastAt: 999, count: 7, reason: '手动' } });

    const j = JSON.parse(readFileSync(join(dir, UI_FILE), 'utf8'));
    assert.equal(j.meta.feed.enabled, true, '定时刷开关归子进程，不能被这次写入抹掉');
    assert.equal(j.meta.feed.minutes, 30);
    assert.equal(j.meta.feed.lastAt, 999, '自己写的字段要生效');
    assert.equal(j.meta.feed.count, 7);
    assert.deepEqual(j.meta.account, { isLogin: true, uname: 'x' }, '别的块整个保留');
    assert.equal(j.rows.length, 1, 'setMeta 不能把热门列表清空');
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch { /* 系统回收 */ }
  }
});

/**
 * 消息合并的测试。
 *
 * 这块最容易出的 bug 是「三条消息各回一次」——看起来合并了，
 * 其实每条的等待者都放行了。所以重点测「只有第一个拿到 batch」。
 *
 * 跑法：node test/ai-chat-merge.mjs
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, '..', 'plugins', 'ai-chat');

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

const { createMerger } = await import(pathToFileURL(path.join(PLUGIN, 'merge.js')));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 保活。
 * merge.js 里的定时器是 unref 的（插件里不该拖住进程退出），
 * 测试里没有别的东西撑住事件循环，await 就会永远不返回、进程静默退出。
 */
const keep = setInterval(() => {}, 1000);
const M = (id) => ({ id });

/* ---------------- 基本合并 ---------------- */

{
  const m = createMerger({ waitSec: 0.05, maxSec: 1 });
  const p1 = m.add({ chatId: 'g1', msg: M(1), text: '在吗', name: '小明' });
  const p2 = m.add({ chatId: 'g1', msg: M(2), text: '问你个事', name: '小明' });
  const p3 = m.add({ chatId: 'g1', msg: M(3), text: '那个报错怎么办', name: '小明' });

  const [b1, b2, b3] = await Promise.all([p1, p2, p3]);
  ok('合并: 三条攒成一批', b1?.count === 3, String(b1?.count));
  ok('合并: 只有第一个拿到 batch', b1 && !b2 && !b3);
  ok('合并: 文本拼在一起', /在吗[\s\S]*问你个事[\s\S]*那个报错怎么办/.test(b1.text));
  ok('合并: 多人发言带发言人', b1.text.includes('小明：在吗'));
  ok('合并: 回复挂最后一条', b1.msg.id === 3);
}

/* ---------------- 停顿后自动放行 ---------------- */

{
  const m = createMerger({ waitSec: 0.05, maxSec: 1 });
  const p = m.add({ chatId: 'g2', msg: M(1), text: '单条', name: '' });
  const b = await p;
  ok('合并: 单条不等人也放行', b?.count === 1 && b.text === '单条');
  ok('合并: 单条不加发言人前缀', !b.text.includes('：'));
}

/* ---------------- 被 @ 不等待 ---------------- */

{
  const m = createMerger({ waitSec: 10, maxSec: 20 });
  const t0 = Date.now();
  const b = await m.add({ chatId: 'g3', msg: M(9), text: '叫我干嘛', name: '小明', force: true });
  ok('合并: 被 @ 时立刻返回', Date.now() - t0 < 50, `${Date.now() - t0}ms`);
  ok('合并: 被 @ 时 count 为 1', b?.count === 1);
}

/* ---------------- 最长等待 ---------------- */

{
  // 一直发，也最多等 maxSec
  const m = createMerger({ waitSec: 0.08, maxSec: 0.2 });
  const t0 = Date.now();
  const ps = [];
  for (let i = 0; i < 6; i++) {
    ps.push(m.add({ chatId: 'g4', msg: M(i), text: `第${i}句`, name: '话痨' }));
    await wait(60); // 比 waitSec 短，所以一直在续期
  }
  const first = await Promise.all(ps);
  const elapsed = Date.now() - t0;
  ok('合并: 一直发也不会超过 maxSec 太多', elapsed < 600, `${elapsed}ms`);
  ok('合并: 这一批确实被放行了', Boolean(first[0]));
}

/* ---------------- 不同会话互不干扰 ---------------- */

{
  const m = createMerger({ waitSec: 0.05, maxSec: 1 });
  const a = m.add({ chatId: 'ga', msg: M(1), text: 'A 群的话', name: '甲' });
  const b = m.add({ chatId: 'gb', msg: M(2), text: 'B 群的话', name: '乙' });
  const [ra, rb] = await Promise.all([a, b]);
  ok('合并: 两个群各自成批', ra.count === 1 && rb.count === 1);
  ok('合并: 内容没串', ra.text === 'A 群的话' && rb.text === 'B 群的话');
}

/* ---------------- 卸载时全部放行 ---------------- */

{
  const m = createMerger({ waitSec: 10, maxSec: 20 });
  const p = m.add({ chatId: 'g5', msg: M(1), text: '还没说完', name: '小明' });
  ok('合并: 攒着的时候 size 是 1', m.size === 1);
  m.flushAll();
  const b = await p;
  ok('合并: flushAll 之后放行了', b?.text === '还没说完');
  ok('合并: flushAll 之后 size 归零', m.size === 0);
}

/* ---------------- 多人批次带 openid ---------------- */

/**
 * 多条攒成一批时，每条都要带 `昵称(openid)：`。
 *
 * 只带昵称的话模型没法 @ 人（官方只认 openid），
 * 而且群里两个「小明」根本分不清谁是谁。
 */
{
  const m = createMerger({ waitSec: 0.02, maxSec: 1 });
  const p1 = m.add({ chatId: 'g6', msg: M(1), text: '在吗', name: '小明', id: 'AAA111111111' });
  const p2 = m.add({ chatId: 'g6', msg: M(2), text: '问你个事', name: '小红', id: 'BBB222222222' });
  m.flush('g6');
  const [b1, b2] = await Promise.all([p1, p2]);
  ok('合并: 多人批次标了 multi', b1?.multi === true);
  ok('合并: 第一条带 openid', b1?.text.includes('小明(AAA111111111)：在吗'), b1?.text);
  ok('合并: 第二条带 openid', b1?.text.includes('小红(BBB222222222)：问你个事'));
  ok('合并: 只有第一个拿到 batch', b2 === null);
}

{
  const m = createMerger({ waitSec: 0.02, maxSec: 1 });
  const p = m.add({ chatId: 'g7', msg: M(3), text: '单条', name: '小明', id: 'AAA111111111' });
  m.flush('g7');
  const b = await p;
  ok('合并: 单条不拼发言人（宿主会贴消息头）', b?.text === '单条', b?.text);
  ok('合并: 单条 multi 是假', b?.multi === false);
}

/* ---------------- 汇总 ---------------- */

clearInterval(keep);
console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.log('失败项:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exitCode = 1;
}

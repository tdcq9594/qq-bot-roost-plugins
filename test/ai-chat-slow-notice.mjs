/**
 * E5：慢回复先回一句。
 *
 * 锁四件事：0 关掉、到点才发、模型回来后取消、发送失败不把这一轮带崩。
 * 用假时钟，不真等 8 秒。
 *
 * 跑法：node test/ai-chat-slow-notice.mjs
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { startSlowNotice } = await import(
  pathToFileURL(path.join(HERE, '..', 'plugins', 'ai-chat', 'slow-notice.js')).href
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

/** 假时钟：记下定时器，手动触发/检查是否被清掉 */
function clock() {
  const timers = [];
  const timer = (fn, ms) => {
    timers.push({ fn, ms, cleared: false });
    return timers.length - 1;
  };
  const clear = (id) => { if (timers[id]) timers[id].cleared = true; };
  return { timers, timer, clear };
}

{
  const c = clock();
  let called = 0;
  startSlowNotice({ replyNow: () => { called += 1; }, sec: 0, timer: c.timer, clear: c.clear });
  ok('sec=0 不启动定时器', c.timers.length === 0 && called === 0);
}

{
  const c = clock();
  let called = 0;
  const notice = startSlowNotice({
    replyNow: (t) => { called += 1; return t; }, sec: 8, timer: c.timer, clear: c.clear,
  });
  ok('按秒数设定时器', c.timers[0]?.ms === 8000, String(c.timers[0]?.ms));
  ok('还没到点不发', called === 0);
  c.timers[0].fn();
  ok('到点发一句预告', called === 1);
  notice.cancel();
  ok('已经发过就不必再清', c.timers[0].cleared === false);
}

{
  const c = clock();
  let text = '';
  const notice = startSlowNotice({
    replyNow: (t) => { text = t; }, sec: 5, timer: c.timer, clear: c.clear,
  });
  notice.cancel();
  ok('模型回来了要取消', c.timers[0].cleared === true);
  ok('取消后不再发', text === '');
}

{
  const c = clock();
  const notice = startSlowNotice({
    replyNow: () => { throw new Error('通道断了'); }, sec: 3, timer: c.timer, clear: c.clear,
  });
  let threw = false;
  try { c.timers[0].fn(); } catch { threw = true; }
  ok('发送抛错不把这一轮带崩', threw === false);
  notice.cancel();
}

{
  const c = clock();
  let text = '';
  startSlowNotice({
    replyNow: (t) => { text = t; }, sec: 2, text: '稍等哈', timer: c.timer, clear: c.clear,
  });
  c.timers[0].fn();
  ok('支持自定义文案', text === '稍等哈', text);
}

{
  const c = clock();
  startSlowNotice({ replyNow: null, sec: 8, timer: c.timer, clear: c.clear });
  ok('没有 replyNow（老框架）不启动', c.timers.length === 0);
}

console.log(`\n${pass} pass, ${fails.length} fail`);
if (fails.length) process.exit(1);

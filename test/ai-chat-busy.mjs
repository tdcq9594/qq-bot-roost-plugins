/**
 * 忙态攒着的队列：这块不报错，只会在超时的那一刻悄悄丢消息，所以盯副作用。
 *
 * 跑法：node test/ai-chat-busy.mjs
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { createBusyQueue } = await import(pathToFileURL(path.join(HERE, '..', 'plugins', 'ai-chat', 'busy-queue.js')).href);

let pass = 0;
const fails = [];
const ok = (name, cond) => {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}`);
  }
};

const q = createBusyQueue();
ok('初始为空', q.size === 0);
ok('push 返回累计条数', q.push('a') === 1 && q.push('b') === 2 && q.push('c') === 3);

const out = q.drain();
ok('drain 一次全取走', out.length === 3);
ok('顺序不变', out[0] === 'a' && out[1] === 'b' && out[2] === 'c');
ok('drain 后清空', q.size === 0 && q.drain().length === 0);
ok('清空后还能再用', q.push('d') === 1 && q.drain()[0] === 'd');

console.log(`\n${pass} pass, ${fails.length} fail`);
if (fails.length) process.exit(1);

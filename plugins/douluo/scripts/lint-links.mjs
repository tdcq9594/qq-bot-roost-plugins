/**
 * 链接上下文检查
 * ==============
 *
 *   node plugins/douluo/scripts/lint-links.mjs
 *
 * 为什么需要这个脚本：
 * `clink()` 生成的是 **markdown 链接**（`[文字](mqqapi://aio/inlinecmd?...)`）。
 * 它只有在 markdown 消息里才会被渲染成可点按钮；塞进**纯文本**消息就会
 * 原样露出 `(mqqapi://aio/inlinecmd?command=%2F%E9%AD%82%E5%85%BD...)` 这种长串。
 *
 * 真机上就是这么翻车的：三处 `msg.reply()` 里放了 clink，群里直接显示原始 URL。
 *
 * 规则：
 *   ✓ 可以用 clink —— `msg.replyMarkdown()`、`msg.replyMenu()`
 *   ✗ 不能用 clink —— `msg.reply()`、`media.send({ text })`（都是纯文本）
 *
 * 检查方式：按**括号配对**找到每个调用的参数范围，看范围内有没有 `clink(`。
 * 按行扫描会误报（后面的语句里有 clink 也算进来）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, '..', 'src', 'cmd', 'handlers.js');
const src = fs.readFileSync(FILE, 'utf8');

/** 纯文本出口：这些调用里不能出现 clink */
const PLAIN_CALLS = ['msg.reply(', 'media.send('];

/** 从 `openIdx`（指向 '(' 之后）找配对的 ')'，返回参数文本 */
function argsOf(text, openIdx) {
  // 调用本身的 '(' 已经算一层，所以起始深度是 1
  let depth = 1;
  let i = openIdx;
  let inStr = null;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    const prev = text[i - 1];
    if (inStr) {
      if (ch === inStr && prev !== '\\') inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openIdx, i);
    }
  }
  return text.slice(openIdx, openIdx + 400);
}

const problems = [];
let checked = 0;

for (const call of PLAIN_CALLS) {
  let idx = src.indexOf(call);
  while (idx >= 0) {
    checked += 1;
    const openIdx = idx + call.length;
    const args = argsOf(src, openIdx);
    if (args.includes('clink(')) {
      const line = src.slice(0, idx).split('\n').length;
      const snippet = args.replace(/\s+/g, ' ').slice(0, 90);
      problems.push({ line, call: call.slice(0, -1), snippet });
    }
    idx = src.indexOf(call, idx + call.length);
  }
}

console.log(`=== 链接上下文检查 ===`);
console.log(`检查 ${checked} 处纯文本出口（${PLAIN_CALLS.map((c) => c.slice(0, -1)).join(' / ')}）\n`);

if (!problems.length) {
  console.log('✓ 纯文本消息里没有 markdown 链接');
  process.exit(0);
}

console.log(`✗ ${problems.length} 处会把链接原样发出去：`);
for (const p of problems) {
  console.log(`  handlers.js:${p.line}  ${p.call}()  ${p.snippet}…`);
}
console.log('\n改法：纯文本里直接写指令名（如 `武魂觉醒`），或者把调用换成 replyMarkdown。');
process.exit(1);

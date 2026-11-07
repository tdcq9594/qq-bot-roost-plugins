/**
 * ai-chat 三个真机缺陷的回归（2026-11-06）
 * ======================================
 *
 * 另一份真机修复记录里，这三个问题是靠手改运行副本的插件源码绕过去的，
 * 源码层一直没修：
 *   1. 单聊预算恒 5，与框架 `PASSIVE_MAX_REPLIES.c2c = 4` 不一致 → 最后一格静默丢；
 *   2. 分段 `qq_send` 参数里的富媒体动作只借了 parseActions 的清理能力，
 *      actions 被丢 → 分段带语音时一条都发不出去；
 *   3. 附件丢失日志把未生效的 `MAX_MEDIA` 打印成「上限」，排查方向被带偏。
 *
 * 跑法：node test/ai-chat-budget-media.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = path.join(HERE, '..', 'plugins', 'ai-chat', 'index.js');
const src = fs.readFileSync(P, 'utf8');
const { maxSegmentsOf } = await import(pathToFileURL(P));

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}${detail ? '  ' + detail : ''}`);
  }
};

/* 1. 额度按场景 */
ok('单聊 c2c 预算 4', maxSegmentsOf({ kind: 'c2c' }) === 4);
ok('群聊 group 预算 5', maxSegmentsOf({ kind: 'group' }) === 5);
ok('未知 / guild / dm 按群聊兜底 5',
  maxSegmentsOf({}) === 5 && maxSegmentsOf({ kind: 'guild' }) === 5 && maxSegmentsOf({ kind: 'dm' }) === 5);
ok('预算调用点走 maxSegmentsOf(msg)，不再直接引用常量',
  src.includes('let budget = maxSegmentsOf(msg);') && !src.includes('let budget = MAX_SEGMENTS;'));
ok('MAX_SEGMENTS 仍保留作段数硬顶与群聊默认值', src.includes('const MAX_SEGMENTS = 5;'));

/* 2. 分段富媒体动作（2026-11-07 B 方案：统一标准图片语法、砍掉兼容层） */
ok('paired 保留每段解析出的 actions，且只调一次 parseActions(raw)',
  src.includes("actions: Array.isArray(parsed.actions) ? parsed.actions : []")
  && src.includes('const parsed = parseActions(raw)')
  && !/markdownImagesToLegacy|keepImages|autoImageLayout|autoLayout|imageRoots|allowedRoots/.test(src));
ok('media 仍是 let，分段动作照样能并进来',
  /let media = actions\.filter\(/.test(src)
  && src.includes('media = media.concat(segMedia)'));
ok('segMedia 收「单独发」的图和语音；正文内联图仍由框架就地排版',
  src.includes('const segMedia = kept.flatMap(')
  && /\(x\.actions \|\| \[\]\)\.filter\(\(a\) => a\.type === 'voice' \|\| a\.type === 'image'\)/.test(src));
ok('两条发送路径都在段里带图时交给框架通用出口',
  (src.match(/sendAutoReply\(msg, /g) ?? []).length >= 2
  && src.includes('hasInlineImage(segs[i])')
  && src.includes('hasInlineImage(body)'));
ok('带按钮不再绕开自动出口：keyboard 传给两条路径',
  (src.match(/keyboard: kb,/g) ?? []).length >= 2);
ok('B 方案: sendAutoReply 不再有 null 兜底，直接取 auto.units',
  (src.match(/n = auto\.units;/g) ?? []).length === 2
  && !src.includes('auto ? auto.units'));
const atMerge = src.indexOf('media = media.concat(segMedia)');
const atEarlyReturn = src.indexOf('if (!body && !segs?.length && !media.length');
ok('合并发生在「什么都没有就不发」早退判断之前',
  atMerge > 0 && atEarlyReturn > 0 && atMerge < atEarlyReturn,
  `merge=${atMerge} early=${atEarlyReturn}`);

/* 3. 日志上限 */
ok('日志报实际生效的 mediaRoom，不再把 MAX_MEDIA 说成上限',
  src.includes('本次上限 ${mediaRoom} 格') && !src.includes('上限 ${MAX_MEDIA}'));
ok('index.js 不再 import 已不使用的 MAX_MEDIA',
  !/import \{[^}]*MAX_MEDIA[^}]*\} from '\.\/outbound\.js'/.test(src));

console.log(`\n${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  console.log('失败：' + fails.join('、'));
  process.exitCode = 1;
}

/**
 * 决策门的测试。
 *
 * 这块是整个插件最该测的地方：判断错了要么「该说话时一声不吭」，
 * 要么「群里每句都插嘴」。两头都是用户会立刻卸载的那种错。
 *
 * 跑法：node test/ai-chat-decide.mjs
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

const { shouldConsider, isSkip, parseActions, SKIP_MARK } = await import(
  pathToFileURL(path.join(PLUGIN, 'decide.js'))
);

const conf = (over = {}) => ({
  decide: 'ai',
  cooldownSec: 20,
  maxRepliesPerMin: 3,
  ignoreWords: ['/'],
  ...over,
});

const group = (over = {}) => ({
  kind: 'group',
  chatId: 'g1',
  content: '今天好热',
  mentioned: false,
  addressed: false,
  ...over,
});

/* ---------------- 硬规则 ---------------- */

ok('私聊一律理，而且跳过模型判断', (() => {
  const r = shouldConsider(group({ kind: 'c2c', content: '在吗' }), conf(), {});
  return r.go === true && r.force === true;
})());

ok('被 @ 时必回，跳过模型判断', (() => {
  const r = shouldConsider(group({ mentioned: true }), conf(), {});
  return r.go === true && r.force === true;
})());

ok('回复机器人的消息也算被叫', (() => {
  const r = shouldConsider(group({ addressed: true }), conf(), {});
  return r.go === true && r.force === true;
})());

ok('斜杠开头的消息不理', (() => {
  const r = shouldConsider(group({ content: '/kun 菜单' }), conf(), {});
  return r.go === false && /开头/.test(r.reason);
})());

ok('空消息不理', (() => {
  const r = shouldConsider(group({ content: '   ' }), conf(), {});
  return r.go === false && /空/.test(r.reason);
})());

ok('「只在 @ 时回复」模式下普通聊天不理', (() => {
  const r = shouldConsider(group(), conf({ decide: 'mention' }), {});
  return r.go === false && /只在/.test(r.reason);
})());

ok('普通消息交给模型判断（不强制）', (() => {
  const r = shouldConsider(group(), conf(), {});
  return r.go === true && r.force === false;
})());

/* ---------------- 冷却与配额 ---------------- */

ok('刚回过就不接（冷却中）', (() => {
  const now = Date.now();
  const r = shouldConsider(group(), conf({ cooldownSec: 20 }), { lastReplyAt: now - 5_000 });
  return r.go === false && /冷却/.test(r.reason);
})());

ok('冷却过了就能接', (() => {
  const now = Date.now();
  const r = shouldConsider(group(), conf({ cooldownSec: 20 }), { lastReplyAt: now - 30_000 });
  return r.go === true;
})());

ok('每分钟配额用满就不接', (() => {
  const now = Date.now();
  const r = shouldConsider(group(), conf({ maxRepliesPerMin: 2 }), {
    replyTimes: [now - 1_000, now - 2_000],
  });
  return r.go === false && /每分钟/.test(r.reason);
})());

ok('一分钟以前的计数不算', (() => {
  const now = Date.now();
  const r = shouldConsider(group(), conf({ maxRepliesPerMin: 2 }), {
    replyTimes: [now - 90_000, now - 80_000],
  });
  return r.go === true;
})());

ok('配额设 0 表示不限', (() => {
  const now = Date.now();
  const r = shouldConsider(group(), conf({ maxRepliesPerMin: 0 }), {
    replyTimes: Array.from({ length: 20 }, (_, i) => now - i * 100),
  });
  return r.go === true;
})());

ok('被 @ 时不受冷却限制', (() => {
  const now = Date.now();
  const r = shouldConsider(group({ mentioned: true }), conf(), { lastReplyAt: now - 1_000 });
  return r.go === true && r.force === true;
})());

/* ---------------- 跳过标记 ---------------- */

ok('只输出 <skip> 算不接', isSkip(SKIP_MARK) === true);
ok('空回复算不接', isSkip('') === true);
ok('空白回复算不接', isSkip('   \n ') === true);
ok('正常回答不算跳过', isSkip('今天确实挺热的') === false);
ok(
  '带了标记但还说了不少，说明其实想答',
  isSkip(`${SKIP_MARK} 不过这个我可以答：热就开空调`) === false,
);

/* ---------------- 动作标记 ---------------- */

{
  const r = parseActions('好，记下了 <<remember: 我住在杭州>>');
  ok('动作: 解析出 remember', r.actions.length === 1 && r.actions[0].type === 'remember');
  ok('动作: 值正确', r.actions[0].value === '我住在杭州', r.actions[0].value);
  ok('动作: 标记从正文里摘掉了', r.text === '好，记下了', JSON.stringify(r.text));
}

{
  const r = parseActions('<<remember: 喜欢猫>>\n<<persona: 你是个毒舌群友>>');
  ok('动作: 一次多个', r.actions.length === 2 && r.actions.map((a) => a.type).join() === 'remember,persona');
  ok('动作: 摘完正文为空', r.text === '', JSON.stringify(r.text));
}

{
  const r = parseActions('<<clear>>');
  ok('动作: clear 没有值', r.actions[0]?.type === 'clear' && r.actions[0].value === undefined);
}

{
  const r = parseActions('<<forget: 杭州>>');
  ok('动作: forget 带关键词', r.actions[0]?.type === 'forget' && r.actions[0].value === '杭州');
}

{
  const r = parseActions('就是普通的一句话，没有标记');
  ok('动作: 没有标记时原样返回', r.actions.length === 0 && r.text === '就是普通的一句话，没有标记');
}

{
  // 模型偶尔会写半个标记，不能把用户看到的正文吃掉
  const r = parseActions('<<remember: 没闭合');
  ok('动作: 不完整的标记不当动作', r.actions.length === 0);
  ok('动作: 不完整的标记原样保留', r.text.includes('没闭合'));
}

{
  const r = parseActions('画好了 <<image: D:/out/cat.png>>');
  ok('动作: 解析出 image', r.actions.length === 1 && r.actions[0].type === 'image');
  ok('动作: image 带路径', r.actions[0].value === 'D:/out/cat.png', r.actions[0].value);
  ok('动作: 正文只剩「画好了」', r.text === '画好了', JSON.stringify(r.text));
}

{
  const r = parseActions('<<voice: https://x/a.silk>>');
  ok('动作: 解析出 voice', r.actions[0]?.type === 'voice' && r.actions[0].value === 'https://x/a.silk');
}

{
  // 图片和文字标记能共存
  const r = parseActions('记一下 <<remember: 喜欢猫>> <<image: a.png>>');
  ok('动作: 文本动作和媒体动作共存', r.actions.length === 2);
  ok('动作: 类型对', r.actions.map((a) => a.type).join() === 'remember,image');
}

/* ---------------- 汇总 ---------------- */

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.log('失败项:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exitCode = 1;
}

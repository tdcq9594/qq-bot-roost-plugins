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

const { shouldConsider, isSkip, stripSkip, takeRetract, parseActions, parseDuration, parseButton, textOf, isFromBot, SKIP_MARK } = await import(
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

ok('冷却期内不丢消息，攒着等冷却结束', (() => {
  const now = Date.now();
  const r = shouldConsider(group(), conf({ cooldownSec: 20 }), { lastReplyAt: now - 5_000 });
  // 以前这里是 go:false —— 用户说的话凭空消失。现在放行，带上剩余时间由合并窗口压住
  return r.go === true && r.cooling === true && r.cooldownLeftMs > 10_000 && /冷却/.test(r.reason);
})());

ok('冷却剩余时间算得对', (() => {
  const now = Date.now();
  const r = shouldConsider(group(), conf({ cooldownSec: 20 }), { lastReplyAt: now - 19_000 });
  return r.cooldownLeftMs > 0 && r.cooldownLeftMs <= 2_000;
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

// 标记是内部约定，绝不能原样发到群里（真机上被 @ 时漏过一次）
ok('剥标记: 只剥标记不碰正文', stripSkip(`${SKIP_MARK} 热就开空调`) === '热就开空调');
ok('剥标记: 纯标记剥完是空串', stripSkip(SKIP_MARK) === '');
ok('剥标记: 多次出现都剥掉', stripSkip(`${SKIP_MARK}嗯${SKIP_MARK}`) === '嗯');
ok('剥标记: 没有标记时原样返回', stripSkip('今天确实挺热的') === '今天确实挺热的');

/* ---------------- 撤回标记 ---------------- */
// 以前是发完正文再 replace，而 body 是 const → 抛 TypeError，整条回复变报错
{
  const r = takeRetract('说错了 <<retract>>');
  ok('撤回: 认出标记', r.want === true);
  ok('撤回: 标记不进正文', r.text === '说错了', JSON.stringify(r.text));

  const only = takeRetract('<<retract>>');
  ok('撤回: 只有标记时正文为空', only.want === true && only.text === '');

  const none = takeRetract('今天挺热的');
  ok('撤回: 没标记时不误判', none.want === false && none.text === '今天挺热的');

  const twice = takeRetract('<<retract>><<retract>>好');
  ok('撤回: 重复标记都摘掉', twice.want === true && twice.text === '好');
}

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

/* ---------------- 语音 ---------------- */

{
  const r = parseActions('晚安 <<say: 早点睡呀>>');
  ok('语音: 解析出 say', r.actions[0]?.type === 'say');
  ok('语音: 内容对', r.actions[0]?.value === '早点睡呀', r.actions[0]?.value);
  ok('语音: 正文不残留标记', r.text === '晚安', JSON.stringify(r.text));
}

/* ---------------- 空消息 / 纯媒体 ---------------- */

{
  const c = { decide: 'ai', cooldownSec: 0, ignoreWords: [] };

  const img = { kind: 'group', content: '', attachments: [{ type: 'image', url: 'https://x/a.png' }] };
  ok('空消息: 纯图片不算空消息', shouldConsider(img, c).reason !== '空消息');

  const voice = { kind: 'group', content: '', attachments: [{ type: 'voice', asrText: '今天几号' }] };
  ok('空消息: 纯语音不算空消息', shouldConsider(voice, c).reason !== '空消息');
  ok('空消息: 语音 ASR 当文本', textOf(voice) === '今天几号', textOf(voice));

  const blank = { kind: 'group', content: '', attachments: [] };
  ok('空消息: 真空白仍然跳过', shouldConsider(blank, c).reason === '空消息');

  ok('空消息: 有文本就用文本', textOf({ content: '你好', attachments: [] }) === '你好');
}

/* ---------------- 按钮 ---------------- */

{
  const b = parseButton('点赞 | 点赞');
  ok('按钮: 解析 label 和 data', b.label === '点赞' && b.data === '点赞');

  const full = parseButton('看运势｜今天运势怎么样');
  ok('按钮: 全角竖线也认', full.label === '看运势' && full.data === '今天运势怎么样');

  const only = parseButton('随便聊聊');
  ok('按钮: 没写内容就用文字当内容', only.data === '随便聊聊');

  ok('按钮: 空的返回 null', parseButton('') === null && parseButton('   ') === null);
  ok('按钮: 太长会截断', parseButton('一二三四五六七八九十十一十二十三 | x').label.length <= 12);
}

{
  // 对话收尾：这边只摘不执行，状态落在 dsh-roost 的 closing.json
  const r = parseActions('那你去忙吧，晚安 <<close: 聊到他说要去忙 | 明天问他忙完没>>');
  ok('收尾: 解析出 close', r.actions.length === 1 && r.actions[0].type === 'close');
  ok(
    '收尾: 值原样带出来',
    r.actions[0].value === '聊到他说要去忙 | 明天问他忙完没',
    r.actions[0].value,
  );
  ok('收尾: 正文不残留标记', r.text === '那你去忙吧，晚安', JSON.stringify(r.text));
}

{
  /**
   * 收尾**可以单独出现**。
   *
   * 「不说话地退场」正是它的用法（说完晚安，下一轮只留一个标记），
   * 所以正文为空是正常结局，不该被当成"模型没说人话"。
   */
  const r = parseActions('<<close: 聊完了 | 下次接着问>>');
  ok('收尾: 可以只有标记', r.actions.length === 1 && r.text === '');
}

{
  // 不闭合的 close 跟别的标记一样，原样留着，别把正文吃掉
  const r = parseActions('晚安 <<close: 没闭合');
  ok('收尾: 不完整不当动作', r.actions.length === 0 && r.text.includes('没闭合'));
}

/* ---------------- 情绪 / 未知标记兜底 ---------------- */

{
  /**
   * `<<mood:>>` 必须被摘掉。
   *
   * 它由 DSH 宿主执行，ai-chat 这边只管别让它漏进群——
   * 而 `qq_send` 的工具参数里模型是真会写这个的。
   */
  const r = parseActions('<<mood: valence=-0.3, reason=被凶了>>今天不想说话');
  ok('情绪: 标记被摘掉', r.text === '今天不想说话', JSON.stringify(r.text));
  ok('情绪: 值原样带出来', r.actions.some((a) => a.type === 'mood' && a.value.includes('被凶了')));
}

{
  /**
   * 兜底：**没实现过的**标记也得摘掉。
   *
   * 两个仓库各写一套正则，一边加了新标记、另一边没跟上，标记就漏进群了
   * （mood 已经这么漏过一次）。这条测的就是「以后再加新标记也不会漏」。
   */
  const r = parseActions('<<wake: 早八>>醒了 <<nonexistent>>');
  ok('兜底: 未知标记被摘干净', r.text === '醒了', JSON.stringify(r.text));
}

{
  // 单尖括号和普通比较符号不能被误伤
  const r = parseActions('if (a << 3) 就 << 2，这是代码');
  ok('兜底: 不误伤普通尖括号', r.text.includes('<< 3') && r.text.includes('<< 2'), JSON.stringify(r.text));
}

{
  // 标记夹在中间，前后正文都得留着
  const r = parseActions('前半句<<mood: energy=0.8>>后半句');
  ok('情绪: 中间标记不吞正文', r.text === '前半句后半句', JSON.stringify(r.text));
}

/* ---------------- 机器人发的消息 ---------------- */

{
  // 官方 author.bot=true：机器人发的
  ok('机器人: author.bot=true 认出来', isFromBot({ raw: { author: { bot: true } } }) === true);
  // 真人：author.bot=false
  ok('机器人: 真人 bot=false 放行', isFromBot({ raw: { author: { bot: false } } }) === false);
  // 老消息/别的通道没有这个字段，不能当成机器人
  ok('机器人: 没有 bot 字段按真人处理', isFromBot({ raw: { author: { username: '小明' } } }) === false);
  ok('机器人: 连 author 都没有也不炸', isFromBot({ raw: {} }) === false);
  // 框架将来给了 msg.isBot 就直接用
  ok('机器人: 认 msg.isBot', isFromBot({ isBot: true }) === true);
  // 空消息不能抛
  ok('机器人: undefined 不炸', isFromBot(undefined) === false);
}

/* ---------------- 静默标记 ---------------- */

/**
 * `<<silence:2h>>` 是唯一一个**会改变运行状态**的动作标记——
 * 别的标记改的是记忆或人设，这个会让机器人真的闭嘴。
 * 所以它错了的代价是「机器人突然不理人」，比漏记一条记忆严重得多。
 */

{
  const r = parseActions('让我静静 <<silence:2h>>');
  ok('静默: 标记从正文里摘干净', r.text === '让我静静', JSON.stringify(r.text));
  ok('静默: 解析成 silence 动作', r.actions.length === 1 && r.actions[0].type === 'silence');
  ok('静默: 带上原始时长', r.actions[0]?.value === '2h', String(r.actions[0]?.value));
}

{
  // 只有标记、没有正文：合法（「我要安静，没什么要说的」）
  const r = parseActions('<<silence:30m>>');
  ok('静默: 只有标记时正文为空', r.text === '');
  ok('静默: 只有标记也能解析出动作', r.actions.some((a) => a.type === 'silence'));
}

{
  // 不带时长：按未知标记摘掉，**不生效**——无期限静默等于「再也不说话」
  const r = parseActions('<<silence>> 我先撤了');
  ok('静默: 不带时长时被兜底摘掉', r.text === '我先撤了', JSON.stringify(r.text));
  ok('静默: 不带时长不产生动作', !r.actions.some((a) => a.type === 'silence'));
}

{
  ok('时长: 2h = 7200000ms', parseDuration('2h') === 7_200_000);
  ok('时长: 默认单位是分钟', parseDuration('30') === 1_800_000);
  ok('时长: 90s', parseDuration('90s') === 90_000);
  ok('时长: 1d', parseDuration('1d') === 86_400_000);
  ok('时长: 认不出来返回 0', parseDuration('乱写') === 0);
  ok('时长: 空值返回 0', parseDuration('') === 0);
  // 上限：`<<silence:9999h>>` 不能变成永久静默
  ok('时长: 有 30 天上限', parseDuration('9999h') === 30 * 86_400_000);
}

/* ---------------- 汇总 ---------------- */

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.log('失败项:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exitCode = 1;
}

/**
 * 接话策略与静默状态的契约（阶段 2）：这里锁死「默认 = 现状」。
 *
 * 跑法：node test/ai-chat-policy-config.mjs
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(HERE, '..', 'plugins', 'ai-chat', 'policy-config.js')).href);
const {
  POLICY_MODES, GROUP_POLICY_DEFAULTS, normalizeGroupPolicy,
  inQuietHours, isSilent, withSilent, SILENT_STATE_KEY,
  policyFromConfig, topicRelevance, isShortAsk, RELEVANCE_MIN,
} = mod;

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

ok('默认策略就是现状 ai', normalizeGroupPolicy().mode === 'ai');
ok('五个模式都注册了（原有三个 + 两个 opt-in），第一个仍是 ai',
  POLICY_MODES.length === 5 && POLICY_MODES[0].value === 'ai'
  && POLICY_MODES.map((m) => m.value).join(',') === 'ai,mention,window,relevance,engaged');
ok('默认刹车全关（0 = 不限制），不改变线上行为',
  normalizeGroupPolicy().burstMax === 0 && normalizeGroupPolicy().maxPerHour === 0);
ok('默认静默时段不生效（起止相等）',
  GROUP_POLICY_DEFAULTS.quietStartHour === GROUP_POLICY_DEFAULTS.quietEndHour
  && !inQuietHours({}, 3));
ok('默认不许 shortAsk 强制放行', normalizeGroupPolicy().shortAskMustReply === false);

const cfg = { mode: 'relevance', burstMax: 8, maxPerHour: 6, shortAskMustReply: true, engagedMaxTurns: 4 };
ok('合法值原样保留', (() => {
  const p = normalizeGroupPolicy(cfg);
  return p.mode === 'relevance' && p.burstMax === 8 && p.maxPerHour === 6
    && p.shortAskMustReply === true && p.engagedMaxTurns === 4;
})());
ok('归一化不改输入', cfg.mode === 'relevance' && cfg.burstMax === 8);

for (const bad of [null, undefined, 42, 'x', [], { mode: 'nope' }]) {
  ok(`坏配置 ${JSON.stringify(bad)} 回落到默认值`, normalizeGroupPolicy(bad).mode === 'ai');
}
ok('越界数字回默认，不抛错',
  normalizeGroupPolicy({ burstMax: 999 }).burstMax === 0
  && normalizeGroupPolicy({ maxPerHour: -1 }).maxPerHour === 0);
ok('空字符串不能被 Number() 当成 0（能力页清空输入框那个坑）',
  normalizeGroupPolicy({ burstMax: '' }).burstMax === 0
  && normalizeGroupPolicy({ engagedMaxTurns: '' }).engagedMaxTurns === GROUP_POLICY_DEFAULTS.engagedMaxTurns);
ok('小数不收', normalizeGroupPolicy({ burstMax: 2.5 }).burstMax === 0);
ok('0 是合法值（关掉刹车）', normalizeGroupPolicy({ burstMax: 0, maxPerHour: 0 }).burstMax === 0);

ok('静默时段 1-8：3 点静默、9 点不静默',
  inQuietHours({ quietStartHour: 1, quietEndHour: 8 }, 3)
  && !inQuietHours({ quietStartHour: 1, quietEndHour: 8 }, 9));
ok('跨零点 23-8：0 点静默、12 点不静默',
  inQuietHours({ quietStartHour: 23, quietEndHour: 8 }, 0)
  && !inQuietHours({ quietStartHour: 23, quietEndHour: 8 }, 12));
ok('起止相等 = 不设静默（全天都不拦）',
  [0, 3, 8, 23].every((h) => !inQuietHours({ quietStartHour: 3, quietEndHour: 3 }, h)));

ok('没状态就是没静默', isSilent() === false && isSilent({}) === false);
ok('字符串 "true" 不算静默', isSilent({ [SILENT_STATE_KEY]: 'true' }) === false);
const s1 = withSilent({ a: 1 }, true);
ok('withSilent 写入且不改原对象', isSilent(s1) && !isSilent({ a: 1 }) && s1.a === 1);
ok('withSilent(false) 能取消', !isSilent(withSilent(s1, false)));

/* ---- 阶段 3：扁平配置、相关度打分、短句追问 ---- */

ok('框架扁平键 → 策略对象', (() => {
  const p = policyFromConfig({
    decide: 'relevance', policyBurstMax: 8, policyMaxPerHour: 6,
    policyQuietStartHour: 1, policyQuietEndHour: 8,
    policyShortAskMustReply: true, policyEngagedMaxTurns: 4,
  });
  return p.mode === 'relevance' && p.burstMax === 8 && p.maxPerHour === 6
    && p.quietStartHour === 1 && p.quietEndHour === 8
    && p.shortAskMustReply === true && p.engagedMaxTurns === 4;
})());
ok('空扁平配置 = 默认策略（升级后行为不变）', (() => {
  const p = policyFromConfig({});
  return p.mode === 'ai' && p.burstMax === 0 && p.maxPerHour === 0
    && p.quietStartHour === p.quietEndHour && p.shortAskMustReply === false;
})());
ok('扁平配置里写嵌套 groupPolicy 不会误读', policyFromConfig({ groupPolicy: { mode: 'engaged' } }).mode === 'ai');

ok('相关度：问句过门', topicRelevance('这个要怎么弄啊？') >= RELEVANCE_MIN);
ok('相关度：话题词过门', topicRelevance('今天天气真好') >= RELEVANCE_MIN);
ok('相关度：长句过门', topicRelevance('我刚才看了一下那个文档感觉里面对这块的说明还是挺清楚的') >= RELEVANCE_MIN);
ok('相关度：纯附和「嗯」「哦」被拦（省钱正是拦这些）',
  topicRelevance('嗯') < RELEVANCE_MIN && topicRelevance('哦哦') < RELEVANCE_MIN);
ok('相关度：接着刚才的话题说，窗口重合能加分', (() => {
  const alone = topicRelevance('那个怎么解决');
  const withWin = topicRelevance('那个怎么解决', ['前面说的那个 bug 怎么解决', '我也遇到那个了']);
  return withWin >= alone;
})());
ok('相关度：空文本 0 分，不抛错', topicRelevance('') === 0 && topicRelevance(null, [null, 3]) === 0);
ok('相关度：上限 1', topicRelevance('为什么这个游戏这么好玩呀？', ['为什么这个游戏这么好玩呀？']) <= 1);

ok('短句追问默认关', isShortAsk('在吗') === false);
ok('短句追问打开后认「在吗 / 人呢」',
  isShortAsk('在吗', true) && isShortAsk('人呢', true) && isShortAsk('在不在', true));
ok('短句追问不认长句和陈述句',
  !isShortAsk('在吗在吗在吗在吗在吗在吗在吗', true) && !isShortAsk('今天好热', true));

ok('相关度：纯标点/问号串不给问句分', topicRelevance('？？？') === 0 && topicRelevance('!!!') === 0);
ok('相关度：窗口里复读本句不加分', topicRelevance('嗯', ['嗯']) === 0);
ok('短句追问：全角问号结尾也认', isShortAsk('在吗？', true) && isShortAsk('人呢？', true));
ok('短句追问：纯问号算追问（全角/半角）', isShortAsk('？？', true) && isShortAsk('?', true));
ok('短句追问：句子中间带「在吗」不算在叫人', !isShortAsk('今天好热在吗', true));

console.log(`\n${pass} pass, ${fails.length} fail`);
if (fails.length) process.exit(1);

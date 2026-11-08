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
ok('三个模式都注册了', POLICY_MODES.length === 3 && POLICY_MODES[0].value === 'ai');
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

console.log(`\n${pass} pass, ${fails.length} fail`);
if (fails.length) process.exit(1);

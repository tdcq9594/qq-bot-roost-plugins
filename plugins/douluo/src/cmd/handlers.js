/**
 * 群聊指令处理器
 * ==============
 *
 * 设计取舍（对比同类插件，逐条是「做得更好」而不是「抄得像」）：
 *
 *   1. 指令面收敛。同类插件铺 95 条顶层指令，玩家记不住、菜单要滑两屏。
 *      这里只暴露 ~26 个**玩家真正会用**的词，其余靠「帮助 <域>」二次展开。
 *   2. 参数统一空格分隔。同类插件空格 / `-` / 数字直接拼接三种混用，
 *      玩家只能靠猜。这里一律空格，参数错就给用法，不静默。
 *   3. 每个动作都有「下一步」。同类插件 13.5% 的指令完全没回复，
 *      玩家不知道是发错了还是游戏坏了。
 *   4. 战斗有取舍。同类插件只有「攻击/魂技」，回合制退化成「按大的那个」。
 *      这里加「防御」（减伤 50% + 回魂力），攒魂力放大招成为可行策略。
 *   5. 战斗带血条。纯数字看不出进度，这里用 ▰▱ 画出来。
 */
import { damageOnce, monsterDef, monsterHp, monsterLevel, power, ringColor } from '../engine/formula.js';
import { expNeed, levelCap, expPercent } from '../engine/progress.js';
import { ATTRS, ATTR_LABEL } from '../engine/modifiers.js';
import { REL_KIND } from '../repo/social.js';

/** 装备部位 → 中文 */
const PART_LABEL = {
  head: '头部',
  arm_l: '左臂',
  arm_r: '右臂',
  leg_l: '左腿',
  leg_r: '右腿',
  torso: '躯干',
  body: '身',
  conduct_atk: '攻击魂导器',
  conduct_def: '防御魂导器',
  domain: '领域',
  mecha: '机甲',
  ship: '战舰',
  spirit_atk: '攻击斗灵',
  spirit_def: '防御斗灵',
};

/** 装备大类 → 中文 */
const KIND_LABEL = {
  bone: '魂骨',
  armor: '斗铠',
  conduct: '魂导器',
  domain: '领域',
  mecha: '机甲',
  ship: '战舰',
  spirit: '斗灵',
};

/** 中文部位 → 内部键，让玩家能说「卸下 左臂」 */
const PART_KEY = Object.fromEntries(Object.entries(PART_LABEL).map(([k, v]) => [v, k]));

/** 伙伴大类 → 中文 */
const COMPANION_LABEL = { soul: '魂灵', pet: '战宠', wsoul: '战魂', card: '集卡' };

/* ---------------- 渲染小工具 ---------------- */

/** 十格血条：数字之外给一个一眼能看的进度 */
function bar(cur, max, width = 10) {
  const c = Math.max(0, Number(cur) || 0);
  const m = Math.max(1, Number(max) || 1);
  const filled = Math.min(width, Math.max(0, Math.round((c / m) * width)));
  return '▰'.repeat(filled) + '▱'.repeat(width - filled) + ` ${Math.round((c / m) * 100)}%`;
}

const mdEscape = (s) => String(s ?? '').replace(/([\\`*_~])/g, '\\$1');

/** 麒麟那套「魂环徐徐升起」的仪式感保留，但年限/颜色分开揭示 */
function ringLine(years, color, skill) {
  return `> 年限 **${years}** 年 · ${color}色魂环${skill ? ` · ${mdEscape(skill)}` : ''}`;
}

/** 战斗事件 → markdown 行 */
function renderEvents(events, { player, battle }) {
  const lines = [];
  for (const e of events) {
    if (e.t === 'damage' && e.by === 'player') {
      lines.push(`你造成 **${e.value}** 伤害${e.crit ? '（暴击）' : ''}${e.skill ? ` · ${mdEscape(e.skill)}` : ''}`);
    } else if (e.t === 'damage' && e.by === 'monster') {
      lines.push(`敌方反击 **${e.value}**${e.defended ? '（已减伤）' : ''}${e.skill ? ` · ${mdEscape(e.skill)}` : ''}`);
    } else if (e.t === 'miss') {
      lines.push('可惜没有命中');
    } else if (e.t === 'dodge' && e.by === 'player') {
      lines.push('你侧身闪开了');
    } else if (e.t === 'defend') {
      lines.push(`你摆出防御姿态 · 本回合承伤 **-${e.cut}%** · 回复魂力 **${e.mp}**`);
    } else if (e.t === 'flee') {
      lines.push('你脱离了战斗');
    } else if (e.t === 'companion') {
      // 伙伴追击：让玩家看见「它在帮我打」
      lines.push(`${mdEscape(e.name)} 追击 **${e.value}**`);
    } else if (e.t === 'tick') {
      const who = e.on === 'monster' ? '敌方' : '你';
      lines.push(e.harmful ? `${who}受到 **${mdEscape(e.name)}** ${e.value} 点伤害` : `${who}的 **${mdEscape(e.name)}** 回复 ${e.value}`);
    } else if (e.t === 'status') {
      const who = e.on === 'monster' ? '敌方' : '你';
      lines.push(`${who}陷入 **${mdEscape(e.name)}**`);
    } else if (e.t === 'expire') {
      lines.push(`**${mdEscape(e.name)}** 已结束`);
    } else if (e.t === 'stunned') {
      lines.push(e.on === 'monster' ? '敌方被控住了，这一下没能出手' : '你被控住了，这一回合动不了');
    } else if (e.t === 'silenced') {
      lines.push('你被封住了魂技，只能普攻');
    } else if (e.t === 'instant_kill') {
      lines.push(e.on === 'monster' ? '**即死印记生效** — 敌方直接倒下' : '**即死印记生效** — 你被直接抹杀');
    }
  }
  return lines;
}

/**
 * 神秘商店：每天刷 3 件，价格按日期确定性浮动（同一天所有人看到一样）。
 * 用日期做种子而不是随机数，玩家「刷新前看到的价格」不会变。
 */
function mysteryShopItems(content) {
  const all = content.db
    .prepare('SELECT si.*, i.name, i.price AS base FROM shop_item si JOIN item i ON i.id = si.item_id WHERE i.enabled = 1 ORDER BY si.item_id')
    .all();
  if (!all.length) return [];
  const seed = Number(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
  const picked = [];
  for (let i = 0; i < 3 && all.length; i += 1) {
    picked.push(all[(seed * 7 + i * 13) % all.length]);
  }
  return picked.map((x, idx) => ({
    ...x,
    base: Number(x.base),
    price: Math.max(1, Math.round(Number(x.base) * (0.6 + ((seed + idx * 17) % 4) * 0.1))),
  }));
}

/* ---------------- 主工厂 ---------------- */

export function createHandlers({ content, players, battles, media, economy, social, guild, craft, balance, mail, progress, growth, qol, extra, pfx = () => '/' }) {
  const cfg = () => content.allCfg();
  const P = (w) => pfx() + w; // 带前缀的指令词，用于菜单的可点击项

  /**
   * 可点击的指令链接（QQ 的 inlinecmd）。
   *
   * 点一下就等于在群里发了这条指令，玩家不用手打。
   * 「下一步」提示里全用它——文游最劝退的就是「知道该干嘛但要自己敲指令」。
   */
  const clink = (cmd, label) =>
    `[${label ?? cmd}](mqqapi://aio/inlinecmd?command=${encodeURIComponent(cmd)}&enter=false&reply=false)`;

  /** 武魂稀有度 */
  const RARITY = ['普通', '稀有', '史诗', '传说'];
  const need = (msg) => {
    const p = players.get(msg.userId);
    if (!p) return { error: '你还没有角色，发 `创建账号 你的名字` 建一个。' };
    return { player: p };
  };

  const H = {};

  /* ================= 菜单 / 帮助 ================= */

  H['斗罗菜单'] = {
    desc: '斗罗主菜单（按功能分组，点哪条发哪条）',
    async run(msg) {
      const dm = players.detail(msg.userId);
      // 没角色就引导建号；有角色就给「下一步」，菜单项自带点击行为
      const hint = dm
        ? nextHint(dm)
        : { text: '还没建号', cmd: P('创建账号'), action: '创建账号', desc: '还没建号' };
      const it = (w, desc) => ({ text: w, cmd: P(w), desc: desc ? `· ${desc}` : '' });
      await msg.replyMenu('斗罗大陆', [
        { title: '下一步', items: [{ text: hint.action ?? hint.text, cmd: hint.cmd, desc: hint.desc ? `· ${hint.desc}` : '' }] },
        { title: '角色', items: [
          it('武魂', '立绘与属性'), it('武魂觉醒', '首次免费'), it('属性'), it('背包'),
          it('使用', '使用 <物品>'), it('批量', '批量 使用 药 5'), it('签到'), it('称号'),
          it('排行', '排行 战力'), it('资料'), it('改名'), it('删号'),
        ]},
        { title: '战斗', items: [
          it('魂兽'), it('挑战魂兽', '挑战魂兽 哥布林'), it('攻击'), it('自动', '自动打完'),
          it('魂技', '魂技 <槽>'), it('魂技升级', '提威力'), it('防御', '减伤回魂力'),
          it('物品', '战斗中用'), it('逃跑'), it('休息', '非战斗回满'), it('复活'),
        ]},
        { title: '魂环', items: [it('魂环'), it('附加魂环'), it('设置魂技'), it('打环'), it('更换魂环')] },
        { title: '装备', items: [
          it('我的装备'), it('魂骨'), it('斗铠'), it('魂导器'), it('装备', '装备 <名字>'),
          it('卸下', '卸下 全部'), it('强化'), it('分解', '换碎片'), it('修理', '耐久归零没加成'),
          it('宝石'), it('开孔'), it('镶嵌'), it('摘孔'), it('封印'), it('解封'),
        ]},
        { title: '伙伴', items: [
          it('伙伴'), it('魂灵'), it('战宠'), it('战魂'), it('集卡'), it('出战'), it('收回'), it('升卡'),
        ]},
        { title: '生活', items: [
          it('职业'), it('转职'), it('职业等级'), it('放弃职业'), it('配方'), it('制作'),
          it('丹鼎'), it('丹火'), it('炼丹', '有成功率与品质'), it('钓鱼'), it('采集'),
        ]},
        { title: '任务与世界', items: [
          it('地图'), it('移动', '移动 北'), it('传送', '传送 <地图>'), it('附近'),
          it('对话', 'NPC 会随等级说不同的话'), it('任务'), it('接受任务'), it('完成任务'),
          it('悬赏', '每日 3 个'), it('图鉴', '魂兽收集'), it('教程'),
        ]},
        { title: '宗门与领地', items: [
          it('宗门'), it('创建宗门'), it('加入宗门'), it('退出宗门'), it('宗门成员'),
          it('捐献'), it('宗门升级', '全员加属性'), it('宗门商店'),
          it('领地'), it('占领'), it('收工', '领地收益'), it('挖矿'), it('宣战'), it('抢夺'),
        ]},
        { title: '经济', items: [
          it('商城'), it('购买'), it('出售'), it('银行'), it('存'), it('取'), it('贷'), it('还'),
          it('拍卖'), it('上架'), it('竞拍'), it('我的拍卖'), it('下架'),
          it('抽奖'), it('月卡'), it('兑换'), it('神秘商店'),
          it('邮件'), it('领取', '领取 全部'),
        ]},
        { title: '社交', items: [
          it('关系'), it('求婚'), it('答应'), it('分手'), it('拜师'), it('出师'), it('加好友'),
          it('喊话'), it('送花'), it('约战'), it('应战'), it('斗魂'), it('排位'),
          it('我的队伍', '组队 +15% 经验'), it('创建队伍'), it('邀请组队'), it('加入队伍'),
          it('队伍离开'), it('踢出队员'),
        ]},
        { title: '进阶', items: [
          it('挑战', '万兽台/深渊/BOSS'), it('世界BOSS'), it('斗天', '战令积分'),
          it('冥想', '挂机得经验'), it('领域', '穿戴的领域型斗铠'), it('领域列表', '43 个可觉醒'),
          it('觉醒领域'), it('开启领域'), it('关闭领域'),
          it('融合列表', '武魂融合'), it('武魂融合'), it('武魂进化'),
          it('充能', '机甲能量'), it('聚能'),
        ]},
        { title: '便捷', items: [
          it('快捷'), it('设置快捷', '设置快捷 1 魂兽'), it('删除快捷'), it('清空快捷'),
          it('匿名'), it('签名'), it('帮助', '全部指令'),
          { text: '用法示例', cmd: null, desc: `\`${P('创建账号')} 唐三\` · \`${P('武魂觉醒')}\` · \`${P('挑战魂兽')} 哥布林\`` },
        ]},
      ]);
    },
  };

  H['帮助'] = {
    desc: '指令说明',
    usage: '帮助 [指令名]',
    async run(msg, args) {
      const key = args[0];
      if (key) {
        const h = H[key];
        if (!h) return msg.reply(`没有「${key}」这个指令。\n> 发 \`帮助\` 看全部`);
        return msg.replyMarkdown({
          content: [
            `## ${key}`,
            `> ${h.desc}`,
            '',
            h.usage ? `**用法** \`${pfx()}${h.usage}\`` : `**用法** \`${pfx()}${key}\` 直接发送`,
          ].join('\n'),
        });
      }
      const groups = [
        ['角色', ['创建账号', '武魂觉醒', '武魂', '属性', '背包', '使用', '签到', '称号', '排行', '删号']],
        ['战斗', ['魂兽', '挑战魂兽', '攻击', '自动', '魂技', '魂技升级', '防御', '物品', '逃跑', '休息', '复活']],
        ['魂环', ['魂环', '附加魂环', '设置魂技', '魂技升级', '打环']],
        ['装备', ['我的装备', '魂骨', '斗铠', '魂导器', '装备', '卸下', '强化', '分解']],
        ['伙伴', ['伙伴', '魂灵', '战宠', '战魂', '集卡', '出战', '收回']],
        ['系统', ['领域', '机甲', '战舰', '斗灵']],
        ['邮件', ['邮件', '领取']],
        ['经济', ['商城', '购买', '出售', '银行', '存', '取', '贷', '还', '拍卖', '上架', '竞拍', '我的拍卖', '下架', '抽奖', '月卡', '兑换']],
        ['社交', ['关系', '求婚', '答应', '分手', '拜师', '出师', '加好友', '喊话', '创建队伍', '我的队伍', '邀请组队', '加入队伍', '队伍离开', '踢出队员']],
        ['对战', ['附近', '斗魂', '排位']],
        ['宗门', ['宗门', '创建宗门', '加入宗门', '退出宗门', '宗门成员', '捐献', '宗门升级', '领地', '占领', '宣战', '抢夺', '收工', '挖矿', '宗门商店']],
        ['生活', ['职业', '转职', '放弃职业', '配方', '制作', '丹鼎', '丹火', '炼丹', '升卡', '职业等级', '钓鱼', '采集']],
        ['进阶', ['挑战', '世界BOSS', '排行', '斗天', '悬赏', '图鉴', '称号', '冥想', '教程', '更换魂环']],
        ['养成', ['宝石', '开孔', '镶嵌', '摘孔', '功法', '血脉', '学', '暗器', '买暗器', '用暗器', '副武魂', '切换武魂', '修理', '武魂进化', '融合列表', '武魂融合', '领域列表', '觉醒领域', '开启领域', '关闭领域', '充能', '聚能', '封印', '解封']],
        ['体验', ['资料', '改名', '签名', '匿名', '送花', '约战', '应战', '批量', '神秘商店', '宗门商店', '快捷', '设置快捷', '删除快捷', '清空快捷']],
        ['世界', ['地图', '移动', '传送', '对话', '任务', '接受任务', '完成任务']],
      ];
      const lines = [
        '## 指令',
        `> 每条都以 \`${pfx()}\` 开头，例如 \`${pfx()}攻击\``,
        '',
      ];
      for (const [g, words] of groups) {
        lines.push(`**${g}**`);
        for (const w of words) lines.push(`- \`${pfx()}${w}\` — ${H[w]?.desc ?? ''}`);
        lines.push('');
      }
      lines.push(`> \`${pfx()}帮助 攻击\` 看单条用法`);
      await msg.replyMarkdown({ content: lines.join('\n') });
    },
  };

  /* ================= 角色 ================= */

  H['创建账号'] = {
    desc: '创建角色（建完再觉醒武魂）',
    usage: '创建账号 <昵称>',
    async run(msg, args) {
      if (players.get(msg.userId)) {
        return msg.reply(
          [`你已经有角色了。`, `> 发 \`${pfx()}属性\` 看看，或者 \`${pfx()}删号\` 重来`].join('\n'),
        );
      }

      // 昵称：允许「男/女」写在前面（老习惯），也允许直接给名字
      const gender = args[0] === '女' ? '女' : '男';
      const name = (args[0] === '男' || args[0] === '女' ? args[1] : args[0]) || msg.userName || '';
      if (!name) {
        return msg.reply(
          [
            `用法：\`${pfx()}创建账号 唐三\``,
            `> 昵称 1–12 个字。想指定性别就写 \`${pfx()}创建账号 女 小舞\``,
          ].join('\n'),
        );
      }
      try {
        // 建号**不给武魂**——武魂要靠「武魂觉醒」，这是原著里最重要的一步
        const p = players.create({ openid: msg.userId, name, gender });
        await msg.replyMarkdown({
          content: [
            '## 账号已创建',
            `> ${mdEscape(p.name)} · ${p.gender} · 六岁`,
            '',
            `**生命** ${p.hp_max} · **魂力** ${p.mp_max} · **攻击** ${p.atk}`,
            '',
            '> 武魂还没觉醒。在斗罗大陆，六岁那年要觉醒武魂，才知道自己是什么命。',
            '',
            `**下一步** ${clink(pfx() + '武魂觉醒')}`,
          ].join('\n'),
        });
      } catch (e) {
        await msg.reply(`建号失败：${e.message}`);
      }
    },
  };

  /** 老名字保留为别名，老玩家不用改习惯 */
  H['开始穿越'] = {
    desc: '创建角色（旧名，等同 创建账号）',
    usage: '开始穿越 <昵称>',
    hidden: true,
    async run(msg, args) {
      return H['创建账号'].run(msg, args);
    },
  };

  H['武魂觉醒'] = {
    desc: '觉醒武魂（首次免费，之后花魂币）',
    usage: '武魂觉醒',
    async run(msg) {
      const p = players.get(msg.userId);
      // 注意：msg.reply 是**纯文本**，不能放 markdown 链接（会原样露出 mqqapi://…）
      if (!p) return msg.reply(`你还没有角色，先发 ${pfx()}创建账号 你的名字`);

      const r = players.awaken(msg.userId);
      if (r.error === 'no_gold') {
        return msg.replyMarkdown({
          content: [
            `## 魂币不够`,
            `> 觉醒要 **${r.need}**，你只有 ${r.have}`,
            `> 已经觉醒 ${r.times} 次了，每次都会更贵`,
            '',
            `**去打怪攒钱** ${clink(pfx() + '魂兽')}`,
          ].join('\n'),
        });
      }
      if (r.error) return msg.reply('觉醒失败，稍后再试。');

      const w = r.wuhun;
      const rarity = RARITY[Number(w.rarity) - 1] ?? '普通';
      const stars = '★'.repeat(Math.max(1, Number(w.rarity) || 1));
      const lines = [
        `## 武魂觉醒 · ${mdEscape(w.name)}`,
        `> ${stars} ${rarity}${r.before ? ` · 原武魂 ${mdEscape(r.before)}` : ''}`,
        r.cost ? `> 花费 ${r.cost} 魂币（第 ${r.times} 次）` : '> **首次觉醒，免费**',
        '',
        `**生命** ${r.player.hp_max} · **魂力** ${r.player.mp_max}`,
        `**攻击** ${r.player.atk} · **防御** ${r.player.def} · **速度** ${r.player.spd}`,
        '',
        mdEscape(w.desc ?? ''),
      ];
      if (r.rings) lines.push('', `> 你已经附了 ${r.rings} 个魂环，觉醒不影响魂环`);
      const nextCost = players.awakenCost(msg.userId);
      lines.push(
        '',
        nextCost
          ? `> 再觉醒一次要 ${nextCost} 魂币 · ${clink(pfx() + '武魂觉醒')}`
          : `> **下一步** ${clink(pfx() + '属性')}`,
      );

      // 有图就图文同条发
      const text = [
        `【武魂觉醒】${w.name}（${rarity}）`,
        `${r.player.hp_max} 生命 · ${r.player.mp_max} 魂力 · ${r.player.atk} 攻击`,
        '',
        `下一步：${pfx()}魂兽 看看附近有什么能打的`,
      ].join('\n');
      if (await media.send(msg, { image: w.image, text })) return;
      await msg.replyMarkdown({ content: lines.join('\n') });
    },
  };

  H['删号'] = {
    desc: '删除角色（不可恢复，需加「确认」）',
    usage: '删号 确认',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      // 不加任何游戏性限制（不要求等级、不要求道具），但必须带「确认」两个字。
      // 这是防手滑，不是防玩家——群里误发一次角色就没了。
      if (String(args[0] ?? '') !== '确认') {
        return msg.replyMarkdown({
          content: [
            '## 确认删号？',
            `> 角色 **${mdEscape(p.name)}** Lv.${p.level} · ${players.ringCount(msg.userId)} 环`,
            '> 魂环、装备、伙伴、宗门、关系 **全部清空，不可恢复**',
            '',
            `**确定要删就点** ${clink(pfx() + '删号 确认', pfx() + '删号 确认')}`,
          ].join('\n'),
        });
      }
      const r = players.remove(msg.userId);
      if (r.error) return msg.reply('删号失败，稍后再试。');
      await msg.replyMarkdown({
        content: [
          '## 已删号',
          `> ${mdEscape(r.name)}（Lv.${r.level}）已从这个世界抹去`,
          '',
          `**重新开始** ${clink(pfx() + '创建账号')}`,
        ].join('\n'),
      });
    },
  };

  H['属性'] = {
    desc: '查看面板与战力',
    async run(msg) {
      players.regen(msg.userId);
      const d = players.detail(msg.userId);
      if (!d) return msg.reply('你还没有角色，发 `创建账号 你的名字` 建一个。');
      const p = d.player;
      const w = content.db.prepare('SELECT name FROM wuhun WHERE id = ?').get(p.wuhun_id);
      const c = cfg();
      const rings = d.rings.length;
      const cap = levelCap(rings, c);
      const years = d.rings.reduce((s, r) => s + r.years, 0);
      const worn = d.equipment.equipped;
      const srcLines = d.equipment.sources.map((s) => {
        // 乘区来源（宗门等级）没有逐项属性，只有百分比
        if (s.type === 'buff') return `- ${mdEscape(s.name)} · 全属性 +${Math.round(Number(s.pct) * 100)}%`;
        const parts = ATTRS.filter((a) => Number(s.attrs?.[a]) > 0).map((a) => `${ATTR_LABEL[a]}+${s.attrs[a]}`);
        const tag = s.type === 'set' ? `套装 ${mdEscape(s.name)}（${s.need} 件）` : mdEscape(s.name);
        return `- ${tag} · ${parts.join(' ')}`;
      });
      await msg.replyMarkdown({
        content: [
          `## ${mdEscape(w?.name ?? '未知武魂')}`,
          `> ${mdEscape(p.name)} · ${p.gender} · Lv.**${p.level}** · 战力 **${p.power}**`,
          '',
          `**生命** ${p.hp}/${p.hp_max}　${bar(p.hp, p.hp_max)}`,
          `**魂力** ${p.mp}/${p.mp_max}　${bar(p.mp, p.mp_max)}`,
          `**经验** ${expPercent(p, c)}%（Lv.${p.level} 上限 ${cap}）`,
          '',
          `**攻击** ${p.atk} · **防御** ${p.def} · **速度** ${p.spd}`,
          `**闪避** ${p.dodge}% · **暴击** ${p.crit}%`,
          `**魂环** ${rings} 个 · 年限合计 **${years}**`,
          `**装备** ${worn.length} 件${worn.length ? `（${worn.map((e) => mdEscape(e.name)).join('、')}）` : ''}`,
          `**魂币** ${p.gold} · **点券** ${p.coupon} · **体力** ${p.stamina}`,
          srcLines.length ? `\n**加成来源**\n${srcLines.join('\n')}` : '',
          '',
          p.level >= cap
            ? '> 已到等级上限，`附加魂环` 才能继续升级'
            : '',
          `**下一步** ${nextHint(d).text}`,
        ].filter(Boolean).join('\n'),
      });
    },
  };

  H['背包'] = {
    desc: '查看背包',
    usage: '背包 [页码]',
    async run(msg, args) {
      const d = players.detail(msg.userId);
      if (!d) return msg.reply('你还没有角色。');
      if (!d.inventory.length) return msg.reply('背包是空的。\n> 去打怪，或者等任务奖励');
      // 参数不是数字 → 当关键词搜索（背包一多，翻页找不到东西）
      const kw = String(args[0] ?? '').trim();
      if (kw && !/^\d+$/.test(kw)) {
        const hit = d.inventory.filter((i) => i.name.includes(kw) || (i.kind ?? '').includes(kw));
        if (!hit.length) return msg.reply(`背包里没有含「${kw}」的东西。`);
        const lines = hit.map((i) => `- **${mdEscape(i.name)}** × ${i.qty}`);
        return msg.replyMarkdown({
          content: [`## 背包 · 搜「${mdEscape(kw)}」`, ...lines, '', `> \`${pfx()}使用 <物品名>\``].join('\n'),
        });
      }
      const page = Math.max(1, Number(args[0]) || 1);
      const size = 10;
      const slice = d.inventory.slice((page - 1) * size, page * size);
      if (!slice.length) return msg.reply(`第 ${page} 页是空的。`);
      const lines = slice.map((i, n) => `- \`${(page - 1) * size + n + 1}\` **${mdEscape(i.name)}** × ${i.qty}`);
      await msg.replyMarkdown({
        content: [`## 背包（${page} 页）`, ...lines, '', `> \`${pfx()}使用 <物品名>\` · \`${pfx()}背包 <关键词>\` 搜索`].join('\n'),
      });
    },
  };

  H['使用'] = {
    desc: '使用物品',
    usage: '使用 <物品名> [数量]',
    async run(msg, args) {
      const d = players.detail(msg.userId);
      if (!d) return msg.reply('你还没有角色。');
      const name = args[0];
      if (!name) return msg.reply('用法：`使用 回魂丹`\n> 发 `背包` 看有什么');
      const qty = Math.max(1, Number(args[1]) || 1);
      const inv = d.inventory.find((i) => i.name === name);
      if (!inv) {
        const near = d.inventory.filter((i) => i.name.includes(name) || name.includes(i.name)).slice(0, 3);
        return msg.reply(
          [`背包里没有「${name}」。`, near.length ? `你要找的是不是：${near.map((i) => i.name).join(' / ')}` : '', '> 发 `背包` 看全部']
            .filter(Boolean).join('\n'),
        );
      }
      if (inv.qty < qty) return msg.reply(`**${name}** 不够（有 ${inv.qty}，要用 ${qty}）。`);

      const item = content.db.prepare('SELECT * FROM item WHERE id = ?').get(inv.item_id);
      const p = players.get(msg.userId);
      let text = '';
      if (item.effect === 'heal_hp') {
        const heal = Math.min(Number(item.amount) * qty, p.hp_max - p.hp);
        players.db.prepare('UPDATE player SET hp = hp + ? WHERE openid = ?').run(heal, p.openid);
        text = `生命回复 **${heal}**`;
      } else if (item.effect === 'heal_mp') {
        const heal = Math.min(Number(item.amount) * qty, p.mp_max - p.mp);
        players.db.prepare('UPDATE player SET mp = mp + ? WHERE openid = ?').run(heal, p.openid);
        text = `魂力回复 **${heal}**`;
      } else if (item.effect === 'add_gold') {
        players.addGold(p.openid, Number(item.amount) * qty, `使用 ${item.name}`);
        text = `获得魂币 **${Number(item.amount) * qty}**`;
      } else if (item.effect === 'add_exp') {
        const r = players.gainExp(p.openid, Number(item.amount) * qty);
        text = `获得经验 **${Number(item.amount) * qty}**${r.leveled ? ` · **升级** Lv.${r.after.level}` : ''}`;
      } else {
        return msg.reply(`**${name}** 现在还用不了。\n> ${item.desc || '（没有说明）'}`);
      }

      players.addItem(p.openid, item.id, -qty, `使用 ${name}`);
      await msg.replyMarkdown({ content: [`## 使用 ${mdEscape(name)} × ${qty}`, `> ${text}`].join('\n') });
    },
  };

  H['签到'] = {
    desc: '每日签到（连续 7 天有阶梯奖励）',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const st = qol.signinState(msg.userId);
      if (st.signedToday) return msg.reply(`今天已经签到过了（连续 ${st.streak} 天）。明天再来。`);

      const r = qol.signin(msg.userId);
      if (r.error === 'trade') return msg.reply(r.message);

      const rewards = content.db.prepare('SELECT * FROM signin_reward ORDER BY day').all();
      const lines = rewards.map((x) => {
        const mark = Number(x.day) === Number(r.day) ? '**← 今天**' : '';
        return `- 第 ${x.day} 天 · ${x.gold} 魂币${x.coupon ? ` · ${x.coupon} 点券` : ''} ${mark}`;
      });
      const got = [];
      if (r.reward?.gold) got.push(`魂币 +${r.reward.gold}`);
      if (r.reward?.coupon) got.push(`点券 +${r.reward.coupon}`);
      if (r.reward?.exp) got.push(`经验 +${r.reward.exp}`);
      for (const it of safeJsonArr(r.reward?.items)) {
        const nm = content.db.prepare('SELECT name FROM item WHERE id = ?').get(Number(it.id));
        got.push(`${nm?.name ?? '物品'} × ${it.qty}`);
      }
      await msg.replyMarkdown({
        content: [
          `## 签到 · 第 ${r.day} 天`,
          `> 连续 ${r.streak} 天`,
          '',
          `**获得** ${got.join(' · ') || '（无）'}`,
          '',
          ...lines,
        ].join('\n'),
      });
    },
  };

  H['称号'] = {
    desc: '称号一览',
    async run(msg) {
      const d = players.detail(msg.userId);
      if (!d) return msg.reply('你还没有角色。');
      const all = content.db.prepare('SELECT id, name, desc FROM title WHERE enabled = 1 ORDER BY id').all();
      const owned = new Set(d.titles);
      const rings = d.rings.length;
      const lines = all.map((t) => {
        const got = owned.has(t.id);
        return `${got ? '**已获得**' : '未获得'} · ${mdEscape(t.name)} — ${mdEscape(t.desc)}`;
      });
      await msg.replyMarkdown({ content: ['## 称号', `> 当前魂环 ${rings} 个`, '', ...lines].join('\n') });
    },
  };

  H['排行'] = {
    desc: '排行榜',
    usage: '排行 [等级|战力|魂币]',
    async run(msg, args) {
      const kind = args[0] || '等级';
      const c = cfg();
      const map = { 等级: 'level DESC, exp DESC', 战力: 'atk DESC', 魂币: 'gold DESC' };
      const order = map[kind] ?? map['等级'];
      const rows = players.db
        .prepare(`SELECT openid, name, level, atk, gold, hp_max, mp_max, def, spd, dodge, crit FROM player ORDER BY ${order} LIMIT 10`)
        .all();
      if (!rows.length) return msg.reply('还没有人上榜。');
      const lines = rows.map((r, i) => {
        const val = kind === '魂币' ? `${r.gold} 魂币` : kind === '战力' ? `战力 ${power(r, c)}` : `Lv.${r.level}`;
        return `- \`${i + 1}\` **${mdEscape(r.name)}** · ${val}`;
      });
      await msg.replyMarkdown({
        content: [`## ${kind}榜`, ...lines, '', '> `排行 战力` / `排行 魂币` 换榜'].join('\n'),
      });
    },
  };

  /* ================= 魂环 ================= */

  H['魂环'] = {
    desc: '查看自己的魂环',
    async run(msg) {
      const d = players.detail(msg.userId);
      if (!d) return msg.reply('你还没有角色。');
      const c = cfg();
      const pending = battles.pendingRing(msg.userId);
      const lines = d.rings.map((r) => {
        const sk = r.skill_id ? content.db.prepare('SELECT name FROM skill WHERE id = ?').get(r.skill_id) : null;
        return `- **第 ${r.slot} 环** · ${ringColor(r.years, c)}色 · **${r.years}** 年 · ${mdEscape(r.name)}${sk ? ` · ${mdEscape(sk.name)}` : ''}`;
      });
      if (!lines.length) lines.push('还没有魂环。');
      if (pending) {
        lines.push('', `**待附加** · ${ringColor(pending.years, c)}色 · **${pending.years}** 年`, '> 发 `附加魂环` 装上');
      }
      await msg.replyMarkdown({
        content: [`## 魂环（${d.rings.length}）`, ...lines].join('\n'),
      });
    },
  };

  H['附加魂环'] = {
    desc: '把打到的魂环装上',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const r = battles.attachRing(msg.userId);
      if (r.error === 'no_pending') return msg.reply('你现在没有待附加的魂环。\n> 去 `挑战魂兽` 打一个');
      if (r.error === 'full') return msg.reply(`魂环已满（${r.maxSlot} 个）。`);
      const c = cfg();
      const sk = r.ring.skillId ? content.db.prepare('SELECT name FROM skill WHERE id = ?').get(r.ring.skillId) : null;
      await msg.replyMarkdown({
        content: [
          `## 第 ${r.ring.slot} 魂环 · 附加成功`,
          ringLine(r.ring.years, ringColor(r.ring.years, c), sk?.name),
          '',
          `**攻击** ${r.player.atk} · **防御** ${r.player.def} · **生命** ${r.player.hp_max}`,
          r.expResult?.leveled ? `\n**升级** → Lv.${r.expResult.after.level}` : '',
          '',
          `> 等级上限提高到 **${levelCap(r.player ? players.ringCount(msg.userId) : 0, c)}**`,
        ].filter(Boolean).join('\n'),
      });
    },
  };

  /**
   * 取玩家魂环上的技能。
   *
   * `ring` / `loadout` 在游戏库，`skill` 在内容库——两个连接不能 JOIN，
   * 之前直接写 `ring r JOIN skill s` 会报 `no such table: skill`。
   * 只能先查 id 再回内容库取名字。
   */
  function ringSkills(openid) {
    const rows = players.db
      .prepare('SELECT slot, skill_id FROM ring WHERE openid = ? AND skill_id IS NOT NULL')
      .all(String(openid));
    return rows
      .map((r) => ({ slot: r.slot, skill: content.db.prepare('SELECT * FROM skill WHERE id = ?').get(r.skill_id) }))
      .filter((x) => x.skill);
  }

  H['设置魂技'] = {
    desc: '把魂技绑定到快捷槽',
    usage: '设置魂技 <槽位> <魂技名>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const slot = Number(args[0]);
      const name = args.slice(1).join(' ');
      if (!slot || !name) return msg.reply('用法：`设置魂技 1 蓝银缠绕`\n> 槽位 1-9，魂技必须是你的魂环带的');
      const mine = ringSkills(p.openid);
      const owned = mine.find((x) => x.skill.name === name)?.skill;
      if (!owned) {
        return msg.reply(
          [
            `你的魂环里没有「${name}」。`,
            mine.length ? `你有：${mine.map((x) => x.skill.name).join(' / ')}` : '你还没有带技能的魂环',
            '> 先 `附加魂环`',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }
      players.db
        .prepare(
          `INSERT INTO loadout (openid, slot, skill_id) VALUES (?,?,?)
           ON CONFLICT(openid, slot) DO UPDATE SET skill_id = excluded.skill_id`,
        )
        .run(p.openid, slot, owned.id);
      await msg.replyMarkdown({
        content: [`## 快捷魂技 ${slot}`, `> 已绑定 **${mdEscape(owned.name)}**（威力 ${owned.power}% · 耗魂力 ${owned.cost}）`, '', `> 战斗中发 \`魂技 ${slot}\``].join('\n'),
      });
    },
  };

  /**
   * 更换魂环：卸下某个槽位。
   *
   * 为什么是「卸下」而不是「替换成新的」：原著里换环就是放弃旧的，
   * 得重新猎杀魂兽。做成「随便换」会让年限门槛形同虚设。
   *
   * 槽位必须连续（1..N）—— ringCount 和 levelCap 都按数量算，
   * 中间空一格会出现「5 个环只有 3 个生效」这种诡异 bug，
   * 所以卸下后后面的槽位要前移。
   */
  H['更换魂环'] = {
    desc: '卸下一个魂环（换环要重新猎杀）',
    usage: '更换魂环 <槽位>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      if (p.status === 'battle') return msg.reply('战斗中不能换环。');
      const d = players.detail(msg.userId);
      const slot = Number(args[0]);
      if (!slot) {
        const list = d.rings.map((r) => r.slot + '（' + r.years + ' 年）').join(' / ') || '（无）';
        return msg.reply(['用法：`' + pfx() + '更换魂环 3`', '> 你现在有：' + list].join('\n'));
      }
      const row = players.db.prepare('SELECT * FROM ring WHERE openid = ? AND slot = ?').get(p.openid, slot);
      if (!row) return msg.reply('第 ' + slot + ' 槽没有魂环。');

      const before = d.rings.length;
      const kept = d.rings.filter((r) => Number(r.slot) !== slot);
      players.db.prepare('DELETE FROM ring WHERE openid = ?').run(p.openid);
      const ins = players.db.prepare('INSERT INTO ring (openid, slot, years, name, skill_id) VALUES (?,?,?,?,?)');
      kept.forEach((r, i) => ins.run(p.openid, i + 1, r.years, r.name ?? '', r.skill_id ?? null));
      const after = players.recalc(p.openid);
      const cap = levelCap(players.ringCount(msg.userId), cfg());

      await msg.replyMarkdown({
        content: [
          '## 第 ' + slot + ' 魂环已卸下',
          ringLine(row.years, ringColor(row.years, cfg()), null),
          '',
          '> 魂环数 ' + before + ' → ' + players.ringCount(msg.userId) + ' · 等级上限降到 **' + cap + '**',
          '> 攻击 ' + after.atk + ' · 防御 ' + after.def + ' · 生命 ' + after.hp_max,
          '',
          '> 想补回来要重新猎杀魂兽：`' + pfx() + '打环`',
        ].join('\n'),
      });
    },
  };

  H['打环'] = {
    desc: '打环建议：按魂兽年龄查年限与颜色',
    async run(msg) {
      const c = cfg();
      const rows = content.db.prepare('SELECT * FROM monster WHERE enabled = 1 ORDER BY age').all();
      const lines = rows.map((m) => {
        const lo = m.age;
        const hi = Math.round(m.age * (1 + Number(c.ring_years_spread ?? 0.5)));
        return `- **${mdEscape(m.name)}** · 年龄 ${m.age} · 掉 **${lo}~${hi}** 年 · ${ringColor(hi, c)}色 · ${m.tier}`;
      });
      await msg.replyMarkdown({
        content: ['## 打环建议', '> 年限越高颜色越好，颜色决定魂环品阶', '', ...lines].join('\n'),
      });
    },
  };

  /* ================= 战斗 ================= */

  H['魂兽'] = {
    desc: '本地图能打的魂兽',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const rows = battles.monstersAt(p.map_id);
      const map = content.db.prepare('SELECT name FROM map WHERE id = ?').get(p.map_id);
      if (!rows.length) return msg.reply(`${map?.name ?? '这里'} 附近没有魂兽。\n> 发 \`地图\` 换个地方`);
      const lines = rows.map((m) => {
        const lv = monsterLevel(m.age);
        return `- **${mdEscape(m.name)}** · ${m.tier} · 年龄 ${m.age}（≈Lv.${lv}）· 目标 ${m.target_rounds} 回合`;
      });
      await msg.replyMarkdown({
        content: [`## ${mdEscape(map?.name ?? '')} 的魂兽`, ...lines, '', '> `挑战魂兽 <名字>` 开打'].join('\n'),
      });
    },
  };

  H['挑战魂兽'] = {
    desc: '开始战斗',
    usage: '挑战魂兽 <魂兽名>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      if (!name) {
        const rows = battles.monstersAt(p.map_id);
        return msg.reply(
          [`用法：\`挑战魂兽 十年白虎\``, rows.length ? `这里有：${rows.map((m) => m.name).join(' / ')}` : '这里没有魂兽']
            .filter(Boolean).join('\n'),
        );
      }
      const r = battles.start(msg.userId, name);
      if (r.error === 'in_battle') return msg.reply('你还在战斗中。\n> 发 `攻击` 继续，或 `逃跑`');
      if (r.error === 'dead') return msg.reply('你已阵亡。\n> 发 `复活`');
      if (r.error === 'no_such') return msg.reply(`没有叫「${name}」的魂兽。\n> 发 \`魂兽\` 看本地图有什么`);
      if (r.error === 'not_here') return msg.reply(`「${name}」不在这张地图。\n> 发 \`魂兽\` 看附近有什么`);
      if (r.error === 'no_stamina') return msg.reply(`体力不够（需要 ${r.need}，你有 ${r.have}）。\n> 体力每分钟恢复`);
      if (r.error) return msg.reply(`开战失败：${r.error}`);

      const b = r.battle;
      // 开战时带魂兽图（图文同条）；没图就发原来的 markdown 面板
      const text = [
        `【${b.monster_name}】战斗开始`,
        `体力 -${r.staminaCost}`,
        '',
        `你　　${r.player.hp}/${r.player.hp_max}　${bar(r.player.hp, r.player.hp_max)}`,
        `敌方　${b.monster_hp}/${b.monster_hp_max}　${bar(b.monster_hp, b.monster_hp_max)}`,
        '',
        `可用：${pfx()}攻击 · ${pfx()}魂技 1 · ${pfx()}防御 · ${pfx()}逃跑`,
      ].join('\n');
      if (await media.send(msg, { image: r.monster?.image, text })) return;

      await msg.replyMarkdown({
        content: [
          `## ${mdEscape(b.monster_name)}`,
          `> 战斗开始 · 体力 -${r.staminaCost}`,
          '',
          `**你** ${r.player.hp}/${r.player.hp_max}　${bar(r.player.hp, r.player.hp_max)}`,
          `**敌方** ${b.monster_hp}/${b.monster_hp_max}　${bar(b.monster_hp, b.monster_hp_max)}`,
          '',
          '> 可用：`攻击` · `魂技 <槽>` · `防御` · `物品 <名>` · `逃跑`',
        ].join('\n'),
      });
    },
  };

  /** 战斗中的一次行动，统一走这里，避免四个入口各写一遍 */
  async function act(msg, action, label) {
    const p = players.get(msg.userId);
    if (!p) return msg.reply('你还没有角色。');
    const r = battles.act(msg.userId, action);
    if (r.error === 'no_battle') return msg.reply('你现在没有在战斗。\n> 发 `魂兽` 找一只');
    if (r.error === 'no_mp') return msg.reply(`魂力不够（需要 ${r.need}，你有 ${r.have}）。\n> 试试 \`防御\` 回魂力`);
    if (r.error === 'cooldown') return msg.reply(`**${mdEscape(r.skill)}** 还在冷却，还要 **${r.left}** 回合。\n> 先 \`攻击\` 或 \`防御\``);
    if (r.error) return msg.reply(`行动失败：${r.error}`);

    const lines = [`### ${label}`];
    lines.push(...renderEvents(r.events, { player: p, battle: r.battle ?? {} }));

    if (r.catchup?.hits) {
      lines.push('', `> 你刚才走神了 ${r.catchup.hits} 回合${r.catchup.skipped ? `（另有 ${r.catchup.skipped} 回合已忽略）` : ''}`);
    }

    if (r.playerDead) {
      lines.push('', '**你已阵亡**', '> 发 `复活` 继续');
      return msg.replyMarkdown({ content: lines.join('\n') });
    }

    if (r.monsterDead) {
      const rw = r.reward ?? {};
      lines.push('', '> 敌方生命归零', '');
      if (rw.ring) {
        const c = cfg();
        lines.push('**魂环徐徐升起**', ringLine(rw.ring.years, ringColor(rw.ring.years, c), rw.ring.skill), '');
      }
      if (rw.ringBlocked) {
        lines.push(
          `> 这只魂兽只有 **${rw.ringBlocked.haveAge}** 年，形成不了第 **${rw.ringBlocked.slot}** 环`,
          `> 需要 **${rw.ringBlocked.needAge}** 年以上的魂兽`,
          '',
        );
      }
      lines.push(`**获得经验** ${rw.expGain ?? 0} · **魂币** ${rw.goldGain ?? 0}`);
      if (Array.isArray(rw.drops) && rw.drops.length) {
        const tag = { item: '', equip: '装备 ', gem: '宝石 ', companion: '伙伴 ' };
        lines.push(`**掉落** ${rw.drops.map((d) => `${tag[d.kind] ?? ''}${mdEscape(d.name)}${d.qty > 1 ? ` × ${d.qty}` : ''}`).join(' · ')}`);
      }
      if (rw.exp?.leveled) lines.push(`**升级** → Lv.${rw.exp.after.level}`);
      if (rw.exp?.capped) lines.push('> 已到等级上限，需要 `附加魂环` 才能继续升级');
      lines.push('', rw.ring ? '> 下一步：`附加魂环`' : '> 下一步：`魂兽` 再来一只');
      return msg.replyMarkdown({ content: lines.join('\n') });
    }

    const b = r.battle;
    const pl = r.player;
    lines.push('', `**你** ${pl.hp}/${pl.hp_max}　${bar(pl.hp, pl.hp_max)}`);
    lines.push(`**敌方** ${b.monster_hp}/${b.monster_hp_max}　${bar(b.monster_hp, b.monster_hp_max)}`);
    lines.push('', '> `攻击` · `魂技 <槽>` · `防御` · `逃跑`');
    return msg.replyMarkdown({ content: lines.join('\n') });
  }

  H['攻击'] = { desc: '普通攻击', run: (msg) => act(msg, { type: 'attack' }, '普通攻击') };
  H['防御'] = { desc: '防御：减伤 50% 并回魂力', run: (msg) => act(msg, { type: 'defend' }, '防御') };

  H['魂技'] = {
    desc: '用快捷魂技',
    usage: '魂技 <槽位>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const slot = Number(args[0]);
      if (!slot) {
        // loadout 在游戏库、skill 在内容库，分两步查（不能 JOIN）
        const rows = players.db
          .prepare('SELECT slot, skill_id FROM loadout WHERE openid = ? ORDER BY slot')
          .all(p.openid)
          .map((r) => ({ slot: r.slot, skill: content.db.prepare('SELECT name, cost FROM skill WHERE id = ?').get(r.skill_id) }))
          .filter((r) => r.skill)
          .map((r) => ({ ...r, lv: players.skillLevel(msg.userId, content.db.prepare('SELECT id FROM skill WHERE name = ?').get(r.skill.name)?.id ?? 0) }));
        return msg.reply(
          [`用法：\`魂技 1\``, rows.length ? `你的快捷：${rows.map((r) => `${r.slot}=${r.skill.name}${r.lv > 1 ? '+' + r.lv : ''}(${r.skill.cost})`).join(' / ')}` : '你还没设置快捷魂技\n> 发 `设置魂技 1 <魂技名>`']
            .filter(Boolean).join('\n'),
        );
      }
      const lo = players.db.prepare('SELECT skill_id FROM loadout WHERE openid = ? AND slot = ?').get(p.openid, slot);
      const row = lo ? content.db.prepare('SELECT * FROM skill WHERE id = ?').get(lo.skill_id) : null;
      if (!row) return msg.reply(`槽位 ${slot} 没有绑定魂技。\n> 发 \`设置魂技 ${slot} <魂技名>\``);
      // 按魂技等级换算实际威力（每级 +8%）
      const eff = players.effectiveSkill(msg.userId, row);
      return act(msg, { type: 'skill', skill: eff }, `魂技 · ${row.name}${eff.level > 1 ? ` +${eff.level}` : ''}`);
    },
  };

  H['物品'] = {
    desc: '战斗中使用物品',
    usage: '物品 <物品名>',
    async run(msg, args) {
      const name = args[0];
      if (!name) return msg.reply('用法：`物品 回魂丹`\n> 战斗外请用 `使用`');
      // 战斗中用物品：先回血/回魂，然后按一次「怪物反击」推进回合
      const d = players.detail(msg.userId);
      if (!d) return msg.reply('你还没有角色。');
      const inv = d.inventory.find((i) => i.name === name);
      if (!inv) return msg.reply(`背包里没有「${name}」。`);
      const item = content.db.prepare('SELECT * FROM item WHERE id = ?').get(inv.item_id);
      if (item.use_scene === 'out') return msg.reply(`**${name}** 不能在战斗中用。`);

      const p = players.get(msg.userId);
      let healed = 0;
      if (item.effect === 'heal_hp') {
        healed = Math.min(Number(item.amount), p.hp_max - p.hp);
        players.db.prepare('UPDATE player SET hp = hp + ? WHERE openid = ?').run(healed, p.openid);
      } else if (item.effect === 'heal_mp') {
        healed = Math.min(Number(item.amount), p.mp_max - p.mp);
        players.db.prepare('UPDATE player SET mp = mp + ? WHERE openid = ?').run(healed, p.openid);
      } else {
        return msg.reply(`**${name}** 战斗中用不了。`);
      }
      players.addItem(p.openid, item.id, -1, `战斗使用 ${name}`);

      // 用物品也占一回合 → 走一次防御式推进（不出手，挨打）
      const r = battles.act(msg.userId, { type: 'defend' });
      if (r.error === 'no_battle') {
        return msg.replyMarkdown({ content: [`## 使用 ${mdEscape(name)}`, `> 回复 **${healed}**`, '', '> 你现在没在战斗'].join('\n') });
      }
      const lines = [`## 使用 ${mdEscape(name)}`, `> 回复 **${healed}**`, ''];
      lines.push(...renderEvents(r.events.filter((e) => e.t !== 'defend'), { player: p, battle: r.battle ?? {} }));
      if (r.playerDead) {
        lines.push('', '**你已阵亡**', '> 发 `复活`');
      } else if (r.monsterDead) {
        lines.push('', '> 敌方倒下（反击中击杀）');
      } else if (r.battle) {
        lines.push('', `**你** ${r.player.hp}/${r.player.hp_max}　${bar(r.player.hp, r.player.hp_max)}`);
        lines.push(`**敌方** ${r.battle.monster_hp}/${r.battle.monster_hp_max}　${bar(r.battle.monster_hp, r.battle.monster_hp_max)}`);
      }
      return msg.replyMarkdown({ content: lines.join('\n') });
    },
  };

  H['逃跑'] = {
    desc: '脱离战斗',
    async run(msg) {
      const r = battles.flee(msg.userId);
      if (r.error === 'no_battle') return msg.reply('你现在没有在战斗。');
      return msg.reply('你脱离了战斗。\n> 体力不会返还');
    },
  };

  H['休息'] = {
    desc: '非战斗时回满生命与魂力',
    async run(msg) {
      const r = players.rest(msg.userId);
      if (r.error === 'no_player') return msg.reply('你还没有角色。');
      if (r.error === 'in_battle') return msg.reply(`战斗中不能休息。\n> 先 \`${pfx()}逃跑\` 或打完`);
      if (r.error === 'dead') return msg.reply(`你已经阵亡，先 \`${pfx()}复活\`。`);
      if (r.error === 'cooldown') return msg.reply(`刚休息过，还要等 **${r.wait}** 秒。`);
      await msg.replyMarkdown({
        content: [
          '## 休息',
          `> 生命 +${r.healedHp} · 魂力 +${r.healedMp}`,
          '',
          `**生命** ${r.player.hp}/${r.player.hp_max}　${bar(r.player.hp, r.player.hp_max)}`,
          `**魂力** ${r.player.mp}/${r.player.mp_max}　${bar(r.player.mp, r.player.mp_max)}`,
        ].join('\n'),
      });
    },
  };

  H['复活'] = {
    desc: '阵亡后复活（默认免费半血）',
    usage: '复活 [满血]',
    async run(msg, args) {
      const full = String(args[0] ?? '').includes('满');
      const r = battles.revive(msg.userId, { full });
      if (r.error === 'no_player') return msg.reply('你还没有角色。');
      if (r.error === 'not_dead') return msg.reply('你现在没有阵亡。');
      if (r.error === 'no_gold') return msg.reply(`满血复活需要 **${r.need}** 魂币，你只有 ${r.have}。\n> 直接发 \`${pfx()}复活\` 可以免费复活半血`);
      await msg.replyMarkdown({
        content: [
          '## 复活成功',
          r.full ? `> 消耗魂币 **${r.cost}** · 满血` : '> 免费复活 · 恢复一半生命',
          '',
          `**生命** ${r.player.hp}/${r.player.hp_max}　${bar(r.player.hp, r.player.hp_max)}`,
          r.full ? '' : `\n> 想要满血：\`${pfx()}复活 满血\`（${cfg().revive_cost_gold ?? 50} 魂币）`,
        ].filter(Boolean).join('\n'),
      });
    },
  };

  H['试打'] = {
    desc: '数值演示（不打真架，只看公式）',
    usage: '试打 <魂兽名>',
    async run(msg, args) {
      const d = players.detail(msg.userId);
      if (!d) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      if (!name) return msg.reply('用法：`试打 十年白虎`');
      const m = content.db.prepare('SELECT * FROM monster WHERE name = ? AND enabled = 1').get(name);
      if (!m) return msg.reply(`没有叫「${name}」的魂兽。`);
      const c = cfg();
      const p = d.player;
      // 怪物属性按内容生成（和真实战斗同一套），不是按你当前输出反推
      const st = balance.monsterStats(m);
      let left = st.hp;
      let rounds = 0;
      let crits = 0;
      while (left > 0 && rounds < 500) {
        const r = damageOnce({ p, target: { def: st.def }, cfg: c });
        left -= r.value;
        if (r.crit) crits += 1;
        rounds += 1;
      }
      await msg.replyMarkdown({
        content: [
          `## 试打 · ${mdEscape(m.name)}`,
          `> ${m.tier} · 年龄 ${m.age}（≈Lv.${st.level}）`,
          '',
          `**怪物生命** ${st.hp}（标准玩家 ${m.target_rounds} 回合）· **防御** ${st.def}`,
          `**实测** 你普攻打完需要 **${rounds}** 回合 · 暴击 ${crits} 次`,
          '',
          rounds < Number(m.target_rounds)
            ? `> 比标准快 ${Number(m.target_rounds) - rounds} 回合，说明你比同级强`
            : rounds > Number(m.target_rounds) + 2
              ? '> 比标准慢，考虑升级或换更弱的魂兽'
              : '> 接近标准节奏',
        ].join('\n'),
      });
    },
  };

  /* ================= 装备（魂骨 / 斗铠 / 魂导器） ================= */

  /**
   * 三个系统共用一个渲染器。
   *
   * 同类插件给魂骨、斗铠、魂导器各写一套查看/装备/卸下，共 20 多条指令；
   * 这里它们只是 `kind` 不同，所以只有「看 / 穿 / 脱」三个动作。
   */
  function renderEquipList(d, kind) {
    const rows = d.equipment.owned.filter((e) => !kind || e.kind === kind);
    const title = kind ? KIND_LABEL[kind] ?? kind : '我的装备';
    if (!rows.length) {
      return { title, lines: ['还没有装备。', '', '> 打怪会掉魂骨，面板也能直接发'] };
    }
    const lines = rows.map((e) => {
      const worn = Number(e.equipped) === 1 ? '**已装备**' : '未装备';
      const attrs = ATTRS.filter((a) => Number(e[a]) > 0).map((a) => `${ATTR_LABEL[a]}+${e[a]}`);
      return `- ${worn} · **${mdEscape(e.name)}**（${PART_LABEL[e.part] ?? e.part}）\n  ${attrs.join(' · ') || '无属性'}`;
    });
    // 套装进度
    const setLines = [];
    const bySet = new Map();
    for (const e of d.equipment.equipped) {
      if (!e.set_id) continue;
      bySet.set(e.set_id, (bySet.get(e.set_id) ?? 0) + 1);
    }
    if (bySet.size) {
      setLines.push('', '**套装**');
      for (const [sid, n] of bySet) {
        const meta = content.db.prepare('SELECT name FROM equip_set WHERE id = ?').get(sid);
        setLines.push(`- ${mdEscape(meta?.name ?? '套装 ' + sid)}：${n} 件`);
      }
    }
    return { title, lines: [...lines, ...setLines, '', '> `装备 <名字>` · `卸下 <部位>`'] };
  }

  function showEquip(kind) {
    return {
      desc: kind ? `查看${KIND_LABEL[kind]}` : '查看全部装备',
      async run(msg) {
        const d = players.detail(msg.userId);
        if (!d) return msg.reply('你还没有角色。');
        const { title, lines } = renderEquipList(d, kind);
        await msg.replyMarkdown({ content: [`## ${title}`, ...lines].join('\n') });
      },
    };
  }

  H['我的装备'] = showEquip(null);
  H['魂骨'] = showEquip('bone');
  H['斗铠'] = showEquip('armor');
  H['魂导器'] = showEquip('conduct');

  H['装备'] = {
    desc: '穿上一件装备',
    usage: '装备 <装备名>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      if (!name) {
        const d = players.detail(msg.userId);
        const free = d.equipment.owned.filter((e) => Number(e.equipped) === 0);
        return msg.reply(
          [`用法：\`装备 鹿之左臂骨\``, free.length ? `可以穿：${free.map((e) => e.name).join(' / ')}` : '你没有未装备的东西']
            .filter(Boolean).join('\n'),
        );
      }
      const r = players.equipItem(msg.userId, name);
      if (r.error === 'not_owned') return msg.reply(`你没有「${name}」。\n> 发 \`我的装备\` 看看`);
      if (r.error === 'already') return msg.reply(`「${name}」已经穿在身上了。`);
      if (r.error === 'slot_taken') {
        return msg.reply(
          `${PART_LABEL[r.part] ?? r.part}已经穿了 **${mdEscape(r.by)}**。\n> 先 \`卸下 ${PART_LABEL[r.part] ?? r.part}\``,
        );
      }
      const attrs = ATTRS.filter((a) => Number(r.item[a]) > 0).map((a) => `${ATTR_LABEL[a]}+${r.item[a]}`);
      await msg.replyMarkdown({
        content: [
          `## 装备 · ${mdEscape(r.item.name)}`,
          `> ${PART_LABEL[r.item.part] ?? r.item.part} · ${attrs.join(' · ') || '无属性'}`,
          '',
          `**攻击** ${r.player.atk} · **防御** ${r.player.def} · **生命** ${r.player.hp_max}`,
          '',
          `> \`属性\` 看完整面板 · \`卸下 ${PART_LABEL[r.item.part] ?? r.item.part}\``,
        ].join('\n'),
      });
    },
  };

  H['卸下'] = {
    desc: '脱下一件装备（或「卸下 全部」）',
    usage: '卸下 <部位|装备名|全部>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const key = args.join(' ').trim();
      if (!key) {
        const d = players.detail(msg.userId);
        if (!d.equipment.equipped.length) return msg.reply('你身上没有装备。');
        return msg.reply(`用法：\`卸下 左臂\`\n> 身上有：${d.equipment.equipped.map((e) => `${PART_LABEL[e.part] ?? e.part}=${e.name}`).join(' / ')}\n> 一次全脱：\`${pfx()}卸下 全部\``);
      }
      // 一键卸下：装备多了以后一件件脱很烦
      if (key === '全部' || key === 'all') {
        const worn = players.detail(msg.userId).equipment.equipped;
        if (!worn.length) return msg.reply('你身上没有装备。');
        for (const e of worn) players.unequipItem(msg.userId, e.name);
        const after = players.recalc(msg.userId);
        return msg.replyMarkdown({
          content: [
            `## 已卸下 ${worn.length} 件`,
            `> ${worn.map((e) => mdEscape(e.name)).join('、')}`,
            '',
            `**攻击** ${after.atk} · **防御** ${after.def}`,
          ].join('\n'),
        });
      }
      const r = players.unequipItem(msg.userId, PART_KEY[key] ?? key);
      if (r.error === 'not_worn') {
        const d = players.detail(msg.userId);
        return msg.reply(
          [`身上没有「${key}」。`, d.equipment.equipped.length ? `现在穿着：${d.equipment.equipped.map((e) => PART_LABEL[e.part] ?? e.part).join(' / ')}` : '你身上没有装备']
            .filter(Boolean).join('\n'),
        );
      }
      await msg.replyMarkdown({
        content: [
          `## 卸下 · ${mdEscape(r.item.name)}`,
          `> ${PART_LABEL[r.item.part] ?? r.item.part} 空了`,
          '',
          `**攻击** ${r.player.atk} · **防御** ${r.player.def} · **生命** ${r.player.hp_max}`,
        ].join('\n'),
      });
    },
  };

  /* ================= 领域 / 机甲 / 战舰 / 斗灵 ================= */

  /**
   * 这四个在同类插件里各有一套「控制/退出/维修/激活/组装/安装…」，
   * 一共 30 多条指令。它们的共同点只有一个：**一个可以开也可以关的加成源**。
   *
   * 所以这里只有一个模板：查看 + 开 + 关。
   * 差异（能量、维修、组装）留给内容表用 desc 描述，真要实现时再加，
   * 不用先为它们各造一套表。
   */
  function systemHandler(verb, kind, onWords, offWords) {
    return {
      desc: `查看并开关${KIND_LABEL[kind]}`,
      usage: `${verb} [${onWords[0]}|${offWords[0]}]`,
      async run(msg, args) {
        const p = players.get(msg.userId);
        if (!p) return msg.reply('你还没有角色。');
        const d = players.detail(msg.userId);
        const mine = d.equipment.owned.filter((e) => e.kind === kind);
        if (!mine.length) {
          return msg.reply(`你还没有${KIND_LABEL[kind]}。\n> 面板「玩家 → 发放」可以直接发`);
        }
        const worn = mine.find((e) => Number(e.equipped) === 1);
        const a = args[0];

        if (onWords.includes(a)) {
          if (worn) return msg.reply(`${mdEscape(worn.name)} 已经开着呢。`);
          const target = mine[0];
          const r = players.equipItem(msg.userId, target.name);
          if (r.error) return msg.reply(`开启失败：${r.error}`);
          return msg.replyMarkdown({
            content: [
              `## ${KIND_LABEL[kind]} · ${mdEscape(target.name)}`,
              '> 已开启',
              '',
              `**攻击** ${r.player.atk} · **防御** ${r.player.def} · **生命** ${r.player.hp_max}`,
              '',
              `> \`${pfx()}${verb} ${offWords[0]}\` 关闭`,
            ].join('\n'),
          });
        }

        if (offWords.includes(a)) {
          if (!worn) return msg.reply(`你现在没开${KIND_LABEL[kind]}。`);
          const r = players.unequipItem(msg.userId, worn.part);
          return msg.replyMarkdown({
            content: [
              `## ${KIND_LABEL[kind]} · ${mdEscape(worn.name)}`,
              '> 已关闭',
              '',
              `**攻击** ${r.player.atk} · **防御** ${r.player.def} · **生命** ${r.player.hp_max}`,
            ].join('\n'),
          });
        }

        const { lines } = renderEquipList(d, kind);
        await msg.replyMarkdown({
          content: [`## ${KIND_LABEL[kind]}`, ...lines, '', `> \`${pfx()}${verb} ${onWords[0]}\` 开启`].join('\n'),
        });
      },
    };
  }

  H['领域'] = systemHandler('领域', 'domain', ['开', '开启', '开领域'], ['关', '关闭', '收']);
  H['机甲'] = systemHandler('机甲', 'mecha', ['控制', '开', '启动'], ['退出', '关', '离开']);
  H['战舰'] = systemHandler('战舰', 'ship', ['激活', '开', '启动'], ['关闭', '停用', '退出']);
  H['斗灵'] = systemHandler('斗灵', 'spirit', ['安装', '装备', '开'], ['卸下', '拆除', '关']);

  /* ================= 武魂（图文同条） ================= */

  /**
   * 武魂立绘走「图文同条」：一条消息里既有图也有字。
   *
   * 注意富媒体消息的 content 是**纯文本**，不支持 markdown，
   * 所以这里刻意用【】和 · 排版；发不出去（没图/开关关/上传失败）再退回 markdown。
   */
  H['武魂'] = {
    desc: '查看武魂与立绘',
    async run(msg) {
      const d = players.detail(msg.userId);
      if (!d) return msg.reply('你还没有角色。');
      const w = content.db
        .prepare('SELECT w.*, s.name AS series FROM wuhun w LEFT JOIN wuhun_series s ON s.id = w.series_id WHERE w.id = ?')
        .get(d.player.wuhun_id);
      if (!w) return msg.reply('武魂数据缺失，去面板检查武魂表。');
      const p = d.player;

      const text = [
        `【武魂】${w.name}`,
        `${w.series ?? '未知系列'} · ${RARITY[Number(w.rarity) - 1] ?? '普通'}`,
        `生命 ${p.hp_max} · 魂力 ${p.mp_max} · 攻击 ${p.atk}`,
        `力量 ${p.str} · 智力 ${p.intel} · 速度 ${p.spd}`,
        `闪避 ${p.dodge}% · 暴击 ${p.crit}%`,
        w.desc ? `\n${w.desc}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      if (await media.send(msg, { image: w.image, text })) return;

      await msg.replyMarkdown({
        content: [
          `## ${mdEscape(w.name)}`,
          `> ${mdEscape(w.series ?? '未知系列')} · ${RARITY[Number(w.rarity) - 1] ?? '普通'}`,
          '',
          `**生命** ${p.hp_max} · **魂力** ${p.mp_max} · **攻击** ${p.atk}`,
          `**力量** ${p.str} · **智力** ${p.intel} · **速度** ${p.spd}`,
          '',
          w.desc ? `> ${mdEscape(w.desc)}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      });
    },
  };

  /* ================= 伙伴（魂灵 / 战宠 / 战魂 / 集卡） ================= */

  function renderCompanionList(d, kind) {
    const rows = d.companions.owned.filter((c) => !kind || c.kind === kind);
    const title = kind ? COMPANION_LABEL[kind] : '伙伴';
    if (!rows.length) {
      return { title, lines: ['还没有。', '', '> 面板「玩家 → 发放」可以直接发'] };
    }
    const lines = rows.map((c) => {
      const st =
        c.kind === 'card' ? '**已收集**' : Number(c.active) === 1 ? '**出战中**' : '未出战';
      const star = '★'.repeat(Math.min(5, Number(c.star) || 1));
      const attrs = ATTRS.filter((a) => Number(c[a]) > 0).map((a) => `${ATTR_LABEL[a]}+${c[a]}`);
      return `- ${st} · **${mdEscape(c.name)}** ${star}\n  ${attrs.join(' · ') || '无属性'}`;
    });

    // 集卡进度（收集即生效，所以单独报一下）
    if (kind === 'card' || !kind) {
      const total = content.db.prepare("SELECT COUNT(*) n FROM companion WHERE kind='card' AND enabled=1").get().n;
      const got = d.companions.cards.length;
      if (total) lines.push('', `**图鉴** ${got}/${total}（收集即生效，不占出战位）`);
    }
    return { title, lines };
  }

  function showCompanion(kind) {
    return {
      desc: kind ? `查看${COMPANION_LABEL[kind]}` : '查看全部伙伴',
      async run(msg) {
        const d = players.detail(msg.userId);
        if (!d) return msg.reply('你还没有角色。');
        const { title, lines } = renderCompanionList(d, kind);
        await msg.replyMarkdown({
          content: [`## ${title}`, ...lines, '', `> \`${pfx()}出战 <名字>\` · \`${pfx()}收回 <名字>\``].join('\n'),
        });
      },
    };
  }

  H['伙伴'] = showCompanion(null);
  H['魂灵'] = showCompanion('soul');
  H['战宠'] = showCompanion('pet');
  H['战魂'] = showCompanion('wsoul');
  H['集卡'] = showCompanion('card');

  H['出战'] = {
    desc: '让伙伴出战（同类只能一个）',
    usage: '出战 <名字>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      if (!name) {
        const d = players.detail(msg.userId);
        const free = d.companions.owned.filter((c) => c.kind !== 'card' && Number(c.active) === 0);
        return msg.reply(
          [`用法：\`出战 百年魂灵\``, free.length ? `可以出战：${free.map((c) => c.name).join(' / ')}` : '没有可出战的伙伴']
            .filter(Boolean).join('\n'),
        );
      }
      const r = players.setCompanionActive(msg.userId, name, true);
      if (r.error === 'not_owned') return msg.reply(`你没有「${name}」。\n> 发 \`${pfx()}伙伴\` 看看`);
      if (r.error === 'card_passive') return msg.reply(`**${name}** 是集卡，收集就生效，不用出战。`);
      if (r.error === 'already') return msg.reply(`**${name}** 已经在出战了。`);
      if (r.error === 'slot_taken') {
        return msg.reply(`${COMPANION_LABEL[r.kind] ?? r.kind}位已经站着 **${mdEscape(r.by)}**。\n> 先 \`${pfx()}收回 ${r.by}\``);
      }
      await msg.replyMarkdown({
        content: [
          `## 出战 · ${mdEscape(r.item.name)}`,
          '',
          `**攻击** ${r.player.atk} · **防御** ${r.player.def} · **生命** ${r.player.hp_max}`,
          '',
          `> \`${pfx()}收回 ${r.item.name}\` 收回`,
        ].join('\n'),
      });
    },
  };

  H['收回'] = {
    desc: '收回出战伙伴',
    usage: '收回 <名字>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      if (!name) {
        const d = players.detail(msg.userId);
        if (!d.companions.active.length) return msg.reply('你现在没有伙伴出战。');
        return msg.reply(`用法：\`收回 百年魂灵\`\n> 出战中：${d.companions.active.map((c) => c.name).join(' / ')}`);
      }
      const r = players.setCompanionActive(msg.userId, name, false);
      if (r.error === 'not_owned') return msg.reply(`你没有「${name}」。`);
      if (r.error === 'not_active') return msg.reply(`**${name}** 没在出战。`);
      await msg.replyMarkdown({
        content: [
          `## 收回 · ${mdEscape(r.item.name)}`,
          '',
          `**攻击** ${r.player.atk} · **防御** ${r.player.def} · **生命** ${r.player.hp_max}`,
        ].join('\n'),
      });
    },
  };

  /* ================= 经济（商城 / 银行 / 拍卖 / 抽奖 / 月卡 / CDK） ================= */

  const CURRENCY = { gold: '魂币', coupon: '点券' };

  H['商城'] = {
    desc: '看商城货架',
    usage: '商城 [商城名]',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      if (!name) {
        const shops = economy.shops();
        if (!shops.length) return msg.reply('还没有开商城。');
        const lines = shops.map((s) => `- **${mdEscape(s.name)}**（${CURRENCY[s.currency] ?? s.currency}）· ${mdEscape(s.desc)}`);
        return msg.replyMarkdown({
          content: ['## 商城', ...lines, '', `> \`${pfx()}商城 杂货铺\` 看货架`].join('\n'),
        });
      }
      const shop = economy.shops().find((s) => s.name === name);
      if (!shop) {
        const near = economy.shops().filter((s) => s.name.includes(name) || name.includes(s.name)).slice(0, 3);
        return msg.reply([`没有「${name}」这个商城。`, near.length ? `你要找的是不是：${near.map((s) => s.name).join(' / ')}` : ''].filter(Boolean).join('\n'));
      }
      const items = economy.shopItems(shop.id);
      if (!items.length) return msg.reply(`**${shop.name}** 还没上货。`);
      const lines = items.map(
        (i) =>
          `- **${mdEscape(i.name)}** · ${i.price} ${CURRENCY[shop.currency]}${Number(i.stock) >= 0 ? ` · 剩 ${i.stock}` : ''}\n  ${mdEscape(i.desc || '')}`,
      );
      await msg.replyMarkdown({
        content: [
          `## ${mdEscape(shop.name)}`,
          `> 结算货币：${CURRENCY[shop.currency] ?? shop.currency} · 你有 ${shop.currency === 'coupon' ? p.coupon : p.gold}`,
          '',
          ...lines,
          '',
          `> \`${pfx()}购买 <物品> [数量]\` · \`${pfx()}出售 <物品> [数量]\``,
        ].join('\n'),
      });
    },
  };

  H['购买'] = {
    desc: '从商城买东西',
    usage: '购买 <物品名> [数量]',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      if (!args.length) return msg.reply(`用法：\`${pfx()}购买 金疮药 3\`\n> 发 \`${pfx()}商城\` 看有什么`);
      // 最后一个是数字就当数量
      const last = Number(args[args.length - 1]);
      const qty = args.length > 1 && Number.isFinite(last) ? last : 1;
      const name = (args.length > 1 && Number.isFinite(last) ? args.slice(0, -1) : args).join(' ').trim();
      const r = economy.buy(msg.userId, { itemName: name, qty });
      if (r.error === 'no_shop') return msg.reply(`商城没开。`);
      if (r.error === 'no_item') {
        return msg.reply(
          r.shop
            ? `**${r.shop}** 里没有「${name}」。\n> 发 \`${pfx()}商城 ${r.shop}\` 看货架`
            : `没有「${name}」这件货。\n> 发 \`${pfx()}商城\` 看各店卖什么`,
        );
      }
      if (r.error === 'no_stock') return msg.reply(`**${r.name}** 只剩 ${r.left} 个。`);
      if (r.error === 'trade') return msg.reply(r.message);
      await msg.replyMarkdown({
        content: [
          `## 购买成功`,
          `> ${mdEscape(r.item)} × ${r.qty}`,
          '',
          `**花费** ${r.total} ${CURRENCY[r.currency]} · **余额** ${r.currency === 'coupon' ? players.get(msg.userId).coupon : players.get(msg.userId).gold}`,
          '',
          `> \`${pfx()}背包\` 看看`,
        ].join('\n'),
      });
    },
  };

  H['出售'] = {
    desc: '把物品卖回商店',
    usage: '出售 <物品名> [数量]',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      if (!args.length) return msg.reply(`用法：\`${pfx()}出售 金疮药 1\``);
      const last = Number(args[args.length - 1]);
      const qty = args.length > 1 && Number.isFinite(last) ? last : 1;
      const name = (args.length > 1 && Number.isFinite(last) ? args.slice(0, -1) : args).join(' ').trim();
      const r = economy.sell(msg.userId, { itemName: name, qty });
      if (r.error === 'no_item') return msg.reply(`没有叫「${name}」的物品。`);
      if (r.error === 'not_tradeable') return msg.reply(`**${r.name}** 不能卖。`);
      if (r.error === 'trade') return msg.reply(r.message);
      await msg.replyMarkdown({
        content: [`## 出售成功`, `> ${mdEscape(r.item)} × ${r.qty}`, '', `**获得** ${r.gold} 魂币`].join('\n'),
      });
    },
  };

  H['银行'] = {
    desc: '银行存款与贷款',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const b = economy.bank(msg.userId);
      await msg.replyMarkdown({
        content: [
          '## 银行',
          `**存款** ${b.deposit} · **贷款** ${b.loan}`,
          `**身上** ${p.gold} 魂币`,
          '',
          `> \`${pfx()}存 100\` · \`${pfx()}取 100\` · \`${pfx()}贷 100\` · \`${pfx()}还 100\``,
        ].join('\n'),
      });
    },
  };

  /** 存/取/贷/还 共用一套参数处理 */
  function bankOp(kind, verb) {
    const map = {
      deposit: { desc: '存钱进银行', fn: 'deposit' },
      withdraw: { desc: '从银行取钱', fn: 'withdraw' },
      loan: { desc: '向银行借款', fn: 'loan' },
      repay: { desc: '还银行贷款', fn: 'repay' },
    };
    const m = map[kind];
    return {
      desc: m.desc,
      usage: `${verb} <数量>`,
      async run(msg, args) {
        const p = players.get(msg.userId);
        if (!p) return msg.reply('你还没有角色。');
        const n = Math.trunc(Number(args[0]) || 0);
        if (n <= 0) return msg.reply(`用法：\`${pfx()}${verb} 100\`（数量要大于 0）`);
        const r = economy[m.fn](msg.userId, n);
        if (r.error === 'trade') return msg.reply(r.message);
        if (r.error === 'no_deposit') return msg.reply(`存款只有 ${r.have}。`);
        if (r.error === 'no_loan') return msg.reply('你现在没有贷款。');
        if (r.error === 'over_cap') return msg.reply(`贷款上限 ${r.cap}，你已借 ${r.have}。`);
        if (r.error === 'bad_amount') return msg.reply('数量要大于 0。');
        const cur = economy.bank(msg.userId);
        const label = { deposit: '存款', withdraw: '取款', loan: '借款', repay: '还款' }[kind];
        await msg.replyMarkdown({
          content: [
            `## ${label}`,
            `> ${n} 魂币`,
            '',
            `**存款** ${cur.deposit} · **贷款** ${cur.loan}`,
            `**身上** ${players.get(msg.userId).gold} 魂币`,
          ].join('\n'),
        });
      },
    };
  }

  H['存'] = bankOp('deposit', '存');
  H['取'] = bankOp('withdraw', '取');
  H['贷'] = bankOp('loan', '贷');
  H['还'] = bankOp('repay', '还');

  H['拍卖'] = {
    desc: '看拍卖行在售',
    async run(msg) {
      const rows = economy.auctions(10);
      if (!rows.length) {
        return msg.reply(`拍卖行现在空着。\n> \`${pfx()}上架 <物品> <数量> <价格>\` 挂一件上去`);
      }
      const lines = rows.map(
        (a) => `- \`#${a.id}\` **${mdEscape(a.itemName)}** × ${a.qty} · ${a.price} 魂币 · 卖家 ${mdEscape(a.sellerName)}`,
      );
      await msg.replyMarkdown({
        content: ['## 拍卖行', ...lines, '', `> \`${pfx()}竞拍 <编号>\` 买下`].join('\n'),
      });
    },
  };

  H['上架'] = {
    desc: '把物品挂到拍卖行',
    usage: '上架 <物品> <数量> <价格>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      if (args.length < 3) return msg.reply(`用法：\`${pfx()}上架 金疮药 2 100\``);
      const price = Number(args[args.length - 1]);
      const qty = Number(args[args.length - 2]);
      if (!Number.isFinite(price) || !Number.isFinite(qty)) {
        return msg.reply(`用法：\`${pfx()}上架 金疮药 2 100\`（最后两个是数量和单价）`);
      }
      const name = args.slice(0, -2).join(' ').trim();
      const r = economy.auctionList(msg.userId, { itemName: name, qty, price });
      if (r.error === 'no_item') return msg.reply(`没有叫「${name}」的物品。`);
      if (r.error === 'not_tradeable') return msg.reply(`**${r.name}** 不能交易。`);
      if (r.error === 'bad_price') return msg.reply('价格要大于 0。');
      if (r.error === 'trade') return msg.reply(r.message);
      await msg.replyMarkdown({
        content: [
          '## 已上架',
          `> \`#${r.id}\` **${mdEscape(r.item)}** × ${r.qty} · ${r.price} 魂币`,
          '',
          `**${r.hours}** 小时内没人买会自动退回`,
        ].join('\n'),
      });
    },
  };

  H['竞拍'] = {
    desc: '买下拍卖行的东西',
    usage: '竞拍 <编号>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const id = Number(args[0]);
      if (!id) return msg.reply(`用法：\`${pfx()}竞拍 3\`\n> 编号在 \`${pfx()}拍卖\` 里看`);
      const r = economy.auctionBid(msg.userId, id);
      if (r.error === 'no_auction') return msg.reply(`没有 #${id} 这个拍卖。`);
      if (r.error === 'not_open') return msg.reply(`#${id} 已经结束了（${r.status}）。`);
      if (r.error === 'own') return msg.reply('这是你自己挂的，不能拍。');
      if (r.error === 'trade') return msg.reply(r.message);
      await msg.replyMarkdown({
        content: [
          '## 竞拍成功',
          `> ${mdEscape(r.item)} × ${r.qty}`,
          '',
          `**花费** ${r.price} 魂币（卖家到手 ${r.price - r.fee}，手续费 ${r.fee}）`,
        ].join('\n'),
      });
    },
  };

  H['我的拍卖'] = {
    desc: '看自己挂的单',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const rows = economy.myAuctions(msg.userId);
      if (!rows.length) return msg.reply('你还没挂过东西。');
      const tag = { open: '在售', sold: '已卖出', cancelled: '已下架', expired: '已过期退回' };
      const lines = rows.map(
        (a) => `- \`#${a.id}\` **${mdEscape(a.itemName)}** × ${a.qty} · ${a.price} 魂币 · ${tag[a.status] ?? a.status}`,
      );
      await msg.replyMarkdown({
        content: ['## 我的拍卖', ...lines, '', `> \`${pfx()}下架 <编号>\` 撤掉在售的`].join('\n'),
      });
    },
  };

  H['下架'] = {
    desc: '撤掉自己的拍卖',
    usage: '下架 <编号>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const id = Number(args[0]);
      if (!id) return msg.reply(`用法：\`${pfx()}下架 3\``);
      const r = economy.auctionCancel(msg.userId, id);
      if (r.error === 'no_auction') return msg.reply(`没有 #${id}。`);
      if (r.error === 'not_owner') return msg.reply('这不是你挂的。');
      if (r.error === 'not_open') return msg.reply(`#${id} 已经结束了。`);
      await msg.replyMarkdown({ content: [`## 已下架 #${id}`, '> 物品已退回背包'].join('\n') });
    },
  };

  H['抽奖'] = {
    desc: '花魂币抽奖',
    usage: '抽奖 [次数]',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const times = Math.max(1, Math.min(10, Number(args[0]) || 1));
      const cfgNow = cfg();
      const cost = Number(cfgNow.lottery_cost ?? 100) * times;
      if (Number(p.gold) < cost) return msg.reply(`抽 ${times} 次要 ${cost} 魂币，你有 ${p.gold}。`);
      const r = economy.draw(msg.userId, times);
      if (r.error === 'no_prize') return msg.reply('奖池是空的，去面板加奖品。');
      if (r.error === 'trade') return msg.reply(r.message);
      const RARITY_TAG = ['', '普通', '**稀有**', '**史诗**', '**传说**'];
      const lines = r.results.map((x) => `- ${RARITY_TAG[Number(x.rarity)] ?? ''} ${mdEscape(x.name)} × ${x.qty}`);
      await msg.replyMarkdown({
        content: [
          `## 抽奖 ×${times}`,
          `> 花费 ${r.cost} 魂币`,
          '',
          ...lines,
          '',
          `> 余额 ${players.get(msg.userId).gold} · \`${pfx()}背包\` 查看`,
        ].join('\n'),
      });
    },
  };

  H['月卡'] = {
    desc: '月卡购买与每日领取',
    usage: '月卡 [购买|领取]',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const act = args[0];

      if (act === '购买') {
        const r = economy.buyMonthly(msg.userId);
        if (r.error === 'trade') return msg.reply(r.message);
        return msg.replyMarkdown({
          content: ['## 月卡已开通', `> 有效期至 ${new Date(r.expireAt).toLocaleDateString('zh-CN')}`, '', `> \`${pfx()}月卡 领取\` 每天领 ${economy.monthly(msg.userId).dailyGold} 魂币`].join('\n'),
        });
      }

      if (act === '领取') {
        const r = economy.claimMonthly(msg.userId);
        if (r.error === 'not_active') return msg.reply(`你还没买月卡。\n> \`${pfx()}月卡 购买\`（${economy.monthly(msg.userId).price} 点券）`);
        if (r.error === 'claimed') return msg.reply('今天已经领过了，明天再来。');
        return msg.replyMarkdown({ content: ['## 月卡领取', `> **魂币** +${r.gold}`].join('\n') });
      }

      const m = economy.monthly(msg.userId);
      await msg.replyMarkdown({
        content: [
          '## 月卡',
          m.active
            ? `> 生效中 · 到期 ${new Date(m.expireAt).toLocaleDateString('zh-CN')}`
            : '> 未开通',
          '',
          `**每日** ${m.dailyGold} 魂币 · **价格** ${m.price} 点券 / ${m.days} 天`,
          '',
          m.active
            ? `> \`${pfx()}月卡 领取\`${m.canClaim ? '' : '（今天已领）'}`
            : `> \`${pfx()}月卡 购买\``,
        ].join('\n'),
      });
    },
  };

  H['兑换'] = {
    desc: '兑换 CDK',
    usage: '兑换 <兑换码>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const code = args[0];
      if (!code) return msg.reply(`用法：\`${pfx()}兑换 ABCD-1234\``);
      const r = economy.redeem(msg.userId, code);
      if (r.error === 'no_code') return msg.reply('兑换码不存在。');
      if (r.error === 'expired') return msg.reply('兑换码已过期。');
      if (r.error === 'used_up') return msg.reply('这个兑换码已经被用完了。');
      if (r.error === 'trade') return msg.reply(r.message);
      const got = [];
      if (r.reward.gold) got.push(`魂币 +${r.reward.gold}`);
      if (r.reward.coupon) got.push(`点券 +${r.reward.coupon}`);
      for (const it of r.reward.items ?? []) {
        const nm = content.db.prepare('SELECT name FROM item WHERE id = ?').get(Number(it.id));
        got.push(`${nm?.name ?? '物品'} × ${it.qty ?? 1}`);
      }
      for (const e of r.reward.equips ?? []) {
        const nm = content.db.prepare('SELECT name FROM equip WHERE id = ?').get(Number(e));
        got.push(`${nm?.name ?? '装备'} × 1`);
      }
      for (const c of r.reward.companions ?? []) {
        const nm = content.db.prepare('SELECT name FROM companion WHERE id = ?').get(Number(c));
        got.push(`${nm?.name ?? '伙伴'} × 1`);
      }
      await msg.replyMarkdown({
        content: ['## 兑换成功', ...(got.length ? got.map((g) => `- ${g}`) : ['- （这个码没配奖励）'])].join('\n'),
      });
    },
  };

  /* ================= 社交（关系 / 喊话） ================= */

  H['关系'] = {
    desc: '我的关系总览',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const r = social.relations(msg.userId);
      const lines = [];
      if (r.couple.length) lines.push(`**情侣** ${r.couple.map(mdEscape).join('、')}`);
      if (r.master.length) lines.push(`**师父** ${r.master.map(mdEscape).join('、')}`);
      if (r.apprentice.length) lines.push(`**徒弟** ${r.apprentice.map(mdEscape).join('、')}`);
      if (r.friend.length) lines.push(`**好友** ${r.friend.map(mdEscape).join('、')}`);
      if (r.enemy.length) lines.push(`**仇人** ${r.enemy.map(mdEscape).join('、')}`);
      if (r.incoming.length) {
        lines.push('', '**待你确认**');
        for (const i of r.incoming) lines.push(`- ${i.label} · ${mdEscape(i.name)} → 发 \`${pfx()}答应 ${i.name}\``);
      }
      if (!lines.length) lines.push('还没有任何关系。', '', `> \`${pfx()}求婚 <昵称>\` · \`${pfx()}拜师 <昵称>\``);
      await msg.replyMarkdown({ content: ['## 关系', ...lines].join('\n') });
    },
  };

  /** 发起关系（情侣/师徒/好友） */
  function relRequest(kind, verb, hint) {
    return {
      desc: hint,
      usage: `${verb} <昵称>`,
      async run(msg, args) {
        const p = players.get(msg.userId);
        if (!p) return msg.reply('你还没有角色。');
        const name = args.join(' ').trim();
        if (!name) return msg.reply(`用法：\`${pfx()}${verb} 昵称\``);
        const r = social.request(msg.userId, name, kind);
        if (r.error === 'not_found') return msg.reply(`没有叫「${name}」的玩家。\n> 昵称要和游戏内一致`);
        if (r.error === 'ambiguous') return msg.reply(`有 ${r.count} 个玩家叫「${name}」，没法确定是谁。`);
        if (r.error === 'self') return msg.reply('不能对自己发。');
        if (r.error === 'already') return msg.reply(`你们已经是${REL_KIND[kind].label}了。`);
        if (r.error === 'pending') return msg.reply(`已经发过请求了，等对方 \`${pfx()}答应 ${mdEscape(name)}\`。`);
        await msg.replyMarkdown({
          content: [
            `## 已发出请求`,
            `> ${REL_KIND[kind].label} · ${mdEscape(r.target.name)}`,
            '',
            `> 对方发 \`${pfx()}答应 ${mdEscape(r.target.name)}\` 就成立`,
          ].join('\n'),
        });
      },
    };
  }

  H['求婚'] = relRequest('couple', '求婚', '向玩家求婚');
  H['拜师'] = relRequest('master', '拜师', '拜某人为师');
  H['加好友'] = relRequest('friend', '加好友', '加个好友');

  H['答应'] = {
    desc: '答应别人的请求',
    usage: '答应 <昵称>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      if (!name) return msg.reply(`用法：\`${pfx()}答应 昵称\``);
      // 情侣优先，其次师徒、好友
      for (const kind of ['couple', 'master', 'friend']) {
        const r = social.accept(msg.userId, name, kind);
        if (r.ok) {
          return msg.replyMarkdown({
            content: [`## ${REL_KIND[kind].label}成立`, `> 与 **${mdEscape(r.from.name)}**`, '', `> \`${pfx()}关系\` 查看`].join('\n'),
          });
        }
      }
      await msg.reply(`没有来自「${name}」的待确认请求。`);
    },
  };

  /** 解除关系 */
  function relEnd(kind, verb, hint) {
    return {
      desc: hint,
      usage: `${verb} <昵称>`,
      async run(msg, args) {
        const p = players.get(msg.userId);
        if (!p) return msg.reply('你还没有角色。');
        const name = args.join(' ').trim();
        if (!name) return msg.reply(`用法：\`${pfx()}${verb} 昵称\``);
        const r = social.end(msg.userId, name, kind);
        if (r.error === 'not_found') return msg.reply(`没有叫「${name}」的玩家。`);
        if (r.error === 'none') return msg.reply(`你和「${name}」没有这层关系。`);
        await msg.replyMarkdown({
          content: [`## ${REL_KIND[kind].label}已解除`, `> ${mdEscape(r.target.name)}`].join('\n'),
        });
      },
    };
  }

  H['分手'] = relEnd('couple', '分手', '解除情侣关系');
  H['出师'] = relEnd('master', '出师', '解除师徒关系');

  H['喊话'] = {
    desc: '世界喊话（有冷却）',
    usage: '喊话 <内容>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const text = args.join(' ').trim();
      if (!text) return msg.reply(`用法：\`${pfx()}喊话 收魂环碎片，价格好商量\``);
      if (text.length > 60) return msg.reply('喊话最多 60 个字。');
      const wait = social.shoutCooldown(msg.userId);
      if (wait) return msg.reply(`喊话冷却中，还要等 **${wait}** 秒。`);
      social.markShout(msg.userId);
      await msg.replyMarkdown({
        content: [`## 世界 · ${mdEscape(p.name)}`, `> ${mdEscape(text)}`].join('\n'),
      });
    },
  };

  /* ================= PVP ================= */

  H['斗魂'] = {
    desc: '和玩家打一场（异步）',
    usage: '斗魂 <昵称>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      if (!name) return msg.reply(`用法：\`${pfx()}斗魂 昵称\`\n> \`${pfx()}附近\` 看同地图有谁`);
      const r = social.duel(msg.userId, name);
      if (r.error === 'not_found') return msg.reply(`没有叫「${name}」的玩家。`);
      if (r.error === 'ambiguous') return msg.reply(`有 ${r.count} 个玩家叫「${name}」。`);
      if (r.error === 'self') return msg.reply('不能打自己。');
      if (r.error === 'dead') return msg.reply(`你已经阵亡，先 \`${pfx()}复活\`。`);
      if (r.error === 'daily_limit') return msg.reply(`今天已经打过 ${r.limit} 场了，明天再来。\n> 每天上限是为了防止互相刷分`);

      progress.addPoints(msg.userId, r.win ? 30 : 10);
      const last = r.events.slice(-3).map((e) => `${e.by === 'a' ? '你' : mdEscape(r.foe.name)} 打出 ${e.value}${e.crit ? '（暴击）' : ''}`);
      await msg.replyMarkdown({
        content: [
          `## ${r.win ? '胜利' : '败北'} · ${mdEscape(r.foe.name)}`,
          `> ${r.rounds} 回合 · 排位分 ${r.scoreDelta > 0 ? '+' : ''}${r.scoreDelta}`,
          '',
          `**你** ${Math.max(0, r.aHp)}/${r.aMax}　${bar(Math.max(0, r.aHp), r.aMax)}`,
          `**对方** ${Math.max(0, r.bHp)}/${r.bMax}　${bar(Math.max(0, r.bHp), r.bMax)}`,
          '',
          ...last.map((l) => `- ${l}`),
          '',
          `> \`${pfx()}排位\` 看榜`,
        ].join('\n'),
      });
    },
  };

  H['排位'] = {
    desc: '排位榜与我的积分',
    async run(msg) {
      const p = players.get(msg.userId);
      const rows = social.rankTop(10);
      if (!rows.length) return msg.reply('还没有人上榜。');
      const mine = p ? `\n\n> 你的排位分 **${p.rank_score ?? 0}**` : '';
      const lines = rows.map((r, i) => `- \`${i + 1}\` **${mdEscape(r.name)}** · ${r.rank_score} 分 · Lv.${r.level}`);
      await msg.replyMarkdown({
        content: ['## 排位榜', ...lines, mine].filter(Boolean).join('\n'),
      });
    },
  };

  H['附近'] = {
    desc: '同地图的玩家',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const rows = social.nearPlayers(msg.userId, 10);
      const map = content.db.prepare('SELECT name FROM map WHERE id = ?').get(p.map_id);
      if (!rows.length) return msg.reply(`${mdEscape(map?.name ?? '这里')} 只有你一个人。`);
      const lines = rows.map((r) => `- **${mdEscape(r.name)}** · Lv.${r.level} · 排位 ${r.rank_score ?? 0}`);
      await msg.replyMarkdown({
        content: [`## ${mdEscape(map?.name ?? '')} 的玩家`, ...lines, '', `> \`${pfx()}斗魂 <昵称>\` 打一场`].join('\n'),
      });
    },
  };

  /* ================= 组织 ================= */

  H['宗门'] = {
    desc: '我的宗门',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const g = guild.of(msg.userId);
      if (!g) {
        return msg.replyMarkdown({
          content: [
            '## 宗门',
            '> 你还没有加入任何宗门',
            '',
            `\`${pfx()}创建宗门 <名字>\`（1000 魂币）· \`${pfx()}加入宗门 <名字>\``,
            `\`${pfx()}领地\` 看各地图归属`,
          ].join('\n'),
        });
      }
      const n = guild.members(g.id).length;
      await msg.replyMarkdown({
        content: [
          `## ${mdEscape(g.name)}`,
          `> 宗主 ${mdEscape(players.get(g.leader)?.name ?? '???')} · Lv.${g.level} · ${n} 人`,
          '',
          `**资金** ${g.funds} 魂币 · **我的身份** ${g.myRank === 'leader' ? '宗主' : g.myRank === 'elder' ? '长老' : '成员'}`,
          g.notice ? `\n> ${mdEscape(g.notice)}` : '',
          '',
          `\`${pfx()}宗门成员\` · \`${pfx()}捐献 <数量>\` · \`${pfx()}领地\` · \`${pfx()}挖矿\``,
        ].filter(Boolean).join('\n'),
      });
    },
  };

  H['创建宗门'] = {
    desc: '创建宗门',
    usage: '创建宗门 <名字>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      if (!name) return msg.reply(`用法：\`${pfx()}创建宗门 史莱克\``);
      const r = guild.create(msg.userId, name);
      if (r.error === 'in_guild') return msg.reply('你已经在宗门里了。');
      if (r.error === 'name_taken') return msg.reply(`「${name}」已经被占用了。`);
      if (r.error === 'bad_name') return msg.reply('宗门名字 2–10 个字。');
      if (r.error === 'no_gold') return msg.reply(`创建要 ${r.need} 魂币，你有 ${r.have}。`);
      await msg.replyMarkdown({
        content: [`## 宗门创建成功`, `> **${mdEscape(r.guild.name)}** · 花费 ${r.cost} 魂币`, '', `\`${pfx()}宗门\` 查看`].join('\n'),
      });
    },
  };

  H['加入宗门'] = {
    desc: '加入别人的宗门',
    usage: '加入宗门 <名字>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      if (!name) return msg.reply(`用法：\`${pfx()}加入宗门 史莱克\``);
      const r = guild.join(msg.userId, name);
      if (r.error === 'in_guild') return msg.reply('你已经在宗门里了。');
      if (r.error === 'no_guild') return msg.reply(`没有叫「${name}」的宗门。`);
      if (r.error === 'full') return msg.reply(`**${name}** 已经满员（${r.max} 人）。`);
      await msg.replyMarkdown({ content: [`## 已加入`, `> **${mdEscape(r.guild.name)}**`].join('\n') });
    },
  };

  H['退出宗门'] = {
    desc: '退出或解散宗门',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const r = guild.leave(msg.userId);
      if (r.error === 'not_in_guild') return msg.reply('你不在任何宗门里。');
      if (r.error === 'leader_must_transfer') return msg.reply('你是宗主，宗门里还有别人，不能直接退。');
      await msg.replyMarkdown({
        content: [r.disbanded ? `## 已解散 **${mdEscape(r.name)}**` : `## 已退出 **${mdEscape(r.name)}**`].join('\n'),
      });
    },
  };

  H['宗门成员'] = {
    desc: '看宗门成员',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const g = guild.of(msg.userId);
      if (!g) return msg.reply(`你还没有宗门。\n> \`${pfx()}创建宗门 <名字>\``);
      const list = guild.members(g.id);
      const RANK = { leader: '宗主', elder: '长老', member: '成员' };
      const lines = list.map((m) => `- ${RANK[m.rank] ?? m.rank} · **${mdEscape(m.name)}** · Lv.${m.level}`);
      await msg.replyMarkdown({
        content: [`## ${mdEscape(g.name)} 成员（${list.length}）`, ...lines].join('\n'),
      });
    },
  };

  H['捐献'] = {
    desc: '捐魂币给宗门',
    usage: '捐献 <数量>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const n = Math.trunc(Number(args[0]) || 0);
      if (n <= 0) return msg.reply(`用法：\`${pfx()}捐献 500\``);
      const r = guild.contribute(msg.userId, n);
      if (r.error === 'not_in_guild') return msg.reply('你还没有宗门。');
      if (r.error === 'no_gold') return msg.reply(`你只有 ${r.have} 魂币。`);
      await msg.replyMarkdown({ content: [`## 捐献成功`, `> ${n} 魂币 · 宗门资金 **${r.funds}**`].join('\n') });
    },
  };

  H['领地'] = {
    desc: '各地图的领地归属与守卫',
    async run(msg) {
      const rows = guild.territories();
      if (!rows.length) return msg.reply('还没有可占领的领地。');
      const lines = rows.map((t) => {
        const mine = t.guild_id && guild.of(msg.userId)?.id === t.guild_id;
        return `- **${mdEscape(t.mapName)}** · ${mine ? '**我们的**' : mdEscape(t.guildName)} · 守卫 ${t.defense}`;
      });
      await msg.replyMarkdown({
        content: [
          '## 领地',
          ...lines,
          '',
          `> 无主的：\`${pfx()}占领 <地图>\`（500 资金）`,
          `> 别人的：先 \`${pfx()}宣战 <宗门>\`，再 \`${pfx()}抢夺 <地图>\``,
          `> 收益：\`${pfx()}收工\`（每天有次数上限）`,
        ].join('\n'),
      });
    },
  };

  H['占领'] = {
    desc: '占领无主领地（宗主）',
    usage: '占领 <地图名>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      if (!name) return msg.reply(`用法：\`${pfx()}占领 星斗森林\``);
      const r = guild.occupy(msg.userId, name);
      if (r.error === 'not_in_guild') return msg.reply('你还没有宗门。');
      if (r.error === 'not_leader') return msg.reply('只有宗主能占领领地。');
      if (r.error === 'no_map') return msg.reply(`没有叫「${name}」的地图。`);
      if (r.error === 'no_territory') return msg.reply(`**${name}** 不是可占领的领地。`);
      if (r.error === 'already_ours') return msg.reply(`**${name}** 已经是你们的了。`);
      if (r.error === 'occupied') {
        return msg.reply(
          `**${name}** 是 **${r.holder}** 的地盘，不能直接占。\n> 先 \`${pfx()}宣战 ${r.holder}\`，再 \`${pfx()}抢夺 ${name}\``,
        );
      }
      if (r.error === 'no_funds') return msg.reply(`宗门资金不够（需要 ${r.need}，现有 ${r.have}）。`);
      await msg.replyMarkdown({
        content: [
          `## 占领成功`,
          `> **${mdEscape(r.map)}** · 花费 ${r.cost} 宗门资金`,
          `> 守卫强度 **${r.defense}**（宗门等级越高越难被抢）`,
          '',
          `\`${pfx()}收工\` 收产出`,
        ].join('\n'),
      });
    },
  };

  H['宣战'] = {
    desc: '对别的宗门宣战（24 小时有效）',
    usage: '宣战 <宗门名>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      if (!name) {
        const wars = guild.myWars(msg.userId);
        return msg.reply(
          [
            `用法：\`${pfx()}宣战 <宗门名>\``,
            wars.length
              ? `正在打：${wars.map((w) => `${w.targetName}（还剩 ${Math.max(0, Math.round((w.expires_at - Date.now()) / 3600_000))} 小时）`).join(' / ')}`
              : '你现在没有宣战任何宗门',
          ].join('\n'),
        );
      }
      const r = guild.declareWar(msg.userId, name);
      if (r.error === 'not_in_guild') return msg.reply('你还没有宗门。');
      if (r.error === 'not_leader') return msg.reply('只有宗主能宣战。');
      if (r.error === 'no_guild') return msg.reply(`没有叫「${name}」的宗门。`);
      if (r.error === 'self') return msg.reply('不能对自己宣战。');
      if (r.error === 'already') return msg.reply(`已经在打 **${r.name}** 了，不用重复宣战。`);
      if (r.error === 'no_funds') return msg.reply(`宣战要 **${r.need}** 宗门资金，现有 ${r.have}。`);
      await msg.replyMarkdown({
        content: [
          `## 已对 ${mdEscape(r.target.name)} 宣战`,
          `> 花费 ${r.cost} 宗门资金 · 有效期 ${r.hours} 小时`,
          '',
          `> 现在可以 \`${pfx()}抢夺 <地图>\` 抢他们的领地`,
        ].join('\n'),
      });
    },
  };

  H['抢夺'] = {
    desc: '抢夺别的宗门的领地（需先宣战）',
    usage: '抢夺 <地图名>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      if (!name) return msg.reply(`用法：\`${pfx()}抢夺 星斗森林\`\n> 先 \`${pfx()}领地\` 看谁占着`);
      const r = guild.raid(msg.userId, name);
      if (r.error === 'not_in_guild') return msg.reply('你还没有宗门。');
      if (r.error === 'not_leader') return msg.reply('只有宗主能发动抢夺。');
      if (r.error === 'no_map') return msg.reply(`没有叫「${name}」的地图。`);
      if (r.error === 'no_territory') return msg.reply(`**${name}** 不是可占领的领地。`);
      if (r.error === 'already_ours') return msg.reply(`**${name}** 已经是你们的了。`);
      if (r.error === 'no_war') {
        return msg.reply(
          `**${name}** 是 **${r.holder}** 的地盘。\n> 先 \`${pfx()}宣战 ${r.holder}\` 才能抢`,
        );
      }
      if (r.error === 'dead') return msg.reply(`你先 \`${pfx()}复活\`。`);

      const lines = [
        `## ${r.win ? '抢下来了' : '抢夺失败'} · ${mdEscape(r.map)}`,
        `> 守卫强度 ${r.defense} · 打了 ${r.rounds} 回合`,
        '',
      ];
      if (r.win) {
        lines.push(`**领地已归你们** · 新守卫强度 ${r.newDefense}`);
        lines.push('', `> \`${pfx()}收工\` 开始收产出`);
      } else {
        lines.push('> 你被打退了。对方守住了地盘，守卫更强了（+10）。');
        lines.push('', `> \`${pfx()}复活\` 之后再试试`);
      }
      await msg.replyMarkdown({ content: lines.join('\n') });
    },
  };

  H['收工'] = {
    desc: '收取领地产出（每天有次数上限）',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const r = guild.collect(msg.userId);
      if (r.error === 'not_in_guild') return msg.reply('你还没有宗门。');
      if (r.error === 'no_territory') return msg.reply(`你们还没有领地。\n> \`${pfx()}领地\` 看能占哪些`);
      if (r.error === 'daily_limit') return msg.reply(`今天已经收过 ${r.limit} 次了，明天再来。`);
      if (!r.gold && !r.items.length) return msg.reply('还没到产出时间（按小时结算）。');
      const lines = [];
      if (r.gold) lines.push(`- 魂币 **+${r.gold}**`);
      for (const it of r.items) {
        const nm = content.db.prepare('SELECT name FROM item WHERE id = ?').get(it.id);
        lines.push(`- ${mdEscape(nm?.name ?? '物品')} × ${it.qty}`);
      }
      await msg.replyMarkdown({
        content: [
          '## 收工',
          `> ${mdEscape(r.guild.name)} Lv.${r.guild.level} · 收益加成 +${Math.round((r.bonus - 1) * 100)}%`,
          `> 今天第 ${r.used}/${r.limit} 次`,
          '',
          ...lines,
        ].join('\n'),
      });
    },
  };

  /** 老名字保留，行为等同收工 */
  H['挖矿'] = {
    desc: '收取领地产出（等同收工）',
    async run(msg) {
      return H['收工'].run(msg, []);
    },
  };

  /* ================= 生活（职业 / 配方） ================= */

  H['职业'] = {
    desc: '查看职业与能做的配方',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const m = craft.myCraft(msg.userId);
      const lines = m.profession
        ? [`> 当前职业 **${mdEscape(m.profession)}** · Lv.${m.level}`]
        : ['> 还没有职业', '', `\`${pfx()}转职 炼药师\` 选一个`];
      if (m.can.length) {
        lines.push('', '**现在能做的**');
        for (const r of m.can) lines.push(`- \`${pfx()}制作 ${mdEscape(r.name)}\` — ${mdEscape(r.desc)}`);
      }
      await msg.replyMarkdown({ content: ['## 职业', ...lines].join('\n') });
    },
  };

  H['转职'] = {
    desc: '选择职业',
    usage: '转职 <职业名>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      if (!name) {
        const list = craft.professions();
        return msg.reply([`用法：\`${pfx()}转职 炼药师\``, `可选：${list.map((x) => x.name).join(' / ')}`].join('\n'));
      }
      const r = craft.learn(msg.userId, name);
      if (r.error === 'no_profession') return msg.reply(`没有「${name}」这个职业。`);
      if (r.error === 'same') return msg.reply(`你已经是${r.name}了。`);
      await msg.replyMarkdown({
        content: [
          `## 转职成功`,
          `> **${mdEscape(r.profession.name)}** — ${mdEscape(r.profession.desc)}`,
          r.before ? `> （原来：${mdEscape(r.before)}）` : '',
          '',
          `\`${pfx()}职业\` 看能做什么`,
        ].filter(Boolean).join('\n'),
      });
    },
  };

  H['配方'] = {
    desc: '查看配方',
    usage: '配方 [炼丹|合成|设计]',
    async run(msg, args) {
      const kindMap = { 炼丹: 'alchemy', 合成: 'craft', 设计: 'design' };
      const kind = kindMap[args[0]] ?? '';
      const list = craft.recipes(kind);
      if (!list.length) return msg.reply('还没有配方。');
      const KIND_LABEL = { alchemy: '炼丹', craft: '合成', design: '设计图' };
      const lines = list.map((r) => {
        const cost = [];
        if (r.cost.gold) cost.push(`${r.cost.gold} 魂币`);
        for (const it of r.cost.items ?? []) {
          const nm = content.db.prepare('SELECT name FROM item WHERE id = ?').get(Number(it.id));
          cost.push(`${nm?.name ?? '物品'}×${it.qty}`);
        }
        const pro = r.profession ? `${r.profession} ` : '';
        return `- **${mdEscape(r.name)}**（${KIND_LABEL[r.kind] ?? r.kind}）· ${pro}Lv.${r.level_req}\n  ${cost.join(' + ') || '无消耗'}`;
      });
      await msg.replyMarkdown({
        content: ['## 配方', ...lines, '', `> \`${pfx()}制作 <配方名> [次数]\``].join('\n'),
      });
    },
  };

  H['制作'] = {
    desc: '按配方制作',
    usage: '制作 <配方名> [次数]',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      if (!args.length) return msg.reply(`用法：\`${pfx()}制作 金疮药 2\`\n> \`${pfx()}配方\` 看能做什么`);
      const last = Number(args[args.length - 1]);
      const times = args.length > 1 && Number.isFinite(last) ? last : 1;
      const name = (args.length > 1 && Number.isFinite(last) ? args.slice(0, -1) : args).join(' ').trim();
      const r = craft.craft(msg.userId, name, times);
      if (r.error === 'no_recipe') return msg.reply(`没有「${name}」这个配方。\n> \`${pfx()}配方\` 看全部`);
      if (r.error === 'wrong_profession') return msg.reply(`这个配方要 **${r.need}**，你现在是 ${r.have}。\n> \`${pfx()}转职 ${r.need}\``);
      if (r.error === 'level') return msg.reply(`需要 Lv.${r.need}，你现在 Lv.${r.have}。`);
      if (r.error === 'trade') return msg.reply(r.message);
      await msg.replyMarkdown({
        content: [
          `## 制作成功`,
          `> ${mdEscape(r.outName)} × ${r.qty}`,
          '',
          `**经验** +${r.exp}${r.leveled ? ` · **升级** Lv.${players.get(msg.userId).level}` : ''}`,
          '',
          `\`${pfx()}背包\` 查看`,
        ].join('\n'),
      });
    },
  };

  H['强化'] = {
    desc: '强化装备（必成，成本递增）',
    usage: '强化 <装备名>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      if (!name) {
        const d = players.detail(msg.userId);
        if (!d.equipment.owned.length) return msg.reply(`你还没有装备。\n> 打怪会掉魂骨，面板也能发`);
        return msg.reply(
          [`用法：\`${pfx()}强化 鹿之左臂骨\``, `你有：${d.equipment.owned.map((e) => `${e.name}+${e.level}`).join(' / ')}`].join('\n'),
        );
      }
      const r = players.upgradeEquip(msg.userId, name);
      if (r.error === 'not_owned') return msg.reply(`你没有「${name}」。\n> 发 \`${pfx()}我的装备\` 看看`);
      if (r.error === 'maxed') return msg.reply(`**${r.name}** 已经 +${r.max}，满级了。`);
      if (r.error === 'no_gold') return msg.reply(`强化要 **${r.need}** 魂币，你只有 ${r.have}。`);

      const c = cfg();
      const max = Number(c.equip_upgrade_max ?? 10);
      const next = r.level < max ? Math.round(Number(c.equip_upgrade_base ?? 200) * Math.pow(r.level, 1.6)) : null;
      await msg.replyMarkdown({
        content: [
          `## ${mdEscape(r.name)} **+${r.level}**`,
          `> 消耗 ${r.cost} 魂币`,
          '',
          `**攻击** ${r.player.atk} · **防御** ${r.player.def} · **生命** ${r.player.hp_max}`,
          '',
          next ? `> 下一级 ${next} 魂币 · \`${pfx()}强化 ${mdEscape(r.name)}\`` : `> 已满级 +${max}`,
        ].join('\n'),
      });
    },
  };

  H['宗门升级'] = {
    desc: '升级宗门（宗主，全员加属性）',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const r = guild.upgrade(msg.userId);
      if (r.error === 'not_in_guild') return msg.reply('你还没有宗门。');
      if (r.error === 'not_leader') return msg.reply('只有宗主能升级宗门。');
      if (r.error === 'maxed') return msg.reply(`宗门已经满级（Lv.${r.max}）。`);
      if (r.error === 'no_funds') {
        return msg.reply(`宗门资金不够（需要 **${r.need}**，现有 ${r.have}）。\n> \`${pfx()}捐献 <数量>\` 筹钱`);
      }
      await msg.replyMarkdown({
        content: [
          `## ${mdEscape(r.name)} → Lv.${r.level}`,
          `> 消耗 ${r.cost} 宗门资金 · ${r.members} 名成员受益`,
          '',
          `**全员全属性 +${Math.round(r.pct * 100)}%**`,
          '',
          `> \`${pfx()}宗门\` 查看`,
        ].join('\n'),
      });
    },
  };

  H['分解'] = {
    desc: '分解多余装备，换回碎片',
    usage: '分解 <装备名>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      if (!name) {
        const d = players.detail(msg.userId);
        if (!d.equipment.owned.length) return msg.reply('你还没有装备。');
        return msg.reply(
          [`用法：\`${pfx()}分解 鹿之左臂骨\``, `你有：${d.equipment.owned.map((e) => `${e.name}+${e.level}`).join(' / ')}`].join('\n'),
        );
      }
      const r = players.salvageEquip(msg.userId, name);
      if (r.error === 'not_owned') return msg.reply(`你没有「${name}」。\n> 发 \`${pfx()}我的装备\` 看看`);
      await msg.replyMarkdown({
        content: [
          `## 已分解 ${mdEscape(r.name)}`,
          `> 得到 **${mdEscape(r.itemName)}** × ${r.qty}`,
          '',
          `**攻击** ${r.player.atk} · **防御** ${r.player.def}`,
        ].join('\n'),
      });
    },
  };

  /**
   * 条件对话的条件判定。
   *
   * 条件全在 `npc_dialog.cond` 的 JSON 里，语义是**全部 AND**：
   *   level / levelMax / ring / gold / kill / item{name,qty} / time(day|night)
   * 加新条件维度只要在这里加一个 if，不用改表结构。
   */
  function dialogCondOk(cond, p, d) {
    const c = cond && typeof cond === 'object' ? cond : {};
    if (c.level && Number(p.level) < Number(c.level)) return false;
    if (c.levelMax && Number(p.level) > Number(c.levelMax)) return false;
    if (c.ring && d.rings.length < Number(c.ring)) return false;
    if (c.gold && Number(p.gold) < Number(c.gold)) return false;
    if (c.kill) {
      const total = Number(
        players.db.prepare('SELECT COALESCE(SUM(n), 0) n FROM kill_count WHERE openid = ?').get(p.openid)?.n ?? 0,
      );
      if (total < Number(c.kill)) return false;
    }
    if (c.item?.name) {
      const have = d.inventory.find((i) => i.name === c.item.name);
      if (!have || Number(have.qty) < Number(c.item.qty ?? 1)) return false;
    }
    if (c.time) {
      const h = new Date().getHours();
      const isNight = h >= 18 || h < 6;
      if (c.time === 'night' && !isNight) return false;
      if (c.time === 'day' && isNight) return false;
    }
    return true;
  }

  H['对话'] = {
    desc: '和地图上的 NPC 说话（内容会随等级/魂环变化）',
    usage: '对话 <NPC名>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const d = players.detail(msg.userId);
      const npcs = content.db.prepare('SELECT * FROM npc WHERE map_id = ? AND enabled = 1').all(p.map_id);
      if (!npcs.length) return msg.reply('这里没有可以说话的人。');
      const name = args.join(' ').trim();
      if (!name) {
        return msg.reply([`用法：\`${pfx()}对话 圣魂长老\``, `这里的人：${npcs.map((n) => n.name).join(' / ')}`].join('\n'));
      }
      const npc = npcs.find((n) => n.name === name) ?? npcs.find((n) => n.name.includes(name) || name.includes(n.name));
      if (!npc) return msg.reply(`这里没有「${name}」。\n> 这里的人：${npcs.map((n) => n.name).join(' / ')}`);

      // 条件对话：按 sort 排，取所有满足条件的
      const dialogs = content.db
        .prepare('SELECT * FROM npc_dialog WHERE npc_id = ? AND enabled = 1 ORDER BY sort')
        .all(npc.id)
        .map((r) => {
          let cond = {};
          try {
            cond = JSON.parse(r.cond || '{}');
          } catch {
            cond = {};
          }
          return { ...r, cond };
        })
        .filter((r) => dialogCondOk(r.cond, p, d));

      const lines = [];
      const effects = [];
      if (dialogs.length) {
        // 第一条是「现在该说的」，后面的是补充
        for (const [i, dlg] of dialogs.entries()) {
          lines.push(i === 0 ? `> ${mdEscape(dlg.text)}` : `- ${mdEscape(dlg.text)}`);
        }
        // 动作只执行第一条的（避免一次对话把奖励全发了）
        const main = dialogs[0];
        if (main.action === 'heal') {
          const before = Number(p.hp);
          players.db.prepare('UPDATE player SET hp = hp_max, mp = mp_max WHERE openid = ?').run(p.openid);
          if (Number(p.hp_max) > before) effects.push(`生命回满（+${Number(p.hp_max) - before}）`);
          effects.push('魂力回满');
        } else if (main.action.startsWith('give:')) {
          // 只给一次：用 player_meta 记 <npc_id>:<sort>
          const key = `dlg:${npc.id}:${main.sort}`;
          const got = players.db.prepare('SELECT value FROM player_meta WHERE openid = ? AND key = ?').get(p.openid, key);
          if (got) {
            effects.push('（这份东西他已经给过你了）');
          } else {
            const spec = main.action.slice(5);
            const [iname, iqty] = spec.split('*');
            const row = content.db.prepare('SELECT id, name FROM item WHERE name = ?').get(String(iname ?? '').trim());
            if (row) {
              const qty = Math.max(1, Number(iqty) || 1);
              players.addItem(p.openid, row.id, qty, `${npc.name} 给的`);
              players.db
                .prepare('INSERT OR REPLACE INTO player_meta (openid, key, value) VALUES (?,?,?)')
                .run(p.openid, key, String(Date.now()));
              effects.push(`**获得** ${mdEscape(row.name)} × ${qty}`);
            }
          }
        }
      } else if (npc.dialog) {
        lines.push(`> ${mdEscape(npc.dialog)}`);
      }

      const quests = content.db
        .prepare(
          `SELECT q.* FROM npc_quest nq JOIN quest q ON q.id = nq.quest_id
            WHERE nq.npc_id = ? AND q.enabled = 1 ORDER BY nq.sort, q.id`,
        )
        .all(npc.id);

      if (effects.length) lines.push('', ...effects.map((x) => `> ${x}`));
      if (quests.length) {
        lines.push('', '**他能托付的事**');
        for (const q of quests) {
          const row = players.db.prepare('SELECT state FROM player_quest WHERE openid = ? AND quest_id = ?').get(p.openid, q.id);
          const st = !row ? '可接' : row.state === 'claimed' ? '已完成' : row.state === 'done' ? '**可交付**' : '进行中';
          lines.push(`- ${st} · **${mdEscape(q.name)}**`);
          if (q.desc) lines.push(`  ${mdEscape(q.desc)}`);
        }
        lines.push('', `> \`${pfx()}接受任务 <名字>\` · \`${pfx()}完成任务 <名字>\``);
      } else {
        lines.push('', '> 他没什么要你做的。');
      }
      await msg.replyMarkdown({ content: [`## ${mdEscape(npc.name)}`, ...lines].join('\n') });
    },
  };

  H['自动'] = {
    desc: '自动打完当前战斗（可连打多场）',
    usage: '自动 [场数]',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const cur = battles.current(msg.userId);
      if (!cur) {
        return msg.reply(`你现在不在战斗里。\n> 先 \`${pfx()}挑战魂兽 <名字>\`，再发 \`${pfx()}自动\``);
      }
      const times = Math.max(1, Math.min(10, Number(args[0]) || 1));
      const name = cur.monster_name;

      let totalRounds = 0;
      let wins = 0;
      let died = false;
      let ring = null;
      let ringBlocked = null;
      let expTotal = 0;
      let goldTotal = 0;
      let firstHp = Number(p.hp);

      for (let i = 0; i < times; i += 1) {
        const r = battles.autoFight(msg.userId, { maxRounds: 30 });
        if (r.error === 'no_battle') break;
        totalRounds += r.rounds;
        if (r.outcome === 'dead') {
          died = true;
          break;
        }
        if (r.outcome === 'win') {
          wins += 1;
          if (r.reward) {
            expTotal += Number(r.reward.expGain ?? 0);
            goldTotal += Number(r.reward.goldGain ?? 0);
            if (r.reward.ring) ring = r.reward.ring;
            if (r.reward.ringBlocked) ringBlocked = r.reward.ringBlocked;
          }
        } else break; // timeout：打不完就别继续了

        // 连打：还有场次就自动接下一只同名怪
        if (i < times - 1) {
          const again = battles.start(msg.userId, name);
          if (!again.battle) break;
        }
      }

      const after = players.get(msg.userId);
      const lines = [
        `## ${died ? '阵亡' : '自动战斗结束'} · ${mdEscape(name)}`,
        `> ${wins} 胜 · 共 ${totalRounds} 回合${died ? ' · **你被打倒了**' : ''}`,
        '',
        `**经验** +${expTotal} · **魂币** +${goldTotal}`,
        `**生命** ${after.hp}/${after.hp_max}　${bar(after.hp, after.hp_max)}`,
      ];
      if (ring) {
        const c = cfg();
        lines.push('', '**魂环升起**', ringLine(ring.years, ringColor(ring.years, c), ring.skill));
      }
      if (ringBlocked && !ring) {
        lines.push('', `> 这只魂兽只有 ${ringBlocked.haveAge} 年，形成不了第 ${ringBlocked.slot} 环（需 ${ringBlocked.needAge} 年）`);
      }
      if (died) lines.push('', `> \`${pfx()}复活\` 复活（免费半血）`);
      else if (after.hp < after.hp_max * 0.4) lines.push('', `> 血不多了：\`${pfx()}休息\``);
      lines.push('', `> 还想打：\`${pfx()}自动 ${times}\` · 手动：\`${pfx()}攻击\``);

      await msg.replyMarkdown({ content: lines.join('\n') });
    },
  };

  H['邮件'] = {
    desc: '查看邮件',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const list = mail.list(msg.userId, { limit: 10 });
      if (!list.length) return msg.reply('没有邮件。\n> 拍卖成交、运营补发都会发到邮箱');
      const lines = list.map((m) => {
        const st = Number(m.claimed) === 1 ? '已领' : '**未领**';
        const got = mail.summary(m.attach);
        return `- \`#${m.id}\` ${st} · **${mdEscape(m.title)}**${got.length ? `\n  ${got.join(' · ')}` : ''}`;
      });
      const left = mail.countUnclaimed(msg.userId);
      await msg.replyMarkdown({
        content: [
          '## 邮件',
          left ? `> ${left} 封未领` : '> 都领完了',
          '',
          ...lines,
          '',
          `> \`${pfx()}领取 <编号>\` · \`${pfx()}领取 全部\``,
        ].join('\n'),
      });
    },
  };

  H['领取'] = {
    desc: '领取邮件附件',
    usage: '领取 [编号|全部]',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const arg = String(args[0] ?? '').trim();
      if (arg === '全部' || arg === 'all') {
        const r = mail.claimAll(msg.userId);
        if (!r.count) return msg.reply('没有可领的邮件。');
        const after = players.get(msg.userId);
        return msg.replyMarkdown({
          content: [
            `## 领取了 ${r.count} 封`,
            ...(r.got.length ? r.got.map((g) => `- ${g}`) : ['- （都是通知，没有附件）']),
            '',
            `**魂币** ${after.gold} · **点券** ${after.coupon}`,
          ].join('\n'),
        });
      }
      const id = Number(arg);
      if (!id) return msg.reply(`用法：\`${pfx()}领取 3\` 或 \`${pfx()}领取 全部\`\n> 编号在 \`${pfx()}邮件\` 里看`);
      const r = mail.claim(msg.userId, id);
      if (r.error === 'not_found') return msg.reply(`没有 #${id} 这封邮件。`);
      if (r.error === 'already') return msg.reply(`「${mdEscape(r.title)}」已经领过了。`);
      if (r.error === 'trade') return msg.reply(r.message);
      await msg.replyMarkdown({
        content: [`## ${mdEscape(r.title)}`, ...(r.got.length ? r.got.map((g) => `- ${g}`) : ['- 没有附件'])].join('\n'),
      });
    },
  };

  /* ================= 扩展：排行 / 挑战 / 战令 ================= */

  H['排行'] = {
    desc: '各种排行榜',
    usage: '排行 [榜名]',
    async run(msg, args) {
      const list = progress.ranks();
      const key = String(args[0] ?? '').trim();
      if (!key) {
        return msg.reply(
          [`用法：\`${pfx()}排行 战力\``, `可查：${list.map((r) => r.name.replace('榜', '')).join(' / ')}`].join('\n'),
        );
      }
      const def = list.find((r) => r.name.includes(key) || r.key === key) ?? list[0];
      const res = progress.rank(def.key, 10);
      if (!res || !res.rows.length) return msg.reply(`**${def.name}** 还没有数据。`);
      const lines = res.rows.map((r, i) => `- \`${i + 1}\` **${mdEscape(r.name)}** · Lv.${r.level}`);
      const mine = players.get(msg.userId);
      const myRank = res.rows.findIndex((r) => r.openid === msg.userId);
      await msg.replyMarkdown({
        content: [
          `## ${def.name}`,
          `> ${def.desc}`,
          '',
          ...lines,
          mine && myRank >= 0 ? `\n> 你排第 **${myRank + 1}**` : mine ? '\n> 你还没进前十' : '',
        ].filter(Boolean).join('\n'),
      });
    },
  };

  H['挑战'] = {
    desc: '万兽台 / 深渊 / 世界BOSS / 神位',
    usage: '挑战 <名字>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const list = progress.challenges();
      const name = args.join(' ').trim();
      if (!name) {
        const lines = list.map((c) => {
          const pr = progress.progress(msg.userId, c.id);
          const next = Math.min(Number(c.max_depth), Number(pr.depth) + 1);
          const fl = progress.floorOf(c.id, next);
          const boss = Number(fl?.is_boss) === 1 ? ' · **守关**' : '';
          return `- **${mdEscape(c.name)}**（Lv.${c.level_req}+）· 第 ${next}/${c.max_depth} 层 · ${mdEscape(fl?.name ?? '')}${boss}\n  今日 ${pr.daily_count}/${c.daily_limit} · ${mdEscape(c.desc)}`;
        });
        return msg.replyMarkdown({
          content: ['## 挑战', ...lines, '', `> \`${pfx()}挑战 万兽台\``].join('\n'),
        });
      }
      const r = progress.fight(msg.userId, name);
      if (r.error === 'no_challenge') return msg.reply(`没有叫「${name}」的挑战。\n> \`${pfx()}挑战\` 看全部`);
      if (r.error === 'level') return msg.reply(`**${name}** 需要 Lv.${r.need}，你现在 Lv.${r.have}。`);
      if (r.error === 'daily_limit') return msg.reply(`今天已经打过 ${r.limit} 次了，明天再来。`);
      if (r.error === 'dead') return msg.reply(`你先 \`${pfx()}复活\`。`);

      const bossMark = Number(r.floor?.is_boss) === 1 ? ' · **守关**' : '';
      const lines = [
        `## ${r.win ? '通过' : '失败'} · ${mdEscape(r.challenge.name)} 第 ${r.depth} 层`,
        `> **${mdEscape(r.floor?.name ?? '')}**${bossMark} · ${r.rounds} 回合 · 对手 ≈Lv.${r.stats.level}`,
        '',
        `**剩余生命** ${Math.max(0, r.hpLeft)}/${r.player?.hp_max ?? '?'}`,
      ];
      if (r.win && r.reward) {
        const got = [];
        if (r.reward.gold) got.push(`魂币 +${r.reward.gold}`);
        if (r.reward.exp) got.push(`经验 +${r.reward.exp}`);
        for (const it of r.reward.items ?? []) {
          const nm = content.db.prepare('SELECT name FROM item WHERE id = ?').get(Number(it.id));
          got.push(`${nm?.name ?? '物品'} × ${it.qty}`);
        }
        if (got.length) lines.push('', `**奖励** ${got.join(' · ')}`);
      }
      if (r.firstClear) {
        const fc = r.firstClear;
        const extra = [];
        if (fc.gold) extra.push(`魂币 +${fc.gold}`);
        if (fc.coupon) extra.push(`点券 +${fc.coupon}`);
        for (const eid of fc.equips ?? []) {
          const nm = content.db.prepare('SELECT name FROM equip WHERE id = ?').get(Number(eid));
          if (nm) extra.push(`装备 ${mdEscape(nm.name)}`);
        }
        for (const gid of fc.gems ?? []) {
          const nm = content.db.prepare('SELECT name FROM gem WHERE id = ?').get(Number(gid));
          if (nm) extra.push(`宝石 ${mdEscape(nm.name)}`);
        }
        for (const cid of fc.companions ?? []) {
          const nm = content.db.prepare('SELECT name FROM companion WHERE id = ?').get(Number(cid));
          if (nm) extra.push(`伙伴 ${mdEscape(nm.name)}`);
        }
        if (extra.length) lines.push('', `**首通奖励** ${extra.join(' · ')}`);
      }
      if (r.bossLeft !== null) lines.push('', `**世界BOSS 剩余血量** ${r.bossLeft}`);
      if (!r.win) lines.push('', `> 你被打倒了 · \`${pfx()}复活\``);
      await msg.replyMarkdown({ content: lines.join('\n') });
    },
  };

  H['世界BOSS'] = {
    desc: '世界BOSS 状态',
    async run(msg) {
      const boss = content.db.prepare("SELECT * FROM challenge WHERE kind = 'boss' AND enabled = 1 LIMIT 1").get();
      if (!boss) return msg.reply('还没有世界BOSS。');
      const st = progress.bossState(boss.id);
      if (!st) return msg.reply('世界BOSS 还没刷新。');
      const pct = Math.round((st.hp / Math.max(1, st.maxHp)) * 100);
      await msg.replyMarkdown({
        content: [
          '## 世界BOSS',
          `> ${mdEscape(boss.name)} · 全服共享血量`,
          '',
          `**${st.hp} / ${st.maxHp}**（${pct}%）`,
          `${bar(st.hp, st.maxHp)}`,
          '',
          `> \`${pfx()}挑战 ${mdEscape(boss.name)}\` 打一次（每天 ${boss.daily_limit} 次）`,
          '> 血量每天重置',
        ].join('\n'),
      });
    },
  };

  H['斗天'] = {
    desc: '斗天积分与奖励',
    usage: '斗天 [兑换 <分数>]',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const tiers = progress.tiers();
      const row = progress.points(msg.userId);
      let claimed = [];
      try {
        claimed = JSON.parse(row.claimed || '[]');
      } catch {
        claimed = [];
      }

      if (String(args[0] ?? '') === '兑换') {
        const tier = Number(args[1]);
        if (!tier) return msg.reply(`用法：\`${pfx()}斗天 兑换 100\`\n> 档位：${tiers.join(' / ')}`);
        const r = progress.claimTier(msg.userId, tier);
        if (r.error === 'no_tier') return msg.reply(`没有 ${tier} 分这档。\n> 档位：${r.tiers.join(' / ')}`);
        if (r.error === 'not_enough') return msg.reply(`积分不够（需要 ${r.need}，你有 ${r.have}）。`);
        if (r.error === 'claimed') return msg.reply(`${tier} 分档已经领过了。`);
        if (r.error === 'trade') return msg.reply(r.message);
        return msg.replyMarkdown({
          content: [`## 斗天 ${r.tier} 分档`, `> **魂币** +${r.gold} · **点券** +${r.coupon}`].join('\n'),
        });
      }

      const lines = tiers.map((t) => {
        const done = Number(row.points) >= t;
        const got = claimed.includes(t);
        return `- ${got ? '已领' : done ? '**可领**' : '未达成'} · ${t} 分 · 魂币 ${t * 2} / 点券 ${Math.round(t / 50)}`;
      });
      await msg.replyMarkdown({
        content: [
          `## 斗天 · 第 ${progress.seasonNo()} 赛季`,
          `**我的积分** ${row.points}`,
          '> 打怪、挑战、斗魂都会涨积分',
          '',
          ...lines,
          '',
          `> \`${pfx()}斗天 兑换 <分数>\``,
        ].join('\n'),
      });
    },
  };

  /* ================= 扩展：养成（宝石 / 功法 / 暗器 / 双生武魂 / 耐久） ================= */

  H['宝石'] = {
    desc: '宝石列表与库存',
    async run(msg) {
      const gems = growth.gems();
      const owned = players.db.prepare('SELECT gem_id, qty FROM gem_owned WHERE openid = ?').all(msg.userId);
      const have = new Map(owned.map((o) => [o.gem_id, o.qty]));
      const lines = gems.map((g) => `- **${mdEscape(g.name)}** ×${have.get(g.id) ?? 0} · ${mdEscape(g.desc)}`);
      await msg.replyMarkdown({
        content: ['## 宝石', ...lines, '', `> \`${pfx()}开孔 <装备>\` → \`${pfx()}镶嵌 <装备> <宝石>\``].join('\n'),
      });
    },
  };

  H['开孔'] = {
    desc: '给装备开一个宝石孔',
    usage: '开孔 <装备名>',
    async run(msg, args) {
      const name = args.join(' ').trim();
      if (!name) return msg.reply(`用法：\`${pfx()}开孔 鹿之左臂骨\``);
      const r = growth.openSlot(msg.userId, name);
      if (r.error === 'not_owned') return msg.reply(`你没有「${name}」。`);
      if (r.error === 'max_holes') return msg.reply(`**${name}** 已经开满 ${r.max} 个孔。`);
      if (r.error === 'no_gold') return msg.reply(`开孔要 ${r.need} 魂币，你只有 ${r.have}。`);
      await msg.replyMarkdown({
        content: [`## 开孔成功`, `> **${mdEscape(r.name)}** 现在有 ${r.holes}/${r.max} 个孔 · 花费 ${r.cost}`].join('\n'),
      });
    },
  };

  H['镶嵌'] = {
    desc: '把宝石镶进装备孔',
    usage: '镶嵌 <装备名> <宝石名>',
    async run(msg, args) {
      if (args.length < 2) return msg.reply(`用法：\`${pfx()}镶嵌 鹿之左臂骨 赤焰石\``);
      const gemName = args[args.length - 1];
      const equipName = args.slice(0, -1).join(' ').trim();
      const r = growth.socket(msg.userId, equipName, gemName);
      if (r.error === 'not_owned') return msg.reply(`你没有「${equipName}」。`);
      if (r.error === 'no_gem') return msg.reply(`没有「${gemName}」这种宝石。`);
      if (r.error === 'no_hole') return msg.reply(`**${equipName}** 没有空孔，先 \`${pfx()}开孔 ${equipName}\`。`);
      if (r.error === 'no_stock') return msg.reply(`你没有「${r.name}」。\n> 宝石可以从抽奖/挑战获得`);
      await msg.replyMarkdown({
        content: [
          `## 镶嵌成功`,
          `> **${mdEscape(r.gem)}** → ${mdEscape(r.equip)}（第 ${r.slot} 孔）`,
          '',
          `**攻击** ${r.player.atk} · **防御** ${r.player.def} · **生命** ${r.player.hp_max}`,
        ].join('\n'),
      });
    },
  };

  H['摘孔'] = {
    desc: '取下宝石',
    usage: '摘孔 <装备名> <孔位>',
    async run(msg, args) {
      const slot = Number(args[args.length - 1]);
      const equipName = args.slice(0, -1).join(' ').trim();
      if (!equipName || !slot) return msg.reply(`用法：\`${pfx()}摘孔 鹿之左臂骨 1\``);
      const r = growth.unsocket(msg.userId, equipName, slot);
      if (r.error === 'not_owned') return msg.reply(`你没有「${equipName}」。`);
      if (r.error === 'no_slot') return msg.reply(`**${equipName}** 第 ${slot} 孔没有宝石。`);
      await msg.replyMarkdown({
        content: [`## 已取下`, `> **${mdEscape(r.gem)}** 回到库存`, '', `**攻击** ${r.player.atk}`].join('\n'),
      });
    },
  };

  /** 功法 / 血脉 共用一套列表与学习逻辑 */
  function aptitudeList(kind, title) {
    return {
      desc: `查看${title}`,
      async run(msg) {
        const list = growth.aptitudes(kind);
        const mine = new Set(growth.ownedAptitudes(msg.userId).map((a) => a.id));
        const lines = list.map((a) => {
          const attrs = Object.entries(safeJson(a.attrs))
            .map(([k, v]) => `${ATTR_LABEL[k] ?? k}+${v}`)
            .join(' ');
          const cost = safeJson(a.cost);
          const costStr = [`${cost.gold ?? 0} 魂币`]
            .concat((cost.items ?? []).map((it) => {
              const nm = content.db.prepare('SELECT name FROM item WHERE id = ?').get(Number(it.id));
              return `${nm?.name ?? '物品'}×${it.qty}`;
            }))
            .join(' + ');
          return `- ${mine.has(a.id) ? '**已学**' : '未学'} · **${mdEscape(a.name)}**（${'★'.repeat(Number(a.rarity) || 1)}）\n  ${attrs} · ${costStr}`;
        });
        await msg.replyMarkdown({
          content: [`## ${title}`, ...lines, '', `> \`${pfx()}学 <名字>\` 学习`].join('\n'),
        });
      },
    };
  }

  H['功法'] = aptitudeList('technique', '功法');
  H['血脉'] = aptitudeList('bloodline', '血脉');

  H['学'] = {
    desc: '学习功法或血脉',
    usage: '学 <名字>',
    async run(msg, args) {
      const name = args.join(' ').trim();
      if (!name) return msg.reply(`用法：\`${pfx()}学 玄天功\`\n> \`${pfx()}功法\` / \`${pfx()}血脉\` 看能学什么`);
      const r = growth.learn(msg.userId, name);
      if (r.error === 'no_aptitude') return msg.reply(`没有「${name}」这门功法/血脉。`);
      if (r.error === 'already') return msg.reply(`你已经学过 **${r.name}** 了。`);
      if (r.error === 'trade') return msg.reply(r.message);
      const attrs = Object.entries(r.attrs)
        .map(([k, v]) => `${ATTR_LABEL[k] ?? k}+${v}`)
        .join(' ');
      await msg.replyMarkdown({
        content: [
          `## 学会了 ${mdEscape(r.aptitude.name)}`,
          `> ${mdEscape(r.aptitude.desc)}`,
          '',
          `**永久加成** ${attrs}`,
          `**攻击** ${r.player.atk} · **生命** ${r.player.hp_max}`,
        ].join('\n'),
      });
    },
  };

  H['暗器'] = {
    desc: '暗器列表（战斗中可用）',
    async run(msg) {
      const list = growth.weapons();
      const lines = list.map((w) => `- **${mdEscape(w.name)}** ×${growth.weaponStock(msg.userId, w.id)} · 威力 ${w.power}% · ${w.price} 魂币\n  ${mdEscape(w.desc)}`);
      await msg.replyMarkdown({
        content: ['## 暗器', ...lines, '', `> \`${pfx()}买暗器 <名字>\` · 战斗中 \`${pfx()}用暗器 <名字>\``].join('\n'),
      });
    },
  };

  H['买暗器'] = {
    desc: '购买暗器',
    usage: '买暗器 <名字>',
    async run(msg, args) {
      const name = args.join(' ').trim();
      if (!name) return msg.reply(`用法：\`${pfx()}买暗器 袖箭\``);
      const r = growth.buyWeapon(msg.userId, name);
      if (r.error === 'no_weapon') return msg.reply(`没有「${name}」这种暗器。`);
      if (r.error === 'trade') return msg.reply(r.message);
      await msg.replyMarkdown({ content: [`## 买到 ${mdEscape(r.weapon.name)}`, `> 花费 ${r.weapon.price} 魂币`].join('\n') });
    },
  };

  H['用暗器'] = {
    desc: '战斗中使用暗器',
    usage: '用暗器 <名字>',
    async run(msg, args) {
      const name = args.join(' ').trim();
      if (!name) return msg.reply(`用法：\`${pfx()}用暗器 袖箭\``);
      const b = battles.current(msg.userId);
      if (!b) return msg.reply('你不在战斗里。');
      const w = growth.weapons().find((x) => x.name === name);
      if (!w) return msg.reply(`没有「${name}」这种暗器。`);
      if (growth.weaponStock(msg.userId, w.id) <= 0) return msg.reply(`你没有「${name}」了。`);
      const p = players.get(msg.userId);
      if (Number(p.mp) < Number(w.cost)) return msg.reply(`魂力不够（需要 ${w.cost}）。`);
      growth.db
        .prepare('UPDATE hidden_weapon_owned SET qty = qty - 1 WHERE openid = ? AND weapon_id = ?')
        .run(msg.userId, w.id);
      const dmg = Math.max(1, Math.round(Number(p.atk) * (Number(w.power) / 100) * 1.5));
      growth.db
        .prepare('UPDATE battle SET monster_hp = MAX(0, monster_hp - ?) WHERE id = ?')
        .run(dmg, b.id);
      growth.db.prepare('UPDATE player SET mp = MAX(0, mp - ?) WHERE openid = ?').run(w.cost, msg.userId);
      const after = growth.db.prepare('SELECT monster_hp FROM battle WHERE id = ?').get(b.id);
      await msg.replyMarkdown({
        content: [
          `## ${mdEscape(w.name)} 出手`,
          `> 造成 **${dmg}** 伤害 · 耗魂力 ${w.cost}`,
          '',
          `**敌方剩余** ${after?.monster_hp ?? 0}`,
          after?.monster_hp > 0 ? `> \`${pfx()}攻击\` 继续` : `> \`${pfx()}攻击\` 收尾`,
        ].join('\n'),
      });
    },
  };

  H['副武魂'] = {
    desc: '设置第二武魂（双生武魂）',
    usage: '副武魂 <武魂名>',
    async run(msg, args) {
      const name = args.join(' ').trim();
      if (!name) {
        const e = qol.ext(msg.userId);
        const sub = e.sub_wuhun_id
          ? content.db.prepare('SELECT name FROM wuhun WHERE id = ?').get(e.sub_wuhun_id)?.name
          : null;
        return msg.reply(
          [
            `用法：\`${pfx()}副武魂 昊天锤\``,
            sub ? `当前副武魂：**${sub}** · \`${pfx()}切换武魂\` 互换` : '你还没有副武魂',
          ].join('\n'),
        );
      }
      const r = growth.setSubWuhun(msg.userId, name);
      if (r.error === 'no_wuhun') return msg.reply(`没有「${name}」这个武魂。\n> \`${pfx()}武魂列表\` 看看`);
      if (r.error === 'same') return msg.reply(`这已经是你现在的主武魂了。`);
      await msg.replyMarkdown({
        content: [`## 副武魂已设置`, `> **${mdEscape(r.wuhun.name)}**`, '', `> \`${pfx()}切换武魂\` 随时互换`].join('\n'),
      });
    },
  };

  H['切换武魂'] = {
    desc: '主副武魂互换',
    async run(msg) {
      const r = growth.swapWuhun(msg.userId);
      if (r.error === 'no_sub') return msg.reply(`你还没有副武魂。\n> \`${pfx()}副武魂 <武魂名>\` 设置一个`);
      await msg.replyMarkdown({
        content: [
          '## 武魂切换',
          `> 主 **${mdEscape(r.main)}** · 副 **${mdEscape(r.sub)}**`,
          '',
          `**攻击** ${r.player.atk} · **防御** ${r.player.def} · **生命** ${r.player.hp_max}`,
        ].join('\n'),
      });
    },
  };

  H['修理'] = {
    desc: '修理装备耐久',
    usage: '修理 [装备名]',
    async run(msg, args) {
      const name = args.join(' ').trim();
      const r = growth.repair(msg.userId, name);
      if (r.error === 'not_owned') return msg.reply(`你没有「${name}」。`);
      if (r.error === 'no_equip') return msg.reply('你还没有装备。');
      if (r.error === 'full') return msg.reply('耐久都是满的，不用修。');
      if (r.error === 'no_gold') return msg.reply(`修理要 ${r.need} 魂币，你只有 ${r.have}。`);
      await msg.replyMarkdown({
        content: [
          '## 修理完成',
          `> ${r.count} 件 · 修复 ${r.points} 点 · 花费 ${r.cost} 魂币`,
          '',
          `**攻击** ${r.player.atk} · **防御** ${r.player.def}`,
        ].join('\n'),
      });
    },
  };

  /* ================= 扩展：称号 / 签到 / 冥想 / 资料 / 社交 ================= */

  H['称号'] = {
    desc: '称号列表与佩戴',
    usage: '称号 [佩戴 <名字>]',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      if (String(args[0] ?? '') === '佩戴') {
        const name = args.slice(1).join(' ').trim();
        if (!name) return msg.reply(`用法：\`${pfx()}称号 佩戴 魂尊\``);
        const r = qol.wearTitle(msg.userId, name);
        if (r.error === 'no_title') return msg.reply(`没有「${name}」这个称号。`);
        if (r.error === 'not_owned') return msg.reply(`你还没拿到 **${r.name}**。\n> 称号是达成条件自动获得的`);
        return msg.replyMarkdown({ content: [`## 已佩戴 **${mdEscape(r.title.name)}**`, `> ${mdEscape(r.title.desc)}`].join('\n') });
      }
      if (String(args[0] ?? '') === '取下') {
        qol.unwearTitle(msg.userId);
        return msg.reply('已取下称号。');
      }
      const list = qol.titles(msg.userId);
      const lines = list.map((t) =>
        `- ${t.worn ? '**佩戴中**' : t.owned ? '已获得' : '未获得'} · **${mdEscape(t.name)}**${t.desc ? ` — ${mdEscape(t.desc)}` : ''}`,
      );
      await msg.replyMarkdown({
        content: ['## 称号', ...lines, '', `> \`${pfx()}称号 佩戴 <名字>\` · \`${pfx()}称号 取下\``].join('\n'),
      });
    },
  };

  H['冥想'] = {
    desc: '开始/结束冥想（挂机得经验）',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const cur = qol.meditating(msg.userId);
      if (!cur) {
        const r = qol.startMeditate(msg.userId);
        if (r.error === 'in_battle') return msg.reply('战斗中不能冥想。');
        if (r.error === 'already') return msg.reply('你已经在冥想了。');
        const c = cfg();
        return msg.replyMarkdown({
          content: [
            '## 开始冥想',
            `> 每分钟 ${c.meditation_exp_per_min ?? 30} 经验，最多累计 ${c.meditation_cap_hours ?? 8} 小时`,
            '',
            `> 再发一次 \`${pfx()}冥想\` 结束并结算`,
          ].join('\n'),
        });
      }
      const r = qol.stopMeditate(msg.userId);
      if (r.error === 'not_meditating') return msg.reply('你不在冥想。');
      if (r.minutes <= 0) return msg.reply('还没到一分钟，什么都没得到。');
      await msg.replyMarkdown({
        content: [
          '## 冥想结束',
          `> ${r.minutes} 分钟${r.capped ? '（已达上限）' : ''}`,
          '',
          `**经验** +${r.exp}${r.leveled ? ` · **升级** Lv.${r.player.level}` : ''}`,
          `**当前** Lv.${r.player.level}`,
        ].join('\n'),
      });
    },
  };

  H['资料'] = {
    desc: '查看玩家资料卡',
    usage: '资料 [昵称]',
    async run(msg, args) {
      const name = args.join(' ').trim();
      let openid = msg.userId;
      if (name) {
        const list = players.findByName(name);
        if (!list.length) return msg.reply(`没有叫「${name}」的玩家。`);
        if (list.length > 1) return msg.reply(`有 ${list.length} 个玩家叫「${name}」。`);
        openid = list[0].openid;
      }
      const d = qol.profile(openid);
      if (!d) return msg.reply('没有这个角色。');
      const p = d.player;
      await msg.replyMarkdown({
        content: [
          `## ${mdEscape(p.name)}${d.title ? ` · ${mdEscape(d.title)}` : ''}`,
          d.bio ? `> ${mdEscape(d.bio)}` : '',
          '',
          `**等级** Lv.${p.level} · **战力** ${d.power} · **魂环** ${d.rings}`,
          d.guild ? `**宗门** ${mdEscape(d.guild)}` : '',
          d.couple.length ? `**情侣** ${d.couple.map(mdEscape).join('、')}` : '',
          `**魅力** ${d.charm}${d.anonymous ? ' · 已匿名' : ''}`,
          '',
          `> \`${pfx()}送花 ${mdEscape(p.name)}\` 送一朵`,
        ].filter(Boolean).join('\n'),
      });
    },
  };

  H['改名'] = {
    desc: '改名字',
    usage: '改名 <新名字>',
    async run(msg, args) {
      const name = args.join(' ').trim();
      if (!name) return msg.reply(`用法：\`${pfx()}改名 新名字\``);
      const r = qol.rename(msg.userId, name);
      if (r.error === 'bad_name') return msg.reply('名字 1–12 个字。');
      if (r.error === 'name_taken') return msg.reply(`「${name}」已经有人用了。`);
      if (r.error === 'no_gold') return msg.reply(`改名要 ${r.need} 魂币，你只有 ${r.have}。`);
      await msg.replyMarkdown({ content: [`## 改名成功`, `> ${mdEscape(r.before)} → **${mdEscape(r.name)}**`, '', `花费 ${r.cost} 魂币`].join('\n') });
    },
  };

  H['签名'] = {
    desc: '设置个人签名',
    usage: '签名 <内容>',
    async run(msg, args) {
      const text = args.join(' ').trim();
      if (!text) return msg.reply(`用法：\`${pfx()}签名 一句话介绍自己\``);
      const r = qol.setBio(msg.userId, text);
      await msg.replyMarkdown({ content: [`## 签名已更新`, `> ${mdEscape(r.bio)}`].join('\n') });
    },
  };

  H['匿名'] = {
    desc: '匿名开关（喊话不显示名字）',
    usage: '匿名 [开|关]',
    async run(msg, args) {
      const on = String(args[0] ?? '').includes('开');
      const r = qol.toggleAnon(msg.userId, on);
      await msg.replyMarkdown({ content: [`## 匿名已${r.anonymous ? '开启' : '关闭'}`, r.anonymous ? '> 喊话时不会显示你的名字' : '> 喊话会显示名字'].join('\n') });
    },
  };

  H['送花'] = {
    desc: '给别的玩家送花',
    usage: '送花 <昵称> [数量]',
    async run(msg, args) {
      const name = args[0];
      if (!name) return msg.reply(`用法：\`${pfx()}送花 昵称\``);
      const qty = Math.max(1, Math.trunc(Number(args[1]) || 1));
      const r = qol.sendFlower(msg.userId, name, qty);
      if (r.error === 'not_found') return msg.reply(`没有叫「${name}」的玩家。`);
      if (r.error === 'ambiguous') return msg.reply(`有多个玩家叫「${name}」。`);
      if (r.error === 'self') return msg.reply('不能给自己送花。');
      if (r.error === 'trade') return msg.reply(r.message);
      await msg.replyMarkdown({
        content: [`## 送花成功`, `> 送给 **${mdEscape(r.to)}** × ${r.qty}`, '', `花费 ${r.price} 魂币 · 对方魅力 +${r.charm}`].join('\n'),
      });
    },
  };

  H['约战'] = {
    desc: '约人打一场（对方要应战）',
    usage: '约战 <昵称>',
    async run(msg, args) {
      const name = args.join(' ').trim();
      if (!name) {
        const pend = qol.pendingDuels(msg.userId);
        return msg.reply(
          [`用法：\`${pfx()}约战 昵称\``, pend.length ? `找你的：${pend.map((x) => x.fromName).join(' / ')}` : '没人约你'].join('\n'),
        );
      }
      const r = qol.requestDuel(msg.userId, name);
      if (r.error === 'not_found') return msg.reply(`没有叫「${name}」的玩家。`);
      if (r.error === 'ambiguous') return msg.reply(`有多个玩家叫「${name}」。`);
      if (r.error === 'self') return msg.reply('不能约自己。');
      if (r.error === 'pending') return msg.reply(`已经约过 **${r.name}** 了，等他应战。`);
      await msg.replyMarkdown({
        content: [`## 已发出约战`, `> 对手 **${mdEscape(r.to)}**`, '', `> 对方发 \`${pfx()}应战 ${mdEscape(players.get(msg.userId).name)}\` 开打`].join('\n'),
      });
    },
  };

  H['应战'] = {
    desc: '接受约战',
    usage: '应战 <昵称>',
    async run(msg, args) {
      const name = args.join(' ').trim();
      if (!name) return msg.reply(`用法：\`${pfx()}应战 昵称\``);
      const r = qol.acceptDuel(msg.userId, name);
      if (r.error === 'not_found') return msg.reply(`没有叫「${name}」的玩家。`);
      if (r.error === 'no_request') return msg.reply(`「${name}」没约你。`);
      if (r.error) return msg.reply('这场打不了。');
      const d = r.result;
      await msg.replyMarkdown({
        content: [
          `## ${d.win ? '胜利' : '败北'} · ${mdEscape(d.foe.name)}`,
          `> ${d.rounds} 回合 · 排位分 ${d.scoreDelta > 0 ? '+' : ''}${d.scoreDelta}`,
          '',
          `**你** ${Math.max(0, d.aHp)}/${d.aMax}　${bar(Math.max(0, d.aHp), d.aMax)}`,
          `**对方** ${Math.max(0, d.bHp)}/${d.bMax}　${bar(Math.max(0, d.bHp), d.bMax)}`,
        ].join('\n'),
      });
    },
  };

  H['教程'] = {
    desc: '新手教程',
    async run(msg) {
      const list = qol.tutorials();
      if (!list.length) return msg.reply('还没有教程。');
      const lines = list.map((t) => `**${mdEscape(t.title)}**\n${mdEscape(t.body)}`);
      await msg.replyMarkdown({ content: ['## 教程', ...lines].join('\n\n') });
    },
  };

  H['批量'] = {
    desc: '批量使用物品',
    usage: '批量 使用 <物品> <数量>',
    async run(msg, args) {
      if (String(args[0] ?? '') !== '使用') {
        return msg.reply(`用法：\`${pfx()}批量 使用 金疮药 5\``);
      }
      const qty = Math.max(1, Math.min(50, Math.trunc(Number(args[args.length - 1]) || 1)));
      const name = args.slice(1, -1).join(' ').trim() || args[1];
      if (!name) return msg.reply(`用法：\`${pfx()}批量 使用 金疮药 5\``);
      let used = 0;
      let last = null;
      for (let i = 0; i < qty; i += 1) {
        const r = players.useItem(msg.userId, name);
        if (r.error) {
          last = r;
          break;
        }
        used += 1;
      }
      if (!used) {
        if (last?.error === 'no_item') return msg.reply(`你没有「${name}」。`);
        if (last?.error === 'full') return msg.reply('生命/魂力已经是满的，用不着。');
        if (last?.error === 'not_enough') return msg.reply(`**${name}** 不够（有 ${last.have}）。`);
        return msg.reply(`用不了：${last?.error ?? '未知'}`);
      }
      const p = players.get(msg.userId);
      await msg.replyMarkdown({
        content: [
          `## 批量使用`,
          `> **${mdEscape(name)}** × ${used}`,
          '',
          `**生命** ${p.hp}/${p.hp_max} · **魂力** ${p.mp}/${p.mp_max}`,
        ].join('\n'),
      });
    },
  };

  H['神秘商店'] = {
    desc: '每日随机折扣商店',
    usage: '神秘商店 [买 <物品>]',
    async run(msg, args) {
      const items = mysteryShopItems(content);
      if (String(args[0] ?? '') === '买') {
        const name = args.slice(1).join(' ').trim();
        const hit = items.find((x) => x.name === name);
        if (!hit) return msg.reply(`今天没有「${name}」。`);
        const p = players.get(msg.userId);
        if (Number(p.gold) < hit.price) return msg.reply(`要 ${hit.price} 魂币，你只有 ${p.gold}。`);
        try {
          economy.trade(msg.userId, { pay: { gold: hit.price }, gain: { items: [{ id: hit.item_id, qty: 1 }] }, reason: `神秘商店 ${hit.name}` });
        } catch (e) {
          return msg.reply(e.message);
        }
        return msg.replyMarkdown({ content: [`## 买到 ${mdEscape(hit.name)}`, `> 花费 ${hit.price} 魂币（原价 ${hit.base}）`].join('\n') });
      }
      const lines = items.map((x) => `- **${mdEscape(x.name)}** · ${x.price} 魂币（原价 ${x.base}）${x.price < x.base ? ' · **折扣**' : ''}`);
      await msg.replyMarkdown({
        content: ['## 神秘商店', '> 每天刷新三件，价格随机', '', ...lines, '', `> \`${pfx()}神秘商店 买 <物品>\``].join('\n'),
      });
    },
  };

  H['宗门商店'] = {
    desc: '用宗门资金买物品',
    usage: '宗门商店 [买 <物品>]',
    async run(msg, args) {
      const g = guild.of(msg.userId);
      if (!g) return msg.reply(`你还没有宗门。\n> \`${pfx()}创建宗门 <名字>\``);
      const rows = content.db
        .prepare('SELECT gs.*, i.name, i.desc FROM guild_shop gs JOIN item i ON i.id = gs.item_id ORDER BY gs.price')
        .all();
      if (!rows.length) return msg.reply('宗门商店还没上货。');

      if (String(args[0] ?? '') === '买') {
        const name = args.slice(1).join(' ').trim();
        const hit = rows.find((r) => r.name === name);
        if (!hit) return msg.reply(`宗门商店没有「${name}」。`);
        if (Number(g.funds) < Number(hit.price)) return msg.reply(`宗门资金不够（需要 ${hit.price}，现有 ${g.funds}）。`);
        guild.db.prepare('UPDATE guild SET funds = funds - ? WHERE id = ?').run(hit.price, g.id);
        players.addItem(msg.userId, hit.item_id, 1, `宗门商店 ${hit.name}`);
        return msg.replyMarkdown({
          content: [`## 买到 ${mdEscape(hit.name)}`, `> 花宗门资金 ${hit.price} · 剩余 ${Number(g.funds) - Number(hit.price)}`].join('\n'),
        });
      }
      const lines = rows.map((r) => `- **${mdEscape(r.name)}** · ${r.price} 宗门资金`);
      await msg.replyMarkdown({
        content: [`## ${mdEscape(g.name)} 商店`, `> 宗门资金 ${g.funds}`, '', ...lines, '', `> \`${pfx()}宗门商店 买 <物品>\``].join('\n'),
      });
    },
  };

  H['放弃职业'] = {
    desc: '放弃当前职业',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      if (!p.profession) return msg.reply('你现在没有职业。');
      const before = p.profession;
      players.db.prepare("UPDATE player SET profession = '' WHERE openid = ?").run(msg.userId);
      await msg.replyMarkdown({
        content: [`## 已放弃职业`, `> ${mdEscape(before)}`, '', `> \`${pfx()}转职 <职业>\` 可以重新选`].join('\n') });
    },
  };

  H['升卡'] = {
    desc: '用碎片升级伙伴卡',
    usage: '升卡 <伙伴名>',
    async run(msg, args) {
      const name = args.join(' ').trim();
      if (!name) return msg.reply(`用法：\`${pfx()}升卡 百年魂灵\``);
      const list = players.ownedCompanions(msg.userId);
      const target = list.find((c) => c.name === name);
      if (!target) return msg.reply(`你没有「${name}」。`);
      const cfgNow = cfg();
      const maxLv = Number(cfgNow.companion_max_level ?? 10);
      if (Number(target.level) >= maxLv) return msg.reply(`**${name}** 已经满级 +${maxLv}。`);
      const need = 5 + Number(target.level) * 5;
      const have = players.db.prepare('SELECT qty FROM inventory WHERE openid = ? AND item_id = 3').get(msg.userId)?.qty ?? 0;
      if (Number(have) < need) return msg.reply(`升级需要 **${need}** 个魂环碎片，你有 ${have}。`);
      players.addItem(msg.userId, 3, -need, `升卡 ${name}`);
      players.db.prepare('UPDATE companion_owned SET level = level + 1 WHERE id = ?').run(target.instanceId);
      const after = players.recalc(msg.userId);
      await msg.replyMarkdown({
        content: [
          `## ${mdEscape(name)} **+${Number(target.level) + 1}**`,
          `> 消耗 ${need} 魂环碎片`,
          '',
          `**攻击** ${after.atk} · **生命** ${after.hp_max}`,
        ].join('\n'),
      });
    },
  };

  /** 丹鼎 / 丹火：同一套逻辑，只是 kind 不同 */
  function toolHandler(kind, title) {
    return {
      desc: `查看/更换${title}`,
      usage: `${title} [名字]`,
      async run(msg, args) {
        const name = args.join(' ').trim();
        if (name) {
          const r = craft.equipTool(msg.userId, name);
          if (r.error === 'no_tool') return msg.reply(`没有「${name}」这种${title}。`);
          if (r.error === 'same') return msg.reply(`你现在用的就是 **${r.name}**。`);
          return msg.replyMarkdown({
            content: [
              `## 已装备 ${mdEscape(r.tool.name)}`,
              `> 成功率 +${r.tool.bonus}%`,
              '',
              `> \`${pfx()}炼丹 <丹方>\` 试试`,
            ].join('\n'),
          });
        }
        const list = craft.alchemyTools(kind);
        const cur = craft.myTools(msg.userId);
        const worn = kind === 'furnace' ? cur.furnace : cur.fire;
        const lines = list.map(
          (t) => `- ${Number(worn?.id) === Number(t.id) ? '**在用**' : ''} **${mdEscape(t.name)}** · 成功率 +${t.bonus}% · ${t.price} 魂币\n  ${mdEscape(t.desc)}`,
        );
        await msg.replyMarkdown({
          content: [
            `## ${title}`,
            worn ? `> 当前：**${mdEscape(worn.name)}**（+${worn.bonus}%）` : '> 还没装备，炼丹成功率会很低',
            '',
            ...lines,
            '',
            `> \`${pfx()}${title} <名字>\` 更换`,
          ].join('\n'),
        });
      },
    };
  }

  H['丹鼎'] = toolHandler('furnace', '丹鼎');
  H['丹火'] = toolHandler('fire', '丹火');

  H['炼丹'] = {
    desc: '炼丹（有成功率与品质）',
    usage: '炼丹 <丹方> [次数]',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      if (!args.length) {
        const list = craft.recipes('alchemy');
        const cur = craft.myTools(msg.userId);
        const lines = list.map((r) => `- **${mdEscape(r.name)}**（Lv.${r.level_req}）· ${mdEscape(r.desc)}`);
        return msg.replyMarkdown({
          content: [
            '## 炼丹',
            `> 丹鼎：${cur.furnace ? `**${mdEscape(cur.furnace.name)}** +${cur.furnace.bonus}%` : '无'}`,
            `> 丹火：${cur.fire ? `**${mdEscape(cur.fire.name)}** +${cur.fire.bonus}%` : '无'}`,
            '',
            ...lines,
            '',
            `> \`${pfx()}炼丹 <丹方> [次数]\` · \`${pfx()}丹鼎\` / \`${pfx()}丹火\` 换工具`,
          ].join('\n'),
        });
      }
      const last = Number(args[args.length - 1]);
      const times = args.length > 1 && Number.isFinite(last) ? last : 1;
      const name = (args.length > 1 && Number.isFinite(last) ? args.slice(0, -1) : args).join(' ').trim();
      const r = craft.brew(msg.userId, name, times);
      if (r.error === 'no_recipe') return msg.reply(`没有「${name}」这个丹方。\n> \`${pfx()}炼丹\` 看全部`);
      if (r.error === 'wrong_profession') return msg.reply(`炼丹要 **${r.need}**，你现在是 ${r.have}。\n> \`${pfx()}转职 ${r.need}\``);
      if (r.error === 'level') return msg.reply(`需要 Lv.${r.need}，你现在 Lv.${r.have}。`);
      if (r.error === 'trade') return msg.reply(r.message);

      const q = Object.entries(r.quality).filter(([, v]) => v > 0).map(([k, v]) => `${k}×${v}`).join(' · ');
      await msg.replyMarkdown({
        content: [
          `## 炼丹 · ${mdEscape(r.recipe)}`,
          `> 成功率 ${r.rate}%${r.tools.furnace ? ` · 鼎 +${r.tools.furnace.bonus}` : ' · 无鼎'}${r.tools.fire ? ` · 火 +${r.tools.fire.bonus}` : ' · 无火'}`,
          '',
          `**成功** ${r.success} 次 · **失败** ${r.fail} 次`,
          q ? `**品质** ${q}` : '',
          r.success ? `**产出** ${mdEscape(r.outName)} × ${r.gained}` : '',
          '',
          `**经验** +${r.exp}${r.leveled ? ` · **升级** Lv.${players.get(msg.userId).level}` : ''}`,
        ].filter(Boolean).join('\n'),
      });
    },
  };

  H['图鉴'] = {
    desc: '魂兽图鉴与收集奖励',
    usage: '图鉴 [领奖]',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      if (String(args[0] ?? '') === '领奖') {
        const r = qol.claimBestiary(msg.userId);
        if (!r.count) return msg.reply('还没有可领的图鉴奖励。');
        return msg.replyMarkdown({
          content: [`## 图鉴奖励`, ...r.got.map((g) => `- ${g}`), '', `> 共 ${r.count} 档`].join('\n'),
        });
      }
      const b = qol.bestiary(msg.userId);
      const rewards = qol.bestiaryRewards(msg.userId);
      const unlocked = b.list.filter((m) => m.unlocked);
      const locked = b.list.filter((m) => !m.unlocked);
      const lines = [];
      if (unlocked.length) {
        lines.push('**已解锁**');
        for (const m of unlocked.slice(0, 12)) lines.push(`- **${mdEscape(m.name)}**（${m.age} 年）× ${m.kills}`);
        if (unlocked.length > 12) lines.push(`- …… 还有 ${unlocked.length - 12} 种`);
      }
      if (locked.length) {
        lines.push('', '**未解锁**');
        lines.push(locked.slice(0, 6).map((m) => `- ${mdEscape(m.name)}（${m.age} 年）`).join('\n'));
        if (locked.length > 6) lines.push(`- …… 还有 ${locked.length - 6} 种`);
      }
      const claimable = rewards.filter((r) => r.reached && !r.claimed).length;
      await msg.replyMarkdown({
        content: [
          '## 魂兽图鉴',
          `> **${b.unlocked} / ${b.total}** 种　${bar(b.unlocked, b.total)}`,
          '',
          ...lines,
          '',
          claimable ? `> 有 **${claimable}** 档奖励可领 · \`${pfx()}图鉴 领奖\`` : '> 继续探索解锁更多',
        ].join('\n'),
      });
    },
  };

  H['悬赏'] = {
    desc: '每日悬赏任务',
    usage: '悬赏 [领取]',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      if (String(args[0] ?? '').includes('领')) {
        const r = progress.claimBounties(msg.userId);
        if (!r.count) return msg.reply('还没有完成的悬赏。');
        return msg.replyMarkdown({
          content: [
            '## 悬赏结算',
            `> 完成 ${r.count} 个 · 魂币 +${r.gold} · 斗天积分 +${r.points}`,
          ].join('\n'),
        });
      }
      const list = progress.dailyBounties(msg.userId);
      if (!list.length) return msg.reply('今天没有悬赏。');
      const lines = list.map((b) => {
        const st = Number(b.claimed) ? '已领' : b.done ? '**可领**' : `${b.progress}/${b.target}`;
        return `- ${st} · 击杀 **${mdEscape(b.name)}** × ${b.target} · 魂币 ${b.reward.gold}`;
      });
      await msg.replyMarkdown({
        content: [
          '## 今日悬赏',
          '> 每天 3 个，击杀指定魂兽即可完成',
          '',
          ...lines,
          '',
          `> \`${pfx()}悬赏 领取\``,
        ].join('\n'),
      });
    },
  };

  H['魂技升级'] = {
    desc: '升级魂技（每级 +8% 威力）',
    usage: '魂技升级 <魂技名>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      const mine = ringSkills(p.openid);
      if (!name) {
        if (!mine.length) return msg.reply(`你还没有带技能的魂环。\n> 先 \`${pfx()}附加魂环\``);
        const lines = mine.map((x) => {
          const lv = players.skillLevel(p.openid, x.skill.id);
          const next = players.skillUpgradeCost(lv);
          return `- **${mdEscape(x.skill.name)}** +${lv} · 威力 ${x.skill.power}% · 下一级 ${next} 魂币`;
        });
        return msg.replyMarkdown({
          content: ['## 魂技', ...lines, '', `> \`${pfx()}魂技升级 <魂技名>\``].join('\n'),
        });
      }
      const hit = mine.find((x) => x.skill.name === name) ?? mine.find((x) => x.skill.name.includes(name));
      if (!hit) return msg.reply(`你的魂环里没有「${name}」。\n> \`${pfx()}魂技升级\` 看全部`);
      const r = players.upgradeSkill(p.openid, hit.skill.id);
      if (r.error === 'maxed') return msg.reply(`**${hit.skill.name}** 已经满级 +${r.max}。`);
      if (r.error === 'no_gold') return msg.reply(`升级要 **${r.need}** 魂币，你只有 ${r.have}。`);
      const eff = players.effectiveSkill(p.openid, hit.skill);
      await msg.replyMarkdown({
        content: [
          `## ${mdEscape(hit.skill.name)} **+${r.level}**`,
          `> 消耗 ${r.cost} 魂币`,
          '',
          `**威力** ${hit.skill.power}% → **${eff.power}%**`,
          r.level < r.max ? `> 下一级 ${players.skillUpgradeCost(r.level)} 魂币` : `> 已满级 +${r.max}`,
        ].join('\n'),
      });
    },
  };

  /* ================= 世界 ================= */

  H['地图'] = {
    desc: '当前位置、出口与插画',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const cur = content.db.prepare('SELECT * FROM map WHERE id = ?').get(p.map_id);
      if (!cur) return msg.reply('位置数据缺失，请在面板检查地图表。');
      const exits = [];
      for (const [label, col] of [['北', 'north'], ['南', 'south'], ['东', 'east'], ['西', 'west']]) {
        if (cur[col]) {
          const t = content.db.prepare('SELECT name FROM map WHERE id = ?').get(cur[col]);
          exits.push(`${label}→${t?.name ?? cur[col]}`);
        }
      }
      const npcs = content.db.prepare('SELECT name FROM npc WHERE map_id = ? AND enabled = 1').all(cur.id);
      const mobs = battles.monstersAt(cur.id);

      // 图文同条：地图插画 + 地点信息，一条消息发完
      const text = [
        `【${cur.name}】`,
        cur.desc || '',
        exits.length ? `出口：${exits.join(' · ')}` : '出口：无',
        npcs.length ? `NPC：${npcs.map((n) => n.name).join('、')}` : '',
        mobs.length ? `魂兽：${mobs.map((m) => m.name).join('、')}` : '',
        `\n${pfx()}移动 北　${pfx()}魂兽`,
      ]
        .filter(Boolean)
        .join('\n');
      if (await media.send(msg, { image: cur.image, text })) return;

      await msg.replyMarkdown({
        content: [
          `## ${mdEscape(cur.name)}`,
          `> ${mdEscape(cur.desc || '（无描述）')}`,
          '',
          exits.length ? `**出口** ${exits.join(' · ')}` : '**出口** 无',
          npcs.length ? `**NPC** ${npcs.map((n) => mdEscape(n.name)).join('、')}` : '',
          mobs.length ? `**魂兽** ${mobs.map((m) => mdEscape(m.name)).join('、')}` : '',
          '',
          '> `移动 北` · `魂兽`',
        ]
          .filter(Boolean)
          .join('\n'),
      });
    },
  };

  H['移动'] = {
    desc: '移动到相邻地图',
    usage: '移动 <北|南|东|西>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const dirMap = { 北: 'north', 南: 'south', 东: 'east', 西: 'west', 上: 'north', 下: 'south', 左: 'west', 右: 'east' };
      const key = dirMap[args[0]];
      if (!key) return msg.reply('方向只能是 北/南/东/西（或 上/下/左/右）。');
      const cur = content.db.prepare('SELECT * FROM map WHERE id = ?').get(p.map_id);
      const next = cur?.[key];
      if (!next) return msg.reply(`往${args[0]}走不通。\n> 发 \`地图\` 看出口`);
      const target = content.db.prepare('SELECT * FROM map WHERE id = ? AND enabled = 1').get(next);
      if (!target) return msg.reply('那个方向的地图还没开放。');
      /**
       * 战舰护航：激活战舰后可以无视地图等级门槛。
       *
       * 这是战舰唯一的实际价值——之前它只是个开关，开了什么也没发生。
       * 现代游戏里载具的作用就是「缩短距离 / 越过障碍」，
       * 放到文游里最贴切的就是「能直接开进高等级区」。
       */
      const ship = players.hasActiveEquip(p.openid, 'ship');
      if (Number(target.min_level) > Number(p.level) && !ship) {
        return msg.reply(
          `${mdEscape(target.name)} 需要 **Lv.${target.min_level}**，你现在 Lv.${p.level}。\n> 有战舰可以硬闯：\`${pfx()}战舰 激活\``,
        );
      }
      players.db.prepare('UPDATE player SET map_id = ?, last_seen = ? WHERE openid = ?').run(target.id, Date.now(), p.openid);
      await msg.replyMarkdown({
        content: [
          `## ${mdEscape(target.name)}`,
          ship && Number(target.min_level) > Number(p.level) ? '> **战舰护航** · 已越过等级门槛（进去小心）' : '',
          `> ${mdEscape(target.desc || '（无描述）')}`,
          '',
          `> 发 \`${pfx()}魂兽\` 看看有什么`,
        ]
          .filter(Boolean)
          .join('\n'),
      });
    },
  };

  H['传送'] = {
    desc: '传送到去过的地图',
    usage: '传送 <地图名>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      if (!name) {
        const rows = content.db.prepare('SELECT name FROM map WHERE enabled = 1 AND portal = 1 ORDER BY id').all();
        return msg.reply(['用法：`传送 诺丁城`', rows.length ? `可传送：${rows.map((r) => r.name).join(' / ')}` : '还没有开放传送点'].join('\n'));
      }
      const target = content.db.prepare('SELECT * FROM map WHERE name = ? AND enabled = 1').get(name);
      if (!target) return msg.reply(`没有叫「${name}」的地图。`);
      if (!target.portal) return msg.reply(`**${name}** 没有传送阵，只能走过去。`);
      if (Number(target.min_level) > Number(p.level)) return msg.reply(`**${name}** 需要 Lv.${target.min_level}。`);
      players.db.prepare('UPDATE player SET map_id = ?, last_seen = ? WHERE openid = ?').run(target.id, Date.now(), p.openid);
      await msg.replyMarkdown({ content: [`## 传送到 ${mdEscape(target.name)}`, `> ${mdEscape(target.desc || '')}`].join('\n') });
    },
  };

  /* ================= 任务 ================= */

  H['任务'] = {
    desc: '任务列表与进度',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const quests = content.db.prepare('SELECT * FROM quest WHERE enabled = 1 ORDER BY id').all();
      const mine = players.db.prepare('SELECT * FROM player_quest WHERE openid = ?').all(p.openid);
      const stateOf = new Map(mine.map((r) => [r.quest_id, r]));
      const rings = players.ringCount(p.openid);
      const lines = [];
      for (const q of quests) {
        const st = stateOf.get(q.id);
        const cond = safeJson(q.cond);
        const done = checkQuest(cond, p, rings);
        const tag = st?.state === 'claimed' ? '已领取' : st?.state === 'done' ? '**可领取**' : done ? '**可完成**' : st ? '进行中' : '未接受';
        lines.push(`- **${mdEscape(q.name)}** · ${tag}`);
        lines.push(`  ${mdEscape(q.desc)}`);
        if (cond.kill) {
          const kc = players.db
            .prepare('SELECT n FROM kill_count WHERE openid = ? AND monster_id = ?')
            .get(p.openid, cond.kill.monster_id);
          const mn = content.db.prepare('SELECT name FROM monster WHERE id = ?').get(cond.kill.monster_id);
          lines.push(`  进度 ${Math.min(Number(kc?.n ?? 0), cond.kill.count)}/${cond.kill.count} · 击杀 ${mdEscape(mn?.name ?? '')}`);
        }
        if (cond.ring) lines.push(`  进度 ${rings}/${cond.ring} 个魂环`);
      }
      await msg.replyMarkdown({
        content: ['## 任务', '> `接受任务 <名>` · `完成任务 <名>`', '', ...lines].join('\n'),
      });
    },
  };

  H['接受任务'] = {
    desc: '接受一个任务',
    usage: '接受任务 <任务名>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      if (!name) return msg.reply('用法：`接受任务 初入圣魂村`');
      const q = content.db.prepare('SELECT * FROM quest WHERE name = ? AND enabled = 1').get(name);
      if (!q) return msg.reply(`没有叫「${name}」的任务。\n> 发 \`任务\` 看列表`);
      const cur = players.db.prepare('SELECT * FROM player_quest WHERE openid = ? AND quest_id = ?').get(p.openid, q.id);
      if (cur) return msg.reply(`**${name}** 已经接过了。\n> 发 \`任务\` 看进度`);
      players.db
        .prepare('INSERT INTO player_quest (openid, quest_id, state, progress, updated_at) VALUES (?,?,?,0,?)')
        .run(p.openid, q.id, 'doing', Date.now());
      await msg.replyMarkdown({
        content: [`## 接受任务 · ${mdEscape(q.name)}`, `> ${mdEscape(q.desc)}`, '', '> 完成后发 `完成任务 ' + mdEscape(q.name) + '`'].join('\n'),
      });
    },
  };

  H['完成任务'] = {
    desc: '提交已完成的任务',
    usage: '完成任务 <任务名>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      if (!name) return msg.reply('用法：`完成任务 初入圣魂村`');
      const q = content.db.prepare('SELECT * FROM quest WHERE name = ? AND enabled = 1').get(name);
      if (!q) return msg.reply(`没有叫「${name}」的任务。`);
      const st = players.db.prepare('SELECT * FROM player_quest WHERE openid = ? AND quest_id = ?').get(p.openid, q.id);
      if (!st) return msg.reply(`你还没接受 **${name}**。\n> 发 \`接受任务 ${name}\``);
      if (st.state === 'claimed') return msg.reply(`**${name}** 的奖励已经领过了。`);

      const cond = safeJson(q.cond);
      const rings = players.ringCount(p.openid);
      if (!checkQuest(cond, p, rings)) {
        return msg.reply(`**${name}** 还没完成。\n> 发 \`任务\` 看进度`);
      }

      const reward = safeJson(q.reward);
      const gained = [];
      if (reward.gold) {
        players.addGold(p.openid, Number(reward.gold), `任务 ${q.name}`);
        gained.push(`魂币 +${reward.gold}`);
      }
      if (reward.exp) {
        const r = players.gainExp(p.openid, Number(reward.exp));
        gained.push(`经验 +${reward.exp}${r.leveled ? `（升级 Lv.${r.after.level}）` : ''}`);
      }
      for (const it of Array.isArray(reward.item) ? reward.item : []) {
        players.addItem(p.openid, Number(it.id), Number(it.qty ?? 1), `任务 ${q.name}`);
        const nm = content.db.prepare('SELECT name FROM item WHERE id = ?').get(Number(it.id));
        gained.push(`${nm?.name ?? '物品'} × ${it.qty ?? 1}`);
      }
      players.db.prepare('UPDATE player_quest SET state = ?, updated_at = ? WHERE openid = ? AND quest_id = ?')
        .run('claimed', Date.now(), p.openid, q.id);

      await msg.replyMarkdown({
        content: [`## 完成任务 · ${mdEscape(q.name)}`, '', ...gained.map((g) => `- ${g}`)].join('\n'),
      });
    },
  };

  /* ---------------- 任务条件判定 ---------------- */

  function safeJson(s) {
    try {
      return JSON.parse(s || '{}');
    } catch {
      return {};
    }
  }

  /** 解析成数组（签到奖励、赛季已领档位这类） */
  function safeJsonArr(s) {
    try {
      const v = JSON.parse(s || '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  function checkQuest(cond, p, rings) {
    if (!cond || typeof cond !== 'object') return false;
    if (cond.kill) {
      const kc = players.db
        .prepare('SELECT n FROM kill_count WHERE openid = ? AND monster_id = ?')
        .get(p.openid, cond.kill.monster_id);
      if (Number(kc?.n ?? 0) < Number(cond.kill.count ?? 0)) return false;
    }
    if (cond.ring && rings < Number(cond.ring)) return false;
    if (cond.level && Number(p.level) < Number(cond.level)) return false;
    // 收集物品：导入的任务里有这类条件，早期没实现，那些任务永远交不了
    if (Array.isArray(cond.items)) {
      for (const it of cond.items) {
        const row = players.db
          .prepare('SELECT qty FROM inventory WHERE openid = ? AND item_id = ?')
          .get(p.openid, Number(it.id));
        if (Number(row?.qty ?? 0) < Number(it.qty ?? 1)) return false;
      }
    }
    return true;
  }

  /**
   * 「你现在该做什么」。
   *
   * 现代游戏都有 next-goal 提示，因为文游最大的流失点是**玩家不知道下一步**——
   * 89 个指令摆在那，新玩家只会重复发「攻击」。
   * 这里按状态给一条最该做的事，不罗列菜单。
   */
  /**
   * 「你现在该做什么」。
   *
   * 返回 `{ text, cmd }` 而不是纯字符串：
   *   - text 里的命令是 **可点链接**（QQ 的 inlinecmd），玩家不用手打
   *   - cmd 给菜单用（菜单项自带点击行为，不需要再包一层 markdown）
   *
   * 现代游戏都有 next-goal 提示，因为文游最大的流失点是**玩家不知道下一步**——
   * 133 个指令摆在那，新玩家只会重复发「攻击」。
   */
  function nextHint(d) {
    const p = d.player;
    const c = cfg();
    const one = (cmd, label) => ({
      text: `${label} · ${clink(cmd)}`,
      cmd,
      desc: label,
      action: cmd.replace(pfx(), ''),
    });

    // 还没觉醒武魂：这是最优先的，没武魂连属性都算不出来
    if (!Number(p.wuhun_id)) return one(`${pfx()}武魂觉醒`, '还没觉醒武魂');

    if (p.status === 'dead') return one(`${pfx()}复活`, '你已经阵亡');
    if (battles.pendingRing(p.openid)) return one(`${pfx()}附加魂环`, '有魂环等着附加');

    const hpPct = Number(p.hp) / Math.max(1, Number(p.hp_max));
    if (hpPct < 0.4) return one(`${pfx()}休息`, `生命只剩 ${Math.round(hpPct * 100)}%`);

    // 有能交的任务，优先级最高
    const doing = players.db.prepare("SELECT quest_id FROM player_quest WHERE openid = ? AND state = 'doing'").all(p.openid);
    for (const row of doing) {
      const q = content.db.prepare('SELECT * FROM quest WHERE id = ?').get(row.quest_id);
      if (q && checkQuest(safeJson(q.cond), p, d.rings.length)) {
        return one(`${pfx()}完成任务 ${q.name}`, `任务「${mdEscape(q.name)}」可以交了`);
      }
    }

    // 卡在魂环墙
    const rings = d.rings.length;
    const cap = levelCap(rings, c);
    if (Number(p.level) >= cap && rings < Number(c.max_ring_slot ?? 10)) {
      return one(`${pfx()}打环`, `Lv.${p.level} 到顶了（${rings} 环上限 ${cap}），去打能掉环的魂兽`);
    }

    // 背包里有没用过的药
    const potion = d.inventory.find((i) => i.kind === 'consumable');
    if (potion && hpPct < 0.8) return one(`${pfx()}使用 ${potion.name}`, `背包有 **${mdEscape(potion.name)}**`);

    // 领地收益可以收了（宗门成员最容易忘的一件事）
    const g = guild.of(p.openid);
    if (g) {
      const rows = guild.db.prepare('SELECT map_id, last_mine_at FROM territory WHERE guild_id = ?').all(g.id);
      const ready = rows.some((t) => Date.now() - Number(t.last_mine_at || 0) >= 3600_000);
      if (ready) return one(`${pfx()}收工`, '领地有收益可以收');
      const wars = guild.myWars(p.openid);
      const soon = wars.find((w) => w.expires_at - Date.now() < 2 * 3600_000);
      if (soon) return one(`${pfx()}抢夺`, `对 ${mdEscape(soon.targetName)} 的宣战快过期了`);
    }

    // 没接任务
    const anyQuest = players.db.prepare('SELECT COUNT(*) n FROM player_quest WHERE openid = ?').get(p.openid).n;
    if (!anyQuest) {
      const npc = content.db.prepare('SELECT name FROM npc WHERE map_id = ? AND enabled = 1').get(p.map_id);
      if (npc) return one(`${pfx()}对话 ${npc.name}`, '还没接任务');
    }

    return one(`${pfx()}斗魂`, '去打更老的魂兽，或者找人打一场');
  }


  /* ================= v24：对齐原版控制台的指令面 ================= */

  /* ---------------- 组队（原版 7 条队伍指令） ---------------- */

  H['创建队伍'] = {
    desc: '创建队伍（组队打怪经验更高）',
    usage: '创建队伍 [名字]',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.replyMarkdown({ content: `你还没有角色，先 ${clink(pfx() + '创建账号')}` });
      const r = extra.teamCreate(msg.userId, args.join(' ').trim());
      if (r.error === 'in_team') return msg.reply(`你已经在队伍里了。\n> 发 \`${pfx()}我的队伍\` 看看`);
      if (r.error) return msg.reply('建队失败，稍后再试。');
      await msg.replyMarkdown({
        content: [
          '## 队伍已创建',
          `> **${mdEscape(r.team.name)}** · 你是队长`,
          '',
          `> 邀请队友：\`${pfx()}邀请组队 <昵称>\``,
          '> 队友越多经验越高（每人 +15%，最多 4 人）',
        ].join('\n'),
      });
    },
  };

  H['我的队伍'] = {
    desc: '查看队伍与待处理邀请',
    async run(msg) {
      const t = extra.teamOf(msg.userId);
      const inv = players.db
        .prepare(
          "SELECT ti.*, p.name AS fromName FROM team_invite ti LEFT JOIN player p ON p.openid = ti.from_openid WHERE ti.to_openid = ? AND ti.status = 'pending' ORDER BY ti.id DESC",
        )
        .all(msg.userId);
      const lines = [];
      if (t) {
        lines.push(`## ${mdEscape(t.name)}`, `> ${t.members.length}/4 人 · 队长 ${mdEscape(t.members.find((m) => m.leader)?.name ?? '？')}`, '');
        for (const m of t.members) {
          lines.push(`- ${m.leader ? '👑 ' : ''}**${mdEscape(m.name ?? '？')}** Lv.${m.level} · 生命 ${m.hp}/${m.hp_max}`);
        }
        lines.push('', `> \`${pfx()}邀请组队 <昵称>\` · \`${pfx()}队伍离开\``);
        if (t.isLeader) lines.push(`> \`${pfx()}踢出队员 <昵称>\``);
      } else {
        lines.push('## 你还没有队伍', `> \`${pfx()}创建队伍\` 建一个`);
      }
      if (inv.length) {
        lines.push('', '**待处理邀请**');
        for (const i of inv) lines.push(`- ${mdEscape(i.fromName ?? '？')} 邀请你 · \`${pfx()}加入队伍 ${mdEscape(i.fromName ?? '')}\``);
      }
      await msg.replyMarkdown({ content: lines.join('\n') });
    },
  };

  H['邀请组队'] = {
    desc: '邀请某人加入你的队伍（队长）',
    usage: '邀请组队 <昵称>',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const name = args.join(' ').trim();
      if (!name) return msg.reply(`用法：\`${pfx()}邀请组队 唐三\``);
      const r = extra.teamInvite(msg.userId, name);
      if (r.error === 'no_team') return msg.reply(`你还没有队伍。\n> \`${pfx()}创建队伍\` 建一个`);
      if (r.error === 'not_leader') return msg.reply('只有队长能邀请。');
      if (r.error === 'not_found') return msg.reply(`没有叫「${name}」的玩家。`);
      if (r.error === 'ambiguous') return msg.reply(`有 ${r.count} 个玩家叫「${name}」。`);
      if (r.error === 'target_in_team') return msg.reply(`**${name}** 已经在别的队伍里了。`);
      if (r.error === 'full') return msg.reply(`队伍满了（最多 ${r.max} 人）。`);
      if (r.error === 'pending') return msg.reply('已经邀请过了，等对方答应。');
      await msg.replyMarkdown({
        content: ['## 已邀请', `> **${mdEscape(r.target.name)}** → \`${pfx()}加入队伍 ${mdEscape(r.target.name)}\``].join('\n'),
      });
    },
  };

  H['加入队伍'] = {
    desc: '接受队伍邀请',
    usage: '加入队伍 [邀请人昵称]',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const r = extra.teamAccept(msg.userId, args.join(' ').trim());
      if (r.error === 'in_team') return msg.reply('你已经在队伍里了。');
      if (r.error === 'no_invite') return msg.reply('没有待处理的邀请。');
      if (r.error === 'no_invite_from') return msg.reply(`没有来自「${r.name}」的邀请。`);
      if (r.error === 'team_gone') return msg.reply('那个队伍已经解散了。');
      if (r.error === 'full') return msg.reply(`队伍满了（最多 ${r.max} 人）。`);
      if (r.error) return msg.reply('加入失败，稍后再试。');
      await msg.replyMarkdown({
        content: ['## 已加入队伍', `> **${mdEscape(r.team.name)}** · ${r.team.members.length}/4 人`, '', '> 组队打怪每人 +15% 经验'].join('\n'),
      });
    },
  };

  H['队伍离开'] = {
    desc: '退出队伍（队长退出会自动转让）',
    async run(msg) {
      const r = extra.teamLeave(msg.userId);
      if (r.error === 'no_team') return msg.reply('你不在任何队伍里。');
      await msg.replyMarkdown({ content: r.disbanded ? '## 队伍已解散\n> 你是最后一个人' : '## 已退出队伍' });
    },
  };

  H['踢出队员'] = {
    desc: '把某人踢出队伍（队长）',
    usage: '踢出队员 <昵称>',
    async run(msg, args) {
      const name = args.join(' ').trim();
      if (!name) return msg.reply(`用法：\`${pfx()}踢出队员 唐三\``);
      const r = extra.teamKick(msg.userId, name);
      if (r.error === 'no_team') return msg.reply('你不在队伍里。');
      if (r.error === 'not_leader') return msg.reply('只有队长能踢人。');
      if (r.error === 'self') return msg.reply(`要退队请发 \`${pfx()}队伍离开\`。`);
      if (r.error === 'not_member') return msg.reply(`**${name}** 不在你的队伍里。`);
      if (r.error === 'not_found') return msg.reply(`没有叫「${name}」的玩家。`);
      if (r.error) return msg.reply('操作失败。');
      await msg.replyMarkdown({ content: `## 已踢出\n> **${mdEscape(r.target.name)}** 离开了队伍` });
    },
  };

  /* ---------------- 钓鱼 / 采集（原版「地图设置-钓鱼」） ---------------- */

  H['钓鱼'] = {
    desc: '在当前地图钓鱼',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const pts = extra.points(msg.userId).filter((x) => x.kind === 'fish');
      if (!pts.length) {
        const mapName = content.db.prepare('SELECT name FROM map WHERE id = ?').get(p.map_id)?.name ?? '这里';
        return msg.reply(`**${mdEscape(mapName)}** 没有钓点。\n> 换个有水的地图试试`);
      }
      const r = extra.gather(msg.userId, 'fish');
      if (r.error === 'in_battle') return msg.reply('战斗中不能钓鱼。');
      if (r.error === 'cooldown') return msg.reply(`刚钓过，还要等 **${r.left}** 秒。`);
      if (r.error === 'level_low') return msg.reply(`这个钓点需要 Lv.${r.need}。`);
      if (r.error === 'no_bait') return msg.reply(`没有鱼饵。\n> 去商城买 \`鱼饵\``);
      if (r.error) return msg.reply('钓不上来，换个时间再试。');
      await msg.replyMarkdown({
        content: ['## 钓鱼', `> ${mdEscape(r.point.name)}`, '', `**钓到** ${mdEscape(r.point.itemName)} × ${r.qty}`].join('\n'),
      });
    },
  };

  H['采集'] = {
    desc: '在当前地图采集材料',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const pts = extra.points(msg.userId).filter((x) => x.kind === 'gather');
      if (!pts.length) return msg.reply('这里没有可采集的东西。');
      const r = extra.gather(msg.userId, 'gather');
      if (r.error === 'cooldown') return msg.reply(`刚采过，还要等 **${r.left}** 秒。`);
      if (r.error) return msg.reply('采不到，换个时间再试。');
      await msg.replyMarkdown({
        content: ['## 采集', `> ${mdEscape(r.point.name)}`, '', `**采到** ${mdEscape(r.point.itemName)} × ${r.qty}`].join('\n'),
      });
    },
  };

  /* ---------------- 武魂融合（原版「武魂融合列表.ini」25 组） ---------------- */

  H['融合列表'] = {
    desc: '看所有武魂融合组合',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const list = extra.fusionList(msg.userId);
      if (!list.length) return msg.reply('还没有配置武魂融合。');
      const lines = list.slice(0, 14).map((f) => {
        const mark = f.done ? '✓ 已融合' : f.ready ? '**可融合**' : '';
        return `- **${mdEscape(f.name)}** · ${mdEscape(f.aName)} + ${mdEscape(f.bName)}${f.skillName ? ` → ${mdEscape(f.skillName)}` : ''} ${mark}`;
      });
      await msg.replyMarkdown({
        content: [
          `## 武魂融合（${list.filter((f) => f.ready && !f.done).length} 组可融）`,
          ...lines,
          list.length > 14 ? `> 还有 ${list.length - 14} 组…` : '',
          '',
          `> 需要同时拥有两侧武魂（主武魂 + \`${pfx()}副武魂\`）`,
          `> \`${pfx()}武魂融合 <名字>\` 执行`,
        ]
          .filter(Boolean)
          .join('\n'),
      });
    },
  };

  H['武魂融合'] = {
    desc: '执行武魂融合',
    usage: '武魂融合 [融合名]',
    async run(msg, args) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const r = extra.fuse(msg.userId, args.join(' ').trim());
      if (r.error === 'no_fusion') return msg.reply(`没有这个融合组合。\n> \`${pfx()}融合列表\` 看全部`);
      if (r.error === 'not_ready') {
        return msg.reply(
          [`**${r.name}** 需要同时拥有：`, ...r.need.map((n) => `- ${mdEscape(n)}`), '', `> \`${pfx()}副武魂 <名字>\` 可以设副武魂`].join('\n'),
        );
      }
      if (r.error === 'already') return msg.reply(`**${r.name}** 已经融合过了。`);
      if (r.error) return msg.reply('融合失败。');
      const f = r.fusion;
      await msg.replyMarkdown({
        content: [
          `## 融合成功 · ${mdEscape(f.name)}`,
          `> ${mdEscape(f.aName)} + ${mdEscape(f.bName)}`,
          '',
          f.skillName ? `**融合魂技** ${mdEscape(f.skillName)}（已放进快捷槽）` : '',
          f.buff ? `**融合 BUFF** ${mdEscape(f.buff)}` : '',
          ...r.bonus.map(([k, v]) => `- ${k} +${v}`),
        ]
          .filter(Boolean)
          .join('\n'),
      });
    },
  };

  /* ---------------- 武魂进化（原版「武魂进化列表.ini」48 条） ---------------- */

  H['武魂进化'] = {
    desc: '查看/执行武魂进化',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const info = extra.evolveInfo(msg.userId);
      if (!info) return msg.reply('你还没有武魂。');
      if (!info.target) {
        return msg.reply(`**${mdEscape(info.wuhun.name)}** 没有可进化的形态。\n> 换一个武魂试试 \`${pfx()}武魂觉醒\``);
      }
      const lines = [
        `## ${mdEscape(info.wuhun.name)} → ${mdEscape(info.target.name)}`,
        `> 需要 Lv.${info.needLevel}${info.needItem ? ` · 需要 ${mdEscape(info.needItem)} × 1（你有 ${info.have}）` : ''}`,
        '',
        '**进化后属性**',
        `> 生命 ${info.target.hp} · 魂力 ${info.target.mp} · 攻击 ${info.target.atk}`,
        `> 防御 ${info.target.def} · 速度 ${info.target.spd}`,
      ];
      if (info.canEvolve) {
        const r = extra.evolve(msg.userId);
        if (r.ok) {
          lines.push('', '## 进化成功', `> **${mdEscape(r.from)}** → **${mdEscape(r.to)}**`, `> 攻击 ${r.player.atk} · 防御 ${r.player.def} · 生命 ${r.player.hp_max}`);
          return msg.replyMarkdown({ content: lines.join('\n') });
        }
      }
      const why = Number(p.level) < info.needLevel ? `等级不够（要 Lv.${info.needLevel}）` : '缺少进化材料';
      lines.push('', `> 还不能进化：${why}`);
      await msg.replyMarkdown({ content: lines.join('\n') });
    },
  };

  /* ---------------- 快捷指令（原版 4 条 + 快捷指令.ini） ---------------- */

  H['快捷'] = {
    desc: '查看/执行快捷指令',
    usage: '快捷 [槽位]',
    async run(msg, args) {
      const slot = Number(args[0]) || 0;
      if (slot) {
        const cmd = extra.quickResolve(msg.userId, slot);
        if (!cmd) return msg.reply(`槽位 ${slot} 是空的。\n> \`${pfx()}设置快捷 ${slot} 魂兽\``);
        return msg.reply(`槽位 ${slot} → \`${cmd}\`\n> 直接发 \`${pfx()}${cmd}\` 就行`);
      }
      const list = extra.quickList(msg.userId);
      if (!list.length) {
        return msg.reply(
          ['## 快捷指令', '> 还没设置。', '', `\`${pfx()}设置快捷 1 魂兽\` 之后，发 \`${pfx()}快捷 1\` 就能看到它`].join('\n'),
        );
      }
      await msg.replyMarkdown({
        content: ['## 快捷指令', ...list.map((r) => `- \`${r.slot}\` → **${mdEscape(r.cmd)}**`), '', `> \`${pfx()}删除快捷 <槽>\` · \`${pfx()}清空快捷\``].join('\n'),
      });
    },
  };

  H['设置快捷'] = {
    desc: '把一个指令存进快捷槽',
    usage: '设置快捷 <槽位> <指令>',
    async run(msg, args) {
      const slot = Number(args[0]) || 0;
      const cmd = args.slice(1).join(' ').trim();
      if (!slot || !cmd) return msg.reply(`用法：\`${pfx()}设置快捷 1 魂兽\``);
      const r = extra.quickSet(msg.userId, slot, cmd.replace(pfx(), ''));
      if (r.error) return msg.reply('设置失败，槽位 1–20。');
      await msg.replyMarkdown({ content: `## 已设置\n> 槽 ${r.slot} → \`${mdEscape(r.cmd)}\`\n\n> 发 \`${pfx()}快捷 ${r.slot}\` 查看` });
    },
  };

  H['删除快捷'] = {
    desc: '删除一个快捷槽',
    usage: '删除快捷 <槽位>',
    async run(msg, args) {
      const r = extra.quickDel(msg.userId, args[0]);
      if (r.error === 'not_found') return msg.reply(`槽位 ${r.slot} 本来就是空的。`);
      if (r.error) return msg.reply(`用法：\`${pfx()}删除快捷 1\``);
      await msg.replyMarkdown({ content: `## 已删除\n> 槽 ${r.slot}` });
    },
  };

  H['清空快捷'] = {
    desc: '清空所有快捷槽',
    async run(msg) {
      const r = extra.quickClear(msg.userId);
      await msg.replyMarkdown({ content: `## 已清空\n> 删掉 ${r.n} 条` });
    },
  };

  /* ---------------- 斗铠领域（原版「斗铠领域列表.ini」43 个） ---------------- */

  H['领域列表'] = {
    desc: '查看可觉醒的斗铠领域',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const list = extra.domainList(msg.userId);
      if (!list.length) return msg.reply('还没有配置领域。');
      const active = extra.activeDomain(msg.userId);
      const lines = list.slice(0, 12).map((d) => {
        const tag = active?.id === d.id ? '**已开启**' : d.opened ? '已觉醒' : '';
        return `- **${mdEscape(d.name)}**${d.status_key ? ` · ${mdEscape(d.status_key)}` : ''} ${tag}`;
      });
      await msg.replyMarkdown({
        content: [
          `## 斗铠领域（${list.filter((d) => d.opened).length} 个已觉醒）`,
          ...lines,
          list.length > 12 ? `> 还有 ${list.length - 12} 个…` : '',
          '',
          `> \`${pfx()}觉醒领域 <名字>\` 需要穿戴领域型斗铠`,
          `> \`${pfx()}开启领域 <名字>\` · 同一时间只能开一个`,
        ]
          .filter(Boolean)
          .join('\n'),
      });
    },
  };

  H['觉醒领域'] = {
    desc: '觉醒一个斗铠领域',
    usage: '觉醒领域 <名字>',
    async run(msg, args) {
      const name = args.join(' ').trim();
      if (!name) return msg.reply(`用法：\`${pfx()}觉醒领域 冰皇域\``);
      const r = extra.domainAwaken(msg.userId, name);
      if (r.error === 'no_domain') return msg.reply(`没有叫「${name}」的领域。\n> \`${pfx()}领域列表\` 看全部`);
      if (r.error === 'no_armor') return msg.reply(`要先穿戴一件领域型斗铠（\`${pfx()}我的装备\` 里带「领域」的那件）。`);
      if (r.error === 'no_gold') return msg.reply(`觉醒要 **${r.need}** 魂币，你只有 ${r.have}。`);
      if (r.error) return msg.reply('觉醒失败。');
      await msg.replyMarkdown({
        content: ['## 领域觉醒', `> **${mdEscape(r.domain.name)}**`, '', `> \`${pfx()}开启领域 ${mdEscape(r.domain.name)}\` 生效`].join('\n'),
      });
    },
  };

  H['开启领域'] = {
    desc: '开启一个已觉醒的领域',
    usage: '开启领域 [名字]',
    async run(msg, args) {
      const r = extra.domainToggle(msg.userId, true, args.join(' ').trim());
      if (r.error === 'not_awakened') return msg.reply(`**${r.name}** 还没觉醒。\n> \`${pfx()}觉醒领域 ${r.name}\``);
      if (r.error === 'no_domain') return msg.reply(`还没有觉醒任何领域。\n> \`${pfx()}领域列表\` 看能觉醒哪些`);
      if (r.error) return msg.reply('开启失败。');
      await msg.replyMarkdown({
        content: [`## 领域已开启`, `> **${mdEscape(r.domain.name)}**`, '', '> 战斗开始时会自动获得它的附加状态'].join('\n'),
      });
    },
  };

  H['关闭领域'] = {
    desc: '关闭当前领域',
    async run(msg) {
      const r = extra.domainToggle(msg.userId, false);
      await msg.replyMarkdown({ content: r.closed ? '## 领域已关闭' : '> 你本来就没开领域。' });
    },
  };

  /* ---------------- 职业等级（原版「职业等级.ini」7 职业 × 10 级） ---------------- */

  H['职业等级'] = {
    desc: '查看职业等级与经验',
    async run(msg) {
      const p = players.get(msg.userId);
      if (!p) return msg.reply('你还没有角色。');
      const info = extra.professionInfo(msg.userId);
      if (!info) return msg.reply('你还没有角色。');
      if (info.none) return msg.reply(`你还没有职业。\n> \`${pfx()}职业列表\` 挑一个，\`${pfx()}转职 <职业>\``);
      const lines = [
        `## ${mdEscape(info.name)} · Lv.${info.level}`,
        info.max ? '> 已经满级' : `> 经验 ${info.exp} / ${info.need}（${Math.round((info.exp / Math.max(1, info.need)) * 100)}%）`,
        '',
        '> 制作 / 炼丹会给职业经验',
      ];
      if (info.max) lines.push('> 满级后制作产出会更好');
      await msg.replyMarkdown({ content: lines.join('\n') });
    },
  };

  /* ---------------- 机甲聚能（原版「机甲列表」总能量值 + 聚能概率） ---------------- */

  H['充能'] = {
    desc: '给机甲充能',
    async run(msg) {
      const r = extra.mechaCharge(msg.userId);
      if (r.error === 'no_mecha') return msg.reply(`你没穿机甲。\n> \`${pfx()}我的装备\` 看看`);
      if (r.error === 'full') return msg.reply(`能量已经满了（${r.max}）。`);
      if (r.error === 'no_gold') return msg.reply(`充能要 **${r.need}** 魂币，你只有 ${r.have}。`);
      if (r.error) return msg.reply('充能失败。');
      await msg.replyMarkdown({
        content: ['## 充能完成', `> 能量 +${r.gain}（${r.energy}/${r.max}）`, `> 花费 ${r.cost} 魂币`].join('\n'),
      });
    },
  };

  H['聚能'] = {
    desc: '机甲聚能状态',
    async run(msg) {
      const info = extra.mechaInfo(msg.userId);
      if (!info?.mecha) return msg.reply(`你没穿机甲。\n> \`${pfx()}我的装备\` 看看`);
      const pct = Math.round((info.energy / Math.max(1, info.max)) * 100);
      const filled = Math.round(pct / 10);
      await msg.replyMarkdown({
        content: [
          '## 机甲聚能',
          `> **${mdEscape(info.mecha.name)}** · 能量 ${info.energy}/${info.max}（${pct}%）`,
          `> ${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}`,
          '',
          pct >= 50 ? '> 能量充足，战斗中会触发聚能攻击' : `> \`${pfx()}充能\` 补能量`,
        ].join('\n'),
      });
    },
  };

  /* ---------------- 魂导器封印（原版 封印/解封/解封列表） ---------------- */

  H['封印'] = {
    desc: '封印一件魂导器（省背包位）',
    usage: '封印 <装备名>',
    async run(msg, args) {
      const name = args.join(' ').trim();
      if (!name) return msg.reply(`用法：\`${pfx()}封印 魂导器名\``);
      const r = extra.seal(msg.userId, name);
      if (r.error === 'no_equip') return msg.reply(`没有「${name}」。`);
      if (r.error === 'equipped') return msg.reply('先卸下才能封印。');
      if (r.error === 'already') return msg.reply(`**${r.name}** 已经封印了。`);
      if (r.error) return msg.reply('封印失败。');
      await msg.replyMarkdown({ content: `## 已封印\n> **${mdEscape(r.name)}**\n\n> \`${pfx()}解封 ${mdEscape(r.name)}\` 恢复` });
    },
  };

  H['解封'] = {
    desc: '解封魂导器',
    usage: '解封 <装备名>',
    async run(msg, args) {
      const name = args.join(' ').trim();
      if (!name) {
        const list = extra.sealedList(msg.userId);
        if (!list.length) return msg.reply('没有封印中的东西。');
        return msg.reply(`用法：\`${pfx()}解封 <名字>\`\n> 封印中：${list.map((e) => e.name).join(' / ')}`);
      }
      const r = extra.unseal(msg.userId, name);
      if (r.error === 'no_equip') return msg.reply(`没有「${name}」。`);
      if (r.error === 'not_sealed') return msg.reply(`**${r.name}** 没被封印。`);
      if (r.error === 'no_gold') return msg.reply(`解封要 **${r.need}** 魂币，你只有 ${r.have}。`);
      if (r.error) return msg.reply('解封失败。');
      await msg.replyMarkdown({ content: `## 已解封\n> **${mdEscape(r.name)}** · 花费 ${r.cost} 魂币` });
    },
  };

  return H;
}

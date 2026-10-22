/**
 * 养鲲 v3.0
 * ==========
 *
 * ── 致敬原作者 ──────────────────────────────────────────────
 *
 * 这个插件的**玩法设计**来自 Agam 的《简单的养鲲游戏》
 * （CQP 插件 me.cqp.Agam.kun，版本 1.19.9.4.1，2020 年）。
 *
 * 「开局一条鲲，进化全靠吞」、节操 / 体重 / 砸蛋 / 磨炼 / 幻化 /
 * 拍卖行 / 单挑群主 / 抽群主一个大嘴巴 —— 这些都不是我们想出来的，
 * 是 Agam 八年前就设计好的。数值（25% 致命一击、75% 狗带、
 * 喂食最多 100 颗蛋……）也是从他的源码里读出来的，不是我们调的。
 *
 * 原版是易语言编译的二进制（.e），无法直接复用代码，
 * 所以这里是**按原版规则重写的 JS 实现**，不是搬运。
 * 如果原作者认为有不妥，请联系删除。
 *
 * ────────────────────────────────────────────────────────
 *
 * 玩法概览：
 *   养成：签到 / 买蛋 / 砸蛋 / 孵化 / 喂食 / 喝鸡汤 / 磨炼 / 幻化
 *   对抗：吞噬 / 单挑群主 / 攻击 BOSS / 渡劫
 *   交易：拍卖行（出售 / 出价 / 成交 / 下架）
 *   生存：阵亡 / 复活 / 放生
 *
 * 数据：user:<openid> 存玩家，__boss / __auction 存全局状态。
 * 所有写操作走 ctx.storage.update，保证并发不丢。
 */

/** 品种池：稀有度决定孵化权重和成长系数 */
const SPECIES = {
  普通: { weight: 60, grow: 1.0, list: ['尘鲲', '土鲲', '沙鲲', '石鲲', '岩鲲', '菜虚鲲', '胖头鲲'] },
  稀有: { weight: 28, grow: 1.15, list: ['碧鲲', '蓝鲲', '橙鲲', '雪鲲', '虹鲲', '阳鲲', '靓鲲'] },
  史诗: {
    weight: 10,
    grow: 1.35,
    list: ['炎鲲', '冰鲲', '雷鲲', '铁头鲲', '钢背鲲', '剑鲲', '齿鲲', '铠鲲', '烈鲲', '阴鲲'],
  },
  传说: {
    weight: 2,
    grow: 1.6,
    list: [
      '帝鲲', '圣鲲', '灵鲲', '冥鲲', '玄鲲', '魔鲲', '鬼鲲', '妖鲲', '幻鲲', '诡鲲',
      '尸鲲', '血鲲', '骨鲲', '腐鲲', '毒鲲', '凶鲲', '恶鲲', '黑鲲', '暗鲲', '炫鲲',
    ],
  },
};

/** 每个品种一个颜文字，按稀有度定风格 */
const FACE = {
  尘鲲: '(´･ω･`)', 土鲲: '(￣▽￣)', 沙鲲: '(・_・)', 石鲲: '(￣.￣)',
  岩鲲: '(￣ー￣)', 菜虚鲲: '(；一_一)', 胖头鲲: '(´～`)',
  碧鲲: '(◕‿◕)', 蓝鲲: '(＾▽＾)', 橙鲲: '(￣ω￣)', 雪鲲: '(*´∀`)',
  虹鲲: '(✧∀✧)', 阳鲲: '(๑•̀ㅂ•́)', 靓鲲: '(≧▽≦)',
  炎鲲: '(╬￣皿￣)', 冰鲲: '(￣ω￣;)', 雷鲲: '(｀Д´)', 铁头鲲: '(￣^￣)',
  钢背鲲: '(╯°□°)╯', 剑鲲: '(￣ヘ￣)', 齿鲲: '(ᗒᗨᗕ)', 铠鲲: '(๑•̀ㅁ•́๑)',
  烈鲲: '(｀∀´)', 阴鲲: '(￣ー￣;)',
  帝鲲: '(｀・ω・´)', 圣鲲: '(✿◠‿◠)', 灵鲲: '(・∀・)', 冥鲲: '(x_x)',
  玄鲲: '(¯﹃¯)', 魔鲲: '(▼皿▼)', 鬼鲲: '(((ﾟДﾟ)))', 妖鲲: '(￣▽￣)~*',
  幻鲲: '(๑¯ω¯๑)', 诡鲲: '(・_・;)', 尸鲲: '(✖╭╮✖)', 血鲲: '(╬☉д⊙)',
  骨鲲: '(☠д☠)', 腐鲲: '(x_x;)', 毒鲲: '(๑•́ ₃ •̀๑)', 凶鲲: '(╬ Ò﹏Ó)',
  恶鲲: '(▼_▼)', 黑鲲: '(￣ω￣)', 暗鲲: '(・-・)', 炫鲲: '(✧ω✧)',
};

function faceOf(species, rarity) {
  if (FACE[species]) return FACE[species];
  return { 普通: '(・_・)', 稀有: '(◕‿◕)', 史诗: '(￣ヘ￣)', 传说: '(๑¯ω¯๑)' }[rarity] || '(・_・)';
}

/** 属性：悲 是负面属性，无法幻化、无法复活 */
const ATTRS = ['智', '力', '速', '韧'];
const BAD_ATTR = '悲';

const COST = { 蛋: 80, 磨炼: 30, 幻化丹: 200 };
const TRAIN_PER_DAY = 30;
const MIN_WEIGHT = 0.5;

function rollSpecies() {
  const pool = [];
  for (const [rarity, def] of Object.entries(SPECIES)) {
    for (let i = 0; i < def.weight; i++) {
      for (const name of def.list) pool.push({ name, rarity });
    }
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

const growOf = (rarity) => SPECIES[rarity]?.grow ?? 1;
const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const hasKun = (p) => Boolean(p.species && p.species !== '未孵化');

/** 今日运势：同一天同一人结果固定 */
function fortuneOf(userId, dk) {
  let h = 0;
  const s = `${userId}:${dk}`;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return [
    { name: '大凶', mul: 0.5, tip: '今天别吞噬，会亏。' },
    { name: '小凶', mul: 0.8, tip: '适合窝着喂食。' },
    { name: '平', mul: 1.0, tip: '平常心，日常操作。' },
    { name: '小吉', mul: 1.2, tip: '运气不错，可以试试吞噬。' },
    { name: '大吉', mul: 1.5, tip: '冲！今天吞噬有加成。' },
  ][h % 5];
}

/** 运势事件：原版里的中蛋 / 狗屎 / 群主祝福 */
function rollLuckEvent() {
  const r = Math.random();
  if (r < 0.1) return '你受到了英俊潇洒器宇不凡的群主的祝福！运势+10';
  if (r < 0.2) return '你却不小心摔在了一坨狗屎上！运势-5';
  if (r < 0.35) return '你中蛋了！运势-2';
  if (r < 0.45) return '你捡到一枚闪闪发亮的小石子，运势+5';
  if (r < 0.5) return '你在路边摊吃了碗五块钱的牛肉面，意外地很香。运势+3';
  return null;
}

/* ------------------------------------------------------------------ */
/* 文案池                                                              */
/* ------------------------------------------------------------------ */

/**
 * 同一个动作多准备几句，随机挑一句。
 * 不是为了信息量，是为了让老玩家第 100 次喂食时还愿意看一眼。
 */
const LINES = {
  // 孵化：按稀有度分语气，普通平平无奇，传说得有点排面
  孵化普通: [
    '蛋壳裂开，{name}探出个脑袋，看起来普普通通。',
    '{name}破壳而出，打了个哈欠。就这？',
    '一只{name}滚了出来，在地上弹了两下。',
    '蛋壳碎了一地，{name}蹲在中间，眼神空洞。',
  ],
  孵化稀有: [
    '{name}破壳的瞬间，壳上泛起了淡淡的光。',
    '蛋壳裂开，{name}抖了抖身上的碎壳，挺精神。',
    '这只{name}一出来就四处张望，不像凡物。',
  ],
  孵化史诗: [
    '蛋壳炸开！{name}带着一股气势登场。',
    '整个房间震了一下，{name}从碎壳里站起来。',
    '{name}破壳的动静有点大，隔壁的鲲都探头了。',
  ],
  传说: [
    '天边压过一片阴影——{name}降世了。',
    '蛋壳还没落地就被气浪掀飞，{name}缓缓睁眼。',
    '你听见远处有钟声。{name}出现了。',
    '这只{name}一出壳，方圆十里的鲲都安静了。',
  ],

  吞噬胜: [
    '你的【{me}】张开嘴，对方的【{other}】连喊停的机会都没有。',
    '一口下去，干净利落。对方的【{other}】只剩个影子。',
    '【{me}】打了个饱嗝。{other} 那边已经没人说话了。',
    '这不是吞噬，这是单方面的物理消灭。',
  ],
  吞噬负: [
    '你的【{me}】被对方的【{other}】反杀了，场面一度十分尴尬。',
    '【{me}】冲上去，然后被弹了回来。',
    '有仇不报非君子啊。',
    '你听见自己的鲲发出了不体面的声音。',
  ],

  渡劫成: [
    '雷光散去，{name}不但没死，还胖了一圈。',
    '渡劫成功！{name}在电闪雷鸣中完成了蜕变。',
    '天雷劈下来，{name}张嘴接了。',
  ],
  渡劫败: [
    '雷劈偏了，正中{name}。体重暴跌。',
    '渡劫失败。{name}现在只剩一口气和一身焦味。',
    '你听见一声脆响——那是{name}的自尊心。',
  ],

  放生: [
    '你把{name}放回了水里。它头也不回地游走了。',
    '{name}被放生。走之前回头看了你一眼，眼神复杂。',
    '放生完成。水面上浮起一串泡泡，算是告别。',
  ],
  复活: [
    '{name}睁开眼睛，第一句话是「饿」。',
    '一粒复活药下去，{name}诈尸般地坐了起来。',
    '{name}活过来了，虽然看起来还有点懵。',
  ],

  喂食: [
    '你端来一盆饲料，{name}吃得很投入。',
    '{name}埋头猛吃，尾巴摇得像个风扇。',
    '这顿吃得不错，{name}满意地打了个嗝。',
    '你喂了一勺，{name}吞了三口。',
  ],
  磨炼: [
    '{name}绕着场地跑了十圈，气喘吁吁但精神了不少。',
    '你陪着{name}练了一会儿，它好像胖了点。',
    '{name}对着石头撞了半天，居然真变强了。',
  ],

  砸蛋出神器: ['恭喜你砸出了上古神器！这运气，建议去买彩票。', '金光一闪——上古神器！'],
  砸蛋普通: ['蛋壳里滚出一样东西：{item}。', '砸开了，是{item}，聊胜于无。'],
  砸蛋空: ['蛋壳里什么都没有，只有一股说不清的味道。'],

  群主胜: [
    '你战胜了群主！群主当场表示要去闭关。',
    '群主被你打得满地找牙，群名片都改了。',
    '你赢了。群里安静了三秒，然后开始刷屏。',
  ],
  群主负: [
    '你被群主按在地上摩擦……',
    '群主甚至没有站起来。',
    '你输了。群主说：「年轻人，多养养。」',
  ],
};

/** 取一条文案并填变量 */
function line(key, vars = {}) {
  const pool = LINES[key];
  if (!pool?.length) return '';
  return pick(pool).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
}

export default {
  id: 'kun',
  name: '养鲲',
  version: '3.0.0',
  description: '开局一条鲲，进化全靠吞：养成、道具、拍卖行、BOSS、群主互动',

  setup(ctx) {
    const L = ctx.defineLevels({ 管理员: 0 });
    const keyOf = (uid) => `user:${uid}`;
    const AUCTION = '__auction';
    const BOSS = '__boss';

    const fresh = (uid, name) => ({
      name: name || uid.slice(0, 8),
      species: '未孵化',
      rarity: '—',
      attr: '',
      weight: 5,
      points: 100,
      eggs: 1,
      pills: 0,
      soup: 0,
      revive: 0,
      artifact: 0,
      trainLeft: TRAIN_PER_DAY,
      trainDay: '',
      lastSign: '',
      kills: 0,
      deaths: 0,
      alive: true,
      released: false,
      auction: null,
      bornAt: Date.now(),
    });

    /** 原子读改写；fn 返回 null 表示放弃写入 */
    const mutate = (uid, name, fn) =>
      ctx.storage.update(keyOf(uid), (p) => fn(p ?? fresh(uid, name)));

    const read = async (uid) => (await ctx.storage.get(keyOf(uid))) ?? null;

    /** 跨天重置每日额度 */
    function daily(p) {
      const d = dayKey();
      if (p.trainDay !== d) {
        p.trainDay = d;
        p.trainLeft = TRAIN_PER_DAY;
      }
    }

    /** 状态检查：不能操作时返回原因 */
    function blocked(p) {
      if (p.released) return '这只鲲已经放生了。';
      if (!p.alive) return '鲲已阵亡，先用 /复活。';
      if (p.auction) return '正在拍卖，无法操作。先 /下架。';
      return null;
    }

    /* ---------------- 渲染 ---------------- */

    const bar = (v, max) => {
      const n = Math.max(0, Math.min(10, Math.round((v / max) * 10)));
      return '█'.repeat(n) + '░'.repeat(10 - n);
    };

    function panel(p, uid) {
      const f = fortuneOf(uid, dayKey());

      if (!hasKun(p)) {
        return [
          `# ${ctx.md.esc(p.name)} 的鲲`,
          '',
          `还没有鲲。蛋 **${p.eggs}** · 节操 **${p.points}**`,
          '',
          '## 开始',
          p.eggs > 0
            ? `- ${ctx.md.cmdInput('/孵化', '孵化')} 用一颗蛋开局`
            : `- ${ctx.md.cmdInput('/买蛋', '买蛋')} ${COST.蛋} 节操买一颗`,
          `- ${ctx.md.cmdInput('/签到', '签到')} 赚节操和蛋`,
        ].join('\n');
      }

      if (!p.alive) {
        return [
          `# ${ctx.md.esc(p.name)} 的鲲`,
          '',
          `**${p.species}** ${faceOf(p.species, p.rarity)} · **已阵亡**`,
          '',
          p.revive > 0
            ? `- ${ctx.md.cmdInput('/复活', '复活')} 消耗一粒复活药（有 ${p.revive} 粒）`
            : '- 需要复活药才能复活（砸蛋有几率出）',
          `- ${ctx.md.cmdInput('/放生', '放生')} 放弃这只，换点节操重新开始`,
        ].join('\n');
      }

      if (p.auction) {
        return [
          `# ${ctx.md.esc(p.name)} 的鲲`,
          '',
          `**${p.species}** ${faceOf(p.species, p.rarity)} · 正在拍卖中`,
          '',
          `起拍价 **${p.auction.price}** · 当前竞价 **${p.auction.bid || '无人出价'}**`,
          '',
          `- ${ctx.md.cmdInput('/成交', '成交')} 有出价后确认交易`,
          `- ${ctx.md.cmdInput('/下架', '下架')} 撤回来`,
        ].join('\n');
      }

      // 按状态生成可用操作
      const acts = [];
      if (p.lastSign !== dayKey()) acts.push(`- ${ctx.md.cmdInput('/签到', '签到')} 今天还没签`);
      acts.push(`- ${ctx.md.cmdInput('/喂食', '喂食')} 喂蛋增重（现有 ${p.eggs} 颗蛋）`);
      if (p.eggs > 0) acts.push(`- ${ctx.md.cmdInput('/砸蛋', '砸蛋')} 开蛋出道具（现有 ${p.eggs} 颗）`);
      else acts.push(`- ${ctx.md.cmdInput('/买蛋', '买蛋')} ${COST.蛋} 节操一颗`);
      if (p.soup > 0) acts.push(`- ${ctx.md.cmdInput('/喝鸡汤', '喝鸡汤')} 回节操（有 ${p.soup} 碗）`);
      if (p.trainLeft > 0) acts.push(`- ${ctx.md.cmdInput('/磨炼', '磨炼')} 今日还剩 ${p.trainLeft} 次`);
      if (p.attr !== BAD_ATTR) acts.push(`- ${ctx.md.cmdInput('/幻化', '幻化')} 随机换品种`);
      acts.push(`- ${ctx.md.cmdInput('/吞噬', '吞噬 @某人')} 抢对方 15% 体重`);
      acts.push(`- ${ctx.md.cmdInput('/渡劫', '渡劫')} 体重翻倍或暴跌`);
      acts.push(`- ${ctx.md.cmdInput('/单挑群主', '单挑群主')} 赢了有重赏`);
      acts.push(`- ${ctx.md.cmdInput('/抽群主一个大嘴巴', '抽群主一个大嘴巴')} 白嫖节操`);
      acts.push(`- ${ctx.md.cmdInput('/出售', '出售')} 把鲲挂到拍卖行`);

      const items = [];
      if (p.pills) items.push(`幻化丹 ${p.pills}`);
      if (p.soup) items.push(`鸡汤 ${p.soup}`);
      if (p.revive) items.push(`复活药 ${p.revive}`);
      if (p.artifact) items.push(`神器 ${p.artifact}`);

      return [
        `# ${ctx.md.esc(p.name)} 的鲲`,
        '',
        `**${p.species}** ${faceOf(p.species, p.rarity)} · ${p.rarity} · 属性【${p.attr || '无'}】`,
        `体重 **${p.weight.toFixed(1)}** 千克`,
        '',
        `节操 **${p.points}** · 蛋 **${p.eggs}** · 磨炼 **${p.trainLeft}** 次`,
        items.length ? `道具：${items.join(' · ')}` : '道具：无',
        `战绩 ${p.kills} 杀 ${p.deaths} 死`,
        '',
        `今日运势：**${f.name}**（体重收益 ×${f.mul}）—— ${f.tip}`,
        '',
        '## 可以做',
        ...acts,
      ].join('\n');
    }

    const say = (msg, text) => msg.replyMarkdown({ content: text });

    async function show(msg) {
      const p = await mutate(msg.userId, msg.userName, (x) => {
        daily(x);
        return x;
      });
      await say(msg, panel(p, msg.userId));
    }

    ctx.command('kun', { desc: '看看我的鲲' }, show);

    /* ---------------- 签到 ---------------- */

    ctx.command('签到', { desc: '每日签到领节操，偶尔捡到蛋，可能触发运势事件' }, async (msg) => {
      const today = dayKey();
      const f = fortuneOf(msg.userId, today);
      const gain = Math.round((40 + Math.random() * 40) * f.mul);
      const gotEgg = Math.random() < 0.35;
      const ev = rollLuckEvent();
      let signed = false;

      const p = await mutate(msg.userId, msg.userName, (x) => {
        daily(x);
        if (x.lastSign === today) return null;
        signed = true;
        x.points += gain;
        x.lastSign = today;
        if (gotEgg) x.eggs += 1;
        return x;
      });

      if (!signed) return msg.reply('今天已经签过了，明天再来。');
      await msg.reply(
        `签到成功，节操 +${gain}（${f.name}）${gotEgg ? '\n还捡到一颗蛋。' : ''}` +
          `${ev ? `\n${ev}` : ''}\n当前节操 ${p.points}`,
      );
    });

    /* ---------------- 蛋：买 / 砸 / 孵 ---------------- */

    ctx.command('买蛋 [数量]', { desc: `买蛋 [数量]，每颗 ${COST.蛋} 节操` }, async (msg) => {
      const want = Math.max(1, Number(msg.args[0]) || 1);
      let ok = false;
      let bought = 0;

      const p = await mutate(msg.userId, msg.userName, (x) => {
        const can = Math.min(want, Math.floor(x.points / COST.蛋));
        if (can < 1) return null;
        ok = true;
        bought = can;
        x.points -= can * COST.蛋;
        x.eggs += can;
        return x;
      });

      if (!ok) return msg.reply(`节操不够，还差 ${COST.蛋 - p.points}。发 /签到 去赚。`);
      await msg.reply(`买了 ${bought} 颗蛋（-${bought * COST.蛋} 节操），现在有 ${p.eggs} 颗，剩 ${p.points} 节操。`);
    });

    // 原版：砸蛋【数量】，最多 100 颗；出道具的概率 = 今日运势
    ctx.command('砸蛋 [数量]', { desc: '砸蛋 [数量]，最多 100 颗。出道具的概率取决于今日运势' }, async (msg) => {
      const want = Math.max(1, Math.min(100, Number(msg.args[0]) || 1));
      const f = fortuneOf(msg.userId, dayKey());
      // 运势越好越容易出东西：大吉 1.5 倍，大凶 0.5 倍
      const luck = f.mul;
      let ok = false;
      let used = 0;
      const bag = { 鸡汤: 0, 幻化丹: 0, 复活药: 0, 上古神器: 0, 节操: 0 };

      const p = await mutate(msg.userId, msg.userName, (x) => {
        if (x.eggs < 1) return null;
        ok = true;
        used = Math.min(want, x.eggs);
        x.eggs -= used;

        for (let i = 0; i < used; i++) {
          // 基础命中率随运势浮动：运势 1.0 时约 55% 出货
          if (Math.random() > 0.55 * luck) continue;
          const r = Math.random();
          if (r < 0.42) {
            x.soup += 1;
            bag.鸡汤++;
          } else if (r < 0.72) {
            x.pills += 1;
            bag.幻化丹++;
          } else if (r < 0.94) {
            x.revive += 1;
            bag.复活药++;
          } else {
            x.artifact += 1;
            bag.上古神器++;
          }
        }
        return x;
      });

      if (!ok) return msg.reply('你没有蛋。发 /买蛋 买，或者等签到捡。');

      const parts = Object.entries(bag)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k} ×${v}`);
      const got = parts.length ? parts.join(' · ') : '什么都没有';
      const flavor = bag.上古神器
        ? line('砸蛋出神器')
        : parts.length
          ? line('砸蛋普通', { item: got })
          : line('砸蛋空');

      await msg.reply(
        `砸了 ${used} 颗蛋（今日运势 ${f.name}）\n${flavor}\n获得：**${got}**，剩 ${p.eggs} 颗蛋。`,
      );
    });

    ctx.command('孵化', { desc: '孵一颗蛋，随机得到一只鲲' }, async (msg) => {
      const sp = rollSpecies();
      // 10% 概率出「悲」属性：无法幻化、无法复活
      const attr = Math.random() < 0.1 ? BAD_ATTR : pick(ATTRS);
      let ok = false;
      let reason = '';

      const p = await mutate(msg.userId, msg.userName, (x) => {
        daily(x);
        if (x.eggs < 1) {
          reason = 'noegg';
          return null;
        }
        if (hasKun(x) && !x.released) {
          reason = 'has';
          return null;
        }
        ok = true;
        x.eggs -= 1;
        x.species = sp.name;
        x.rarity = sp.rarity;
        x.attr = attr;
        x.weight = 5;
        x.alive = true;
        x.released = false;
        x.trainLeft = TRAIN_PER_DAY;
        return x;
      });

      if (reason === 'has') return msg.reply('你已经有鲲了。想换一只就发 /放生 或 /幻化。');
      if (reason === 'noegg' || !ok) {
        return msg.reply('你没有蛋。发 /买蛋 买一颗，或者等签到捡。');
      }

      const flavorKey = sp.rarity === '传说' ? '传说' : `孵化${sp.rarity}`;
      await msg.reply(
        `【${sp.name}】${faceOf(sp.name, sp.rarity)} · ${sp.rarity}\n` +
          `${line(flavorKey, { name: sp.name })}\n` +
          `属性【${attr}】${attr === BAD_ATTR ? '（悲属性：无法幻化、无法复活）' : ''}\n` +
          `起步 ${p.weight.toFixed(1)} 千克，磨炼次数已回满。`,
      );
    });

    /* ---------------- 喂食 / 鸡汤 / 磨炼 ---------------- */

    // 原版：喂食【数量】，消耗的是**蛋**，一次最多 100 颗
    ctx.command('喂食 [数量]', { desc: '喂食 [数量]，消耗蛋把鲲喂胖，一次最多 100 颗' }, async (msg) => {
      const want = Math.max(1, Math.min(100, Number(msg.args[0]) || 1));
      const f = fortuneOf(msg.userId, dayKey());
      let reason = '';
      let used = 0;
      let add = 0;

      const p = await mutate(msg.userId, msg.userName, (x) => {
        daily(x);
        if (!hasKun(x)) {
          reason = 'nokun';
          return null;
        }
        const b = blocked(x);
        if (b) {
          reason = b;
          return null;
        }
        if (x.eggs < 1) {
          reason = 'noegg';
          return null;
        }
        used = Math.min(want, x.eggs);
        x.eggs -= used;
        // 每颗蛋 +2~6 千克，稀有度与运势加成
        for (let i = 0; i < used; i++) add += (2 + Math.random() * 4) * growOf(x.rarity) * f.mul;
        x.weight += add;
        return x;
      });

      if (reason === 'nokun') return msg.reply('还没有鲲。先发 /孵化 开局。');
      if (reason === 'noegg') return msg.reply('你没有蛋。发 /买蛋 买，或者等签到捡。');
      if (reason) return msg.reply(reason);

      await msg.reply(
        `${line('喂食', { name: p.species })}\n` +
          `喂了 ${used} 颗蛋，体重 +${add.toFixed(1)} → ${p.weight.toFixed(1)} 千克，剩 ${p.eggs} 颗蛋。`,
      );
    });

    ctx.command('喝鸡汤 [数量]', { desc: '喝鸡汤 [数量]，每碗回节操（砸蛋获得）' }, async (msg) => {
      const want = Math.max(1, Number(msg.args[0]) || 1);
      let reason = '';
      let used = 0;
      let gain = 0;

      const p = await mutate(msg.userId, msg.userName, (x) => {
        if (x.soup < 1) {
          reason = 'nosoup';
          return null;
        }
        used = Math.min(want, x.soup);
        x.soup -= used;
        for (let i = 0; i < used; i++) gain += 80 + Math.floor(Math.random() * 120);
        x.points += gain;
        return x;
      });

      if (reason === 'nosoup') return msg.reply('你没有鸡汤了。砸蛋有几率出。');
      await msg.reply(`喝了 ${used} 碗鸡汤，节操 +${gain}\n剩 ${p.soup} 碗，当前节操 ${p.points}。`);
    });

    ctx.command('磨炼', { desc: `花 ${COST.磨炼} 节操磨炼，70% 概率不消耗，每天 ${TRAIN_PER_DAY} 次` }, async (msg) => {
      let reason = '';
      let gain = 0;
      let free = false;

      const p = await mutate(msg.userId, msg.userName, (x) => {
        daily(x);
        if (!hasKun(x)) {
          reason = 'nokun';
          return null;
        }
        const b = blocked(x);
        if (b) {
          reason = b;
          return null;
        }
        if (x.trainLeft < 1) {
          reason = 'used';
          return null;
        }
        if (x.points < COST.磨炼) {
          reason = 'poor';
          return null;
        }
        x.trainLeft -= 1;
        free = Math.random() < 0.7;
        if (!free) x.points -= COST.磨炼;
        gain = (1 + Math.random() * 3) * growOf(x.rarity);
        x.weight += gain;
        return x;
      });

      if (reason === 'nokun') return msg.reply('还没有鲲。先发 /孵化 开局。');
      if (reason === 'used') return msg.reply('今日磨炼次数已用完！发 /孵化 可换新鲲回满。');
      if (reason === 'poor') return msg.reply(`你已节操丧尽！无法磨炼。还差 ${COST.磨炼 - p.points}。`);
      if (reason) return msg.reply(reason);

      await msg.reply(
        `${line('磨炼', { name: p.species })}\n体重 +${gain.toFixed(1)}${free ? '（这次没消耗节操）' : ''}` +
          ` → ${p.weight.toFixed(1)} 千克，剩 ${p.trainLeft} 次 / ${p.points} 节操。`,
      );
    });

    /* ---------------- 幻化 ---------------- */

    ctx.command('幻化', { desc: `花 ${COST.幻化丹} 节操炼幻化丹，随机换品种，体重不变` }, async (msg) => {
      const sp = rollSpecies();
      let reason = '';
      let oldName = '';

      const p = await mutate(msg.userId, msg.userName, (x) => {
        daily(x);
        if (!hasKun(x)) {
          reason = 'nokun';
          return null;
        }
        const b = blocked(x);
        if (b) {
          reason = b;
          return null;
        }
        if (x.attr === BAD_ATTR) {
          reason = 'bad';
          return null;
        }
        if (x.pills < 1) {
          if (x.points < COST.幻化丹) {
            reason = 'poor';
            return null;
          }
          x.points -= COST.幻化丹;
          x.pills += 1;
        }
        x.pills -= 1;
        oldName = x.species;
        x.species = sp.name;
        x.rarity = sp.rarity;
        return x;
      });

      if (reason === 'nokun') return msg.reply('还没有鲲。先发 /孵化 开局。');
      if (reason === 'bad') return msg.reply('悲属性的鲲无法幻化！');
      if (reason === 'poor') {
        return msg.reply(`炼一颗幻化丹要 ${COST.幻化丹} 节操，你还差 ${COST.幻化丹 - p.points}。`);
      }
      if (reason) return msg.reply(reason);

      await msg.reply(`幻化成功：${oldName} → 【${sp.name}】${faceOf(sp.name, sp.rarity)}（${sp.rarity}）\n体重不变。`);
    });

    /* ---------------- 吞噬 ---------------- */

    ctx.command('吞噬', { desc: '吞噬 @某人 的鲲，赢家抢对方 15% 体重' }, async (msg) => {
      const target = msg.mentions?.[0]?.id;
      if (!target) return msg.reply('要吞噬谁？发 /吞噬 @某人');
      if (target === msg.userId) return msg.reply('不能吞自己。');

      const me = await read(msg.userId);
      if (!me || !hasKun(me)) return msg.reply('你还没有鲲。先发 /孵化 开局。');
      const myBlock = blocked(me);
      if (myBlock) return msg.reply(myBlock);

      const other = await read(target);
      if (!other || !hasKun(other)) return msg.reply('对方还没有鲲，无从下口。');
      if (blocked(other)) return msg.reply('对方当前状态无法被吞噬。');

      const f = fortuneOf(msg.userId, dayKey());

      // 原版的三个隐藏概率：
      //   25% 致命一击（直接赢）
      //   30% 顺手获得一颗蛋
      //   25% 恢复大量体重
      const crit = Math.random() < 0.25;
      const gotEgg = Math.random() < 0.3;
      const heal = Math.random() < 0.25;

      const myPower = me.weight * growOf(me.rarity) * f.mul * (1 + (me.artifact ?? 0) * 0.1);
      const otherPower = other.weight * growOf(other.rarity) * (1 + (other.artifact ?? 0) * 0.1);
      const win = crit || Math.random() < myPower / (myPower + otherPower);

      if (win) {
        const steal = other.weight * 0.15;
        // 原版：被对方吞噬后，有 75% 的几率直接狗带
        const die = Math.random() < 0.75;

        const mine = await mutate(msg.userId, msg.userName, (x) => {
          x.weight += steal;
          x.kills += 1;
          if (gotEgg) x.eggs += 1;
          if (heal) x.weight += x.weight * 0.2;
          return x;
        });
        const theirs = await mutate(target, other.name, (x) => {
          x.weight = Math.max(MIN_WEIGHT, x.weight - steal);
          x.deaths += 1;
          if (die) x.alive = false;
          return x;
        });

        const extra = [
          crit ? '发动了致命一击！' : '',
          gotEgg ? '顺手捡到一颗蛋。' : '',
          heal ? '吞噬过程中恢复了大量体重。' : '',
        ]
          .filter(Boolean)
          .join(' ');

        return msg.reply(
          `${line('吞噬胜', { me: mine.species, other: theirs.species })}\n` +
            `体重 +${steal.toFixed(1)} → ${mine.weight.toFixed(1)} 千克\n` +
            `对方剩 ${theirs.weight.toFixed(1)} 千克${theirs.alive ? '' : '，直接狗带'}。` +
            `${extra ? `\n${extra}` : ''}`,
        );
      }

      const lose = me.weight * 0.1;
      const mine = await mutate(msg.userId, msg.userName, (x) => {
        x.weight = Math.max(MIN_WEIGHT, x.weight - lose);
        x.deaths += 1;
        if (x.weight <= MIN_WEIGHT) x.alive = false;
        return x;
      });
      const theirs = await mutate(target, other.name, (x) => {
        x.weight += lose;
        x.kills += 1;
        return x;
      });
      await msg.reply(
        `${line('吞噬负', { me: mine.species, other: theirs.species })}\n` +
          `体重 -${lose.toFixed(1)} → ${mine.weight.toFixed(1)} 千克${mine.alive ? '' : '，已阵亡'}。`,
      );
    });

    /* ---------------- 渡劫 ---------------- */

    ctx.command('渡劫', { desc: '赌一把：体重翻倍，或暴跌到一成' }, async (msg) => {
      let reason = '';
      let win = false;
      let before = 0;

      const p = await mutate(msg.userId, msg.userName, (x) => {
        if (!hasKun(x)) {
          reason = 'nokun';
          return null;
        }
        const b = blocked(x);
        if (b) {
          reason = b;
          return null;
        }
        before = x.weight;
        win = Math.random() < 0.45;
        x.weight = win ? x.weight * 2 : Math.max(MIN_WEIGHT, x.weight * 0.1);
        return x;
      });

      if (reason === 'nokun') return msg.reply('还没有鲲。先发 /孵化 开局。');
      if (reason) return msg.reply(reason);

      await msg.reply(
        `${line(win ? '渡劫成' : '渡劫败', { name: p.species })}\n` +
          `体重 ${before.toFixed(1)} → ${p.weight.toFixed(1)} 千克。`,
      );
    });

    /* ---------------- 复活 / 放生 ---------------- */

    ctx.command('复活', { desc: '用一粒复活药救回阵亡的鲲' }, async (msg) => {
      let reason = '';

      const p = await mutate(msg.userId, msg.userName, (x) => {
        if (!hasKun(x)) {
          reason = 'nokun';
          return null;
        }
        if (x.alive) {
          reason = 'alive';
          return null;
        }
        if (x.released) {
          reason = 'released';
          return null;
        }
        if (x.attr === BAD_ATTR) {
          reason = 'bad';
          return null;
        }
        if (x.revive < 1) {
          reason = 'noitem';
          return null;
        }
        x.revive -= 1;
        x.alive = true;
        x.weight = Math.max(2, x.weight);
        return x;
      });

      if (reason === 'nokun') return msg.reply('还没有鲲。');
      if (reason === 'alive') return msg.reply('鲲活得好好的，不用复活。');
      if (reason === 'released') return msg.reply('放生的鲲无法复活。');
      if (reason === 'bad') return msg.reply('可能原因：属性鲲、放生鲲、自己强袭致死鲲无法复活。');
      if (reason === 'noitem') return msg.reply('你没有复活药！砸蛋可以获取复活药。');
      await msg.reply(
        `${line('复活', { name: p.species })}\n体重 ${p.weight.toFixed(1)} 千克，剩 ${p.revive} 粒复活药。`,
      );
    });

    ctx.command('放生', { desc: '放生当前这只鲲，随机获得 2~10 颗蛋' }, async (msg) => {
      let reason = '';
      let gain = 0;
      let oldName = '';

      const p = await mutate(msg.userId, msg.userName, (x) => {
        if (!hasKun(x)) {
          reason = 'nokun';
          return null;
        }
        if (x.auction) {
          reason = 'auction';
          return null;
        }
        // 原版：放生随机获得 2 至 10 颗蛋
        gain = 2 + Math.floor(Math.random() * 9);
        oldName = x.species;
        x.eggs += gain;
        x.species = '未孵化';
        x.rarity = '—';
        x.attr = '';
        x.weight = 5;
        x.alive = true;
        x.released = true;
        x.auction = null;
        return x;
      });

      if (reason === 'nokun') return msg.reply('还没有鲲。');
      if (reason === 'auction') return msg.reply('正在拍卖，无法放生！');
      await msg.reply(
        `${line('放生', { name: oldName })}\n获得 ${gain} 颗蛋（现在 ${p.eggs} 颗）。发 /孵化 可以养一只新的。`,
      );
    });

    /* ---------------- 拍卖行 ---------------- */

    ctx.command('出售 [起拍价]', { desc: '出售 [起拍价]，把自己的鲲挂到拍卖行' }, async (msg) => {
      const price = Number(msg.args[0]);
      if (!Number.isFinite(price) || price <= 0) return msg.reply('用法：/上架 <起拍价>');

      const me = await read(msg.userId);
      if (!me || !hasKun(me)) return msg.reply('你还没有鲲。');
      if (me.auction) return msg.reply('你的鲲已经在拍卖了。');
      if (!me.alive) return msg.reply('阵亡的鲲不能上架。');

      const board = await ctx.storage.update(AUCTION, (cur) => {
        const a = cur ?? { list: [] };
        if (a.list.some((x) => x.seller === msg.userId)) return null;
        a.list.push({
          seller: msg.userId,
          sellerName: me.name,
          species: me.species,
          rarity: me.rarity,
          weight: me.weight,
          price,
          bid: 0,
          bidder: '',
          bidderName: '',
          at: Date.now(),
        });
        return a;
      });

      if (!board || !board.list.some((x) => x.seller === msg.userId)) {
        return msg.reply('上架失败，可能你已经有鲲在拍卖了。');
      }

      await mutate(msg.userId, msg.userName, (x) => {
        x.auction = { price, bid: 0, at: Date.now() };
        return x;
      });

      await msg.reply(
        `上架成功！【${me.species}】${faceOf(me.species, me.rarity)} · ${me.weight.toFixed(1)} 千克\n` +
          `起拍价 ${price} 节操。其他人群里发 /竞价 <价格> 出价。`,
      );
    });

    ctx.command('出价 [竞拍价]', { desc: '出价 [竞拍价]，参与竞拍' }, async (msg) => {
      const price = Number(msg.args[0]);
      if (!Number.isFinite(price) || price <= 0) return msg.reply('用法：/竞价 <价格>');

      const me = await read(msg.userId);
      if (!me) return msg.reply('先发 /kun 注册一下。');
      if (me.points < price) return msg.reply(`节操不够，你现在有 ${me.points}。`);

      let reason = '';
      let target = null;

      const board = await ctx.storage.update(AUCTION, (cur) => {
        const a = cur ?? { list: [] };
        if (!a.list.length) {
          reason = 'empty';
          return null;
        }
        const item = a.list[0];
        if (item.seller === msg.userId) {
          reason = 'self';
          return null;
        }
        const cur2 = item.bid || item.price;
        if (price <= cur2) {
          reason = `low:${cur2}`;
          return null;
        }
        item.bid = price;
        item.bidder = msg.userId;
        item.bidderName = me.name;
        target = { ...item };
        return a;
      });

      if (reason === 'empty') return msg.reply('目前没有鲲上架！');
      if (reason === 'self') return msg.reply('不能竞价自己的鲲。');
      if (reason?.startsWith('low:')) {
        return msg.reply(`出价必须大于当前竞价（当前 ${reason.slice(4)}）。`);
      }
      if (!target) return msg.reply('出价失败，再试一次。');

      await mutate(msg.userId, msg.userName, (x) => {
        x.points -= price;
        return x;
      });

      await msg.reply(
        `出价成功：${price} 节操\n目标【${target.species}】${faceOf(target.species, target.rarity)} · ` +
          `${target.weight.toFixed(1)} 千克（卖家 ${target.sellerName}）`,
      );
    });

    ctx.command('成交', { desc: '卖家确认成交，把鲲交给最高出价者' }, async (msg) => {
      const me = await read(msg.userId);
      if (!me?.auction) return msg.reply('你没有在拍卖的鲲。');

      let deal = null;
      let reason = '';

      await ctx.storage.update(AUCTION, (cur) => {
        const a = cur ?? { list: [] };
        const idx = a.list.findIndex((x) => x.seller === msg.userId);
        if (idx < 0) {
          reason = 'gone';
          return null;
        }
        const item = a.list[idx];
        if (!item.bidder) {
          reason = 'nobid';
          return null;
        }
        a.list.splice(idx, 1);
        deal = item;
        return a;
      });

      if (reason === 'gone') return msg.reply('拍卖行里找不到你的鲲。');
      if (reason === 'nobid') return msg.reply('还没有人出价，再等等。');
      if (!deal) return msg.reply('成交失败，再试一次。');

      const seller = await mutate(msg.userId, me.name, (x) => {
        x.points += deal.bid;
        x.species = '未孵化';
        x.rarity = '—';
        x.attr = '';
        x.weight = 5;
        x.auction = null;
        return x;
      });

      await mutate(deal.bidder, deal.bidderName, (x) => {
        x.species = deal.species;
        x.rarity = deal.rarity;
        x.weight = deal.weight;
        x.attr = x.attr || '力';
        x.alive = true;
        x.released = false;
        x.auction = null;
        return x;
      });

      await msg.reply(
        `成交！【${deal.species}】${faceOf(deal.species, deal.rarity)} 以 ${deal.bid} 节操卖给了 ${deal.bidderName}。\n` +
          `你当前节操 ${seller.points}。`,
      );
    });

    ctx.command('下架', { desc: '把拍卖中的鲲撤下来' }, async (msg) => {
      const me = await read(msg.userId);
      if (!me?.auction) return msg.reply('你没有在拍卖的鲲。');

      const mins = (Date.now() - (me.auction.at ?? 0)) / 60000;
      if (mins < 5 && me.auction.bid > 0) {
        return msg.reply(`上架时间不足 5 分钟，不可强制下架！（还有 ${Math.ceil(5 - mins)} 分钟）`);
      }

      await ctx.storage.update(AUCTION, (cur) => {
        const a = cur ?? { list: [] };
        a.list = a.list.filter((x) => x.seller !== msg.userId);
        return a;
      });
      await mutate(msg.userId, msg.userName, (x) => {
        x.auction = null;
        return x;
      });

      await msg.reply('已下架。');
    });

    /* ---------------- BOSS ---------------- */

    function bossOfDay() {
      const d = dayKey();
      let h = 0;
      for (let i = 0; i < d.length; i++) h = (h * 31 + d.charCodeAt(i)) >>> 0;
      const names = ['混沌鲲', '深渊鲲', '吞天鲲', '噬地鲲', '古神鲲'];
      const maxHp = 3000 + (h % 5) * 500;
      return { day: d, name: names[h % names.length], hp: maxHp, maxHp, killers: [] };
    }

    /** 拿今日 BOSS，跨天自动重置 */
    const ensureBoss = () =>
      ctx.storage.update(BOSS, (cur) => (cur && cur.day === bossOfDay().day ? undefined : bossOfDay()));

    ctx.command('查询BOSS', { desc: '看看今日 BOSS 的血量与击杀情况' }, async (msg) => {
      const b = await ensureBoss();
      const pct = Math.max(0, Math.round((b.hp / b.maxHp) * 100));
      const lines = [
        `# 今日 BOSS · ${b.name}`,
        '',
        `血量 ${bar(b.hp, b.maxHp)} ${pct}%（${Math.max(0, Math.round(b.hp))}/${b.maxHp}）`,
        '',
      ];
      if (b.hp <= 0) lines.push('已被击杀，明天再来。');
      else lines.push(`- ${ctx.md.cmdInput('/攻击BOSS', '攻击BOSS')} 按体重造成伤害`);
      if (b.killers?.length) {
        lines.push('', '## 阵亡名单', ...b.killers.slice(-5).map((k) => `- ${k.name} · 造成 ${k.dmg} 伤害`));
      }
      await say(msg, lines.join('\n'));
    });

    ctx.command('攻击BOSS', { desc: '攻击今日 BOSS，按体重造成伤害' }, async (msg) => {
      const me = await read(msg.userId);
      if (!me || !hasKun(me)) return msg.reply('你还没有鲲。先发 /孵化 开局。');
      const b0 = blocked(me);
      if (b0) return msg.reply(b0);

      await ensureBoss();
      // 基础 50 + 体重×5：新玩家一拳 75，50 公斤的大鲲一拳 300，都能打出存在感
      const dmg = Math.round((50 + me.weight * 5) * (1 + (me.artifact ?? 0) * 0.2) * (0.8 + Math.random() * 0.4));
      let killed = false;

      const b = await ctx.storage.update(BOSS, (cur) => {
        const board = cur ?? bossOfDay();
        if (board.hp <= 0) return undefined;
        board.hp = Math.max(0, board.hp - dmg);
        board.killers = board.killers ?? [];
        board.killers.push({ name: me.name, dmg, at: Date.now() });
        if (board.hp === 0) killed = true;
        return board;
      });

      if (!b || (b.hp <= 0 && !killed)) return msg.reply('今日 BOSS 已经被击杀了。明天再来。');

      if (killed) {
        await mutate(msg.userId, me.name, (x) => {
          x.points += 300;
          x.artifact += 1;
          x.kills += 1;
          return x;
        });
        return msg.reply(
          `成功击杀！你打出了 ${dmg} 伤害，拿下最后一击。\n获得击杀奖励：300 节操 + 1 件神器。`,
        );
      }

      await msg.reply(
        `你打出了 ${dmg} 伤害。\nBOSS 剩余血量 ${Math.round(b.hp)}/${b.maxHp}（${Math.round((b.hp / b.maxHp) * 100)}%）。`,
      );
    });

    ctx.command('刷新BOSS', { desc: '重置今日 BOSS（插件管理员）' }, async (msg) => {
      if (!(await ctx.can(msg, L.管理员))) {
        return msg.reply(`需要「养鲲」管理员权限（等级 ${L.管理员}）`);
      }
      await ctx.storage.set(BOSS, bossOfDay());
      await msg.reply('已刷新今日 BOSS。');
    });

    /* ---------------- 群主互动 ---------------- */

    ctx.command('单挑群主', { desc: '挑战群主，赢了有重赏' }, async (msg) => {
      if (msg.kind !== 'group') return msg.reply('这个玩法只能在群里用。');
      const me = await read(msg.userId);
      if (!me || !hasKun(me)) return msg.reply('你还没有鲲。先发 /孵化 开局。');
      const b0 = blocked(me);
      if (b0) return msg.reply(b0);

      const bossWeight = Math.max(20, me.weight * (1.2 + Math.random() * 0.8));
      const win = Math.random() < me.weight / (me.weight + bossWeight);

      if (win) {
        const gain = Math.round(bossWeight * 3);
        const p = await mutate(msg.userId, me.name, (x) => {
          x.points += gain;
          x.weight += bossWeight * 0.2;
          x.kills += 1;
          return x;
        });
        return msg.reply(
          `${line('群主胜')}\n节操 +${gain}，体重 +${(bossWeight * 0.2).toFixed(1)} → ${p.weight.toFixed(1)} 千克。`,
        );
      }

      const lose = me.weight * 0.1;
      const p = await mutate(msg.userId, me.name, (x) => {
        x.weight = Math.max(MIN_WEIGHT, x.weight - lose);
        x.deaths += 1;
        return x;
      });
      await msg.reply(
        `${line('群主负')}\n体重 -${lose.toFixed(1)} → ${p.weight.toFixed(1)} 千克。下次带只更胖的来。`,
      );
    });

    ctx.command('抽群主一个大嘴巴', { desc: '抽群主一巴掌，白嫖节操' }, async (msg) => {
      if (msg.kind !== 'group') return msg.reply('这个玩法只能在群里用。');
      const gain = 10 + Math.floor(Math.random() * 30);
      const p = await mutate(msg.userId, msg.userName, (x) => {
        x.points += gain;
        return x;
      });
      await msg.reply(`啪！你抽了群主一个大嘴巴，节操 +${gain}\n当前节操 ${p.points}。`);
    });

    /* ---------------- 排行 ---------------- */

    ctx.command('鲲榜', { desc: '体重排行前 5' }, async (msg) => {
      const all = await ctx.storage.all();
      const rows = Object.entries(all)
        .filter(([k]) => k.startsWith('user:'))
        .map(([k, v]) => ({ uid: k.slice(5), ...v }))
        .filter((r) => hasKun(r) && r.alive && !r.released)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 5);

      if (!rows.length) return msg.reply('还没有人养鲲。发 /kun 开局。');
      const lines = rows.map(
        (r, i) =>
          `${i + 1}. ${r.name || r.uid.slice(0, 8)} · ${r.species} ${faceOf(r.species, r.rarity)} · ${r.weight.toFixed(1)} 千克`,
      );
      await msg.reply(['鲲榜', ...lines].join('\n'));
    });

    /* ---------------- 菜单 ---------------- */

    ctx.menu('养成', [
      { text: '我的鲲', desc: '群里直接说，不用加前缀' },
      { text: '签到', desc: '每天一次，赚节操和蛋，可能触发运势事件' },
      { text: '砸蛋', desc: '开蛋出道具：鸡汤 / 幻化丹 / 复活药 / 神器' },
      { text: '喝鸡汤', desc: '回节操' },
      { text: '磨炼', desc: `每天 ${TRAIN_PER_DAY} 次，70% 概率不消耗节操` },
    ]);

    ctx.menu('对抗', [
      { text: '吞噬 @某人', desc: '赢家抢对方 15% 体重，输家可能阵亡' },
      { text: '渡劫', desc: '体重翻倍或暴跌到一成' },
      { text: '单挑群主', desc: '赢了重赏，输了掉体重' },
      { text: '抽群主一个大嘴巴', desc: '白嫖节操' },
    ]);

    ctx.menu('交易与活动', [
      { text: '出售 <起拍价>', desc: '把鲲挂到拍卖行' },
      { text: '出价 <竞拍价>', desc: '参与竞拍' },
      { text: '成交', desc: '卖家确认，把鲲交给最高出价者' },
      { text: '查询BOSS', desc: '看今日 BOSS 血量与阵亡名单' },
      { text: '攻击BOSS', desc: '按体重造成伤害，击杀有重赏' },
    ]);

    ctx.menu('生存', [
      { text: '复活', desc: '用复活药救回阵亡的鲲' },
      { text: '放生', desc: '放弃当前鲲，换一笔节操' },
    ]);

    /* ---------------- 被动触发 ---------------- */

    ctx.on('message', async (msg) => {
      if (msg.isCommand) return;
      if (msg.content === '我的鲲' || msg.content === '养鲲') {
        await show(msg);
        return true;
      }
    });

    /* ---------------- 管理 ---------------- */

    ctx.command('kunreset', { desc: '清空所有人的鲲和全局状态（插件管理员）' }, async (msg) => {
      if (!(await ctx.can(msg, L.管理员))) {
        return msg.reply(`需要「养鲲」管理员权限（等级 ${L.管理员}）`);
      }
      const all = await ctx.storage.all();
      let n = 0;
      for (const k of Object.keys(all)) {
        if (k.startsWith('user:')) {
          await ctx.storage.delete(k);
          n++;
        }
      }
      await ctx.storage.delete(AUCTION);
      await ctx.storage.delete(BOSS);
      await msg.reply(`已清空 ${n} 条养鲲记录，拍卖行和 BOSS 也重置了。`);
    });
  },
};

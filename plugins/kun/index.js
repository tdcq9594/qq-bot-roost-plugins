/**
 * 养鲲 v4.0 —— 1:1 还原版
 * ==========
 *
 * ── 致敬原作者 ──────────────────────────────────────────────
 *
 * 玩法设计全部来自 Agam 的《简单的养鲲游戏》
 * （CQP 插件 me.cqp.Agam.kun，版本 1.19.9.4.1，2020 年）。
 *
 * 「开局一条鲲，进化全靠吞」、节操 / 体重 / 砸蛋 / 磨炼 / 幻化 /
 * 拍卖行 / 单挑群主 / 抽群主一个大嘴巴 —— 这些创意都是 Agam 的。
 *
 * v4.0 的改变：**按易语言源码 1:1 重写**。
 * 源码（IDE 导出的 鲲.txt / 鲲BOSS.txt / 常量数据表.txt）在
 * C:/Users/q9079/Desktop/kun，本文件的每条回复文本、每个数值公式
 * 都从那里逐行对照搬运，包括原版的怪癖（攻击2 的 B 也用重A 算、
 * 渡劫失败进度条末尾缀个随机数字、运势取 QQ 前四位算等等）。
 *
 * ── 平台差异与平替（原版跑在真实 QQ + 酷Q 上）────────────────
 *
 * | 原版（酷Q / 真实 QQ）      | 本版（官方机器人）              |
 * |---------------------------|--------------------------------|
 * | `*命令` 前缀               | `/命令`（框架约定）             |
 * | `[CQ:at,qq=123]`          | `<@openid>`（输出文本里原样替换）|
 * | 真实 QQ 号 / 群号          | openid（官方不暴露 QQ 号）      |
 * | 群成员列表遍历排行          | 遍历自己的存档（输出不变）       |
 * | 名片→昵称→QQ号             | 存档昵称→openid                |
 * | 运势按 QQ 前四位           | 按 openid 前四位（同形状算法）   |
 * | 置群员禁言 180 秒           | ctx.api.muteMember（平替保留）  |
 * | 群流程里给受害者发私信       | 放弃（群里已 @ 通知，内容是重复的）|
 * | 查阅属性时私信一份           | 放弃（群消息已有全文）           |
 * | _menuA 弹信息框             | 放弃（GUI 弹窗，官方无对应）     |
 * | *绑定 群号（可校验群成员）   | /绑定 群openid（存下来即可）     |
 *
 * 抢答指令 `*=数值` 在本框架注册为 `/=`（也可用 `/答`），
 * 提示文案保持原文「回复【*=数值】来抢答」。
 *
 * ── 数据（INI → JSON）────────────────────────────────────
 *
 *   p:<群>:<用户>   玩家：鲲/属性/体重/蛋/节操/神器/鸡汤/幻化丹/复活药/
 *                    好运/死因/死鲲/死重/上架/签到日/上次使用/磨炼余次/BOSS输出/昵称
 *   g:<群>          群：开关 / 拍卖行(卖家/买主/竞价/上架时间) /
 *                    小游戏(a-y,ques,ans,奖励,惩罚,名额,game,星星1-5) /
 *                    BOSS(刷新日/体重/活/BOSS/击杀者/阵亡名单)
 *   b:<用户>        绑定的群
 */

/* ================= 常量（原版「常量数据表」） ================= */

/** #神器 —— 神器代称 */
const SHENQI = '+夨￥宀♂牮√';
/** #神器1 / #神器2 —— 砸出神器时的两行炫酷文案 */
const SHENQI1 =
  '★★★高端◇大气□上档次⊕狂拽◎酷炫¤屌炸天●〔加冰〕〔加雷〕又〔加碳〕!!【防水】【防火】更【防电】!![加葱][加肠]再[加蛋]」!!〖防偷〗〖防抢〗还〖防骗〗卍法力无边∞潜能无限';
const SHENQI2 =
  '☆先{淬毒}后{蘸蒜}再{镀金}又{镶钻}※暴击+2333◆明晃晃⊕冷森森&&削铁如泥╀吹毛立断★★★の+夨￥宀♂牮√';

/** 七种属性的一句话说明（#傲 ~ #悲） */
const ATTR_DESC = {
  傲: '“◆无视对方属性”',
  妒: '“◆比其体重大的鲲无法对其发起吞噬或攻击”',
  怒: '“◆较强的攻击力，容易吞噬对方◆吞噬或攻击开始时有25%的几率对对方造成致命一击”',
  惰: '“◆较强的防御力，不容易被吞噬◆免疫强袭”',
  贪: '“◆发起吞噬或攻击时有30%的几率获得一颗蛋◆磨炼有70%的概率不消耗节操◆将其放生可随机获得2至10颗蛋”',
  馋: '“◆吞噬对方失败时不损失体重◆幻化不消耗体重◇无法发起攻击◇体重超过1000千克时暴死(渡劫成功时体重可暂时突破1000千克)”',
  淫: '“◆被对方吞噬后，对方有75%的几率直接狗带◆发起攻击或被攻击后有25%的概率恢复大量体重”',
  悲: '“◆初始体重为（当前榜一体重）+1000千克◇无法幻化◇极其稀有，孵化率仅为0.7%，无法通过幻化获得该属性”',
};

/** BOSS 四种属性说明（#魑 ~ #魉） */
const BOSS_DESC = {
  魑: '免疫强袭',
  魅: '免疫吞噬',
  魍: '免疫攻击',
  魉: '体重低于666千克时恢复至1000千克',
};

/** 50 个鲲名（原版 鲲名()，1-50 等概率） */
const KUN_NAMES = [
  '菜虚鲲', '将鲲', '犷鲲', '尘鲲', '土鲲', '岩鲲', '石鲲', '沙鲲', '雷鲲', '雪鲲',
  '虹鲲', '碧鲲', '蓝鲲', '橙鲲', '黑鲲', '暗鲲', '铁头鲲', '钢背鲲', '彩鲲', '炎鲲',
  '冰鲲', '凶鲲', '恶鲲', '幻鲲', '诡鲲', '炬目鲲', '柯温鲲', '胖头鲲', '阳鲲', '靓鲲',
  '尸鲲', '血鲲', '骨鲲', '腐鲲', '毒鲲', '妖鲲', '魔鲲', '鬼鲲', '圣鲲', '灵鲲',
  '冥鲲', '玄鲲', '炫鲲', '帝鲲', '齿鲲', '剑鲲', '铠鲲', 'ikun', '阴鲲', '烈鲲',
];

/** 幻化成功时的七个目标属性（1-7 等概率，原版顺序） */
const HUAHUA_ATTRS = ['傲', '妒', '怒', '惰', '贪', '馋', '淫'];

/** 冷却：同一用户两条命令之间至少隔这么久（秒） */
const COOLDOWN_SEC = 6;
/** 磨炼每天次数 */
const TRAIN_PER_DAY = 30;
/** 喂食/砸蛋单次上限 */
const MAX_EGG_BATCH = 100;

/* ================= 随机数与文本助手 ================= */

/** 取随机数(a,b)：闭区间，对齐易语言。测试可注入 globalThis.__kunRng */
function rng() {
  return globalThis.__kunRng ? globalThis.__kunRng() : Math.random();
}
function rand(a, b) {
  return a + Math.floor(rng() * (b - a + 1));
}

/** 到文本：整数直接转；小数用 JS 默认表示（对齐易语言到文本的小数形态） */
function toText(v) {
  return String(v);
}

/** 到数值：取前导数字，失败为 0（对齐易语言） */
function toNum(s) {
  const m = String(s ?? '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

/** 取文本左边 */
function left(s, n) {
  return String(s ?? '').slice(0, n);
}

/** 子文本替换(全部替换) */
function subReplace(s, find, rep) {
  return String(s ?? '').split(find).join(rep);
}

/** 取绝对值 */
function abs(n) {
  return Math.abs(n);
}

/** 取整（向零取整，对齐易语言取整） */
function trunc(n) {
  return n < 0 ? Math.ceil(n) : Math.floor(n);
}

/* ================= 存储层 ================= */

/** 玩家存档默认值 */
function freshPlayer(name) {
  return {
    nm: name || '',   // 昵称缓存
    n: '',            // 鲲名
    a: '',            // 属性
    w: 0,             // 体重
    e: 0,             // 蛋
    j: 0,             // 节操
    s: 0,             // 神器
    p: 0,             // 鸡汤
    h: 0,             // 幻化丹
    r: 0,             // 复活药
    l: 0,             // 好运
    dc: 0,            // 死因
    dk: '',           // 死鲲
    dw: 0,            // 死重
    li: 0,            // 上架
    sg: '',           // 签到日（原版存「日」，跨月会重置，保持原样）
    lu: 0,            // 上次使用（毫秒时间戳）
    tl: 0,            // 磨炼余次
    bo: 0,            // BOSS输出
  };
}

/** 群存档默认值 */
function freshGroup() {
  return {
    on: '',   // 开关：'开' / '关' / ''（默认空=开）
    au: { se: '', bu: '', bd: 0, at: 0 },   // 拍卖行：卖家/买主(openid)/竞价/上架时间
    gm: {      // 小游戏
      a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, x: 0, y: 0,
      ques: '', ans: '', rw: 0, pn: 0, sl: 0, game: 0,
      t1: '', t2: '', t3: '', t4: '', t5: '',
    },
    bs: { rd: 0, w: 0, al: '', bo: '', kl: '', dl: '' },   // BOSS
  };
}

/**
 * 插件元信息先存成常量，最后再 `export default`。
 *
 * 为什么不直接 `export default { ... }`：启动日志想用同一个版本号，
 * 但工具链（插件仓库的 scripts/check-versions.mjs、市场安装时的
 * readVersionLoose）是用正则读 `version: '...'` **字面量**的。
 * 写成 `version: VERSION` 它们读不到，CI 会直接判「读不到 version」。
 * 这样两边都满足：字面量还在，日志也不用再抄一份。
 */
const PLUGIN = {
  id: 'kun',
  name: '养鲲',
  version: '4.1.2',
  description: '开局一条鲲，进化全靠吞（Agam《简单的养鲲游戏》1:1 还原）',
  frameworkVersion: '>=0.6.0',

  async setup(ctx) {
    const log = ctx.logger;

    /* ---------- key ---------- */
    const pKey = (gid, uid) => `p:${gid}:${uid}`;
    const gKey = (gid) => `g:${gid}`;
    const bKey = (uid) => `b:${uid}`;

    /* ---------- 原子读改写 ---------- */
    // 注意：ctx.storage.update 的语义是「fn 返回新值，返回 undefined/null 表示不写」，
    // 所以这里必须把改完的对象 return 出去（block 体箭头函数默认返回 undefined）。
    const mutateP = (gid, uid, name, fn) =>
      ctx.storage.update(pKey(gid, uid), (p) => {
        const x = p ?? freshPlayer(name);
        fn(x);
        return x;
      });
    const mutateG = (gid, fn) =>
      ctx.storage.update(gKey(gid), (g) => {
        const x = g ?? freshGroup();
        fn(x);
        return x;
      });
    // 一定要返回**副本**：update 的回调拿到的就是存储里的那个对象，
    // 原地改完再读「修改前的值」会读到新值（磨炼那条 204>>>>>204 就是这么来的）。
    const readP = async (gid, uid) => {
      const v = await ctx.storage.get(pKey(gid, uid));
      return v ? { ...v } : freshPlayer('');
    };
    const readG = async (gid) => {
      const v = await ctx.storage.get(gKey(gid));
      if (!v) return freshGroup();
      return { ...v, au: { ...v.au }, gm: { ...v.gm }, bs: { ...v.bs } };
    };

    /** 遍历某群的全部玩家存档（替代原版的取群成员列表） */
    const eachPlayer = async (gid) => {
      const all = (await ctx.storage.all()) ?? {};
      const pre = `p:${gid}:`;
      const out = [];
      for (const [k, v] of Object.entries(all)) {
        if (k.startsWith(pre)) out.push({ uid: k.slice(pre.length), p: v });
      }
      return out;
    };

    /* ---------- 展示助手 ---------- */

    /** 昵称：存档优先，其次消息里的用户名，最后 openid */
    const nameOf = (uid, fallback) => fallback || uid;

    /** 带属性前缀的鲲名：[怒]炎鲲 */
    const kunWith = (p) => {
      let k = p.n;
      if (p.a && p.a !== '无') k = `[${p.a}]${k}`;
      return k;
    };

    /** CQ码_At 的占位；发 markdown 时由 mdEmphasis 换成 <qqbot-at-user> 标签 */
    const at = (uid) => `<@${uid}>`;

    /**
     * 把纯文本变成「渲染后一字不差」的 markdown 安全文本。
     *
     * 原版文本里有大量 `*`（菜单行、蛋*20、神器文案的 ★★★）和长串 `---`，
     * 直接进 markdown 会被当成粗体 / 斜体 / 分割线，文字就变了样。
     * 官方文档没给反斜杠转义，所以用文档里提到的零宽字符 \u200B 打断：
     * 渲染结果和原文本完全一致，但解析器再也拼不出 ** / *** / ---。
     * 注意每个 * 后面都要插——只打断连写不够，「蛋*20」加粗数字后会变成 ***。
     */
    function mdSafe(s) {
      return String(s ?? '')
        .replace(/\*/g, '*\u200B')
        .replace(/-{2,}/g, (m) => m.split('').join('\u200B'));
    }

    /**
     * =标题= 行整行加粗（====命令菜单==== 这种）。
     * 要求等号中间有实际内容——`=============` 是分隔线，加粗没意义还难看。
     */
    function boldTitles(s) {
      return String(s)
        .split('\n')
        .map((line) => (/^=+[^=]+=+$/.test(line) ? `**${line}**` : line))
        .join('\n');
    }

    /**
     * 加粗重点：数字（体重/节操/蛋/奖励）、=标题= 行。
     * 只往外面包 **，不动原文字符。@ 占位按段绕开，保证标签原样透传。
     */
    function mdEmphasis(text) {
      return String(text ?? '')
        .split(/(<@[^>]+>|<qqbot-cmd-[^>]*\/>)/g)
        .map((seg) => {
          if (/^<@[^>]+>$/.test(seg)) {
            // 官方 markdown 里的 @ 标签
            return `<qqbot-at-user id="${seg.slice(2, -1)}" />`;
          }
          // 指令标签原样透传：属性里 urlencode 过，加粗数字会把它弄坏
          if (/^<qqbot-cmd-/.test(seg)) return seg;
          let s = mdSafe(seg);
          s = boldTitles(s);
          s = s.replace(/(\d+)/g, '**$1**');
          return s;
        })
        .join('');
    }

    /**
     * 可点击指令标签：显示原文，点一下把 /kun 指令填进输入框。
     * show 用原文（`*签到`），text 用新写法（`/kun 签到`）——
     * 菜单看起来和原版一模一样，但每条都能点。
     */
    function cmdTag(show, text) {
      return `<qqbot-cmd-input text="${encodeURIComponent(text)}" show="${encodeURIComponent(show)}" />`;
    }

    /** 发一条 markdown 消息；发不出去（未开放等）自动退回纯文本，内容不丢 */
    async function sendMd(msg, text) {
      const r = await msg.replyMarkdown({ content: mdEmphasis(text) });
      if (r === null || r === undefined) await msg.reply(text);
      return r;
    }

    /** 群消息（markdown，立刻发） */
    const say = (msg, text) => sendMd(msg, text);
    /** 原版连着发多条时用——同样是立刻发 */
    const sayNow = (msg, text) => sendMd(msg, text);

    /** 管理权限：3=群主 2=管理员 1=成员（对齐原版 qcy.管理权限） */
    const roleOf = async (msg) => {
      const r = msg.raw?.author?.member_role;
      if (r === 'owner') return 3;
      if (r === 'admin') return 2;
      if (r === 'member') return 1;
      if (msg.kind !== 'group') return 1;
      try {
        const g = await ctx.getGroup(msg.groupId);
        if (g?.ownerOpenid && g.ownerOpenid === msg.userId) return 3;
        if (await ctx.isGroupAdmin(msg.groupId, msg.userId)) return 2;
      } catch { /* 查不到就当普通成员 */ }
      return 1;
    };

    /** 置群员禁言（原版 180 秒的那个）。失败静默——原版也一样 */
    const mute = async (gid, uid, seconds) => {
      try {
        await ctx.api.muteMember(gid, uid, new Date(Date.now() + seconds * 1000).toISOString());
      } catch (e) {
        log.warn(`[kun] 禁言失败（机器人可能不是群管）: ${e.message}`);
      }
    };

    /** 好运（原版 好运()） */
    async function luckOf(gid, uid) {
      return (await readP(gid, uid)).l;
    }

    /**
     * 运势的基数。
     * 原版取 QQ 号前四位——QQ 号一定是数字。官方机器人只有 openid（字母数字混合），
     * 直接取前四位经常是 0，导致运势恒为 0、砸蛋永远不出货。
     * 所以：纯数字 ID 沿用原版；openid 走稳定哈希，保证同一个人每天稳定、且非零。
     */
    function idSeed(uid) {
      const s = String(uid ?? '');
      const head = toNum(left(s, 4));
      if (head > 0) return head;
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      return (h % 9000) + 1000;
    }

    /**
     * 运势：0~100，同一个人同一天固定，换天就变。
     *
     * 原版拿 QQ 号前四位套一串整除取余（`a*b/c/99` 再取小数部分前两位），
     * 在 openid 上会退化——前四位不是数字、小数部分又常常不足 1%，
     * 结果几乎恒为 0，砸蛋永远出不了货。
     * 这里改成「用户 + 日期」的稳定哈希取模，分布均匀且每天变。
     */
    function baseFortune(uid) {
      const now = new Date();
      const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
      const s = `${uid}:${day}`;
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      return h % 101;   // 0~100
    }

    /** 运势（原版 运势()）：基础运势 + 好运加成，夹到 0~100 */
    async function fortune(gid, uid) {
      let d = baseFortune(uid) + (await luckOf(gid, uid));
      if (d < 0) d = 0;
      if (d > 100) d = 100;
      return d;
    }

    /* ================= 菜单 / 帮助 ================= */

    /**
     * 菜单条目：字符串 = 原样一行；数组 = [显示文本, 点击后插入的指令]。
     * 显示文本照抄原版（连 `*下架 ` 后面的空格都留着），
     * 点击插入的是新写法 `/kun <指令>`。
     */
    const MENU_ITEMS = [
      '====命令菜单====',
      /**
       * 开关类的两条拆成两行。
       *
       * 原版是一行「*鲲开/关【@机器人】」，但菜单现在每条都是**可点的**
       * （`cmdTag` 插入一条具体指令），一行里塞两个指令就只能插进去一个，
       * 点「鲲开/关」得到「鲲开」，标签和实际不符。拆开各自准确。
       */
      ['*鲲开【@机器人】', '/kun 鲲开'],
      ['*鲲关【@机器人】', '/kun 鲲关'],
      ['*小游戏开【@机器人】', '/kun 小游戏开'],
      ['*小游戏关【@机器人】', '/kun 小游戏关'],
      ['*数据清除【@机器人】（仅群主·慎用）', '/kun 数据清除'],
      ['*查看群主指令', '/kun 查看群主指令'],
      '——————————',
      ['*出售【起拍价】', '/kun 出售 '],
      ['*出价【竞拍价】', '/kun 出价 '],
      ['*成交', '/kun 成交'],
      ['*下架 ', '/kun 下架'],
      ['*强制下架', '/kun 强制下架'],
      ['*拍卖行 ', '/kun 拍卖行'],
      '——————————',
      ['*签到', '/kun 签到'],
      ['*查询', '/kun 查询'],
      ['*排行', '/kun 排行'],
      '——————————',
      ['*孵化', '/kun 孵化'],
      ['*喂食【数量】', '/kun 喂食 '],
      ['*磨炼【数值】（私）', '/kun 磨炼 '],
      ['*幻化（私）', '/kun 幻化'],
      ['*渡劫', '/kun 渡劫'],
      ['*复活', '/kun 复活'],
      ['*放生', '/kun 放生'],
      '——————————',
      // 目标是 @ 成员（官方机器人拿不到 QQ 号，openid 用户也打不出来）
      ['*吞噬【@成员】', '/kun 吞噬 '],
      ['*攻击【@成员】', '/kun 攻击 '],
      ['*强袭【@成员】', '/kun 强袭 '],
      ['*扔蛋【@成员】', '/kun 扔蛋 '],
      '——————————',
      ['*买蛋【数量】', '/kun 买蛋 '],
      ['*砸蛋【数量】（私）', '/kun 砸蛋 '],
      ['*喝鸡汤【数量】', '/kun 喝鸡汤 '],
      ['*今日运势', '/kun 今日运势'],
      ['*当前游戏', '/kun 当前游戏'],
      ['*BOSS菜单', '/kun BOSS菜单'],
      ['*查阅属性', '/kun 查阅属性'],
      '——————————',
      '带有（私）标记的指令可以私聊机器人使用',
    ];

    /** 纯文本版菜单（测试断言和降级用） */
    const MENU_TEXT = MENU_ITEMS.map((it) => (Array.isArray(it) ? it[0] : it)).join('\n');

    /** markdown 版菜单：每条指令都能点 */
    const MENU_MD = MENU_ITEMS.map((it) => (Array.isArray(it) ? cmdTag(it[0], it[1]) : it)).join('\n');

    function showMenu(msg, gid) {
      say(msg, MENU_MD);
    }

    const OWNER_HELP =
      '*OP @成员 项目 数值' + '\n' +
      '===================' + '\n' +
      '1、先 @ 要改的那个成员。' + '\n' +
      '2、在【项目】处填入要修改的项目。有以下项目可选：' +
      '【鲲】【体重】【属性】【节操】【蛋】【神器】【幻化丹】【鸡汤】【复活药】【运势】' + '\n' +
      '3、在数值处填要改成什么／加减多少（正为加负为减）' + '\n' +
      '===================' + '\n' +
      '例：' + '\n' +
      '*OP @张三 属性 妒' + '\n' +
      '把张三的鲲的属性改为[妒]' + '\n' +
      '*OP @张三 蛋 -10' + '\n' +
      '张三的蛋减10' + '\n' +
      '*OP @张三 节操 +1' + '\n' +
      '张三的节操加1' + '\n' +
      '===================' + '\n' +
      '官方机器人拿不到 QQ 号，所以目标是 @ 成员；' + '\n' +
      '@ 不上时也可以填对方的 openid（面板「权限」页能查到）。' + '\n' +
      '【鲲】【属性】是「改成」，其余是「加减」。' + '\n' +
      '群主和管理员可用，请谨慎操作！错误操作造成的损失概不负责！';

    function showOwnerHelp(msg) {
      say(msg, OWNER_HELP);
    }

    function showAttrs(msg) {
      let w =
        '=====属性列表=====' + '\n' +
        '[表情]傲：' + ATTR_DESC.傲 + '\n' +
        '[表情]妒：' + ATTR_DESC.妒 + '\n' +
        '[表情]怒：' + ATTR_DESC.怒 + '\n' +
        '[表情]惰：' + ATTR_DESC.惰 + '\n' +
        '[表情]贪：' + ATTR_DESC.贪 + '\n' +
        '[表情]馋：' + ATTR_DESC.馋 + '\n' +
        '[表情]淫：' + ATTR_DESC.淫 + '\n' +
        '[表情]悲：' + ATTR_DESC.悲 + '\n' +
        '----BOSS属性----' + '\n' +
        '♂魑：' + BOSS_DESC.魑 + '\n' +
        '♂魅：' + BOSS_DESC.魅 + '\n' +
        '♂魍：' + BOSS_DESC.魍 + '\n' +
        '♂魉：' + BOSS_DESC.魉;
      say(msg, w);
      // 原版在这里还给本人发一份私信；官方机器人主动私信有额度限制，内容群消息已有，放弃
    }

    /* ================= 群开关（*鲲开/关） ================= */

    /** 返回 false 表示「本条不应继续处理」 */
    async function handleSwitch(msg, gid, uid, text) {
      if (!left(text, 5).startsWith('*鲲')) return { pass: true, text };
      // 原版要求 @ 机器人（解析 CQ 码取 toQQ 与登录 QQ 比对）
      if (!msg.mentioned) return { pass: true, text };
      const role = await roleOf(msg);
      if (role < 2) {
        say(msg, at(uid) + '对不起，你没有管理权限！');
        return { pass: false };
      }
      const on = text.includes('开') ? '开' : '关';
      await mutateG(gid, (g) => {
        g.on = on;
      });
      let w = '开局一只鲲，进化全靠吞！' + '\n' + '游戏已' + on;
      if (on === '开') w += '\n' + '各位饲鲲主快来一试身手吧！';
      say(msg, w);
      return { pass: false };
    }

    /* ================= 签到 ================= */

    async function doSign(msg, gid, uid) {
      const today = String(new Date().getDate());
      const p = await readP(gid, uid);
      if (p.sg === today) {
        const j = p.j - 10;
        await mutateP(gid, uid, p.nm, (x) => {
          x.j = j;
        });
        say(
          msg,
          at(uid) + '请勿重复签到！' + '\n' + '获得惩罚：节操-10' + '\n' +
          '-------------------' + '\n' + '剩余' + toText(j) + '节操',
        );
        return;
      }
      const eggs = rand(10, 20);
      const jiecao = rand(30, 100);
      await mutateP(gid, uid, p.nm, (x) => {
        x.sg = today;
        x.l = 0;
        x.e += eggs;
        x.j += jiecao;
        x.tl = TRAIN_PER_DAY;
      });
      say(
        msg,
        at(uid) + '签到成功！' + '\n' + '获得奖励：' + '\n' +
        toText(eggs) + '颗蛋' + '\n' + toText(jiecao) + '节操' + '\n' + '磨炼次数回复至30',
      );
    }

    /* ================= 买蛋（5 节操一颗） ================= */

    async function buyEgg(msg, gid, uid, argText) {
      const p = await readP(gid, uid);
      if (p.j <= 0) {
        say(
          msg,
          at(uid) + '你已经节操丧尽！不能买蛋！' + '\n' + '-------------------' + '\n' +
          '节操可以通过每日【*签到】或【*喝鸡汤】或玩♂【*当前游戏】获取',
        );
        return;
      }
      if (p.j < 5) {
        say(
          msg,
          at(uid) + '\n' + ' 5节操去渡劫，运气不好鲲永别！' + '\n' +
          '你不如来买蛋，节操换蛋真划算！' + '\n' +
          '买一个孵只鲲，要是太轻会被吞！' + '\n' +
          '你不如买一对，一个孵化一个喂！' + '\n' +
          '要是喂完还被吞，这个仇人记在心！' + '\n' +
          '回头再来买一斤，砸出神器袭他鲲!' + '\n' +
          '不行还要买一打，直接往他头上砸！' + '\n' +
          '瞧一瞧，看一看，5节操一颗蛋！' + '\n' +
          '走一走，转一转，节操不够靠边站！' + '\n' + '\n' +
          '节操不足！' + '\n' + '当前节操' + toText(p.j) + '\n' + '-------------------' + '\n' +
          '节操可以通过每日【*签到】或【*喝鸡汤】或玩♂【*当前游戏】获取',
        );
        return;
      }
      let a = toNum(argText);
      if (a <= 0) a = 1;
      const b = a * 5;
      if (p.j < b) {
        say(
          msg,
          at(uid) + '节操不足！' + '\n' + toText(a) + '颗蛋需要' + toText(b) + '节操' + '\n' +
          '-------------------' + '\n' + '当前节操' + toText(p.j) + '\n' + '剩余' + toText(p.e) + '颗蛋',
        );
        return;
      }
      await mutateP(gid, uid, p.nm, (x) => {
        x.j -= b;
        x.e += a;
      });
      say(
        msg,
        at(uid) + '你和群主发生了PY交易，群主很满意，送了你' + toText(a) + '颗蛋' + '\n' +
        '节操-' + toText(b) + '\n' + '-------------------' + '\n' +
        '当前节操' + toText(p.j - b) + '\n' + '剩余' + toText(p.e + a) + '颗蛋',
      );
    }

    /* ================= 砸蛋（运势决定出货） ================= */

    async function smashEgg(msg, gid, uid, argText, q) {
      const p = await readP(gid, uid);
      if (p.e <= 0) {
        const t = q
          ? q + '\n' + '你没有蛋了！'
          : at(uid) + '你没有蛋了！';
        say(msg, t + '\n' + '通过每日【*签到】或【*买蛋】可以获取蛋');
        return;
      }
      let a = toNum(argText);
      if (a > MAX_EGG_BATCH) {
        const t = q ? q + '\n' + '最多同时砸100颗蛋！' : at(uid) + '最多同时砸100颗蛋！';
        say(msg, t);
        return;
      }
      if (a <= 0) a = 1;
      if (a > p.e) {
        const t = q
          ? q + '\n' + '你没有足够的蛋！'
          : at(uid) + '你没有足够的蛋！';
        say(msg, t + '\n' + '剩余' + toText(p.e) + '颗蛋');
        return;
      }
      const luck = await fortune(gid, uid);   // 原版这里调的是 运势()，不是好运
      let got = '';
      let used = 0;
      let gotX = 0;
      let gotY = 0;
      for (let i = 1; i <= a; i++) {
        used++;
        await mutateP(gid, uid, p.nm, (x) => {
          x.e -= 1;
        });
        const x1 = rand(1, 200);
        if (x1 <= luck) {
          const x2 = rand(1, 100);
          if (x2 >= 1 && x2 <= 30) {
            gotY = (await readP(gid, uid)).s;
            const add = rand(1, 5);
            gotY += add;
            gotX = add;
            await mutateP(gid, uid, p.nm, (x) => {
              x.s = gotY;
            });
            got = '神器';
            break;
          }
          if (x2 >= 31 && x2 <= 60) {
            gotY = (await readP(gid, uid)).h;
            const add = rand(1, 20);
            gotY += add;
            gotX = add;
            await mutateP(gid, uid, p.nm, (x) => {
              x.h = gotY;
            });
            got = '幻化丹';
            break;
          }
          if (x2 >= 61 && x2 <= 90) {
            gotY = (await readP(gid, uid)).p + 1;
            gotX = 1;
            await mutateP(gid, uid, p.nm, (x) => {
              x.p = gotY;
            });
            got = '鸡汤';
            break;
          }
          if (x2 >= 91 && x2 <= 100) {
            gotY = (await readP(gid, uid)).r + 1;
            gotX = 1;
            await mutateP(gid, uid, p.nm, (x) => {
              x.r = gotY;
            });
            got = '复活药';
            break;
          }
        }
      }
      const leftEggs = (await readP(gid, uid)).e;
      const head = (q ? q + '\n' : at(uid)) + '今日运势' + toText(luck);
      if (got === '') {
        const body =
          used === 1
            ? '他狠心砸开了一颗蛋！里面并没有奖品，只有一只尚未成型的鲲宝宝。悔恨的泪水止不住的流。。。'
            : '他狠心砸开了' + toText(used) + '颗蛋！里面并没有奖品，全是尚未成型的鲲宝宝。悔恨的泪水止不住的流。。。';
        say(msg, head + '\n' + body + '\n' + '-------------------' + '\n' + '剩余' + toText(leftEggs) + '颗蛋');
        return;
      }
      if (got === '神器') {
        say(
          msg,
          head + '\n' + '恭喜你砸出了上古神器' + '\n' + SHENQI1 + '\n' + SHENQI2 + '\n' +
          toText(gotX) + '把' + '\n' + '-------------------' + '\n' +
          '现有' + SHENQI + ' ' + toText(gotY) + '\n' +
          '消耗' + toText(used) + '颗蛋' + '\n' + '剩余' + toText(leftEggs) + '颗蛋',
        );
        return;
      }
      if (got === '幻化丹') {
        say(
          msg,
          head + '\n' + '恭喜你砸出了' + '\n' + '幻化丹×' + toText(gotX) + '\n' +
          '-------------------' + '\n' + '现有幻化丹' + toText(gotY) + '\n' +
          '消耗' + toText(used) + '颗蛋' + '\n' + '剩余' + toText(leftEggs) + '颗蛋',
        );
        return;
      }
      if (got === '鸡汤') {
        say(
          msg,
          head + '\n' + '恭喜你砸出了' + '\n' + '一碗鸡汤' + '\n' +
          '-------------------' + '\n' + '现有鸡汤' + toText(gotY) + '\n' +
          '消耗' + toText(used) + '颗蛋' + '\n' + '剩余' + toText(leftEggs) + '颗蛋',
        );
        return;
      }
      say(
        msg,
        head + '\n' + '恭喜你砸出了' + '\n' + '一粒复活药' + '\n' +
        '-------------------' + '\n' + '现有复活药' + toText(gotY) + '\n' +
        '消耗' + toText(used) + '颗蛋' + '\n' + '剩余' + toText(leftEggs) + '颗蛋',
      );
    }

    /* ================= 孵化 ================= */

    async function hatch(msg, gid, uid) {
      const p = await readP(gid, uid);
      if (p.n) {
        say(
          msg,
          at(uid) + '你已经拥有一只鲲了，开始吞吧' + '\n' + kunWith(p) + '\n' +
          '体重' + toText(p.w) + '千克' + '\n' + '剩余' + toText(p.e) + '颗蛋' + '\n' +
          '-------------------' + '\n' + '发送【*喂食】可以用多余的蛋喂养鲲哦',
        );
        return;
      }
      if (p.e === 0) {
        say(
          msg,
          at(uid) + '你并没有蛋！' + '\n' + '通过每日【*签到】或【*买蛋】可以获取蛋',
        );
        return;
      }
      const name = KUN_NAMES[rand(1, 50) - 1];
      const attr = rollAttr();
      let weight = rand(20, 100);
      if (attr === '悲') {
        // 原版：遍历全群找最重的鲲，体重 = 1000 + 它
        let max = 0;
        for (const { p: q } of await eachPlayer(gid)) {
          if (q.n && q.w > max) max = q.w;
        }
        weight = 1000 + max;
      }
      await mutateP(gid, uid, p.nm, (x) => {
        x.tl = TRAIN_PER_DAY;
        x.e -= 1;
        x.n = name;
        x.w = weight;
        if (attr !== '无') x.a = attr;
      });
      say(
        msg,
        at(uid) + '恭喜你获得一只' + attr + '属性' + name + '\n' +
        '体重' + toText(weight) + '千克' + '\n' + '-------------------' + '\n' +
        '剩余' + toText(p.e - 1) + '颗蛋',
      );
    }

    /** 鲲属性()：1/140 每种前七种，1/140 悲，其余无 */
    function rollAttr() {
      const x = rand(1, 140);
      if (x >= 1 && x <= 3) return '傲';
      if (x >= 4 && x <= 6) return '妒';
      if (x >= 7 && x <= 9) return '怒';
      if (x >= 10 && x <= 12) return '惰';
      if (x >= 13 && x <= 15) return '贪';
      if (x >= 16 && x <= 18) return '馋';
      if (x >= 19 && x <= 21) return '淫';
      if (x === 22) return '悲';
      return '无';
    }

    /* ================= 扔蛋 ================= */

    async function throwEgg(msg, gid, uid, argText) {
      const p = await readP(gid, uid);
      if (p.e === 0) {
        say(
          msg,
          at(uid) + '你并没有蛋！' + '\n' + '通过每日【*签到】或【*买蛋】可以获取蛋',
        );
        return;
      }
      await mutateP(gid, uid, p.nm, (x) => {
        x.e -= 1;
      });
      const target = parseTarget(argText, msg);
      const tp = await readP(gid, target.id);
      if (!target.id) {
        say(msg, at(uid) + '蛋太多了，扔一个玩' + '\n' + '剩余' + toText(p.e - 1) + '颗蛋');
        return;
      }
      const nick2 = tp.nm || target.id;
      if (uid === target.id) {
        const luck = p.l - 1;
        await mutateP(gid, uid, p.nm, (x) => {
          x.l = luck;
        });
        say(
          msg,
          at(uid) + '向自己头上扔了一颗蛋！' + '\n' + '运势-1' + '\n' +
          '（大家快看，这有个大傻[消音]！）' + '\n' + '-------------------' + '\n' +
          '剩余' + toText(p.e - 1) + '颗蛋',
        );
        return;
      }
      const x = rand(1, 100);
      if (x >= 1 && x <= 15) {
        await mutateP(gid, target.id, tp.nm, (t) => {
          t.e += 1;
        });
        say(
          msg,
          at(uid) + '\n' + nick2 + '眼疾手快，稳稳的接住了你的蛋并随手向你比了个心！[表情]' + '\n' +
          '-------------------' + '\n' + '剩余' + toText(p.e - 1) + '颗蛋',
        );
        return;
      }
      if (x >= 16 && x <= 50) {
        say(
          msg,
          at(uid) + '\n' + nick2 + '闪转腾挪，躲开了你的蛋，还随手向你比了个心！[表情]' + '\n' +
          '-------------------' + '\n' + '剩余' + toText(p.e - 1) + '颗蛋',
        );
        return;
      }
      if (x >= 51 && x <= 85) {
        const tl = tp.l - 2;
        await mutateP(gid, target.id, tp.nm, (t) => {
          t.l = tl;
        });
        say(
          msg,
          at(uid) + '\n' + '你砸中了' + nick2 + '\n' + '获得称号：蛋无虚发' + '\n' +
          '-------------------' + '\n' + '剩余' + toText(p.e - 1) + '颗蛋',
        );
        sayNow(msg, at(target.id) + '你中蛋了！运势-2');
        return;
      }
      // 86-100
      const tl = tp.l - 5;
      await mutateP(gid, target.id, tp.nm, (t) => {
        t.l = tl;
      });
      say(
        msg,
        at(uid) + '\n' + nick2 + '闪转腾挪，躲开了你的蛋，还随手向你比了个心！[表情]' + '\n' +
        '-------------------' + '\n' + '剩余' + toText(p.e - 1) + '颗蛋',
      );
      sayNow(msg, at(target.id) + '你躲开了' + (p.nm || uid) + '的蛋' + '\n' + '却不小心摔在了一坨狗屎上！运势-5');
    }

    /* ================= 查询 ================= */

    async function query(msg, gid, uid) {
      const p = await readP(gid, uid);
      const g = await readG(gid);
      let w =
        '\n' + '=============' + '\n' + '蛋×' + toText(p.e) + '\n' + '节操' + toText(p.j);
      if (p.s > 0) w += '\n' + SHENQI + '×' + toText(p.s);
      if (p.h > 0) w += '\n' + '幻化丹×' + toText(p.h);
      if (p.r > 0) w += '\n' + '复活药×' + toText(p.r);
      if (p.p > 0) w += '\n' + '鸡汤×' + toText(p.p);
      if (p.n) {
        let k = kunWith(p);
        if (p.li === 1) k += '(拍卖中' + toText(g.au.bd) + ')';
        w = '\n' + k + '\n' + '体重' + toText(p.w) + w;   // 原版这里不带「千克」
      } else {
        w = '\n' + '你还没有鲲！' + '\n' + '发送【*孵化】获取鲲' + w;
      }
      say(msg, at(uid) + w);
    }

    /* ================= 复活（还阳） ================= */

    async function revive(msg, gid, uid) {
      const p = await readP(gid, uid);
      if (p.n) {
        say(msg, at(uid) + kunWith(p) + '：' + '“老子还没死呢！”');
        return;
      }
      if (p.r <= 0) {
        say(
          msg,
          at(uid) + '你没有复活药！' + '\n' + '-------------------' + '\n' + '通过【*砸蛋】可以获取复活药',
        );
        return;
      }
      if (p.dc === 0) {
        say(
          msg,
          at(uid) + '复活失败！' + '\n' + '可能原因：属性鲲、放生鲲、自己强袭致死鲲无法复活',
        );
        return;
      }
      await mutateP(gid, uid, p.nm, (x) => {
        x.r -= 1;
        x.n = x.dk;
        x.w = x.dw;
      });
      say(
        msg,
        at(uid) + '起！死！回！生！' + '\n' + p.dk + '已经复活' + '\n' +
        '体重' + toText(p.dw) + '\n' + '-------------------' + '\n' +
        '剩余复活药' + toText(p.r - 1) + '\n' + '（注：属性鲲是无法复活的）',
      );
    }

    /* ================= 目标解析（@人或 openid） ================= */

    /**
     * 原版从正文里剥掉 [CQ:at,qq= 和 ] 后到数值。
     * 官方机器人：优先用 msg.mentions（框架已剥好），否则认纯数字/openid 文本。
     * 认不出来返回空串——原版对应 toQQ=0 的分支。
     */
    function parseTarget(argText, msg) {
      const m = (msg?.mentions ?? []).find((x) => !x.isBot);
      if (m?.id) return { id: m.id, boss: false };
      const t = String(argText ?? '').trim();
      if (t === 'BOSS' || t === 'boss') return { id: '', boss: true };
      if (/^\d+$/.test(t)) return { id: t, boss: false };
      if (/^[0-9A-Za-z]{8,}$/.test(t)) return { id: t, boss: false };
      return { id: '', boss: false };
    }

    /* ================= 喂食 ================= */

    async function feed(msg, gid, uid, argText) {
      const p = await readP(gid, uid);
      const g = await readG(gid);
      if (p.li === 1) {
        say(
          msg,
          at(uid) + '你的' + kunWith(p) + '正在拍卖，无法喂食！' + '\n' +
          '当前竞价' + toText(g.au.bd) + '节操',
        );
        return;
      }
      if (!p.n) {
        say(
          msg,
          at(uid) + '你并没有鲲！' + '\n' + '剩余' + toText(p.e) + '颗蛋' + '\n' +
          '-------------------' + '\n' + '发送【*孵化】获取鲲',
        );
        return;
      }
      if (p.e <= 0) {
        say(
          msg,
          at(uid) + '你没有蛋了！' + '\n' + '通过每日【*签到】或【*买蛋】可以获取蛋',
        );
        return;
      }
      let a = toNum(argText);
      if (a > MAX_EGG_BATCH) {
        say(msg, at(uid) + '最多同时喂食100颗蛋！');
        return;
      }
      if (a <= 0) a = 1;
      if (a > p.e) {
        say(
          msg,
          at(uid) + '你没有足够的蛋！' + '\n' + '现有' + toText(p.e) + '颗蛋',
        );
        return;
      }
      let gain = 0;
      let weight = p.w;
      const shownKun = kunWith(p);   // 原版在循环前捕获鲲名，暴毙后的总结消息仍用它
      for (let i = 1; i <= a; i++) {
        const cur = await readP(gid, uid);
        await mutateP(gid, uid, cur.nm, (x) => {
          x.e -= 1;
        });
        weight = cur.w;
        const x = rand(1, 100);
        weight += x;
        gain += x;
        await mutateP(gid, uid, cur.nm, (y) => {
          y.w = weight;
        });
        if (cur.a === '馋' && weight > 1000) {
          await mutateP(gid, uid, cur.nm, (y) => {
            y.dc = 0;
            y.n = '';
            y.a = '';
          });
          say(
            msg,
            at(uid) + '你的' + shownKun + '因暴食而死！' + '\n' + '人为鸟死，鲲为食亡！',
          );
          break;
        }
      }
      const fin = await readP(gid, uid);
      say(
        msg,
        at(uid) + '你的' + shownKun + '体重增加了' + toText(gain) + '千克' + '\n' +
        '现体重为' + toText(weight) + '千克' + '\n' + '-------------------' + '\n' +
        '剩余' + toText(fin.e) + '颗蛋',
      );
    }

    /* ================= 喝鸡汤 ================= */

    async function drinkSoup(msg, gid, uid, argText) {
      const p = await readP(gid, uid);
      if (p.p <= 0) {
        say(msg, at(uid) + '你没有鸡汤了！' + '\n' + '【*砸蛋】可以获得鸡汤');
        return;
      }
      let a = toNum(argText);
      if (a < 0) {
        say(msg, at(uid) + '请输入正确数量！');
        return;
      }
      if (a === 0) a = 1;
      if (a !== 1 && a > p.p) {
        say(
          msg,
          at(uid) + '你没有足够的鸡汤！' + '\n' + '现有鸡汤' + toText(p.p),
        );
        return;
      }
      const soup = p.p - a;
      const jiecao = p.j + a * 10;
      await mutateP(gid, uid, p.nm, (x) => {
        x.p = soup;
        x.j = jiecao;
      });
      say(
        msg,
        at(uid) + '喝了' + toText(a) + '碗鸡汤，节操+' + toText(a * 10) + '！' + '\n' +
        '--------------------' + '\n' + '剩余鸡汤' + toText(soup) + '\n' + '节操' + toText(jiecao),
      );
    }

    /* ================= 磨炼 ================= */

    async function train(msg, gid, uid, argText, q) {
      const p = await readP(gid, uid);
      if (!p.n) {
        const t = q ? q + '\n' + '你还没有鲲！' : at(uid) + '你还没有鲲！';
        say(msg, t + '\n' + '发送【*孵化】获取鲲');
        return;
      }
      const g = await readG(gid);
      if (p.li === 1) {
        const t = q
          ? q + '\n' + '你的' + kunWith(p) + '正在拍卖，无法磨炼！'
          : at(uid) + '你的' + kunWith(p) + '正在拍卖，无法磨炼！';
        say(msg, t + '\n' + '当前竞价' + toText(g.au.bd) + '节操');
        return;
      }
      if (p.tl <= 0) {
        const t = q ? q + '\n' + '今日磨炼次数已用完！' : at(uid) + '今日磨炼次数已用完！';
        say(msg, t + '\n' + '每日【*签到】或【*孵化】可将磨炼次数回复至30');
        return;
      }
      if (p.j <= 0) {
        const t = q ? q + '\n' + '你已节操丧尽！无法磨炼！' : at(uid) + '你已节操丧尽！无法磨炼！';
        say(
          msg,
          t + '\n' + '-------------------' + '\n' +
          '节操可以通过每日【*签到】或【*喝鸡汤】或玩♂【*当前游戏】获取',
        );
        return;
      }
      let cost = 30;
      if (p.j < cost) {
        const t = q ? q + '\n' : at(uid);
        say(
          msg,
          t + '节操不足' + toText(cost) + '！' + '无法磨炼！' + '\n' +
          '当前节操' + toText(p.j) + '\n' + '-------------------' + '\n' +
          '节操可以通过每日【*签到】或【*喝鸡汤】或玩♂【*当前游戏】获取',
        );
        return;
      }
      let value = toNum(argText);
      if (value > p.w) {
        const t = q ? q + '\n' : at(uid);
        say(
          msg,
          t + '不行不行，这么练会死的！' + '\n' + '磨炼数值不能大于体重！' + '\n' + toText(p.w) + '千克',
        );
        return;
      }
      await mutateP(gid, uid, p.nm, (x) => {
        x.tl -= 1;
      });
      if (p.a === '贪') {
        if (rand(1, 100) <= 70) cost = 0;
      }
      const jiecao = p.j - cost;
      await mutateP(gid, uid, p.nm, (x) => {
        x.j = jiecao;
      });
      if (value <= 0) value = 1;
      const roll = rand(1, p.w);
      let pct = trunc((value / p.w) * 100);
      if (pct <= 0) pct = 1;
      const pre = q ? q + '\n' : at(uid);
      if (roll <= value) {
        const gain = p.w - value;
        const w2 = p.w * 2 - value;
        await mutateP(gid, uid, p.nm, (x) => {
          x.w = w2;
        });
        say(
          msg,
          pre + '磨炼成功！' + '【' + toText(pct) + '%】 ' + '\n' + kunWith(p) + '\n' +
          '体重增加' + toText(gain) + '千克' + '\n' +
          toText(p.w) + '千克>>>>>' + toText(w2) + '千克' + '\n' +
          '--------------------' + '\n' + '节操-' + toText(cost) + '\n' +
          '剩余节操' + toText(jiecao) + '\n' +
          '（成功率=磨炼数值/总体重×100%）' + '\n' + '（减少体重=磨炼数值）' + '\n' + '（增加体重=总体重-磨炼数值）',
        );
        if (p.a === '馋' && w2 > 1000) {
          await mutateP(gid, uid, p.nm, (x) => {
            x.n = '';
            x.a = '';
          });
          say(msg, pre + '你的' + kunWith(p) + '因暴食而死！' + '\n' + '人为鸟死，鲲为食亡！');
          return;
        }
        return;
      }
      const w2 = p.w - value;
      await mutateP(gid, uid, p.nm, (x) => {
        x.w = w2;
      });
      say(
        msg,
        pre + '磨炼失败！' + '【' + toText(pct) + '%】 ' + '\n' + kunWith(p) + '\n' +
        '体重减少' + toText(value) + '千克' + '\n' +
        toText(p.w) + '千克>>>>>' + toText(w2) + '千克' + '\n' +
        '--------------------' + '\n' + '节操-' + toText(cost) + '\n' +
        '剩余节操' + toText(jiecao) + '\n' +
        '（成功率=磨炼数值/总体重×100%）' + '\n' + '（增加/减少体重=磨炼数值）' + '\n' + '（增加体重=总体重-磨炼数值）',
      );
    }

    /* ================= 幻化 ================= */

    async function transform(msg, gid, uid, q) {
      const p = await readP(gid, uid);
      if (!p.n) {
        const t = q ? q + '\n' + '你还没有鲲！' : at(uid) + '你还没有鲲！';
        say(msg, t + '\n' + '发送【*孵化】获取鲲');
        return;
      }
      if (p.h <= 0) {
        // 原版两个分支都发群消息（else 分支也发群消息），保持一样
        say(msg, at(uid) + '你没有幻化丹！' + '\n' + '【*砸蛋】可以获取幻化丹');
        return;
      }
      if (p.a === '悲') {
        const t = q ? q + '\n' + '悲属性的鲲无法幻化！' : at(uid) + '悲属性的鲲无法幻化！';
        say(msg, t);
        return;
      }
      const g = await readG(gid);
      if (p.li === 1) {
        const t = q
          ? q + '\n' + '你的' + kunWith(p) + '正在拍卖，无法幻化！'
          : at(uid) + '你的' + kunWith(p) + '正在拍卖，无法幻化！';
        say(msg, t + '\n' + '当前竞价' + toText(g.au.bd) + '节操');
        return;
      }
      const dan = p.h - 1;
      let cost = trunc((p.w * rand(1, 10)) / 100);
      if (cost < 10) cost = 10;
      if (p.a === '馋') cost = 0;
      const weight = p.w - cost;
      const pre = q ? q + '\n' : at(uid);
      const shown = kunWith(p);
      if (rand(1, 100) > 30) {
        // 幻化失败
        await mutateP(gid, uid, p.nm, (x) => {
          x.h = dan;
          x.w = weight;
        });
        say(
          msg,
          pre + '幻化失败！' + '\n' + '消耗' + toText(cost) + '千克体重' + '\n' +
          '剩余体重' + toText(weight) + '千克' + '\n' + '剩余幻化丹' + toText(dan),
        );
        if (weight <= 0) {
          await mutateP(gid, uid, p.nm, (x) => {
            x.dc = 1;
            x.dk = x.n;
            x.dw = weight + cost;
            x.n = '';
            x.a = '';
          });
          say(msg, pre + '世事难预料！你的' + shown + '就这么没了！' + '\n' + '再接再厉吧');
        }
        return;
      }
      // 幻化成功
      const attr = HUAHUA_ATTRS[rand(1, 7) - 1];
      await mutateP(gid, uid, p.nm, (x) => {
        x.h = dan;
        x.w = weight;
        x.a = attr;
      });
      const fresh = await readP(gid, uid);
      const kunNew = '[' + attr + ']' + fresh.n;
      say(
        msg,
        pre + '幻化成功！' + '\n' + shown + '>>>>>' + kunNew + '\n' +
        '消耗' + toText(cost) + '千克体重' + '\n' + '剩余体重' + toText(weight) + '千克' + '\n' +
        '剩余幻化丹' + toText(dan),
      );
      if (shown === kunNew) {
        // 属性未变，返还幻化丹
        const back = dan + 1;
        await mutateP(gid, uid, p.nm, (x) => {
          x.h = back;
        });
        say(msg, pre + '属性未发生变化，返还幻化丹' + '\n' + '剩余幻化丹' + toText(back));
      }
      if (weight <= 0) {
        await mutateP(gid, uid, p.nm, (x) => {
          x.dc = 1;
          x.dk = x.n;
          x.dw = weight + cost;
          x.n = '';
          x.a = '';
        });
        say(msg, pre + '世事难预料！你的' + kunNew + '就这么没了！' + '\n' + '再接再厉吧');
      }
    }

    /* ================= 渡劫 ================= */

    async function tribulate(msg, gid, uid) {
      const p = await readP(gid, uid);
      if (!p.n) {
        say(msg, at(uid) + '你还没有鲲！' + '\n' + '发送【*孵化】获取鲲');
        return;
      }
      const g = await readG(gid);
      if (p.li === 1) {
        say(
          msg,
          at(uid) + '你的' + kunWith(p) + '正在拍卖，无法渡劫！' + '\n' +
          '当前竞价' + toText(g.au.bd) + '节操',
        );
        return;
      }
      if (!p.a || p.a === '无') {
        say(
          msg,
          at(uid) + '无属性的鲲无法渡劫！' + '\n' + '通过【*幻化】可以获得属性',
        );
        return;
      }
      if (p.j <= 0) {
        say(
          msg,
          at(uid) + '你已经节操丧尽！无法渡劫！' + '\n' + '-------------------' + '\n' +
          '节操可以通过每日【*签到】或【*喝鸡汤】或玩♂【*当前游戏】获取',
        );
        return;
      }
      if (p.j < 10) {
        say(
          msg,
          at(uid) + '节操不足10！无法渡劫！' + '\n' + '当前节操' + toText(p.j) + '\n' +
          '-------------------' + '\n' + '节操可以通过每日【*签到】或【*喝鸡汤】或玩♂【*当前游戏】获取',
        );
        return;
      }
      const jiecao = p.j - 10;
      const shown = kunWith(p);
      if (rand(1, 2) === 1) {
        // 渡劫失败
        const x = rand(1, 9);
        let bar = '';
        for (let i = 1; i <= 10; i++) bar += i <= x ? '■' : '□';
        await mutateP(gid, uid, p.nm, (y) => {
          y.j = jiecao;
          y.dc = 0;
          y.n = '';
          y.a = '';
        });
        say(
          msg,
          at(uid) + '渡劫失败！' + '\n' + '进度' + '\n' + bar +
          toText(x) + toText(rand(0, 9)) + '%' + '\n' +
          '你的' + shown + '粉身碎骨灰飞烟灭！' + '\n' + '-------------------' + '\n' +
          '剩余节操' + toText(jiecao),
        );
        return;
      }
      // 渡劫成功
      const w5 = p.w * 5;
      await mutateP(gid, uid, p.nm, (y) => {
        y.j = jiecao;
        y.w = w5;
        y.n = y.n + '★';
      });
      say(
        msg,
        at(uid) + '渡劫成功！' + '\n' + '进度' + '\n' + '■■■■■■■■■■100%' + '\n' +
        shown + '>>>>>' + shown + '★' + '\n' +
        '体重' + toText(p.w) + '千克' + '>>>>>' + toText(w5) + '千克' + '\n' +
        '-------------------' + '\n' + '剩余节操' + toText(jiecao),
      );
    }

    /* ================= 放生 ================= */

    async function release(msg, gid, uid) {
      const p = await readP(gid, uid);
      if (!p.n) {
        say(msg, at(uid) + '你并没有鲲！' + '\n' + '发送【*孵化】获取鲲');
        return;
      }
      const g = await readG(gid);
      if (p.li === 1) {
        say(
          msg,
          at(uid) + '你的' + kunWith(p) + '正在拍卖，无法放生！' + '\n' +
          '当前竞价' + toText(g.au.bd) + '节操',
        );
        return;
      }
      const shown = kunWith(p);
      const jiecao = p.j + 2;
      await mutateP(gid, uid, p.nm, (x) => {
        x.dc = 0;
        x.n = '';
        x.a = '';
        x.j = jiecao;
      });
      if (p.a !== '贪') {
        say(
          msg,
          at(uid) + '你放生了一条' + shown + '\n' + '功德无量！随喜赞叹！节操+（2）！' + '\n' +
          '-------------------' + '\n' + '现有节操' + toText(jiecao),
        );
        return;
      }
      const eggs = rand(2, 10);
      await mutateP(gid, uid, p.nm, (x) => {
        x.e += eggs;
      });
      say(
        msg,
        at(uid) + '你放生了一条' + shown + '\n' + '意外获得了' + toText(eggs) + '颗蛋' + '\n' +
        '功德无量！随喜赞叹！节操+（2）！' + '\n' + '-------------------' + '\n' +
        '现有' + toText(p.e + eggs) + '颗蛋',
      );
    }

    /* ================= 排行 ================= */

    async function rank(msg, gid) {
      const players = await eachPlayer(gid);
      // 原版的插入排序：前十名，重的大者居前
      const d = new Array(10).fill(null);
      for (const { uid, p } of players) {
        if (!p.n) continue;
        for (let j = 0; j < 10; j++) {
          const cur = d[j];
          const curW = cur ? cur.w : 0;
          if (p.w > curW) {
            for (let k = 9; k > j; k--) d[k] = d[k - 1];
            d[j] = { uid, ...p };
            break;
          }
        }
      }
      let w = '====排=行=榜====';
      for (let i = 0; i < 10; i++) {
        const e = d[i];
        if (!e) break;
        const nick = e.nm || e.uid;
        let k = kunWith(e);
        if (e.li === 1) k += '（在售）';
        w += '\n' + toText(i + 1) + '.' + nick + '\n' + '   ' + k + ' ◇' + toText(e.w) + '千克';
      }
      say(msg, w);
    }

    /* ================= 对抗共用 ================= */

    /**
     * 击杀一名玩家（原版每个死亡分支都是这四行）。
     * attr 是该玩家鲲的属性；空/无属性才留全尸（死因=1），属性鲲死因=0 不能复活。
     */
    async function killPlayer(gid, uid, attr, kunName, deadWeight) {
      // 原版模式：无属性才留全尸（死因=1 + 死鲲/死重），属性鲲死因=0 且不留
      await mutateP(gid, uid, '', (x) => {
        if (attr === '' || attr === '无') {
          x.dc = 1;
          x.dk = kunName;
          x.dw = deadWeight;
        } else {
          x.dc = 0;
        }
        x.n = '';
        x.a = '';
      });
    }

    /** 属性克制（原版 属性克制()） */
    function restrain(attrA, attrB, who) {
      if (attrA === '傲') attrB = '';
      if (attrB === '傲') attrA = '';
      if (attrA === '怒' && attrB === '惰') {
        attrA = '';
        attrB = '';
      }
      if (who === 'A') return attrA;
      if (who === 'B') return attrB;
      return '';
    }

    /** 吞噬2：算双方的吞噬力。返回 [A, B] */
    function devour2(gid, uid, wA, wB, attrA, attrB) {
      if (attrA === '贪' && rand(1, 100) <= 30) {
        // 贪：下蛋
        void (async () => {
          const p = await readP(gid, uid);
          const eggs = p.e + 1;
          await mutateP(gid, uid, p.nm, (x) => {
            x.e = eggs;
          });
        })();
      }
      let A = trunc((wA * rand(25, 75)) / 100);
      let B = trunc((wB * rand(25, 75)) / 100);
      if (attrA === '怒') {
        A = trunc((wA * rand(50, 90)) / 100);
        B = trunc((wB * rand(25, 55)) / 100);
      }
      if (attrB === '惰') {
        A = trunc((wA * rand(25, 55)) / 100);
        B = trunc((wB * rand(50, 90)) / 100);
      }
      if (attrB === '妒' && wA > wB) {
        A = -1;
        B = -1;
      }
      return [A, B];
    }

    /* ================= 吞噬 ================= */

    async function devour(msg, gid, uid, argText, jiecao) {
      let fix = 0;   // 节操修正
      const self = await readP(gid, uid);
      const attrA0 = self.a;
      let kunA = self.n;
      if (attrA0 !== '无' && attrA0 !== '') kunA = `[${attrA0}]${kunA}`;
      const g = await readG(gid);
      if (self.li === 1) {
        say(
          msg,
          at(uid) + '你的' + kunA + '正在拍卖，无法吞噬！' + '\n' + '当前竞价' + toText(g.au.bd) + '节操',
        );
        return 1;
      }
      if (!self.n) {
        say(msg, at(uid) + '你还没有鲲！' + '\n' + '发送【*孵化】可获得鲲');
        return 1;
      }
      const tgt = parseTarget(argText, msg);
      if (tgt.boss) return devourBoss(msg, gid, uid, jiecao);
      if (!tgt.id) return 1;
      if (uid === tgt.id) {
        say(
          msg,
          at(uid) + '暴怒的作者Agam：' + '“你故意找麻烦是吧？嫌BUG太少是吧？扣你5节操！”' + '\n' +
          '-------------------' + '\n' + '剩余' + toText(jiecao - 10) + '节操',
        );
        return -4;
      }
      const foe = await readP(gid, tgt.id);
      const nick2 = foe.nm || tgt.id;
      if (!foe.n) {
        say(msg, at(uid) + nick2 + '还没有鲲，快邀请他一起♂玩吧');
        return 1;
      }
      const nick1 = self.nm || uid;
      const wA = self.w;
      const wB = foe.w;
      const attrB0 = foe.a;
      let kunB = foe.n;
      if (attrB0 !== '无' && attrB0 !== '') kunB = `[${attrB0}]${kunB}`;
      if (foe.li === 1) {
        say(
          msg,
          at(uid) + nick2 + '的' + kunB + '正在拍卖，无法吞噬！' + '\n' + '当前竞价' + toText(g.au.bd) + '节操',
        );
        return 1;
      }
      if (wA > wB * 8) {
        say(
          msg,
          at(uid) + nick2 + '的' + kunB + '太小了！养肥了再吞吧' + '\n' + '-------------------' + '\n' +
          '剩余' + toText(jiecao + 1) + '节操',
        );
        return 1;
      }
      let attrA = restrain(attrA0, attrB0, 'A');
      let attrB = restrain(attrA, attrB0, 'B');
      const [A, B] = devour2(gid, uid, wA, wB, attrA, attrB);
      // 怒：25% 致命一击
      if (attrA === '怒' && attrB !== '傲') {
        if (A === -1 && B === -1) {
          say(
            msg,
            at(uid) + '无法对' + nick2 + '的' + kunB + '发起吞噬！' + '\n' + '-------------------' + '\n' +
            '剩余' + toText(jiecao) + '节操',
          );
          return fix;
        }
        if (rand(1, 100) <= 25) {
          const nb = wB - wA;
          await mutateP(gid, tgt.id, foe.nm, (x) => {
            x.w = nb;
          });
          say(
            msg,
            nick1 + '的' + kunA + '对' + nick2 + '的' + kunB + '发动了致命一击！' + '\n' +
            '-------------------' + '\n' + nick2 + '的' + kunB + '体重减少' + toText(wA) +
            '千克，剩余体重' + toText(nb) + '千克',
          );
          if (nb <= 0) {
            await killPlayer(gid, tgt.id, attrB0, foe.n, nb + wA);
            sayNow(msg, at(tgt.id) + '你的' + kunB + '被' + nick1 + '的' + kunA + '干死了！' + '\n' + '友情提示：有仇不报非君子啊！');
            return fix;
          }
        }
      }
      if (A === -1 && B === -1) {
        say(
          msg,
          at(uid) + '无法对' + nick2 + '的' + kunB + '发起吞噬！' + '\n' + '-------------------' + '\n' +
          '剩余' + toText(jiecao) + '节操',
        );
        return fix;
      }
      if (A > B) {
        // 吞噬成功
        const gain = abs(wB - B - B);
        const na = wA + gain;
        await mutateP(gid, uid, self.nm, (x) => {
          x.w = na;
        });
        say(
          msg,
          '吞噬成功！' + '\n' + at(uid) + '的' + kunA + '吞噬了' + nick2 + '的' + kunB + '\n' +
          nick1 + '的' + kunA + '体重增加' + toText(gain) + '千克' + '\n' +
          '现体重：' + toText(na) + '千克' + '\n' + '-------------------' + '\n' +
          nick1 + '剩余' + toText(jiecao) + '节操',
        );
        let x = 0;
        const attrNow = (await readP(gid, uid)).a;
        if (attrNow === '馋' && na > 1000) {
          x = -1;
          // 原版这里只写死因0/写鲲""/写属性""，不留尸体
          await mutateP(gid, uid, self.nm, (y) => {
            y.dc = 0;
            y.n = '';
            y.a = '';
          });
          say(msg, at(uid) + '你的' + kunA + '因暴食而死！' + '\n' + '友情提示：多行不义必自毙！');
        }
        await killPlayer(gid, tgt.id, attrB0, foe.n, wB);
        sayNow(msg, at(tgt.id) + '你的' + kunB + '被吞噬了！' + '\n' + '友情提示：有仇不报非君子啊！');
        if (attrB0 === '淫' && attrA0 !== '傲' && x === 0) {
          if (rand(1, 4) !== 1) {
            await killPlayer(gid, uid, attrNow, self.n, na);
            sayNow(msg, at(uid) + '你的' + kunA + '吞噬了' + nick2 + '的' + kunB + '后身感不适，暴毙身亡！' + '\n' + '你以为我会同情你？我差点笑出声！');
          }
        }
        return fix;
      }
      // 吞噬失败
      let dmgToFoe = A;
      if (attrA === '馋') dmgToFoe = 0;
      const na = wA - B;
      const nb = wB - dmgToFoe;
      await mutateP(gid, uid, self.nm, (x) => {
        x.w = na;
      });
      if (na <= 0) {
        await killPlayer(gid, uid, attrA0, self.n, na + B);
        say(msg, at(uid) + '你的' + kunA + '为食而死！' + '\n' + '吞噬要量力而为啊！');
      }
      await mutateP(gid, tgt.id, foe.nm, (x) => {
        x.w = nb;
      });
      if (nb <= 0) {
        await killPlayer(gid, tgt.id, attrB0, foe.n, nb + na);   // 原版：重B＋重A（重A 已扣减）
        sayNow(msg, at(tgt.id) + '你的' + kunB + '战死了！' + '\n' + '友情提示：有仇不报非君子啊！');
      }
      say(
        msg,
        '吞噬失败！' + '\n' + at(uid) + '的' + kunA + '体重减少' + toText(B) + '千克' + '\n' +
        '剩余体重' + toText(na) + '千克' + '\n' + nick2 + '的' + kunB + '体重减少' + toText(dmgToFoe) + '千克' + '\n' +
        '剩余体重' + toText(nb) + '千克' + '\n' + '-------------------' + '\n' +
        nick1 + '剩余' + toText(jiecao) + '节操',
      );
      return fix;
    }

    /* ================= 攻击 ================= */

    async function attack(msg, gid, uid, argText, jiecao) {
      let fix = 0;
      const self = await readP(gid, uid);
      const attrA0 = self.a;
      let kunA = self.n;
      if (attrA0 !== '无' && attrA0 !== '') kunA = `[${attrA0}]${kunA}`;
      const g = await readG(gid);
      if (self.li === 1) {
        say(
          msg,
          at(uid) + '你的' + kunA + '正在拍卖，无法攻击！' + '\n' + '当前竞价' + toText(g.au.bd) + '节操',
        );
        return 2;
      }
      if (!self.n) {
        say(msg, at(uid) + '你还没有鲲！' + '\n' + '发送【*孵化】可获得鲲');
        return 2;
      }
      const tgt = parseTarget(argText, msg);
      if (tgt.boss) return attackBoss(msg, gid, uid, jiecao);
      if (!tgt.id) return 2;
      if (uid === tgt.id) {
        say(
          msg,
          at(uid) + '暴怒的作者Agam：' + '“你故意找麻烦是吧？嫌BUG太少是吧？扣你5节操！”' + '\n' +
          '-------------------' + '\n' + '剩余' + toText(jiecao - 3) + '节操',
        );
        return -3;
      }
      const foe = await readP(gid, tgt.id);
      const nick2 = foe.nm || tgt.id;
      if (!foe.n) {
        say(msg, at(uid) + nick2 + '还没有鲲，快邀请他一起♂玩吧');
        return 2;
      }
      const nick1 = self.nm || uid;
      const wA = self.w;
      const wB = foe.w;
      const attrB0 = foe.a;
      let kunB = foe.n;
      if (attrB0 !== '无' && attrB0 !== '') kunB = `[${attrB0}]${kunB}`;
      if (foe.li === 1) {
        say(
          msg,
          at(uid) + nick2 + '的' + kunB + '正在拍卖，无法攻击！' + '\n' + '当前竞价' + toText(g.au.bd) + '节操',
        );
        return 2;
      }
      if (attrA0 === '馋') {
        say(msg, at(uid) + '馋属性鲲无法发起攻击！');
        return 2;
      }
      if (wA > wB * 5) {
        say(
          msg,
          at(uid) + nick2 + '的' + kunB + '太小了！以大欺小，胜之不武！放他一马吧！' + '\n' +
          '-------------------' + '\n' + '剩余' + toText(jiecao + 2) + '节操',
        );
        return 2;
      }
      let attrA = restrain(attrA0, attrB0, 'A');
      let attrB = restrain(attrA, attrB0, 'B');
      const [A, B] = attack2(gid, uid, wA, wB, attrA, attrB);
      if (attrA === '怒' && attrB !== '傲') {
        if (A === -1 && B === -1) {
          say(
            msg,
            at(uid) + '无法对' + nick2 + '的' + kunB + '发起攻击！' + '\n' + '-------------------' + '\n' +
            '剩余' + toText(jiecao) + '节操',
          );
          return fix;
        }
        if (rand(1, 100) <= 25) {
          const nb = wB - wA;
          await mutateP(gid, tgt.id, foe.nm, (x) => {
            x.w = nb;
          });
          say(
            msg,
            nick1 + '的' + kunA + '对' + nick2 + '的' + kunB + '发动了致命一击！' + '\n' +
            '-------------------' + '\n' + nick2 + '的' + kunB + '体重减少' + toText(wA) +
            '千克，剩余体重' + toText(nb) + '千克',
          );
          if (nb <= 0) {
            await killPlayer(gid, tgt.id, attrB0, foe.n, nb + wA);
            sayNow(msg, at(tgt.id) + '你的' + kunB + '被' + nick1 + '的' + kunA + '干死了！' + '\n' + '友情提示：有仇不报非君子啊！');
            return fix;
          }
        }
      }
      if (A === -1 && B === -1) {
        say(
          msg,
          at(uid) + '无法对' + nick2 + '的' + kunB + '发起攻击！' + '\n' + '-------------------' + '\n' +
          '剩余' + toText(jiecao) + '节操',
        );
        return fix;
      }
      const na = wA - A;
      const nb = wB - B;
      await mutateP(gid, uid, self.nm, (x) => {
        x.w = na;
      });
      if (na <= 0) {
        await killPlayer(gid, uid, attrA0, self.n, na + A);
        say(msg, at(uid) + '你的' + kunA + '死球了！' + '\n' + '打架要量力而为啊！');
      }
      await mutateP(gid, tgt.id, foe.nm, (x) => {
        x.w = nb;
      });
      if (nb <= 0) {
        await killPlayer(gid, tgt.id, attrB0, foe.n, nb + B);
        sayNow(msg, at(tgt.id) + '你的' + kunB + '死球了！' + '\n' + '友情提示：有仇不报非君子啊！');
      }
      say(
        msg,
        '战况统计：' + '\n' + at(uid) + '的' + kunA + '体重减少' + toText(A) + '千克' + '\n' +
        '剩余体重' + toText(na) + '千克' + '\n' + nick2 + '的' + kunB + '体重减少' + toText(B) + '千克' + '\n' +
        '剩余体重' + toText(nb) + '千克' + '\n' + '-------------------' + '\n' +
        nick1 + '剩余' + toText(jiecao) + '节操',
      );
      // 淫：大恢复术
      let w = '';
      if (attrA === '淫' && attrB !== '傲' && na > 0) {
        if (rand(1, 100) <= 25) {
          const healed = na + A + A;
          await mutateP(gid, uid, self.nm, (x) => {
            x.w = healed;
          });
          w = at(uid) + '大恢复术！' + '\n' + kunA + '体重增加' + toText(A * 2) + '千克' + '\n' + '当前体重' + toText(healed) + '千克';
        }
      }
      if (attrA !== '傲' && attrB === '淫' && nb > 0) {
        if (rand(1, 100) <= 25) {
          const healed = nb + B + B;
          await mutateP(gid, tgt.id, foe.nm, (x) => {
            x.w = healed;
          });
          w += (w === '' ? '' : '\n') + at(tgt.id) + '大恢复术！' + '\n' + kunB + '体重增加' + toText(B * 2) + '千克' + '\n' + '当前体重' + toText(healed) + '千克';
        }
      }
      if (w !== '') {
        if (left(w, 2) === '\n') w = subReplace(w, '\n', '', 1);
        say(msg, w);
      }
      return fix;
    }

    /** 攻击2：原版的怪癖——A 和 B 都按 重A 算 */
    function attack2(gid, uid, wA, wB, attrA, attrB) {
      if (attrA === '贪' && rand(1, 100) <= 30) {
        void (async () => {
          const p = await readP(gid, uid);
          const eggs = p.e + 1;
          await mutateP(gid, uid, p.nm, (x) => {
            x.e = eggs;
          });
        })();
      }
      let A = trunc((wA * rand(1, 20)) / 100);
      let B = trunc((wA * rand(1, 20)) / 100);
      if (attrA === '怒') {
        A = trunc((wA * rand(15, 35)) / 100);
        B = trunc((wA * rand(1, 20)) / 100);
      }
      if (attrB === '惰') {
        A = trunc((wA * rand(1, 20)) / 100);
        B = trunc((wA * rand(15, 35)) / 100);
      }
      let AX;
      let BX;
      if (A > B) {
        AX = B;
        BX = trunc(A * 1.5);
      } else {
        AX = B + B;
        BX = trunc(A * 1.5);
      }
      if (attrA === '怒') BX *= 2;
      if (attrB === '惰') BX = trunc(BX / 2);
      if (attrB === '妒' && wA > wB) {
        AX = -1;
        BX = -1;
      }
      return [AX, BX];
    }

    /* ================= 强袭 ================= */

    async function raid(msg, gid, uid, argText, jiecao) {
      let fix = 0;
      const self = await readP(gid, uid);
      let artifact = self.s;
      if (artifact <= 0) {
        say(
          msg,
          at(uid) + '你没有神器' + SHENQI + '，无法发动强袭' + '\n' + '【*砸蛋】可获得' + SHENQI,
        );
        return 5;
      }
      const tgt = parseTarget(argText, msg);
      if (tgt.boss) return raidBoss(msg, gid, uid, jiecao);
      if (!tgt.id) return 2;
      const foe = await readP(gid, tgt.id);
      const nick2 = foe.nm || tgt.id;
      if (uid === tgt.id) {
        if (!foe.n) {
          say(
            msg,
            at(uid) + '你还没有鲲！' + '\n' + '-----------------' + '\n' + '发送【*孵化】获取鲲',
          );
          return 5;
        }
        artifact -= 1;
        await mutateP(gid, uid, self.nm, (x) => {
          x.s = artifact;
        });
        let kun = foe.n;
        if (foe.a !== '' && foe.a !== '无') kun = `[${foe.a}]${kun}`;
        await mutateP(gid, uid, self.nm, (x) => {
          x.dc = 0;
          x.n = '';
          x.a = '';
          x.l = x.l + 10;
        });
        say(
          msg,
          at(uid) + '\n' + '鲲鲲那么可爱，你们为什么要吃它？！' + '\n' +
          '我' + nick2 + '就算是饿死，死外边，从这跳下去，也绝不吃我的' + kun + '！' + '\n' +
          '哎呀妈呀！真香！' + '\n' + '节操-5/运势+10' + '\n' + '--------------------------' + '\n' +
          SHENQI + '余量' + toText(artifact) + '\n' + '节操' + toText(jiecao),
        );
        return fix;
      }
      if (!foe.n) {
        say(msg, at(uid) + nick2 + '还没有鲲，快邀请他一起♂玩吧');
        return 5;
      }
      const nick1 = self.nm || uid;
      let kun = foe.n;
      const attr = foe.a;
      if (attr !== '' && attr !== '无') kun = `[${attr}]${kun}`;
      const g = await readG(gid);
      if (foe.li === 1) {
        say(
          msg,
          at(uid) + nick2 + '的' + kun + '正在拍卖，无法强袭！' + '\n' + '当前竞价' + toText(g.au.bd) + '节操',
        );
        return 5;
      }
      if (attr === '惰') {
        say(
          msg,
          at(uid) + nick2 + '的' + kun + '免疫强袭' + '\n' + '--------------------------' + '\n' +
          SHENQI + '余量' + toText(artifact) + '\n' + '节操' + toText(jiecao + 5),
        );
        return fix;
      }
      artifact -= 1;
      await mutateP(gid, uid, self.nm, (x) => {
        x.s = artifact;
      });
      if (rand(1, 2) === 1) {
        say(
          msg,
          at(uid) + '强袭失败！节操-2' + '\n' + '你悄悄向' + nick2 + '的' + kun + '扔了一把' + SHENQI +
          ',' + kun + '蛇皮走位，躲开了' + '\n' + '--------------------------' + '\n' +
          SHENQI + '余量' + toText(artifact) + '\n' + '节操' + toText(jiecao),
        );
        return fix;
      }
      let cost = trunc((foe.w * rand(10, 30)) / 100);
      if (cost < 10) cost = 10;
      const nb = foe.w - cost;
      await mutateP(gid, tgt.id, foe.nm, (x) => {
        x.w = nb;
      });
      say(
        msg,
        at(uid) + '强袭成功！节操-2' + '\n' + '你悄悄向' + nick2 + '的' + kun + '扔了一把' + SHENQI +
        ',' + kun + '躲闪不及，身受重伤，惨叫震天，血流满地！' + '\n' + '--------------------------' + '\n' +
        SHENQI + '余量' + toText(artifact) + '\n' + '节操' + toText(jiecao),
      );
      if (nb <= 0) {
        await killPlayer(gid, tgt.id, attr, foe.n, nb + cost);
        sayNow(msg, at(tgt.id) + '你的' + kun + '被' + nick1 + '打死了' + '\n' + '--------------------------' + '\n' + '友情提示：有仇不报非君子！');
      } else {
        sayNow(msg, at(tgt.id) + '你的' + kun + '受到' + nick1 + '的袭♂击' + '\n' + '体重减少' + toText(cost) + '千克' + '\n' + '剩余体重' + toText(nb) + '千克');
      }
      return fix;
    }

    /* ================= 拍卖行 ================= */

    async function auction(msg, gid, uid, argText, verb) {
      const g = await readG(gid);
      const seller = String(g.au.se || '');
      const buyer = String(g.au.bu || '');
      let nick1 = '';
      let kunTxt = '';
      let weight = 0;
      let bid = g.au.bd;
      if (seller !== '') {
        const sp = await readP(gid, seller);
        nick1 = sp.nm || String(seller);
        kunTxt = sp.n;
        if (sp.a && sp.a !== '无') kunTxt = `[${sp.a}]${kunTxt}`;
        weight = sp.w;
      }
      // 原版这里还算买主昵称（昵称2），但拍卖回复里用不到，略过

      if (verb === '出售' || verb === '上架') {
        if (seller !== '') {
          say(
            msg,
            at(uid) + '拍卖行消息：' + '\n' + '无法出售！拍卖行已经有鲲在售了！' + '\n' +
            '卖家：' + nick1 + '\n' + kunTxt + '\n' + '体重' + toText(weight) + '千克' + '\n' +
            '当前竞价' + toText(bid) + '节操',
          );
          return;
        }
        const p = await readP(gid, uid);
        if (p.li === 1) {
          say(
            msg,
            at(uid) + '拍卖行消息：' + '\n' + '你的鲲已经在售了！' + '\n' + kunWith(p) + '\n' +
            '体重' + toText(p.w) + '千克' + '\n' + '当前竞价' + toText(bid),
          );
          return;
        }
        if (!p.n) {
          say(msg, at(uid) + '你并没有鲲！' + '\n' + '发送【*孵化】可获得鲲');
          return;
        }
        // 原版写的是 取文本右边(鲲, 2) ≠ "★"——取右边两个字符是「鲲★」，
        // 永远不等于单字符「★」，等于拍卖行永远不可用（原版笔误，显然想写 1）。
        // 这里按明显意图取右边 1 个字符，让拍卖行能用。
        if (right(p.n, 1) !== '★') {
          say(msg, at(uid) + '拍卖行消息：' + '\n' + '未渡劫的鲲无法出售！');
          return;
        }
        if (!p.a || p.a === '无') {
          say(msg, at(uid) + '拍卖行消息：' + '\n' + '无属性的鲲无法出售！');
          return;
        }
        const shown = `[${p.a}]${p.n}`;
        let price = toNum(argText);
        if (price <= 0) price = 1;
        await mutateP(gid, uid, p.nm, (x) => {
          x.li = 1;
        });
        await mutateG(gid, (x) => {
          x.au.se = uid;
          x.au.bd = price;
          x.au.at = Date.now();
        });
        say(
          msg,
          at(uid) + '拍卖行消息：' + '\n' + '上架成功！' + '\n' + '卖家：' + (p.nm || uid) + '\n' +
          shown + '\n' + '体重' + toText(p.w) + '千克' + '\n' + '起拍价' + toText(price) + '节操' + '\n' +
          '----------------' + '\n' + '发送【*出价【数值】】参与竞拍' + '\n' + '卖家发送【*成交】完成交易',
        );
        return;
      }

      if (verb === '出价') {
        if (uid === seller) {
          say(msg, at(uid) + '拍卖行消息：' + '\n' + '无法为自己的鲲出价！');
          return;
        }
        if (seller === '') {
          say(
            msg,
            at(uid) + '拍卖行消息：' + '\n' + '目前没有在售的鲲！' + '\n' + '-------------------' + '\n' +
            '发送【*出售【起拍价】】将自己的鲲上架',
          );
          return;
        }
        const p = await readP(gid, uid);
        if (p.j <= 0) {
          say(
            msg,
            at(uid) + '你已经节操丧尽！无法出价！！' + '\n' + '-------------------' + '\n' +
            '节操可以通过每日【*签到】或【*喝鸡汤】或玩♂【*当前游戏】获取',
          );
          return;
        }
        let price = toNum(argText);
        if (price <= 0) {
          say(msg, at(uid) + '请输入正确数值！');
          return;
        }
        if (price > p.j) {
          say(
            msg,
            at(uid) + '拍卖行消息：' + '\n' + '出价失败！' + '\n' + '节操不足' + '\n' +
            '当前节操' + toText(p.j) + '\n' + '-------------------' + '\n' +
            '节操可以通过每日【*签到】或【*喝鸡汤】或玩♂【*当前游戏】获取',
          );
          return;
        }
        if (price <= bid) {
          say(
            msg,
            at(uid) + '拍卖行消息：' + '\n' + '出价失败！' + '\n' + '出价必须大于当前竞价' + '\n' +
            '-------------------' + '\n' + '卖家：' + nick1 + '\n' + kunTxt + '\n' +
            '体重' + toText(weight) + '千克' + '\n' + '当前竞价' + toText(bid),
          );
          return;
        }
        await mutateG(gid, (x) => {
          x.au.bd = price;
          x.au.bu = uid;
        });
        const bp = await readP(gid, uid);
        const nick2 = bp.nm || uid;
        say(
          msg,
          at(uid) + '拍卖行消息：' + '\n' + '出价成功！' + '\n' + '-------------------' + '\n' +
          '卖家：' + at(seller) + '\n' + kunTxt + '\n' + '体重' + toText(weight) + '千克' + '\n' +
          '当前竞价' + toText(price) + '\n' + '-------------------' + '\n' + '卖家发送【*成交】完成交易',
        );
        return;
      }

      if (verb === '成交') {
        if (uid !== seller) {
          say(
            msg,
            at(uid) + '拍卖行消息：' + '\n' + '你没有在售的鲲！' + '\n' + '-------------------' + '\n' +
            '发送【*出售【起拍价】】将自己的鲲上架',
          );
          return;
        }
        if (buyer === '') {
          say(
            msg,
            at(uid) + '拍卖行消息：' + '\n' + '没有买主！' + '\n' + '-------------------' + '\n' +
            '卖家：' + nick1 + '\n' + kunTxt + '\n' + '体重' + toText(weight) + '千克' + '\n' +
            '当前竞价' + toText(bid) + '节操',
          );
          return;
        }
        const sp = await readP(gid, uid);
        const bp = await readP(gid, buyer);
        say(
          msg,
          '拍卖行消息：' + '\n' + '交♂易成功！' + '\n' + kunTxt + '\n' + '体重' + toText(weight) + '千克' + '\n' +
          '售价' + toText(bid) + '节操' + '\n' + '卖家：' + at(seller) + '\n' + '买主：' + at(buyer),
        );
        await mutateP(gid, seller, sp.nm, (x) => {
          x.j += bid;
        });
        await mutateP(gid, buyer, bp.nm, (x) => {
          x.j -= bid;
          x.n = sp.n;
          x.a = sp.a;
          x.w = sp.w;
        });
        await mutateP(gid, uid, sp.nm, (x) => {
          x.n = '';
          x.a = '';
          x.dc = 0;
          x.li = 0;
        });
        await mutateG(gid, (x) => {
          x.au.se = '';
          x.au.bu = '';
          x.au.bd = 0;
        });
        return;
      }

      if (verb === '下架') {
        if (uid !== seller) {
          say(
            msg,
            at(uid) + '拍卖行消息：' + '\n' + '你没有在售的鲲！' + '\n' + '-------------------' + '\n' +
            '发送【*出售【起拍价】】将自己的鲲上架',
          );
          return;
        }
        await mutateP(gid, uid, '', (x) => {
          x.li = 0;
        });
        await mutateG(gid, (x) => {
          x.au.se = '';
          x.au.bu = '';
          x.au.bd = 0;
        });
        say(msg, at(uid) + '拍卖行消息：' + '\n' + kunTxt + '已经下架！');
        return;
      }

      if (verb === '拍卖行') {
        if (seller === '') {
          say(
            msg,
            '拍卖行消息：' + '\n' + '目前没有鲲上架！' + '\n' + '-------------------' + '\n' +
            '发送【*出售【起拍价】】将自己的鲲上架',
          );
        } else {
          say(
            msg,
            '拍卖行消息：' + '\n' + '卖家：' + nick1 + '\n' + kunTxt + '\n' +
            '体重' + toText(weight) + '千克' + '\n' + '当前竞价：' + toText(bid) + '\n' +
            '-------------' + '\n' + '发送【*出价【竞拍价】】进行竞拍',
          );
        }
        return;
      }

      if (verb === '强制下架') {
        if (seller === '') {
          say(msg, at(uid) + '指令无效！没有在售的鲲！');
          return;
        }
        if (Date.now() - g.au.at < 5 * 60 * 1000) {
          say(
            msg,
            at(uid) + '拍卖行消息：' + '\n' + '上架时间不足5分钟，不可强制下架！' + '\n' +
            '卖家：' + nick1 + '\n' + kunTxt + '\n' + '体重' + toText(weight) + '千克' + '\n' +
            '当前竞价' + toText(bid) + '节操' + '\n' + '上架时间' + new Date(g.au.at).toLocaleString('zh-CN'),
          );
          return;
        }
        await mutateP(gid, seller, '', (x) => {
          x.li = 0;
        });
        await mutateG(gid, (x) => {
          x.au.se = '';
          x.au.bu = '';
          x.au.bd = 0;
        });
        say(msg, at(uid) + '拍卖行消息：' + '\n' + nick1 + '的' + kunTxt + '已经强制下架！');
        return;
      }
    }

    /** 取文本右边 */
    function right(s, n) {
      const t = String(s ?? '');
      return t.length <= n ? t : t.slice(t.length - n);
    }

    /* ================= BOSS ================= */

    const BOSS_KINDS = ['魑', '魅', '魍', '魉'];

    /** BOSS刷新：原版在每条群消息时顺手刷（23 点后不刷） */
    async function bossRefresh(gid) {
      const now = new Date();
      if (now.getHours() >= 23) return;
      const g = await readG(gid);
      if (g.bs.rd === String(now.getDate())) return;
      const players = await eachPlayer(gid);
      for (const { uid } of players) {
        await mutateP(gid, uid, '', (x) => {
          x.bo = 0;
        });
      }
      let max = 0;
      for (const { p } of players) {
        if (p.n && p.w > max) max = p.w;
      }
      const kind = BOSS_KINDS[rand(1, 4) - 1];
      await mutateG(gid, (x) => {
        x.bs.rd = String(now.getDate());
        x.bs.w = 10000 + max;
        x.bs.al = '1';
        x.bs.bo = kind;
        x.bs.dl = '';
      });
    }

    async function bossMenu(msg) {
      const lines = [
        '==BOSS菜单==',
        cmdTag('*刷新BOSS', '/kun 刷新BOSS'),
        '---------',
        cmdTag('*查询BOSS', '/kun 查询BOSS'),
        cmdTag('*强袭BOSS', '/kun 强袭BOSS'),
        cmdTag('*攻击BOSS', '/kun 攻击BOSS'),
        cmdTag('*吞噬BOSS', '/kun 吞噬BOSS'),
        cmdTag('*阵亡名单', '/kun 阵亡名单'),
      ];
      say(msg, lines.join('\n'));
    }

    async function queryBoss(msg, gid) {
      const g = await readG(gid);
      let boss = g.bs.bo;
      const desc = BOSS_DESC[boss] ?? '';
      boss = '♂' + boss + '♂';
      if (g.bs.al !== '1') boss += '[已击杀]';
      let w =
        '==今日BOSS==' + '\n' + boss + '\n' + '属性☆' + desc + '\n' + '体重☆' + toText(g.bs.w) + '千克';
      if (g.bs.al !== '1') {
        const kp = await readP(gid, String(g.bs.kl || ''));
        const nick = kp.nm || String(g.bs.kl || '');
        w += '\n' + '击杀者 ' + nick;
      }
      say(msg, w + '\n' + '=输=出=排=行=' + (await outputRank(gid)));
    }

    async function refreshBoss(msg, gid, uid) {
      const role = await roleOf(msg);
      if (role < 3) {
        say(msg, at(uid) + '对不起，你没有此权限！' + '\n' + '此命令仅群主可用！');
        return;
      }
      const players = await eachPlayer(gid);
      for (const { uid } of players) {
        await mutateP(gid, uid, '', (x) => {
          x.bo = 0;
        });
      }
      let max = 0;
      for (const { p } of players) {
        if (p.n && p.w > max) max = p.w;
      }
      const kind = BOSS_KINDS[rand(1, 4) - 1];
      await mutateG(gid, (x) => {
        x.bs.rd = String(new Date().getDate());
        x.bs.w = 10000 + max;
        x.bs.al = '1';
        x.bs.bo = kind;
        x.bs.dl = '';
      });
      say(msg, '今日BOSS已经刷新' + '\n' + '发送【*查询BOSS】查看详情');
    }

    async function deadList(msg, gid) {
      const g = await readG(gid);
      let w = g.bs.dl;
      if (right(w, 1) === '/') w = left(w, String(w).length - 1);
      say(msg, '阵亡名单：' + '\n' + w + '\n' + '缅怀以上各位勇士！');
    }

    /** 输出排行（原版的插入排序用的是 qcy[j] 而非 d[j]，是原版 bug，这里用正确算法，输出格式不变） */
    async function outputRank(gid, type = '排行') {
      const players = await eachPlayer(gid);
      const d = new Array(10).fill(null);
      for (const { uid, p } of players) {
        if (p.bo <= 0) continue;
        for (let j = 0; j < 10; j++) {
          const cur = d[j];
          const curV = cur ? cur.bo : 0;
          if (p.bo >= curV) {
            for (let k = 9; k > j; k--) d[k] = d[k - 1];
            d[j] = { uid, ...p };
            break;
          }
        }
      }
      if (type === '前五') {
        let w = '';
        for (let i = 0; i < 5; i++) w += toText(d[i] ? d[i].uid : 0) + '/';
        return w;
      }
      let w = '';
      for (let i = 0; i < 10; i++) {
        const e = d[i];
        if (!e) break;
        w += '\n' + toText(i + 1) + '.' + (e.nm || e.uid) + '--' + toText(e.bo);
      }
      return w;
    }

    /** BOSS 已被击杀时的提示 */
    async function killHint(msg, gid, uid) {
      const g = await readG(gid);
      const kp = await readP(gid, String(g.bs.kl || ''));
      const nick = kp.nm || String(g.bs.kl || '');
      say(
        msg,
        at(uid) + '今日BOSS已经被击杀！' + '\n' + '击杀者 ' + nick + '\n' +
        '=输=出=排=行=' + (await outputRank(gid)) + '\n' + '-----------' + '\n' + '请等待每日0点刷新或联系群主！',
      );
    }

    /** BOSS 死亡结算。返回 x（击杀者在输出前五则为 300，否则 0） */
    async function bossDeath(msg, gid, uid, nick) {
      const g = await readG(gid);
      const kind = g.bs.bo;
      await mutateG(gid, (x) => {
        x.bs.w = 0;
        x.bs.al = '';
        x.bs.kl = uid;
      });
      const p = await readP(gid, uid);
      const jiecao = p.j + 100;
      const eggs = p.e + 20;
      await mutateP(gid, uid, p.nm, (x) => {
        x.j = jiecao;
        x.e = eggs;
      });
      let w =
        '今日BOSS♂' + kind + '♂被 ' + nick + ' 成功击杀！' + '\n' + '获得击杀奖励：' + '\n' +
        '蛋×20' + '\n' + '节操×100';
      w += '\n' + '==输出排行==' + (await outputRank(gid));
      const top5 = (await outputRank(gid, '前五')).split('/');
      w += '\n' + '----------' + '\n';
      let x = 0;
      for (let i = 0; i < 5; i++) {
        const toQQ = toNum(top5[i]);
        if (uid === String(toQQ)) x = 300;
        if (toQQ !== 0) {
          const tp = await readP(gid, String(toQQ));
          w += at(String(toQQ));
          await mutateP(gid, String(toQQ), tp.nm, (t) => {
            t.j += 300;
          });
        }
      }
      w += '\n' + '输出排行前五名每人获得300节操奖励！';
      say(msg, w);
      return x;
    }

    /* ---------- BOSS 战：吞噬 ---------- */

    async function devourBoss(msg, gid, uid, jiecao) {
      let fix = 0;
      const g = await readG(gid);
      if (g.bs.al !== '1') {
        await killHint(msg, gid, uid);
        return 1;
      }
      const bossKind = g.bs.bo;
      const self = await readP(gid, uid);
      const attrA0 = self.a;
      if (attrA0 !== '傲' && bossKind === '魅') {
        say(msg, at(uid) + 'BOSS魅免疫吞噬！');
        return 1;
      }
      let wA = self.w;
      let wB = g.bs.w;
      let kunA = self.n;
      if (attrA0 !== '无' && attrA0 !== '') kunA = `[${attrA0}]${kunA}`;
      let attrA = restrainBoss(attrA0, bossKind, 'A');
      const attrB = restrainBoss(attrA, bossKind, 'B');
      const nick1 = self.nm || uid;
      if (attrA === '怒' && rand(1, 100) <= 25) {
        wB -= wA;
        await mutateG(gid, (x) => {
          x.bs.w = wB;
        });
        say(
          msg,
          nick1 + '的' + kunA + '对' + 'BOSS' + bossKind + '发动了致命一击！' + '\n' +
          '-------------------' + '\n' + 'BOSS' + bossKind + '体重减少' + toText(wA) + '千克，剩余体重' + toText(wB) + '千克',
        );
        const out = self.bo + wA;
        await mutateP(gid, uid, self.nm, (x) => {
          x.bo = out;
        });
        if (wB <= 0) {
          fix = (await bossDeath(msg, gid, uid, nick1)) + 100;
          return fix;
        }
      }
      const [A, B] = devourBoss2(gid, uid, wA, wB, attrA, attrB);
      if (A > B) {
        const gain = abs(wB - B - B);
        wA += gain;
        await mutateG(gid, (x) => {
          x.bs.w = 0;
        });
        say(
          msg,
          '吞噬成功！' + '\n' + at(uid) + '的' + kunA + '成功吞噬了' + 'BOSS' + bossKind + '\n' +
          nick1 + '的' + kunA + '体重增加' + toText(gain) + '千克' + '\n' +
          '现体重：' + toText(wA) + '千克' + '\n' + '-------------------' + '\n' + nick1 + '剩余' + toText(jiecao) + '节操',
        );
        const attrNow = (await readP(gid, uid)).a;
        const out = (await readP(gid, uid)).bo + wB;
        await mutateP(gid, uid, self.nm, (x) => {
          x.bo = out;
          x.w = wA;
        });
        if (attrNow === '馋' && wA > 1000) {
          await mutateP(gid, uid, self.nm, (y) => {
            y.dc = 0;
            y.n = '';
            y.a = '';
          });
          say(msg, at(uid) + '你的' + kunA + '因暴食而死！' + '\n' + '友情提示：多行不义必自毙！');
        }
        await mutateG(gid, (x) => {
          x.bs.w = 0;
        });
        fix = (await bossDeath(msg, gid, uid, nick1)) + 100;
        return fix;
      }
      let dmg = A;
      if (attrA === '馋') dmg = 0;
      const na = wA - B;
      const nb = wB - dmg;
      await mutateP(gid, uid, self.nm, (x) => {
        x.w = na;
      });
      await mutateG(gid, (x) => {
        x.bs.w = nb;
      });
      const out = (await readP(gid, uid)).bo + dmg;
      await mutateP(gid, uid, self.nm, (x) => {
        x.bo = out;
      });
      if (na <= 0) {
        await killPlayer(gid, uid, attrA0, self.n, na + B);
        const dl = nick1 + '-' + kunA + '/' + g.bs.dl;
        await mutateG(gid, (x) => {
          x.bs.dl = dl;
        });
        say(msg, at(uid) + '你的' + kunA + '为食而死！' + '\n' + '吞噬要量力而为啊！');
      }
      say(
        msg,
        '吞噬失败！' + '\n' + at(uid) + '的' + kunA + '体重减少' + toText(B) + '千克' + '\n' +
        '剩余体重' + toText(na) + '千克' + '\n' + 'BOSS' + bossKind + '体重减少' + toText(dmg) + '千克' + '\n' +
        '剩余体重' + toText(nb) + '千克' + '\n' + '-------------------' + '\n' + nick1 + '剩余' + toText(jiecao) + '节操',
      );
      if (nb <= 0) {
        fix = (await bossDeath(msg, gid, uid, nick1)) + 100;
        return fix;
      }
      if (bossKind === '魉' && nb > 0 && nb < 666) {
        await mutateG(gid, (x) => {
          x.bs.w = 1000;
        });
        say(msg, '大恢复术！' + '\n' + 'BOSS' + bossKind + '体重恢复至1000' + '千克');
      }
      return fix;
    }

    /** 吞噬BOSS2：与吞噬2 相同，但没有 惰 分支 */
    function devourBoss2(gid, uid, wA, wB, attrA, attrB) {
      if (attrA === '贪' && rand(1, 100) <= 30) {
        void (async () => {
          const p = await readP(gid, uid);
          const eggs = p.e + 1;
          await mutateP(gid, uid, p.nm, (x) => {
            x.e = eggs;
          });
        })();
      }
      let A = trunc((wA * rand(25, 75)) / 100);
      let B = trunc((wB * rand(25, 75)) / 100);
      if (attrA === '怒') {
        A = trunc((wA * rand(50, 90)) / 100);
        B = trunc((wB * rand(25, 55)) / 100);
      }
      return [A, B];
    }

    /** 属性克制 BOSS 版：只有 傲 会清掉 BOSS 属性 */
    function restrainBoss(attrA, attrB, who) {
      if (attrA === '傲') attrB = '';
      if (who === 'A') return attrA;
      if (who === 'B') return attrB;
      return '';
    }

    /* ---------- BOSS 战：攻击 ---------- */

    async function attackBoss(msg, gid, uid, jiecao) {
      let fix = 0;
      const g = await readG(gid);
      if (g.bs.al !== '1') {
        await killHint(msg, gid, uid);
        return 2;
      }
      const self = await readP(gid, uid);
      const attrA0 = self.a;
      if (attrA0 === '馋') {
        say(msg, at(uid) + '馋属性鲲无法发起攻击！');
        return 2;
      }
      const bossKind = g.bs.bo;
      if (attrA0 !== '傲' && bossKind === '魍') {
        say(msg, at(uid) + 'BOSS魍免疫攻击！');
        return 2;
      }
      let kunA = self.n;
      if (attrA0 !== '无' && attrA0 !== '') kunA = `[${attrA0}]${kunA}`;
      let wA = self.w;
      let wB = g.bs.w;
      let attrA = restrain(attrA0, bossKind, 'A');
      const attrB = restrain(attrA, bossKind, 'B');
      const [A, B] = attackBoss2(gid, uid, wA, wB, attrA, attrB);
      const nick1 = self.nm || uid;
      if (attrA === '怒' && rand(1, 100) <= 25) {
        wB -= wA;
        await mutateG(gid, (x) => {
          x.bs.w = wB;
        });
        const out = self.bo + wA;
        await mutateP(gid, uid, self.nm, (x) => {
          x.bo = out;
        });
        say(
          msg,
          nick1 + '的' + kunA + '对' + 'BOSS' + bossKind + '发动了致命一击！' + '\n' +
          '-------------------' + '\n' + 'BOSS' + bossKind + '体重减少' + toText(wA) + '千克，剩余体重' + toText(wB) + '千克',
        );
        if (wB <= 0) {
          fix = (await bossDeath(msg, gid, uid, nick1)) + 100;
          return fix;
        }
      }
      const na = wA - A;
      const nb = wB - B;
      await mutateP(gid, uid, self.nm, (x) => {
        x.w = na;
      });
      await mutateG(gid, (x) => {
        x.bs.w = nb;
      });
      const out = (await readP(gid, uid)).bo + B;
      await mutateP(gid, uid, self.nm, (x) => {
        x.bo = out;
      });
      if (na <= 0) {
        await killPlayer(gid, uid, attrA0, self.n, na + B);
        const dl = nick1 + '-' + kunA + '/' + g.bs.dl;
        await mutateG(gid, (x) => {
          x.bs.dl = dl;
        });
        say(msg, at(uid) + '你的' + kunA + '死球了！' + '\n' + '打架要量力而为啊！');
      }
      say(
        msg,
        '战况统计：' + '\n' + at(uid) + '的' + kunA + '体重减少' + toText(A) + '千克' + '\n' +
        '剩余体重' + toText(na) + '千克' + '\n' + 'BOSS' + bossKind + '体重减少' + toText(B) + '千克' + '\n' +
        '剩余体重' + toText(nb) + '千克' + '\n' + '-------------------' + '\n' + nick1 + '剩余' + toText(jiecao) + '节操',
      );
      if (nb <= 0) {
        fix = (await bossDeath(msg, gid, uid, nick1)) + 100;
      }
      let w = '';
      if (attrA === '淫' && na > 0 && rand(1, 100) <= 25) {
        const healed = na + A + A;
        await mutateP(gid, uid, self.nm, (x) => {
          x.w = healed;
        });
        w = at(uid) + '大恢复术！' + '\n' + kunA + '体重增加' + toText(A * 2) + '千克' + '\n' + '当前体重' + toText(healed) + '千克';
      }
      if (w !== '') say(msg, w);
      if (bossKind === '魉' && nb > 0 && nb < 666) {
        await mutateG(gid, (x) => {
          x.bs.w = 1000;
        });
        say(msg, '大恢复术！' + '\n' + 'BOSS' + bossKind + '体重恢复至1000' + '千克');
      }
      return fix;
    }

    /** 攻击BOSS2：与攻击2 相同，但没有 惰 分支 */
    function attackBoss2(gid, uid, wA, wB, attrA, attrB) {
      if (attrA === '贪' && rand(1, 100) <= 30) {
        void (async () => {
          const p = await readP(gid, uid);
          const eggs = p.e + 1;
          await mutateP(gid, uid, p.nm, (x) => {
            x.e = eggs;
          });
        })();
      }
      let A = trunc((wA * rand(1, 20)) / 100);
      let B = trunc((wA * rand(1, 20)) / 100);
      if (attrA === '怒') {
        A = trunc((wA * rand(15, 35)) / 100);
        B = trunc((wA * rand(1, 20)) / 100);
      }
      let AX;
      let BX;
      if (A > B) {
        AX = B;
        BX = trunc(A * 1.5);
      } else {
        AX = B + B;
        BX = trunc(A * 1.5);
      }
      if (attrA === '怒') BX *= 2;
      return [AX, BX];
    }

    /* ---------- BOSS 战：强袭 ---------- */

    async function raidBoss(msg, gid, uid, jiecao) {
      let fix = 0;
      const g = await readG(gid);
      if (g.bs.al !== '1') {
        await killHint(msg, gid, uid);
        return 5;
      }
      const self = await readP(gid, uid);
      let artifact = self.s;
      const bossKind = g.bs.bo;
      if (bossKind === '魑') {
        say(
          msg,
          at(uid) + 'BOSS' + bossKind + '免疫强袭' + '\n' + '--------------------------' + '\n' +
          SHENQI + '余量' + toText(artifact) + '\n' + '节操' + toText(jiecao + 5),
        );
        return fix;
      }
      const nick1 = self.nm || uid;
      let w = g.bs.w;
      artifact -= 2;
      await mutateP(gid, uid, self.nm, (x) => {
        x.s = artifact;
      });
      if (rand(1, 2) === 1) {
        say(
          msg,
          at(uid) + '强袭失败！节操-2' + '\n' + '你悄悄向' + 'BOSS' + bossKind + '扔了两把' + SHENQI +
          ',' + bossKind + '蛇皮走位，躲开了' + '\n' + '--------------------------' + '\n' +
          SHENQI + '余量' + toText(artifact) + '\n' + '节操' + toText(jiecao),
        );
        return fix;
      }
      let cost = trunc((w * rand(10, 30)) / 100);
      if (cost < 10) cost = 10;
      w -= cost;
      await mutateG(gid, (x) => {
        x.bs.w = w;
      });
      say(
        msg,
        at(uid) + '强袭成功！节操-2' + '\n' + '你悄悄向' + 'BOSS' + bossKind + '扔了两把' + SHENQI +
        ',' + bossKind + '躲闪不及，身受重伤，惨叫震天，血流满地！' + '\n' + '--------------------------' + '\n' +
        SHENQI + '余量' + toText(artifact) + '\n' + '节操' + toText(jiecao),
      );
      if (w <= 0) {
        fix = (await bossDeath(msg, gid, uid, nick1)) + 100;
      } else {
        say(
          msg,
          'BOSS' + bossKind + '受到' + nick1 + '的袭♂击' + '\n' + '体重减少' + toText(cost) + '千克' + '\n' +
          '剩余体重' + toText(w) + '千克',
        );
      }
      if (bossKind === '魉' && w > 0 && w < 666) {
        await mutateG(gid, (x) => {
          x.bs.w = 1000;
        });
        say(msg, '大恢复术！' + '\n' + 'BOSS' + bossKind + '体重恢复至1000' + '千克');
      }
      return fix;
    }

    /* ================= 小游戏（原版 游戏()） ================= */

    /**
     * 每条群消息都会过一遍的状态机。
     * 处理：小游戏开/关、当前游戏、抢答(*=)、抽嘴巴、单挑群主、名额耗尽换新游戏。
     */
    async function gameStep(msg, gid, uid, verb, argText) {
      const g = await readG(gid);
      const gm = { ...g.gm };
      let role = 1;
      let needRole = false;

      if (verb === '小游戏开' || verb === '小游戏关') {
        needRole = true;
        // 原版要求 @ 机器人
        if (!msg.mentioned) return;
        role = await roleOf(msg);
        if (role < 2) {
          say(msg, at(uid) + '对不起，你没有管理权限！');
          return;
        }
        if (verb === '小游戏开') {
          gm.game = 1;
          gm.sl = 0;
          say(msg, '小游戏已开！' + '\n' + '回复【*当前游戏】查看');
        } else {
          gm.game = 0;
          gm.sl = 0;
          say(msg, '小游戏已关！');
        }
        // 原版这里**不提前返回**：接着往下走，名额为 0 会立刻滚出一个新题目。
        // 提前 return 的话，*当前游戏 会显示「0+0=?」。
      }

      if (verb === '当前游戏') {
        let w = '小游戏未开启！';
        if (gm.game === 1) {
          w = '奥数比赛【总名额5】' + '\n' + toText(gm.a) + '+' + toText(gm.b) + '=?' + '\n' +
            '回复【*=数值】来抢答' + '\n' + '剩余名额' + toText(gm.sl) + '\n' + '-------------------' + '\n' + '节操至少为1才能参与游戏';
        } else if (gm.game === 2) {
          w = '奥数比赛【总名额5】' + '\n' + toText(gm.a) + '×' + toText(gm.b) + '=?' + '\n' +
            '回复【*=数值】来抢答' + '\n' + '剩余名额' + toText(gm.sl) + '\n' + '-------------------' + '\n' + '节操至少为1才能参与游戏';
        } else if (gm.game === 3) {
          w = '奥数比赛【总名额1】' + '\n' + toText(gm.a) + 'X+' + toText(gm.b) + 'Y=' + toText(gm.e) + '\n' +
            toText(gm.c) + 'X+' + toText(gm.d) + 'Y=' + toText(gm.f) + '\n' + '求X' + '\n' +
            '回复【*=数值】来抢答' + '\n' + '剩余名额' + toText(gm.sl) + '\n' + '-------------------' + '\n' + '节操至少为1才能参与游戏';
        } else if (gm.game === 4) {
          w = '数星星【总名额2】' + '\n' + gm.t1 + '\n' + gm.t2 + '\n' + gm.t3 + '\n' + gm.t4 + '\n' + gm.t5 + '\n' + '\n' +
            '问：有多少黑色星星' + '\n' + '回复【*=数值】来抢答' + '\n' + '剩余名额' + toText(gm.sl) + '\n' + '-------------------' + '\n' + '节操至少为1才能参与游戏';
        } else if (gm.game === 5) {
          w = '群殴群主【总名额5】' + '\n' + '回复【*抽群主一个大嘴巴】获取节操' + '\n' + '剩余名额未知' + '\n' + '-------------------' + '\n' + '节操至少为1才能参与游戏';
        } else if (gm.game === 6) {
          w = '抄作业【总名额5】' + '\n' + '问题：' + toText(gm.ques) + '\n' + '答案：倒序抄写问题' + '\n' +
            '回复【*=答案】获取节操' + '\n' + '剩余名额' + toText(gm.sl) + '\n' + '-------------------' + '\n' + '节操至少为1才能参与游戏';
        } else if (gm.game === 7) {
          w = '单挑群主' + '\n' + '回复【*单挑群主】开始挑战群主' + '\n' + '直到有人打败群主才可结束当前游戏！' + '\n' +
            '获胜节操奖励' + toText(gm.rw) + '\n' + '-------------------' + '\n' + '节操至少为1才能参与游戏';
        }
        say(msg, w);
        return;   // 原版在这里直接返回，不写回状态
      }

      const p = await readP(gid, uid);
      if (p.j > 0) {
        if (gm.game !== 0) {
          if (verb === '抽群主一个大嘴巴' && gm.game !== 5) {
            const j = p.j - 10;
            await mutateP(gid, uid, p.nm, (x) => {
              x.j = j;
            });
            say(
              msg,
              at(uid) + '\n' + '目无法纪！胆大包天！' + '\n' + '以下犯上！乱我朝纲！' + '\n' + '节操-10' + '\n' +
              '-------------------' + '\n' + '剩余节操' + toText(j),
            );
          }
          if (verb === '单挑群主' && gm.game !== 7) {
            const j = p.j - 10;
            await mutateP(gid, uid, p.nm, (x) => {
              x.j = j;
            });
            say(
              msg,
              at(uid) + '\n' + '不自量力！螳臂当车！' + '\n' + '挑衅群主！自取其辱！' + '\n' + '节操-10' + '\n' +
              '-------------------' + '\n' + '剩余节操' + toText(j),
            );
          }
          if (verb === '答' || verb === '=') {
            const s = argText;
            if (s === gm.ans) {
              gm.sl -= 1;
              const j = p.j + gm.rw;
              await mutateP(gid, uid, p.nm, (x) => {
                x.j = j;
              });
              say(
                msg,
                at(uid) + '回答正确！节操+' + toText(gm.rw) + '\n' + '当前节操' + toText(j) + '\n' +
                '-------------------' + '\n' + '剩余名额' + toText(gm.sl),
              );
            } else {
              const j = p.j - gm.pn;
              await mutateP(gid, uid, p.nm, (x) => {
                x.j = j;
              });
              say(
                msg,
                at(uid) + '回答错误！节操-' + toText(gm.pn) + '\n' + '当前节操' + toText(j) + '\n' +
                '-------------------' + '\n' + '剩余名额' + toText(gm.sl),
              );
            }
          }
        }
        if (gm.game === 5) {
          if (verb === '抽群主一个大嘴巴') {
            gm.sl -= 1;
            const j = p.j + 2;
            await mutateP(gid, uid, p.nm, (x) => {
              x.j = j;
            });
            say(
              msg,
              at(uid) + '抚摸了群主的脸颊，响亮但不文雅！' + '\n' + '节操+2' + '\n' +
              '当前节操' + toText(j) + '\n' + '-------------------' + '\n' + '剩余名额未知',
            );
          }
        }
        if (gm.game === 7) {
          if (verb === '单挑群主') {
            if (rand(1, 100) <= 20) {
              gm.sl -= 1;
              const j = p.j + gm.rw;
              await mutateP(gid, uid, p.nm, (x) => {
                x.j = j;
              });
              say(
                msg,
                at(uid) + '打趴了群主！功德无量，百世流傅！' + '\n' + '节操+' + toText(gm.rw) + '\n' +
                '当前节操' + toText(j) + '\n' + '-------------------' + '\n' + '单挑群主游戏结束',
              );
            } else {
              const j = p.j - 5;
              gm.rw += 10;
              await mutateP(gid, uid, p.nm, (x) => {
                x.j = j;
              });
              say(
                msg,
                at(uid) + '被群主打趴了！舍生取益，可歌可泣！' + '\n' + '节操-5' + '\n' +
                '当前节操' + toText(j) + '\n' + '-------------------' + '\n' + '奖励提高至' + toText(gm.rw) + '\n' +
                '还有谁！！！' + '\n' + '发送【*单挑群主】进行游戏',
              );
            }
          }
        }
      }

      // 名额耗尽 → 换新游戏
      if (gm.game !== 0 && gm.sl <= 0) {
        gm.game = rand(1, 7);
        if (gm.game === 1) {
          gm.a = rand(101, 999);
          gm.b = rand(101, 999);
          gm.ans = toText(gm.a + gm.b);
          gm.sl = 5;
          gm.rw = 1;
          gm.pn = 1;
        } else if (gm.game === 2) {
          gm.a = rand(11, 99);
          gm.b = rand(11, 99);
          gm.ans = toText(gm.a * gm.b);
          gm.sl = 5;
          gm.rw = 5;
          gm.pn = 1;
        } else if (gm.game === 3) {
          gm.x = rand(1, 10);
          gm.y = rand(1, 10);
          gm.a = rand(1, 10);
          gm.b = rand(1, 10);
          gm.c = rand(1, 10);
          gm.d = rand(1, 9);
          if (gm.c === gm.d) gm.d += 1;
          gm.ans = toText(gm.x);
          gm.e = gm.a * gm.x + gm.b * gm.y;
          gm.f = gm.c * gm.x + gm.d * gm.y;
          gm.sl = 1;
          gm.rw = 20;
          gm.pn = 5;
        } else if (gm.game === 4) {
          let count = 0;
          const line = (starWhen) => {
            let s = '';
            for (let i = 0; i < 10; i++) {
              if (starWhen(rand(1, 1000))) {
                s += '★';
                count++;
              } else {
                s += '☆';
              }
            }
            return s;
          };
          gm.t1 = line((v) => v > 500);
          gm.t2 = line((v) => v > 500);
          gm.t3 = line((v) => v > 500);
          gm.t4 = line((v) => v < 500);
          gm.t5 = line((v) => v < 500);
          gm.ans = toText(count);
          gm.sl = 2;
          gm.rw = 10;
          gm.pn = 5;
        } else if (gm.game === 5) {
          gm.sl = 5;
          gm.ans = '抽群主一个大嘴巴';
        } else if (gm.game === 6) {
          let ques = '';
          let ans = '';
          for (let i = 0; i < 10; i++) {
            let code = rand(65, 86);
            if (rand(1, 2) === 1) code += 32;
            ques += String.fromCharCode(code);
            ans = String.fromCharCode(code) + ans;
          }
          gm.ques = ques;
          gm.ans = ans;
          gm.sl = 3;
          gm.rw = 10;
          gm.pn = 5;
        } else if (gm.game === 7) {
          gm.sl = 1;
          gm.rw = 10;
          gm.ans = '单挑群主';
        }
      }
      await writeGame(gid, gm);
    }

    async function writeGame(gid, gm) {
      await mutateG(gid, (x) => {
        x.gm = gm;
      });
    }

    /* ================= 主流程辅助 ================= */

    /** 缓存昵称（原版从 QQ 取名片，我们只能在见到时存下来） */
    async function touchName(gid, uid, name) {
      if (!name) return;
      const p = await readP(gid, uid);
      if (p.nm === name) return;
      await mutateP(gid, uid, name, (x) => {
        x.nm = name;
      });
    }

    /** 6 秒冷却。返回 false 表示应静默丢弃 */
    async function passCooldown(gid, uid) {
      const p = await readP(gid, uid);
      if (p.lu && Date.now() - p.lu < COOLDOWN_SEC * 1000) return false;
      await mutateP(gid, uid, p.nm, (x) => {
        x.lu = Date.now();
      });
      return true;
    }

    /** 今日运势指令 */
    async function showFortune(msg, gid, uid) {
      const d = await fortune(gid, uid);
      say(
        msg,
        at(uid) + '\n' + '今日运势为' + toText(d) + '\n' + '-------------------' + '\n' +
        '砸蛋出道具概率=今日运势÷200×100%',
      );
    }

    /** 节操检查（原版 节操检查()）：先扣钱再办事，返回修正 */
    async function costCheck(msg, gid, uid, argText, verb) {
      const kind = verb === '强袭' || verb === '强袭BOSS' ? '强袭' : verb === '攻击' || verb === '攻击BOSS' ? '攻击' : '吞噬';
      // 指令名带 BOSS 的直接锁定 BOSS 目标（原版靠 *攻击BOSS 前缀匹配到 *攻击 后剩下 "BOSS"）
      if (/BOSS$/i.test(verb)) argText = 'BOSS';
      const p = await readP(gid, uid);
      if (p.j <= 0) {
        say(
          msg,
          at(uid) + '你已经节操丧尽！无法发起' + kind + '！' + '\n' + '-------------------' + '\n' +
          '节操可以通过每日【*签到】或【*喝鸡汤】或玩♂【*当前游戏】获取',
        );
        return;
      }
      let fix = 0;
      let cost = 0;
      if (kind === '吞噬') {
        cost = 1;
        fix = await devour(msg, gid, uid, argText, p.j - cost);
      } else if (kind === '强袭') {
        cost = 5;
        fix = await raid(msg, gid, uid, argText, p.j - cost);
      } else {
        cost = 2;
        fix = await attack(msg, gid, uid, argText, p.j - cost);
      }
      await mutateP(gid, uid, p.nm, (x) => {
        x.j = p.j - cost + fix;
      });
    }

    /** 数据清除 */
    async function clearData(msg, gid, uid) {
      if (!msg.mentioned) return;
      const role = await roleOf(msg);
      if (role < 3) {
        say(msg, at(uid) + '对不起，你没有权限！此命令仅群主可用！');
        return;
      }
      for (const { uid: u } of await eachPlayer(gid)) {
        await ctx.storage.delete(pKey(gid, u));
      }
      await ctx.storage.delete(gKey(gid));
      say(msg, '游戏数据成功清除！');
    }

    /* ================= 群主 / 管理员指令 OP ================= */

    /**
     * OP 能改的项目 → 存档字段。
     *
     * 字段名沿用短键（见 freshPlayer）：n 鲲名 / a 属性 / w 体重 / e 蛋 /
     * j 节操 / s 神器 / h 幻化丹 / p 鸡汤 / r 复活药 / l 好运。
     *
     * `kind` 决定「数值」怎么用：
     *   num  → 加减（正为加负为减）
     *   name → 改成指定鲲名（必须是那 50 个鲲名之一，「无」清空）
     *   attr → 改成指定属性（傲妒怒惰贪馋淫悲，「无」清空）
     */
    const OP_ITEMS = {
      鲲: { key: 'n', kind: 'name' },
      体重: { key: 'w', kind: 'num' },
      属性: { key: 'a', kind: 'attr' },
      节操: { key: 'j', kind: 'num' },
      蛋: { key: 'e', kind: 'num' },
      神器: { key: 's', kind: 'num' },
      幻化丹: { key: 'h', kind: 'num' },
      鸡汤: { key: 'p', kind: 'num' },
      复活药: { key: 'r', kind: 'num' },
      运势: { key: 'l', kind: 'num' },
    };

    const OP_USAGE =
      '*OP @成员 项目 数值' + '\n' +
      '例：*OP @张三 蛋 10' + '\n' +
      '　　*OP @张三 节操 -5' + '\n' +
      '　　*OP @张三 属性 妒' + '\n' +
      '也可以把 @成员 换成 openid，或写成斜杠式 *OP/项目/数值（目标取消息里的 @）' + '\n' +
      '项目：' + Object.keys(OP_ITEMS).join(' / ');

    /**
     * 从原文里拆 OP 的三个参数。
     *
     * **不能用 dispatch 递进来的 argText**：那是 `args.join('')`，
     * `*OP/12345/属性/妒` 整串会被当成一个「动词」，根本进不了 HANDLERS；
     * 空格写法拼起来又会把「12345 属性 妒」粘成「12345属性妒」。
     * 所以直接读原文，`/`、`／`、空格都当分隔符。
     *
     * @returns {{targetId:string,item:string,value:string}|null}
     */
    function parseOpArgs(msg) {
      const t = String(msg.content ?? '');
      const m = /OP(?:[/／\s]+|$)/i.exec(t);
      if (!m) return null;
      const parts = t
        .slice(m.index + m[0].length)
        .split(/[/／\s]+/)
        .filter(Boolean);

      // 正文里的 @ 已经被框架剥掉了，目标只能从 mentions 里拿
      let targetId = (msg.mentions ?? []).find((x) => !x.isBot)?.id ?? '';

      // 没 @ 人：第一个参数当 openid（32 位十六进制那种长串）
      if (!targetId && parts.length >= 3) targetId = parts.shift();
      // @ 了人却又多写了一遍 openid：把它摘掉，别当成项目名
      else if (targetId && parts.length >= 3 && /^[0-9A-Za-z]{16,}$/.test(parts[0])) parts.shift();

      return { targetId, item: parts[0] ?? '', value: parts[1] ?? '' };
    }

    /**
     * OP：直接改某个成员的存档。
     *
     * 原版写的是 `*OP/QQ号/项目/数值`。官方机器人拿不到 QQ 号，只有 openid
     * （一串 32 位十六进制，用户既记不住也打不出来），所以目标改成
     * **@成员** 为主、手填 openid 为辅。
     *
     * 权限：群主和管理员（roleOf 的 3 / 2）。
     */
    async function opCmd(msg, gid, uid) {
      const role = await roleOf(msg);
      if (role < 2) {
        say(msg, at(uid) + 'OP 只有群主和管理员能用。');
        return;
      }

      const parsed = parseOpArgs(msg);
      if (!parsed) {
        say(msg, OP_USAGE);
        return;
      }
      const { targetId, item, value } = parsed;

      if (!targetId) {
        say(
          msg,
          '没认出要改谁。' + '\n' + '在指令里 @ 一下那个成员。' + '\n' +
          '-------------------' + OP_USAGE,
        );
        return;
      }

      const spec = OP_ITEMS[item];
      if (!spec) {
        say(
          msg,
          (item ? `没有「${item}」这个项目。` : '缺项目。') + '\n' +
          '-------------------' + OP_USAGE,
        );
        return;
      }

      // 必须是已经玩过的人：没有存档就不知道「改之前」是什么
      const existed = await ctx.storage.get(pKey(gid, targetId));
      if (!existed) {
        say(
          msg,
          at(targetId) + '还没有养鲲存档。' + '\n' +
          '让他先发一次【*签到】，或者确认 @ 的是不是同一个人。',
        );
        return;
      }

      const cur = { ...existed };
      const before = cur[spec.key];
      let after;
      let delta = 0;

      if (spec.kind === 'num') {
        if (!/[+-]?\d/.test(String(value))) {
          say(
            msg,
            `「${item}」要填数字，正为加负为减。` + '\n' +
            `例：*OP @张三 ${item} +10`,
          );
          return;
        }
        delta = toNum(value);
        after = Math.max(0, Math.round(Number(before || 0) + delta));
      } else if (spec.kind === 'attr') {
        const v2 = String(value).trim();
        if (v2 === '无' || v2 === '无属性') after = '';
        else if (ATTR_DESC[v2]) after = v2;
        else {
          say(msg, '属性只能是：' + Object.keys(ATTR_DESC).join(' / ') + '（或填「无」清空）');
          return;
        }
      } else {
        const v2 = String(value).trim();
        if (v2 === '无' || v2 === '') after = '';
        else if (KUN_NAMES.includes(v2)) after = v2;
        else {
          say(msg, `没有「${v2}」这种鲲。` + '\n' + '可用的鲲名：' + KUN_NAMES.join(' / '));
          return;
        }
      }

      await mutateP(gid, targetId, cur.nm, (x) => {
        x[spec.key] = after;
      });

      const who = at(targetId) + (cur.nm ? `（${cur.nm}）` : '');
      const line =
        spec.kind === 'num'
          ? `${item}：${toText(before || 0)} → ${toText(after)}（${delta >= 0 ? '+' : ''}${toText(delta)}）`
          : `${item}：${before || '（空）'} → ${after || '（空）'}`;
      say(msg, who + ' 已修改' + '\n' + line);
    }

    /** 抽嘴巴/单挑群主 的禁言判定（原版在 游戏() 之后那两段） */
    async function muteCheck(msg, gid, uid, verb) {
      const g = await readG(gid);
      if (verb === '抽群主一个大嘴巴' && g.gm.game === 5) return;
      if (verb === '单挑群主' && g.gm.game === 7) return;
      const role = await roleOf(msg);
      if (role !== 1) return;
      // 原版还要求机器人自己是管理/群主（qcy2.管理权限 ＞ 1）
      let botIsAdmin = false;
      try {
        botIsAdmin = (await ctx.api.canManageGroup(gid)).ok;
      } catch { /* 查不到就不禁言 */ }
      if (!botIsAdmin) return;
      await mute(gid, uid, 180);
      say(
        msg,
        at(uid) + '藐视群主！寻衅滋事！罪大恶极！按法当踢！' + '\n' +
        '但是英俊潇洒光明伟岸的群主宅心仁厚宽容大度，免其死罪，暂且收监！禁言3分钟，以观后效！',
      );
    }

    /* ================= 指令分发 ================= */

    /**
     * 两种调用方式（对应原版「*指令」和官方机器人的 @ 限制）：
     *
     *   @机器人 /kun 签到        ← 群里必须 @，官方机器人默认只收 @ 消息
     *   *签到                    ← 需要「全量消息」权限才会收到
     *
     * 私聊：/kun 绑定 <群openid>，然后 /kun 磨炼 5 之类。
     */

    /** 不过开关/冷却的（原版在 开关() 之前处理） */
    const PLAIN_VERBS = new Set(['菜单', 'BOSS菜单', '查询BOSS', '刷新BOSS', '阵亡名单', '鲲开', '鲲关']);

    /** 私聊里能用的（原版私聊只认这几个） */
    const PRIVATE_VERBS = new Set(['绑定', '磨炼', '磨练', '砸蛋', '幻化']);

    const noop = async () => {};

    /** 每个指令的处理体：(msg, gid, uid, argText, verb) => Promise */
    const HANDLERS = {
      /* --- 不受开关/冷却限制 --- */
      菜单: (msg) => showMenu(msg),
      BOSS菜单: (msg) => bossMenu(msg),
      查询BOSS: (msg, gid) => queryBoss(msg, gid),
      刷新BOSS: (msg, gid, uid) => refreshBoss(msg, gid, uid),
      阵亡名单: (msg, gid) => deadList(msg, gid),
      鲲开: (msg, gid, uid) => handleSwitch(msg, gid, uid, '*鲲开'),
      鲲关: (msg, gid, uid) => handleSwitch(msg, gid, uid, '*鲲关'),

      /* --- 养成 --- */
      签到: doSign,
      今日运势: showFortune,
      买蛋: buyEgg,
      砸蛋: (msg, gid, uid, t) => smashEgg(msg, gid, uid, t, ''),
      孵化: hatch,
      孵蛋: hatch,
      喂食: feed,
      喝鸡汤: drinkSoup,
      磨炼: (msg, gid, uid, t) => train(msg, gid, uid, t, ''),
      磨练: (msg, gid, uid, t) => train(msg, gid, uid, t, ''),
      幻化: (msg, gid, uid) => transform(msg, gid, uid, ''),
      渡劫: tribulate,
      放生: release,
      复活: revive,
      查询: query,
      查阅属性: showAttrs,
      排行: rank,

      /* --- 对抗 --- */
      吞噬: costCheck,
      攻击: costCheck,
      强袭: costCheck,
      吞噬BOSS: costCheck,
      攻击BOSS: costCheck,
      强袭BOSS: costCheck,
      扔蛋: throwEgg,

      /* --- 拍卖行 --- */
      出售: auction,
      上架: auction,
      出价: auction,
      成交: auction,
      下架: auction,
      拍卖行: auction,
      强制下架: auction,

      /* --- 小游戏（状态机在 gameStep 里，这里只补禁言判定） --- */
      小游戏开: noop,
      小游戏关: noop,
      当前游戏: noop,
      答: noop,
      '=': noop,
      抽群主一个大嘴巴: (msg, gid, uid, t, verb) => muteCheck(msg, gid, uid, verb),
      单挑群主: (msg, gid, uid, t, verb) => muteCheck(msg, gid, uid, verb),

      /* --- 群管/杂项 --- */
      数据清除: clearData,
      查看群主指令: showOwnerHelp,
      OP: opCmd,
    };

    /** 绑定群（私聊） */
    async function bindGroup(msg, argText) {
      const gid = String(argText ?? '').trim();
      if (!gid) {
        await sendMd(
          msg,
          '用法：/kun 绑定 <群openid>' + '\n' + '群 openid 让群主在面板「群管理」里看，或先在本群发一次 /kun 菜单',
        );
        return;
      }
      await ctx.storage.set(bKey(msg.userId), gid);
      await sendMd(msg, '绑定群 ' + gid + ' 成功！');
    }

    /** 私聊里的（私）指令：磨炼 / 砸蛋 / 幻化，作用在绑定的群 */
    async function privateRun(msg, fn, argText) {
      const uid = msg.userId;
      const gid = (await ctx.storage.get(bKey(uid))) ?? '';
      if (!gid) {
        await sendMd(msg, '请先【*绑定群 群号】' + '\n' + '（本版写法：/kun 绑定 <群openid>）');
        return;
      }
      const gname = (await ctx.getGroup(gid)?.name) ?? '';
      const q = '群 ' + gname + ' ' + gid;
      const g = await readG(gid);
      if (g.on === '关') {
        await sendMd(msg, q + ' 未开启养鲲小游戏！');
        return;
      }
      const p = await readP(gid, uid);
      if (p.lu && Date.now() - p.lu < COOLDOWN_SEC * 1000) return;
      await mutateP(gid, uid, p.nm, (x) => {
        x.lu = Date.now();
      });
      await touchName(gid, uid, msg.userName);
      await fn(msg, gid, uid, argText, q);
    }

    /**
     * 统一入口。
     * 原版流程：菜单 → 开关 → 冷却 → 小游戏状态机 → 具体指令。
     */
    async function dispatch(msg, verb, args = []) {
      const v = String(verb ?? '').trim();
      if (!v) return false;
      const argText = args.join('');

      /* ---------- 私聊 ---------- */
      if (msg.kind === 'c2c') {
        if (!PRIVATE_VERBS.has(v)) return false;   // 原版私聊只认这几个
        if (v === '绑定') await bindGroup(msg, argText);
        else if (v === '磨炼' || v === '磨练') await privateRun(msg, train, argText);
        else if (v === '砸蛋') await privateRun(msg, smashEgg, argText);
        else if (v === '幻化') await privateRun(msg, transform, argText);
        return true;
      }
      if (msg.kind !== 'group') return false;

      /**
       * OP 有两种写法：`*OP/目标/项目/数值`（斜杠连写，整串会被当成一个
       * 「动词」）和 `*OP 目标 项目 数值`。这里统一成动词 `OP`，
       * 具体参数由 opCmd 自己从原文里拆（见 parseOpArgs）——
       * dispatch 给的 argText 是 `args.join('')`，会把空格写法粘成一坨。
       */
      const verbName = /^OP(?:[/／]|$)/i.test(v) ? 'OP' : v;
      const fn = HANDLERS[verbName];
      // 认不出的指令静默忽略（原版如此），但留一行 debug 方便排查「为什么没反应」
      if (!fn) {
        log.debug(`不认识的指令 ${JSON.stringify(v)}，已忽略`);
        return false;
      }

      const gid = msg.groupId;
      const uid = msg.userId;
      await touchName(gid, uid, msg.userName);

      // 菜单 / BOSS 四连 / 鲲开鲲关：不过开关和冷却
      if (PLAIN_VERBS.has(verbName)) {
        await fn(msg, gid, uid, argText, verbName);
        return true;
      }

      // 其余：开关 → 冷却 → 小游戏状态机 → 正文
      const g = await readG(gid);
      if (g.on === '关') return true;   // 开关关着：算处理过，但什么都不做
      if (!(await passCooldown(gid, uid))) return true;   // 冷却中：静默丢弃
      await gameStep(msg, gid, uid, verbName, argText);
      await fn(msg, gid, uid, argText, verbName);
      return true;
    }

    /* ================= 注册入口 ================= */

    /** 方式一：@机器人 /kun <指令> */
    ctx.command(
      'kun',
      { desc: '养鲲：/kun <指令>，或直接发 *<指令>', usage: '/kun 菜单' },
      async (msg, { args = [] } = {}) => {
        await dispatch(msg, args[0], args.slice(1));
      },
    );

    /**
     * 方式二：*<指令>（原版写法）
     *
     * 需要机器人开了「全量消息」权限才会收到没 @ 的群消息；
     * 没开的话这条分支只在私聊生效，群里请用 @机器人 /kun <指令>。
     */
    ctx.on('message', async (msg) => {
      const t = String(msg.content ?? '').trim();
      if (!t.startsWith('*')) return false;
      const body = t.slice(1).trim();
      if (!body) return false;
      const [verb, ...rest] = body.split(/\s+/);
      return dispatch(msg, verb, rest);   // 不是养鲲的指令就放给别人处理
    });

    /* ================= 面板菜单 ================= */

    ctx.menu('养鲲', [
      { text: '/kun 菜单', desc: '命令菜单' },
      { text: '/kun 签到', desc: '每日签到' },
      { text: '/kun 孵化', desc: '孵一只鲲' },
      { text: '/kun 查询', desc: '看自己的鲲' },
      { text: '/kun 排行', desc: '本群前十' },
    ]);

    log.info(`[kun] 养鲲 v${PLUGIN.version}（1:1 还原版）已加载：@机器人 /kun 菜单，或直接发 *菜单`);
  },
};

export default PLUGIN;

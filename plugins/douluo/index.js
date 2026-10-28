/**
 * 斗罗大陆 · 骨架版
 * =================
 *
 * 这个文件只做装配，不写业务：
 *
 *   setup()
 *     ├─ 开库（content.db 只读 / game.db 读写）
 *     ├─ 建 repo（内容 CRUD、玩家 CRUD）
 *     ├─ 注册面板接口（ctx.registerRoute → /api/plugins/douluo/r/...）
 *     ├─ 注册面板页面（ctx.registerPage → 面板多一个「斗罗」标签）
 *     └─ 注册命令（/斗罗、/dl）
 *
 * 所有游戏数据（武魂/魂兽/魂技/物品/地图/任务/称号/数值系数）都在
 * content.db 里，**面板可编辑**，代码里不写死任何数值。
 * 首次启动会用 src/db/seed.sql 灌一份测试数据，之后不再覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDbs } from './src/db/open.js';
import { ContentRepo } from './src/repo/content.js';
import { PlayerRepo } from './src/repo/player.js';
import { BattleRepo } from './src/repo/battle.js';
import { BalanceRepo } from './src/repo/balance.js';
import { EconomyRepo } from './src/repo/economy.js';
import { SocialRepo } from './src/repo/social.js';
import { GuildRepo } from './src/repo/guild.js';
import { CraftRepo } from './src/repo/craft.js';
import { MailRepo } from './src/repo/mail.js';
import { ProgressRepo } from './src/repo/progress.js';
import { GrowthRepo } from './src/repo/growth.js';
import { QolRepo } from './src/repo/qol.js';
import { ExtraRepo } from './src/repo/extra.js';
import { registerCommands } from './src/cmd/index.js';
import { createMedia } from './src/cmd/media.js';
import { registerRoutes } from './src/ui/api.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export default {
  id: 'douluo',
  name: '斗罗大陆',
  version: '0.2.0',
  description: '斗罗大陆文字游戏：内容全部在面板可编辑，数据用 SQLite',

  config: {
    prefix: {
      type: 'string',
      default: '/',
      label: '指令前缀',
      desc: '玩家发指令要带的前缀，默认 /，例如「/攻击」。1–4 个字符。也可以在插件面板页里改，改完菜单自动跟着变。',
      placeholder: '/',
    },
    images: {
      type: 'boolean',
      default: true,
      label: '发送图片',
      desc: '武魂/地图/魂兽在内容表里填了图时，用「图文同条」发出去（一条消息里既有图又有字）。关掉则全部退回纯文本。',
    },
    seedOnEmpty: {
      type: 'boolean',
      default: true,
      label: '首次启动灌入测试数据',
      desc: 'content.db 为空时执行 seed.sql。已经有内容时不会覆盖。',
    },
  },

  setup(ctx) {
    /**
     * 热重载时 setup 会再跑一遍，而旧库连接还开着。
     * ctx.state 跨重载保留，所以拿它当把手，先把上一轮的连接关掉，
     * 否则会攒出一堆 WAL 连接。
     */
    if (ctx.state.db) {
      try {
        ctx.state.db.close();
      } catch {}
      ctx.state.db = null;
    }

    const seed = ctx.config.seedOnEmpty !== false;
    const db = openDbs(ctx.dataDir, { seed });
    ctx.state.db = db;
    ctx.onTeardown(() => {
      try {
        db.close();
      } catch {}
      ctx.state.db = null;
    });

    const content = new ContentRepo(db.content);
    const players = new PlayerRepo(db.game, content);
    const balance = new BalanceRepo(db.game, content, players);
    const battles = new BattleRepo(db.game, content, players, balance);
    const economy = new EconomyRepo(db.game, content, players);
    const social = new SocialRepo(db.game, content, players);
    const guild = new GuildRepo(db.game, content, players, balance);
    const craft = new CraftRepo(db.game, content, players, economy);
    const mail = new MailRepo(db.game, content, players, economy);
    economy.mail = mail; // 后置注入：拍卖成交走邮件
    const progress = new ProgressRepo(db.game, content, players, balance, economy, mail);
    const growth = new GrowthRepo(db.game, content, players, economy);
    const qol = new QolRepo(db.game, content, players, economy, social);
    const extra = new ExtraRepo(db.game, content, players, economy);
    battles.growth = growth; // 战斗结束掉耐久
    battles.extra = extra;   // 组队经验加成 / 领域开局状态
    players.extra = extra;   // 领域属性进 recalc
    // 图文同条：图从内容表的 image 列取，地址可以是 URL 或 images/ 下的文件名
    const media = createMedia({ ctx, dataDir: ctx.dataDir });
    ctx.state.content = content;
    ctx.state.players = players;
    ctx.state.battles = battles;
    ctx.state.balance = balance;
    ctx.state.economy = economy;
    ctx.state.social = social;
    ctx.state.guild = guild;
    ctx.state.craft = craft;
    ctx.state.mail = mail;
    ctx.state.progress = progress;
    ctx.state.growth = growth;
    ctx.state.qol = qol;
    ctx.state.extra = extra;
    ctx.state.media = media;

    // 面板接口：必须在页面之前注册，页面一打开就会拉数据
    // 老框架没有 registerRoute 时跳过（页面还能显示，只是拿不到数据）
    if (typeof ctx.registerRoute === 'function') {
      registerRoutes(ctx, { content, players, db, economy, balance, mail });
    } else {
      ctx.logger.warn('当前框架没有 ctx.registerRoute，面板只能看不能改');
    }

    // 面板页面：把 html 读进来交给框架，框架负责挂标签 + 注入主题变量
    try {
      const html = fs.readFileSync(path.join(HERE, 'src', 'ui', 'page.html'), 'utf8');
      ctx.registerPage({ key: 'admin', label: '斗罗', html });
    } catch (e) {
      ctx.logger.error(`读不到面板页面：${e.message}`);
    }

    registerCommands(ctx, { content, players, battles, media, economy, social, guild, craft, balance, mail, progress, growth, qol, extra });

    // 面板「运行数据」里的几个指标
    ctx.setDashboard({
      metrics: [
        { label: '玩家', value: players.count(), unit: '人' },
        { label: '内容表', value: content.tables().length, unit: '张' },
        { label: '魂兽', value: content.db.prepare('SELECT COUNT(*) AS n FROM monster').get().n, unit: '只' },
        { label: '武魂', value: content.db.prepare('SELECT COUNT(*) AS n FROM wuhun').get().n, unit: '个' },
      ],
      note: seed ? '骨架版 · 测试数据' : '骨架版',
    });

    ctx.logger.info(`斗罗插件就绪：数据目录 ${ctx.dataDir}`);
  },
};

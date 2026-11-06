/**
 * 演示插件 · 读完这份源码，就能写出自己的插件
 * ==========================================
 *
 * 这不是一份 API 清单，是一份**按顺序读的教程**。正文都是真实可运行的代码；
 * 每个编号段落都注明了「改成自己的插件时该动哪几行」。
 * /demo skeleton 的两段示例都是完整模块，能直接存成文件用 test:plugin 验证。
 *
 * ── 五分钟写出第一个插件 ──────────────────────────────────────
 * 1. 建 plugins/my-plugin/index.js，把下面这段原样粘进去：
 *
 *      export default {
 *        id: 'my-plugin',                 // 必须和目录名一致，全局唯一
 *        name: '我的插件',
 *        version: '0.1.0',
 *        config: { greeting: '你好' },     // 面板据此自动生成设置表单
 *        setup(ctx) {
 *          ctx.command('hello [名字]', { desc: '打招呼' }, async (msg) => {
 *            const who = msg.args[0] || msg.userName || '你';
 *            await msg.reply(ctx.config.greeting + '，' + who + '！');
 *          });
 *          ctx.menu('玩法', [{ text: ctx.prefix + 'hello 名字', desc: '打个招呼' }]);
 *        },
 *      };
 *
 * 2. 不用开机器人，直接跑：
 *      npm run test:plugin -- my-plugin --list
 *      npm run test:plugin -- my-plugin hello 小明
 *    （也可以 npm run create -- my-plugin "我的插件" 让框架生成这个骨架。）
 * 3. 真机上把目录放进 plugins/，热重载会自动捡到；或发 /reload my-plugin。
 * 4. 装了面板的话，「设置」页已经能改 greeting，不用重启。
 *
 * 就是这么多。剩下的都是「需要时才加」的能力，按下面章节顺序看。
 *
 * ── 本文件章节（每一项都能用 /demo <项目> 真跑一遍）────────────
 *   §1 元信息       export default 那一段：id / config / frameworkVersion 为什么这么写
 *   §2 setup(ctx)   加载一次、热重载会重新 import、状态为什么不能放模块顶层变量
 *   §3 命令         hello / skeleton：注册、参数、校验、回复、错误提示
 *   §4 完整功能     storage：参数 → 校验 → 存档 → 面板 → 回复，一个真实插件的全流程
 *   §5 配置与数据   config / ctx / msg：配置、消息字段、可选能力
 *   §6 富媒体       rich / menu / stream：Markdown、可点菜单、流式
 *   §7 事件与会话   listen / ask / push：被动关键词、中间件、多轮、主动额度
 *   §8 面板与工具   panel / tool / sched：运行数据、页面、路由、AI 工具、定时任务
 *   §9 边界         limits / perm：权限、平台限制、发布自查清单
 *
 * 聊天里也能看：/demo start 是分步教程，/demo skeleton 是两段可复制的完整模块，
 * /demo help 是带章节的目录。每个项目都会真的执行一遍，输出就是示范。
 *
 * ── 写插件的六步（对应上面章节）────────────────────────────────
 *   1) 定 id（= 目录名，全局唯一）与 config（可调参数）
 *   2) setup 里注册命令 / 监听 / 菜单 / 等级，别在这里做耗时操作
 *   3) 命令里取 msg.args，校验后 msg.reply；失败要说清楚，别吞异常
 *   4) 跨重启的数据用 ctx.storage，跨热重载的用 ctx.state，文件用 ctx.dataDir
 *   5) 日志走 ctx.logger；定时器用 ctx.schedule；主动推送先查额度并 catch
 *   6) 用 npm run test:plugin 跑通，再 /reload；发布前对照 /demo limits 自查
 *
 * ── 这份文件怎么组织 ───────────────────────────────────────────
 *  只注册一个全局命令 `demo`，能力用子命令分发（命令名全局唯一，别占十几个名字）。
 *  子命令放在 DEMOS 表里，每项一个 run(ctx, msg, args)：加演示只改一张表。
 *  状态全在 ctx.state / ctx.storage，**不用模块顶层变量**（/reload 会重新 import）。
 *  可选能力先判断存在再调用：旧宿主、--mock、testkit 都可能没给全，加载失败最糟。
 *  ctx.storage 只保证 get / set / update / delete / all / flush 六个方法；
 *  测试夹具额外给的 keys / clear / has 在真机上并不存在，别照着用（§4 有对照）。
 *  不发外部图片 / 文件、不发邮件、不改静默闸：能力确实存在，但演示插件不该有外部副作用。
 *
 * 接口签名以 src/plugin/context.js、src/message.js、src/markdown.js 为准；
 * types/roost.d.ts 只管编辑器补全，个别条目已落后于实现，正文里都标了出来。
 * 现成方案调研（2026-11-06）：GitHub 上没有同类「全接口演示插件」，
 * 于是以本仓 scripts/create-plugin.mjs、docs/插件开发规范.md §14/§15、
 * plugins/dice | echo | group-admin 为蓝本，没有从零硬写。
 */

/** 恒存在的注册接口：方法一定有，但老宿主可能返回 null */
const ALWAYS_CAPS = [
  ['registerRoute', 'ctx.registerRoute —— 给面板页面注册接口'],
  ['registerTool', 'ctx.registerTool —— 暴露 AI 可调用的工具'],
  ['levelName', 'ctx.levelName —— 等级数字转名字'],
];

/** 演示插件故意不碰、但值得知道存在的能力（有些宿主根本不注入，用前判空） */
const OPTIONAL_CAPS = [
  ['mail', 'ctx.mail —— 邮件通知（会外发，演示不调用）'],
  ['reach', 'ctx.reach —— 主动消息可达性预检'],
  ['ledger', 'ctx.ledger —— 事件账本，只读'],
  ['identity', 'ctx.identity —— QQ号/群号对照，只读'],
  ['gate', 'ctx.gate —— 会话静默闸（会改状态，演示不调用）'],
  ['delivery', 'ctx.delivery —— 投递账本，只读'],
];

/** 存档键统一带前缀，避免和别的插件 / 别的版本混在一起 */
const STORE_KEY = 'demo:counter';

/** 每次操作后刷新面板「运行数据」；宿主不给就静默跳过 */
function refresh(ctx) {
  if (typeof ctx.setDashboard !== 'function') return;
  const s = ctx.state;
  ctx.setDashboard({
    metrics: [
      { label: '演示命令', value: s.commands ?? 0, unit: '次' },
      { label: '定时器滴答', value: s.ticks ?? 0, unit: '次', hint: '每 60 秒 +1，不发消息' },
      { label: '收到消息', value: s.seen ?? 0, unit: '条' },
      { label: '关键词命中', value: s.listened ?? 0, unit: '次' },
      { label: '中间件经过', value: s.middleware ?? 0, unit: '条' },
    ],
    note: [
      `问候语：${ctx.config.greeting ?? ''}`,
      `被动关键词：${ctx.config.keyword ?? ''}`,
      `主动推送演示：${ctx.config.allowPush ? '已开启' : '默认关闭'}`,
      `加载于：${new Date(s.startedAt ?? Date.now()).toLocaleString('zh-CN')}`,
    ].join('\n'),
  });
}

/** 教程章节：/demo help 的目录和 ctx.menu 的分组共用同一份，不会两处不同步 */
const CHAPTERS = [
  ['入门 · 先看这两个', ['start', 'skeleton', 'hello']],
  ['数据 · 一个插件的骨架', ['ctx', 'msg', 'config', 'storage']],
  ['交互 · 怎么把话说好看', ['rich', 'menu', 'stream']],
  ['会话 · 什么时候开口', ['listen', 'ask', 'push']],
  ['扩展 · 面板、AI 与边界', ['panel', 'tool', 'sched', 'perm', 'limits']],
];

/** 每个演示项：一句话说明 + 一个能跑的函数（§3~§9 的全部例子） */
const DEMOS = {
  help: {
    desc: '教程目录（不带项目时默认显示）',
    async run(ctx, msg) {
      const rows = CHAPTERS.flatMap(([title, keys]) => [
        `【${title}】`,
        ...keys.map(
          (k) => `  ${ctx.prefix}demo ${k}${' '.repeat(Math.max(1, 10 - k.length))}${DEMOS[k].desc}`,
        ),
      ]);
      await msg.reply(
        [
          `${ctx.name} v${ctx.version} · 读完源码就能写插件`,
          '（ctx.name / ctx.version 由宿主注入；npm run test:plugin 夹具默认给 id 和 0.0.0。）',
          `新手指路：${ctx.prefix}demo start（分步教程）→ ${ctx.prefix}demo skeleton（可复制骨架）`,
          `每一项都真的跑一遍：${ctx.prefix}demo <项目>；${ctx.prefix}help 里也有完整菜单。`,
          '',
          ...rows,
          '',
          '源码按章节编号，setup 里 1)..8) 就是「写插件的顺序」；',
          '每个 run() 都写了它演示哪个接口、改成自己的插件时该动哪几行。',
        ].join('\n'),
      );
    },
  },

  start: {
    desc: '从零写一个插件：分步教程',
    async run(ctx, msg) {
      await msg.reply(
        [
          '写插件的 7 步（每步都能在本文件里找到对应代码）',
          '',
          '1) 建文件：plugins/<id>/index.js。id 全小写短横线、和目录名一致、全局唯一。',
          '2) 写元信息：export default { id, name, version, config, setup }（本文件 §1）。',
          '   config 里的可调参数会变成面板「设置」表单，别写死在代码里。',
          '3) setup(ctx) 只做注册（本文件 §2）：command / on / menu / defineLevels /',
          '   schedule / registerPage / registerTool。加载时跑一次，别做耗时操作。',
          `4) 命令处理（本文件 §3）：ctx.command('名字 [可选] <必填>', { desc }, async (msg) => {})`,
          '   参数从 msg.args 取；缺参数自己回一句用法；await msg.reply(...) 会攒着合并发。',
          '5) 存数据（本文件 §4）：ctx.storage.update(key, fn) 原子读改写，跨重启保留；',
          '   ctx.state 跨热重载保留；图片、缓存这类文件用 ctx.dataDir。',
          '6) 让用户找得到（本文件 §2）：注册命令会自动进菜单「指令」组，',
          '   非命令玩法用 ctx.menu 补；每个命令都写 desc，别让用户猜。',
          '7) 测与发（本文件 §9）：npm run test:plugin -- <id> --list 列命令，',
          '   npm run test:plugin -- <id> <命令> 跑一条看回复；真机 /reload <id>；',
          '   改了代码要升 version，发布前对照 /demo limits 自查。',
          '',
          '最小骨架发 /demo skeleton；带存档的完整功能看 /demo storage。',
          '接口签名以 src/plugin/context.js 为准，别只信 types/roost.d.ts。',
        ].join('\n'),
      );
    },
  },

  skeleton: {
    desc: '① 最小插件 + ② 带存档的完整模块，都能复制验证',
    async run(ctx, msg) {
      await msg.reply(
        [
          `① 最小可用插件（存成 plugins/my-plugin/index.js）`,
          `----------------------------------------`,
          `export default {`,
          `  id: 'my-plugin',                  // 与目录名一致`,
          `  name: '我的插件',`,
          `  version: '0.1.0',`,
          `  config: { greeting: '你好' },      // 面板自动生成设置表单`,
          `  setup(ctx) {`,
          `    ctx.command('hello [名字]', { desc: '打招呼' }, async (msg) => {`,
          `      const who = msg.args[0] || msg.userName || '你';`,
          `      await msg.reply(ctx.config.greeting + '，' + who + '！');`,
          `    });`,
          `    ctx.menu('玩法', [{ text: ctx.prefix + 'hello 名字', desc: '打个招呼' }]);`,
          `  },`,
          `};`,
          ``,
          `② 带存档的完整功能（参数 → 校验 → 存档 → 面板 → 回复）`,
          `----------------------------------------`,
          `export default {`,
          `  id: 'my-count',`,
          `  name: '我的计数',`,
          `  version: '0.1.0',`,
          `  setup(ctx) {`,
          `    ctx.command('count [数字]', { desc: '累加计数' }, async (msg) => {`,
          `      const n = Number(msg.args[0] ?? 1);                     // ① 取参数`,
          `      if (!Number.isFinite(n) || n < 1 || n > 100) {       // ② 校验`,
          `        return msg.reply('用法：' + ctx.prefix + 'count 1~100 的数字');`,
          `      }`,
          `      const total = await ctx.storage.update('count',        // ③ 原子存档`,
          `        (cur) => (Number(cur) || 0) + n, 0);`,
          `      ctx.setDashboard({                                   // ④ 刷新面板`,
          `        metrics: [{ label: '累计', value: total, unit: '次' }],`,
          `      });`,
          `      await msg.reply('累计 ' + total + ' 次');               // ⑤ 回复`,
          `    });`,
          `  },`,
          `};`,
          ``,
          `两段都是完整模块，都能存成 plugins/<id>/index.js 用 npm run test:plugin 验证。`,
          `本文件 §4（/demo storage）就是 ② 的真实可运行版本：`,
          `多加了错误捕获、菜单、AI 工具、面板页面，但骨架完全一样。`,
        ].join('\n'),
      );
    },
  },

  hello: {
    desc: '最小命令：config / args / 回复合并',
    async run(ctx, msg, args) {
      const who = String(args[0] || msg.userName || '你').slice(0, 40);
      ctx.logger.debug('hello 被调用', { who });
      // msg.reply 不立刻发，攒到本次处理结束合并成一条；别在它后面等发送结果。
      await msg.reply(
        [
          `${ctx.config.greeting}，${who}！`,
          `问候语来自 ctx.config.greeting（面板「设置」可改，或发 ${ctx.prefix}demo config 新问候语）。`,
          '名字取自 msg.args[0]，没给就退回 msg.userName。',
        ].join('\n'),
      );
    },
  },

  ctx: {
    desc: 'ctx 上到底有什么（含可选能力）',
    async run(ctx, msg) {
      const caps = OPTIONAL_CAPS.map(
        ([key, label]) => `  ${ctx[key] ? '有' : '无'}  ${label}`,
      );
      const always = ALWAYS_CAPS.map(
        ([key, label]) => `  ${typeof ctx[key] === 'function' ? '有' : '无'}  ${label}`,
      );
      await msg.reply(
        [
          'setup(ctx) 拿到的上下文',
          `  id / name / version : ${ctx.id} / ${ctx.name} / ${ctx.version}`,
          `  prefix              : ${ctx.prefix}`,
          `  config              : ${JSON.stringify(ctx.config)}`,
          `  dataDir             : ${ctx.dataDir ?? '（当前宿主未提供）'}`,
          `  levelRange          : ${JSON.stringify(ctx.levelRange ?? {})}`,
          `  CORE_LEVELS         : ${JSON.stringify(ctx.CORE_LEVELS ?? {})}`,
          `  state 的键           : ${Object.keys(ctx.state).join(', ') || '（空）'}`,
          '',
          '常用入口：command / on / menu / storage / logger / md / api /',
          '          schedule / onTeardown / prompt / wait / push / quotaLeft /',
          '          use / setDashboard / setConfig / registerPage / registerTool',
          '',
          '恒存在的注册接口（方法在，但老宿主可能返回 null）：',
          ...always,
          '',
          '宿主可选能力（可能根本不注入，用前先判断）：',
          ...caps,
          '',
          'ctx.storage 只有 get / set / update / delete / all / flush；',
          '测试夹具额外给的 keys / clear / has 在真机上不存在，别照着写（§4 有对照）。',
          'api 是官方 HTTP 接口的包装，调用会记进出站账本；演示插件只读不调。',
        ].join('\n'),
      );
    },
  },

  msg: {
    desc: 'msg 字段：场景、身份、免@、附件',
    async run(ctx, msg) {
      const m = msg;
      await msg.reply(
        [
          '一条消息里能拿到什么',
          `  id / event        : ${m.id} / ${m.event ?? '（无）'}`,
          `  kind / chatId     : ${m.kind} / ${m.chatId}`,
          `  groupId / userId  : ${m.groupId || '（私聊为空）'} / ${m.userId}`,
          `  userName          : ${m.userName || '（频道事件可能为空）'}`,
          `  content           : ${String(m.content ?? '').slice(0, 60)}`,
          `  command / args    : ${m.command || '（非命令）'} / ${JSON.stringify(m.args)}`,
          `  isCommand         : ${m.isCommand}`,
          `  mentioned / addressed : ${m.mentioned} / ${m.addressed ?? '（旧宿主无此字段）'}`,
          `  receivedAt / replied  : ${m.receivedAt} / ${m.replied}`,
          '',
          `  attachments / images / voices / files : ${(m.attachments ?? []).length} / ` +
            `${(m.images ?? []).length} / ${(m.voices ?? []).length} / ${(m.files ?? []).length}`,
          `  quoted / msgIdx / refMsgIdx 存在与否 : ${'quoted' in m} / ${'msgIdx' in m} / ${'refMsgIdx' in m}`,
          `  raw / mentions 存在与否              : ${'raw' in m} / ${'mentions' in m}`,
          '',
          'addressed = mentioned || isCommand || sticky，判断「是不是冲着机器人来的」用它更准。',
          '语音的官方 ASR 结果在 msg.voices[0].asrText，不用自己转码。',
          `发 ${ctx.prefix}demo rich 看回复方法，${ctx.prefix}demo limits 看平台边界。`,
        ].join('\n'),
      );
    },
  },

  config: {
    desc: 'ctx.config 与 ctx.setConfig（改自己配置）',
    async run(ctx, msg, args) {
      const value = args.join(' ').trim();
      if (!value) {
        return msg.reply(
          [
            `当前配置：${JSON.stringify(ctx.config)}`,
            `改问候语：${ctx.prefix}demo config 早上好`,
            'ctx.setConfig 只改传入的键，立刻落盘到 config/bots/<机器人>/plugins/demo-x.json，',
            '并且原地更新 ctx.config —— 已经拿到的引用也会跟着变。',
            '可调参数写进 config 而不是写死在代码里，面板才能自动生成设置表单。',
          ].join('\n'),
        );
      }
      await ctx.setConfig({ greeting: value.slice(0, 40) });
      refresh(ctx);
      return msg.reply(`问候语已改成「${ctx.config.greeting}」，发 ${ctx.prefix}demo hello 试试。`);
    },
  },

  storage: {
    desc: '§4 完整功能示范：校验 → 存档 → 面板 → 回复',
    async run(ctx, msg, args) {
      const action = String(args[0] || 'show').toLowerCase();
      const st = ctx.storage;
      switch (action) {
        case 'add': {
          // ★ 这就是一个真实插件的完整流程，照抄改名字就能用：
          //   ① 取参数  ② 校验并回用法  ③ 原子存档  ④ 刷新面板  ⑤ 回复
          // 换成自己的业务时，只改这五行里的键名、校验规则和回复文案。
          // 全程只用 ctx.storage 一定有的 get / update / set / delete / all。
          const step = Number(args[1] ?? 1);
          if (!Number.isFinite(step) || step < 1 || step > 100) {
            return msg.reply(`用法：${ctx.prefix}demo storage add 1~100 的数字`);
          }
          // update 是原子读改写，并发时不会互相覆盖；fn 返回 null/undefined 表示放弃写入。
          const n = await st.update(STORE_KEY, (cur) => (Number(cur) || 0) + step, 0);
          refresh(ctx);
          return msg.reply(`计数 +${step} → ${n}（已落盘，重启还在；面板「运行数据」也更新了）`);
        }
        case 'del': {
          // delete() 不返回布尔值（真宿主返回 undefined），要先 get 判断存在。
          const before = await st.get(STORE_KEY, undefined);
          if (before === undefined) return msg.reply('没有这个键。');
          await st.delete(STORE_KEY);
          refresh(ctx);
          return msg.reply('已删除计数键。');
        }
        case 'clear': {
          // 真宿主没有 clear()，要自己遍历 all() 的键逐个 delete。
          const keys = Object.keys(await st.all());
          for (const k of keys) await st.delete(k);
          refresh(ctx);
          return msg.reply(`已清空本插件存档（${keys.length} 个键，只影响 demo-x 自己）。`);
        }
        case 'show':
        default: {
          const n = await st.get(STORE_KEY, 0);
          const all = await st.all();
          return msg.reply(
            [
              `storage.get(${STORE_KEY}) = ${n}`,
              `all()   = ${JSON.stringify(all)}`,
              `ctx.state.commands = ${ctx.state.commands ?? 0}（内存计数，跨热重载保留，重启归零）`,
              '',
              `可用动作：${ctx.prefix}demo storage add [数字] | del | clear | show`,
              '',
              '★ 本文件 DEMOS.storage 的 add 分支是「一个完整功能」的范本：参数 → 校验 → 存档 → 面板 → 回复。',
              '照着它写自己的业务，比从零想结构快得多；/demo skeleton ② 有可复制的完整模块。',
              'storage 只保证 get / set / update / delete / all / flush 六个方法，落盘在',
              'data/bots/<机器人>/plugins/demo-x.json；测试夹具多给的 keys / clear / has',
              '在真机上并不存在 —— 这是「别拿夹具当真机」最常踩的坑。',
              '要放图片 / 缓存这类文件用 ctx.dataDir，别往插件目录里写业务数据。',
            ].join('\n'),
          );
        }
      }
    },
  },

  perm: {
    desc: '权限等级：defineLevels / can / levelOf',
    async run(ctx, msg) {
      const L = ctx.state.levels ?? {};
      const lv = await ctx.levelOf(msg);
      const canAdmin = await ctx.can(msg, 'admin');
      const admin = ctx.isGroupAdmin
        ? await ctx.isGroupAdmin(msg.groupId, msg.userId)
        : false;
      const group = ctx.getGroup ? await ctx.getGroup(msg.groupId) : null;
      await msg.reply(
        [
          '权限：数字越小越高，每个插件有独立号段',
          `  ctx.defineLevels → ${JSON.stringify(L)}（调用时会自动往菜单加一组「权限等级」）`,
          `  ctx.level(0) / levelRange : ${ctx.level ? ctx.level(0) : '（无）'} / ${JSON.stringify(ctx.levelRange ?? {})}`,
          `  ctx.levelOf(msg)          : ${lv}（9999 = 无权限）`,
          `  ctx.can(msg, 'admin')     : ${canAdmin}`,
          `  ctx.isOwner(userId)       : ${ctx.isOwner(msg.userId)}`,
          `  ctx.isGroupAdmin(...)     : ${admin}`,
          `  ctx.scopeOf(msg)          : ${ctx.scopeOf(msg)}`,
          `  ctx.getGroup(...)         : ${group ? '有群档案' : '无群档案（或当前夹具不提供）'}`,
          '',
          '命令选项只认 { desc, usage, admin } 三项；admin: true 会让内核替你挡一层。',
          'globalAdmin / section / alias / cooldown / level 经 ctx.command 传了不会进命令表',
          '（src/plugin/context.js 只透传 desc / usage / pattern / admin / plugin / pluginId）。',
          'types/roost.d.ts 里的 alias / cooldown / level 是旧稿；globalAdmin 只有内核',
          '直接用 registry.addCommand 才带得上。要更细的权限判断，在 handler 里用',
          "ctx.can(msg, 'admin') / ctx.isOwner(msg.userId)，别指望选项里多写一个字段。",
        ].join('\n'),
      );
    },
  },

  rich: {
    desc: 'Markdown：replyMarkdown + ctx.md',
    async run(ctx, msg) {
      const md = ctx.md ?? {};
      const esc = typeof md.esc === 'function' ? md.esc : (s) => String(s ?? '');
      const parts = [
        '# 这是一条 Markdown 消息',
        '',
        `ctx.md.esc 会把特殊字符转义，防止用户输入破坏排版：${esc('*别把我当斜体* _还有我_')}`,
        '（测试夹具的 esc 是空实现，所以上面看着没变；真实宿主会加上反斜杠。）',
        '',
        typeof md.cmdInput === 'function'
          ? `群聊可用的可点击指令：${md.cmdInput(`${ctx.prefix}demo hello`, '点我打招呼')}`
          : '（当前宿主没有 ctx.md.cmdInput）',
        msg.kind === 'group'
          ? 'ctx.md.cmdEnter 点了直接发，群聊不支持，框架会退化成纯文本 —— 群菜单一律用 cmdInput。'
          : typeof md.cmdEnter === 'function'
            ? `单聊可点直接发：${md.cmdEnter(`${ctx.prefix}demo ctx`)}`
            : '（当前宿主没有 ctx.md.cmdEnter）',
        typeof md.at === 'function' ? `@ 标签：${md.at(msg.userId)}` : '（旧宿主没有 ctx.md.at）',
        typeof md.hr === 'function' ? md.hr() : '',
        typeof md.quote === 'function' ? md.quote('引用块也是 ctx.md 给的') : '',
        '',
        '同一家族的其它发送方法：',
        `  ${ctx.prefix}demo menu       → msg.replyMenu，把命令渲染成可点菜单`,
        '  msg.replyCard      → markdown + 按钮一次发出（ark 现在只收不发）',
        '  msg.replyTuwen     → 图文卡片，四字段必填且必须 https',
        '  msg.replyImage / replyVideo / replyVoice / replyFile / replyImageBuffer → 富媒体',
        '  msg.replyQuote     → 引用回复（旧宿主可能没有，用前判断）',
        '',
        '演示插件不上传任何外部图片 / 文件：富媒体会走官方上传，失败只记日志不抛。',
      ].filter(Boolean);
      await msg.replyMarkdown({ content: parts.join('\n') });
    },
  },

  menu: {
    desc: 'replyMenu：把命令做成可点菜单',
    async run(ctx, msg) {
      await msg.replyMenu(`${ctx.name} · 点一下就能试`, [
        {
          title: '基础',
          items: [
            { text: '打招呼', desc: '读配置 + 取参数', cmd: `${ctx.prefix}demo hello` },
            { text: '看上下文', desc: 'ctx 上有什么', cmd: `${ctx.prefix}demo ctx` },
            { text: '看消息', desc: 'msg 字段', cmd: `${ctx.prefix}demo msg` },
          ],
        },
        {
          title: '进阶',
          items: [
            { text: '存个计数', desc: 'storage 落盘', cmd: `${ctx.prefix}demo storage add` },
            { text: '看权限', desc: '等级与作用域', cmd: `${ctx.prefix}demo perm` },
            { text: '看边界', desc: '平台限制', cmd: `${ctx.prefix}demo limits` },
          ],
        },
      ]);
    },
  },

  ask: {
    desc: 'ctx.prompt 多轮对话（15 秒超时）',
    async run(ctx, msg) {
      if (typeof ctx.prompt !== 'function') {
        return msg.reply('当前环境不支持多轮对话。');
      }
      // onTimeout: false 关掉内置超时提示，自己回一句更清楚的。
      // 注意：prompt 返回的是**下一条消息对象**（有 .content），不是字符串；
      // types/roost.d.ts 写成 Promise<string|null> 已过时，以 src/plugin/context.js 为准。
      const answer = await ctx.prompt(msg, '随便回一句，我演示多轮对话。15 秒不等了。', {
        timeoutMs: 15_000,
        onTimeout: false,
      });
      if (!answer) {
        return msg.reply(
          [
            '没等到回答（超时，或测试夹具把 prompt 固定返回 null）。',
            '真实机器人里 ctx.prompt 会真的等你下一句，并自动 flush 提示语；',
            '自己手写「等下一条消息」的状态机是常见坑。',
            'ctx.wait 只等不问，ctx.cancelWait 取消等待。',
          ].join('\n'),
        );
      }
      return msg.reply(`收到了：${String(answer.content ?? '').slice(0, 80)}`);
    },
  },

  stream: {
    desc: 'msg.replyStream 流式回复（仅单聊）',
    async run(ctx, msg) {
      // 群聊也真跑一遍：框架会退化成「push 只缓存、end 发一条 Markdown」。
      // 亲眼看到只出来 1 条消息，比只读一行说明更好懂。
      const s = msg.replyStream();
      // 流式是「传全量正文、服务端算差量」：每片必须以上一片为前缀，不能中途改写。
      await s.push('演示开始');
      await s.push('演示开始……第一段');
      const full = '演示开始……第一段\n完成，三段合成一条流式消息。';
      if (msg.kind === 'group') {
        await s.end(
          [
            full,
            '',
            `当前是 ${msg.kind} 场景：官方没有群聊流式接口，框架把 replyStream 退化成一条 Markdown。`,
            '真机上 push() 只缓存、end() 发最终全文，所以三段只会合成一条消息；',
            'test:plugin 夹具会把每片都记成一条（本地看到 3 条），别拿夹具的表现当真机行为。',
            '私聊里发同样的命令才有打字机效果。',
          ].join('\n'),
        );
      } else {
        await s.end(full);
      }
    },
  },

  push: {
    desc: '主动推送：quotaLeft / isSticky / ctx.push',
    async run(ctx, msg) {
      const kind = msg.kind === 'group' ? 'group' : 'c2c';
      const left = await ctx.quotaLeft(msg.chatId, kind);
      const sticky = ctx.isSticky(msg.chatId);
      const head = [
        `ctx.quotaLeft(${msg.chatId}) = ${left}（今天这个会话还剩的主动额度）`,
        `ctx.isSticky(${msg.chatId}) = ${sticky}（是否处在免@窗口内）`,
      ];
      if (!ctx.config.allowPush) {
        return msg.reply(
          [
            ...head,
            '',
            '默认不真的发：config.allowPush 是 false。',
            '想试就把面板「设置」里改成 true（演示插件不该默认开着主动推送）。',
            '主动推送有每日额度、会打扰人，务必先看 ctx.quotaLeft，并且一定 catch。',
            '真发时：await ctx.push(chatId, text, { kind, requestId })，requestId 是幂等键；',
            'msg.push 是同一条路的被动写法。定时任务里尤其要 catch —— 额度用完会抛错。',
          ].join('\n'),
        );
      }
      try {
        await ctx.push(msg.chatId, '这是一条由 ctx.push 发出的主动消息（演示）。', {
          kind,
          requestId: `demo:${msg.id}`,
        });
        return msg.reply([...head, '', '已发出一条主动消息。'].join('\n'));
      } catch (e) {
        ctx.logger.warn('主动推送演示失败：', e.message);
        return msg.reply([...head, '', `推送失败（额度或权限）：${e.message}`].join('\n'));
      }
    },
  },

  tool: {
    desc: '跨插件 AI 工具：registerTool / tools / callTool',
    async run(ctx, msg) {
      const list = typeof ctx.tools === 'function' ? ctx.tools() : [];
      const mine = list.find((t) => t.name === 'demo_stats');
      let out = '（当前宿主没有工具表）';
      if (typeof ctx.callTool === 'function') {
        try {
          out = String(await ctx.callTool('demo_stats', {}, { msg }));
        } catch (e) {
          out = `调用失败：${e.message}`;
        }
      }
      await msg.reply(
        [
          '命令是给人打的，工具是给模型调的：中间只认一张全局工具表。',
          `  ctx.tools() 里共 ${list.length} 个工具，本插件注册的是：${mine ? mine.name : '（未找到）'}`,
          `  ctx.callTool('demo_stats', {}, { msg }) → ${out}`,
          '',
          '工具名必须全局唯一（建议带插件前缀）；失败要 throw，别返回空字符串；',
          'execute(args, call) 的 call 里有 userId / chatId / scope，按人区分就取这里。',
          '插件卸载时框架按 pluginId 自动注销，不用手动收。外部插件（py/go）暂不支持注册工具。',
        ].join('\n'),
      );
    },
  },

  panel: {
    desc: '面板：setDashboard / registerPage / registerRoute',
    async run(ctx, msg) {
      refresh(ctx);
      const dash = typeof ctx.getDashboard === 'function' ? ctx.getDashboard() : null;
      const s = ctx.state;
      await msg.reply(
        [
          '面板「运行数据」与自定义页面',
          `  ctx.setDashboard / getDashboard : ${dash ? `已推 ${dash.metrics?.length ?? 0} 个指标` : '未取到（测试夹具不缓存推送值）'}`,
          `  ctx.registerPage                : ${s.pageKey || '返回 null（测试夹具不跑页面）'}`,
          `  ctx.registerRoute               : ${s.routeKey || '返回 null（测试夹具不跑 HTTP）'}`,
          '',
          '页面在 iframe 里渲染，路由挂在 /api/plugins/demo-x/r... 下，鉴权复用面板那套；',
          '插件卸载时页面、路由、中间件、定时任务、工具都会被框架清掉。',
          '运行数据也可以不推，改成在插件导出里写 dashboard() 每次现算，二选一。',
        ].join('\n'),
      );
    },
  },

  sched: {
    desc: 'ctx.schedule / onTeardown 生命周期',
    async run(ctx, msg) {
      const s = ctx.state;
      await msg.reply(
        [
          `已用 ctx.schedule 注册 ${s.scheduleCount ?? 0} 个定时任务：每 60 秒只把 ctx.state.ticks +1，不发消息。`,
          `当前 ticks = ${s.ticks ?? 0}（测试夹具只记录不真跑定时器，所以通常是 0）。`,
          `ctx.state.startedAt = ${new Date(s.startedAt ?? Date.now()).toISOString()}，热重载不会重置它。`,
          '',
          '不要用裸 setInterval：卸载时不会清，重载后会留下一堆重复定时器。',
          'ctx.schedule 返回停止函数，但一般不用接 —— ctx.onTeardown 和 dispose 会自动收。',
          'setup 里别做耗时操作；卸载钩子 teardown(ctx) 里只做清理，别发消息。',
        ].join('\n'),
      );
    },
  },

  listen: {
    desc: "ctx.on('message') 被动关键词 + 中间件",
    async run(ctx, msg) {
      const s = ctx.state;
      await msg.reply(
        [
          `被动关键词：${ctx.config.keyword}`,
          `ctx.on('message') 收到非命令消息 ${s.seen ?? 0} 条，命中关键词 ${s.listened ?? 0} 次。`,
          `ctx.use 中间件：${s.middlewareOn ? '已注册，只计数不拦截' : '当前宿主没有中间件管道'}，经过 ${s.middleware ?? 0} 条。`,
          '',
          '被动关键词玩法**不要**判断 msg.mentioned，否则不 @ 就触发不了；',
          '主动搭话类才要判断（或直接用 msg.addressed），不然群里聊到相关词就会插嘴。',
          '监听器回一条消息、或显式 return true，就算「这条我处理了」。',
          '中间件必须 await next()，不调就等于把消息拦下来 —— 演示插件只计数，不拦。',
        ].join('\n'),
      );
    },
  },

  limits: {
    desc: '写插件前必须知道的边界',
    async run(ctx, msg) {
      await msg.reply(
        [
          '平台与框架的硬边界',
          '1. 被动回复有 5 分钟窗口（从 msg.receivedAt 起算）；msg.reply 会攒着，',
          '   一次处理合并成一条，要立刻发用 msg.replyNow。',
          '2. ctx.push / msg.push 消耗主动额度，按会话每天限量：先 ctx.quotaLeft，一定 catch。',
          '3. 命令名全局唯一，同名后注册会抛错；必填参数写 <xxx>，缺了内核自动回用法。',
          '4. ctx.on("message") 收到的是非命令消息；被动关键词不判断 mentioned，主动搭话要判断。',
          '5. 流式回复仅单聊；群聊菜单用 cmdInput，cmdEnter 群聊不支持。',
          '6. 每个插件必须提供菜单（注册命令或调 ctx.menu），否则 /help 显示「未提供菜单」。',
          '7. 富媒体走官方上传，失败只记日志不抛；图文卡片四字段必填且必须 https。',
          '8. 日志走 ctx.logger，别用 console.log；存档用 ctx.storage，业务文件用 ctx.dataDir。',
          '9. 官方只给 openid，QQ号/群号由本人自愿在面板绑定；没绑是常态，按 openid 处理即可，',
          '   不要拦截、更不要诱导用户报号。',
          '',
          `完整规范见 docs/插件开发规范.md；类型补全见 types/roost.d.ts（${ctx.prefix}demo ctx 有对照）。`,
        ].join('\n'),
      );
    },
  },
};

/* ==================================================================
 * §1 元信息：一个插件只有这一段是「必须写」的
 * ------------------------------------------------------------------
 * 改成自己的插件时：把 id 换成目录名、name/description 换成自己的，
 * version 每次改代码都要升（市场靠它判断有没有新版），config 放可调参数。
 *
 * 字段解释：
 *   id               必须等于目录名，全小写短横线，全局唯一
 *   config           默认值；面板「设置」按它生成表单，用户改的值合并进 ctx.config
 *   frameworkVersion 需要的最低框架版本，不满足时插件不启动（比跑到一半报错清楚）
 *   supportPlatforms 声明支持哪些场景，目前只做展示
 *   shortDesc / repo 面板卡片简介与源码仓库
 *   setup(ctx)       加载时调用一次，注册命令/监听/菜单（§2）
 *   teardown(ctx)    卸载时调用，做清理（§9）
 * ================================================================== */
export default {
  id: 'demo-x',
  name: '演示插件',
  version: '0.2.0',
  description: '读完源码就能写插件：分步教程、可复制骨架、全接口可运行示例',
  shortDesc: '一份能跑的插件开发教程',
  repo: 'tdcq9594/qq-bot-roost-plugins',
  frameworkVersion: '>=1.0.0',
  supportPlatforms: ['group', 'c2c'],

  // 面板「设置」会按默认值生成表单；可调参数别写死在代码里。
  // allowPush 默认关：主动推送会消耗额度、会打扰人，只有主人明确打开才真发。
  config: {
    greeting: '你好',
    keyword: '演示插件',
    allowPush: false,
  },

  /**
   * §2 setup(ctx)：加载时跑一次，只做「注册」，不做耗时操作。
   * ------------------------------------------------------------------
   * 改成自己的插件时，照着 1)..8) 的顺序挑需要的步骤删减即可：
   * 只有一个命令的插件，留 2) 菜单 + 8) 命令 就够了。
   *
   * 热重载会重新 import 本模块 —— 模块顶层变量会归零，所以状态一律放
   * ctx.state（跨热重载）或 ctx.storage（跨重启）。下面所有闭包捕获的 s
   * 就是 ctx.state 这个对象，框架在重载时会把它交给新的 setup。
   * @param {RoostCtx} ctx
   */
  setup(ctx) {
    const s = ctx.state;
    // 用 ??= 而不是直接赋值：热重载时 ctx.state 会保留，计数不该被清零。
    s.commands ??= 0;
    s.ticks ??= 0;
    s.seen ??= 0;
    s.listened ??= 0;
    s.middleware ??= 0;
    s.startedAt ??= Date.now();

    // 1) 权限等级：写偏移量即可，框架按插件 id 分配号段，不会和别人撞号。
    s.levels = ctx.defineLevels({ 演示管理员: 0, 演示成员: 2 });

    // 2) 菜单：命令会自动进「指令」组，这里把非命令玩法与教程章节补上。
    //    改成自己的插件时，把 CHAPTERS 换成自己的玩法分组；每项写 desc，别让用户猜。
    //    坑：菜单项的 cmd 只认「单个命令名」，带参数会被 /help 渲染时截成 /demo
    //    （src/main.js 的 menuItemOf 取 pattern.split(' ')[0]），点哪一项都只发 /demo。
    //    所以带参数的教程目录用纯文本项 { text, desc }，把完整命令写给人看即可。
    //    另外：ctx.command 注册过的命令别再写进 ctx.menu，会在菜单里重复出现。
    for (const [title, keys] of CHAPTERS) {
      ctx.menu(title, keys.map((k) => ({ text: `${ctx.prefix}demo ${k}`, desc: DEMOS[k].desc })));
    }
    ctx.menu('说明', [
      { text: `群里直接说「${ctx.config.keyword}」`, desc: "演示 ctx.on('message') 的被动关键词触发" },
      { text: '演示插件不上传外部图片、不发邮件、不改静默闸' },
      { text: '所有计数在 ctx.state / ctx.storage，热重载不会重置' },
    ]);

    // 3) 被动监听：关键词足够具体，且不做 mentioned 判断（被动玩法）。
    ctx.on('message', async (m) => {
      if (m.isCommand) return;
      s.seen = (s.seen ?? 0) + 1;
      const kw = String(ctx.config.keyword || '演示插件');
      if (!String(m.content ?? '').includes(kw)) return;
      s.listened = (s.listened ?? 0) + 1;
      await m.reply(
        `命中被动关键词「${kw}」——这是 ctx.on('message') 的演示，发 ${ctx.prefix}demo listen 看计数。`,
      );
      refresh(ctx);
      return true;
    });

    // 4) 中间件：只计数、必须 next()。旧宿主可能没有 pipeline，包一层别让 setup 抛错。
    try {
      ctx.use('演示计数', async (_scope, next) => {
        s.middleware = (s.middleware ?? 0) + 1;
        await next();
      });
      s.middlewareOn = true;
    } catch (e) {
      s.middlewareOn = false;
      ctx.logger.debug('当前宿主没有中间件管道，跳过 ctx.use 演示：', e.message);
    }

    // 5) 定时任务：只改内存计数，绝不定时发消息。卸载时框架自动 clearInterval。
    if (typeof ctx.schedule === 'function') {
      ctx.schedule('demo-tick', 60_000, () => {
        s.ticks = (s.ticks ?? 0) + 1;
        refresh(ctx);
      });
      s.scheduleCount = 1;
    }
    ctx.onTeardown(() => ctx.logger.debug('演示插件卸载，资源由框架统一清理'));

    // 6) 面板页面 + 自己的接口。返回 null 是正常情况（测试夹具 / 老宿主）。
    if (typeof ctx.registerPage === 'function') {
      s.pageKey = ctx.registerPage({
        key: 'stats',
        label: '演示数据',
        html:
          '<div style="font:14px/1.7 system-ui;padding:16px">' +
          '<h3>演示插件</h3><p>这是 ctx.registerPage 注册的页面。</p>' +
          '<p>数据来自 ctx.registerRoute 注册的 GET /stats 接口。</p>' +
          '</div>',
      });
    }
    if (typeof ctx.registerRoute === 'function') {
      s.routeKey = ctx.registerRoute('GET', '/stats', async ({ json }) =>
        json(200, {
          commands: s.commands,
          ticks: s.ticks,
          seen: s.seen,
          listened: s.listened,
        }),
      );
    }

    // 7) 跨插件 AI 工具：注册一个只读计数工具，别处（AI 插件）不用认识本插件。
    if (typeof ctx.registerTool === 'function') {
      ctx.registerTool({
        name: 'demo_stats',
        description: '读取演示插件的运行计数，用于演示跨插件 AI 工具怎么注册和调用',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return `演示命令 ${s.commands ?? 0} 次，定时器 ${s.ticks ?? 0} 次，关键词命中 ${s.listened ?? 0} 次`;
        },
      });
    }

    // 8) §3 命令：唯一一个全局命令。子命令走表驱动，加演示只改 DEMOS 一张表。
    //    改成自己的插件时，通常直接写几个 ctx.command('名字', {desc}, handler)；
    //    本文件为了不占用十几个全局命令名，才把演示项收进一个 /demo 下。
    //    handler 里统一 try/catch：预期外的失败也要回一句人话，不能静默吞掉。
    ctx.command(
      'demo [项目] [参数...]',
      {
        desc: `框架能力演示：${ctx.prefix}demo 看清单，${ctx.prefix}demo <项目> 看一个能跑的例子`,
        usage: `${ctx.prefix}demo [项目] [参数...]`,
      },
      async (msg) => {
        s.commands = (s.commands ?? 0) + 1;
        const [key = '', ...args] = msg.args;
        const item = key ? DEMOS[key.toLowerCase()] : DEMOS.help;
        if (!item) {
          await msg.reply(
            `没有「${key}」这个演示项目。可用：${Object.keys(DEMOS).join(' ')}\n发 ${ctx.prefix}demo 看完整清单。`,
          );
        } else {
          try {
            await item.run(ctx, msg, args);
          } catch (e) {
            // 预期外的失败也要说清楚，不能静默吞掉。
            ctx.logger.error(`演示 ${key || 'help'} 出错:`, e.message);
            await msg.reply(
              [
                `这个演示用到了当前宿主没提供的能力：${e.message}`,
                '别把测试夹具当成真机 —— 夹具往往比真实 ctx 多给方法（storage.keys/clear/has 就是）。',
                '接口是否存在，以 src/plugin/context.js 为准；用前先 typeof 判断。',
              ].join('\n'),
            );
          }
        }
        refresh(ctx);
      },
    );

    refresh(ctx);
    ctx.logger.info(`${ctx.name} v${ctx.version} 已加载：${Object.keys(DEMOS).length} 个演示项`);
  },

  teardown(ctx) {
    // 定时器、工具、页面、路由、中间件都由框架按 pluginId 清理，这里只留一行日志。
    ctx.logger.info('演示插件已卸载');
  },
};

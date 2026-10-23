/**
 * 示例插件：回声
 * 演示三件事——注册命令、监听普通消息、把运行数据展示到面板。
 *
 * 注意：群消息不一定都 @ 机器人（取决于订阅的事件），
 * 所以「主动搭话」类逻辑要先判断 msg.mentioned，否则会在群里乱插话。
 */

// 面板要看的计数。真实插件可以换成存档 / 数据库，示例就放内存里
const stats = { seen: 0, replied: 0, lastAt: 0, lastText: '' };
const startedAt = Date.now();

export default {
  id: 'echo',
  name: '回声',
  version: '1.1.0',
  description: '复读机，演示命令、消息监听与面板运行数据',

  /**
   * 面板「运行数据」标签。
   * 写成函数就每次拉取时现算（框架有 1 秒缓存，不会打爆）；
   * 也可以写成普通对象，或用 ctx.setDashboard() 主动推。
   */
  dashboard() {
    const last = stats.lastAt
      ? new Date(stats.lastAt).toLocaleTimeString('zh-CN', { hour12: false })
      : '还没收到过消息';
    return {
      metrics: [
        { label: '已回复', value: stats.replied, unit: '条' },
        { label: '收到消息', value: stats.seen, unit: '条' },
        {
          label: '运行时长',
          value: Math.round((Date.now() - startedAt) / 1000),
          unit: '秒',
          hint: '本次加载后累计',
        },
        {
          label: '回复率',
          value: stats.seen ? Math.round((stats.replied / stats.seen) * 100) : 0,
          unit: '%',
        },
      ],
      note: `最后一条：${last}\n最近内容：${stats.lastText || '（无）'}`,
    };
  },

  setup(ctx) {
    // 1) 注册命令：/echo 你好世界
    ctx.command('echo <内容...>', { desc: '原样返回你说的内容' }, async (msg) => {
      const text = msg.args.join(' ');
      if (!text) return msg.reply(`用法: ${ctx.prefix}echo 随便说点什么`);
      await msg.reply(text);
      stats.replied += 1;
      stats.lastAt = Date.now();
      stats.lastText = text.slice(0, 40);
    });

    // 2) 监听所有消息（不是命令的也会进来）
    //    这里只在「@了机器人」时才搭话，避免刷屏
    ctx.on('message', async (msg) => {
      stats.seen += 1;
      stats.lastAt = Date.now();
      stats.lastText = String(msg.content ?? '').slice(0, 40);

      if (msg.isCommand) return; // 命令已由上面处理
      if (!msg.mentioned) return; // 没 @ 就不插话
      if (msg.content.includes('你好')) {
        await msg.reply(`你好呀，我是 ${ctx.name}。发 ${ctx.prefix}help 看命令。`);
        stats.replied += 1;
      }
    });
  },
};

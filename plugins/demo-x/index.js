/**
 * 演示插件
 * ========
 *
 * 用 `npm run test:plugin -- demo-x hello` 直接跑，不用开机器人。
 */

export default {
  id: 'demo-x',
  name: '演示插件',
  version: '0.1.0',
  description: '入门示例：一个命令 + 一份配置 + 一份菜单，照着改就能写自己的插件',

  // 面板「设置」页会按这里的默认值生成表单。
  // 想加校验就写成完整写法：{ default: 3, type: 'number', min: 1, max: 10, desc: '次数' }
  config: {
    greeting: '你好',
  },

  /** @param {RoostCtx} ctx */
  setup(ctx) {
    ctx.command('hello [名字]', { desc: '跟某人打招呼' }, async (msg) => {
      const who = msg.args[0] || msg.userName || '你';
      await msg.reply(`${ctx.config.greeting}，${who}！`);
    });

    // 非命令玩法也要进菜单，不然用户不知道有这功能
    ctx.menu('演示插件', [
      { text: '/hello 名字', desc: '打个招呼' },
    ]);
  },
};

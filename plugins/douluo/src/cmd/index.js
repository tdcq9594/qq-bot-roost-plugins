/**
 * 指令分发
 * ========
 *
 * 三条入口，共用一套处理器：
 *
 *   1. `<前缀><指令> [参数]`   ← 主用法。前缀默认 `*`，可在面板或 `设置前缀` 改。
 *      加前缀是为了**和群聊正常说话区分开**：不带前缀的「攻击」「属性」在群里
 *      天天有人随口说，裸词触发会变成噪音。这也是同类插件最常见的体验问题。
 *
 *   2. `/斗罗 <指令> [参数]`   ← 框架命令，带参数提示和帮助，适合新玩家
 *   3. `/dl <指令>`            ← 别名
 *
 * 前缀可自定义（ctx.config.prefix），改完菜单里的可点击项会跟着变。
 *
 * 零静默：认不出的词一定回一句话。特别地，如果玩家**漏了前缀**
 * （发了裸的「攻击」），会直接告诉他正确写法——这比沉默好得多。
 */
import { createHandlers } from './handlers.js';

/** 前缀合法性：1–4 个字符，空则回退默认 */
function normalizePrefix(raw, fallback = '/') {
  const s = String(raw ?? '').trim();
  if (!s) return fallback;
  return s.slice(0, 4);
}

export function registerCommands(ctx, deps) {
  const pfx = () => normalizePrefix(ctx.config?.prefix, '/');
  const H = createHandlers({ ...deps, pfx });
  // 给面板用：列出全部指令词（前缀改了以后页面上要能显示正确写法）
  ctx.state.verbs = H;

  /**
   * 把正文里 `反引号包着的指令词` 补上前缀。
   *
   * 这样处理器里写提示时可以只写 `攻击`，不用到处拼前缀；
   * 前缀一改，所有提示自动跟着变。
   */
  const VERBS = Object.keys(H).sort((a, b) => b.length - a.length);
  function decorate(text) {
    let out = String(text ?? '');
    const p = pfx();
    for (const v of VERBS) {
      out = out.replace(new RegExp('`' + escapeRe(v) + '`', 'g'), '`' + p + v + '`');
    }
    return out;
  }

  /** 包一层 msg，让所有 reply* 自动补前缀 */
  function wrap(msg) {
    return new Proxy(msg, {
      get(target, key) {
        const v = target[key];
        if (key === 'reply') return (text) => target.reply(decorate(text));
        if (key === 'replyNow') return (text) => target.replyNow(decorate(text));
        if (key === 'replyMarkdown') {
          return (md, kb) => target.replyMarkdown({ ...md, content: decorate(md?.content ?? '') }, kb);
        }
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }

  async function dispatch(msg, verb, args = []) {
    const v = String(verb ?? '').trim();
    const m = wrap(msg);

    if (!v) {
      await H['菜单'].run(m, []);
      return true;
    }
    const h = H[v];
    if (h) {
      await h.run(m, args);
      return true;
    }

    // ---- 零静默：认不出也要回话 ----
    const near = VERBS.filter((k) => k.includes(v) || v.includes(k)).slice(0, 3);
    const lines = [`没有「${v}」这个指令。`];
    if (near.length) lines.push(`你要找的是不是：${near.map((k) => '`' + pfx() + k + '`').join(' / ')}`);
    lines.push(`发 \`${pfx()}菜单\` 看全部`);
    await m.reply(lines.join('\n'));
    return true;
  }

  /* ---------------- 入口 1：框架命令（前缀默认就是它） ---------------- */

  /**
   * 把每个动词都注册成框架命令。
   *
   * 为什么必须这么做：框架在 `src/bot.js` 里对「isCommand 但查不到命令」的消息
   * 直接回一句「没有这个命令」并 return，**监听器根本没机会执行**。
   * 所以前缀如果是 `/`（默认），`/攻击` 必须是一条真命令，否则会被框架吃掉。
   *
   * 顺带好处：`/help 斗罗` 能看到全部指令，参数提示、权限校验也都由框架提供。
   */
  const skipped = [];
  for (const [verb, h] of Object.entries(H)) {
    try {
      ctx.command(
        verb,
        { desc: h.desc, usage: `${pfx()}${h.usage ?? verb}`, section: '斗罗' },
        async (msg) => {
          await h.run(wrap(msg), Array.isArray(msg.args) ? msg.args : []);
        },
      );
    } catch (e) {
      // 名字被别的插件占了：记下来，走前缀监听那条路照样能用
      skipped.push({ verb, reason: e.message });
    }
  }
  if (skipped.length) {
    ctx.logger.warn(
      `有 ${skipped.length} 个指令名被别的插件占用，只能靠前缀触发：` +
        skipped.map((s) => s.verb).join('、'),
    );
  }

  // 兜底入口：`/斗罗 <指令>`，前缀被改成别的字符时也能用
  ctx.command(
    '斗罗 [指令]',
    { desc: `斗罗大陆：${pfx()}菜单，或 /斗罗 <指令>`, usage: '/斗罗 菜单', section: '斗罗' },
    async (msg) => {
      const [v, ...rest] = Array.isArray(msg.args) ? msg.args : [];
      await dispatch(msg, v, rest);
    },
  );

  ctx.command('dl [指令]', { desc: '斗罗大陆（别名）', usage: '/dl 菜单', section: '斗罗' }, async (msg) => {
    const [v, ...rest] = Array.isArray(msg.args) ? msg.args : [];
    await dispatch(msg, v, rest);
  });

  /* ---------------- 入口 2：前缀指令 ---------------- */

  ctx.on('message', async (msg) => {
    // 框架命令（/斗罗、/dl）已由上面的 handler 处理，别抢
    if (msg.isCommand) return false;

    const text = String(msg.content ?? '').trim();
    const p = pfx();
    if (!text.startsWith(p)) return false;

    const body = text.slice(p.length).trim();
    if (!body) {
      await dispatch(msg, '', []);
      return true;
    }
    const [verb, ...rest] = body.split(/\s+/);
    return dispatch(msg, verb, rest);
  });

  /* ---------------- 入口 3：漏了前缀也要教 ---------------- */

  /**
   * 玩家直接发「攻击」这种裸词时，告诉他正确写法。
   *
   * 为什么单独做：群里玩家看别人截图照着打，很容易漏掉前缀，
   * 然后「没反应」→ 以为游戏坏了。同类插件在这里基本是静默丢弃。
   * 只在「被 @」或「私聊」或「免@窗口内」才纠正，避免群里聊天误触发。
   */
  ctx.on('message', async (msg) => {
    if (msg.isCommand) return false;
    const text = String(msg.content ?? '').trim();
    const p = pfx();
    if (text.startsWith(p)) return false;
    const first = text.split(/\s+/)[0];
    if (!first || !H[first]) return false;
    if (msg.groupId && !msg.mentioned && !ctx.isSticky(msg.chatId)) return false;
    await wrap(msg).reply(`指令要加前缀：\`${p}${first}\``);
    return true;
  });

  /* ---------------- 前缀本身可改 ---------------- */

  ctx.command('前缀', { desc: '查看当前指令前缀', section: '斗罗' }, async (msg) => {
    await msg.replyMarkdown({
      content: ['## 指令前缀', `> 当前前缀：\`${pfx()}\``, '', `用法：\`${pfx()}菜单\``].join('\n'),
    });
  });

  ctx.command('设置前缀 <新前缀>', { desc: '修改指令前缀（仅主人）', section: '斗罗' }, async (msg) => {
    if (!ctx.isOwner(msg.userId)) {
      await msg.reply('只有机器人主人能改前缀。');
      return;
    }
    const next = normalizePrefix(msg.args?.[0], '');
    if (!next) {
      await msg.reply('用法：`/设置前缀 。`（1–4 个字符）');
      return;
    }
    await ctx.setConfig({ prefix: next });
    await msg.replyMarkdown({
      content: ['## 前缀已改', `> 现在是 \`${next}\``, '', `试试 \`${next}菜单\``].join('\n'),
    });
  });

  /* ---------------- 菜单（面板里也能看到） ---------------- */

  ctx.menu('斗罗大陆', [
    { text: `${pfx()}菜单`, cmd: `${pfx()}菜单`, desc: '主菜单' },
    { text: `${pfx()}帮助`, cmd: `${pfx()}帮助`, desc: '指令说明' },
    { text: `${pfx()}属性`, cmd: `${pfx()}属性`, desc: '面板与战力' },
    { text: `${pfx()}魂兽`, cmd: `${pfx()}魂兽`, desc: '本地图能打什么' },
    { text: `${pfx()}任务`, cmd: `${pfx()}任务`, desc: '任务与进度' },
  ]);

  return { dispatch, handlers: H };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

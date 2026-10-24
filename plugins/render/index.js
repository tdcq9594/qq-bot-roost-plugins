/**
 * 图片渲染插件（示例）
 * ====================
 *
 * 把一段文字画成图片发出去。适合「排行榜」「战报」这类排版复杂、
 * 纯文本表达不清楚的内容。
 *
 * **需要可选依赖 `@napi-rs/canvas`**，框架不会替你装——渲染是重功能，
 * 不用的人不该为它多下一个几十兆的原生模块。想用就这样装：
 *
 *   npm i @napi-rs/canvas --prefix plugins/render
 *
 * 装完不用重启，热重载会自动把它捡起来（改完文件 2 秒内生效）。
 *
 * 用法：
 *   /card 今天天气不错     画成一张图
 */

/** 按宽度折行：中文按字符宽度算，英文按单词断 */
function wrapText(text, maxWidth, measure) {
  const lines = [];
  let cur = '';
  for (const ch of text) {
    if (ch === '\n') {
      lines.push(cur);
      cur = '';
      continue;
    }
    const next = cur + ch;
    if (measure(next) > maxWidth && cur) {
      lines.push(cur);
      cur = ch;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export default {
  id: 'render',
  name: '图片渲染',
  version: '0.1.0',
  description: '把文字画成图片（需要可选依赖 @napi-rs/canvas）',

  config: {
    width: 720,
    /** 内边距 */
    padding: 40,
    fontSize: 26,
    lineHeight: 1.6,
    /** 背景色与文字色 */
    bg: '#19120e',
    fg: '#ede7df',
    /** 顶部小标题，留空则不画 */
    title: '',
  },

  setup(ctx) {
    let canvasMod = null;
    let loadErr = '';

    async function ensureCanvas() {
      if (canvasMod) return canvasMod;
      try {
        // 裸模块名会从 plugins/render/node_modules 里找，装了就能拿到
        canvasMod = await import('@napi-rs/canvas');
        ctx.logger.info('渲染依赖已就绪');
        return canvasMod;
      } catch (e) {
        loadErr = e.message;
        return null;
      }
    }

    ctx.command('card <文字...>', { desc: '把文字渲染成图片' }, async (msg) => {
      const text = String(msg.args.join(' ') || '').trim();
      if (!text) return msg.reply('用法：/card 要画成图的文字');

      const m = await ensureCanvas();
      if (!m) {
        return msg.reply(
          [
            '渲染插件还没装依赖（这是可选的，框架不会自动装）。',
            '',
            '在项目根目录执行：',
            '  npm i @napi-rs/canvas --prefix plugins/render',
            '',
            '装完存盘即生效，不用重启。',
            loadErr ? `（当前错误：${loadErr.split('\n')[0]}）` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }

      const c = ctx.config;
      const { createCanvas } = m;

      // 先用临时画布量文字，算出需要多高
      const probe = createCanvas(10, 10).getContext('2d');
      const font = `${c.fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
      probe.font = font;

      const innerW = c.width - c.padding * 2;
      const lines = wrapText(text, innerW, (s) => probe.measureText(s).width);
      const lineH = Math.round(c.fontSize * (c.lineHeight || 1.6));
      const titleH = c.title ? Math.round(c.fontSize * 1.8) : 0;
      const height = Math.max(
        160,
        c.padding * 2 + titleH + lines.length * lineH,
      );

      const canvas = createCanvas(c.width, height);
      const g = canvas.getContext('2d');
      g.fillStyle = c.bg;
      g.fillRect(0, 0, c.width, height);

      g.textBaseline = 'top';
      let y = c.padding;

      if (c.title) {
        g.font = `600 ${Math.round(c.fontSize * 1.05)}px "Microsoft YaHei", "PingFang SC", sans-serif`;
        g.fillStyle = c.fg;
        g.fillText(c.title, c.padding, y);
        y += titleH;
      }

      g.font = font;
      g.fillStyle = c.fg;
      for (const line of lines) {
        g.fillText(line, c.padding, y);
        y += lineH;
      }

      const buf = await canvas.encode('png');
      const sent = await msg.replyImageBuffer(buf);
      if (!sent) return msg.reply('图生成好了，但发送失败，看日志里的具体错误');
    });

    ctx.menu('渲染', [
      { text: '/card 文字', desc: '把文字画成一张图片' },
      { text: '需要可选依赖', desc: 'npm i @napi-rs/canvas --prefix plugins/render' },
    ]);
  },
};

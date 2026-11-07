/**
 * ai-chat 接入框架通用图文出口 `msg.replyAuto()` 的行为回归（2026-11-07）。
 *
 * 这里是**行为**测试，不是源码文本断言（`ai-chat-budget-media.mjs` 管那部分）。
 * 最终形态是「两层语法」：
 *   1. 模型侧只认标记：`<<image: 路径>>` 图文同条（转换成 `![](路径)` 交给框架）、
 *      `<<image-alone: 路径>>` 单独一条（插件自己 `sendMedia`）；
 *      代码块 / 行内代码里的标记一律不执行，值不像路径的也不执行；
 *   2. 任何通道上都**不能把本地绝对路径发给用户**；
 *   3. 带按钮不再绕开自动出口；框架缺能力时明确报错、不静默丢消息。
 *
 * 跑法：node test/ai-chat-auto-layout.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, '..', 'plugins', 'ai-chat');

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}${detail ? '  ' + detail : ''}`);
  }
};

const {
  parseActions, hasInlineImage, extractInlineImages,
} = await import(pathToFileURL(path.join(PLUGIN, 'decide.js')));
const { sendAutoReply } = await import(pathToFileURL(path.join(PLUGIN, 'outbound.js')));

/* 1. 单独发一条图：`<<image-alone: 路径>>` 抽成动作，正文只留文字 */
{
  const src = '前面\n<<image-alone: C:/贴纸/笑.png>>\n后面';
  const r = parseActions(src);
  ok('单独发图: 正文里不剩路径',
    !r.text.includes('C:/') && !r.text.includes('<<image'), r.text.replace(/\n/g, '\\n'));
  ok('单独发图: 抽成 image 动作',
    r.actions.length === 1 && r.actions[0].type === 'image' && r.actions[0].value === 'C:/贴纸/笑.png',
    JSON.stringify(r.actions));
  ok('单独发图: 前后文字照常留下', r.text.includes('前面') && r.text.includes('后面'));

  const full = parseActions('<<image-alone：C:/a.png>>');
  ok('单独发图: 全角冒号也认，同样摘干净',
    full.text === '' && full.actions[0]?.type === 'image' && full.actions[0]?.value === 'C:/a.png');
}

/* 2. 就地图：`<<image: 路径>>` 换成框架认的 markdown 图片，位置不动 */
{
  const src = '前面\n<<image: C:/贴纸/空格 名.png>>\n后面';
  const r = parseActions(src);
  ok('就地图: 换成 markdown 图片留在原位',
    r.text === '前面\n![](C:/贴纸/空格 名.png)\n后面', JSON.stringify(r.text));
  ok('就地图: 不转成内部 image 动作（位置交给框架）', r.actions.length === 0);
  const mixed = parseActions('记一下 <<remember: 猫>> 然后 <<image: C:/a.png>> 结束 <<mood: x>>');
  ok('就地图: 其它标记照旧摘干净，图片位置不变',
    !mixed.text.includes('<<remember') && !mixed.text.includes('<<mood')
    && mixed.text.indexOf('![](C:/a.png)') > mixed.text.indexOf('然后')
    && mixed.text.indexOf('![](C:/a.png)') < mixed.text.indexOf('结束'),
    mixed.text);
}

/* 3. 主动通道：没有 msg 对象，抽掉图片只为不泄漏路径 */
{
  const r = extractInlineImages('前\n![](C:/贴纸/笑.png)\n后');
  ok('extractInlineImages: 正文里不再有本地路径', !r.text.includes('C:/'), JSON.stringify(r.text));
  ok('extractInlineImages: 路径收进内部动作', r.images.length === 1 && r.images[0].value === 'C:/贴纸/笑.png');
  ok('extractInlineImages: 普通链接不误伤',
    extractInlineImages('[看这里](https://x/y)').text === '[看这里](https://x/y)');
  ok('extractInlineImages: 空 src 不造空动作',
    extractInlineImages('![](  )').images.length === 0);
}

/* 4. hasInlineImage 看的是「转换之后」的正文 */
{
  ok('hasInlineImage 认框架的 markdown 图片', hasInlineImage('![](a.png)'));
  ok('hasInlineImage 不认模型标记（转换前它还不是图）', !hasInlineImage('<<image: a.png>>'));
  ok('parseActions 转换后 hasInlineImage 才成立',
    hasInlineImage(parseActions('<<image: C:/a.png>>').text));
  ok('hasInlineImage 不误判普通文本/链接',
    !hasInlineImage('[x](a.png)') && !hasInlineImage('今天真开心'));
}

/* 5. sendAutoReply 契约：不再有 null 兜底，按钮与幂等键原样透传 */
{
  let logged = '';
  const old = await sendAutoReply({ reply: () => {} }, '前 ![x](a.png) 后', {
    log: (m) => { logged = m; },
  });
  ok('框架没有 replyAuto 时明确失败，不返回 null', old !== null && old.ok === false);
  ok('框架没有 replyAuto 时 unsupported=true，且不再发第二遍', old.unsupported === true && old.units === 1);
  ok('框架没有 replyAuto 时日志说清原因', logged.includes('replyAuto'), logged);

  const calls = [];
  const KB = { content: { rows: [] } };
  const msg = {
    replyAuto: async (text, opts) => {
      calls.push({ text, opts });
      return { id: 'MSG-1' };
    },
  };
  let reported = '';
  const r = await sendAutoReply(msg, '前 ![x](a.png) 后', {
    requestId: 'r-1', keyboard: KB, onSent: (id) => { reported = id; },
  });
  ok('正常路径占用 1 个发送单元', r && r.ok === true && r.units === 1 && r.fellBack === false);
  ok('幂等键与 keyboard 原样透传给框架',
    calls[0].opts.requestId === 'r-1' && calls[0].opts.keyboard === KB);
  ok('不再传任何路径白名单参数',
    calls[0].opts.allowedRoots === undefined && calls[0].opts.hints === undefined);
  ok('正文原样交给框架（位置由框架判）', calls[0].text === '前 ![x](a.png) 后');
  ok('消息 id 报给 onSent，撤回功能不受影响', reported === 'MSG-1');
}

{
  /** 模拟框架内部降级：文本 1 条 + 独立图 2 条 */
  const msg = {
    replyAuto: async (_text, opts) => {
      opts.onResult?.({ mode: 'fallback', reason: 'oversize', image: 0, state: 'sent' });
      opts.onResult?.({ mode: 'fallback', reason: 'oversize', image: 1, state: 'sent' });
      opts.onResult?.({ mode: 'fallback', reason: 'oversize', images: 2 });
      return null;
    },
  };
  const r = await sendAutoReply(msg, '前 ![x](big.png) 后', { requestId: 'r-2' });
  ok('降级后按真实条数扣预算（文本 1 + 图 2）', r && r.units === 3 && r.fellBack === true);
  ok('降级不算成功，但仍算「已尝试」，不许再走老路径', r && r.ok === true);
}

{
  /**
   * 降级但**一张图都没补发**：`bad_format` / `outside` 只发原位提示。
   * 这时只能算 1 个发送单元，多算一格会白扣被动额度，把后面本来能发的附件挤掉。
   */
  const msg = {
    replyAuto: async (_text, opts) => {
      opts.onResult?.({ mode: 'fallback', reason: 'bad_format', images: 0 });
      return null;
    },
  };
  const r = await sendAutoReply(msg, '前 ![x](假图.png) 后', { requestId: 'r-3' });
  ok('只发提示、不补图时只占 1 格', r && r.units === 1, JSON.stringify(r));
  ok('这种情况仍算「已尝试」，不许回退老路径再发一遍', r && r.fellBack === true && r.ok === true);
}

{
  /**
   * `msg_type=7` 出口：**一张图就是一条消息**。
   * 框架把真实条数报在 `sent` 里，别一律按 1 算——三条图少扣两格，
   * 后面的分段就可能撞上「被动回复 5 条」上限被拒。
   */
  const msg = {
    replyAuto: async (_text, opts) => {
      opts.onResult?.({ mode: 'media-text', images: 3, sent: 3 });
      return { id: 'm-1' };
    },
  };
  const r = await sendAutoReply(msg, '前\n![a](1.png)\n![b](2.png)\n![c](3.png)');
  ok('富媒体出口按真实发出条数扣预算', r && r.units === 3, JSON.stringify(r));

  const one = await sendAutoReply(
    { replyAuto: async (_t, o) => { o.onResult?.({ mode: 'media', images: 1, sent: 1 }); return { id: 'm-2' }; } },
    '![a](1.png)',
  );
  ok('单图仍是 1 格', one && one.units === 1);
}

{
  const msg = { replyAuto: async () => { throw new Error('炸了'); } };
  const r = await sendAutoReply(msg, '前 ![x](a.png) 后');
  ok('框架抛错时收成结构化失败，不把异常抛回调用方', r && r.ok === false && r.units === 1);
}

/* 6. 源码级：主动 /send 必须抽图；全链路不再有兼容层与白名单 */
{
  const index = fs.readFileSync(path.join(PLUGIN, 'index.js'), 'utf8');
  const sendRoute = index.slice(
    index.indexOf("registerRoute?.('POST', '/send'"),
    index.indexOf("registerRoute?.('POST', '/send'") + 2200,
  );
  ok('主动消息通道用 extractInlineImages 抽掉图片节点',
    sendRoute.includes('extractInlineImages('));
  /**
   * 顺序必须是「先 parseActions（把 `<<image:>>` 转成 `![](路径)`）→ 再抽图」。
   * 反过来写抽的是还没转换的标记，等于没抽，`![](C:/…)` 会当纯文本推给用户。
   */
  ok('主动消息通道先转换再抽图（顺序不能反）',
    sendRoute.indexOf('parseActions(') < sendRoute.indexOf('extractInlineImages('),
    '顺序反了会把本地路径当纯文本发出去');
  ok('index.js 里不再有旧标记兼容 / 白名单链路',
    !/markdownImagesToLegacy|keepImages|autoImageLayout|imageRoots|allowedRoots/.test(index));
  ok('单独发图的 image 动作并进 media（正文发完由 sendMedia 另发）',
    /let media = actions\.filter\(\(a\) => a\.type === 'voice' \|\| a\.type === 'image'\)/.test(index)
    && index.includes('sendMedia(msg, media'));

  const out = fs.readFileSync(path.join(PLUGIN, 'outbound.js'), 'utf8');
  ok('outbound.js 不再有 allowedRoots，且透传 keyboard',
    !/allowedRoots/.test(out) && /if \(keyboard\) opts\.keyboard = keyboard;/.test(out));
}

console.log(`\n${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  console.log('失败：' + fails.join('、'));
  process.exitCode = 1;
}

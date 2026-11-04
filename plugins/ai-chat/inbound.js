/**
 * 入站整形：把一条 QQ 消息整成「宿主能看懂的一段话」。
 *
 * 这一步是 Roost 相比 OneBot 方案最占便宜的地方——官方直接给了：
 *   · 语音的 ASR 结果（`asrText`）——不用自己跑识别
 *   · 转好的 WAV（`wavUrl`）——不用自己转码
 *   · 合并转发展开后的文本（`elements` 里 `type: 'chatRecord'`）
 *   · 结构化卡片（`ark`）
 *   · 被引用的原文（`quoted`）
 *
 * 以前那份插件只把 `msg.content` 发过去，这些东西全丢了——
 * 用户发一段语音，模型看到的是空字符串。
 */

import { isImageAttachment } from './vision.js';

/**
 * 图片说明：**给本地路径，不给 URL**。
 *
 * QQ 的图片 URL 有时效，模型拿它去 `<<image: url>>` 转发，过一会儿就 404；
 * 而本地路径是我们自己落盘的，只要没被清理就一直能读。
 *
 * 四种情况分开说，别让模型猜：
 *   · `'off'`    —— 这一轮关了看图，明确说看不到
 *   · `null`     —— 不知道（结构化通道用，图片另走 vision），中性一句话
 *   · 数组里有项 —— 取到并落盘给路径；取到但没落盘说清"能看到但没存"
 *   · 数组是空的 —— 尝试过但全失败，说清"没取到，可以让对方重发"
 */
function imageNote(got, images) {
  if (images === 'off') return '（发来一张图；这一轮没开看图，看不到内容）';
  if (images === null) return '（发来一张图）';
  if (got?.path) return `（发来一张图，已存到本地：${got.path}）`;
  if (got) return '（发来一张图，能看到内容，但没存到本地）';
  return '（发来一张图，但没取到——可以让对方重发）';
}

/** 附件 → 一行说明。没有就返回空数组 */
export function describeAttachments(msg, images = null) {
  const out = [];
  const list = Array.isArray(images) ? images : [];
  let imgIdx = 0;

  for (const a of msg.attachments ?? []) {
    switch (a?.type) {
      case 'voice':
        /**
         * 转写成功时**一个字都不写**。
         *
         * 以前这里输出「（发了一条语音）」，而转写文字就在它上一行。
         * 模型会把那行说明当成「这条消息的实质」，把转写当成附件备注，
         * 于是回一句「我只看到『发了条语音』这几个字」——2026-11-03
         * 线上真实发生，用户以为识别坏了，其实文字一直好好地摆在那儿。
         *
         * 转写本身就是正文，再补一句说明只会把它稀释掉。
         */
        if (!a.asrText) {
          out.push('（发来一条语音，但没转出文字——可以说没听清，请对方再说一遍）');
        }
        break;
      case 'image': {
        const got = list.find((x) => x.index === imgIdx);
        imgIdx += 1;
        out.push(imageNote(got, images));
        break;
      }
      case 'video':
        out.push('（发了一段视频）');
        break;
      case 'file':
        /**
         * 以文件形式发出来的图，**按图说**，不说「发了个文件」。
         *
         * 说成文件，模型就只拿到一个文件名，然后回「我只看得到文件名」——
         * 图其实早就下载好摆在它面前了。判定和 `collectImages` 用同一个函数，
         * 保证两边的 `imgIdx` 一一对应。
         */
        if (isImageAttachment(a)) {
          const got = list.find((x) => x.index === imgIdx);
          imgIdx += 1;
          out.push(imageNote(got, images));
        } else {
          out.push(`（发了个文件：${a.filename || '未命名'}${a.size ? `，${Math.round(a.size / 1024)}KB` : ''}）`);
        }
        break;
      default:
        if (a?.type) out.push(`（发了一个 ${a.type}）`);
    }
  }
  return out;
}

/** 消息元素 → 若干行说明（合并转发、卡片） */
export function describeElements(msg) {
  const out = [];
  for (const el of msg.elements ?? []) {
    if (el?.type === 'chatRecord') {
      // 官方把聊天记录展开成文本了，截一下防止一条消息把上下文吃光
      const body = String(el.content ?? '').trim();
      if (body) out.push(`（合并转发的内容：\n${body.slice(0, 1200)}）`);
    } else if (el?.type === 'ark') {
      const a = el.ark;
      if (a) out.push(`（卡片消息：${[a.title, a.desc].filter(Boolean).join(' — ') || a.name || '无标题'}）`);
    }
  }
  return out;
}

/** 卡片（顶层 ark，常见于单独一条卡片消息） */
export function describeArk(msg) {
  const a = msg.ark;
  if (!a) return [];
  const head = [a.title, a.desc].filter(Boolean).join(' — ');
  const url = a.url ? ` ${a.url}` : '';
  return [`（卡片消息：${head || a.name || '无标题'}${url}）`];
}

/**
 * 给模型看的完整用户内容。
 *
 * 顺序有讲究：先说用户自己打的字，再补上下文（引用、附件、卡片）。
 * 反过来的话模型容易把「（发来一张图）」当成用户说的话。
 *
 * @param {object} msg Roost 的 Message
 * @param {string} text 用户打的字（`/ai` 后面的部分）
 * @param {object} [opts]
 * @param {Array<{path:string,index:number}>|'off'|null} [opts.images]
 *   已下载的图片；`'off'` = 这一轮关了看图；`null` = 不知道（结构化通道用）
 * @returns {string}
 */
export function buildUserContent(msg, text, { images = null } = {}) {
  const parts = [];
  const said = String(text ?? '').trim();
  if (said) parts.push(said);

  if (msg.quoted) parts.push(`（引用了这句：${String(msg.quoted).slice(0, 500)}）`);

  parts.push(...describeAttachments(msg, images));
  parts.push(...describeElements(msg));
  parts.push(...describeArk(msg));

  // 用户只发了个语音、没打字，也要有内容可发
  return parts.filter(Boolean).join('\n') || '（发来一条空消息）';
}

/**
 * 给宿主协议的 payload（见 docs/AI宿主插件方案.md 第五节）。
 *
 * 跟 `buildUserContent` 的区别：这个是**结构化**的，宿主可以自己决定怎么用；
 * 那个是压成一段文本给模型。webhook / dsh 适配器用这个。
 */
export function hostPayload(msg, { id, token, replyUrl, expiresAt, history = [], sender = null, system = '', images = [], channel = null, said = null, batch = null, eventIds = [], trace = '' }) {
  /**
   * 这一轮真正该给宿主的正文。
   *
   * **不能用 `msg.content`**：合并窗口会把连着几句攒成一批，`msg` 只是
   * 最后那条（回复要挂它的 msg_id 才稳），真正的正文在 `batch.text` 里。
   * 以前这里读 `msg.content`，结果「在吗」→「问你个事」→「报错怎么办」
   * 攒成一批时，宿主只看到最后那句——前两句等于没说过。
   */
  const body = said ?? msg.content;
  return {
    id,
    /**
     * 链路 id：框架在进站时生成，宿主每轮日志带着它。
     * 老框架没有这个字段，所以给空串而不是报错。
     */
    trace: String(trace || msg.traceId || ''),
    /**
     * 这一轮对应事件账本里的哪几条（场景片段，阶段 4）。
     *
     * 宿主写记忆时要记「这条记忆从哪几条消息来」，而事件账本在框架侧——
     * 它只能靠这里带过去的 id，事后调 `/r/context` 反查原文。
     *
     * 合并窗口攒过几句时是**多条**：一批消息合成一轮对话，
     * 记忆的出处也该是这一批，不是最后那一句。
     */
    eventIds: (eventIds?.length ? eventIds : [msg.eventId]).filter(Boolean),
    chat: {
      kind: msg.kind === 'c2c' ? 'c2c' : 'group',
      chatId: msg.chatId,
      /**
       * 群名和昵称不能互相兜底。
       *
       * 以前写 `msg.groupName || msg.userName`：群名拿不到时会退成**发消息人的昵称**，
       * 群会话标题就变成「我的昵称」，和私聊一模一样；私聊又因为 C2C 事件没有
       * `author.username` 退成 openid。现在各取各的，拿不到就留空——
       * 由 dsh-roost 那边用「群 xxxxxx / 私聊 xxxxxx」兜底。
       */
      name: msg.kind === 'c2c' ? (msg.userName || '') : (msg.groupName || ''),
      groupId: msg.groupId || '',
      /**
       * 身份对照：QQ号 / 群号。
       *
       * 面板绑过才有值，没绑就是空串——**不是错误**，只是「还没认出来」。
       * 宿主拿到之后应该「有号码就用号码认人，没有才退回 openid」：
       * openid 是每个 AppID 一套的，换机器人就全变，号码不会。
       */
      uin: msg.uin || '',
      groupUin: msg.groupUin || '',
      /**
       * 读旧记忆的备用键：号码本身 + 这个号码名下**所有** openid
       * （含别的机器人的）。宿主查记忆时应该 `chat_id IN (...)` 一起查，
       * 否则换过机器人之后就只剩新记忆，旧的等于丢了。
       *
       * 人和群分开两组，**别合成一个数组**——混用会让群会话读到私聊记忆。
       * 所以这里按 kind 选，**不能**用「群别名空了就退成人的」：
       * 群没绑、发消息的人绑了，那样退会把这个群的记忆读成那个人的。
       */
      aliases: msg.kind === 'c2c' ? (msg.userAliases ?? []) : (msg.groupAliases ?? []),
    },
    sender: {
      id: msg.userId || '',
      name: msg.userName || '',
      /** QQ号，没绑是空串。有它时宿主该拿它当主键认人 */
      uin: msg.uin || '',
      /**
       * 权限档位。**算不准就不带这几个字段**——宿主拿不到就会按
       * 「身份不明」处理（只给聊天能力），比错报成「普通成员」安全。
       */
      ...(sender?.bucket ? { bucket: sender.bucket, level: sender.level, role: sender.role } : {}),
    },
    /**
     * 插件拼好的系统提示词。
     *
     * **宿主必须用它**：动作标记（<<skip>> / <<remember>> / <<image>> / <<button>>）
     * 的契约写在这里，宿主自己另写一份人格就等于让这些标记失效。
     * 之前就是这个 bug——DSH 模式下模型完全不知道有标记这回事。
     */
    system: String(system || ''),
    /**
     * 这个通道现在能发什么。
     *
     * 目前只有一个字段：`markdown`。宿主需要它，是因为**有些能力只在
     * markdown 消息类型里生效**——最典型的是 `<qqbot-at-user>`（@ 人）：
     * 官方文档写明群聊 @用户 只支持 markdown 消息，发成纯文本会把标签
     * 原样露在群里。宿主不知道这个开关就只能瞎猜，所以由插件告诉它。
     *
     * 老宿主读不到这个字段也没关系（不认识就忽略）。
     */
    ...(channel ? { channel } : {}),
    text: String(body || ''),
    /**
     * 整形好的那段话。
     *
     * 有它，宿主就不用自己把 ASR / 引用 / 合并转发拼进文本——
     * 宿主应该尽量笨，整形是插件的事。没有它的老宿主可以退回 `text`
     * 加上结构化字段自己拼。
     */
    rendered: buildUserContent(msg, body),
    /**
     * 这一轮是不是**多个人**的话攒成的一批。
     *
     * 是的话正文里每条都自带 `昵称(openid)：`，宿主不该再在外面套一层
     * 发送者标签——套了就变成「整段都是最后那个人说的」。
     */
    ...(batch?.multi ? { batch: { count: batch.count, multi: true } } : {}),
    quoted: msg.quoted || '',
    /** 下载好的图片块（base64）。宿主直接拿去当 image 内容块用 */
    images: Array.isArray(images) ? images : [],
    attachments: (msg.attachments ?? []).map((a) => ({
      type: a?.type,
      url: a?.url,
      asrText: a?.asrText,
      wavUrl: a?.wavUrl,
      filename: a?.filename,
      size: a?.size,
    })),
    elements: (msg.elements ?? []).map((el) => ({
      type: el?.type,
      content: el?.content,
      ark: el?.ark ? { title: el.ark.title, desc: el.ark.desc, url: el.ark.url } : null,
    })),
    history,
    reply: { url: replyUrl, token, expiresAt },
  };
}

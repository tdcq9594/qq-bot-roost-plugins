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

/** 附件 → 一行说明。没有就返回空数组 */
export function describeAttachments(msg) {
  const out = [];
  for (const a of msg.attachments ?? []) {
    switch (a?.type) {
      case 'voice':
        // 官方 ASR 是白给的，直接用；识别失败也要说清楚，别让模型以为是静音
        // 转写内容已经由 textOf 放进正文了，这里只说明「这是语音」，不重复文字
        out.push(a.asrText ? '（发了一条语音）' : '（发了一条语音，但没能转成文字）');
        break;
      case 'image':
        out.push(a.url ? `（发了一张图：${a.url}）` : '（发了一张图）');
        break;
      case 'video':
        out.push('（发了一段视频）');
        break;
      case 'file':
        out.push(`（发了个文件：${a.filename || '未命名'}${a.size ? `，${Math.round(a.size / 1024)}KB` : ''}）`);
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
 * 反过来的话模型容易把「（发了一张图）」当成用户说的话。
 *
 * @param {object} msg Roost 的 Message
 * @param {string} text 用户打的字（`/ai` 后面的部分）
 * @returns {string}
 */
export function buildUserContent(msg, text) {
  const parts = [];
  const said = String(text ?? '').trim();
  if (said) parts.push(said);

  if (msg.quoted) parts.push(`（引用了这句：${String(msg.quoted).slice(0, 500)}）`);

  parts.push(...describeAttachments(msg));
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
export function hostPayload(msg, { id, token, replyUrl, expiresAt, history = [], sender = null, system = '', images = [] }) {
  return {
    id,
    chat: {
      kind: msg.kind === 'c2c' ? 'c2c' : 'group',
      chatId: msg.chatId,
      name: msg.groupName || msg.userName || '',
      groupId: msg.groupId || '',
    },
    sender: {
      id: msg.userId || '',
      name: msg.userName || '',
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
    text: msg.content || '',
    /**
     * 整形好的那段话。
     *
     * 有它，宿主就不用自己把 ASR / 引用 / 合并转发拼进文本——
     * 宿主应该尽量笨，整形是插件的事。没有它的老宿主可以退回 `text`
     * 加上结构化字段自己拼。
     */
    rendered: buildUserContent(msg, msg.content),
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

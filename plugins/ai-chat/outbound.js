/**
 * 出站整形：把宿主的回复变成 QQ 里能发出去的一条或几条消息。
 *
 * 三件事：
 *   1. **切段**——QQ 单条有长度上限，长回答硬发会被平台截断（或者直接失败）
 *   2. **不切坏 Markdown**——代码块、列表被拦腰截断，渲染出来是乱的
 *   3. **被动回复次数有上限**——同一条消息最多回 5 次（`msg_seq` 1–5），
 *      切太多段会撞墙，所以段数也要封顶
 */

/** 单条上限。官方没给明确数字，留足余量：1800 个字符 */
export const MAX_CHUNK = 1800;

/** 最多发几段。同一条消息官方只让回 5 次，留一段给「出错了」这类提示 */
export const MAX_CHUNKS = 4;

/**
 * 按行切，尽量在段落/列表边界断开，且不把 ``` 代码块切断。
 *
 * @param {string} text
 * @param {number} [max]
 * @returns {string[]}
 */
export function splitText(text, max = MAX_CHUNK) {
  const s = String(text ?? '');
  if (!s) return [];
  if (s.length <= max) return [s];

  const lines = s.split('\n');
  const chunks = [];
  let cur = '';
  let inFence = false;

  const push = () => {
    if (cur.trim()) chunks.push(cur.replace(/\s+$/, ''));
    cur = '';
  };

  for (const line of lines) {
    const isFence = /^\s*```/.test(line);

    // 单行就超长：硬切（代码块里的长行只能这样）
    if (line.length > max) {
      if (cur) push();
      for (let i = 0; i < line.length; i += max) {
        const piece = line.slice(i, i + max);
        if (piece) chunks.push(piece);
      }
      continue;
    }

    if (cur.length + line.length + 1 > max) {
      /**
       * 断在这里。如果正处在代码块里，得先把围栏补上，
       * 否则下一段开头是代码、却没有起始的 ```，渲染全乱。
       */
      if (inFence) {
        cur += '\n```';
        push();
        cur = '```\n';
      } else {
        push();
      }
    }

    cur += (cur ? '\n' : '') + line;
    if (isFence) inFence = !inFence;
  }
  push();

  return chunks;
}

/**
 * 切段 + 封顶。超过段数上限就丢掉后面的，并留一句提示。
 *
 * @param {string} text
 * @param {number} [maxChunks]
 * @returns {string[]}
 */
export function planChunks(text, maxChunks = MAX_CHUNKS) {
  const all = splitText(text);

  /**
   * 别把文本链标签切断。
   *
   * `<qqbot-cmd-input text="…" />` 这种标签一旦被劈成两半，
   * 用户看到的就是一段乱码，而且点不了。所以：
   * 某段末尾有没闭合的 `<`，就把这段尾巴挪到下一段开头。
   */
  for (let i = 0; i < all.length - 1; i++) {
    const t = all[i];
    const lt = t.lastIndexOf('<');
    if (lt > t.lastIndexOf('>')) {
      all[i] = t.slice(0, lt);
      all[i + 1] = t.slice(lt) + all[i + 1];
    }
  }

  if (all.length <= maxChunks) return all;
  const kept = all.slice(0, maxChunks);
  const dropped = all.slice(maxChunks).join('');
  kept[kept.length - 1] += `\n\n（太长了，后面还有约 ${dropped.length} 字没发出来）`;
  return kept;
}

/**
 * 一次最多发几个富媒体。发太多会被平台限流，也吵。
 */
export const MAX_MEDIA = 3;

/** 图片/语音的扩展名白名单——不让模型把任意文件当图发出去 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const VOICE_EXT = /\.(silk|amr|mp3|wav|ogg|m4a)$/i;

/** 是网址还是本地路径 */
export function isRemote(src) {
  return /^https?:\/\//i.test(String(src ?? ''));
}

/**
 * 发富媒体（图片 / 语音）。
 *
 * 表情包、生图都走这条：DSH 那边生成或找到文件，模型输出
 * `<<image: 路径>>`，这里调 `msg.replyImage` 发出去。
 *
 * 为什么要白名单扩展名：模型有文件工具，理论上能发任何文件。
 * 加一道扩展名校验，至少不会把 `.env` 当图片传上去。
 *
 * @param {object} msg
 * @param {Array<{type:string, value:string}>} items
 * @param {object} [opts]
 * @returns {Promise<number>} 成功发出几个
 */
export async function sendMedia(msg, items, { log = () => {}, max = MAX_MEDIA } = {}) {
  let sent = 0;
  for (const it of (items ?? []).slice(0, max)) {
    const src = String(it?.value ?? '').trim();
    if (!src) continue;

    const ext = src.split(/[?#]/)[0];
    const ok = it.type === 'voice' ? VOICE_EXT.test(ext) : IMAGE_EXT.test(ext);
    if (!ok) {
      log(`${it.type} 扩展名不在白名单里，跳过：${src}`);
      continue;
    }

    const opts = { local: !isRemote(src) };
    try {
      const r = it.type === 'voice' ? await msg.replyVoice?.(src, opts) : await msg.replyImage?.(src, opts);
      if (r) sent++;
      else log(`${it.type} 没发出去：${src}`);
    } catch (e) {
      log(`${it.type} 发送失败：${e?.message ?? e}`);
    }
  }
  return sent;
}

/**
 * 发回复。
 *
 * 第一段走被动回复（带 msg_id，不消耗主动额度），后续段同样走 `msg.reply`——
 * 框架会自动递增 `msg_seq`，只要不超过 5 次就行（`MAX_CHUNKS` 就是为此留的余量）。
 *
 * `markdown` 开着时第一段用 markdown 消息类型发；它内部失败会返回 null，
 * 这时降级成纯文本——不降级的话用户什么都收不到，以为机器人挂了。
 *
 * @param {object} msg
 * @param {string} text
 * @param {object} p
 * @param {boolean} [p.markdown]
 * @param {(s:string)=>void} [p.log]
 * @returns {Promise<number>} 实际发出去几段
 */
/**
 * 拼按钮组（QQ 官方的 keyboard 结构）。
 *
 * 这是**官方接口独有的能力**——hook 客户端那套（OneBot）发不出真按钮。
 *
 * 用的是 `action.type: 2`（指令按钮）：点了等于用户自己发了 `data` 那句话，
 * 所以它天然会走回我们正常的消息处理流程，不用额外处理点击事件。
 *
 * 布局：一行最多 2 个，总共最多 4 个（再多就是一张键盘了，群里很吵）。
 *
 * @param {Array<{label:string, data:string}>} buttons
 */
export function buildKeyboard(buttons, { max = 4, perRow = 2 } = {}) {
  const list = (buttons ?? []).filter((b) => b && b.label).slice(0, max);
  if (!list.length) return null;

  const rows = [];
  for (let i = 0; i < list.length; i += perRow) {
    rows.push({
      buttons: list.slice(i, i + perRow).map((b, j) => ({
        id: String(i + j + 1),
        render_data: { label: b.label, visited_label: b.label, style: 1 },
        action: {
          type: 2, // 2 = 指令：点击后把 data 当一条消息发出来
          permission: { type: 0 }, // 0 = 所有人可点
          data: b.data,
          enter: true,
        },
      })),
    });
  }
  return { content: { rows } };
}

/**
 * 发回复。
 *
 * @param {object} msg
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.markdown] 用 markdown 消息类型（标题/列表/加粗真渲染）
 * @param {object} [opts.keyboard] 按钮组，见 buildKeyboard
 * @param {(m:string)=>void} [opts.log]
 */
export async function sendReply(msg, text, { markdown = false, keyboard = null, log = () => {}, onSent = null, stream = false, immediate = false, requestId = '' } = {}) {
  /**
   * 发出去了就把 message id 报出去（`onSent`）。
   *
   * 为什么要 id：`<<retract>>` 要撤回「自己刚发的那条」，
   * 而框架的 `send()` 本来就返回完整响应体（含 id），
   * 只是这里以前把它丢成了 `1`。不报 id 就撤不回来。
   */
  const report = (r) => {
    if (!onSent) return;
    try {
      onSent(String(r?.id ?? r?.message_id ?? ''));
    } catch {
      /* 记录失败不影响发送 */
    }
  };

  /**
   * `immediate` 走 `replyNow`，绕开攒批。
   *
   * 为什么需要：框架的 `msg.reply` 是**攒到本次处理结束**再由 `flushReplies`
   * 合并的（见 `src/message.js` 的 `replyBuf`）。多个插件各回一句时这是对的，
   * 但「模型决定分几条说」要的是**几条独立消息**——攒批会把它们吞成一条。
   *
   * `replyNow` 是被动回复（带 msgId），不占主动消息配额；
   * 上限是官方给的「同一条消息最多回 5 次」，所以段数由调用方先卡住。
   */
  const emit = immediate && typeof msg.replyNow === 'function' ? msg.replyNow : msg.reply;
  /**
   * 幂等键（阶段 5）。框架的 `msg.reply` 会把它从 body 里摘出来单独传给
   * `outbound.send`——它不是官方字段，混进请求体会被一路带到接口上。
   */
  const emitOpts = requestId ? { requestId } : undefined;

  /**
   * 私聊流式：边发边更新（`replace` 模式，服务端算差量，只占一条消息）。
   *
   * 为什么只做私聊：官方**没有群聊的流式接口**，`replyStream()` 在群里
   * 会自动降级成普通 markdown——那还不如走下面的正常路径。
   *
   * 为什么先切好片再推：DSH 给的是一次性完整文本，不是增量，
   * 所以这里是"分段推送"而不是真流式。但因为是 replace 模式，
   * 用户看到的是一条消息在长出来，不是刷屏。
   */
  if (stream && !keyboard && msg.kind === 'c2c' && typeof msg.replyStream === 'function') {
    const chunks = planChunks(text);
    if (chunks.length > 1) {
      try {
        const s = msg.replyStream();
        let acc = '';
        for (let i = 0; i < chunks.length; i++) {
          acc += (i ? '\n\n' : '') + chunks[i];
          if (i < chunks.length - 1) {
            await s.push(acc);
            // 停一下再推下一片，否则"长出来"的过程看不见
            await new Promise((r) => setTimeout(r, 140));
          } else {
            const r = await s.end(acc);
            report(r);
          }
        }
        return 1;
      } catch (e) {
        log(`流式失败，退回普通发送：${e?.message ?? e}`);
      }
    }
  }

  /**
   * 带按钮时必须一条发完——按钮只属于这一条消息，
   * 切段的话按钮会挂到第一段上，用户看着莫名其妙。
   */
  if (keyboard) {
    try {
      const r = await msg.replyMarkdown?.({ content: String(text) }, keyboard, emitOpts);
      if (r) {
        report(r);
        return 1;
      }
      log('带按钮的 markdown 没发出去，降级纯文本（按钮会丢）');
    } catch (e) {
      log(`带按钮的 markdown 发送失败：${e?.message ?? e}`);
    }
    await emit(text, emitOpts);
    return 1;
  }

  const chunks = planChunks(text);
  if (!chunks.length) return 0;

  /**
   * 第 i 块的幂等键。
   *
   * **一块一个 id，不能共用。** 账本的语义是「同一个 requestId 调多少次
   * 都只发第一次」（`delivery.claim` 第二次返回 `reuse`，`outbound.send`
   * 拿到 `reuse` 就直接回上次结果、**不打接口**）。所以整条共用一个 id
   * 的后果是：长回复被 `planChunks` 切成 3 块，第 2、3 块静默不发，
   * 用户只看到第一块——而调用方以为全发出去了。
   *
   * 单块时用原 id（绝大多数情况，行为完全不变）；
   * 多块时第 i 块用 `${id}#${i+1}`。派生是**确定的**，所以整条重发时
   * 每块各自命中 `reuse`，一块都不会重复发；只失败了一块时也只补那一块。
   *
   * 要查整条的终态，拿 base id 调 `/r/delivery?requestId=`——账本那边
   * 会按 `base` 和 `base#*` 聚合成一个状态（见框架 `delivery.family`）。
   */
  const idOf = (i) => (!requestId ? '' : chunks.length === 1 ? requestId : `${requestId}#${i + 1}`);
  const optOf = (i) => {
    const id = idOf(i);
    return id ? { requestId: id } : undefined;
  };

  let sent = 0;
  for (let i = 0; i < chunks.length; i++) {
    const body = chunks[i];
    const opt = optOf(i);
    try {
      if (i === 0 && markdown) {
        const r = await msg.replyMarkdown({ content: body }, undefined, opt);
        if (r) {
          report(r);
          sent++;
          continue;
        }
        log('markdown 发送失败，降级纯文本');
      }
      const r2 = await emit(body, opt);
      // 多段时只记最后一段的 id —— 撤回撤的是「最后发出去那条」
      report(r2);
      sent++;
    } catch (e) {
      log(`第 ${i + 1} 段发送失败：${e?.message ?? e}`);
      // 后面的段也别发了——大概率是同一个原因（被禁言、超限）
      break;
    }
  }
  return sent;
}

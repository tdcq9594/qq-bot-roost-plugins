/**
 * 记忆：短期上下文 + 长期事实 + 摘要压缩。
 *
 * 分三层，各存各的地方（这是 AstrBot 那套「分层记忆」的简化版）：
 *
 *   1. 短期：最近几轮对话，放内存（ctx.state）。闲置/重启就丢——
 *      和 ai-chat 一样，没必要为了它落盘、拖慢每轮。
 *   2. 摘要：旧对话攒多了，让模型压成一段话，存 ctx.storage，跨重启保留。
 *      对应 AstrBot 的 llm_compress 策略，只是我们做得更轻。
 *   3. 事实：用户明确让它记的事（/ai 记住），存 ctx.storage，跨重启保留。
 *
 * 为什么不自动提取事实：要么再调一次模型（贵、慢），要么用正则（不可靠）。
 * 宁可少记，也不要记一堆猜出来的东西污染上下文。
 */

const MAX_FACTS = 50;

export function createMemory({ conf, storage, state, providers, log = () => {} }) {
  // ctx.state 跨热重载保留（重启丢），正好放易失的上下文
  state.histories ??= new Map();

  const key = (prefix, chatId) => `${prefix}:${chatId}`;

  function history(chatId) {
    let h = state.histories.get(chatId);
    if (!h) {
      h = [];
      state.histories.set(chatId, h);
    }
    return h;
  }

  function addTurn(chatId, user, assistant) {
    const h = history(chatId);
    h.push({ role: 'user', content: String(user) });
    h.push({ role: 'assistant', content: String(assistant) });
    // 兜底：就算压缩没跟上，也别让数组无限长
    const keep = Math.max(2, (Number(conf().historyTurns) || 12) * 2);
    if (h.length > keep * 4) h.splice(0, h.length - keep);
  }

  function reset(chatId) {
    state.histories.delete(chatId);
  }

  async function facts(chatId) {
    const raw = await storage.get(key('facts', chatId), []);
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string' && x) : [];
  }

  async function addFact(chatId, text) {
    const f = String(text || '').trim().slice(0, 300);
    if (!f) return facts(chatId);
    await storage.update(
      key('facts', chatId),
      (cur) => {
        const arr = Array.isArray(cur) ? cur.filter((x) => typeof x === 'string' && x) : [];
        if (!arr.includes(f)) arr.push(f);
        if (arr.length > MAX_FACTS) arr.splice(0, arr.length - MAX_FACTS);
        return arr;
      },
      [],
    );
    return facts(chatId);
  }

  async function removeFacts(chatId, word) {
    const w = String(word || '').trim();
    if (!w) return { facts: await facts(chatId), removed: 0 };
    let removed = 0;
    await storage.update(
      key('facts', chatId),
      (cur) => {
        const arr = Array.isArray(cur) ? cur : [];
        return arr.filter((x) => {
          if (String(x).includes(w)) {
            removed += 1;
            return false;
          }
          return true;
        });
      },
      [],
    );
    return { facts: await facts(chatId), removed };
  }

  async function summary(chatId) {
    return String((await storage.get(key('summary', chatId), '')) || '');
  }

  async function clearSummary(chatId) {
    await storage.delete(key('summary', chatId));
  }

  /**
   * 超过阈值就把最旧的一段对话压成摘要。
   * 失败只记日志、不抛——压缩是锦上添花，不能因为它让回复挂掉。
   */
  async function maybeCompress(chatId, providerId) {
    const h = history(chatId);
    const keep = Math.max(2, (Number(conf().historyTurns) || 12) * 2);
    const trigger = Math.max(keep * 2, (Number(conf().compressAfterTurns) || 24) * 2);
    if (h.length <= trigger) return false;

    const oldMsgs = h.slice(0, h.length - keep);
    if (!oldMsgs.length) return false;

    try {
      const prev = await summary(chatId);
      const dialog = oldMsgs
        .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${String(m.content).slice(0, 500)}`)
        .join('\n');
      const prompt =
        '把下面这段对话和已有摘要合并成一段简洁的中文摘要，' +
        '保留人物、偏好、约定和没做完的事，不超过 300 字。只输出摘要本身。\n\n' +
        `【已有摘要】\n${prev || '（无）'}\n\n【新增对话】\n${dialog}`;
      const { text } = await providers.chat({
        messages: [{ role: 'user', content: prompt }],
        providerId,
      });
      await storage.set(key('summary', chatId), text.trim().slice(0, 800));
      h.splice(0, oldMsgs.length);
      log.info(`压缩了 ${String(chatId).slice(0, 8)} 的 ${oldMsgs.length} 条旧对话`);
      return true;
    } catch (e) {
      log.warn('压缩失败，跳过这一轮', e.message);
      return false;
    }
  }

  /**
   * 拼 system prompt：人格 + 摘要 + 事实 + 输出风格。
   * aiMode 时再加一句「不该接话就只输出 <skip>」。
   */
  function buildSystem({ persona, factList, summaryText, aiMode }) {
    const parts = [];
    if (persona?.prompt) parts.push(persona.prompt);
    if (summaryText) parts.push(`【之前聊过的事（摘要）】\n${summaryText}`);
    if (factList?.length) {
      parts.push(`【你记得的事】\n${factList.map((f) => `· ${f}`).join('\n')}`);
    }
    parts.push('用中文回答，简短自然，像群友聊天；不要长篇大论，也不要解释自己是 AI。');
    if (aiMode) {
      parts.push(
        '先判断这条消息是否需要你接话：需要就正常回答；' +
          '不需要（群友之间闲聊、跟你无关）就只输出 <skip>，不要输出任何别的内容。',
      );
    }
    return parts.join('\n\n');
  }

  return {
    history,
    addTurn,
    reset,
    facts,
    addFact,
    removeFacts,
    summary,
    clearSummary,
    maybeCompress,
    buildSystem,
  };
}

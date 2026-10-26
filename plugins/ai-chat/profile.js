/**
 * 按会话的人设与记忆。
 *
 * 为什么按会话：一个机器人在好几个群里，每个群的氛围不一样。
 * 技术群里它该是个严谨的助手，亲友群里它该是个会开玩笑的。
 * 全局一个 system prompt 做不到这件事。
 *
 * 存在 `ctx.storage` 里（`data/bots/<机器人>/plugins/ai-chat/store.json`），
 * 键是 `profile:<chatId>`，跟着会话走，卸载插件才清。
 *
 * 记忆为什么是「显式」的：
 *   自动提取事实要么再调一次模型（贵、慢），要么用正则（不可靠）。
 *   所以这里只记用户明确让它记的（`/记住 我住在杭州`），
 *   宁可少记，也不要记一堆猜出来的东西污染上下文。
 */

export function createProfile({ storage, log = () => {} }) {
  const key = (chatId) => `profile:${chatId}`;

  /** 读出来，字段补全，省得调用方到处判空 */
  async function get(chatId) {
    const raw = (await storage.get(key(chatId), null)) ?? {};
    return {
      persona: String(raw.persona ?? ''),
      facts: Array.isArray(raw.facts) ? raw.facts.filter((x) => typeof x === 'string' && x) : [],
    };
  }

  async function patch(chatId, fn) {
    await storage.update(
      key(chatId),
      (cur) => {
        const base = {
          persona: String(cur?.persona ?? ''),
          facts: Array.isArray(cur?.facts) ? cur.facts.filter((x) => typeof x === 'string' && x) : [],
        };
        return fn(base) ?? base;
      },
      { persona: '', facts: [] },
    );
    return get(chatId);
  }

  return {
    get,

    /** 设这个人设；传空字符串就是清掉，回到全局人设 */
    setPersona(chatId, text) {
      const t = String(text ?? '').trim();
      return patch(chatId, (p) => {
        p.persona = t.slice(0, 500);
        return p;
      });
    },

    /** 记一条。重复的不重复记，最多留 20 条（再多就该清一清了） */
    addFact(chatId, fact) {
      const f = String(fact ?? '').trim().slice(0, 200);
      if (!f) return get(chatId);
      return patch(chatId, (p) => {
        if (!p.facts.includes(f)) p.facts.push(f);
        if (p.facts.length > 20) p.facts = p.facts.slice(-20);
        return p;
      });
    },

    /** 按关键词删，删不掉就返回原样（调用方据此提示「没找到」） */
    async removeFact(chatId, word) {
      const w = String(word ?? '').trim();
      if (!w) return { profile: await get(chatId), removed: 0 };
      let removed = 0;
      const profile = await patch(chatId, (p) => {
        const kept = p.facts.filter((f) => {
          if (f.includes(w)) {
            removed++;
            return false;
          }
          return true;
        });
        p.facts = kept;
        return p;
      });
      return { profile, removed };
    },

    clear(chatId) {
      return patch(chatId, (p) => {
        p.persona = '';
        p.facts = [];
        return p;
      });
    },

    /**
     * 拼进 system prompt 的片段。
     * 没有额外内容时返回空串，调用方直接 `filter(Boolean)` 就行。
     */
    async systemExtra(chatId) {
      const p = await get(chatId);
      const lines = [];
      if (p.persona) lines.push(`【这个会话的额外人设】\n${p.persona}`);
      if (p.facts.length) {
        lines.push(`【你记得的事】\n${p.facts.map((f) => `· ${f}`).join('\n')}`);
      }
      return lines.join('\n\n');
    },
  };
}

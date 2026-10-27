/**
 * 模型服务商：OpenAI 兼容 `/chat/completions` 的薄封装。
 *
 * 为什么不引 SDK：几乎所有服务商（DeepSeek / Kimi / 通义 / 智谱 / 硅基流动 /
 * 火山 / Ollama / vLLM / one-api / LiteLLM）都是 OpenAI 兼容形状，一个 fetch
 * 就够——零依赖、换服务商只改 baseUrl，不用在插件里养半个客户端。
 *
 * 和 ai-chat 的区别：ai-chat 把「真正调模型」交给 DSH；这里是**直连**，
 * 插件自己拿 Key、自己拼请求，所以多服务商切换也在这里做。
 */

function trimSlash(s) {
  return String(s || '').trim().replace(/\/+$/, '');
}

/**
 * 把配置里的 providers 归一化成数组。
 * 兼容三种写法：JSON 数组、JSON 字符串、单个对象（只有一个服务商时省事）。
 */
export function normalizeProviders(raw) {
  let list = raw;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) {
    if (list && typeof list === 'object' && (list.baseUrl || list.model)) list = [list];
    else list = [];
  }
  return list
    .filter((p) => p && typeof p === 'object')
    .map((p, i) => ({
      id: String(p.id || p.name || `p${i + 1}`).trim(),
      name: String(p.name || p.id || `服务商${i + 1}`),
      baseUrl: trimSlash(p.baseUrl),
      apiKey: String(p.apiKey || '').trim(),
      model: String(p.model || '').trim(),
      maxTokens: Number(p.maxTokens) > 0 ? Number(p.maxTokens) : undefined,
      temperature:
        p.temperature === 0 || p.temperature ? Number(p.temperature) : undefined,
      vision: p.vision === true,
    }));
}

/** 把 HTTP 错误翻成人话，用户看日志能直接知道该改什么 */
function explainHttp(status, body) {
  const snippet = String(body || '').slice(0, 200).replace(/\s+/g, ' ');
  if (status === 401 || status === 403) {
    return `鉴权失败（HTTP ${status}）：检查 API Key 是否正确、有没有该模型权限`;
  }
  if (status === 404) {
    return `接口不存在（HTTP 404）：检查 baseUrl 是否含 /v1、模型名是否正确`;
  }
  if (status === 429) return `被限流了（HTTP 429）：稍后再试，或换一个服务商`;
  if (status >= 500) return `服务商出错了（HTTP ${status}）：稍后再试`;
  return `请求失败（HTTP ${status}）：${snippet || '无返回内容'}`;
}

/**
 * @param {object} deps
 * @param {() => object} deps.conf 每次调用都重新读配置（面板改了立刻生效）
 * @param {(...a:any[])=>void} [deps.log]
 */
export function createProviders({ conf, log = () => {} }) {
  function list() {
    return normalizeProviders(conf().providers);
  }

  /** 按 id 找服务商；找不到就用第一个，全空返回 null */
  function resolve(providerId) {
    const all = list();
    const want = String(providerId || conf().defaultProvider || '').trim();
    return all.find((p) => p.id === want) || all[0] || null;
  }

  /**
   * 用某个服务商调一轮（非流式）。
   * QQ 群聊不支持流式，用户只看最终消息，所以 `stream: false`。
   */
  async function chatOnce(p, messages, signal, tools) {
    if (!p.baseUrl) throw new Error(`服务商「${p.name}」缺少 baseUrl`);
    if (!p.model) throw new Error(`服务商「${p.name}」缺少 model`);
    if (!p.apiKey) throw new Error(`服务商「${p.name}」还没填 API Key`);

    /**
     * DeepSeek 的思考模式默认是开的、且开着时不支持 temperature。
     * 不显式关掉的话，群里问一句「在吗」它先想半天，思考 token 还更贵。
     */
    const isDeepSeek = /deepseek/i.test(p.baseUrl);
    const body = { model: p.model, messages, stream: false };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (p.maxTokens) body.max_tokens = p.maxTokens;
    if (p.temperature !== undefined) body.temperature = p.temperature;
    if (isDeepSeek) {
      body.thinking = { type: 'disabled' };
      delete body.temperature;
    }

    const started = Date.now();
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${p.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(explainHttp(res.status, text));
    }

    const data = await res.json().catch(() => null);
    const msg = data?.choices?.[0]?.message;
    const text = msg?.content;
    const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
    // 有工具调用时 content 通常是空的，不能当「空回复」处理
    if ((typeof text !== 'string' || !text.trim()) && !toolCalls.length) {
      const reason = data?.choices?.[0]?.finish_reason;
      throw new Error(
        reason === 'content_filter' ? '回复被服务商的内容审核拦了' : '模型返回了空内容',
      );
    }

    return {
      message: msg,
      text: typeof text === 'string' ? text.trim() : '',
      toolCalls,
      usage: data?.usage ?? null,
      model: data?.model || p.model,
      ms: Date.now() - started,
      provider: p,
    };
  }

  /**
   * 调一轮：主服务商失败时**自动换下一个**（对应 AstrBot 的多 provider 容错）。
   * 顺序 = 指定的/默认的优先，其余按配置顺序兜底。
   * `fallback: false` 时只试主服务商，失败直接抛。
   *
   * @param {object} p
   * @param {Array<{role:string, content:any}>} p.messages
   * @param {AbortSignal} [p.signal]
   * @param {string} [p.providerId]
   * @returns {Promise<{text:string, usage:object|null, model:string, ms:number, provider:object}>}
   */
  async function chat({ messages, tools, signal, providerId }) {
    const all = list();
    if (!all.length) {
      throw new Error('还没有配置任何模型服务商，去面板「插件 → ai-native → 配置」里填一个');
    }
    // 注意：必须在同一个 all 数组里按 id 找主服务商。
    // 不能调 resolve()——它内部会重新 list()，生成的是新对象，
    // 后面的 `p !== primary` 就永远成立，主服务商会被试两次。
    const want = String(providerId || conf().defaultProvider || '').trim();
    const primary = all.find((p) => p.id === want) || all[0];
    const useFallback = conf().fallback !== false;
    const order = useFallback ? [primary, ...all.filter((p) => p !== primary)] : [primary];

    let lastErr = null;
    for (const p of order) {
      if (!p) continue;
      try {
        return await chatOnce(p, messages, signal, tools);
      } catch (e) {
        lastErr = e;
        if (!useFallback) throw e;
        /**
         * 超时不算「这个服务商不行」，是**这一轮的预算用完了**。
         * 换下一个服务商也是拿同一个已过期的 signal 去请求，
         * 立刻失败、白等一轮，还会让用户多等几秒才看到错误。
         */
        if (e.name === 'TimeoutError' || e.name === 'AbortError' || /abort/i.test(e.message || '')) {
          throw e;
        }
        log(`服务商「${p.name}」失败，换下一个：${e.message}`);
      }
    }
    throw lastErr || new Error('没有可用的模型服务商');
  }

  /**
   * embedding 服务商配置，**没配就返回 null**（上层据此回落到关键词检索）。
   *
   * 为什么不复用 providers 里的条目：对话模型和向量模型通常不是同一个
   * （`deepseek-chat` 对 `bge-m3`），而且向量接口不产生对话成本，混在一起
   * 反而要用户复制一份 baseUrl / apiKey。这里只要求填 model，地址和 Key
   * 默认继承主服务商——同一家厂商的两类模型共用一套凭证是常态。
   *
   *   embedding: { model: 'text-embedding-3-small' }              // 最省事
   *   embedding: { model: 'bge-m3', baseUrl: 'http://x/v1', apiKey: 'k' }
   */
  function embeddingConf() {
    let e = conf().embedding;
    if (typeof e === 'string') {
      try {
        e = JSON.parse(e);
      } catch {
        e = null;
      }
    }
    if (!e || typeof e !== 'object') return null;
    const model = String(e.model || '').trim();
    if (!model) return null;
    const base = resolve(null);
    const baseUrl = trimSlash(e.baseUrl) || base?.baseUrl || '';
    const apiKey = String(e.apiKey || '').trim() || base?.apiKey || '';
    if (!baseUrl) return null;
    return {
      model,
      baseUrl,
      apiKey,
      // 有些服务商单次上限很小（如 10 条），默认 16 并允许调
      batch: Math.min(64, Math.max(1, Number(e.batch) || 16)),
      minScore: Number(e.minScore) > 0 ? Number(e.minScore) : 0.35,
    };
  }

  /**
   * 批量算向量。没配 embedding 返回 null，让调用方走关键词分支。
   *
   * 为什么不让调用方自己拼请求：/embeddings 和 /chat/completions 的错误码、
   * 分批、乱序返回这些坑是一样的，集中在一处修一次就够。
   */
  async function embed(texts, { signal } = {}) {
    const e = embeddingConf();
    if (!e) return null;
    const inputs = (texts || []).map((t) => String(t ?? '').slice(0, 6000));
    if (!inputs.length) return [];

    const out = [];
    for (let i = 0; i < inputs.length; i += e.batch) {
      const slice = inputs.slice(i, i + e.batch);
      const res = await fetch(`${e.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${e.apiKey}`,
        },
        body: JSON.stringify({ model: e.model, input: slice }),
        signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(explainHttp(res.status, body));
      }
      const data = await res.json().catch(() => null);
      const arr = Array.isArray(data?.data) ? data.data.slice() : [];
      if (arr.length !== slice.length) {
        throw new Error(`向量接口返回条数不对（要 ${slice.length} 条，给了 ${arr.length} 条）`);
      }
      // 有的服务商不保证顺序，按 index 排回来
      arr.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      for (const d of arr) {
        const v = d?.embedding;
        if (!Array.isArray(v) || !v.length) throw new Error('向量接口返回了空向量');
        out.push(v);
      }
    }
    return out;
  }

  return { list, resolve, chat, embed, embeddingConf };
}

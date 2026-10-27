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
   * 调一轮（非流式）。
   * QQ 群聊不支持流式，用户只看最终消息，所以 `stream: false`。
   *
   * @param {object} p
   * @param {Array<{role:string, content:any}>} p.messages
   * @param {AbortSignal} [p.signal]
   * @param {string} [p.providerId]
   * @returns {Promise<{text:string, usage:object|null, model:string, ms:number, provider:object}>}
   */
  async function chat({ messages, signal, providerId }) {
    const p = resolve(providerId);
    if (!p) {
      throw new Error('还没有配置任何模型服务商，去面板「插件 → ai-native → 配置」里填一个');
    }
    if (!p.baseUrl) throw new Error(`服务商「${p.name}」缺少 baseUrl`);
    if (!p.model) throw new Error(`服务商「${p.name}」缺少 model`);
    if (!p.apiKey) throw new Error(`服务商「${p.name}」还没填 API Key`);

    /**
     * DeepSeek 的思考模式默认是开的、且开着时不支持 temperature。
     * 不显式关掉的话，群里问一句「在吗」它先想半天，思考 token 还更贵。
     */
    const isDeepSeek = /deepseek/i.test(p.baseUrl);
    const body = { model: p.model, messages, stream: false };
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
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      const reason = data?.choices?.[0]?.finish_reason;
      throw new Error(
        reason === 'content_filter' ? '回复被服务商的内容审核拦了' : '模型返回了空内容',
      );
    }

    return {
      text: text.trim(),
      usage: data?.usage ?? null,
      model: data?.model || p.model,
      ms: Date.now() - started,
      provider: p,
    };
  }

  return { list, resolve, chat };
}

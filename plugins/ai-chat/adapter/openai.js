/**
 * openai 适配器：直连 OpenAI 兼容的 `/chat/completions`。
 *
 * 这是默认适配器，也是覆盖面最广的一个——DeepSeek / Kimi / 通义 / 智谱 /
 * 硅基流动 / 火山，以及本地的 Ollama / vLLM / LM Studio，还有 one-api /
 * LiteLLM 这类协议转换层，全都是这个形状。
 *
 * 所以「接大部分 AI 工作台」最省力的路径其实是它，而不是给每个工作台写适配器：
 * 只要对方能吐一个 OpenAI 兼容端点（或者中间加个转换层），这里就能用。
 */

/**
 * @param {object} deps
 * @param {() => object} deps.conf 每次调用都重新读配置（面板改了立刻生效）
 * @param {(status:number, body:string) => string} deps.explainHttp 把 HTTP 错误翻成人话
 */
export function createOpenAIAdapter({ conf, explainHttp }) {
  return {
    name: 'openai',

    /**
     * 调一轮。
     *
     * 用 OpenAI 兼容格式而不是某家的私有 SDK：零依赖，换服务商只改 baseUrl。
     * `stream: false` 是有意的——QQ 群聊不支持流式，用户只看最终消息。
     *
     * @param {object} p
     * @param {Array<{role:string,content:string}>} p.messages
     * @param {AbortSignal} [p.signal]
     * @param {string} [p.model] 临时指定模型（/模型 命令用）
     * @returns {Promise<{text:string, usage:object|null, model:string}>}
     */
    async chat({ messages, signal, model }) {
      const c = conf();

      /**
       * 请求体按服务商分别拼。
       *
       * `thinking` 是 DeepSeek 的参数，别家（Kimi / 通义 / Ollama）不认识，
       * 塞过去可能直接 400。所以只在地址是 DeepSeek 时才带。
       *
       * 为什么要显式传 `disabled`：**DeepSeek 的思考模式默认是开的、
       * 强度默认 high**。不显式关掉，群里问一句「在吗」它先想半天，
       * 而且思考过程算输出 token（比普通 token 贵），又慢又费钱。
       *
       * 思考模式还**不支持 temperature**（传了不报错但不生效），
       * 所以开着的时候干脆不传，免得用户以为调了发散程度有用。
       */
      const isDeepSeek = /deepseek/i.test(c.baseUrl);
      const body = {
        model: model || c.model,
        messages,
        max_tokens: c.maxTokens,
        stream: false,
      };
      if (isDeepSeek) {
        body.thinking = { type: c.thinking ? 'enabled' : 'disabled' };
        if (c.thinking) body.reasoning_effort = c.reasoningEffort;
      }
      if (!c.thinking) body.temperature = c.temperature;

      const res = await fetch(`${c.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${c.apiKey}`,
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
        // 有的服务商会把「内容被过滤」放在 finish_reason 里，一起说出来
        const reason = data?.choices?.[0]?.finish_reason;
        throw new Error(reason === 'content_filter' ? '回复被服务商的内容审核拦了' : '模型返回了空内容');
      }
      return {
        text: text.trim(),
        usage: data?.usage ?? null,
        model: data?.model || model || c.model,
      };
    },
  };
}

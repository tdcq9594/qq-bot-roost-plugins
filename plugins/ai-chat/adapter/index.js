/**
 * 适配器注册表。
 *
 * 插件本体只管「QQ 这边怎么收、怎么发、什么该理」，
 * 「这一轮交给谁去想」由适配器决定。换宿主 = 换一个适配器，插件本体不动。
 *
 * 每个适配器只要实现一个方法：
 *
 *   chat({ messages, signal, model, msg, chat }) → { text, usage?, model? }
 *
 * 以后加新宿主，就在这个目录里加一个文件、在下面注册一下，
 * **不用碰 index.js**，也就不会把已经在跑的旧分支改坏。
 */

import { createOpenAIAdapter } from './openai.js';
import { createHostAdapter } from './host.js';

/**
 * @param {object} deps
 * @param {() => object} deps.conf
 * @param {(status:number, body:string) => string} deps.explainHttp
 * @param {object} deps.bridge 回话通道（webhook/dsh 用）
 * @param {() => string} deps.publicUrl 面板对外地址
 * @param {(s:string)=>void} [deps.log]
 */
export function createAdapter({ conf, explainHttp, bridge, publicUrl, log }) {
  const c = conf();
  const wanted = String(c.adapter || 'openai');

  switch (wanted) {
    case 'openai':
      return createOpenAIAdapter({ conf, explainHttp });

    case 'webhook':
      return createHostAdapter({ name: 'webhook', url: c.hostUrl, bridge, publicUrl, log, trimHistory });

    case 'dsh':
      return createHostAdapter({ name: 'dsh', url: c.dshUrl, bridge, publicUrl, log, trimHistory });

    default:
      throw new Error(`未知的适配器：${wanted}`);
  }
}

/**
 * 给宿主的 history：去掉 system（宿主自己有人格），
 * 只留最近的对话，避免把整段上下文推过去。
 */
function trimHistory(messages, limit = 20) {
  const msgs = (messages ?? []).filter((m) => m?.role === 'user' || m?.role === 'assistant');
  return msgs.slice(-limit).map((m) => ({ role: m.role, content: String(m.content ?? '') }));
}

/** 面板上「适配器」这个下拉的选项，跟上面的 switch 保持一致 */
export const ADAPTER_OPTIONS = [
  { value: 'openai', label: 'OpenAI 兼容（默认，直连模型）' },
  { value: 'dsh', label: 'DeepSeek Harness（需装 dsh-roost）' },
  { value: 'webhook', label: 'Webhook（自建服务）' },
];

/**
 * 适配器：只留 DSH。
 *
 * 这个插件现在的定位很单一——**只做「QQ ↔ DSH」的桥**：
 * 收 QQ 消息、交给 DSH 那一轮、把结果发回 QQ。
 * 模型是谁、怎么调、有没有 Key，全归 DSH 管，插件一概不碰。
 *
 * 以前这里有三个适配器（openai 直连 / webhook / dsh）。
 * 直连那套意味着插件自己维护 baseUrl、apiKey、model、maxTokens、
 * temperature、thinking、reasoningEffort……等于在插件里养了半个客户端。
 * 那些能力 DSH 本来就有，重复一份只会两边配置打架、行为对不上。
 *
 * 所以 4.0.0 起只保留 dsh：想换模型就在 DSH 里换，插件不用改一行。
 */

import { createHostAdapter } from './host.js';

/**
 * @param {object} deps
 * @param {() => object} deps.conf
 * @param {object} deps.bridge 回话通道
 * @param {() => string} deps.publicUrl 面板对外地址
 * @param {(s:string)=>void} [deps.log]
 */
export function createAdapter({ conf, bridge, publicUrl, log }) {
  const c = conf();
  return createHostAdapter({
    name: 'dsh',
    url: c.dshUrl,
    bridge,
    publicUrl,
    log,
    trimHistory,
  });
}

/**
 * 给宿主的 history：去掉 system（宿主自己有人格），
 * 只留最近的对话，避免把整段上下文推过去。
 */
function trimHistory(messages, limit = 20) {
  const msgs = (messages ?? []).filter((m) => m?.role === 'user' || m?.role === 'assistant');
  return msgs.slice(-limit).map((m) => ({ role: m.role, content: String(m.content ?? '') }));
}

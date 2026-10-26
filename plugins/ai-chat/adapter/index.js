/**
 * 适配器注册表。
 *
 * 插件本体只管「QQ 这边怎么收、怎么发、什么该理」，
 * 「这一轮交给谁去想」由适配器决定。换宿主 = 换一个适配器，插件本体不动。
 *
 * 每个适配器只要实现一个方法：
 *
 *   chat({ messages, signal, model, chat }) → { text, usage?, model? }
 *
 * 以后加新宿主，就在这个目录里加一个文件、在下面注册一下，
 * **不用碰 index.js**，也就不会把已经在跑的旧分支改坏。
 */

import { createOpenAIAdapter } from './openai.js';

/**
 * @param {object} deps
 * @param {() => object} deps.conf
 * @param {(status:number, body:string) => string} deps.explainHttp
 */
export function createAdapter({ conf, explainHttp }) {
  const wanted = String(conf().adapter || 'openai');

  switch (wanted) {
    case 'openai':
      return createOpenAIAdapter({ conf, explainHttp });

    // 下面两个还没实现。**不要静默回落到 openai**——
    // 用户明确选了 dsh，结果悄悄直连模型，他会以为 DSH 的工具和记忆生效了。
    case 'dsh':
      throw new Error('dsh 适配器还没做（M4）。先把「适配器」改回 openai，或者等更新');

    case 'webhook':
      throw new Error('webhook 适配器还没做（M3）。先把「适配器」改回 openai，或者等更新');

    default:
      throw new Error(`未知的适配器：${wanted}`);
  }
}

/** 面板上「适配器」这个下拉的选项，跟上面的 switch 保持一致 */
export const ADAPTER_OPTIONS = [
  { value: 'openai', label: 'OpenAI 兼容（默认，直连模型）' },
  { value: 'dsh', label: 'DeepSeek Harness（需装 dsh-roost，未实现）' },
  { value: 'webhook', label: 'Webhook（自建服务，未实现）' },
];

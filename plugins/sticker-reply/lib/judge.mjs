/**
 * 判断与选图。
 *
 * 流程：筛候选 → 一次独立模型判断 → 程序校验 → 返回 text 或 image。
 * 任何一步出问题都退回文字方案（**不**为了让表情出现而勉强匹配）。
 *
 * 这一层只负责"给出方案"，真正的发图由宿主解析 `<<image-alone: 路径>>` 完成；
 * 不能保证平台投递成功——没有回执通道。
 */

import { PATHS, readJson, writeJson } from './shared.mjs';
import { apiReady, apiWhy, runModel } from './api.mjs';
import { listAnnotated, loadSettings } from './store.mjs';
import { checkBuiltinDependency } from './builtin.mjs';

/** 同时最多两路判断，避免递归调用或把宿主拖住 */
let inflight = 0;
const MAX_INFLIGHT = 2;

/** 最近选择（按会话），只写"已选择"，不代表已发送 */
function loadRecent() {
  const raw = readJson(PATHS.usage, null);
  return raw && typeof raw === 'object' ? raw : {};
}

export function recentOf(chatId) {
  if (!chatId) return [];
  const all = loadRecent();
  return Array.isArray(all[chatId]) ? all[chatId].slice(0, 10) : [];
}

function noteRecent(chatId, id) {
  if (!chatId) return;
  const all = loadRecent();
  const list = Array.isArray(all[chatId]) ? all[chatId] : [];
  all[chatId] = [id, ...list.filter((x) => x !== id)].slice(0, 10);
  writeJson(PATHS.usage, all);
}

/** 只有"含义"填了且启用的才参与自动选择 */
export function eligibleImages(images) {
  return images.filter((img) => img.enabled !== false && String(img.meaning || '').trim());
}

/**
 * 筛候选：命中标签/含义/适用场景的优先，命中为 0 时按顺序补足。
 * 上限默认 24，避免把整个库塞进提示词。
 */
export function pickCandidates(images, message, { max = 24, avoid = [] } = {}) {
  const text = String(message || '');
  const avoidSet = new Set(avoid);
  const scored = images.map((img, i) => {
    let score = 0;
    for (const tag of img.tags || []) if (tag && text.includes(tag)) score += 3;
    for (const word of String(img.meaning || '').split(/[，,、\s]+/)) {
      if (word.length >= 2 && text.includes(word)) score += 1;
    }
    // 最近刚用过：不清零，只是排后面（只有一张合适时允许重复）
    if (avoidSet.has(img.id)) score -= 2;
    return { img, score, i };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  return scored.slice(0, Math.max(1, max)).map((x) => x.img);
}

const PROMPT = (message, history, candidates) => `你在帮一个 QQ 机器人判断：这一轮**能不能只发一张表情图**代替文字回复。

对方的最后一句：「${message}」
${history.length ? `前面几条对话：\n${history.map((h, i) => `  ${i + 1}. ${h}`).join('\n')}\n` : ''}
可选表情（id | 含义 | 适用 | 避免）：
${candidates.map((c) => `- ${c.id.slice(0, 12)} | ${c.name}：${c.meaning} | ${c.scenes || '-'} | ${c.avoid || '-'}`).join('\n')}

判断标准：
- 只有「情绪、问候、简短互动」这类**用一张图就能完整回应**的才选图
- 问知识、要数据、要命令、要结果、要方案 —— 一律用文字
- 消息短不等于可以用图。"现在几点"很短，但它要具体信息
- 没有合适表情就用文字，不要勉强匹配

只输出 JSON，不要解释、不要代码块：
{"mode":"image","id":"候选里某个 id 的前 12 位","confidence":0.0~1.0,"reason":"一句话"}
或
{"mode":"text","reason":"一句话"}`;

function parseJson(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

/**
 * 主入口。
 *
 * @param {{message:string, history?:string[], chatId?:string}} input
 * @returns {Promise<{mode:'text'|'image', reason:string, image?:object, marker?:string}>}
 */
/**
 * 最近一次判断的落盘记录（运行诊断用）。
 *
 * 计划要求页面能显示"最近一次判断结果"。没有这条记录时，
 * 「模型没调用工具」和「调用了但选了文字」在外部看起来一模一样 —— 真机排查时吃过这个亏。
 */
export function lastDecision() {
  const raw = readJson(PATHS.last, null);
  return raw && typeof raw === 'object' ? raw : null;
}

function noteLast(rec) {
  try { writeJson(PATHS.last, rec); } catch { /* 写不进去不影响判断 */ }
}

export async function decide(input = {}) {
  const started = Date.now();
  const out = await decideInner(input);
  noteLast({
    at: Date.now(),
    ms: Date.now() - started,
    chatId: String(input?.chatId || ''),
    message: String(input?.message || '').slice(0, 120),
    mode: out.mode,
    reason: String(out.reason || '').slice(0, 200),
    image: out.image ? { id: out.image.id, name: out.image.name } : null,
  });
  return out;
}

async function decideInner({ message = '', history = [], chatId = '', requireReady = true } = {}) {
  const settings = loadSettings();
  const textOf = (reason) => ({ mode: 'text', reason });

  if (!settings.enabled) return textOf('扩展已关闭');
  if (!apiReady()) return textOf(`模型判断不可用：${apiWhy()}`);
  /**
   * **先占坑，再 await**。
   *
   * 这里踩过一次：限额检查放在最前面，但计数是在依赖检查（一个 await）之后才加，
   * 于是三个并发请求都能通过检查、各自拿到额度，实测出现 3 路同时调模型。
   * 现在检查与自增之间不允许有 await —— 占坑失败就直接退回文字。
   */
  if (inflight >= MAX_INFLIGHT) return textOf('并发判断已满，本轮用文字');
  inflight += 1;
  try {
    /**
     * 硬依赖先过一遍：内置表情没开、目录没接、图库没导出时**不调用模型**。
     *
     * 面板「匹配测试」传 `requireReady:false`，只验判断能力，不受接入状态影响。
     */
    if (requireReady) {
      const dep = await checkBuiltinDependency();
      if (!dep.available) return textOf(`接入状态未知，本轮用文字：${dep.error}`);
      if (!dep.ready) {
        const why = !dep.enabled ? '内置表情未启用（表达 —— 表情包 —— 启用）'
          : !dep.configured ? '图库目录未加入表情包目录'
            : !dep.extensionEnabled ? '扩展未启用'
              : '图库尚未导出';
        return textOf(`接入未就绪，本轮用文字：${why}`);
      }
    }

    const { images } = listAnnotated(settings);
    const pool = eligibleImages(images);
    if (!pool.length) return textOf('表情库为空或没有可用标注');

    const historyList = (Array.isArray(history) ? history : [])
      .map((h) => String(h || '').trim())
      .filter(Boolean)
      .slice(-6);

    const candidates = pickCandidates(pool, message, {
      max: settings.maxCandidates,
      avoid: recentOf(chatId),
    });
    if (!candidates.length) return textOf('没有合适的候选表情');

    const raw = await runModel(PROMPT(String(message || ''), historyList, candidates), {
      timeoutMs: settings.timeoutMs,
    });
    const parsed = parseJson(raw);
    if (!parsed) return textOf('模型返回的不是合法 JSON');
    if (parsed.mode !== 'image') return textOf(String(parsed.reason || '模型判断本轮用文字'));

    /**
     * 校验两条，**都按严格格式**：
     *   · id：要么正好 12 位十六进制（且唯一命中一张），要么完整 64 位精确相等；
     *     以前会剔掉非十六进制字符再取任意长度前缀，导致 "1" 或"前 12 位对、后面乱写"
     *     也能选中一张图。
     *   · confidence：必须是 [0,1] 的有限数；`2`、`NaN`、字符串都算无效。
     */
    const rawId = String(parsed.id ?? '').trim().toLowerCase();
    let hit = null;
    if (/^[0-9a-f]{64}$/.test(rawId)) {
      hit = candidates.find((c) => c.id.toLowerCase() === rawId) || null;
    } else if (/^[0-9a-f]{12}$/.test(rawId)) {
      const matched = candidates.filter((c) => c.id.toLowerCase().startsWith(rawId));
      hit = matched.length === 1 ? matched[0] : null;
    }
    if (!hit) return textOf('模型给出的图片 ID 格式不对或不在候选里');
    const conf = typeof parsed.confidence === 'number' ? parsed.confidence : Number.NaN;
    if (!Number.isFinite(conf) || conf < 0 || conf > 1) return textOf('模型给出的置信度无效');
    if (conf < settings.threshold) return textOf(`置信度不足（${conf.toFixed(2)}）`);

    noteRecent(chatId, hit.id);
    return {
      mode: 'image',
      reason: String(parsed.reason || ''),
      image: { id: hit.id, name: hit.name, meaning: hit.meaning, path: hit.path },
      /** 宿主解析这个标记，抽成"单独发一条图" */
      marker: `<<image-alone: ${hit.path}>>`,
    };
  } catch (e) {
    return textOf(`判断失败：${e?.message ?? e}`);
  } finally {
    inflight -= 1;
  }
}

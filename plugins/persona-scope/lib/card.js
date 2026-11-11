/**
 * 专属人设卡：模板渲染 + 正则条件 + 注入块拼装
 *
 * 全部是纯函数，不碰网络、不碰框架，可以在纯 Node 里单测。
 *
 * ── 为什么要自己写个小模板引擎 ────────────────────────────────────
 * 人设卡是「写给人看的文本」，让用户去写 JSON 条件树不现实。
 * 所以做成 RP 卡那种行文里夹条件：
 *
 *   角色：你是 {{nick}} 的专属执事。
 *   {{if /早安|早上好/}}现在是早上，用晨间问候的语气。{{else}}用平静克制的语气。{{end}}
 *   {{if /抱抱|亲亲|想你了/}}对方在撒娇，回应可以更亲昵一点。{{end}}
 *
 * `{{if}}` 里的条件就是**正则**（/…/flag 或裸写都行），匹配对象是这个人
 * 这一轮说的话。没写 /…/ 就按「子串包含」处理，免得用户被正则语法吓退。
 */

/**
 * 模板里允许的变量名。不在表里的一律原样保留，避免拼错时静默变成空白。
 *
 * `user` / `char` 沿用 RP 卡的惯例语义（SillyTavern 那套）：
 *   {{user}} = **对方**（用昵称），{{char}} = 这张卡的角色名。
 * 以前 `user` 被塞成 openid，照抄一份 RP 人设卡进来，模型看到的是
 * 「目前是 81E083DCED0024C3AE4C7FA77CC9E5A9 的恋人」——所以这里必须改语义，
 * openid 单独用 {{userId}} 暴露（确实要用的时候才用）。
 */
const VARS = new Set(['nick', 'user', 'char', 'userId', 'time', 'date', 'weekday', 'level', 'chat', 'cardName']);

/**
 * 把用户写的条件编译成匹配函数。
 *
 * 支持三种写法：
 *   /正则/flags   显式正则
 *   含元字符的裸写  按正则处理（早安|早上好、^好累）
 *   普通文字       直接子串包含
 *
 * 裸写走**正则或字面，二者命中其一就算命中**：
 * 以前是「先试 new RegExp，抛错才退回 includes」，于是 `$100` / `a.*b` / `早安^`
 * 这类能编译、但永远匹配不到正常句子的写法会变成**静默死条件** ——
 * 用户看着条件写对了，就是不生效。现在正则不中还会再按字面找一次。
 *
 * **绝不让一条写坏的正则把机器人搞崩**：编译失败返回 null，调用方跳过这个分支。
 */
/**
 * ReDoS 护栏。
 *
 * 条件是**管理员**在面板里写的，但参与匹配的 subject 是**群员**发的话。
 * 一条 `(a+)+b` 配上一串 a 就能让正则回溯爆炸，而 Node 是单线程 ——
 * 事件循环卡住的时候，整个机器人（不只是这个插件）都没有响应。
 *
 * 这里加两道最便宜的护栏：正则源码长度、被匹配字符串长度。挡不住所有构造
 * （彻底解法是 worker + 超时），但把「随手一写就炸」变成「几乎不可能炸」，
 * 而正常的人设条件（关键词、短句、`早安|早上好`）完全不受影响。
 */
const MAX_RE_SRC = 300;
const MAX_SUBJECT = 1000;

/**
 * 嵌套量词的形状：`(…+…)` 或 `(…*…)` 后面又跟量词 —— `(a+)+`、`(a*)*`、`(\\d+){2,}`。
 * 这是 ReDoS 的经典形态：截断被匹配串救不了它（30 个 a 就够炸）。
 * 正则本身是单线程跑的，一旦回溯爆炸，整个机器人一起卡住。
 *
 * 命中就**不编译正则、降级为字面匹配**——宁可这条条件判得粗一点，也不能
 * 让一条配置把进程带走。正常条件（`早安|早上好`、`^好累`、`\\d{3,}`）不会命中。
 */
const NESTED_QUANT = /\([^()]*[+*][^()]*\)\s*[+*{]/;

/** 截断被匹配的字符串：人设条件看开头已经够了，长消息后半段不参与判定 */
const subjectOf = (s) => String(s ?? '').slice(0, MAX_SUBJECT);

export function compileCondition(raw) {
  const src = String(raw ?? '').trim();
  if (!src) return null;

  // /pattern/flags —— 末尾的 \/ 是转义的斜杠，不能当分隔符
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(src);
  if (m) {
    // 超长正则不编译：长度本身就是回溯风险的强信号，而且没人手写 300 字以上的条件
    if (m[1].length > MAX_RE_SRC) return null;
    let re = null;
    if (!NESTED_QUANT.test(m[1])) {
      try { re = new RegExp(m[1], m[2].replace(/g/g, '')); } catch { re = null; }
    }
    if (!re) return { test: (s) => subjectOf(s).includes(m[1]) };
    if (!re) return null;
    return { test: (s) => { try { return re.test(subjectOf(s)); } catch { return false; } } };
  }

  let re = null;
  if (src.length <= MAX_RE_SRC && !NESTED_QUANT.test(src)) {
    try { re = new RegExp(src); } catch { re = null; }
  }
  return {
    test: (s) => {
      const str = subjectOf(s);
      if (re) { try { if (re.test(str)) return true; } catch { /* 继续试字面 */ } }
      return str.includes(src);
    },
  };
}

/**
 * 渲染 `{{if 条件}}…{{else}}…{{end}}` 与 `{{变量}}`。
 *
 * 用递归而不是一次正则替换：条件块要能嵌套，而正则做不到配对。
 * 深度上限 8 层，超了就停止展开（宁可少渲染一段，也不要递归爆栈）。
 */
export function renderTemplate(text, vars = {}, subject = '', depth = 0) {
  let out = String(text ?? '');
  if (!out) return '';
  if (depth > 8) return out;

  // 逐个找最内层的 if 块：从最靠后的 {{if …}} 开始替换，天然支持嵌套
  /**
   * 条件用非贪婪匹配到 `}}`，**不能用 `[^}]+`**：
   * 那样一遇到 `}` 就截断，凡是写了正则量词的条件都匹配不上标签本身
   * （`{{if /\d{2,4}/}}`、`{{if /哈{2,}/}}`），整段模板原样漏给模型。
   */
  const IF = /\{\{\s*if\s+([\s\S]+?)\}\}/g;
  let guard = 0;
  for (;;) {
    if (guard++ > 200) break; // 防御死循环（比如用户写了个不配对的 end）
    // 找到最后一个 if 起点，以及它之后的第一个 end
    let last = null;
    for (const m of out.matchAll(IF)) last = m;
    if (!last) break;

    const start = last.index;
    const bodyStart = start + last[0].length;
    const endIdx = out.indexOf('{{end}}', bodyStart);
    if (endIdx < 0) {
      // 没有配对 end：整段原样保留，并去掉这个 if 标记，避免每轮都扫
      out = out.slice(0, start) + out.slice(bodyStart);
      continue;
    }
    const inner = out.slice(bodyStart, endIdx);
    const elseIdx = inner.indexOf('{{else}}');
    const cond = compileCondition(last[1]);
    // 条件写坏 / 没条件：当作 false，走 else 分支
    let hit = false;
    if (cond) {
      try { hit = Boolean(cond.test(subject)); } catch { hit = false; }
    }
    const branch = hit
      ? (elseIdx >= 0 ? inner.slice(0, elseIdx) : inner)
      : (elseIdx >= 0 ? inner.slice(elseIdx + '{{else}}'.length) : '');
    out = out.slice(0, start) + branch + out.slice(endIdx + '{{end}}'.length);
  }

  // 变量替换
  return out.replace(/\{\{\s*([A-Za-z][\w]*)\s*\}\}/g, (whole, name) =>
    (VARS.has(name) && vars[name] != null ? String(vars[name]) : whole));
}

/** JSON 配置可能是字符串、数组、单对象，统一成数组。坏数据一律丢弃，绝不抛错。 */
export function asArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw == null || raw === '') return [];
  if (typeof raw === 'object') return [raw];
  try {
    const v = JSON.parse(String(raw));
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') return [v];
    return [];
  } catch { return []; }
}

/** 卡片归一：id/name/text 三件套，text 为空视为无效（否则会注入一段空白指令）。 */
export function normalizeCards(raw) {
  return asArray(raw)
    .map((c, i) => ({
      id: String(c?.id ?? `card${i + 1}`).trim() || `card${i + 1}`,
      name: String(c?.name ?? '').trim(),
      text: String(c?.text ?? '').trim(),
      // 只对这些人生效；留空 = 跟着全局 targets 走
      targets: String(c?.targets ?? '').trim(),
    }))
    .filter((c) => c.text);
}

/**
 * 预设归一。形态对齐 RP-Hub 的「预设管理」：
 *   { name, role, content, enabled, when? }
 *
 * 一条都没有正文的会被丢掉 —— 空预设注入进去只会白占 token。
 * 名字为空时按序号补一个，否则列表里全是「未命名」根本分不清。
 */
export function normalizePresets(raw) {
  return asArray(raw)
    .map((p, i) => ({
      id: String(p?.id ?? `preset${i + 1}`).trim() || `preset${i + 1}`,
      name: String(p?.name ?? '').trim() || `预设 ${i + 1}`,
      role: ['system', 'user', 'assistant'].includes(String(p?.role ?? '').trim())
        ? String(p.role).trim()
        : 'system',
      // 生效条件：留空=总是生效。写坏了在 compileCondition 里退化成字面包含
      when: String(p?.when ?? '').trim(),
      content: String(p?.content ?? p?.text ?? '').trim(),
      enabled: p?.enabled !== false,
    }))
    .filter((p) => p.content);
}

/**
 * 老配置迁移：旧版是 `rules: [{ when, text, mode }]`，新版统一成预设。
 * 不迁移的话升级后用户之前写的规则会凭空消失。
 */
export function migrateRules(rules) {
  return asArray(rules)
    .map((r, i) => ({
      id: `legacy${i + 1}`,
      name: `旧规则 ${i + 1}`,
      role: 'system',
      when: String(r?.when ?? '').trim(),
      content: String(r?.text ?? '').trim(),
      enabled: true,
    }))
    .filter((p) => p.content);
}

/** openid / 群号列表：逗号、顿号、分号、空白都算分隔。去重保序。 */
export function parseIdList(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，、;；\s]+/);
  const out = [];
  for (const item of list) {
    const id = String(item ?? '').trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 这个人要不要用专属人设。
 *
 * 判据只有两条，**都不看昵称**：
 *   ① openid 在名单里 —— 协议字段，改名/撞名都影响不到
 *   ② 权限等级 ≤ minLevel（minLevel=0 表示不看等级；等级数字越小越高）
 *
 * 为什么坚决不看名字：群里名片随时能改，两个人同名很常见。
 * 一旦「名字像就算」，任何把名片改成主人名字的路人都能拿到专属设定。
 *
 * @param {string} cardTargets 卡片自带的名单。**非空时只看它**：
 *   以前这里会让全局 minLevel 继续放行，于是「只想给 A 用的卡」被同级别的
 *   另一个管理员 B 拿到了；也会让 B 连通用预设一起丢掉（卡片名单覆盖了全局名单）。
 */
export function matchesTarget({ userId, level, targets, minLevel }, cardTargets = '') {
  const cardIds = parseIdList(cardTargets);
  if (cardIds.length) return cardIds.includes(String(userId ?? ''));
  const ids = parseIdList(targets);
  if (ids.includes(String(userId ?? ''))) return true;
  const lv = Number(minLevel);
  return Number.isFinite(lv) && lv > 0 && Number.isFinite(Number(level)) && Number(level) <= lv;
}

/**
 * 这个人能拿到哪些卡。
 *
 * 只保留「没有名单」或「名单里有他」的卡，**不做回退**。
 * 以前过滤空了会回退成全部卡片，等于把别人的专属卡发给剩下所有人。
 */
export function cardsForUser(cards, { userId }) {
  const id = String(userId ?? '');
  return (Array.isArray(cards) ? cards : []).filter(
    (c) => !parseIdList(c?.targets).length || parseIdList(c.targets).includes(id),
  );
}

/** 挑一套卡片：优先 id 命中，其次第一套。都没有返回 null。 */
export function pickCard(cards, wantedId) {
  if (!cards.length) return null;
  const id = String(wantedId ?? '').trim();
  if (id) {
    const hit = cards.find((c) => c.id === id);
    if (hit) return hit;
  }
  return cards[0];
}

/** user / assistant 预设的包裹前缀（注入时会加在正文前面，算预算必须带上）。 */
const UA_WRAP = {
  user: '（预设·模拟对方说的话，不是他这一轮真正说的）\n',
  assistant: '（预设·模拟你此前说过的话）\n',
};

/**
 * 一条预设实际会占多少字符。
 *
 * `content.length` 是不够的：user / assistant 角色会额外包一层来源标注
 * （约 22~25 字），按 content 算预算就会差出几十个字 ——
 * 卡着预算线填的人正好被截断，还找不到原因。
 */
export function presetCost(p) {
  if (!p || p.enabled === false) return 0;
  const body = String(p.content ?? '').length;
  const wrap = p.role === 'user' ? UA_WRAP.user.length : p.role === 'assistant' ? UA_WRAP.assistant.length : 0;
  return body + wrap;
}

/** 注入块的边界标记。出站前可以用 stripInjection 幂等剥掉。 */
export const BLOCK_OPEN = '〔专属人设·仅对本次发言人生效〕';
export const BLOCK_CLOSE = '〔专属人设结束〕';

/**
 * 拼出要注入的那段文本。
 *
 * 预设按 role 分流（对齐 RP-Hub 的三种角色）：
 *   system   → 拼进人设块正文（人设主体 + 附加约束）
 *   user     → 单独一段，标注为「模拟对方的话」
 *   assistant→ 单独一段，标注为「你此前说过的话」
 * 后两种是 RP 卡常见的「预注入」手法：让模型以为对话里已经发生过，
 * 所以必须明确标注来源，否则它会把内容当成真实历史继续发挥。
 *
 * @returns {string} 空串表示这次不注入（没卡 / 没匹配 / 渲染后为空）
 */
export function buildPersonaBlock({
  card, presets = [], subject = '', vars = {}, maxChars = 1200,
} = {}) {
  const enabled = (Array.isArray(presets) ? presets : []).filter((p) => p && p.enabled !== false);

  /** 条件命中判断：when 留空算总是命中 */
  const hitOf = (when) => {
    const w = String(when ?? '').trim();
    if (!w) return true;
    const cond = compileCondition(w);
    if (!cond) return false;
    try { return Boolean(cond.test(subject)); } catch { return false; }
  };

  // 人设卡正文（单独存一份：截断时它要让位给预设，必须能和预设分开算）
  const cardBody = card?.text ? renderTemplate(card.text, vars, subject).trim() : '';

  // system 预设按数组顺序追加
  const sysFrags = [];
  for (const p of enabled.filter((x) => x.role === 'system' && hitOf(x.when))) {
    const frag = renderTemplate(p.content, vars, subject).trim();
    if (frag) sysFrags.push(frag);
  }

  // user / assistant 预注入
  const uaFrags = [];
  for (const p of enabled.filter((x) => x.role !== 'system' && hitOf(x.when))) {
    const frag = renderTemplate(p.content, vars, subject).trim();
    if (!frag) continue;
    uaFrags.push(`${p.role === 'user' ? UA_WRAP.user : UA_WRAP.assistant}${frag}`);
  }

  /** 除卡片以外的部分（预设）—— 截断时优先完整保留这一块 */
  const tail = [...sysFrags, ...uaFrags].join('\n');
  const parts = [cardBody, ...sysFrags, ...uaFrags].filter(Boolean);
  if (!parts.length) return '';
  const text = parts.join('\n');

  /**
   * 超长时**优先保预设**（防抢话、破限这类规则通常比人设卡的台词示例更关键）。
   *
   * 以前是简单 `slice(0, cap)`：卡写在前面，一超长就从尾部砍，
   * 被砍掉的恰好是排最后的预设 —— 于是用户看到「预设明明开着却不起作用」。
   * 现在先算固定尾部（所有预设）占多少，把剩下的预算留给卡片正文；
   * 卡片太长就砍卡片自己，预设一个字不动。
   *
   * 极端情况（预设本身超过预算）：那就只能从预设尾部截断，此时卡片让位。
   */
  const cap = Math.max(100, Number(maxChars) || 1200);
  if (text.length <= cap) return `${BLOCK_OPEN}\n${text}\n${BLOCK_CLOSE}`;

  const cardSuffix = '…（人设卡过长已截断）';
  const ruleSuffix = '…（预设过长已截断）';
  const room = cap - (tail ? tail.length + 1 : 0) - cardSuffix.length;

  let finalText;
  if (cardBody && room > 60) {
    // 卡片让位：截到剩余预算，预设原样保留
    finalText = `${cardBody.slice(0, room)}${cardSuffix}\n${tail}`;
  } else if (tail) {
    // 预设本身就超预算：只能砍预设（此时卡片让位）
    const keep = Math.max(20, cap - ruleSuffix.length - (cardBody ? cardBody.length + 1 : 0));
    const head = cardBody ? `${cardBody}\n` : '';
    finalText = `${head}${tail.slice(0, Math.min(keep, cap - ruleSuffix.length - head.length))}${ruleSuffix}`;
  } else {
    finalText = `${text.slice(0, Math.max(20, cap - cardSuffix.length))}${cardSuffix}`;
  }

  return `${BLOCK_OPEN}\n${finalText}\n${BLOCK_CLOSE}`;
}

/**
 * 幂等剥离：把上一次注入的块去掉。
 *
 * 中间件是每轮都跑的，而 ai-chat 会把 `said` 存进历史再发回去——
 * 不剥的话同一个块会一层层累积，第二轮就变成「人设」重复两遍。
 *
 * 连带的那个 `\n\n` 分隔符一起吃掉：`injectInto` 加的，属于我们的痕迹；
 * 留着的话每轮剥一次就多一行空白，几十轮后正文前面一大片空行。
 */
export function stripInjection(text) {
  const s = String(text ?? '');
  if (!s.includes(BLOCK_OPEN)) return s;
  const re = new RegExp(`(?:\\r?\\n\\r?\\n)?${escapeRe(BLOCK_OPEN)}[\\s\\S]*?${escapeRe(BLOCK_CLOSE)}\\r?\\n?`, 'g');
  return s.replace(re, '');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 组装最终的注入结果。
 *
 * **放在原文后面而不是前面**：前面的位置最容易撞上别的插件的
 * `startsWith('/')` / 关键词判断，而人设块里全是中文标点，插在最前有可能会
 * 让某些插件把这条消息当成普通聊天处理。放后面原文一个字都不动，
 * 对其它插件完全透明。
 */
export function injectInto(text, block) {
  const clean = stripInjection(text);
  if (!block) return clean;
  return `${clean}\n\n${block}`;
}

/**
 * 变量表：给模板用的上下文。时间一律取本地时区。
 *
 * ⚠️ `user` 是**对方**（昵称），不是 openid —— RP 人设卡里的 {{user}}
 * 指的是「和这个角色对话的人」。openid 走 `userId`，避免把一串
 * `81E083DC…` 拼进人设正文里。
 */
export function buildVars({ nick, userId, level, chatId, cardName, now = new Date() } = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  const name = String(nick || '').trim() || '对方';
  const card = String(cardName ?? '');
  return {
    nick: name,
    user: name,
    char: card || '我',
    userId: String(userId ?? ''),
    level: Number.isFinite(Number(level)) ? String(level) : '',
    chat: String(chatId ?? ''),
    cardName: card,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()],
  };
}

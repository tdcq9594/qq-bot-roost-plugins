/**
 * 人设卡正文的占位符渲染（DSH 侧）。
 *
 * ## 为什么必须在这里渲染
 *
 * 人格正文最终会进 DSH 的**系统提示**，而 DSH 的提示词会解析 `{{变量}}`：
 * 引用了没注册的变量，**整段渲染失败**。所以带 `{{user}}` 的 RP 卡直接写进人格
 * 就会报错。扩展侧先把它们换成正文，落库的就是纯文本，宿主那边不再有花括号。
 *
 * ## 静态人格的取舍
 *
 * Roost 插件版是「每条消息渲染一次」，能按当句话走 `{{if}}`。这里生成的是
 * **一份静态人格**，没有「当前这句话」可判，所以：
 *   · `{{if …}}A{{else}}B{{end}}` → 取 **B（else 分支）**；没有 else 就是空
 *   · `{{user}}` → 绑定的那个人（默认「对方」，可在面板上填称呼）
 *   · `{{char}}` / `{{cardName}}` → 卡片名
 *   · `{{userId}}` → 那个人 openid
 *   · `{{time}}` `{{date}}` `{{weekday}}` → **生成那一刻**的值
 *   · 其余 `{{xxx}}` → **删掉**并记进 `unknown`，避免宿主渲染报错
 */

const IF = /\{\{\s*if\s+([\s\S]+?)\}\}/g;
const END = /\{\{\s*end\s*\}\}/;
const ELSE = /\{\{\s*else\s*\}\}/;

/** 取 `{{if}}…{{end}}` 之间（处理嵌套），返回内层文本与结束位置 */
function sliceBlock(text, openEnd) {
  let depth = 1;
  const re = /\{\{\s*(if\s+[\s\S]+?|end)\s*\}\}/g;
  re.lastIndex = openEnd;
  let m;
  while ((m = re.exec(text))) {
    depth += String(m[1]).startsWith('if') ? 1 : -1;
    if (depth === 0) return { body: text.slice(openEnd, m.index), endAt: m.index + m[0].length };
  }
  return { body: text.slice(openEnd), endAt: text.length };
}

export function buildVars({ user = '', char = '', userId = '', now = new Date() } = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  return {
    user: String(user || '对方'),
    nick: String(user || '对方'),
    char: String(char || ''),
    cardName: String(char || ''),
    userId: String(userId || ''),
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    weekday: '日一二三四五六'[now.getDay()],
  };
}

/**
 * 渲染成人设正文。
 * @returns {{text: string, unknown: string[], conditions: number}}
 */
export function renderPersonaText(text, vars = {}) {
  let out = String(text ?? '');
  let conditions = 0;

  // ① 条件分支：静态人格没有「当句话」，一律走 else
  for (let guard = 0; guard < 100; guard += 1) {
    IF.lastIndex = 0;
    const m = IF.exec(out);
    if (!m) break;
    const { body, endAt } = sliceBlock(out, m.index + m[0].length);
    const em = ELSE.exec(body);
    const fallback = em ? body.slice(em.index + em[0].length) : '';
    out = out.slice(0, m.index) + fallback + out.slice(endAt);
    conditions += 1;
  }
  out = out.replace(END, '').replace(ELSE, '');

  // ② 变量
  const unknown = [];
  out = out.replace(/\{\{\s*([a-zA-Z][\w]*)\s*\}\}/g, (_all, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return String(vars[key] ?? '');
    unknown.push(key);
    return '';
  });

  // ③ 兜底：任何残留的花括号都清掉（宿主渲染会因此报错）
  out = out.replace(/\{\{[\s\S]{0,80}?\}\}/g, '');

  return { text: out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), unknown, conditions };
}

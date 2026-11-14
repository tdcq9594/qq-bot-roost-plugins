/**
 * B 站写动作（0.4，内部用）
 * =========================
 *
 * ⚠️ **不注册成 MCP 工具。** 0.2/0.3 的第一道安全边界是「模型在工具表里
 * 找不到任何能对外说话的东西」——群里任何人的一句话、或视频标题/评论里的
 * 注入文本，都没法让她去发评论。0.4 加写动作但**只在定时刷内部**按开关
 * 执行，模型依旧调用不到，边界还在。
 *
 * 四道闸，缺一不可：
 *   · `writeDryRun` 默认 **开**（只记日志不真发），要用户主动关掉；
 *   · 每天最多 `writeDailyLimit` 次，跨天归零（在 push.mjs 里算）；
 *   · Cookie 里没有 `bili_jct` 直接拒 —— 没有 csrf 写接口只会回 -111；
 *   · 撞到 -101 / -111 / -352 / -509 / 验证码就**当天暂停**，别一直撞风控。
 *
 * 零依赖，fetch 可注入，测试不碰真账号。
 */

import { BiliError, UA, parseCookie } from './api.mjs';

/** 这些码说明今天别再写了，翻成人话给用户看。 */
export const PAUSE_CODES = {
  '-101': 'B 站说没登录（Cookie 失效了）',
  '-111': 'Cookie 里的 bili_jct 不对',
  '-352': '被 B 站风控了',
  '-412': '被 B 站风控了',
  '-509': '请求太频繁，被 B 站限流了',
  12015: 'B 站要求验证码',
  '-403': '没权限发（可能被禁言了）',
};

const dayOf = (t) => new Date(t).toDateString();

/**
 * 评论末尾 @ 主人。
 *
 * B 站的 @ 只是**文本**，不会真的给对方发提醒（那是客户端行为），所以这里
 * 只是「让人看得见我提到了你」。已经写过就不重复加；评论上限 200 字，
 * 整体截断而不是把 @ 截掉。
 *
 * @param {string} text
 * @param {string} name 主人的 B 站昵称；空 = 不加
 */
export function withMention(text, name) {
  const t = String(text || '').trim();
  const n = String(name || '').trim();
  if (!n || !t) return t.slice(0, 200);
  if (t.includes(`@${n}`)) return t.slice(0, 200);
  /**
   * 先把正文裁到「留得下 @」的长度再拼——直接整条 slice 会把 @ 截掉，
   * 那就白加了（用户看到的是一句没有提到任何人的话）。
   */
  const suffix = ` @${n}`;
  const room = Math.max(0, 200 - suffix.length);
  return `${t.slice(0, room)}${suffix}`;
}

export function createWriteApi({
  getCookie = () => '', fetchImpl = fetch, dryRunOf = () => true,
  log = () => {}, now = () => Date.now(), timeoutMs = 12000,
} = {}) {
  let pauseDay = '';
  let pauseReason = '';

  function paused() {
    if (pauseDay !== dayOf(now())) { pauseDay = ''; pauseReason = ''; }
    return pauseDay ? pauseReason : '';
  }

  function creds() {
    const cookie = String(getCookie() || '').trim();
    const csrf = parseCookie(cookie).bili_jct;
    if (!cookie || !csrf) {
      throw new BiliError('Cookie 里没有 bili_jct，发不了（登录态不完整）', {
        hint: '重新复制整条 Cookie，至少要 SESSDATA 和 bili_jct',
      });
    }
    return { cookie, csrf };
  }

  /** 所有写接口都是 form + csrf，返回 code≠0 一律当失败 */
  async function post(path, form, label) {
    const why = paused();
    if (why) return { ok: false, skipped: true, why };
    const { cookie, csrf } = creds();
    const body = new URLSearchParams({ ...form, csrf }).toString();
    if (dryRunOf()) {
      log(`试运行：本来要${label}（${body.slice(0, 120)}）`);
      return { ok: true, dryRun: true };
    }
    const r = await fetchImpl(`https://api.bilibili.com${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': UA,
        cookie,
        referer: 'https://www.bilibili.com/',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new BiliError(`${label}失败（HTTP ${r.status}）`);
    if (Number(j.code) !== 0) {
      const code = String(j.code);
      const hit = PAUSE_CODES[code];
      if (hit) { pauseDay = dayOf(now()); pauseReason = hit; }
      throw new BiliError(`${label}失败：${hit || j.message || `code ${code}`}`, { code, pause: Boolean(hit) });
    }
    return { ok: true, dryRun: false };
  }

  return {
    /**
     * 视频下评论；带 `root` / `parent` 就是**回到某一层楼**。
     *
     * 只发到视频下面等于另起一条评论，对方收不到提醒——「ta 回你」这件事
     * 就白做了。`root` 是楼主评论的 rpid，`parent` 是被回复那条的 rpid
     * （回复楼主时可以两个都给同一个值）。
     */
    comment: (aid, text, { root = 0, parent = 0 } = {}) => post('/x/v2/reply/add', {
      type: '1', oid: String(aid), message: String(text).slice(0, 200),
      ...(root ? { root: String(root), parent: String(parent || root) } : {}),
    }, root ? '回复评论' : '发评论'),
    /** 点赞 */
    like: (aid) => post('/x/web-interface/archive/like', {
      aid: String(aid), like: '1',
    }, '点赞'),
    /** 弹幕：oid 是 cid（分 P 的 cid 来自 view()），progress 毫秒 */
    danmaku: (cid, text, progress = 1000) => post('/x/v2/dm/post', {
      type: '1', oid: String(cid), msg: String(text).slice(0, 100),
      progress: String(Math.max(0, Math.round(progress))),
      color: '16777215', fontsize: '25',
    }, '发弹幕'),
    state: () => ({ paused: paused() }),
    reset: () => { pauseDay = ''; pauseReason = ''; },
  };
}

/**
 * 群管插件
 * ========
 *
 * 把 QQ 官方机器人的群管接口包成命令。**机器人必须是群管理员**，
 * 否则服务端返回 40062003，这里会翻成人话。
 *
 * 官方能力的边界（写在这里，免得以后怀疑是不是插件写错了）：
 *
 * | 能力 | 接口 | 额外要求 |
 * |---|---|---|
 * | 禁言 / 解禁 | `restrict_chat_setting` | 机器人是群管理员 |
 * | 踢人 | `batch_remove_members` | 机器人是群管理员 **+ 群管内邀白名单** |
 * | 群信息 / 禁言状态 | `groups/{id}/info` 等 | 无 |
 *
 * 官方**没有**的：全员禁言、改群名片、设/撤管理员、撤回别人的消息。
 * 这些不是没做，是接口不存在——别在群里试了以为坏了。
 *
 * 目标怎么指定：**@ 对方**最省事（机器人开了「接收所有消息」后，
 * 官方会在事件里给 mentions），或者让对方发 `/whoami` 把 id 贴过来。
 * 回复里一律用昵称，不显示 openid——群友看不懂那串十六进制。
 *
 * **只支持这两种。** 按昵称匹配、按「楼上/第几个」都做过又删了——
 * 那些是从「最近说过话的人」里猜，群聊刷几句话就错位，
 * 禁言错人比不能禁言更糟。
 */
export default {
  id: 'group-admin',
  name: '群管',
  version: '1.1.0',
  description: '禁言、解禁、踢人、群信息（需要机器人是群管理员）',

  setup(ctx) {
    const P = ctx.prefix;
    const api = ctx.api;

    /** 禁言上限 30 天，官方硬限制 */
    const MAX_MUTE_MS = 30 * 24 * 3600 * 1000;

    /* ---------------- 小工具 ---------------- */

    /**
     * 把 `10m` / `1h` / `2d` / `90` 解析成毫秒。
     *
     * 纯数字按**分钟**算——「禁言 10」比「禁言 10 秒」符合直觉，
     * 也符合 QQ 群管的手动操作习惯。
     *
     * @returns {number|null} 解析不出来返回 null
     */
    function parseDuration(text) {
      const s = String(text ?? '').trim().toLowerCase();
      if (!s) return null;
      const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|秒|分|时|天)?$/);
      if (!m) return null;
      const n = Number(m[1]);
      if (!Number.isFinite(n) || n <= 0) return null;
      const unit = m[2] ?? 'm';
      const mul =
        unit === 's' || unit === '秒'
          ? 1000
          : unit === 'h' || unit === '时'
            ? 3600_000
            : unit === 'd' || unit === '天'
              ? 86400_000
              : 60_000;
      return Math.min(Math.round(n * mul), MAX_MUTE_MS);
    }

    /** 毫秒 → 人话（「10 分钟」「1 小时 30 分钟」） */
    function humanDuration(ms) {
      if (ms <= 0) return '0 秒';
      const units = [
        ['天', 86400_000],
        ['小时', 3600_000],
        ['分钟', 60_000],
        ['秒', 1000],
      ];
      const parts = [];
      let left = ms;
      for (const [name, size] of units) {
        const n = Math.floor(left / size);
        if (n) {
          parts.push(`${n} ${name}`);
          left -= n * size;
        }
        if (parts.length === 2) break;
      }
      return parts.join(' ') || `${Math.round(ms / 1000)} 秒`;
    }

    /** 本地时区的 RFC3339，官方要这个格式（带偏移，不能是 Z） */
    function rfc3339(d) {
      const p = (n) => String(n).padStart(2, '0');
      const off = -d.getTimezoneOffset();
      const sign = off >= 0 ? '+' : '-';
      return (
        `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
        `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
        `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
      );
    }

    /** 像不像一个 openid：十六进制、够长。用来区分「@ 到了」和「手填的 id」 */
    const looksLikeOpenid = (s) => /^[0-9A-Fa-f]{16,64}$/.test(String(s ?? '').trim());

    /**
     * 展示用名字。**绝不回退到 openid**——用户明确要求回复里不出现 id。
     * 实在拿不到昵称就说「该成员」，比甩一串十六进制强。
     */
    const nameOf = (t) => t?.name || '该成员';

    /**
     * 从消息里找出「要操作谁」。
     *
     * 依次认：
     *   1. `mentions`（@ 的人）——最准，官方在 mentions 里还给了 username
     *   2. 参数里的 openid 长串（`/whoami` 能拿到）
     *
     * 就这两种。**不做昵称匹配、不做「楼上/第几个」**——那些都是从
     * 「最近说过话的人」里猜的，群聊刷几句话就错位，禁言错人比不能禁言更糟。
     * 想要谁就 @ 谁，或者让当事人发 `/whoami` 把 id 贴过来。
     *
     * @returns {Array<{openid:string, name:string}>}
     */
    function resolveTargets(msg, args) {
      const out = [];
      const push = (openid, name = '') => {
        const id = String(openid ?? '').trim();
        if (!id) return;
        const hit = out.find((x) => x.openid === id);
        if (hit) {
          if (!hit.name && name) hit.name = name;
          return;
        }
        out.push({ openid: id, name: String(name ?? '').trim() });
      };

      for (const m of msg.mentions ?? []) push(m.id, m.name);
      for (const a of args ?? []) {
        if (looksLikeOpenid(a)) push(a);
      }
      return out;
    }

    /**
     * 这个群能不能用 @ 指定目标。
     *
     * 取决于官方给不给 mentions：开了「接收所有消息」的群有
     * （`GROUP_MESSAGE_CREATE`），只开「@机器人消息」的群没有
     * （`GROUP_AT_MESSAGE_CREATE` 的 content 里 @ 被换成空格）。
     *
     * 拿不到就别在提示里教人 @——按做了却没用，用户只会更困惑。
     */
    function canUseMention(msg) {
      if ((msg.mentions ?? []).length) return true;
      // 正文里还留着 <@openid> 也算，mentionsFromContent 捞得到
      return /<@!?[0-9A-Za-z]+>/.test(String(msg.raw?.content ?? ''));
    }

    /** 「要操作谁」的统一提示——不出现 openid */
    function targetHint(action, msg) {
      const lines = [`要${action}谁？`];
      if (canUseMention(msg)) {
        lines.push(`· ${P}禁言 10m @某人 —— 直接 @ 对方`);
      } else {
        lines.push('· 这个群没开「接收全部消息」，@ 谁都用不了');
      }
      lines.push(
        `· 让对方发 ${P}whoami 拿自己的 id，再 ${P}禁言 10m <id>`,
        '',
        '只支持这两种指定方式——按昵称猜人容易禁错，不做。',
      );
      return lines.join('\n');
    }

    /** 把官方错误翻成人话 */
    function explain(e) {
      const raw = String(e?.message ?? e);
      if (raw.includes('40062003')) {
        return '机器人在这个群不是管理员。去群设置 → 群机器人 → 把「管理员」打开。';
      }
      if (raw.includes('11253') || raw.includes('内邀')) {
        return (
          '这个操作需要「群管内邀」白名单（官方限制，踢人/拉黑/群成员列表都要）。\n' +
          '申请通过后到面板「配置 → 群管能力」打开。禁言不需要这个。'
        );
      }
      if (raw.includes('40054')) return '被操作的成员是群主或管理员，官方不允许动他们。';
      if (raw.includes('30 天') || raw.includes('30天')) return '禁言最长 30 天。';
      return raw;
    }

    /** 这个群能不能群管，不能就把原因回给用户 */
    async function ensureManageable(msg) {
      if (msg.kind !== 'group' || !msg.groupId) {
        await msg.reply('这个命令只能在群里用。');
        return false;
      }
      const st = await api.canManageGroup(msg.groupId).catch((e) => ({
        ok: false,
        role: null,
        reason: e.message,
      }));
      // 查不到角色（内邀没开等）时不拦，交给真正的请求去判
      if (st.role && !st.ok) {
        await msg.reply(`没法群管：${st.reason}`);
        return false;
      }
      return true;
    }

    /* ---------------- 命令 ---------------- */

    ctx.command('禁言 [时长] [目标]', {
      desc: '禁言，时长写 10m / 1h / 1d；目标 @ 对方，或填 TA 的 id',
      admin: true,
    }, async (msg, { args, bot }) => {
      if (!(await ensureManageable(msg))) return;

      // 第一个参数不是时长就当目标，省得每次都写时长（默认 10 分钟）
      let dur = parseDuration(args[0]);
      let rest = args.slice(1);
      if (!dur) {
        dur = 10 * 60_000;
        rest = args;
      }

      const targets = resolveTargets(msg, rest);
      if (!targets.length) return msg.reply(targetHint('禁言', msg));

      const expire = rfc3339(new Date(Date.now() + dur));
      const okList = [];
      const badList = [];
      for (const t of targets) {
        try {
          await api.muteMember(msg.groupId, t.openid, expire);
          okList.push(t);
        } catch (e) {
          badList.push({ t, why: explain(e) });
        }
      }

      const lines = [];
      if (okList.length) {
        lines.push(`已禁言 ${okList.length} 人，时长 ${humanDuration(dur)}`);
        for (const t of okList) lines.push(`· ${nameOf(t)}`);
      }
      for (const b of badList) lines.push(`· ${nameOf(b.t)} 没成功：${b.why}`);
      await msg.reply(lines.join('\n'));
    });

    ctx.command('解禁 [目标]', {
      desc: '解除禁言，目标写法同「禁言」',
      admin: true,
    }, async (msg, { args, bot }) => {
      if (!(await ensureManageable(msg))) return;

      const targets = resolveTargets(msg, args);
      if (!targets.length) return msg.reply(targetHint('解禁', msg));

      const okList = [];
      const badList = [];
      for (const t of targets) {
        try {
          await api.muteMember(msg.groupId, t.openid, null);
          okList.push(t);
        } catch (e) {
          badList.push({ t, why: explain(e) });
        }
      }

      const lines = [];
      if (okList.length) {
        lines.push(`已解除 ${okList.length} 人的禁言`);
        for (const t of okList) lines.push(`· ${nameOf(t)}`);
      }
      for (const b of badList) lines.push(`· ${nameOf(b.t)} 没成功：${b.why}`);
      await msg.reply(lines.join('\n'));
    });

    ctx.command('踢人 [目标]', {
      desc: '踢出群，目标写法同「禁言」（需要群管内邀白名单）',
      admin: true,
    }, async (msg, { args, bot }) => {
      if (!(await ensureManageable(msg))) return;

      const targets = resolveTargets(msg, args);
      if (!targets.length) return msg.reply(targetHint('踢', msg));
      try {
        await api.removeMembers(
          msg.groupId,
          targets.map((t) => t.openid),
        );
        await msg.reply(
          `已移出 ${targets.length} 人\n` + targets.map((t) => `· ${nameOf(t)}`).join('\n'),
        );
      } catch (e) {
        await msg.reply(`踢人失败：${explain(e)}`);
      }
    });

    ctx.command('群信息', { desc: '群名、成员数、机器人角色、禁言状态', admin: true }, async (msg) => {
      if (msg.kind !== 'group' || !msg.groupId) return msg.reply('这个命令只能在群里用。');

      const lines = [];
      const info = await api.getGroupInfo(msg.groupId).catch((e) => ({ error: e.message }));
      if (info && !info.error) {
        lines.push(`群名：${info.group_name ?? info.name ?? '-'}`);
        if (info.member_count) lines.push(`成员数：${info.member_count}`);
      } else if (info?.error) {
        lines.push(`群信息读不到：${info.error}`);
      }

      const st = await api.canManageGroup(msg.groupId, { maxAgeMs: 0 }).catch((e) => ({
        ok: false,
        role: null,
        reason: e.message,
      }));
      const roleText =
        st.role === 'owner' ? '群主' : st.role === 'admin' ? '管理员' : st.role === 'member' ? '普通成员' : '未知';
      lines.push(`我的角色：${roleText}${st.ok ? '（可以群管）' : ''}`);

      const mute = await api.getMuteStatus(msg.groupId).catch(() => null);
      if (mute) {
        const on = mute.mute_all === true || mute.muteAll === true;
        lines.push(`全员禁言：${on ? '开' : '关'}`);
      }
      await msg.reply(lines.join('\n'));
    });

    /**
     * 自检：把「为什么群管不生效」一次说清楚。
     *
     * 这条不需要管理员——出问题时往往是普通成员在问「机器人怎么不禁言」。
     */
    ctx.command('群管状态', { desc: '自检：机器人是不是管理员、缺什么权限' }, async (msg) => {
      if (msg.kind !== 'group' || !msg.groupId) return msg.reply('这个命令只能在群里用。');

      const st = await api.canManageGroup(msg.groupId, { maxAgeMs: 0 }).catch((e) => ({
        ok: false,
        role: null,
        reason: e.message,
      }));

      const roleText =
        st.role === 'owner' ? '群主' : st.role === 'admin' ? '管理员' : st.role === 'member' ? '普通成员' : '未知';
      const lines = [`我的角色：${roleText}`];
      if (st.ok) {
        lines.push('禁言 / 解禁：可用');
        lines.push('踢人：需要群管内邀白名单（面板「配置 → 群管能力」）');
      } else {
        lines.push(`原因：${st.reason}`);
        lines.push('');
        if (st.role === 'member') {
          lines.push('怎么修：群设置 → 群机器人 → 找到我 → 设为管理员。');
        } else {
          lines.push('查不到角色多半是「群管内邀」没开：面板「配置 → 群管能力」。');
        }
      }
      await msg.reply(lines.join('\n'));
    });
  },
};

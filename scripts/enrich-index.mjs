#!/usr/bin/env node
/**
 * 合并后从 GitHub API 反查本次 push 关联的 PR，给索引补展示字段
 * ==============================================================
 *
 * 由 sync-artifacts.yml 在 push 到 main 后调用。build-index.mjs 只管结构字段
 * （version / path / sha256），展示字段（author / credits / addedAt）它故意保留
 * 手写值不覆盖——所以新插件合进来时这三个是空的，贡献者表就不会出现它。
 *
 * 本脚本补的就是这几个字段，数据来源是 GitHub 本身而不是插件自述：
 *   - author       = PR 发起人的 GitHub 登录名（维护者自己发的 PR 不占署名）
 *   - contributors = [{login, pr}] 结构化署名，生成器据此对号入座
 *   - credits      = 人读的说明文字（含 PR 号，但不参与生成）
 *   - addedAt      = 首次收录当天
 *
 * 为什么不用插件目录里的 author 字段：签名校验的是内容，不校验署名；
 * 让投稿人自己填 author 等于谁都能写别人的名字。PR 发起人是 GitHub 的
 * 权威数据，和 verified.json 一样属于「我们的判断，不是插件的自述」。
 *
 * 幂等：同样的 before..after 跑多少次结果一样（credits 里已有 PR 号就跳过）。
 * 没有 token 或查不到 PR 时静默跳过——CI 里的 --check 不需要这些字段。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const INDEX = path.join(ROOT, 'index.json');
const REPO = process.env.GITHUB_REPOSITORY ?? 'tdcq9594/qq-bot-roost-plugins';
const TOKEN = process.env.GITHUB_TOKEN ?? '';
const BEFORE = process.env.SYNC_BEFORE ?? '';
const AFTER = process.env.SYNC_AFTER ?? '';
/** 维护者自己的投稿不进社区贡献者表，但 PR 号仍记进 credits。 */
const MAINTAINERS = new Set(['tdcq9594']);

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

async function gh(pathname) {
  // API 失败不能让整条生成链断掉——署名是锦上添花，索引和 README 才是主产物。
  // 强推把 commit 删了（422）、限流（403）、网络抖动都可能是暂时的，
  // 下次有人合并时会由新的一次 push 补上。
  try {
    const res = await fetch(`https://api.github.com${pathname}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      console.warn(`enrich: GitHub API ${pathname} → HTTP ${res.status}，跳过本次署名注入`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`enrich: GitHub API ${pathname} 调用失败（${e.message}），跳过本次署名注入`);
    return null;
  }
}

if (!TOKEN || !BEFORE || !AFTER) {
  console.log('enrich: 缺少 token 或 push 范围，跳过署名注入');
  process.exit(0);
}

// before 是全零（新分支首次推送）时 rev-list 会失败，退化成只看 after 本身
let shas;
try {
  shas = git(['rev-list', `${BEFORE}..${AFTER}`]).split('\n').filter(Boolean);
} catch {
  shas = [AFTER];
}
if (shas.length === 0) shas = [AFTER];

// 同一个 PR 的多个提交会重复出现，按 number 去重
const prs = new Map();
for (const sha of shas) {
  const linked = await gh(`/repos/${REPO}/commits/${sha}/pulls?per_page=100`);
  for (const pr of (Array.isArray(linked) ? linked : [])) {
    if (!pr.number) continue;
    if (!prs.has(pr.number)) {
      prs.set(pr.number, { number: pr.number, login: pr.user?.login ?? '', files: [] });
    }
  }
}
if (prs.size === 0) {
  // 直推护栏：分支保护为了放开 bot 回推而去掉了 required PR，插件改动
  // 全靠流程自律走 PR。这里在直推改了插件时发 warning 留痕——不是硬拦
  // （硬拦会连 bot 自己的 push 一起挡，且个人仓配不了 bypass），但能让
  // 「自己提交插件也要提 PR」这条约定在 Actions 日志里被看见。
  let touchedPlugins = '';
  try {
    touchedPlugins = git(['diff', '--name-only', `${BEFORE}..${AFTER}`, '--', 'plugins/']);
  } catch {
    /* before 无效时忽略，不为了护栏让主流程失败 */
  }
  if (touchedPlugins) {
    console.log('::warning::本次 push 改了 plugins/ 但没有关联 PR——请确认是自己直推了。');
    console.log('::warning::约定：自己提交插件也要走 PR（pr-guard 风险拦截 + CI 结论 + 人工审都只在 PR 上生效）。');
    console.log(touchedPlugins.split('\n').slice(0, 20).map((f) => `  ${f}`).join('\n'));
  } else {
    console.log('enrich: 本次 push 没有关联 PR，也没有插件改动，跳过署名注入');
  }
  process.exit(0);
}

// 每个 PR 改了哪些插件目录——只认 plugins/<id>/，别的地方碰了不管
for (const pr of prs.values()) {
  const files = await gh(`/repos/${REPO}/pulls/${pr.number}/files?per_page=100`);
  for (const f of (Array.isArray(files) ? files : [])) {
    const m = /^plugins\/([^/]+)\//.exec(f.filename ?? '');
    if (m && !pr.files.includes(m[1])) pr.files.push(m[1]);
  }
}

const index = JSON.parse(await fs.readFile(INDEX, 'utf8'));
const byId = new Map((index.plugins ?? []).map((p) => [p.id, p]));
const today = new Date().toISOString().slice(0, 10);
let changed = 0;

for (const pr of prs.values()) {
  for (const id of pr.files) {
    const entry = byId.get(id);
    if (!entry) continue; // 插件被删了，或还没进索引（build-index 先跑就有了）
    const prTag = `PR #${pr.number}`;

    // author：只在缺失时填，且不把维护者写成社区作者
    if (!entry.author && pr.login && !MAINTAINERS.has(pr.login)) {
      entry.author = pr.login;
      changed += 1;
    }
    // contributors：结构化署名，{login, pr} 成对存。生成器按这里对号入座——
    // 不能从 credits 的自由文本里全局抽 PR 号，否则 alice 首发 + bob 升级时
    // 两个 PR 都会记到 author(alice) 头上。credits 只是人读的说明，不是数据源。
    if (!Array.isArray(entry.contributors)) {
      // 存量迁移：首次写 contributors 时，先用已有 author + credits 把历史
      // 贡献预填进去。否则一个存量插件被新 PR 更新后 contributors 只有新作者，
      // 首发署名和早期 PR 会全部消失（维护者更新社区插件时甚至整行不见）。
      entry.contributors = [];
      const oldAuthor = String(entry.author ?? '').trim();
      if (oldAuthor && !MAINTAINERS.has(oldAuthor)) {
        for (const m of String(entry.credits ?? '').matchAll(/PR\s*#(\d+)/g)) {
          const oldPr = Number(m[1]);
          if (Number.isInteger(oldPr) && oldPr > 0) {
            entry.contributors.push({ login: oldAuthor, pr: oldPr });
          }
        }
        // credits 里没有 PR 号时也要保住署名：无 pr 的条目生成器会显示名字但不给链接
        if (entry.contributors.length === 0) entry.contributors.push({ login: oldAuthor });
        changed += 1;
      }
    }
    if (!entry.contributors.some((c) => c.pr === pr.number)) {
      entry.contributors.push({ login: pr.login, pr: pr.number });
      changed += 1;
    }
    // credits：追加 PR 号，保留已有说明（给人看的，不参与生成）
    if (!String(entry.credits ?? '').includes(prTag)) {
      const note = pr.login && !MAINTAINERS.has(pr.login)
        ? `插件由 @${pr.login} 提交（${prTag}）`
        : `由维护者在 ${prTag} 更新`;
      entry.credits = [entry.credits, note].filter(Boolean).join('；');
      changed += 1;
    }
    // addedAt：首次收录日期，已有就不动
    if (!entry.addedAt) {
      entry.addedAt = today;
      changed += 1;
    }
  }
}

if (changed === 0) {
  console.log(`enrich: ${prs.size} 个 PR 的署名字段已是最新`);
  process.exit(0);
}
await fs.writeFile(INDEX, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
console.log(`enrich: 从 ${prs.size} 个 PR 补了 ${changed} 个字段`);

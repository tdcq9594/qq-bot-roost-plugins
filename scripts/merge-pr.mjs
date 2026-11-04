#!/usr/bin/env node
/**
 * 收外部 PR：拉分支、把提交身份改回真正的作者、merge 进 main。
 * ============================================================
 *
 *   node scripts/merge-pr.mjs 2              # 真合并
 *   node scripts/merge-pr.mjs 2 --dry-run    # 只演一遍，不动仓库
 *
 * 为什么要有这一步
 * ----------------
 * 贡献者常在自己机器上带着**别人的 git 身份**提交（照抄了 `user.email`、
 * 或者用共享的开发机）。GitHub 的 Contributors 是按 commit 的 **author 邮箱**
 * 归户的：身份写错，这次贡献就记到邮箱主人头上，作者本人在仓库里一次提交都没有。
 *
 * 2026-11-04 的 PR #2 就是这样：PR 由 `haibiandefengshu` 发起，
 * 但 commit 的 author 是 `jfzn <tdcq9594@users.noreply.github.com>`，
 * 结果 Contributors 里只有维护者。索引的 `credits` 能补署名，头像墙补不了，
 * 只能从提交本身改——所以合并时统一校正成「PR 发起人」的身份。
 *
 * 2026-11-04 之前的做法是 `git checkout FETCH_HEAD -- plugins/<id>`：
 * 只取目录、不留历史。那样确实干净，但作者的 commit 也一起没了。
 *
 * 边界
 * ----
 * 只做「拉 + 校正身份 + merge」。**不 push、不重建索引、不签名**——
 * 那些要私钥、要人工补 credits，见 README「维护者发版完整流程」。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = 'tdcq9594/qq-bot-roost-plugins';

/** 这三个文件出现任何改动都直接中止：签名链是维护者独占的 */
const FORBIDDEN = ['index.json', 'index.json.sig', 'trust-public.pem'];

const argv = process.argv.slice(2);
const num = argv.find((a) => /^\d+$/.test(a));
const dryRun = argv.includes('--dry-run');

if (!num) {
  console.error('用法：node scripts/merge-pr.mjs <PR号> [--dry-run]');
  process.exit(1);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const say = (...a) => console.log(...a);

/* ---------------- 前置检查 ---------------- */

const dirty = git('status', '--porcelain');
if (dirty) {
  console.error('✗ 工作区有未提交的改动，先处理掉再合并：\n' + dirty);
  process.exit(1);
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') {
  console.error(`✗ 当前在 ${branch}，合并要在 main 上做。`);
  process.exit(1);
}

/* ---------------- 读 PR ---------------- */

const pr = await fetch(`https://api.github.com/repos/${REPO}/pulls/${num}`, {
  headers: { 'user-agent': 'roost-merge-pr', accept: 'application/vnd.github+json' },
}).then((r) => r.json());

if (!pr?.number) {
  console.error(`✗ 读不到 PR #${num}：${pr?.message ?? '未知错误'}`);
  process.exit(1);
}
if (pr.state !== 'open' && !dryRun) {
  console.error(`✗ PR #${num} 是 ${pr.state}${pr.merged ? '（已合并）' : ''}，不重复合并。`);
  process.exit(1);
}

const login = pr.user.login;
const uid = pr.user.id;
/** GitHub 的 noreply 地址：带上账号 id 才能稳定归户（老账号没有 id 前缀也认） */
const email = `${uid}+${login}@users.noreply.github.com`;
const authorIsRight = (e) => String(e).includes(login);

say(`PR #${num}：${pr.title}`);
say(`  作者      ${login} <${email}>`);
say(`  分支      ${pr.head.label} → ${pr.base.ref}`);
say(`  提交数    ${pr.commits}  |  改动 ${pr.changed_files} 个文件 +${pr.additions}/-${pr.deletions}`);

/* ---------------- 敏感文件检查（红线） ---------------- */

const files = await fetch(`https://api.github.com/repos/${REPO}/pulls/${num}/files?per_page=100`, {
  headers: { 'user-agent': 'roost-merge-pr', accept: 'application/vnd.github+json' },
}).then((r) => r.json());

if (Array.isArray(files)) {
  const bad = files.map((f) => f.filename).filter((f) => FORBIDDEN.includes(f));
  if (bad.length) {
    console.error(`\n✗ 这个 PR 动了签名链文件：${bad.join(', ')}`);
    console.error('  按 README「签名与信任链」，这类改动一律不收，先和作者确认意图。');
    process.exit(1);
  }
}

/* ---------------- 拉分支 + 校正身份 ---------------- */

say('\n拉取 PR 分支…');
// dry-run 也拉：不拉到本地就没法算要重建哪些提交。只建 refs/heads/pr-N，不碰 main。
git('fetch', 'origin', `refs/pull/${num}/head:refs/heads/pr-${num}`, '--force');

const base = git('merge-base', 'HEAD', `pr-${num}`);
const shas = git('rev-list', '--reverse', `${base}..pr-${num}`).split('\n').filter(Boolean);
if (!shas.length) {
  console.error(`✗ PR #${num} 相对 main 没有任何新提交（可能已被收进 main）。`);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-pr-'));
let parent = base;
const rebuilt = [];

for (const [i, sha] of shas.entries()) {
  const [an, ae, ad, cn, ce, cd] = git(
    'log', '-1', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI', sha,
  ).split('\0');
  const tree = git('rev-parse', `${sha}^{tree}`);
  const msgFile = path.join(tmp, `m${i}.txt`);
  // %B 末尾可能已经带空行；统一收敛成一个结尾换行，否则重建出的提交和原提交
  // 内容不一致（多一行空白），SHA 也会跟着变
  const body = git('log', '-1', '--format=%B', sha).replace(/\n+$/, '');
  fs.writeFileSync(msgFile, `${body}\n`, 'utf8');

  const keepAuthor = authorIsRight(ae);
  const keepCommitter = authorIsRight(ce);
  const subject = git('log', '-1', '--format=%s', sha);

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: keepAuthor ? an : login,
    GIT_AUTHOR_EMAIL: keepAuthor ? ae : email,
    GIT_AUTHOR_DATE: ad,
    GIT_COMMITTER_NAME: keepCommitter ? cn : login,
    GIT_COMMITTER_EMAIL: keepCommitter ? ce : email,
    GIT_COMMITTER_DATE: cd,
  };
  const env2 = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)]));

  const made = execFileSync('git', ['commit-tree', tree, '-p', parent, '-F', msgFile], {
    encoding: 'utf8',
    env: env2,
  }).trim();

  const flag = keepAuthor ? '身份已正确，原样保留' : `身份校正 ${ae} → ${email}`;
  say(`  ${sha.slice(0, 8)} → ${made.slice(0, 8)}  ${subject}`);
  say(`             ${flag}`);
  rebuilt.push(made);
  parent = made;
}

const newHead = parent;

/* ---------------- merge ---------------- */

const mergeMsg =
  `merge: ${pr.title}（PR #${num}）\n\n` +
  `来自 @${login} 的投稿，提交身份已校正为作者本人。索引由维护者重建。`;

if (dryRun) {
  say(`\n[dry-run] 会把 ${newHead.slice(0, 8)} 以 --no-ff 合进 main，不写任何东西。`);
  process.exit(0);
}

git('merge', '--no-ff', newHead, '-m', mergeMsg);
say(`\n✓ 已合并：${git('rev-parse', '--short', 'HEAD')}`);

/* ---------------- 后续步骤提示 ---------------- */

say(`
下一步（都要人工做，脚本不碰）：
  1. 过一遍代码：node --check plugins/<id>/index.js
  2. 重建索引 + 签名：
       node scripts/build-index.mjs --key ../bot/keys/trust-private.pem
  3. 在 index.json 里补 author / credits / addedAt / tags（脚本不覆盖这些字段）
  4. 重新签名（改过 index.json 必须重签）：
       node scripts/sign-index.mjs --key ../bot/keys/trust-private.pem
  5. 验：node scripts/build-index.mjs --check && node scripts/sign-index.mjs --verify --key trust-public.pem
  6. 推：git push origin main（Gitee 见 README 第 6 步）
`);

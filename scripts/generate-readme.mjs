#!/usr/bin/env node
/**
 * 从 index.json 生成 README 的贡献者表
 * ====================================
 *
 *   node scripts/generate-readme.mjs          # 重写标记之间的表格
 *   node scripts/generate-readme.mjs --check  # 只校验，不写（CI 用）
 *
 * README 大部分是手写的说明文档，只有「贡献者」这一段是数据的投影：
 * 每个社区投稿对应 index.json 里的一条，署名（author）和 PR 号（credits）
 * 都已经在索引里。手改这段的后果和手改 index.json 一样——合并一次就把
 * 别人的行撞掉，所以这里让它成为生成物。
 *
 * 用标记（GENERATED: contributors）而不是整份生成：脚本只碰两个标记之间
 * 的内容，外面的说明文字、标题、许可段落保持手写。标记缺失时直接报错，
 * 避免「悄悄什么都没做」——那会让 CI 以为表格是最新的。
 *
 * 排序规则固定（按作者首字母、插件 id、PR 号），保证同样的数据永远产出
 * 同样的字节，bot 才不会因为顺序抖动反复提交。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INDEX = path.join(ROOT, 'index.json');
const README = path.join(ROOT, 'README.md');
const REPO = 'tdcq9594/qq-bot-roost-plugins';

/** 维护者自己写的插件不进投稿贡献者表（那张表是给社区投稿作者署名的）。 */
const MAINTAINERS = new Set(['tdcq9594']);

const BEGIN = '<!-- BEGIN GENERATED: contributors -->';
const END = '<!-- END GENERATED: contributors -->';

const checkOnly = process.argv.includes('--check');

function buildTable(plugins) {
  const byAuthor = new Map();
  const rowFor = (login) => {
    if (!byAuthor.has(login)) byAuthor.set(login, { plugins: new Set(), prs: new Set() });
    return byAuthor.get(login);
  };

  for (const p of plugins) {
    const label = { id: p.id, name: String(p.name ?? p.id) };
    // 首选结构化署名：{login, pr} 精确成对，多作者改同一插件也不会串。
    // 由 enrich-index.mjs 在合并后写入。
    if (Array.isArray(p.contributors) && p.contributors.length > 0) {
      const covered = new Set();
      for (const c of p.contributors) {
        const login = String(c?.login ?? '').trim();
        const pr = Number(c?.pr);
        const validPr = Number.isInteger(pr) && pr > 0;
        // 即使是不该出现的 maintainer 条目，它的 PR 号也要进 covered——
        // 否则兜底逻辑会把维护者的 PR 从 credits 里捞出来塞给社区作者。
        if (validPr) covered.add(pr);
        if (!login || MAINTAINERS.has(login)) continue;
        const row = rowFor(login);
        row.plugins.add(label);
        if (validPr) row.prs.add(pr);
      }
      // 兜底：contributors 只记了最近的 PR 时（规范上线前的存量条目被更新），
      // author + credits 里的历史 PR 还没被覆盖，补到 author 名下，别丢署名。
      // 已被 contributors 精确归属的 PR 不重复计入，避免串到别人头上。
      const author = String(p.author ?? '').trim();
      if (author && !MAINTAINERS.has(author)) {
        const row = rowFor(author);
        row.plugins.add(label);
        for (const m of String(p.credits ?? '').matchAll(/PR\s*#(\d+)/g)) {
          const pr = Number(m[1]);
          if (pr > 0 && !covered.has(pr)) row.prs.add(pr);
        }
      }
      continue;
    }
    // 回退：存量条目还没有 contributors（enum 上线前收录的），
    // 只能从 author + credits 抽。这种情况下多作者会被记到 author 头上，
    // 但下次该插件被 PR 更新时 enrich 会写入 contributors，自动纠正。
    const author = String(p.author ?? '').trim();
    if (!author || MAINTAINERS.has(author)) continue;
    const row = rowFor(author);
    row.plugins.add(label);
    for (const m of String(p.credits ?? '').matchAll(/PR\s*#(\d+)/g)) row.prs.add(Number(m[1]));
  }

  const lines = ['| 贡献者 | 插件 | 提交 |', '|---|---|---|'];
  const authors = [...byAuthor.keys()].sort((a, b) => a.localeCompare(b));
  for (const author of authors) {
    const { plugins: own, prs } = byAuthor.get(author);
    const pluginText = [...own]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => `\`${p.id}\`（${p.name}）`)
      .join('、');
    const prText = [...prs].sort((a, b) => a - b)
      .map((n) => `[PR #${n}](https://github.com/${REPO}/pull/${n})`)
      .join('、');
    lines.push(`| [@${author}](https://github.com/${author}) | ${pluginText} | ${prText} |`);
  }
  return lines.join('\n');
}

const index = JSON.parse(await fs.readFile(INDEX, 'utf8'));
const table = buildTable(index.plugins ?? []);
const readme = await fs.readFile(README, 'utf8');

const beginAt = readme.indexOf(BEGIN);
const endAt = readme.indexOf(END);
if (beginAt === -1 || endAt === -1 || endAt < beginAt) {
  throw new Error(`README.md 缺少 ${BEGIN} / ${END} 标记，拒绝生成（避免静默跳过）`);
}

const before = readme.slice(0, beginAt + BEGIN.length);
const after = readme.slice(endAt);
const next = `${before}\n${table}\n${after}`;

if (next === readme) {
  console.log(`✓ 贡献者表已最新（${index.plugins?.length ?? 0} 个插件）`);
  process.exit(0);
}
if (checkOnly) {
  console.error('✗ 贡献者表与 index.json 不一致，跑 node scripts/generate-readme.mjs');
  process.exit(1);
}
await fs.writeFile(README, next, 'utf8');
console.log(`已更新 README.md 贡献者表（${index.plugins?.length ?? 0} 个插件）`);

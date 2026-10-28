/**
 * 内容安全检查
 * ============
 *
 *   node plugins/douluo/scripts/check-content.mjs           # 只报告
 *   node plugins/douluo/scripts/check-content.mjs --strict   # 有命中就退出码 1（CI 用）
 *
 * 为什么要有这个脚本：
 * 内容包是从第三方 INI 导入的，原作者的命名习惯不可控。
 * 真机联调时在群里的魂兽列表上直接看到了粗俗和民族敏感词——
 * 这种内容上线一次就够封号了，必须在上线前挡住。
 *
 * 检查两类：
 *   1. **敏感/粗俗词**（政治、民族、脏话）—— 命中就一定要改
 *   2. **可疑内容**（纯符号、超长、空名）—— 提示但不拦截
 *
 * 输出**不打印命中词本身**，只报表/ID/类别，避免脚本日志二次传播。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { openDbs } = await import(pathToFileURL(path.join(HERE, '..', 'src', 'db', 'open.js')).href);

const STRICT = process.argv.includes('--strict');

/**
 * 敏感词表。
 * 分两类：**硬拦截**（政治/民族/脏话，必须改）和**软提示**（看着不雅但不一定违规）。
 * 运营可以往 `sensitive-extra.txt` 里加自己的词（一行一个）。
 */
const HARD = [
  // 民族 / 政治（这类一律不能出现）
  '日本鬼子', '鬼子', '支那', '东亚病夫',
  '台独', '港独', '藏独', '疆独', '法轮', '六四',
  // 脏话 / 侮辱
  '傻逼', '煞笔', '傻B', '傻b', '狗日', '操你', '草你', '干你',
  '他妈', '尼玛', '你妈', '妈的', '婊子', '贱人', '妓女', '嫖',
];

const SOFT = ['垃圾', '废物', '去死', '滚蛋', '智障', '脑残', '白痴'];

const extraFile = path.join(HERE, 'sensitive-extra.txt');
if (fs.existsSync(extraFile)) {
  for (const line of fs.readFileSync(extraFile, 'utf8').split('\n')) {
    const w = line.trim();
    if (w && !w.startsWith('#')) HARD.push(w);
  }
}

const TABLES = [
  'wuhun', 'map', 'monster', 'npc', 'item', 'equip', 'equip_set', 'companion',
  'skill', 'quest', 'title', 'gem', 'aptitude', 'challenge', 'tutorial',
  'recipe', 'profession', 'shop', 'status_def', 'alchemy_tool', 'hidden_weapon',
  'wuhun_series', 'challenge_floor', 'signin_reward', 'rank_def', 'territory_def',
];

const DATA_DIR = path.join(os.tmpdir(), 'douluo-content-check');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
const { content } = openDbs(DATA_DIR, { seed: true });

const hard = [];
const soft = [];
const weird = [];

for (const t of TABLES) {
  let rows = [];
  try {
    rows = content.prepare(`SELECT id, name FROM ${t}`).all();
  } catch {
    continue;
  }
  for (const r of rows) {
    const name = String(r.name ?? '');
    if (!name.trim()) {
      weird.push({ table: t, id: r.id, why: '空名字' });
      continue;
    }
    if (name.length > 24) weird.push({ table: t, id: r.id, why: `名字过长（${name.length} 字）` });
    if (!/[\u4e00-\u9fa5A-Za-z0-9·\-—]/.test(name)) weird.push({ table: t, id: r.id, why: '没有可读字符' });

    const h = HARD.find((w) => name.includes(w));
    if (h) {
      hard.push({ table: t, id: r.id, word: h });
      continue;
    }
    const s = SOFT.find((w) => name.includes(w));
    if (s) soft.push({ table: t, id: r.id, word: s });
  }
}

console.log('=== 内容安全检查 ===');
console.log(`扫描 ${TABLES.length} 张表\n`);

if (hard.length) {
  console.log(`✗ 硬拦截命中 ${hard.length} 条（必须改）：`);
  for (const h of hard) console.log(`  ${h.table}#${h.id} · 含敏感词「${h.word}」`);
} else {
  console.log('✓ 没有敏感/粗俗词');
}

if (soft.length) {
  console.log(`\n⚠ 不雅提示 ${soft.length} 条（建议改）：`);
  for (const s of soft) console.log(`  ${s.table}#${s.id} · 含「${s.word}」`);
}

if (weird.length) {
  console.log(`\n⚠ 可疑命名 ${weird.length} 条：`);
  for (const w of weird.slice(0, 20)) console.log(`  ${w.table}#${w.id} · ${w.why}`);
}

const bad = hard.length;
console.log(`\n${bad === 0 ? '通过' : '不通过'}：硬拦截 ${hard.length} · 不雅 ${soft.length} · 可疑 ${weird.length}`);
process.exit(STRICT && bad > 0 ? 1 : 0);

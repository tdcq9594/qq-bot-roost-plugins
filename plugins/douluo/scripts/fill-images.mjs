/**
 * 图片自动匹配 / 生成
 * ===================
 *
 *   node plugins/douluo/scripts/fill-images.mjs --bot main --dry     # 看覆盖率
 *   node plugins/douluo/scripts/fill-images.mjs --bot main --fetch   # 生成并下载到本地
 *   node plugins/douluo/scripts/fill-images.mjs --src D:/art         # 用现成美术资源
 *
 * 内容表的 `image` 列只认两种值（见 `src/cmd/media.js`）：
 *   1. `https://…`        → 远程图
 *   2. `wuhun/xxx.png`    → 本地图，相对**该机器人**的 `images/` 目录
 *
 * 三种补图方式，按优先级：
 *   `--src`   扫描本地图库，按名字模糊匹配（有美术资源时用这个）
 *   `--fetch` 从模板下载成**本地文件**（没资源时的兜底）
 *   `--url`   直接写远程 URL（不推荐：QQ 每次都要去下载，服务挂了图就没了）
 *
 * 为什么 `--fetch` 优于 `--url`：图存在本地，QQ 上传的是文件，
 * 不依赖第三方服务长期在线，也不受对方限流影响。
 *
 * 匹配规则（从严格到宽松）：
 *   1. 文件名（去扩展名）完全等于内容名
 *   2. 文件名包含内容名，或内容名包含文件名
 *   3. 去掉「·」「-」「_」「空格」后相等
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const { openDbs } = await import(pathToFileURL(path.join(HERE, '..', 'src', 'db', 'open.js')).href);

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const SRC = arg('--src', '');
const BOT = arg('--bot', 'main');
const DRY = argv.includes('--dry');
const FETCH = argv.includes('--fetch');
const URL_MODE = argv.includes('--url');
const LIMIT = Number(arg('--limit', '0')) || 0;

/** 每类内容的配色（背景 / 前景），让不同系统一眼能分开 */
const STYLE = {
  wuhun: { bg: '2a1a4a', fg: 'e8c46a' }, // 紫金
  map: { bg: '14332e', fg: '9fe8c9' }, // 青绿
  monster: { bg: '3a1414', fg: 'ffb38a' }, // 暗红
  equip: { bg: '1a2438', fg: 'c9d6e8' }, // 钢蓝
  npc: { bg: '33241a', fg: 'e8d5b7' }, // 暖褐
};

const TARGETS = [
  { table: 'wuhun', label: '武魂' },
  { table: 'map', label: '地图' },
  { table: 'monster', label: '魂兽' },
  { table: 'equip', label: '装备' },
  { table: 'npc', label: 'NPC' },
];

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const norm = (s) => String(s ?? '').replace(/[·\-_\s]/g, '').toLowerCase();

function scanDir(dir) {
  const out = [];
  const walk = (d) => {
    let list = [];
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (IMG_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function matchFile(name, files) {
  const n = norm(name);
  let best = null;
  for (const f of files) {
    const base = norm(path.basename(f, path.extname(f)));
    if (base === n) return { file: f, score: 3 };
    if (base.includes(n) || n.includes(base)) {
      if (!best || base.length < norm(path.basename(best, path.extname(best))).length) best = { file: f, score: 2 };
    }
  }
  return best;
}

/* ---------------- 主流程 ---------------- */

const DATA_DIR = path.join(ROOT, 'data', 'bots', BOT, 'plugins', 'douluo');
if (!fs.existsSync(DATA_DIR)) {
  console.error(`✗ 找不到机器人数据目录：${DATA_DIR}\n  先启动一次机器人（node src/main.js），或换 --bot <id>`);
  process.exit(1);
}

const { content } = openDbs(DATA_DIR, { seed: true });
const imgDir = path.join(DATA_DIR, 'images');
fs.mkdirSync(imgDir, { recursive: true });

const files = SRC ? scanDir(SRC) : [];
if (SRC && !files.length) console.log(`⚠ 在 ${SRC} 里没找到图片（支持 ${[...IMG_EXT].join(' / ')}）`);

let filledLocal = 0;
let filledFetch = 0;
let filledUrl = 0;
let already = 0;
const missing = [];
const failed = [];

for (const t of TARGETS) {
  const rows = content.prepare(`SELECT id, name, image FROM ${t.table} WHERE enabled = 1 ORDER BY id`).all();
  let local = 0;
  let fetched = 0;
  let remote = 0;
  let have = 0;
  const gap = [];
  const style = STYLE[t.table] ?? { bg: '1a1a2e', fg: 'e8c46a' };

  for (const r of rows) {
    const cur = String(r.image ?? '').trim();
    if (cur) {
      // 已有值：相对路径但文件不在 → 视为失效，重新补
      const isLocal = !/^https?:\/\//i.test(cur);
      if (isLocal && !fs.existsSync(path.join(imgDir, cur))) {
        if (DRY) {
          gap.push(r.name);
          continue;
        }
        content.prepare(`UPDATE ${t.table} SET image = '' WHERE id = ?`).run(r.id);
      } else {
        have += 1;
        already += 1;
        continue;
      }
    }
    if (LIMIT && local + fetched + remote >= LIMIT) {
      gap.push(r.name);
      continue;
    }

    // 1) 本地图库匹配
    if (files.length) {
      const hit = matchFile(r.name, files);
      if (hit) {
        const destDir = path.join(imgDir, t.table);
        fs.mkdirSync(destDir, { recursive: true });
        const destName = `${r.id}${path.extname(hit.file).toLowerCase()}`;
        if (!DRY) {
          try {
            fs.copyFileSync(hit.file, path.join(destDir, destName));
            content.prepare(`UPDATE ${t.table} SET image = ? WHERE id = ?`).run(`${t.table}/${destName}`, r.id);
          } catch (e) {
            failed.push(`${t.label}/${r.name}: ${e.message}`);
            continue;
          }
        }
        local += 1;
        filledLocal += 1;
        continue;
      }
    }

    const url =
      `https://ui-avatars.com/api/?name=${encodeURIComponent(r.name)}` +
      `&size=512&background=${style.bg}&color=${style.fg}&font-size=0.3&bold=true`;

    // 2) 下载到本地（推荐）
    if (FETCH) {
      if (DRY) {
        fetched += 1;
        filledFetch += 1;
        continue;
      }
      try {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 12_000);
        const res = await fetch(url, { signal: ac.signal });
        clearTimeout(to);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 200) throw new Error('图太小，可能不是图片');
        const destDir = path.join(imgDir, t.table);
        fs.mkdirSync(destDir, { recursive: true });
        const destName = `${r.id}.png`;
        fs.writeFileSync(path.join(destDir, destName), buf);
        content.prepare(`UPDATE ${t.table} SET image = ? WHERE id = ?`).run(`${t.table}/${destName}`, r.id);
        fetched += 1;
        filledFetch += 1;
      } catch (e) {
        failed.push(`${t.label}/${r.name}: ${e.message}`);
        gap.push(r.name);
      }
      continue;
    }

    // 3) 直接写远程 URL（兜底，不推荐）
    if (URL_MODE) {
      if (!DRY) content.prepare(`UPDATE ${t.table} SET image = ? WHERE id = ?`).run(url, r.id);
      remote += 1;
      filledUrl += 1;
      continue;
    }

    gap.push(r.name);
    missing.push(`${t.label}/${r.name}`);
  }

  const total = rows.length;
  const cover = total ? Math.round(((have + local + fetched + remote) / total) * 100) : 100;
  console.log(
    `${t.label.padEnd(4)} ${String(total).padStart(3)} 条 · 已有 ${String(have).padStart(3)} · 匹配 ${String(local).padStart(3)} · 下载 ${String(fetched).padStart(3)} · 覆盖 ${cover}%`,
  );
  if (gap.length && gap.length <= 5) console.log(`      缺：${gap.join(' / ')}`);
  else if (gap.length) console.log(`      缺 ${gap.length} 条，例如 ${gap.slice(0, 5).join(' / ')}`);
}

console.log(`\n合计：本地匹配 ${filledLocal} · 下载 ${filledFetch} · 远程URL ${filledUrl} · 原本就有 ${already}${DRY ? '（dry，未写库）' : ''}`);
if (failed.length) {
  console.log(`\n失败 ${failed.length} 条：`);
  for (const f of failed.slice(0, 8)) console.log(`  ${f}`);
}
if (missing.length && !FETCH && !URL_MODE) {
  console.log(`\n还差 ${missing.length} 条没图。`);
  console.log('  1. 有美术资源：--src <目录>（文件名含内容名即可）');
  console.log('  2. 没有资源：--fetch（生成占位图并下载到本地，之后可逐张替换）');
}
console.log(`\n图片目录：${imgDir}`);

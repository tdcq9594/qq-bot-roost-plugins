/**
 * 菜单覆盖检查
 * ============
 *
 *   node scripts/check-menu.mjs
 *
 * 对比「所有已注册的指令」和「菜单/帮助里出现过的指令」，
 * 找出没进菜单的——新加指令最容易漏这一步，玩家就永远看不到它。
 *
 * 菜单结构是从源码文本里抠的（`{ text: ..., cmd: P('xxx') }` 和帮助的
 * `['分组', ['a','b']]`），因为菜单是闭包里的局部变量，运行时拿不到。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src', 'cmd', 'handlers.js');
const txt = fs.readFileSync(SRC, 'utf8');

// 1. 所有注册的指令：H['xxx'] = {
const verbs = [...txt.matchAll(/^  H\['([^']+)'\] = /gm)].map((m) => m[1]);
const uniqVerbs = [...new Set(verbs)];

// 2. 菜单里出现的：cmd: P('xxx')
const menu = new Set([
  ...[...txt.matchAll(/cmd: P\('([^']+)'\)/g)].map((m) => m[1]),
  // 菜单用 it('名字') 简写，也要认
  ...[...txt.matchAll(/\bit\('([^']+)'/g)].map((m) => m[1]),
]);

// 3. 帮助分组里出现的：['分组', ['a', 'b', ...]]
const help = new Set();
for (const m of txt.matchAll(/\['[^']+', \[([^\]]+)\]\]/g)) {
  for (const w of m[1].matchAll(/'([^']+)'/g)) help.add(w[1]);
}

// 隐藏指令（旧名别名之类）不算漏
const hidden = new Set([
  '开始穿越',   // 旧名别名
  '斗罗菜单',   // 菜单本身就是入口
  '试打',       // 内部调试指令
]);

const inMenu = uniqVerbs.filter((v) => menu.has(v));
const inHelp = uniqVerbs.filter((v) => help.has(v));
const missing = uniqVerbs.filter((v) => !menu.has(v) && !help.has(v) && !hidden.has(v));
const menuOnly = [...menu].filter((v) => !uniqVerbs.includes(v));
const helpOnly = [...help].filter((v) => !uniqVerbs.includes(v));

console.log(`指令总数 ${uniqVerbs.length}`);
console.log(`  进菜单 ${inMenu.length} · 进帮助 ${inHelp.length}`);
console.log(`\n没进菜单也没进帮助（${missing.length}）：`);
for (const v of missing) console.log(`  - ${v}`);
if (menuOnly.length) {
  console.log(`\n菜单里有但没实现的（${menuOnly.length}）：`);
  console.log('  ' + menuOnly.join(' / '));
}
if (helpOnly.length) {
  console.log(`\n帮助里有但没实现的（${helpOnly.length}）：`);
  console.log('  ' + helpOnly.join(' / '));
}
process.exit(missing.length || menuOnly.length || helpOnly.length ? 1 : 0);

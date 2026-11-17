/**
 * 扩展契约：清单 / 运行时 / 索引 三方必须说同一个数。
 *
 * 为什么要有这条：
 *
 * 1. bili 的 `server.mjs` 曾把版本写死成 `0.11.7`，而清单早就是 `0.11.8`。
 *    扩展判更新走 sha256，所以发版不受影响，漂移能一直潜伏——面板和宿主
 *    显示的是 `serverInfo` 里的那个数，用户看到的版本和他实际装的对不上，
 *    直到有人去翻握手日志才发现。
 * 2. `plugins/imagegen/test/ui-actions.mjs` 里有同样的断言，但那只管
 *    imagegen 自己；bili 的 smoke 只断言了 `serverInfo.name`，从没比过版本。
 *    每个扩展各写一份就是这个问题——漏掉一个就漏一整类。
 * 3. 所以这里跑**全部**扩展：真的拉起 server.mjs、走标准 MCP 握手，
 *    而不是 grep 源码里的字面量（那样只对写死版本的扩展有效）。
 *
 * 顺带守两件同类的事：
 *   - `tools/list` 至少能回一个工具（握手通了但工具表炸掉，面板是空的）
 *   - 每个插件都有主分类，`categories.json` 与 `plugins/` 双向对齐
 *
 * 跑法：node test/ext-contract.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'index.json'), 'utf8'));
const rows = index.plugins ?? [];

const manifestOf = (id) => {
  const p = path.join(ROOT, 'plugins', id, 'plugin.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};

const extIds = fs
  .readdirSync(path.join(ROOT, 'plugins'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((id) => manifestOf(id)?.kind === 'dsh-extension');

/**
 * 拉起一个扩展，走标准 MCP 握手 + tools/list。
 *
 * 用 `initialize` 而不是 `--list`：`persona-scope-ext` / `persona-grow`
 * 根本没有 `--list` 这个口，拿它当通用冒烟会直接挂到超时。
 */
function probe(id) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'plugins', id, 'server.mjs')], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const waiting = new Map();
    let buf = '';
    let settled = false;

    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      try { child.kill(); } catch { /* 已退出 */ }
      resolve(v);
    };
    /** 整个会话的总闸：某个扩展卡住不能拖死整个测试文件 */
    const hard = setTimeout(() => finish({ error: '整个握手超过 20s' }), 20000);

    const ask = (msg) =>
      new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`${msg.method} 无响应`)), 12000);
        waiting.set(msg.id, (m) => { clearTimeout(t); res(m); });
        child.stdin.write(`${JSON.stringify(msg)}\n`);
      });

    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const cb = waiting.get(msg.id);
        if (cb) { waiting.delete(msg.id); cb(msg); }
      }
    });
    child.stderr.on('data', () => { /* 日志全走 stderr，忽略 */ });
    child.on('exit', (code) => finish({ error: `进程提前退出（code ${code}）` }));
    child.on('error', (e) => finish({ error: `起不来：${e.message}` }));

    (async () => {
      const init = await ask({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'contract', version: '0' } },
      });
      const tools = await ask({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      finish({ init, tools });
    })().catch((e) => finish({ error: e.message }));
  });
}

for (const id of extIds) {
  test(`${id}：真起得来，且清单 / 运行时 / 索引 三方版本一致`, async () => {
    const m = manifestOf(id);
    const row = rows.find((r) => r.id === id);
    assert.ok(row, `${id} 在 index.json 里没有条目，重跑 build-index.mjs`);
    assert.equal(row.version, m.version, `${id}：索引版本 ${row.version} ≠ 清单 ${m.version}`);
    assert.match(String(row.sha256 ?? ''), /^[0-9a-f]{64}$/, `${id}：索引 sha256 不是 64 位小写十六进制`);

    const r = await probe(id);
    assert.ok(!r.error, `${id}：${r.error}`);

    const si = r.init?.result?.serverInfo ?? {};
    assert.equal(si.name, m.id, `${id}：serverInfo.name 是 ${si.name}，清单 id 是 ${m.id}`);
    assert.equal(
      String(si.version), String(m.version),
      `${id}：运行时自报 ${si.version}，清单是 ${m.version}。版本要以 plugin.json 为唯一真相，别在代码里写死`,
    );

    const list = r.tools?.result?.tools;
    assert.ok(Array.isArray(list) && list.length > 0, `${id}：tools/list 没回工具（握手通了但工具表是空的）`);
  });
}

test('每个插件都有主分类，且 categories.json 与 plugins/ 双向对齐', () => {
  const cats = JSON.parse(fs.readFileSync(path.join(ROOT, 'categories.json'), 'utf8'));
  const map = new Map(Object.entries(cats).filter(([k]) => !k.startsWith('_')));

  for (const row of rows) {
    assert.ok(map.has(row.id), `${row.id} 没在 categories.json 里，市场会退回用第一个 tag 当分类`);
    assert.ok(String(row.category ?? '').trim(), `${row.id} 的索引条目没有 category，重跑 build-index.mjs`);
    assert.equal(row.category, map.get(row.id), `${row.id} 的索引分类与 categories.json 不一致`);
  }
  for (const id of map.keys()) {
    assert.ok(rows.some((r) => r.id === id), `categories.json 里的 ${id} 已经不在 plugins/ 下`);
  }
});

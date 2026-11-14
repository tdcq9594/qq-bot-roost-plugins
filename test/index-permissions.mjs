/**
 * 市场索引只存「权限原始声明」，不存等级。
 *
 * 2026-11-14：主人要求「扩展分级，按需要的权限等级明确告知风险」。
 * 等级由宿主 `dsh-roost/src/ext-tier.js` 从索引里的 scopes / overrides / form
 * **实时推导**——索引一旦允许作者自填 `permissionTier`，签名的只是一句
 * 自证，装之前看到的风险提示就形同虚设。
 *
 * 这几条守住：声明进索引、改了清单要重建索引（--check 会拦）、索引里
 * 不存在任何可被作者虚标的等级字段。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'index.json'), 'utf8'));
const rows = index.plugins ?? [];

function manifestOf(id) {
  const p = path.join(ROOT, 'plugins', id, 'plugin.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('索引里每个扩展的 scopes 与 plugin.json 逐项一致', () => {
  let checked = 0;
  for (const row of rows.filter((r) => r.kind === 'dsh-extension')) {
    const m = manifestOf(row.id);
    if (!m) continue;
    checked += 1;
    const want = Array.isArray(m.scopes) ? m.scopes.map(String) : [];
    assert.deepEqual(row.scopes ?? [], want, `${row.id} 的 scopes 与清单不一致，重跑 build-index.mjs`);
    if (Array.isArray(m.overrides)) {
      assert.deepEqual(row.overrides ?? [], m.overrides.map(String), `${row.id} 的 overrides 不一致`);
    }
    if (typeof m.form === 'string' && m.form) {
      assert.equal(row.form, m.form, `${row.id} 的 form 不一致`);
    }
  }
  assert.ok(checked > 0, '至少要有一个扩展可校验，否则这份测试形同虚设');
});

test('索引里不允许出现等级字段（作者不能自填，防虚标）', () => {
  for (const row of rows) {
    for (const key of ['permissionTier', 'riskLevel', 'tier', 'level', 'risk']) {
      assert.equal(Object.hasOwn(row, key), false, `${row.id} 不该带 ${key}，等级由宿主实时推导`);
    }
  }
});

test('build-index.mjs 把 scopes/overrides/form 纳入结构字段与 --check', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'build-index.mjs'), 'utf8');
  assert.match(src, /raw\.scopes/, 'readMeta 必须读清单的 scopes');
  assert.match(src, /raw\.overrides/, 'readMeta 必须读清单的 overrides');
  for (const key of ['scopes', 'overrides', 'form']) {
    assert.match(src, new RegExp(`'${key}'`), `STRUCT_FIELDS 要包含 ${key}，否则 --check 抓不到过期索引`);
  }
  assert.match(src, /delete out\[k\]/, '声明被删掉时要清掉旧值，不能继承上一版的高权限');
});

test('框架侧 build-market-index.mjs 的合并规则与插件仓一致', () => {
  /** 两份脚本各管一份索引，规则漂了最难查：这里只比权限字段那一组 */
  const framework = path.resolve(ROOT, '..', 'bot', 'scripts', 'build-market-index.mjs');
  if (!fs.existsSync(framework)) return; // 单独分发插件仓时跳过
  const src = fs.readFileSync(framework, 'utf8');
  for (const key of ['scopes', 'overrides', 'form']) {
    assert.match(src, new RegExp(`'${key}'`), `框架侧 STRUCT_FIELDS 少了 ${key}`);
  }
  assert.match(src, /raw\.scopes/, '框架侧 readExternal 也要读 scopes');
});

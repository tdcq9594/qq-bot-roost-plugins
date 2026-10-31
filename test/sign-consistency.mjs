/**
 * 跨仓签名一致性守卫
 * ==================
 *
 * 索引由插件仓的 `scripts/sign-index.mjs` 签，由框架的 `src/trust.js` 验。
 * 两边都实现了一遍规范化（为了能单独 clone 就跑），一旦规则漂移，
 * 结果就是「自己签的、自己验不过」——所有用户升级后全部装不了插件。
 *
 * 这个测试在框架在场时逐字节比对两边输出，并且**交叉验签**：
 * 插件仓签的框架能验、框架签的插件仓能验。
 *
 * 需要 ROOST_FRAMEWORK 指向框架检出目录（CI 里 checkout 到 .framework/）。
 * 本地没设就跳过，不阻塞日常开发。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { canonicalize as pluginCanon, signText as pluginSign, verifyText as pluginVerify } from '../scripts/sign-index.mjs';

const FRAMEWORK = process.env.ROOST_FRAMEWORK;
if (!FRAMEWORK) {
  console.log('跳过：未设置 ROOST_FRAMEWORK（本地开发可不跑）');
  process.exit(0);
}

/**
 * 框架太老就没有 `src/trust.js`（0.9.8 才加的）。
 *
 * 这种时候**跳过而不是红**：CI 钉的是某个已发布 tag，老 tag 里压根没有
 * 签名实现，没什么可对比的。真正的漂移会被"两边都有、但输出不一致"抓到。
 */
const trustPath = path.join(FRAMEWORK, 'src/trust.js');
if (!fs.existsSync(trustPath)) {
  console.log(`跳过：${FRAMEWORK} 里没有 src/trust.js（框架早于 0.9.8）`);
  process.exit(0);
}

const fw = await import(pathToFileURL(trustPath).href);

/** 挑容易踩坑的形状：键序、嵌套、数组保序、unicode、数字、空值 */
const FIXTURES = [
  { b: 2, a: 1, c: { z: [3, 2], y: null } },
  { plugins: [{ id: 'x', version: '1.0.0', tags: ['b', 'a'] }], repo: 'o/r' },
  { 中文键: '值', emoji: '🍜', n: -0.5, big: 1e21 },
  { empty: [], obj: {}, s: '' },
  [{ a: 1 }, { a: 2 }],
];

let checked = 0;
for (const f of FIXTURES) {
  const a = pluginCanon(f);
  const b = fw.canonicalize(f);
  assert.equal(a, b, `规范化不一致：\n插件仓 ${a}\n框架   ${b}`);
  checked += 1;
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pub = publicKey.export({ type: 'spki', format: 'pem' });

const sample = pluginCanon(FIXTURES[1]);

// 插件仓签 → 框架验
const sigByPlugin = pluginSign(sample, priv);
assert.equal(fw.verifyText(sample, sigByPlugin, pub), true, '插件仓签的签名，框架验不过');

// 框架签 → 插件仓验
const sigByFramework = fw.signText(sample, priv);
assert.equal(pluginVerify(sample, sigByFramework, pub), true, '框架签的签名，插件仓验不过');

// 公钥解析：PEM 与裸 32 字节都要认
const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
assert.equal(pluginVerify(sample, sigByPlugin, raw), true, '裸 base64 公钥验不过');

// 篡改必失败
assert.equal(pluginVerify(pluginCanon({ ...FIXTURES[1], repo: 'evil/r' }), sigByPlugin, pub), false, '篡改后仍验过');

console.log(`✓ 签名一致性通过（${checked} 组规范化 + 双向交叉验签）`);

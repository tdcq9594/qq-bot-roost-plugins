#!/usr/bin/env node
/**
 * 给 index.json 签名 / 校验
 * =========================
 *
 *   node scripts/sign-index.mjs                 # 用 keys/trust-private.pem 签
 *   node scripts/sign-index.mjs --key D:/k.pem  # 指定私钥
 *   node scripts/sign-index.mjs --verify        # 用 keys/trust-public.pem 验
 *
 * **为什么这里自带一份实现，而不是 import 框架的 `src/trust.js`**：
 * 插件仓库要能单独 clone 下来就跑（见 `build-index.mjs` 头部同样的理由）。
 * 代价是规范化规则必须和框架保持一致——这一点由
 * `test/sign-consistency.mjs` 守卫：框架在场时逐字节比对两边的输出，
 * 不一致就让 CI 红。
 *
 * 签什么：`index.json` **解析后规范化**（键排序、无空白），不签原始字节。
 * 镜像站重新序列化（缩进、键序、末尾换行）不会让签名失效。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * 规范化：键排序 + 无空白 + 数组保序。
 * 必须与框架 `src/trust.js` 的 `canonicalize` 逐字节一致。
 */
export function canonicalize(v) {
  if (v === undefined) throw new Error('canonicalize 不接受 undefined');
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => canonicalize(x)).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(',')}}`;
}

/** PEM / 裸 32 字节 base64 → KeyObject */
export function publicKeyFrom(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try {
    if (t.includes('BEGIN PUBLIC KEY')) return crypto.createPublicKey(t);
    const raw = Buffer.from(t, 'base64');
    if (raw.length !== 32) return null;
    return crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
      format: 'jwk',
    });
  } catch {
    return null;
  }
}

export function signText(text, privateKeyPem) {
  return crypto.sign(null, Buffer.from(text, 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

export function verifyText(text, sigB64, pub) {
  try {
    const key = typeof pub === 'string' ? publicKeyFrom(pub) : pub;
    if (!key) return false;
    return crypto.verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(String(sigB64), 'base64'));
  } catch {
    return false;
  }
}

/** 签一个 JSON 文件，产出 `<file>.sig` */
export function signIndex(file, keyPath, keyId = '') {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const payload = canonicalize(data);
  const sig = signText(payload, fs.readFileSync(keyPath, 'utf8'));
  fs.writeFileSync(`${file}.sig`, `${JSON.stringify({ alg: 'ed25519', keyId, sig })}\n`, 'utf8');
  return { payload, sig };
}

/** 验一个 JSON 文件。没有 .sig 返回 unsigned，读不到公钥返回 unavailable */
export function verifyIndex(file, pub) {
  if (!pub) return { status: 'unavailable', why: '没有公钥' };
  const sigPath = `${file}.sig`;
  if (!fs.existsSync(sigPath)) return { status: 'unsigned', why: '没有 .sig 文件' };
  let env;
  try {
    env = JSON.parse(fs.readFileSync(sigPath, 'utf8'));
  } catch {
    return { status: 'bad', why: '.sig 不是合法 JSON' };
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ok = verifyText(canonicalize(data), env.sig, pub);
  return ok ? { status: 'ok', keyId: env.keyId ?? '' } : { status: 'bad', why: '签名与内容不匹配' };
}

/** 解析密钥路径：--key > ROOST_TRUST_KEY > keys/trust-private.pem */
export function resolveKeyPath(args = process.argv.slice(2), envName = 'ROOST_TRUST_KEY', def = 'keys/trust-private.pem') {
  const i = args.indexOf('--key');
  const fromArg = i >= 0 ? args[i + 1] : '';
  const p = fromArg || process.env[envName] || path.join(ROOT, def);
  return fs.existsSync(p) ? p : null;
}

/* ---------------- CLI ---------------- */

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const target = path.join(ROOT, 'index.json');
  const verifyOnly = args.includes('--verify');

  if (verifyOnly) {
    const pubPath = resolveKeyPath(args, 'ROOST_TRUST_PUBKEY', 'keys/trust-public.pem');
    const pub = pubPath ? fs.readFileSync(pubPath, 'utf8') : process.env.ROOST_TRUST_PUBKEY || '';
    const r = verifyIndex(target, pub);
    if (r.status === 'ok') {
      console.log(`✓ 签名有效${r.keyId ? `（keyId=${r.keyId}）` : ''}`);
      process.exit(0);
    }
    if (r.status === 'unavailable') {
      console.log('· 没有公钥，跳过验签');
      process.exit(0);
    }
    console.error(`✗ 验签失败：${r.why || r.status}`);
    process.exit(1);
  }

  const keyPath = resolveKeyPath(args);
  if (!keyPath) {
    console.error('找不到私钥。用 --key <路径> 或设 ROOST_TRUST_KEY。');
    process.exit(1);
  }
  const { payload } = signIndex(target, keyPath);
  console.log(`已签名 index.json → index.json.sig（${payload.length} 字节内容）`);
}

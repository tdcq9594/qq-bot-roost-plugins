/**
 * 二维码：编码器与扫码流程。
 *
 * 编码器这块不能只测「没抛错」——二维码最典型的失败是**能画出来但扫不动**
 * （格式信息写反、掩码范围错）。所以这里直接校验结构：
 *   · 三个定位图案在角上、尺寸符合版本公式；
 *   · 从矩阵里把格式信息读回来，能还原出 (纠错级别, 掩码)；
 *   · 定长输入落到预期版本。
 *
 * 扫码流程用假 fetch：真接口不该进单测，但状态映射（86101 / 86090 / 86038 / 0）
 * 必须逐条验，否则「扫完了面板没反应」只能靠人工发现。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeQr, createQr, qrToPng } from '../lib/qr-encode.mjs';
import { createQrLogin } from '../lib/qr-login.mjs';

const BILI_URL = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=0123456789abcdef0123456789abcdef&from=';

/** 二维码尺寸公式：17 + 4×版本 */
test('尺寸与版本一致，三个角都有定位图案', () => {
  const qr = encodeQr(BILI_URL, { ec: 'L' });
  assert.equal(qr.size, 17 + 4 * qr.version);
  assert.equal(qr.size % 4, 1, '尺寸必然是 21/25/29… 这种 4n+1');

  /** 定位图案是 7×7：中心 3×3 实心、外面一圈边框、再外一圈白边 */
  const m = qr.modules;
  for (const [r0, c0] of [[0, 0], [0, qr.size - 7], [qr.size - 7, 0]]) {
    assert.equal(m[r0][c0], true, '外框左上角应是黑');
    assert.equal(m[r0][c0 + 1], true);
    assert.equal(m[r0 + 3][c0 + 3], true, '中心应是黑');
    assert.equal(m[r0 + 1][c0 + 1], false, '内外框之间应是白');
  }
});

/** 从矩阵读回格式信息，验证 BCH 自洽并能还原 (ec, mask) */
test('格式信息能被读回来（写反了就整张扫不出）', () => {
  for (const ec of ['L', 'M', 'Q', 'H']) {
    const qr = encodeQr('hello', { ec });
    const m = qr.modules;
    let bits = 0;
    /** 第 8 列：b0–b5、b7、b8（b6 被时序图案占用时是跳过的那格） */
    for (let i = 0; i <= 5; i += 1) if (m[i][8]) bits |= 1 << i;
    if (m[7][8]) bits |= 1 << 6;
    if (m[8][8]) bits |= 1 << 7;
    for (let i = 8; i <= 14; i += 1) if (m[qr.size - 15 + i][8]) bits |= 1 << i;

    const raw = bits ^ 0b101010000010010;
    const data = raw >> 10;
    const level = ['M', 'L', 'H', 'Q'][data >> 3];
    assert.equal(level, ec, `纠错级别应读回 ${ec}`);
    assert.equal(data & 0b111, qr.mask, '掩码应读回同一个值');
  }
});

test('短内容用 V1，B 站那条 URL 用 V6', () => {
  assert.equal(encodeQr('a', { ec: 'L' }).version, 1);
  const qr = encodeQr(BILI_URL, { ec: 'L' });
  assert.equal(qr.version, 6, '131 字节在 V6-L 的容量（134）里');
  assert.equal(qr.size, 41);
});

test('超长内容明确报错，不静默截断', () => {
  assert.throws(() => encodeQr('x'.repeat(400), { ec: 'H' }), /内容太长/);
  assert.throws(() => encodeQr('', {}), /内容为空/);
  assert.throws(() => encodeQr('a', { ec: 'X' }), /不认识的纠错级别/);
});

test('没装开源库时 createQr 退回内置编码器', () => {
  const qr = createQr(BILI_URL, { depsDir: '' });
  assert.equal(qr.source, 'builtin');
  assert.equal(qr.size, 41);
});

test('装了开源库时优先用开源库', () => {
  /** 用一个假的 deps 目录模拟「装了 qrcode」 */
  const dir = mkdtempSync(join(tmpdir(), 'bili-deps-'));
  try {
    const pkg = join(dir, 'node_modules', 'qrcode');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'qrcode', version: '1.5.4', main: 'index.js' }));
    writeFileSync(join(pkg, 'index.js'), `
      exports.create = (text, o) => {
        const size = 21;
        return { version: 1, modules: { size, data: new Array(size*size).fill(0) }, maskPattern: 3, errorCorrectionLevel: o.errorCorrectionLevel };
      };
    `);
    const qr = createQr('x', { depsDir: dir });
    assert.equal(qr.source, 'npm:qrcode', '装了就该用开源实现');
    assert.equal(qr.mask, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PNG 是合法结构（签名 + IHDR + IEND 齐全）', () => {
  const png = qrToPng(encodeQr(BILI_URL, { ec: 'L' }), { scale: 8, margin: 4 });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.toString('ascii', png.length - 8, png.length - 4), 'IEND');
  /** 392 = (41 + 4×2) × 8 */
  assert.equal(png.readUInt32BE(16), 392);
  assert.equal(png.readUInt32BE(20), 392);
  assert.ok(png.length < 6000, `一张 392px 的黑白码不该超过几 KB，实际 ${png.length}`);
});

/* ------------------------------------------------------------------ */
/* 扫码流程：用假 fetch 走完四个状态                                    */
/* ------------------------------------------------------------------ */

function makeLogin(dir, responses) {
  let i = 0;
  const fetchImpl = async (url) => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (typeof r === 'function') return r(url);
    return {
      async json() { return r.body; },
      headers: { getSetCookie: () => r.setCookie || [], get: () => '' },
    };
  };
  return createQrLogin({ root: dir, log: () => {}, depsDir: '', fetchImpl });
}

test('出码：拿 url → 生成 qr.png → waiting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-qr-'));
  try {
    const login = makeLogin(dir, [{ body: { code: 0, data: { url: BILI_URL, qrcode_key: 'k'.repeat(32) } } }]);
    const r = await login.start();
    assert.equal(r.ok, true);
    assert.equal(r.state, 'waiting');
    assert.ok(existsSync(join(dir, 'ui', 'qr.png')), '二维码要落盘，页面用 ext-pages 取');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('轮询状态：未扫码 / 已扫码待确认 / 过期', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-qr-'));
  try {
    const login = makeLogin(dir, [
      { body: { code: 0, data: { url: BILI_URL, qrcode_key: 'k'.repeat(32) } } },
      { body: { code: 0, data: { code: 86101 } } },
      { body: { code: 0, data: { code: 86090 } } },
      { body: { code: 0, data: { code: 86038 } } },
    ]);
    await login.start();
    assert.equal((await login.poll()).state, 'waiting');
    assert.equal((await login.poll()).state, 'scanned');
    const expired = await login.poll();
    assert.equal(expired.state, 'expired');
    assert.match(expired.message, /过期/);
    assert.equal(login.hasSession(), false, '过期后会话要清掉');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('登录成功：从 Set-Cookie 挑出三项写进 cookie.txt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-qr-'));
  try {
    const login = makeLogin(dir, [
      { body: { code: 0, data: { url: BILI_URL, qrcode_key: 'k'.repeat(32) } } },
      {
        body: { code: 0, data: { code: 0 } },
        setCookie: [
          'SESSDATA=abc%2C123; Path=/; Domain=.bilibili.com; HttpOnly',
          'bili_jct=def456; Path=/; Domain=.bilibili.com',
          'DedeUserID=789; Path=/',
          'buvid3=ignored; Path=/',
        ],
      },
    ]);
    await login.start();
    const r = await login.poll();
    assert.equal(r.state, 'done');
    const txt = readFileSync(join(dir, 'cookie.txt'), 'utf8').trim();
    assert.match(txt, /SESSDATA=abc%2C123/);
    assert.match(txt, /bili_jct=def456/);
    assert.match(txt, /DedeUserID=789/);
    assert.doesNotMatch(txt, /buvid3/, '无关的 Cookie 不该写进去，会让两处来源越来越乱');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('取消会删掉二维码文件，页面不会留一张废码', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-qr-'));
  try {
    const login = makeLogin(dir, [{ body: { code: 0, data: { url: BILI_URL, qrcode_key: 'k'.repeat(32) } } }]);
    await login.start();
    assert.ok(existsSync(join(dir, 'ui', 'qr.png')));
    login.cancel();
    assert.equal(existsSync(join(dir, 'ui', 'qr.png')), false);
    assert.equal(login.hasSession(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('接口返回异常时给出可读原因，不抛', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-qr-'));
  try {
    const login = makeLogin(dir, [{ body: { code: -412, message: '风控' } }]);
    const r = await login.start();
    assert.equal(r.ok, false);
    assert.match(r.message, /接口返回异常/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

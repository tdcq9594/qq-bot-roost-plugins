/**
 * 登录态与缓存
 * ============
 *
 * 线上投诉是「扫码提示已登录，面板状态卡一直显示没登录」。
 * 根因不是 Cookie 无效，而是 `nav` 的 10 分钟缓存在扫码前后没有失效：
 * 进程内动作的 api 实例按扩展 mtime 长期复用（宿主 `ext-inprocess.js`），
 * 扫码前查过一次 `isLogin:false`，之后十分钟都拿同一份。
 *
 * 所以这里守三条：
 *   · Cookie 变了（扫码写文件 / 面板清空）→ 缓存必须失效；
 *   · 点「检查登录」带 force → 必须真发请求；
 *   · 请求失败不缓存 → 网络抖一下不能换来十分钟假「没登录」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBiliApi } from '../lib/api.mjs';

function navResponse(isLogin, uname = '') {
  return new Response(JSON.stringify({
    code: 0,
    data: {
      isLogin, uname, mid: 1691351493, vipStatus: 0,
      wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/aaa.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/bbb.png' },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function tmpCookie(text) {
  const dir = mkdtempSync(join(tmpdir(), 'bili-cookie-'));
  const file = join(dir, 'cookie.txt');
  writeFileSync(file, `${text}\n`);
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('Cookie 变了，登录态缓存立刻失效（扫码后不再显示没登录）', async () => {
  const c = tmpCookie('SESSDATA=old');
  let calls = 0;
  let logged = false;
  const api = createBiliApi({
    cookieFile: c.file,
    getCookie: () => '',
    fetchImpl: async () => { calls += 1; return navResponse(logged, logged ? '倦飞之鸟_' : ''); },
  });

  const before = await api.account();
  assert.equal(before.isLogin, false);
  assert.equal(calls, 1);

  /** 模拟扫码：qr-login 写 cookie.txt，mtime 前进 */
  logged = true;
  writeFileSync(c.file, 'SESSDATA=new\n');
  const later = new Date(Date.now() + 5000);
  utimesSync(c.file, later, later);

  const after = await api.account();
  assert.equal(after.isLogin, true, '换了 Cookie 就该重新查，不能沿用扫码前的缓存');
  assert.equal(after.uname, '倦飞之鸟_');
  assert.equal(calls, 2, '必须真的又请求了一次');

  c.cleanup();
});

test('点「检查登录」用 force，跳过十分钟缓存', async () => {
  const c = tmpCookie('SESSDATA=same');
  let calls = 0;
  let logged = false;
  const api = createBiliApi({
    cookieFile: c.file,
    getCookie: () => '',
    fetchImpl: async () => { calls += 1; return navResponse(logged, logged ? 'x' : ''); },
  });

  await api.account();
  assert.equal(calls, 1);

  logged = true;
  const forced = await api.account({ force: true });
  assert.equal(forced.isLogin, true);
  assert.equal(calls, 2, 'force 必须绕过缓存');

  /** 不带 force 时仍然吃缓存（省请求的初衷保留） */
  const cachedHit = await api.account();
  assert.equal(cachedHit.isLogin, true);
  assert.equal(calls, 2);

  c.cleanup();
});

test('请求失败不缓存：网络抖一下不该换来十分钟「没登录」', async () => {
  const c = tmpCookie('SESSDATA=x');
  let calls = 0;
  let broken = true;
  const api = createBiliApi({
    cookieFile: c.file,
    getCookie: () => '',
    fetchImpl: async () => {
      calls += 1;
      if (broken) throw new Error('ECONNRESET');
      return navResponse(true, '倦飞之鸟_');
    },
  });

  const bad = await api.account();
  assert.equal(bad.isLogin, false);
  assert.match(String(bad.error), /ECONNRESET/, '失败原因要带出来，别折成「没登录」');

  broken = false;
  const good = await api.account();
  assert.equal(good.isLogin, true, '上一次失败不能被缓存十分钟');
  assert.equal(calls, 2);

  c.cleanup();
});

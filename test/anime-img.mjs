/**
 * 二次元图插件的测试
 * ==================
 *
 * 用假 fetch 跑，不真打网络：测的是「拉取 → 缓存 → 发送 → 回收」这条链路
 * 有没有走对，图源本身能不能用是另一回事。
 *
 *   node test/anime-img.mjs
 *   ROOST_FRAMEWORK=/path/to/qq-bot-roost node test/anime-img.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRAMEWORK = process.env.ROOST_FRAMEWORK
  ? path.resolve(process.env.ROOST_FRAMEWORK)
  : path.resolve(HERE, '../../bot');

const { makeCtx, runCommand } = await import(
  pathToFileURL(path.join(FRAMEWORK, 'src/plugin/testkit.js')).href
);

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

let plugin;
try {
  plugin = (await import('./../plugins/anime-img/index.js')).default;
} catch (e) {
  check('二次元图: 插件能加载', false, e.message);
  process.exit(1);
}

/* ---------------- 假图源 ---------------- */

const realFetch = globalThis.fetch;
let apiCalls = 0;
let imgCalls = 0;
/** 一张 1x1 的 JPEG 头尾，够当「图片字节」用 */
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('api.lolicon.app')) {
    apiCalls += 1;
    // 每次给不同的 pid，才能测到「缓存会攒起来、超上限会回收」
    const pid = 987654 + apiCalls;
    return new Response(
      JSON.stringify({
        error: '',
        data: [
          {
            pid,
            p: 0,
            title: `测试用图 ${apiCalls}`,
            author: '某画师',
            width: 800,
            height: 1200,
            r18: false,
            urls: { regular: `https://img.example.com/${pid}_p0.jpg` },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  imgCalls += 1;
  return new Response(FAKE_JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
};

/* ---------------- 起一个临时插件实例 ---------------- */

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-anime-'));
const ctx = makeCtx({ id: 'anime-img', config: { minPool: 2, maxFiles: 3 }, dataDir });
await plugin.setup(ctx);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cmd = (name) =>
  runCommand(plugin, name, { content: `/${name}`, userId: 'u1', groupId: 'g1', ctx });

/* ---------------- 用例 ---------------- */

// 启动时会在后台补货，等它落一张
await sleep(150);
{
  const cacheDir = path.join(dataDir, 'imgcache');
  const files = await fs.readdir(cacheDir).catch(() => []);
  check('二次元图: 启动就补货到缓存目录', files.length >= 1, `缓存 ${files.length} 个文件`);
  check('二次元图: 补货调过图源', apiCalls >= 1, `api ${apiCalls} 次 / 图片 ${imgCalls} 次`);
}

// 发一张
{
  const r = await cmd('来张图');
  const all = r.replies.join('\n');
  check('二次元图: 发出了图片', r.replies.some((x) => x.startsWith('[image]')), all.slice(0, 60));
  check('二次元图: 带了出处', /pixiv \d+/.test(all), all.split('\n').pop());
}

// 第二张走缓存：不该标「刚收录」，缓存里也不该出现重复的 pid
{
  const r = await cmd('来张图');
  const all = r.replies.join('\n');
  check('二次元图: 缓存命中不标刚收录', !all.includes('刚收录'), all.split('\n').pop());

  await sleep(120);   // 等后台补货/索引落盘稳定
  const idx = JSON.parse(await fs.readFile(path.join(dataDir, 'index.json'), 'utf8'));
  const pids = idx.items.map((x) => x.pid);
  check('二次元图: 缓存里没有重复 pid', new Set(pids).size === pids.length, `pid ${pids.join(',')}`);
}

// 图库统计
{
  const r = await cmd('图库');
  const t = r.replies[0] ?? '';
  check('二次元图: 图库有统计', /图库：\d+ 张/.test(t), t.split('\n')[0]);
}

// 上限回收：maxFiles=3，连拉几张之后不该超过 3
{
  for (let i = 0; i < 6; i++) {
    await cmd('来张图');
    await sleep(60);
  }
  const files = await fs.readdir(path.join(dataDir, 'imgcache')).catch(() => []);
  check('二次元图: 缓存卡在上限 3', files.length === 3, `缓存 ${files.length} 个文件`);
}

// 清空
{
  const r = await cmd('清图库');
  check('二次元图: 清空有回执', /清掉了|本来就是空的/.test(r.replies[0] ?? ''), r.replies[0] ?? '');
  const files = await fs.readdir(path.join(dataDir, 'imgcache')).catch(() => []);
  check('二次元图: 清空后目录为空', files.length === 0, `剩 ${files.length} 个文件`);
}

globalThis.fetch = realFetch;
await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项: ' + failed.map((r) => r.name).join('、'));
  process.exit(1);
}

/**
 * 二次元图插件的测试
 * ==================
 *
 * 用假 fetch 跑，不真打网络：测的是「拉取 → 缓存 → 发送 → 回收」这条链路
 * 有没有走对，图源本身能不能用是另一回事。
 *
 * v2 起图源换成夜轻 ACG API（api.yppp.net），多两条关键断言：
 *   1. 图片和出处是**同一条**回复（framework replyImage 的 text 选项），
 *      不是先发图再发一句话
 *   2. 图源不去重，重复图不能把启动补货卡死
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
/** 假图片字节：内容不重要，插件只检查 content-type 和长度 */
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

/**
 * dupMode：图源每次都返回同一张图。
 * 夜轻官方「懒得做去重」，这个模式模拟最坏情况——
 * 补货循环必须收手，不能死循环。
 */
let dupMode = false;

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('api.yppp.net')) {
    apiCalls += 1;
    // 横竖由插件请求的端点决定（和真实 API 一样），不是按调用次数轮换
    const type = u.includes('/pe') ? 'pe' : 'pc';
    const id = dupMode ? 'dup-0001' : `2025-10-${String(apiCalls).padStart(8, '0')}abc`;
    const w = type === 'pc' ? 2290 : 1505;
    const h = type === 'pc' ? 1200 : 2048;
    return new Response(
      JSON.stringify({
        code: '200',
        acgurl: `https://list.yppp.net/d/image/${id}.png`,
        width: String(w),
        height: String(h),
        size: 'png',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (u.includes('list.yppp.net')) {
    imgCalls += 1;
    return new Response(FAKE_PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  }
  // 打到别的地址就是 bug，别悄悄放行
  return new Response('unexpected url', { status: 404 });
};

/* ---------------- 起一个临时插件实例 ---------------- */

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-anime-'));
const ctx = makeCtx({ id: 'anime-img', config: { minPool: 2, maxFiles: 3 }, dataDir });
await plugin.setup(ctx);
ctx.__setup = true; // 手动 setup 过就打标，不然 runCommand 会再 setup 一次

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

// 菜单：命令会自动进「指令」组，ctx.menu 只放说明，不能和指令组撞车
{
  const extra = ctx.__menus.find((s) => s.title === '二次元图');
  const cmdNames = ['来张图', '二次元', 'acg', '图库', '清图库'];
  const dup = (extra?.items ?? []).filter((it) => cmdNames.includes(it.text));
  check(
    '二次元图: 菜单说明区不重复列命令',
    !!extra && extra.items.length > 0 && dup.length === 0,
    `${extra?.items.length ?? 0} 条说明，重复 ${dup.length} 条`,
  );
}

// 发一张：图片和出处必须是同一条回复
{
  const r = await cmd('来张图');
  const all = r.replies.join('\n');
  check('二次元图: 发出了图片', r.replies.some((x) => x.startsWith('[image]')), all.slice(0, 60));
  check(
    '二次元图: 图和出处是同一条消息',
    r.replies.length === 1 && /\[image\].*(横|竖)图 \d+×\d+/.test(r.replies[0] ?? ''),
    `共 ${r.replies.length} 条：${all.slice(0, 80)}`,
  );
}

// 第二张走缓存：不该标「刚收录」，缓存里也不该出现重复 id
{
  const r = await cmd('来张图');
  const all = r.replies.join('\n');
  check('二次元图: 缓存命中不标刚收录', !all.includes('刚收录'), all.split('\n').pop());

  await sleep(120); // 等后台补货/索引落盘稳定
  const idx = JSON.parse(await fs.readFile(path.join(dataDir, 'index.json'), 'utf8'));
  const ids = idx.items.map((x) => x.id);
  check('二次元图: 缓存里没有重复 id', new Set(ids).size === ids.length, `id ${ids.join(',')}`);
}

// 图库统计
{
  const r = await cmd('图库');
  const t = r.replies[0] ?? '';
  check('二次元图: 图库有统计', /图库：\d+ 张/.test(t) && /横图 \d+ · 竖图 \d+/.test(t), t.split('\n')[0]);
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

// 清空后现拉：出处带「刚收录」，还是同一条
{
  const r = await cmd('清图库');
  check('二次元图: 清空有回执', /清掉了|本来就是空的/.test(r.replies[0] ?? ''), r.replies[0] ?? '');
  const files = await fs.readdir(path.join(dataDir, 'imgcache')).catch(() => []);
  check('二次元图: 清空后目录为空', files.length === 0, `剩 ${files.length} 个文件`);

  const r2 = await cmd('来张图');
  const one = r2.replies[0] ?? '';
  check(
    '二次元图: 现拉的图带刚收录且图文同条',
    r2.replies.length === 1 && /\[image\].*刚收录/.test(one),
    one.slice(0, 80),
  );
}

// 横竖图类型：type=pc 只出横图，type=pe 只出竖图（配置要能通到端点上）
{
  for (const [type, label, dim] of [
    ['pc', '横图', '2290×1200'],
    ['pe', '竖图', '1505×2048'],
  ]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `roost-anime-${type}-`));
    const c = makeCtx({ id: 'anime-img', config: { type, maxFiles: 3, minPool: 2 }, dataDir: dir });
    await plugin.setup(c);
    c.__setup = true;
    await sleep(150);
    const r = await runCommand(plugin, '来张图', {
      content: '/来张图',
      userId: 'u1',
      groupId: 'g1',
      ctx: c,
    });
    const one = r.replies[0] ?? '';
    check(
      `二次元图: type=${type} 出${label}`,
      one.includes('[image]') && one.includes(`${label} ${dim}`),
      one.slice(-40),
    );
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// 图源不去重：重复图不能把补货循环卡死（第二个实例，从启动就走重复图）
{
  dupMode = true;
  const dataDir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-anime-dup-'));
  const ctx2 = makeCtx({ id: 'anime-img', config: { minPool: 5, maxFiles: 10 }, dataDir: dataDir2 });
  await plugin.setup(ctx2);
  ctx2.__setup = true;
  await sleep(400); // 死循环的话这 400ms 足够让测试挂住

  const idx2 = JSON.parse(await fs.readFile(path.join(dataDir2, 'index.json'), 'utf8'));
  check(
    '二次元图: 图源重复时补货会收手',
    idx2.items.length === 1,
    `补货后缓存 ${idx2.items.length} 张（预期 1）`,
  );

  const r = await runCommand(plugin, '来张图', {
    content: '/来张图',
    userId: 'u1',
    groupId: 'g1',
    ctx: ctx2,
  });
  check(
    '二次元图: 只有重复图时也能发',
    r.replies.some((x) => x.startsWith('[image]')),
    r.replies.join(' / ').slice(0, 60),
  );
  await fs.rm(dataDir2, { recursive: true, force: true }).catch(() => {});
}

dupMode = false;
globalThis.fetch = realFetch;
await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项: ' + failed.map((r) => r.name).join('、'));
  process.exit(1);
}

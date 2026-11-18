/**
 * 预检报告 8 条问题的回归测试。
 * 每条都对应报告里的一个场景，改成"修好之后必须成立"的断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

const sandbox = mkdtempSync(join(tmpdir(), 'sticker-regress-'));
process.env.STICKER_REPLY_DATA_DIR = sandbox;

const shared = await import('../lib/shared.mjs');

/** 1x1 PNG：内容与任何内置图都不同，用来测"同名不同内容" */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const store = await import('../lib/store.mjs');
const builtin = await import('../lib/builtin.mjs');
const api = await import('../lib/api.mjs');

/* ── 1. 导出不覆盖用户文件 ─────────────────────────── */

test('非受管同名文件不被覆盖（改用备用名）', async () => {
  const settings = store.loadSettings();
  const image = store.listAnnotated(settings).images.find((i) => i.meaning);
  const name = builtin.exportName(image);
  mkdirSync(builtin.libraryDir(), { recursive: true });
  const target = join(builtin.libraryDir(), name);
  writeFileSync(target, 'unmanaged-user-file');

  const r = await builtin.exportLibrary();
  assert.equal(readFileSync(target, 'utf8'), 'unmanaged-user-file', '用户文件必须原样保留');
  assert.ok(r.conflicts.some((c) => c.file === name), '要报告冲突');
  assert.ok(r.count >= 1);
});

test('用户替换过的副本不被重新扫描覆盖', async () => {
  await builtin.exportLibrary();
  // 挑一条"目前仍参与导出"的受管条目：前面有测试把某张图的含义清空了
  const eligibleIds = new Set(store.listAnnotated().images
    .filter((i) => !i.missing && i.enabled !== false && String(i.meaning || '').trim())
    .map((i) => i.id));
  const entry = JSON.parse(readFileSync(join(builtin.libraryDir(), '.sticker-reply.json'), 'utf8')).files
    .find((f) => eligibleIds.has(f.id));
  assert.ok(entry, '导出后应有仍参与导出的受管条目');
  const file = join(builtin.libraryDir(), entry.file);
  writeFileSync(file, 'user replaced this');
  const r = await builtin.syncPublishedLibrary();
  assert.equal(readFileSync(file, 'utf8'), 'user replaced this', '用户替换的内容不能被覆盖');
  // 名字被占时不一定刚好记成"用户替换"（前面用例可能先占了同名文件），
  // 关键是：**必须报告冲突**，而且用户内容一个字节都不能被动过。
  assert.ok(r.conflicts.length > 0, '必须报告冲突而不是静默处理');
  assert.ok(r.conflicts.some((c) => /保留/.test(c.reason)));
});

/* ── 2. 损坏标注先备份再重建 ──────────────────────── */

test('标注文件损坏时先备份，再重建', async () => {
  const before = readdirSync(shared.dataDir());
  writeFileSync(shared.PATHS.annotations, '{ 这不是 JSON', 'utf8');
  const id = store.listAnnotated().images[0].id;
  const r = await store.mutateAnnotations((cur) => {
    cur.images[id] = { meaning: '重建后' };
    return cur;
  });
  assert.equal(r.corruptRebuilt, true);
  assert.ok(existsSync(r.backupPath), '必须留下备份文件');
  assert.equal(readFileSync(r.backupPath, 'utf8'), '{ 这不是 JSON', '备份内容要与原件一致');
  assert.ok(readdirSync(shared.dataDir()).length >= before.length);
});

for (const [label, invalid] of [
  ['根值为数组', [{ meaning: '待恢复的旧标注' }]],
  ['images 为数组', { version: 1, images: [{ meaning: '待恢复的旧标注' }] }],
  ['缺少 images', { version: 1, legacy: '待恢复的旧标注' }],
  ['未知版本', { version: 2, images: { original: { meaning: '待恢复的旧标注' } } }],
]) {
  test(`合法 JSON 但${label}：保存前原样备份`, async () => {
    const original = JSON.stringify(invalid);
    writeFileSync(shared.PATHS.annotations, original, 'utf8');
    const r = await store.mutateAnnotations((cur) => {
      cur.images.fixture = { meaning: '新标注' };
      return cur;
    });
    assert.equal(r.corruptRebuilt, true);
    assert.equal(readFileSync(r.backupPath, 'utf8'), original);
    const saved = JSON.parse(readFileSync(shared.PATHS.annotations, 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(saved.images.fixture.meaning, '新标注');
  });
}

/* ── 3. 硬依赖未就绪时不调用模型 ──────────────────── */

test('接入未就绪时 decide 直接返回文字，且不调用模型', async () => {
  const judge = await import('../lib/judge.mjs');
  const original = globalThis.fetch;
  const calls = [];
  api.setApiEnv({ root: 'http://127.0.0.1:9/v1', token: 'test' });
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('/v1/config')) {
      return new Response(JSON.stringify({ ok: true, values: { 'stickers.enabled': false, 'stickers.dir': '' } }));
    }
    return new Response(JSON.stringify({ ok: true, sessionId: 's' }));
  };
  try {
    const out = await judge.decide({ message: '开心！' });
    assert.equal(out.mode, 'text');
    assert.match(out.reason, /接入未就绪/);
    assert.ok(!calls.some((u) => u.includes('/v1/agent.new')), '不该创建模型会话');
  } finally { globalThis.fetch = original; }
});

/* ── 4. 令牌轮换后使用新值 ────────────────────────── */

test('每次动作都从最新 env 取凭据', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));
  const { createActions } = await import(`../${manifest.ui.entry}`);
  const urlKey = ['ROOST', 'API', 'URL'].join('_');
  const tokenKey = ['ROOST', 'API', 'TOKEN'].join('_');
  const env = { [urlKey]: 'http://127.0.0.1:9/v1', [tokenKey]: 'fake-token-for-test' };
  const actions = createActions({ env });
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push(init?.headers?.Authorization);
    return new Response(JSON.stringify({ ok: true, values: { 'stickers.enabled': true, 'stickers.dir': builtin.libraryDir() } }));
  };
  try {
    await actions.dependency({});
    env[tokenKey] = 'fake-token-rotated'; // 宿主原地更新
    await actions.dependency({});
  } finally { globalThis.fetch = original; }
  assert.deepEqual(seen, ['Bearer fake-token-for-test', 'Bearer fake-token-rotated']);
});

/* ── 5. 显式清空标注要生效 ────────────────────────── */

test('把含义和标签清空后，读回来仍是空的，且不再参与选择', async () => {
  const image = store.listAnnotated().images.find((i) => i.origin === 'default');
  await store.mutateAnnotations((cur) => {
    cur.images[image.id] = { ...(cur.images[image.id] || {}), meaning: '', tags: [], scenes: '', avoid: '' };
    return cur;
  });
  const again = store.listAnnotated().images.find((i) => i.id === image.id);
  assert.equal(again.meaning, '', '含义不能回落到默认值');
  assert.deepEqual(again.tags, [], '标签不能回落到默认值');
  assert.equal(again.scenes, '');
  assert.equal(again.origin, 'user');
});

/* ── 6. 外部同名图片不继承默认标注 ────────────────── */

test('外部目录里同名但内容不同的图不带默认标注', async () => {
  const extra = join(sandbox, 'extra-same-name');
  mkdirSync(extra, { recursive: true });
  const builtinImage = store.listAnnotated().images.find((i) => i.path.includes('assets'));
  // 同名但内容不同：写一张 1x1 PNG，却用内置图的 .jpg 文件名
  writeFileSync(join(extra, builtinImage.file), TINY_PNG);
  store.saveSettings({ extraDir: extra });

  const all = store.listAnnotated().images;
  const cloned = all.find((i) => i.path.startsWith(extra));
  assert.ok(cloned, '外部图应出现在列表里');
  assert.equal(cloned.origin, 'none', '不能继承默认标注');
  assert.equal(cloned.meaning, '', '含义必须为空');
  assert.equal(cloned.enabled, false, '未标注的不参与选择');
  store.saveSettings({ extraDir: '' });
});

/* ── 7. 选图校验严格 ──────────────────────────────── */

test('单字符 ID、伪造长 ID、越界置信度一律拒绝', async () => {
  const judge = await import('../lib/judge.mjs');
  const original = globalThis.fetch;
  const images = store.listAnnotated().images.filter((i) => i.meaning && i.enabled !== false);
  const pick = images[0];
  const cases = [
    { id: '1', confidence: 0.99 },
    { id: `${pick.id.slice(0, 12)}${'0'.repeat(52)}`, confidence: 0.99 },
    { id: pick.id.slice(0, 12), confidence: 2 },
    { id: pick.id.slice(0, 12), confidence: Number.NaN },
  ];
  try {
    for (const modelOut of cases) {
      globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/v1/config')) {
          return new Response(JSON.stringify({ ok: true, values: { 'stickers.enabled': true, 'stickers.dir': builtin.libraryDir() } }));
        }
        if (u.includes('/v1/agent.new')) return new Response(JSON.stringify({ ok: true, sessionId: 's' }));
        if (u.includes('/v1/agent.prompt')) {
          return new Response(JSON.stringify({ ok: true, text: JSON.stringify({ mode: 'image', ...modelOut, reason: 'x' }) }));
        }
        return new Response(JSON.stringify({ ok: true }));
      };
      const out = await judge.decide({ message: '开心！', chatId: '' });
      assert.equal(out.mode, 'text', `不该接受 ${JSON.stringify(modelOut)}`);
    }
  } finally { globalThis.fetch = original; }
});

test('合法的 12 位前缀仍然被接受', async () => {
  const judge = await import('../lib/judge.mjs');
  const original = globalThis.fetch;
  const image = store.listAnnotated().images.find((i) => i.meaning && i.enabled !== false);
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/v1/config')) {
      return new Response(JSON.stringify({ ok: true, values: { 'stickers.enabled': true, 'stickers.dir': builtin.libraryDir() } }));
    }
    if (u.includes('/v1/agent.new')) return new Response(JSON.stringify({ ok: true, sessionId: 's' }));
    if (u.includes('/v1/agent.prompt')) {
      return new Response(JSON.stringify({ ok: true, text: JSON.stringify({ mode: 'image', id: image.id.slice(0, 12), confidence: 0.95, reason: 'ok' }) }));
    }
    return new Response(JSON.stringify({ ok: true }));
  };
  try {
    const out = await judge.decide({ message: '开心！', chatId: '' });
    assert.equal(out.mode, 'image');
    assert.match(out.marker, /^<<image-alone: .+>>$/);
  } finally { globalThis.fetch = original; }
});

/* ── 8. 来源失效的行要留在列表里 ──────────────────── */

test('原图删除后，标注仍在，并出现在失效行', async () => {
  const extra = join(sandbox, 'extra-missing');
  mkdirSync(extra, { recursive: true });
  const file = join(extra, '临时图.png');
  writeFileSync(file, TINY_PNG);
  store.saveSettings({ extraDir: extra });

  const added = store.listAnnotated().images.find((i) => i.path.startsWith(extra));
  await store.mutateAnnotations((cur) => {
    cur.images[added.id] = { meaning: '待删', tags: ['临时'], enabled: true };
    return cur;
  });

  rmSync(file);
  const after = store.listAnnotated();
  const row = after.images.find((i) => i.id === added.id);
  assert.ok(row, '失效的图不能直接消失');
  assert.equal(row.missing, true);
  assert.equal(row.path, '');
  assert.equal(row.meaning, '待删', '标注要保留');
  assert.ok(after.missing.some((i) => i.id === added.id));
  store.saveSettings({ extraDir: '' });
});

/* ── 追加：并发上限与 list 漏传 missing ─────────────── */

test('并发判断不得超过两路（占坑必须在 await 之前）', async () => {
  const judge = await import('../lib/judge.mjs');
  const original = globalThis.fetch;
  let modelCalls = 0;
  let running = 0;
  let peak = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/v1/config')) {
      // 故意慢一点：这一步曾经把限额窗口撑开
      await sleep(30);
      return new Response(JSON.stringify({ ok: true, values: { 'stickers.enabled': true, 'stickers.dir': builtin.libraryDir() } }));
    }
    if (u.includes('/v1/agent.new')) return new Response(JSON.stringify({ ok: true, sessionId: 's' }));
    if (u.includes('/v1/agent.prompt')) {
      modelCalls += 1;
      running += 1;
      peak = Math.max(peak, running);
      await sleep(60);
      running -= 1;
      return new Response(JSON.stringify({ ok: true, text: JSON.stringify({ mode: 'text', reason: 'x' }) }));
    }
    return new Response(JSON.stringify({ ok: true }));
  };

  try {
    const out = await Promise.all([
      judge.decide({ message: '开心！' }),
      judge.decide({ message: '开心！' }),
      judge.decide({ message: '开心！' }),
    ]);
    assert.equal(modelCalls, 2, `应只有 2 路进入模型，实际 ${modelCalls}`);
    assert.equal(peak, 2, `实际最大并发 ${peak}`);
    assert.ok(out.some((o) => /并发判断已满/.test(String(o.reason))), '第三路要被限流');
  } finally { globalThis.fetch = original; }
});

test('list 动作把 missing 传给页面', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));
  const { createActions } = await import(`../${manifest.ui.entry}`);
  const actions = createActions({ env: {} });

  // 造一条失效记录：标注里有，磁盘上没有
  const ghostId = 'f'.repeat(64);
  await store.mutateAnnotations((cur) => {
    cur.images[ghostId] = { name: '幽灵图', meaning: '测试', tags: [] };
    return cur;
  });

  const d = await actions.list({});
  assert.equal(d.ok, true);
  const row = d.data.images.find((i) => i.id === ghostId);
  assert.ok(row, '失效行必须出现在返回里');
  assert.equal(row.missing, true, 'missing 字段不能漏传');
  assert.ok(d.data.stats.missing >= 1);
});

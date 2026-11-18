// 表情回复：扫描/标注/判断/并发保存
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'sticker-'));
process.env.STICKER_REPLY_DATA_DIR = dataDir;

const api = await import('../lib/api.mjs');
const store = await import('../lib/store.mjs');
const { decide, pickCandidates } = await import('../lib/judge.mjs');
const { PATHS } = await import('../lib/shared.mjs');

api.setApiEnv({ root: 'http://127.0.0.1:1/v1', token: 'test' });

/** 假模型：按队列返回；同时记录被调用次数 */
function mockModel(handler) {
  const calls = { new: 0, prompt: 0, close: 0 };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/v1/agent.new')) {
      calls.new += 1;
      return new Response(JSON.stringify({ ok: true, sessionId: 's1' }), { status: 200 });
    }
    if (u.includes('/v1/agent.prompt')) {
      calls.prompt += 1;
      const out = await handler(JSON.parse(init.body || '{}'));
      if (out instanceof Error) throw out;
      return new Response(JSON.stringify({ ok: true, text: out }), { status: 200 });
    }
    if (u.endsWith('/v1/agent.close')) {
      calls.close += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  return calls;
}

const withModel = (payload) => mockModel(() => JSON.stringify(payload));

test('首次扫描：14 张默认图，都有初始标注', () => {
  const { images, errors } = store.listAnnotated(store.loadSettings());
  assert.equal(images.length, 14);
  assert.equal(errors.length, 0);
  assert.ok(images.every((i) => i.meaning.trim().length > 0), '每张都要有含义');
  assert.ok(images.every((i) => i.enabled !== false));
});

test('同内容图片按 sha256 去重，来源合并', () => {
  const extra = join(dataDir, 'extra');
  mkdirSync(extra, { recursive: true });
  const src = store.listAnnotated(store.loadSettings()).images[0].path;
  copyFileSync(src, join(extra, '复制一份.jpg'));

  store.saveSettings({ extraDir: extra });
  const { images } = store.listAnnotated(store.loadSettings());
  assert.equal(images.length, 14, '重复内容不应多出一条');
  const dup = images.find((i) => i.sources.includes('user'));
  assert.ok(dup, '应记录 user 来源');
  assert.ok(dup.sources.includes('default'));
  store.saveSettings({ extraDir: '' });
});

test('候选筛选：标签命中排前，数量受上限约束', () => {
  const { images } = store.listAnnotated(store.loadSettings());
  const pool = images.filter((i) => i.meaning);
  const hit = pickCandidates(pool, '你今天好得意哦，还在眨眼', { max: 24 });
  assert.equal(hit.length, Math.min(24, pool.length));
  assert.ok(hit[0].tags.includes('眨眼') || hit[0].tags.includes('得意'), `首个候选：${hit[0].name}`);
  const capped = pickCandidates(pool, 'x', { max: 3 });
  assert.equal(capped.length, 3, '上限生效');
});

test('模型选中候选内图片：返回 image 与标记，且会话被关掉', async () => {
  const { images } = store.listAnnotated(store.loadSettings());
  const target = images.find((i) => i.tags.includes('比心')) || images[0];
  const calls = withModel({ mode: 'image', id: target.id.slice(0, 12), confidence: 0.92, reason: '对方在道谢' });

  const out = await decide({ message: '谢谢你呀', history: [], chatId: 'G1', requireReady: false });
  assert.equal(out.mode, 'image');
  assert.equal(out.image.id, target.id);
  assert.match(out.marker, /^<<image-alone: .+>>$/, `标记格式：${out.marker}`);
  assert.ok(existsSync(out.marker.slice('<<image-alone: '.length, -2)), '标记里的路径必须真实存在');
  assert.equal(calls.close, 1, '临时会话必须关闭');
});

test('模型给出库外 ID → 退回文字', async () => {
  withModel({ mode: 'image', id: 'deadbeefdeadbeef', confidence: 0.99, reason: '瞎编' });
  const out = await decide({ message: '在吗', requireReady: false });
  assert.equal(out.mode, 'text');
  assert.match(out.reason, /不在候选里/);
});

test('置信度不足阈值 → 退回文字', async () => {
  const { images } = store.listAnnotated(store.loadSettings());
  withModel({ mode: 'image', id: images[0].id.slice(0, 12), confidence: 0.5, reason: '勉强' });
  const out = await decide({ message: '在吗', requireReady: false });
  assert.equal(out.mode, 'text');
  assert.match(out.reason, /置信度不足/);
});

test('模型返回非 JSON → 退回文字，不当成"没新增"', async () => {
  withModel('我觉得可以发表情');
  const out = await decide({ message: '在吗', requireReady: false });
  assert.equal(out.mode, 'text');
  assert.match(out.reason, /不是合法 JSON/);
});

test('模型超时／抛错 → 退回文字', async () => {
  mockModel(() => new Error('TimeoutError: 超时'));
  const out = await decide({ message: '在吗', requireReady: false });
  assert.equal(out.mode, 'text');
  assert.match(out.reason, /判断失败/);
});

test('扩展关闭时不调用模型', async () => {
  store.saveSettings({ enabled: false });
  const calls = withModel({ mode: 'image', id: 'x', confidence: 1, reason: '' });
  const out = await decide({ message: '在吗', requireReady: false });
  assert.equal(out.mode, 'text');
  assert.equal(calls.prompt, 0, '关闭后不该再打模型');
  store.saveSettings({ enabled: true });
});

test('并发保存标注不会互相覆盖', async () => {
  const { images } = store.listAnnotated(store.loadSettings());
  const [a, b] = [images[0].id, images[1].id];
  await Promise.all([
    store.mutateAnnotations((cur) => { cur.images[a] = { ...(cur.images[a] || {}), meaning: '甲' }; return cur; }),
    store.mutateAnnotations((cur) => { cur.images[b] = { ...(cur.images[b] || {}), meaning: '乙' }; return cur; }),
  ]);
  const raw = JSON.parse(readFileSync(PATHS.annotations, 'utf8'));
  assert.equal(raw.images[a].meaning, '甲');
  assert.equal(raw.images[b].meaning, '乙');
});

test('用户标注覆盖默认，未编辑字段仍用默认', () => {
  const { images } = store.listAnnotated(store.loadSettings());
  const one = images[0];
  assert.equal(one.origin, 'user', '刚写过的应标为 user');
  assert.equal(one.meaning, '甲', '用户改过的含义优先');
  assert.ok(one.tags.length > 0, '未编辑的标签仍来自默认标注');
});

test('标注文件损坏时退回默认，不崩', () => {
  writeFileSync(PATHS.annotations, '{坏掉的 json', 'utf8');
  const { images } = store.listAnnotated(store.loadSettings());
  assert.equal(images.length, 14);
  assert.ok(images[0].meaning.length > 0);
});

test('扩展目录解析不会把中文用户名转义（真机踩过）', async () => {
  const shared = await import('../lib/shared.mjs');
  assert.ok(!shared.EXT_ROOT.includes('%'), `路径被百分号转义了：${shared.EXT_ROOT}`);
  assert.ok(shared.listImageFiles(shared.DEFAULT_DIR).length >= 14, '内置图必须扫得到');
});

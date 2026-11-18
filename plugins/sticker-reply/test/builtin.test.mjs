import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'sticker-builtin-'));
process.env.STICKER_REPLY_DATA_DIR = sandbox;
const shared = await import('../lib/shared.mjs');
const store = await import('../lib/store.mjs');
const builtin = await import('../lib/builtin.mjs');
const api = await import('../lib/api.mjs');
const sourceRoot = new URL('../', import.meta.url);

test('首次导出：14 张扁平标签图，内容哈希不变，来源未修改', async () => {
  const source = store.listAnnotated().images;
  const r = await builtin.exportLibrary();
  assert.equal(r.count, 14);
  const catalog = JSON.parse(readFileSync(join(r.directory, '.sticker-reply.json'), 'utf8'));
  for (const entry of catalog.files) {
    assert.equal(store.sha256Of(join(r.directory, entry.file)), entry.id);
    assert.equal(store.sha256Of(source.find(i => i.id === entry.id).path), entry.id);
    assert.ok(!/[\\/<>:"|?*]/.test(entry.file));
  }
  assert.ok(catalog.files.some(f => f.file.includes('开心')));
});

test('再次导出无重复，外部同内容图不重复生成副本', async () => {
  const extra = join(sandbox, 'extra'); mkdirSync(extra);
  const first = store.listAnnotated().images[0];
  copyFileSync(first.path, join(extra, '一张 重命名.jpg'));
  store.saveSettings({ extraDir: extra });
  const a = await builtin.exportLibrary(); const b = await builtin.exportLibrary();
  assert.equal(a.count, 14); assert.equal(b.count, 14);
  assert.equal(readdirSync(b.directory).filter(n => n.endsWith('.jpg')).length, 14);
});

test('改标注后更新标签文件名，禁用时移除受管副本，保留用户文件', async () => {
  const first = store.listAnnotated().images[0];
  const old = builtin.exportName(first);
  const userFile = join(builtin.libraryDir(), '用户自己的文件.txt');
  writeFileSync(userFile, 'keep');
  await store.mutateAnnotations(db => { db.images[first.id] = { name: '新标签', enabled: true }; return db; });
  await builtin.syncPublishedLibrary();
  assert.equal(existsSync(join(builtin.libraryDir(), old)), false);
  assert.ok(readdirSync(builtin.libraryDir()).some(n => n.startsWith('新标签_')));
  await store.mutateAnnotations(db => { db.images[first.id].enabled = false; return db; });
  const result = await builtin.syncPublishedLibrary();
  assert.equal(result.count, 13);
  assert.equal(readFileSync(userFile, 'utf8'), 'keep');
});

test('用户替换导出副本后清理不误删该文件', async () => {
  const image = store.listAnnotated().images.find(i => i.enabled !== false);
  const file = join(builtin.libraryDir(), builtin.exportName(image));
  writeFileSync(file, 'user replaced');
  await store.mutateAnnotations(db => { db.images[image.id] = { enabled: false }; return db; });
  await builtin.exportLibrary();
  assert.equal(readFileSync(file, 'utf8'), 'user replaced');
});

test('扩展关闭时受管导出为空，标注文件和原图保留', async () => {
  store.saveSettings({ enabled: false });
  const before = readFileSync(shared.PATHS.annotations, 'utf8');
  const r = await builtin.syncPublishedLibrary();
  assert.equal(r.count, 0);
  assert.equal(readFileSync(shared.PATHS.annotations, 'utf8'), before);
  assert.equal(store.listAnnotated().images.length, 14);
});

test('依赖状态严格检查开关及目录，支持多目录保留原库', () => {
  const dir = builtin.libraryDir();
  assert.equal(builtin.dependencyState({ 'stickers.enabled': false, 'stickers.dir': dir }).ready, false);
  assert.equal(builtin.dependencyState({ 'stickers.enabled': true, 'stickers.dir': [join(sandbox, 'other'), dir] }).ready, true);
  assert.equal(builtin.dependencyState({ 'stickers.enabled': true, 'stickers.dir': join(sandbox, 'other') }).ready, false);
});

test('宿主已开启但扩展关闭或导出为空时，接入仍未就绪', () => {
  const host = { ready: true, enabled: true, configured: true };
  assert.equal(builtin.connectionState(host, {extensionEnabled: false, exportedCount: 14}).ready, false);
  assert.equal(builtin.connectionState(host, {extensionEnabled: true, exportedCount: 0}).ready, false);
  assert.equal(builtin.connectionState(host, {extensionEnabled: true, exportedCount: 14}).ready, true);
});

test('通过公开配置只读检查依赖，不修改宿主或人格', async () => {
  store.saveSettings({ enabled: true });
  await builtin.exportLibrary();
  const original = globalThis.fetch;
  api.setApiEnv({root:'http://localhost:1/v1',token:'test'});
  const calls=[];
  globalThis.fetch=async(url,init) => {
    calls.push({url:String(url),method:init.method});
    return new Response(JSON.stringify({ok:true,values:{'stickers.enabled':true,'stickers.dir':builtin.libraryDir()}}));
  };
  try {
    assert.equal((await builtin.checkBuiltinDependency()).ready, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url,/\/v1\/config\?keys=stickers.enabled,stickers.dir$/);
    assert.equal(calls[0].method,'GET');
  } finally { globalThis.fetch=original; }
});

test('配置接口故障显示未取得，不把失败当成已关闭', async () => {
  const original=globalThis.fetch;
  globalThis.fetch=async() => {throw new Error('network unavailable');};
  try { const r=await builtin.checkBuiltinDependency(); assert.equal(r.available,false); assert.equal(r.enabled,null); assert.match(r.error,/network/); }
  finally {globalThis.fetch=original;}
});

test('清单、入口和面板移除人格功能及写权限', async () => {
  const m=JSON.parse(readFileSync(new URL('plugin.json',sourceRoot),'utf8'));
  assert.deepEqual(m.scopes,['state:read','agent:write']);
  assert.ok(!m.ui.actions.some(a=>/Prompt/.test(a.id)));
  const entry=readFileSync(new URL(m.ui.entry,sourceRoot),'utf8');
  assert.doesNotMatch(entry,/personas\/(?:create|save)|session.configure|prompt\.mjs/);
  assert.equal(existsSync(new URL('lib/prompt.mjs',sourceRoot)),false);
  const page=readFileSync(new URL('page.html',sourceRoot),'utf8');
  assert.doesNotMatch(page,/applyPrompt|revertPrompt|写进人格/);
  assert.match(page,/exportLibrary/);
  new Function(/<script>([\s\S]*?)<\/script>/.exec(page)[1]);
});

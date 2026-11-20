import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every case owns its data root. No host configuration, API, model, or QQ is used.
const shared = await import('../lib/shared.mjs');
const store = await import('../lib/store.mjs');
const builtin = await import('../lib/builtin.mjs');
const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));
const { createActions } = await import(new URL(manifest.ui.entry, new URL('../', import.meta.url)));
const MANIFEST = '.sticker-reply.json';
const IMAGE_NAME = 'managed.png';
const IMAGE_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const IMAGE_ID = createHash('sha256').update(IMAGE_BYTES).digest('hex');
const USER_BYTES = Buffer.from([0, 255, 10, 13, 42, 128, 1]);

function treeBytes(directory) {
  if (!existsSync(directory)) return null;
  const entries = [];
  for (const name of readdirSync(directory).sort()) {
    const file = join(directory, name);
    const stat = lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false, 'snapshot must not follow links');
    entries.push([name, stat.isDirectory() ? treeBytes(file) : readFileSync(file)]);
  }
  return entries;
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sticker-migration-review-'));
  const previous = process.env.STICKER_REPLY_DATA_DIR;
  process.env.STICKER_REPLY_DATA_DIR = join(root, 'isolated-data');
  const links = [];
  t.after(() => {
    for (const link of links.reverse()) {
      try { unlinkSync(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (previous === undefined) delete process.env.STICKER_REPLY_DATA_DIR;
    else process.env.STICKER_REPLY_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });

  const from = join(root, 'source-library');
  mkdirSync(from);
  writeFileSync(join(from, IMAGE_NAME), IMAGE_BYTES);
  writeFileSync(join(from, MANIFEST), JSON.stringify({
    owner: 'sticker-reply', version: 1, at: 123456,
    files: [{ id: IMAGE_ID, file: IMAGE_NAME }],
  }, null, 2));
  writeFileSync(join(from, 'user-owned.bin'), USER_BYTES);
  store.saveSettings({ enabled: false, libraryDir: from });
  writeFileSync(shared.PATHS.annotations, JSON.stringify({
    version: 1,
    images: { [IMAGE_ID]: { meaning: 'keep user annotation', enabled: true } },
    userNote: 'keep exact bytes',
  }, null, 2));

  return {
    root, from,
    actions: createActions({ env: {} }),
    protectedBytes() {
      return {
        source: treeBytes(from),
        settings: readFileSync(shared.PATHS.settings),
        annotations: readFileSync(shared.PATHS.annotations),
      };
    },
    link(target, path, type = process.platform === 'win32' ? 'junction' : 'dir') {
      try {
        symlinkSync(target, path, type);
      } catch (error) {
        if (!['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) throw error;
        t.skip(`${type} link creation unavailable: ${error.code}: ${error.message}`);
        return false;
      }
      if (!lstatSync(path).isSymbolicLink()) {
        t.skip(`runtime did not create a real ${type} link; ordinary files/directories do not exercise link protection`);
        return false;
      }
      links.push(path);
      return true;
    },
  };
}

async function assertSuccessfulSettingsMigration(t, restoreDefault) {
  const f = fixture(t);
  const to = restoreDefault ? builtin.DEFAULT_LIBRARY() : join(f.root, 'new-library');
  const beforeAnnotations = readFileSync(shared.PATHS.annotations);
  const result = await f.actions.settings({ patch: { libraryDir: restoreDefault ? '' : to } });

  assert.equal(result.ok, true, result.message);
  assert.equal(result.data.saved, true);
  assert.equal(result.data.settings.enabled, false);
  assert.equal(result.data.settings.libraryDir, restoreDefault ? '' : to);
  assert.equal(store.loadSettings().libraryDir, restoreDefault ? '' : to);
  assert.equal(builtin.libraryDir(), to);
  assert.equal(result.data.migration.moved, 1);
  assert.equal(result.data.library.directory, to);
  assert.equal(result.data.library.published, true);
  assert.equal(result.data.library.count, 1, 'disabled settings migration must retain its published copy');
  assert.deepEqual(readFileSync(join(to, IMAGE_NAME)), IMAGE_BYTES, 'migrated image bytes must survive');
  assert.equal(existsSync(join(f.from, IMAGE_NAME)), false);
  assert.equal(existsSync(join(f.from, MANIFEST)), false);
  const catalog = JSON.parse(readFileSync(join(to, MANIFEST), 'utf8'));
  assert.equal(catalog.owner, 'sticker-reply');
  assert.deepEqual(catalog.files, [{ id: IMAGE_ID, file: IMAGE_NAME }]);
  assert.deepEqual(readFileSync(join(f.from, 'user-owned.bin')), USER_BYTES);
  assert.equal(existsSync(join(to, 'user-owned.bin')), false);
  assert.deepEqual(readFileSync(shared.PATHS.annotations), beforeAnnotations);
}

test('disabled settings: changing libraryDir preserves the single managed image and user bytes', async (t) => {
  await assertSuccessfulSettingsMigration(t, false);
});

test('disabled settings: empty libraryDir restores the default without deleting migrated image bytes', async (t) => {
  await assertSuccessfulSettingsMigration(t, true);
});

function linkedDestination(t, ancestor) {
  const f = fixture(t);
  const external = join(f.root, 'external-target');
  mkdirSync(external);
  writeFileSync(join(external, 'external-user.bin'), USER_BYTES);
  const link = join(f.root, 'target-link');
  if (!f.link(external, link)) return null;
  return { ...f, external, to: ancestor ? join(link, 'new-child') : link };
}

for (const ancestor of [false, true]) {
  const location = ancestor ? 'intermediate linked ancestor with a missing child' : 'direct directory link';

  test(`settings reject a target ${location} before changing source, settings, or external bytes`, async (t) => {
    const f = linkedDestination(t, ancestor);
    if (!f) return;
    const before = f.protectedBytes();
    const externalBefore = treeBytes(f.external);

    const check = builtin.checkLibraryDir(f.to);
    assert.equal(check.ok, false, 'directory validation must reject the linked path');
    assert.ok(check.reason, 'validation must explain the rejected path');
    assert.deepEqual(f.protectedBytes(), before);
    assert.deepEqual(treeBytes(f.external), externalBefore);

    const result = await f.actions.settings({ patch: { libraryDir: f.to } });
    assert.equal(result.ok, false, 'settings action must reject the linked path');
    assert.ok(result.message);
    assert.deepEqual(f.protectedBytes(), before, 'failed settings must preserve all source and data bytes');
    assert.deepEqual(treeBytes(f.external), externalBefore, 'failed settings must not write through the link');
  });

  test(`migrateLibrary rejects a target ${location} without moving or writing any bytes`, async (t) => {
    const f = linkedDestination(t, ancestor);
    if (!f) return;
    const before = f.protectedBytes();
    const externalBefore = treeBytes(f.external);

    await assert.rejects(() => builtin.migrateLibrary(f.from, f.to));
    assert.deepEqual(f.protectedBytes(), before);
    assert.deepEqual(treeBytes(f.external), externalBefore);
  });
}

for (const ancestor of [false, true]) {
  const location = ancestor ? 'a linked intermediate source ancestor' : 'a linked source directory';
  test(`settings and migrateLibrary reject ${location} and preserve the original image and user data`, async (t) => {
    const f = fixture(t);
    const link = join(f.root, 'source-link');
    if (!f.link(ancestor ? f.root : f.from, link)) return;
    const linkedSource = ancestor ? join(link, 'source-library') : link;
    store.saveSettings({ libraryDir: linkedSource });
    const to = join(f.root, 'new-library');
    const before = f.protectedBytes();
    const beforeTarget = treeBytes(to);

    const result = await f.actions.settings({ patch: { libraryDir: to } });
    assert.equal(result.ok, false, 'settings must reject a linked migration source');
    assert.ok(result.message);
    assert.deepEqual(f.protectedBytes(), before);
    assert.deepEqual(treeBytes(to), beforeTarget);

    await assert.rejects(() => builtin.migrateLibrary(linkedSource, to));
    assert.deepEqual(f.protectedBytes(), before, 'direct migration must preserve source, settings, and annotations');
    assert.deepEqual(treeBytes(to), beforeTarget, 'direct migration must not create or populate a target');
  });
}

for (const alternate of [false, true]) {
  const location = alternate ? 'the alternative filename after a user-file collision' : 'the primary filename';
  test(`settings and migrateLibrary reject a dangling file symlink at ${location} before losing bytes`, async (t) => {
    const f = fixture(t);
    const to = join(f.root, 'new-library');
    const external = join(f.root, 'external-files');
    mkdirSync(to);
    mkdirSync(external);
    writeFileSync(join(external, 'external-user.bin'), USER_BYTES);
    const outsideFile = join(external, 'must-not-be-created.png');
    const targetManifest = join(to, MANIFEST);
    writeFileSync(targetManifest, JSON.stringify({ owner: 'sticker-reply', version: 1, at: 654321, files: [] }));
    if (alternate) writeFileSync(join(to, IMAGE_NAME), USER_BYTES);
    const link = join(to, alternate ? 'managed_1.png' : IMAGE_NAME);
    if (!f.link(outsideFile, link, 'file')) return;
    assert.equal(existsSync(outsideFile), false, 'fixture must point at a nonexistent external file');
    assert.equal(existsSync(link), false, 'fixture must be a genuinely dangling file symlink');
    const before = f.protectedBytes();
    const manifestBefore = readFileSync(targetManifest);
    const namesBefore = readdirSync(to).sort();
    const externalBefore = treeBytes(external);

    function assertPreserved() {
      assert.deepEqual(f.protectedBytes(), before, 'source image, source manifest, settings, and annotations must retain their bytes');
      assert.deepEqual(readFileSync(join(f.from, IMAGE_NAME)), IMAGE_BYTES);
      assert.deepEqual(readFileSync(targetManifest), manifestBefore, 'target manifest must retain its exact bytes');
      assert.deepEqual(readdirSync(to).sort(), namesBefore);
      assert.equal(lstatSync(link).isSymbolicLink(), true, 'existing user symlink must remain intact');
      assert.equal(existsSync(outsideFile), false, 'migration must not create the external symlink target');
      assert.deepEqual(treeBytes(external), externalBefore);
      if (alternate) assert.deepEqual(readFileSync(join(to, IMAGE_NAME)), USER_BYTES);
    }

    const result = await f.actions.settings({ patch: { libraryDir: to } });
    assert.equal(result.ok, false, 'settings must fail before copying through a dangling file symlink');
    assert.ok(result.message);
    assertPreserved();

    await assert.rejects(() => builtin.migrateLibrary(f.from, to));
    assertPreserved();
  });
}

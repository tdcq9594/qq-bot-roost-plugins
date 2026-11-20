import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const page = readFileSync(new URL('../page.html', import.meta.url), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(page)[1];

async function panel(approved) {
  const nodes = new Map();
  const requests = [];
  const confirmations = [];
  let directory = '/custom-library';
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', textContent: '', dataset: {}, handlers: {},
      addEventListener(event, handler) { this.handlers[event] = handler; },
      replaceChildren() {},
    });
    return nodes.get(id);
  };
  const context = createContext({
    document: { getElementById: node, querySelectorAll: () => [...nodes.values()] },
    confirm: (message) => { confirmations.push(message); return approved; },
    fetch: async (_url, options) => {
      const { action, payload } = JSON.parse(options.body).arg;
      requests.push({ action, payload });
      let data;
      if (action === 'list') data = {
        images: [], settings: { enabled: false, threshold: 0.8, maxCandidates: 24 },
        library: { directory, defaultDir: '/default-library', published: true, count: 1 },
        api: 'ok',
      };
      else if (action === 'dependency') data = { available: true, ready: false, extensionEnabled: false, enabled: true, configured: true, exportedCount: 1 };
      else if (action === 'settings') {
        directory = payload.patch.libraryDir || '/default-library';
        data = { library: { directory, count: 1 }, migration: { moved: 1, alreadyThere: 2, leftBehind: [{}], conflicts: [{}] } };
      } else throw new Error(`Unexpected action ${action}`);
      return { ok: true, json: async () => ({ ok: true, data }) };
    },
  });
  runInContext(script, context, { timeout: 1000 });
  await new Promise(setImmediate); // 页面初始化的模拟请求完成。
  requests.length = 0;
  return { node, requests, confirmations };
}

for (const button of ['saveLibraryDir', 'resetLibraryDir']) {
  test(`${button}：取消确认不改路径也不发写请求`, async () => {
    const ui = await panel(false);
    const before = ui.node('libraryDir').value;
    await ui.node(button).handlers.click();
    assert.equal(ui.confirmations.length, 1);
    assert.deepEqual(ui.requests, []);
    assert.equal(ui.node('libraryDir').value, before);
  });

  test(`${button}：确认后回显迁移结果且不再导出清理`, async () => {
    const ui = await panel(true);
    ui.node('libraryDir').value = '/new-library';
    await ui.node(button).handlers.click();
    assert.equal(ui.confirmations.length, 1);
    const writes = ui.requests.filter((r) => r.action === 'settings');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].payload.patch.libraryDir, button === 'resetLibraryDir' ? '' : '/new-library');
    assert.equal(ui.requests.some((r) => r.action === 'exportLibrary'), false);
    const output = ui.node('result').textContent;
    assert.match(output, /搬运 1 张/);
    assert.match(output, /已有 2 张/);
    assert.match(output, /留在原目录 1 个/);
    assert.match(output, /同名冲突 1 个/);
    if (button === 'resetLibraryDir') assert.match(output, /已恢复默认目录/);
    assert.equal(ui.node(button).disabled, false);
  });
}

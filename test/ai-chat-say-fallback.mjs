/**
 * `<<say>>` 回退链路的行为测试（真跑 handle，不读源码猜）。
 *
 * 为什么单独一个文件：2026-11-07 修的这半套机制（onTextSent / 遮蔽 /
 * 预算时机 / replyVoice 三态）以前「自测通过」却一行都没生效——现有 16 个
 * 测试文件没有一个驱动到 say 分支。这里把 `setup()` 注册的消息处理函数拿出来，
 * 用假宿主 + 假 DSH 真跑一轮，断言用户最后到底收到了什么。
 *
 * TTS 的两个可选依赖（mpg123-decoder / silk-wasm）没装也能测：用一个
 * data: URL 的 ESM loader 把它们换成桩，让 synthesize 真走到 replyVoice。
 * 桩只在本进程内生效，不改仓库、不装依赖。
 *
 *   node test/ai-chat-say-fallback.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ---------------- 可选 TTS 依赖的桩 ---------------- */

const stub = `
export async function encode() { return { data: new Uint8Array([1, 2, 3, 4]) }; }
export class MPEGDecoder {}
`;
const stubUrl = 'data:text/javascript,' + encodeURIComponent(stub);
const loader = `
const STUB = ${JSON.stringify(stubUrl)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'silk-wasm' || specifier === 'mpg123-decoder') {
    return { url: STUB, shortCircuit: true, format: 'module' };
  }
  return nextResolve(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(loader), import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = path.join(HERE, '..', 'plugins', 'ai-chat', 'index.js');
const plugin = (await import(pathToFileURL(P))).default;

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}${detail ? '  ' + detail : ''}`);
  }
};

/** 一个最小但合法的 16bit 单声道 WAV，够 decodeWav 解析出采样 */
function wavBytes() {
  const b = Buffer.alloc(48);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(40, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);       // 整数 PCM
  b.writeUInt16LE(1, 22);       // 单声道
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);      // 16bit
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(4, 40);
  b.writeInt16LE(0, 44);
  b.writeInt16LE(100, 46);
  return b;
}

const noop = () => {};
const generic = () => Promise.resolve({});

/**
 * 跑一轮：模型说 `modelText`（或多段 `modelParts`），宿主按 `voiceMode` 表现，
 * 返回这一轮真正发进群的文字、语音调用数、日志。
 */
async function runScenario({
  modelText = '晚安',
  modelParts = null,
  ttsFail = false,
  voiceMode = 'ok',
  replyFailFirst = false,
  autoFallback = false,
} = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-say-test-'));
  const handlers = {};
  const routes = {};
  const replies = [];
  const voiceCalls = [];
  const warns = [];
  let replyCalls = 0;

  const cfg = {
    decide: 'mention',
    dshUrl: 'http://127.0.0.1:17321',
    mergeWaitSec: 0,
    cooldownSec: 0,
    maxRepliesPerMin: 0,
    timeoutSec: 5,
    markdown: false,
    seeImages: false,
    debug: false,
  };

  const ctx = new Proxy({}, {
    get(_t, k) {
      if (k === 'config') return cfg;
      if (k === 'dataDir') return dataDir;
      if (k === 'storage') return { get: async () => null, set: async () => {} };
      if (k === 'logger') return {
        info: noop, debug: noop, error: noop,
        warn: (m) => warns.push(String(m)),
      };
      if (k === 'on') return (ev, fn) => { handlers[ev] = fn; };
      if (k === 'onTeardown') return noop;
      if (k === 'schedule') return () => ({ cancel: noop });
      if (k === 'registerRoute') return (_m, p, fn) => { routes[p] = fn; return null; };
      if (k === 'isOwner') return () => false;
      if (k === 'levelOf') return async () => 'member';
      if (k === 'levelName') return () => '成员';
      return generic;
    },
  });

  const msg = {
    kind: 'group',
    chatId: 'g1',
    userId: 'u1',
    userName: '甲',
    content: '在吗',
    mentioned: true,
    addressed: true,
    attachments: [],
    elements: [],
    author: {},
    receivedAt: Date.now(),
    eventId: 'e1',
    reply: async (text) => {
      replyCalls += 1;
      /** 抛错的那一次不算「用户收到了」：失败的正文不该出现在收到的文字里 */
      if (replyFailFirst && replyCalls === 1) throw new Error('模拟正文发送失败');
      replies.push(String(text));
      return { id: `r${replyCalls}` };
    },
    replyNow: async (text) => msg.reply(text),
    flushReplies: async () => {},
    retract: async () => {},
    replyMarkdown: undefined,
    /**
     * 模拟框架 replyAuto 的「降级」出口：框架内部发了正文 + 独立图，
     * 但返回 null，只通过 onResult 上报 mode:'fallback'。
     */
    replyAuto: autoFallback
      ? async (text, opts = {}) => {
        replies.push(String(text));
        opts?.onResult?.({ mode: 'fallback', images: 1 });
        return null;
      }
      : undefined,
    replyVoice: async (file, opts = {}) => {
      voiceCalls.push({ file, opts });
      if (voiceMode === 'throw') throw new Error('模拟语音抛错');
      if (voiceMode === 'ok') return { id: 'v1' };
      if (voiceMode === 'null-with-error') {
        opts.onError?.(new Error('模拟明确失败'));
        return null;
      }
      if (voiceMode === 'null-silent') return null;
      return null;
    },
  };
  if (voiceMode === 'no-api') delete msg.replyVoice;

  const origFetch = globalThis.fetch;
  const replyRoute = () => routes['/reply'];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const json = async () => ({});
    if (u.endsWith('/capabilities')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, tts: { enabled: true, configured: true } }) };
    }
    if (u.endsWith('/tts')) {
      if (ttsFail) {
        return { ok: false, status: 500, json: async () => ({ message: '宿主合成失败' }), text: async () => '' };
      }
      const b = wavBytes();
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'audio/wav' },
        arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length),
      };
    }
    if (u.endsWith('/inbound')) {
      const body = JSON.parse(init.body);
      const id = body.id;
      const token = body.reply?.token;
      const parts = modelParts ?? [modelText];
      for (let i = 0; i < parts.length; i++) {
        await replyRoute()({
          body: { id, token, text: parts[i], done: i === parts.length - 1 },
          json: (code, data) => ({ code, data }),
        });
      }
      return { ok: true, status: 200, text: async () => '', json };
    }
    return { ok: true, status: 200, json, text: async () => '' };
  };

  try {
    plugin.setup(ctx);
    await handlers.message(msg);
  } finally {
    globalThis.fetch = origFetch;
  }
  return { replies, voiceCalls, warns };
}

/** 拼一条模型回复：正文 + 可选的 <<say:>> */
const line = (body, sayText) => (sayText ? `${body} <<say: ${sayText}>>` : body);

console.log('--- say 回退：正文与「已说过」判定 ---');

{
  const r = await runScenario({
    modelText: line('早点睡呀', '早点睡呀'),
    ttsFail: true,
  });
  ok('正文已送达 say 文本 → 语音合成失败也不重复发',
    r.replies.length === 1 && r.replies[0].includes('早点睡呀'),
    JSON.stringify(r.replies));
}

{
  const r = await runScenario({
    modelText: line('晚安', '早点睡呀'),
    ttsFail: true,
  });
  ok('正文不含 say 文本 → 合成失败补发文字',
    r.replies.some((t) => t === '早点睡呀'),
    JSON.stringify(r.replies));
}

{
  /**
   * 这一条是「遮蔽 bug」的照妖镜：修之前按「打算发的 body」推断，
   * 正文含 say 文本就算已说过；正文其实发送失败，用户什么都没收到，
   * 语音合成又失败 → 零输出。修之后只认真实送达的回调，必须补发。
   */
  const r = await runScenario({
    modelText: line('早点睡呀', '早点睡呀'),
    ttsFail: true,
    replyFailFirst: true,
  });
  ok('正文发送失败（没真送达）→ 仍然补发文字',
    r.replies.filter((t) => t === '早点睡呀').length === 1,
    JSON.stringify(r.replies));
}

console.log('--- say 回退：带图降级路径 ---');

{
  /**
   * `sendAutoReply` 降级时框架内部已经把正文发出去了，但 replyAuto 返回
   * null，原来只有 `if (r) reportText(text)` 会漏掉这次上报。
   * 不上报 → saidAlready 没置位 → 语音一失败就再补发一遍，用户收到两份。
   */
  const r = await runScenario({
    modelText: '早点睡呀 <<image: C:/a.png>> <<say: 早点睡呀>>',
    ttsFail: true,
    autoFallback: true,
  });
  ok(
    'sendAutoReply 降级发了正文 → 语音失败不再重复补发',
    r.replies.length === 1 && !r.replies.includes('早点睡呀'),
    JSON.stringify(r.replies),
  );
}

console.log('--- say 回退：replyVoice 三态与抛错 ---');

for (const [mode, shouldFallback, name] of [
  ['ok', false, '返回真值 → 不补发'],
  ['null-with-error', true, 'null + onError（明确失败）→ 补发文字'],
  ['null-silent', false, 'null 且无 onError（可能已送达）→ 不补发，避免收到两份'],
  ['throw', true, '抛错被就地接住 → 补发文字，且整轮不掉进外层 catch'],
  ['no-api', true, '框架没有 replyVoice → 明确降级成文字'],
]) {
  const r = await runScenario({ modelText: line('晚安', '早点睡呀'), voiceMode: mode });
  const fellBack = r.replies.some((t) => t === '早点睡呀');
  ok(name, fellBack === shouldFallback, JSON.stringify(r.replies));
  if (mode === 'throw') {
    ok('抛错场景没有走到外层「调用失败」', !r.warns.some((w) => w.includes('调用失败')), r.warns.join(' | '));
  }
  if (mode !== 'no-api') {
    ok(`${mode}: 真的调用过 replyVoice`, r.voiceCalls.length === 1, String(r.voiceCalls.length));
  }
}

console.log('--- say 回退：预算时机 ---');

{
  /**
   * 群聊预算 5，先用 4 段正文打到只剩 1 格。
   * 合成失败一个 QQ 请求都没发，不该先把这最后一格扣掉——
   * 修之前 budget 在 synthesize 之前就 -=1，降级文字因此发不出去。
   */
  const r = await runScenario({
    modelParts: ['第一段', '第二段', '第三段', '第四段 <<say: 早点睡呀>>'],
    ttsFail: true,
  });
  ok('预算只剩 1 格、合成失败 → 仍能补发文字',
    r.replies.includes('早点睡呀'),
    JSON.stringify(r.replies));
}

console.log(`\n${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  console.error(fails.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);

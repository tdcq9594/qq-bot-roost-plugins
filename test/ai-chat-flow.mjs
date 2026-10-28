/**
 * ai-chat 的「流程层」测试：入站整形 / 出站整形 / 回话通道 / webhook 端到端。
 *
 * 跟 ai-chat.mjs 的分工：
 *   ai-chat.mjs      测适配器怎么拼请求（openai 那一层）
 *   ai-chat-flow.mjs 测「消息进来 → 整形 → 交给宿主 → 宿主回话 → 发出去」这条链
 *
 * 跑法：
 *   node test/ai-chat-flow.mjs
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, '..', 'plugins', 'ai-chat');
const load = (rel) => import(pathToFileURL(path.join(PLUGIN, rel)));

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

const { buildUserContent, hostPayload } = await load('inbound.js');
const { textOf } = await load('decide.js');
const { splitText, planChunks, MAX_CHUNK, MAX_CHUNKS } = await load('outbound.js');
const { createBridge } = await load('adapter/bridge.js');
const { createAdapter } = await load('adapter/index.js');

const baseConf = (over = {}) => () => ({
  adapter: 'openai',
  apiKey: 'sk-test',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  maxTokens: 512,
  temperature: 0.7,
  thinking: false,
  reasoningEffort: 'high',
  hostUrl: '',
  dshUrl: 'http://127.0.0.1:17321',
  publicUrl: 'http://127.0.0.1:8080',
  ...over,
});

/* ---------------- 入站整形 ---------------- */

{
  const voice = {
    kind: 'group',
    chatId: 'g1',
    content: '',
    attachments: [{ type: 'voice', asrText: '今天几号' }],
    elements: [],
  };
  // ASR 现在由 textOf 放进正文（以前是 describeAttachments 拼进去的），
  // 两条路都要保证「模型能看到转写内容」
  ok('入站: textOf 把语音 ASR 当成文本', textOf(voice) === '今天几号', textOf(voice));
  ok('入站: 语音的官方 ASR 进了内容', buildUserContent(voice, textOf(voice)).includes('今天几号'));
  ok('入站: 语音标记不重复 ASR', !buildUserContent(voice, textOf(voice)).includes('转成文字是'));

  const noAsr = { ...voice, attachments: [{ type: 'voice' }] };
  ok('入站: 语音没转出文字也要说清楚', /没能转成文字/.test(buildUserContent(noAsr, '')));

  const quoted = { ...voice, attachments: [], quoted: '上一条说的是什么' };
  ok('入站: 引用原文带上', buildUserContent(quoted, '这个').includes('上一条说的是什么'));

  const record = { ...voice, attachments: [], elements: [{ type: 'chatRecord', content: 'A: 1\nB: 2' }] };
  ok('入站: 合并转发的内容带上', buildUserContent(record, '').includes('A: 1'));

  const arkMsg = { ...voice, attachments: [], elements: [], ark: { title: '一个视频标题' } };
  ok('入站: 卡片标题带上', buildUserContent(arkMsg, '').includes('一个视频标题'));

  const image = { ...voice, attachments: [{ type: 'image', url: 'https://x/1.png' }] };
  ok('入站: 图片给了地址', buildUserContent(image, '').includes('https://x/1.png'));

  ok('入站: 全空也有兜底文案', buildUserContent({ attachments: [], elements: [] }, '').length > 0);
  ok(
    '入站: 用户自己说的话排在最前',
    buildUserContent({ attachments: [{ type: 'image', url: 'u' }], elements: [] }, '看图').startsWith('看图'),
  );

  // 结构化 payload（给 webhook/dsh 用）
  const p = hostPayload(
    {
      kind: 'group',
      chatId: 'g1',
      groupId: 'g1',
      userId: 'u1',
      userName: '小明',
      content: '看图',
      quoted: '',
      attachments: [{ type: 'voice', asrText: '嗨', wavUrl: 'https://x/a.wav', raw: { auth_token: 'SECRET' } }],
      elements: [],
    },
    { id: 'e1', token: 'tk', replyUrl: 'http://h/reply', expiresAt: 1, history: [{ role: 'user', content: 'hi' }] },
  );
  ok('payload: 带 id/token/回话地址', p.id === 'e1' && p.reply.token === 'tk' && p.reply.url === 'http://h/reply');
  ok('payload: 语音 ASR 与 WAV 都在', p.attachments[0].asrText === '嗨' && p.attachments[0].wavUrl === 'https://x/a.wav');
  ok('payload: 不泄漏 raw', !JSON.stringify(p).includes('SECRET'));
}

/* ---------------- 出站整形 ---------------- */

{
  ok('出站: 短文本不切', splitText('你好').length === 1);
  ok('出站: 空文本返回空数组', splitText('').length === 0);

  const long = 'a'.repeat(MAX_CHUNK * 2 + 10);
  ok('出站: 超长会切段', splitText(long).length >= 3, `切成 ${splitText(long).length} 段`);

  const code = `说明\n\`\`\`js\n${'x\n'.repeat(Math.ceil(MAX_CHUNK / 2))}\`\`\`\n结尾`;
  const parts = splitText(code);
  const fencesEven = parts.every((s) => (s.match(/```/g) ?? []).length % 2 === 0);
  ok('出站: 代码块不会被拦腰截断', parts.length >= 2 && fencesEven, `切成 ${parts.length} 段`);

  const huge = 'a'.repeat(MAX_CHUNK * 10);
  ok('出站: 段数封顶', planChunks(huge).length === MAX_CHUNKS, `实际 ${planChunks(huge).length}`);
  ok('出站: 封顶时告诉用户后面还有', /没发出来/.test(planChunks(huge).at(-1)));
}

/* ---------------- 回话通道 ---------------- */

{
  const b = createBridge({ ttlMs: 500 });
  const e = b.create();
  ok('桥: 事件带 id 与一次性令牌', Boolean(e.id && e.token) && e.id !== e.token);

  ok('桥: 令牌不对被拒', b.handleReply({ id: e.id, token: 'wrong', text: 'x' }).code === 403);
  ok('桥: 没有这个事件返回 404', b.handleReply({ id: 'nope', token: e.token, text: 'x' }).code === 404);

  b.handleReply({ id: e.id, token: e.token, text: '第一段', done: false });
  ok('桥: done:false 时先不收尾', b.size === 1);
  b.handleReply({ id: e.id, token: e.token, text: '第二段', done: true });
  const out = await e.promise;
  ok('桥: 分段拼成一条', out.text === '第一段\n第二段', JSON.stringify(out.text));
  /**
   * 分段要**原样**交出去。
   *
   * `text` 是拼好的全文，交给 `planChunks` 的话短的两段会被合并成一条，
   * 模型对"发几条"的控制就失效了。所以调用方要能拿到原始分段。
   */
  ok(
    '桥: 分段原样带出去（text 拼好，parts 保留原样）',
    Array.isArray(out.parts) && out.parts.length === 2 && out.parts[0] === '第一段',
    JSON.stringify(out.parts),
  );
  ok('桥: 收尾后清掉挂起项', b.size === 0);
  b.dispose();
}

{
  const b = createBridge({ ttlMs: 60 });
  const e = b.create();
  /**
   * 桥的定时器是 unref 的（生产上不该拖住进程退出），
   * 测试里没有别的句柄，所以要自己撑一个，否则事件循环直接空了。
   */
  const keep = setTimeout(() => {}, 400);
  let err = null;
  try {
    await e.promise;
  } catch (x) {
    err = x;
  }
  clearTimeout(keep);
  ok('桥: 宿主不回话会超时报错', /没回话/.test(err?.message ?? ''), err?.message ?? '');
  b.dispose();
}

{
  const b = createBridge({ ttlMs: 5000 });
  const ac = new AbortController();
  const e = b.create({ signal: ac.signal });
  ac.abort();
  let err = null;
  try {
    await e.promise;
  } catch (x) {
    err = x;
  }
  ok('桥: 用户 /停止 能中断等待', err?.name === 'AbortError');
  b.dispose();
}

{
  // 收到半截就超时：把半截交出去，比直接报错强
  const b = createBridge({ ttlMs: 80 });
  const e = b.create();
  const keep = setTimeout(() => {}, 400);
  b.handleReply({ id: e.id, token: e.token, text: '半截', done: false });
  const out = await e.promise;
  clearTimeout(keep);
  ok('桥: 只有半截时交半截', out.text === '半截');
  b.dispose();
}

/* ---------------- webhook 端到端 ---------------- */

{
  const bridge = createBridge({ ttlMs: 2000 });
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => '' };
  };

  const a = createAdapter({
    conf: baseConf({ dshUrl: 'http://host' }),
    bridge,
    publicUrl: () => 'http://127.0.0.1:8080',
    log: () => {},
  });

  const msg = {
    kind: 'group',
    chatId: 'g1',
    groupId: 'g1',
    userId: 'u1',
    userName: '小明',
    content: '你好',
    quoted: '',
    attachments: [{ type: 'voice', asrText: '嗨' }],
    elements: [],
  };

  const pending = a.chat({
    messages: [
      { role: 'system', content: '人设' },
      { role: 'user', content: '你好' },
    ],
    msg,
    chat: { kind: 'group', chatId: 'g1' },
  });

  await new Promise((r) => setTimeout(r, 30));
  const sent = calls[0];

  ok('dsh: 推到宿主的 /inbound', sent?.url === 'http://host/inbound', sent?.url ?? '没发出');
  ok(
    'dsh: 带一次性令牌与回话地址',
    Boolean(sent?.body.reply?.token) && sent.body.reply.url.includes('/api/plugins/ai-chat/r/reply'),
  );
  ok('dsh: 语音 ASR 传给了宿主', sent?.body.attachments?.[0]?.asrText === '嗨');
  ok('dsh: history 里去掉了 system', (sent?.body.history ?? []).every((m) => m.role !== 'system'));
  ok('dsh: 标注了适配器', sent?.body.adapter === 'dsh');

  const r = bridge.handleReply({ id: sent.body.id, token: sent.body.reply.token, text: '在呢' });
  const out = await pending;
  globalThis.fetch = orig;
  bridge.dispose();

  ok('webhook: 回话被接受', r.code === 200);
  ok('webhook: 拿到宿主的回复', out.text === '在呢', out.text);
  ok('webhook: 只有一段时 parts 为 null（走老的切段路径）', out.parts === null, JSON.stringify(out.parts));
}

{
  /**
   * 多段回话：宿主用 `qq_send` 逐段发（`done:false`），适配器要把**原始分段**
   * 带出去，而不是只给拼好的全文——否则短的两段会被 `planChunks` 合并成一条，
   * 模型对"发几条"的控制就白费了。
   */
  const bridge = createBridge({ ttlMs: 2000 });
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => '' };
  };

  const a = createAdapter({
    conf: baseConf({ dshUrl: 'http://host' }),
    bridge,
    publicUrl: () => 'http://127.0.0.1:8080',
    log: () => {},
  });

  const msg = {
    kind: 'c2c',
    chatId: 'u1',
    userId: 'u1',
    userName: '主人',
    content: '在吗',
    quoted: '',
    attachments: [],
    elements: [],
  };

  const pending = a.chat({
    messages: [{ role: 'user', content: '在吗' }],
    msg,
    chat: { kind: 'c2c', chatId: 'u1' },
  });

  await new Promise((r) => setTimeout(r, 30));
  const sent = calls[0];

  bridge.handleReply({ id: sent.body.id, token: sent.body.reply.token, text: '在的', done: false });
  bridge.handleReply({ id: sent.body.id, token: sent.body.reply.token, text: '刚忙完', done: false });
  // 宿主最后用空文本收尾（只发过话、不再补正文）
  bridge.handleReply({ id: sent.body.id, token: sent.body.reply.token, text: '', done: true });

  const out = await pending;
  globalThis.fetch = orig;
  bridge.dispose();

  ok('dsh: 多段时 text 仍是拼好的全文', out.text === '在的\n刚忙完', JSON.stringify(out.text));
  ok(
    'dsh: 多段时 parts 保留原样（2 段）',
    Array.isArray(out.parts) && out.parts.length === 2 && out.parts[1] === '刚忙完',
    JSON.stringify(out.parts),
  );
  ok('dsh: 空文本收尾不产生空段', (out.parts ?? []).every((p) => p.length > 0));
}

{
  // 宿主连不上：要给一句人话，不能抛 ECONNREFUSED
  const bridge = createBridge({ ttlMs: 500 });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  const a = createAdapter({
    conf: baseConf({ adapter: 'webhook', hostUrl: 'http://down' }),
    explainHttp: (s) => `HTTP_${s}`,
    bridge,
    publicUrl: () => 'http://127.0.0.1:8080',
  });
  let err = null;
  try {
    await a.chat({ messages: [], msg: { chatId: 'g1', attachments: [], elements: [] } });
  } catch (e) {
    err = e;
  }
  globalThis.fetch = orig;
  bridge.dispose();
  ok('webhook: 连不上宿主时说人话', /连不上宿主/.test(err?.message ?? ''), err?.message ?? '');
}

{
  // 没填地址：早点说清楚
  const bridge = createBridge({ ttlMs: 500 });
  const a = createAdapter({
    // 地址留空：应该立刻报错，而不是去连一个默认地址
    conf: baseConf({ dshUrl: '' }),
    bridge,
    publicUrl: () => 'http://127.0.0.1:8080',
  });
  let err = null;
  try {
    await a.chat({ messages: [], msg: { chatId: 'g1', attachments: [], elements: [] } });
  } catch (e) {
    err = e;
  }
  bridge.dispose();
  ok('dsh: 没填地址时提示清楚', /还没填宿主的接收地址/.test(err?.message ?? ''), err?.message ?? '');
}

/* ---------------- 富媒体 ---------------- */

{
  const { sendMedia, isRemote, MAX_MEDIA } = await load('outbound.js');
  const calls = [];
  const msg = {
    replyImage: async (src, o) => { calls.push(['img', src, o.local]); return { ok: 1 } },
    replyVoice: async (src, o) => { calls.push(['voice', src, o.local]); return { ok: 1 } },
  };

  const n = await sendMedia(msg, [
    { type: 'image', value: 'https://x/a.png' },
    { type: 'image', value: 'D:/pics/b.jpg' },
    { type: 'voice', value: '/tmp/c.silk' },
  ]);
  ok('媒体: 三个都发了', n === 3, String(n));
  ok('媒体: 网址走远程', calls[0][2] === false);
  ok('媒体: 本地路径走 local', calls[1][2] === true);
  ok('媒体: 语音走 replyVoice', calls[2][0] === 'voice');

  // 模型有文件工具，能发任何文件——扩展名白名单是最后一道闸
  const logs = [];
  const n2 = await sendMedia(msg, [
    { type: 'image', value: '/etc/passwd' },
    { type: 'image', value: 'a.env' },
  ], { log: (m) => logs.push(m) });
  ok('媒体: 非图片扩展名被拒', n2 === 0 && logs.length === 2, logs.join(' | '));

  const n3 = await sendMedia(msg, Array.from({ length: 6 }, (_, i) => ({ type: 'image', value: `a${i}.png` })));
  ok('媒体: 数量封顶', n3 === MAX_MEDIA, String(n3));

  ok('媒体: 识别网址', isRemote('http://a/b.png') === true && isRemote('D:/a.png') === false);
}

/* ---------------- 按钮 ---------------- */

{
  const { buildKeyboard } = await load('outbound.js');

  const k = buildKeyboard([
    { label: '点赞', data: '点赞' },
    { label: '看运势', data: '今天运势怎么样' },
    { label: '换个话题', data: '换个话题吧' },
  ]);
  ok('按钮: 两行（2+1）', k?.content?.rows?.length === 2, String(k?.content?.rows?.length));
  ok('按钮: 第一行两个', k.content.rows[0].buttons.length === 2);
  ok('按钮: 用指令型 action', k.content.rows[0].buttons[0].action.type === 2);
  ok('按钮: 所有人可点', k.content.rows[0].buttons[0].action.permission.type === 0);
  ok('按钮: data 是点了之后发的话', k.content.rows[0].buttons[1].action.data === '今天运势怎么样');

  const many = buildKeyboard(Array.from({ length: 8 }, (_, i) => ({ label: `b${i}`, data: `d${i}` })));
  ok('按钮: 最多四个', many.content.rows.reduce((n, r) => n + r.buttons.length, 0) === 4);

  ok('按钮: 空的不生成 keyboard', buildKeyboard([]) === null && buildKeyboard(null) === null);
}

/* ---------------- 宿主 payload ---------------- */

{
  const { hostPayload } = await load('inbound.js');
  const base = { kind: 'group', chatId: 'g1', content: '你好', userId: 'u1', userName: '小明' };
  const opt = { id: 'e1', token: 't', replyUrl: 'http://127.0.0.1:1/r', expiresAt: Date.now() + 1000 };

  const p = hostPayload(base, { ...opt, system: '你是小栖' });
  ok('宿主: payload 带 system', p.system === '你是小栖');
  ok('宿主: 没给 system 就是空串', hostPayload(base, opt).system === '');

  // 这条很关键：system 里写着动作标记的契约，丢了模型就不知道有 <<skip>> <<button>> 这些
  ok('宿主: system 不是 undefined（宿主会 String 它）', typeof hostPayload(base, opt).system === 'string');
}

/**
 * 合并窗口攒过几句时，交给宿主的必须是 `batch.text` 而不是 `msg.content`。
 *
 * 这个 bug 的表现很隐蔽：单条消息一切正常，只有连着发几句（合并窗口内）
 * 才会丢——而「在吗」→「问你个事」→「报错怎么办」正是最需要完整上下文的场景。
 * 宿主那边只看到最后一句，前面全当没说。
 */
{
  const { hostPayload } = await load('inbound.js');
  const base = { kind: 'group', chatId: 'g1', content: '报错怎么办', userId: 'u1', userName: '小红' };
  const opt = { id: 'e1', token: 't', replyUrl: 'http://127.0.0.1:1/r', expiresAt: Date.now() + 1000 };
  const said = '小明(AAA111111111)：在吗\n小红(BBB222222222)：问你个事\n小红(BBB222222222)：报错怎么办';

  const p = hostPayload(base, { ...opt, said, batch: { multi: true, count: 3 } });
  ok('宿主: 合并批次用 batch.text 当正文', p.text.includes('在吗'), p.text.slice(0, 40));
  ok('宿主: rendered 也带上前面几句', p.rendered.includes('问你个事'));
  ok('宿主: 多人批次标了 multi（宿主据此不再贴外层标签）', p.batch?.multi === true);

  const one = hostPayload(base, { ...opt, batch: { multi: false, count: 1 } });
  ok('宿主: 单条不带 batch 字段', one.batch === undefined);
  ok('宿主: 单条仍然用 msg.content', one.text === '报错怎么办');
}

/* ---------------- 出站：立刻发 vs 攒批 ---------------- */

{
  /**
   * 这两条是「多段回话」能不能成立的关键。
   *
   * 框架的 `msg.reply` 是攒批的（`src/message.js` 的 `replyBuf`，处理结束才合并成一条），
   * 而 `qq_send` 逐段发要的是**几条独立消息**——所以多段必须走 `msg.replyNow()`。
   * 这里用一个假 msg 把两条路分开记，验证 `immediate` 真的切过去了。
   */
  const { sendReply } = await load('outbound.js');

  const makeMsg = (withNow = true) => {
    const buf = []; // 攒批
    const now = []; // 立刻发
    const m = {
      kind: 'group',
      chatId: 'g1',
      reply: async (t) => {
        buf.push(String(t));
        return null;
      },
      replyMarkdown: async (md) => {
        now.push(String(md?.content ?? ''));
        return { id: 'md1' };
      },
    };
    if (withNow) {
      m.replyNow = async (t) => {
        now.push(String(t));
        return { id: 'n1' };
      };
    }
    return { m, buf, now };
  };

  const a = makeMsg();
  await sendReply(a.m, '第一句', { immediate: true });
  ok('出站: immediate 走 replyNow（不进攒批）', a.now.length === 1 && a.buf.length === 0, `now=${a.now.length} buf=${a.buf.length}`);

  const b = makeMsg();
  await sendReply(b.m, '第一句', {});
  ok('出站: 不给 immediate 仍走攒批', b.buf.length === 1 && b.now.length === 0, `now=${b.now.length} buf=${b.buf.length}`);

  /**
   * 老宿主（没实现 `replyNow`）不能因为多了这个选项就崩。
   * 降级到 `reply` 至少还能发出去，只是会被合并。
   */
  const c = makeMsg(false);
  await sendReply(c.m, '第一句', { immediate: true });
  ok('出站: 没有 replyNow 时降级到 reply', c.buf.length === 1, `buf=${c.buf.length}`);

  /**
   * 带按钮时必须一条发完，走 `replyMarkdown`——它本身就是立刻发的
   * （内部先 `flushReplies()` 再 send），所以带按钮的分段不受攒批影响。
   */
  const d = makeMsg();
  await sendReply(d.m, '点这个', { keyboard: { content: { rows: [] } }, immediate: true });
  ok('出站: 带按钮走 markdown（本身就立刻发）', d.now.length === 1 && d.buf.length === 0, `now=${d.now.length} buf=${d.buf.length}`);
}

/* ---------------- 汇总 ---------------- */

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.log('失败项:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exitCode = 1;
}

/**
 * 图床插件（示例）
 * ================
 *
 * 把图片转存到你自己的图床，拿回一个长期有效的链接。
 *
 * **为什么图床要做成插件**：主流图床要么要第三方 SDK，要么要签名算法，
 * 塞进框架就破了「零依赖」。做成插件，用的人装，不用的人不受影响。
 *
 * 支持两种上传方式（配置里选）：
 *
 *   base64   POST JSON：{ "image": "<base64>", "name": "a.png" }
 *            大多数自建图床（lsky、easyimage、chevereto 的 API 模式）都吃这个
 *   multipart 标准表单上传，字段名可配
 *
 * 返回值的取法用 `resultPath` 指定，比如 `data.url` / `url` / `result[0].src`。
 *
 * 用法：
 *   /imgbed <图片链接>     转存
 *   /imgbed config         看当前配置
 */

/** 从 { a: { b: [ { c: 1 } ] } } 里按 'a.b[0].c' 取值 */
export function pick(obj, path) {
  if (!path) return obj;
  const parts = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** 猜一个文件名，图床一般靠后缀判断类型 */
export function fileNameFromUrl(url) {
  try {
    const p = new URL(url).pathname;
    const base = p.split('/').filter(Boolean).pop() || 'image';
    return /\.(png|jpe?g|gif|webp|bmp)$/i.test(base) ? base : `${base}.png`;
  } catch {
    return 'image.png';
  }
}

export default {
  id: 'imgbed',
  name: '图床',
  version: '0.1.0',
  description: '把图片转存到自己的图床，支持 base64 / multipart 两种上传方式',

  config: {
    /** 上传地址，留空时命令只提示怎么配 */
    endpoint: '',
    /** base64 | multipart */
    type: 'base64',
    /** type=base64 时 JSON 里放图片数据的字段名 */
    base64Field: 'image',
    /** type=multipart 时表单字段名 */
    fileField: 'file',
    /** 需要鉴权就填，会作为 Authorization 头 */
    token: '',
    /** 从响应里取链接的路径，如 data.url */
    resultPath: 'data.url',
    /** 单张图片大小上限（MB） */
    maxMb: 10,
  },

  setup(ctx) {
    const counters = { ok: 0, fail: 0, bytes: 0 };
    const pushDash = () =>
      ctx.setDashboard({
        metrics: [
          { label: '转存成功', value: counters.ok, unit: '张' },
          { label: '失败', value: counters.fail, unit: '次' },
          { label: '累计流量', value: (counters.bytes / 1024 / 1024).toFixed(1), unit: 'MB' },
        ],
        note: ctx.config.endpoint ? `图床：${ctx.config.endpoint}` : '还没配置图床地址',
      });
    pushDash();

    /** 下载原图。不用 ctx.api，那是 QQ 的；这里要访问任意 URL */
    async function download(url, maxMb) {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') || 0);
      if (len && len > maxMb * 1024 * 1024) {
        throw new Error(`图片太大（${(len / 1024 / 1024).toFixed(1)}MB，上限 ${maxMb}MB）`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxMb * 1024 * 1024) {
        throw new Error(`图片太大（${(buf.length / 1024 / 1024).toFixed(1)}MB，上限 ${maxMb}MB）`);
      }
      return buf;
    }

    async function upload(url) {
      const c = ctx.config;
      if (!c.endpoint) throw new Error('还没配置图床地址，先发 /imgbed config 看怎么配');

      const buf = await download(url, c.maxMb || 10);
      const name = fileNameFromUrl(url);
      const headers = {};
      if (c.token) headers.Authorization = c.token;

      let res;
      if (c.type === 'multipart') {
        // 手写 multipart，不引 form-data
        const boundary = `----roost${Date.now().toString(16)}`;
        const head = Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${c.fileField || 'file'}"; filename="${name}"\r\n` +
            `Content-Type: application/octet-stream\r\n\r\n`,
        );
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
        const body = Buffer.concat([head, buf, tail]);
        headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
        res = await fetch(c.endpoint, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(60000),
        });
      } else {
        headers['Content-Type'] = 'application/json';
        res = await fetch(c.endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            [c.base64Field || 'image']: buf.toString('base64'),
            name,
          }),
          signal: AbortSignal.timeout(60000),
        });
      }

      const text = await res.text();
      if (!res.ok) throw new Error(`图床返回 HTTP ${res.status}：${text.slice(0, 120)}`);

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`图床返回的不是 JSON：${text.slice(0, 120)}`);
      }

      const link = pick(data, c.resultPath);
      if (!link) {
        throw new Error(`没在响应里找到 ${c.resultPath}，检查 resultPath 配置`);
      }

      counters.ok += 1;
      counters.bytes += buf.length;
      pushDash();
      return { link: String(link), size: buf.length };
    }

    ctx.command('imgbed <链接|config>', { desc: '把图片转存到图床' }, async (msg) => {
      const arg = String(msg.args[0] ?? '').trim();

      if (!arg || arg === 'config') {
        const c = ctx.config;
        const lines = [
          '图床配置（在面板「插件 → 图床 → 设置」里改）',
          `  上传地址 endpoint   ${c.endpoint || '（未配置）'}`,
          `  上传方式 type       ${c.type}`,
          `  返回路径 resultPath ${c.resultPath}`,
          '',
          '用法：/imgbed <图片链接>',
        ];
        return msg.reply(lines.join('\n'));
      }

      if (!/^https?:\/\//i.test(arg)) {
        return msg.reply('需要一个 http(s) 图片链接，比如 /imgbed https://example.com/a.png');
      }

      try {
        const r = await upload(arg);
        return msg.reply(`已转存（${(r.size / 1024).toFixed(0)} KB）\n${r.link}`);
      } catch (e) {
        counters.fail += 1;
        pushDash();
        return msg.reply(`转存失败：${e.message}`);
      }
    });

    ctx.menu('图床', [
      { text: '/imgbed <链接>', desc: '把图片转存到自己的图床' },
      { text: '/imgbed config', desc: '查看当前图床配置' },
    ]);
  },
};

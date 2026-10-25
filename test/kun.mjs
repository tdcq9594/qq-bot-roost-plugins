/**
 * 养鲲插件的测试
 * ================
 *
 * 为什么不在框架仓库里测：框架仓库的 `.gitignore` 排除了 `plugins/`，
 * 插件是「市场里装下来的运行内容」，不属于框架代码。把某个插件的断言
 * 塞进框架自检，会让框架测试依赖一个可能根本没装的插件——
 * 所以插件的测试跟着插件走，框架仓库只留 testkit（夹具）。
 *
 * 跑法：
 *   node test/kun.mjs
 *   ROOST_FRAMEWORK=/path/to/qq-bot-roost node test/kun.mjs
 *
 * 默认框架路径是 `../../bot`（本地两个仓库并排放的时候能直接跑）。
 * CI 里由 workflow checkout 框架到 .framework/ 再传这个环境变量。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRAMEWORK = process.env.ROOST_FRAMEWORK
  ? path.resolve(process.env.ROOST_FRAMEWORK)
  : path.resolve(HERE, '../../bot');

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}
function skip(name, why = '') {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name}${why ? '  ' + why : ''}`);
}

{

const { makeCtx, runCommand } = await import(pathToFileURL(path.join(FRAMEWORK, 'src/plugin/testkit.js')).href);

let plugin;
try {
  plugin = (await import('./../plugins/kun/index.js')).default;
} catch (e) {
  skip('养鲲: 插件加载失败', e.message);
  console.log('\n0/0 通过（跳过 1）');
  process.exit(0);
}

// 种子随机数：LCG，跨平台稳定
let seed = 20201025;
globalThis.__kunRng = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

const ctx = makeCtx({ id: 'kun', config: {} });
const G = 'g-kun';
const U1 = 'user1111';
const U2 = 'user2222';

/**
 * 剥掉 markdown 外壳，拿回「应该和原版一字不差」的纯文本。
 * 这条断言链是「不许改文本内容」的锁：加粗、@ 标签、零宽字符都剥掉之后，
 * 必须和原版文案完全相同。
 */
const stripMd = (s) =>
  String(s ?? '')
    .replace(/<qqbot-at-user id="([^"]+)" \/>/g, '<@$1>')
    // 可点击指令标签还原成它显示的文字
    .replace(/<qqbot-cmd-input[^>]*show="([^"]*)"[^>]*\/>/g, (_, show) => decodeURIComponent(show))
    .replace(/\*\*/g, '')
    .replace(/\u200B/g, '');

// 默认把 6 秒冷却清掉，让用例能连着发命令；冷却有专门的用例（keepCd）
const cmd = async (name, opts = {}) => {
  if (!opts.keepCd) {
    const key = `p:${opts.groupId ?? G}:${opts.userId ?? U1}`;
    await ctx.storage.update(key, (p) => (p ? { ...p, lu: 0 } : p));
  }
  // 新指令格式：@机器人 /kun <指令>（这里用 /kun 形式驱动）
  let tail = '';
  if (opts.content) {
    let c = String(opts.content).replace(/^\//, '').trim();
    if (c.startsWith(name)) c = c.slice(name.length).trim();   // 去掉重复的指令名
    if (c) tail = ' ' + c;
  }
  const r = await runCommand(plugin, 'kun', {
    content: `/kun ${name}${tail}`,
    userId: opts.userId ?? U1,
    groupId: opts.groupId ?? G,
    kind: opts.kind,
    ctx,
    mentioned: opts.mentioned,
    mentions: opts.mentions,
    raw: opts.raw,
  });
  r.plain = r.replies.map(stripMd);
  return r;
};

/* ---- 菜单：整段逐字 ---- */
{
  const r = await cmd('菜单');
  const replies = r.plain;
  const first = replies[0] ?? '';
  check('养鲲: 走的是 markdown 消息', (r.replies[0] ?? '').includes('**'), r.replies[0]?.slice(0, 40));
  check('养鲲: 菜单标题已加粗', (r.replies[0] ?? '').includes('**====命令菜单====**'), '');
  check('养鲲: 菜单第一行', first.startsWith('====命令菜单===='), first.slice(0, 30));
  check('养鲲: 菜单含出售', first.includes('\n*出售【起拍价】\n'));
  check('养鲲: 菜单含私聊标记说明', first.endsWith('带有（私）标记的指令可以私聊机器人使用'));
  check('养鲲: 菜单只有一条', replies.length === 1, `replies=${replies.length}`);
}

/* ---- 查阅属性：整段逐字 ---- */
{
  const { plain: replies } = await cmd('查阅属性');
  const t = replies[0] ?? '';
  check('养鲲: 属性表开头', t.startsWith('=====属性列表=====\n'), t.slice(0, 20));
  check('养鲲: 傲的描述', t.includes('傲：“◆无视对方属性”'));
  check('养鲲: 悲的描述', t.includes('悲：“◆初始体重为（当前榜一体重）+1000千克'));
  check('养鲲: BOSS 属性段', t.includes('----BOSS属性----\n♂魑：免疫强袭'));
}

/* ---- 查看群主指令 ---- */
{
  const { plain: replies } = await cmd('查看群主指令');
  check('养鲲: 群主指令首行', (replies[0] ?? '').startsWith('*OP/【QQ号】/【项目】/【数值】'), replies[0]?.slice(0, 20));
}

/* ---- 默认就是开启的（原版开关默认空=开） ---- */
{
  const { plain: replies } = await cmd('查询');
  check('养鲲: 没鲲开过也能查询（默认开启）', replies.length === 1, `replies=${replies.length}`);
}

/* ---- 鲲开：不 @ 机器人没反应 ---- */
{
  const { plain: replies } = await cmd('鲲开', { mentioned: false });
  check('养鲲: 鲲开不 @ 机器人无反应', replies.length === 0, `replies=${replies.length}`);
}

/* ---- 鲲开：@ 了但没权限 ---- */
{
  const { plain: replies } = await cmd('鲲开', { mentioned: true, raw: { author: { member_role: 'member' } } });
  check('养鲲: 鲲开无管理权限被拒', (replies[0] ?? '').includes('对不起，你没有管理权限！'), replies[0] ?? '');
}

/* ---- 鲲开：管理员 @ 机器人 → 开启 ---- */
{
  const { plain: replies } = await cmd('鲲开', { mentioned: true, raw: { author: { member_role: 'admin' } } });
  check(
    '养鲲: 鲲开成功文案',
    (replies[0] ?? '') === '开局一只鲲，进化全靠吞！\n游戏已开\n各位饲鲲主快来一试身手吧！',
    replies[0] ?? '',
  );
}

/* ---- 签到：第一次 ---- */
{
  const { plain: replies } = await cmd('签到');
  const t = replies[0] ?? '';
  check('养鲲: 签到成功首行', t.startsWith('<@' + U1 + '>签到成功！'), t.slice(0, 30));
  check('养鲲: 签到奖励结构', /\n获得奖励：\n\d+颗蛋\n\d+节操\n磨炼次数回复至30$/.test(t), t);
}

/* ---- 签到：重复 → 惩罚 ---- */
{
  const { plain: replies } = await cmd('签到');
  const t = replies[0] ?? '';
  check('养鲲: 重复签到扣 10', t.includes('请勿重复签到！') && t.includes('获得惩罚：节操-10'), t);
}

/* ---- 买蛋 2：10 节操 ---- */
{
  const { plain: replies } = await cmd('买蛋', { content: '/买蛋 2' });
  const t = replies[0] ?? '';
  check('养鲲: 买蛋成功', t.includes('送了你2颗蛋') && t.includes('节操-10'), t);
}

/* ---- 孵化 ---- */
{
  const { plain: replies } = await cmd('孵化');
  const t = replies[0] ?? '';
  check('养鲲: 孵化成功', /恭喜你获得一只(\S{0,2})属性\S+\n体重\d+千克/.test(t), t);
}

/* ---- 孵化：已有鲲 ---- */
{
  const { plain: replies } = await cmd('孵化');
  check('养鲲: 已有鲲再孵化被拒', (replies[0] ?? '').includes('你已经拥有一只鲲了，开始吞吧'), replies[0] ?? '');
}

/* ---- 查询 ---- */
{
  const { plain: replies } = await cmd('查询');
  const t = replies[0] ?? '';
  check('养鲲: 查询有蛋和节操', t.includes('=============\n蛋×') && t.includes('\n节操'), t.slice(0, 60));
  check('养鲲: 查询显示鲲和体重', /\n体重\d+\n/.test(t), t.slice(0, 50));
}

/* ---- 喂食 1 ---- */
{
  const { plain: replies } = await cmd('喂食', { content: '/喂食 1' });
  const t = replies[0] ?? '';
  check('养鲲: 喂食增重', /体重增加了\d+千克\n现体重为\d+千克/.test(t), t);
}

/* ---- 今日运势 ---- */
{
  const { plain: replies } = await cmd('今日运势');
  check('养鲲: 运势提示', (replies[0] ?? '').includes('砸蛋出道具概率=今日运势÷200×100%'), replies[0] ?? '');
}

/* ---- 冷却：连发第二条静默 ---- */
{
  await cmd('喂食', { content: '/喂食 1' });   // 第一条（助手已清冷却）
  const { plain: replies } = await cmd('喂食', { content: '/喂食 1', keepCd: true });  // 紧接着第二条
  check('养鲲: 6 秒内第二条被冷却吃掉', replies.length === 0, `replies=${replies.length}`);
}

/* ---- 渡劫：无属性被拒 ---- */
{
  // 把刚孵出来的鲲属性抹掉，绕过冷却直接测无属性分支
  await ctx.storage.update(`p:${G}:${U1}`, (p) => ({ ...p, a: '', lu: 0 }));
  const { plain: replies } = await cmd('渡劫');
  check('养鲲: 无属性不能渡劫', (replies[0] ?? '').includes('无属性的鲲无法渡劫！'), replies[0] ?? '');
}

/* ---- 幻化：没丹被拒 ---- */
{
  const { plain: replies } = await cmd('幻化');
  check('养鲲: 没幻化丹被拒', (replies[0] ?? '').includes('你没有幻化丹！'), replies[0] ?? '');
}

/* ---- 喝鸡汤：没鸡汤被拒 ---- */
{
  const { plain: replies } = await cmd('喝鸡汤');
  check('养鲲: 没鸡汤被拒', (replies[0] ?? '').includes('你没有鸡汤了！'), replies[0] ?? '');
}

/* ---- 复活：活着不能复活 ---- */
{
  const { plain: replies } = await cmd('复活');
  check('养鲲: 活着不能复活', (replies[0] ?? '').includes('老子还没死呢！'), replies[0] ?? '');
}

/* ---- 放生 ---- */
{
  const { plain: replies } = await cmd('放生');
  const t = replies[0] ?? '';
  check('养鲲: 放生成功', t.includes('功德无量！随喜赞叹！节操+（2）！'), t);
}

/* ---- 拍卖行全流程 ---- */
{
  // 给两人准备渡劫过的鲲
  await ctx.storage.update(`p:${G}:${U1}`, (p) => ({ ...p, n: '炎鲲★', a: '怒', w: 500, j: 200, li: 0, lu: 0 }));
  await ctx.storage.update(`p:${G}:${U2}`, (p) => ({ ...p, n: '雪鲲', a: '惰', w: 300, j: 200, li: 0, lu: 0, nm: '二号' }));
  let r = await cmd('出售', { content: '/出售 50' });
  check('养鲲: 上架成功', (r.plain[0] ?? '').includes('上架成功！') && (r.plain[0] ?? '').includes('起拍价50节操'), r.plain[0] ?? '');

  r = await cmd('出价', { content: '/出价 60', userId: U2 });
  check('养鲲: 出价成功', (r.plain[0] ?? '').includes('出价成功！') && (r.plain[0] ?? '').includes('当前竞价60'), r.plain[0] ?? '');

  r = await cmd('拍卖行');
  check('养鲲: 拍卖行展示', (r.plain[0] ?? '').includes('当前竞价：60'), r.plain[0] ?? '');

  r = await cmd('成交', { content: '/成交' });
  const t = r.plain[0] ?? '';
  check('养鲲: 成交文案', t.includes('交♂易成功！') && t.includes('售价60节操'), t);

  // 成交后：卖家拿到钱、买主拿到鲲
  const p1 = await ctx.storage.get(`p:${G}:${U1}`);
  const p2 = await ctx.storage.get(`p:${G}:${U2}`);
  check('养鲲: 卖家收款', p1.j === 260, `卖家节操=${p1.j}`);
  check('养鲲: 买家得鲲', p2.n === '炎鲲★' && p2.w === 500, `买主鲲=${p2.n} 重=${p2.w}`);
}

/* ---- 吞噬：对没有鲲的人 ---- */
{
  await ctx.storage.update(`p:${G}:${U1}`, (p) => ({ ...p, n: '炎鲲', a: '怒', w: 400, j: 100, lu: 0 }));
  await ctx.storage.update(`p:${G}:${U2}`, (p) => ({ ...p, n: '', lu: 0 }));
  const { plain: replies } = await cmd('吞噬', { content: `/吞噬 ${U2}`, mentions: [{ id: U2, isBot: false }] });
  check('养鲲: 吞无鲲者被拒', (replies[0] ?? '').includes('还没有鲲，快邀请他一起♂玩吧'), replies[0] ?? '');
}

/* ---- 吞噬：吞自己 ---- */
{
  await ctx.storage.update(`p:${G}:${U2}`, (p) => ({ ...p, n: '雪鲲', w: 100, lu: 0 }));
  await ctx.storage.update(`p:${G}:${U1}`, (p) => ({ ...p, lu: 0 }));
  const { plain: replies } = await cmd('吞噬', { content: `/吞噬 ${U1}`, mentions: [{ id: U1, isBot: false }] });
  check('养鲲: 吞自己被作者骂', (replies[0] ?? '').includes('你故意找麻烦是吧'), replies[0] ?? '');
}

/* ---- 吞噬：正常打一架 ---- */
{
  await ctx.storage.update(`p:${G}:${U1}`, (p) => ({ ...p, n: '炎鲲', a: '怒', w: 400, j: 100, lu: 0 }));
  await ctx.storage.update(`p:${G}:${U2}`, (p) => ({ ...p, n: '雪鲲', a: '', w: 100, lu: 0 }));
  const { plain: replies } = await cmd('吞噬', { content: `/吞噬 ${U2}`, mentions: [{ id: U2, isBot: false }] });
  const all = replies.join('\n');
  check('养鲲: 吞噬有结果', /吞噬成功！|吞噬失败！/.test(all), all.slice(0, 80));
  check('养鲲: 吞噬花了 1 节操', all.includes('剩余99节操'), all.slice(-60));
}

/* ---- BOSS ---- */
{
  await cmd('刷新BOSS', { raw: { author: { member_role: 'owner' } } });
  const { plain: replies } = await cmd('查询BOSS');
  const t = replies[0] ?? '';
  check('养鲲: BOSS 查询格式', /==今日BOSS==\n♂[魑魅魍魉]♂\n属性☆.+\n体重☆\d+千克/.test(t), t.slice(0, 60));
  check('养鲲: BOSS 带输出排行', t.includes('=输=出=排=行='), t.slice(-40));
}

/* ---- 阵亡名单 ---- */
{
  const { plain: replies } = await cmd('阵亡名单');
  check('养鲲: 阵亡名单格式', (replies[0] ?? '').startsWith('阵亡名单：\n'), replies[0] ?? '');
}

/* ---- 小游戏 ---- */
{
  const r1 = await cmd('小游戏开', { mentioned: true, raw: { author: { member_role: 'admin' } } });
  check('养鲲: 小游戏开启', (r1.plain[0] ?? '') === '小游戏已开！\n回复【*当前游戏】查看', r1.plain[0] ?? '');
  const r2 = await cmd('当前游戏');
  check('养鲲: 当前游戏有题目', /回复【\*=数值】来抢答/.test(r2.plain[0] ?? ''), (r2.plain[0] ?? '').slice(0, 40));
}

/* ---- OP 已取消 ---- */
{
  const { plain: replies } = await cmd('OP');
  check('养鲲: OP 已取消', (replies[0] ?? '') === 'OP指令已经取消！\n狗群主再也不能为所欲为啦！哈哈哈！', replies[0] ?? '');
}

/* ---- 私聊：未绑定 ---- */
{
  const { plain: replies } = await cmd('磨炼', { kind: 'c2c', content: '/磨炼 5', userId: 'user9999' });
  check('养鲲: 私聊未绑定被拒', (replies[0] ?? '').startsWith('请先【*绑定群 群号】'), replies[0] ?? '');
}

/* ---- 私聊：绑定后 ---- */
{
  const r = await cmd('绑定', { kind: 'c2c', content: `/绑定 ${G}`, userId: 'user9999' });
  check('养鲲: 绑定成功', (r.plain[0] ?? '') === `绑定群 ${G} 成功！`, r.plain[0] ?? '');
}

globalThis.__kunRng = undefined;

}

const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped).length;
console.log(`\n${results.length - failed.length - skipped}/${results.length - skipped} 通过` + (skipped ? `（跳过 ${skipped}）` : ''));
if (failed.length) {
  console.log('失败项: ' + failed.map((r) => r.name).join('、'));
  process.exit(1);
}

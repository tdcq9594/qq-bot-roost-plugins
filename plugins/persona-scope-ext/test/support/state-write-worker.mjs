// 并发写素材的子进程：和主进程同时 mutate，验证锁是否真的生效
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * 安全带：**只允许写临时目录**。
 * 之前有一次 env 没传对，子进程直接写进了用户真实素材目录（留下一张「未命名」卡）。
 * 测试污染真实数据比测试失败严重得多，这里硬拦。
 */
const dir = String(process.env.ROOST_LAUNCHER_DIR || '');
const { tmpdir } = await import('node:os');
const insideTemp = dir ? relative(resolve(tmpdir()), resolve(dir)) : '';
if (!dir || !insideTemp || insideTemp === '..' || insideTemp.startsWith(`..${sep}`) || isAbsolute(insideTemp)) {
  process.stderr.write(`拒绝写入非临时目录：${dir || '(空)'}\n`);
  process.exit(2);
}
process.env.ROOST_LAUNCHER_DIR = dir;
const { saveCard } = await import('../../lib/ops.mjs');

const name = process.argv[2] || '未命名';
// 抢跑的窗口：两个进程都在同一时刻开始
await new Promise((r) => setTimeout(r, 30));
const out = await saveCard({ name, text: `正文-${name}` });
process.stdout.write(JSON.stringify({ ok: out.ok, cards: out.cards.length }));

#!/usr/bin/env node
/**
 * 真画一张（要真接口、真密钥，会花钱）——手动联调用，**不进 CI**
 *
 *   # 用宿主里那份配置的等价环境变量：
 *   ROOST_EXT_CONFIG='{"baseUrl":"https://api.xxx/v1","model":"m"}' \
 *   ROOST_EXT_SECRET_APIKEY='sk-...' node test/live.mjs "一只橘猫"
 *
 * 画到系统临时目录而不是仓库里：仓库里的文件会被算进索引 sha256，
 * 多一张 png 等于把整份索引弄脏（`build-index --check` 立刻红）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readConfig, readyProblem, sizeFor } from '../lib/config.mjs';
import { textOf } from '../lib/errors.mjs';
import { createToolbox } from '../lib/tools.mjs';

const prompt = process.argv.slice(2).join(' ').trim() || '一只橘猫，简笔画';
const cfg = readConfig(process.env, (m) => console.error(`[config] ${m}`));

const why = readyProblem(cfg);
if (why) {
  console.error(`✗ ${why}`);
  console.error('  这个脚本读的是**当前 shell 的环境变量**，不是面板里存的那份。');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'imagegen-live-'));
const box = createToolbox({ cfg, dir, log: (m) => console.error(`[gen] ${m}`) });

console.log(`画：${prompt}`);
console.log(`尺寸：${sizeFor(cfg, {})}　接法：${cfg.provider === 'custom' ? '自定义接口' : 'OpenAI 兼容'}　模型：${cfg.model}`);
try {
  const text = await box.call('image_gen', { prompt });
  console.log(`\n${text}`);
} catch (e) {
  console.error(`\n✗ ${textOf(e)}`);
  process.exitCode = 1;
}

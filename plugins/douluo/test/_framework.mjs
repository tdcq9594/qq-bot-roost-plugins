/**
 * 找到框架的 testkit。
 *
 * 以前这里写死 `../../../src/plugin/testkit.js`——那只在**框架仓库内部**才解析得到，
 * 在插件仓库里跑必然 `ERR_MODULE_NOT_FOUND`。结果这 6 个测试从来没进过 CI，
 * 改了 douluo 的引擎/数据库也没有任何东西会红。
 *
 * 依次尝试：`ROOST_FRAMEWORK` → CI checkout 的 `.framework` → 同级的 `bot` 仓库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function frameworkRoot() {
  const tries = [
    process.env.ROOST_FRAMEWORK,
    path.resolve(HERE, '../../../.framework'),
    path.resolve(HERE, '../../../../bot'),
  ].filter(Boolean);

  /** 设了环境变量却指错，要直接报错：静默回落到别的框架会跑出假绿 */
  if (process.env.ROOST_FRAMEWORK && !fs.existsSync(path.join(process.env.ROOST_FRAMEWORK, 'src/plugin/testkit.js'))) {
    throw new Error(`ROOST_FRAMEWORK 指错了：${process.env.ROOST_FRAMEWORK} 下没有 src/plugin/testkit.js`);
  }

  for (const p of tries) {
    if (fs.existsSync(path.join(p, 'src/plugin/testkit.js'))) return path.resolve(p);
  }
  throw new Error(
    `找不到框架（试过：${tries.join('、')}）。设 ROOST_FRAMEWORK 指到 qq-bot-roost 目录`,
  );
}

/** 动态导入框架里的任意模块：路径要在运行时算，静态 import 做不到 */
export function loadFramework(rel) {
  return import(pathToFileURL(path.join(frameworkRoot(), rel)).href);
}

export function loadTestkit() {
  return loadFramework('src/plugin/testkit.js');
}

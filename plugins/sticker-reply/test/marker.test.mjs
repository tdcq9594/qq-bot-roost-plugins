/** 宿主契约集成：显式传 DSH_ROOST_DIR，使用真实解析器与模拟发送通道，不向 QQ 发消息。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const host = process.env.DSH_ROOST_DIR || '';
const skip = host ? false : '未设置 DSH_ROOST_DIR，跳过真实宿主契约测试';
const markers = host ? await import(pathToFileURL(join(host,'src/markers.js')).href) : null;
const outbound = host ? await import(pathToFileURL(join(host,'src/outbound-actions.js')).href) : null;
const IMG = join(tmpdir(), '表情 包', '比心.jpg');
const MARK = `<<image-alone: ${IMG}>>`;

test('宿主正则接受扩展图片标记', {skip}, () => {
  assert.ok(markers.markerRe('image-alone').exec(MARK));
});
test('中文、空格路径保持完整', {skip}, () => {
  const result = outbound.parseOutboundActions(MARK);
  assert.equal(result.actions[0].value,IMG);
});
test('全角冒号可解析', {skip}, () => {
  assert.ok(markers.markerRe('image-alone').exec(`<<image-alone： ${IMG}>>`));
});
test('纯标记被抽成一个下行动作，正文为空', {skip}, () => {
  const result=outbound.parseOutboundActions(MARK);
  assert.equal(result.text,'');
  assert.deepEqual(result.actions,[{type:'imageAlone',value:IMG}]);
});
test('反例：宿主会保留夹带文字，未承诺强制删字', {skip}, () => {
  const result=outbound.parseOutboundActions(`给你看 ${MARK} 好看吧`);
  assert.match(result.text,/给你看/); assert.match(result.text,/好看吧/);
});

function fakeRunner() {
  const counts={images:0,texts:0};
  const runner=outbound.createActionRunner({channel:()=>({
    send:async()=>{counts.texts++;return{ok:true,id:'text-1'};},
    sendFile:async()=>{counts.images++;return{ok:true,id:'image-1'};},
  })});
  return {counts,runner};
}
test('真实出站处理器：纯标记发一张图、零文字', {skip}, async()=>{
  const {counts,runner}=fakeRunner();
  await runner({text:MARK,scene:'group',target:'TEST-FIXTURE'});
  assert.deepEqual(counts,{images:1,texts:0});
});
test('真实出站处理器反例：模型加字则发图和文字', {skip}, async()=>{
  const {counts,runner}=fakeRunner();
  await runner({text:`开心！ ${MARK}`,scene:'group',target:'TEST-FIXTURE'});
  assert.deepEqual(counts,{images:1,texts:1});
});

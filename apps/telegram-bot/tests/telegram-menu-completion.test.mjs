import test from 'node:test';
import assert from 'node:assert/strict';
import { withTelegramMenuCompletion } from '../../../runtime/telegram-menu-completion.mjs';
const request = () => new Request('https://api.univeracademy.uz/api/v1/auth/telegram/link', {
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({init_data:'signed-fixture'})});
const env = {UA_TELEGRAM_MENU_SYNC_ENABLED:'true',UA_SESSION_POLICY:'{}',UA_TELEGRAM_BOT_TOKEN:'fixture'};
test('successful server login sends only verified Telegram ID to private hook', async()=>{
  const calls=[],jobs=[];
  const api={fetch:async()=>new Response('original',{status:200})};
  const wrapper=withTelegramMenuCompletion(api,{verify:async(raw)=>{assert.equal(raw,'signed-fixture');return{telegramUserId:42};}});
  const response=await wrapper.fetch(request(),{...env,TELEGRAM_MENU_SYNC:{reconcile:async x=>{calls.push(x);}}},{waitUntil:p=>jobs.push(p)});
  await Promise.all(jobs);assert.equal(await response.text(),'original');assert.deepEqual(calls,[{telegram_user_id:42}]);
});
test('failed registration cannot activate menu',async()=>{
  let called=false;const wrapper=withTelegramMenuCompletion({fetch:async()=>new Response(null,{status:401})},{verify:()=>{called=true;}});
  assert.equal((await wrapper.fetch(request(),env)).status,401);assert.equal(called,false);
});
test('invalid launch cannot notify even after an injected success',async()=>{
  let called=false;const wrapper=withTelegramMenuCompletion({fetch:async()=>new Response(null)},{verify:()=>{throw Error();}});
  assert.equal((await wrapper.fetch(request(),{...env,TELEGRAM_MENU_SYNC:{reconcile:()=>{called=true;}}})).status,200);assert.equal(called,false);
});
test('provider notification failure does not invalidate committed registration',async()=>{
  const wrapper=withTelegramMenuCompletion({fetch:async()=>new Response('ok')},{verify:async()=>({telegramUserId:42})});
  const response=await wrapper.fetch(request(),{...env,TELEGRAM_MENU_SYNC:{reconcile:()=>{throw Error('private');}}});
  assert.equal(await response.text(),'ok');
});
test('feature off passes original request without reading body or secrets',async()=>{
  const r=request();let same;
  const wrapper=withTelegramMenuCompletion({fetch:async got=>{same=got;return new Response(null);}});
  await wrapper.fetch(r,{});assert.equal(same,r);assert.equal(r.bodyUsed,false);
});

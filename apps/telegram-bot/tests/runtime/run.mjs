import {Miniflare} from 'miniflare';
import workerdPath from 'workerd';
// Pin the official runtime separately: Miniflare stable currently bundles an older binary.
process.env.MINIFLARE_WORKERD_PATH ??= typeof workerdPath === 'string' ? workerdPath : workerdPath.default;
import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../../',import.meta.url)).replace(/\/$/,'');
const compatibilityDate=process.env.UA_BOT_TEST_COMPATIBILITY_DATE || '2026-11-11';
const output=await build({stdin:{contents:`import bot,{LoginMessageLifecycleObject,TelegramMenuSync} from '${root}/apps/telegram-bot/src/lifecycle-cloudflare-entry.mjs';
export {TelegramMenuSync};
export class RuntimeTest extends LoginMessageLifecycleObject {
 async inspect(){return JSON.stringify(await this.ctx.storage.get('state'));}
 async expire(){return this.run(async()=>{const s=await this.ctx.storage.get('state');for(const r of s.receipts){r.expires=Date.now()-1;r.next=Date.now()-1;}await this.ctx.storage.put('state',s);await this.ctx.storage.setAlarm(Date.now()+50);});}
}
export default bot;`,resolveDir:root},bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],write:false});
const apiBundle=await build({stdin:{contents:`import {withTelegramMenuCompletion} from '${root}/runtime/telegram-menu-completion.mjs';export default withTelegramMenuCompletion({fetch:async()=>new Response('committed')},{verify:async()=>({telegramUserId:42})});`,resolveDir:root},bundle:true,format:'esm',platform:'browser',write:false});
let next=100, rateLimitNextSend=false;const calls=[];
const mf=new Miniflare({workers:[{name:'bot',modules:true,script:output.outputFiles[0].text,compatibilityDate,
 bindings:{TELEGRAM_MESSAGE_LIFECYCLE_ENABLED:'true',LOGIN_MESSAGE_TTL_SECONDS:'60',TELEGRAM_BOT_TOKEN:'123:abcdefghijklmnopqrstuvwxyz',TELEGRAM_WEBHOOK_SECRET:'fixture',MINI_CABINET_URL:'https://mini.univeracademy.uz/',MINI_SIGN_IN_URL:'https://mini.univeracademy.uz/sign-in'},
 durableObjects:{LOGIN_MESSAGE_LIFECYCLE:{className:'RuntimeTest',useSQLite:true}},
 serviceBindings:{TELEGRAM_START_LOOKUP:{name:'directory',entrypoint:'TelegramAccountDirectory'}},
 outboundService:async req=>{const method=new URL(req.url).pathname.split('/').at(-1),body=await req.json();calls.push({method,body});if(method==='sendMessage'&&rateLimitNextSend){rateLimitNextSend=false;return Response.json({ok:false,error_code:429,parameters:{retry_after:1}},{status:429});}return Response.json({ok:true,result:method==='sendMessage'?{message_id:next++,chat:{id:body.chat_id}}:true});}},
 {name:'directory',modules:true,compatibilityDate,script:`import {WorkerEntrypoint} from 'cloudflare:workers';let status='needs_clerk';export class TelegramAccountDirectory extends WorkerEntrypoint{lookupTelegramStart(){return {status};}}export default{fetch(r){status=new URL(r.url).pathname.slice(1);return new Response('ok');}};`}, {name:'api-fixture',modules:true,compatibilityDate,script:apiBundle.outputFiles[0].text,bindings:{UA_TELEGRAM_MENU_SYNC_ENABLED:'true',UA_SESSION_POLICY:'{}'},serviceBindings:{TELEGRAM_MENU_SYNC:{name:'bot',entrypoint:'TelegramMenuSync'}}} ]});
try{
const update={update_id:1,message:{message_id:1,from:{id:42,is_bot:false},chat:{id:42,type:'private'},text:'/start'}};
const send=()=>mf.dispatchFetch('https://bot.example.org/telegram/webhook',{method:'POST',headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':'fixture'},body:JSON.stringify(update)});
let r=await send();assert.equal(r.status,200,await r.text());assert.equal(calls.filter(x=>x.method==='sendMessage').length,1);
r=await send();assert.equal(r.status,200);assert.equal(calls.filter(x=>x.method==='sendMessage').length,1);
const directory=await mf.getWorker('directory');await directory.fetch('https://fixture/linked');const apiFixture=await mf.getWorker('api-fixture');const completed=await apiFixture.fetch('https://api.univeracademy.uz/api/v1/auth/telegram/link',{method:'POST',body:JSON.stringify({init_data:'fixture'})});assert.equal(completed.status,200);
for(let i=0;i<40&&!calls.some(x=>x.method==='deleteMessage');i++)await new Promise(r=>setTimeout(r,100));
assert.ok(calls.some(x=>x.method==='setChatMenuButton'&&x.body.menu_button.type==='web_app'));
assert.ok(calls.some(x=>x.method==='deleteMessage'&&x.body.message_id===100));
update.update_id=2;await send();assert.equal(calls.filter(x=>x.method==='sendMessage').length,1);
await directory.fetch('https://fixture/needs_clerk');update.update_id=3;await send();
const ns=await mf.getDurableObjectNamespace('LOGIN_MESSAGE_LIFECYCLE','bot');const stub=ns.get(ns.idFromName('42'));
assert.equal(JSON.parse(await stub.inspect()).receipts[0].id,101);await stub.expire();
for(let i=0;i<40&&!calls.some(x=>x.method==='deleteMessage'&&x.body.message_id===101);i++)await new Promise(r=>setTimeout(r,100));
assert.ok(calls.some(x=>x.method==='deleteMessage'&&x.body.message_id===101));
assert.equal(JSON.parse(await stub.inspect()).receipts.length,0);
rateLimitNextSend=true;update.update_id=4;
const beforeRetry=calls.filter(x=>x.method==='sendMessage').length;
await send();await send();assert.equal(calls.filter(x=>x.method==='sendMessage').length,beforeRetry+1);
assert.equal(JSON.parse(await stub.inspect()).lastSend,'rate_limited');
for(let i=0;i<40&&calls.filter(x=>x.method==='sendMessage').length<beforeRetry+2;i++)await new Promise(r=>setTimeout(r,100));
assert.equal(calls.filter(x=>x.method==='sendMessage').length,beforeRetry+2);
assert.equal(JSON.parse(await stub.inspect()).lastSend,'confirmed');
console.log('PASS workerd: authenticated webhook, private RPC directory, SQLite DO receipt, duplicate suppression, API completion private RPC enables menu/deletes login, existing ID sends no message, real alarm cleans abandonment and retries definitive 429 sends');
}finally{await mf.dispose();}

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createCloudflareEntrypoint} from '../../runtime/cloudflare-entry.mjs';
import {channelGateBlocks} from '../../runtime/channel-gate-api.mjs';
import {clock,testPolicy} from '../backend/http-fixture.ts';

// Kanal a'zoligi (server tomoni): yangi o'quvchi / a'zo / a'zo emas / xodim / Telegram xatosi.
// Telegram, baza va Clerk soxta; tashqi so'rov yo'q.
const api='https://api.channel-gate.invalid',ui='https://mini.channel-gate.invalid',issuer='https://clerk.channel-gate.invalid';
const fresh=()=>Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const gateEnv={UA_CHANNEL_GATE_ENABLED:'true',UA_REQUIRED_CHANNEL:'@PhysicsHubUZ',UA_REQUIRED_CHANNEL_URL:'https://t.me/PhysicsHubUZ'};
async function signed(token,id=4000000123){
 const enc=new TextEncoder(),fields=new URLSearchParams({auth_date:String(Math.floor(clock/1000)),user:JSON.stringify({id,first_name:'Sinov'})});
 const data=[...fields].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>k+'='+v).join('\n');
 const seed=await crypto.subtle.importKey('raw',enc.encode('WebAppData'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const secret=await crypto.subtle.sign('HMAC',seed,enc.encode(token));const key=await crypto.subtle.importKey('raw',secret,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 fields.set('hash',Buffer.from(await crypto.subtle.sign('HMAC',key,enc.encode(data))).toString('hex'));return fields.toString();
}
const telegramReply=status=>Response.json({ok:true,result:{status}});
const down=()=>new Response('bad gateway',{status:502});

// ---- 1) qaror mantiqi: har holat alohida ----
async function decide({reply='left',linked=true,staff=false,env=gateEnv,token=`123456:${'A'.repeat(30)}`,raw}={}){
 const calls=[];
 const result=await channelGateBlocks({
  request:new Request(api+'/x',{method:'POST',body:JSON.stringify({init_data:raw??await signed(token)})}),env,
  bindings:{botToken:token,sessionPolicy:testPolicy},now:()=>clock,
  fetcher:async(url,init)=>{calls.push(JSON.parse(init.body));if(reply==='throw')throw Error('network');return typeof reply==='function'?reply():telegramReply(reply);},
  isLinked:async()=>{if(linked==='throw')throw Error('db');return linked;},
  isStaff:async()=>{if(staff==='throw')throw Error('db');return staff;}});
 return {result,calls};
}
test('a‘zo emas + kabineti bor + xodim emas -> to‘xtatiladi',async()=>{
 const {result,calls}=await decide();assert.equal(result.url,'https://t.me/PhysicsHubUZ');
 assert.deepEqual(calls,[{chat_id:'@PhysicsHubUZ',user_id:4000000123}]);
});
for(const status of ['left','kicked'])test('holat '+status+' -> to‘xtatiladi',async()=>assert.ok((await decide({reply:status})).result));
for(const status of ['member','administrator','creator'])test('holat '+status+' -> kiritiladi (baza so‘ralmaydi)',async()=>assert.equal((await decide({reply:status,linked:'throw'})).result,null));
test('yangi o‘quvchi (kabineti yo‘q) kanal so‘ralmasdan kiritiladi',async()=>assert.equal((await decide({linked:false})).result,null));
test('xodim kiritiladi',async()=>assert.equal((await decide({staff:true})).result,null));
test('xodimligi noaniq (baza xatosi) -> kiritiladi',async()=>assert.equal((await decide({staff:'throw'})).result,null));
test('kabineti borligi noaniq (baza xatosi) -> kiritiladi',async()=>assert.equal((await decide({linked:'throw'})).result,null));
for(const reply of ['throw','down'])test('Telegram xatosi ('+reply+') -> kiritiladi',async()=>assert.equal((await decide({reply:reply==='down'?down:reply})).result,null));
test('Telegram "kanal topilmadi" desa (bot admin emas) -> kiritiladi',async()=>
 assert.equal((await decide({reply:()=>Response.json({ok:false,error_code:400,description:'Bad Request: chat not found'},{status:400})})).result,null));
for(const [label,env] of [['o‘chiq',{}],['false',{...gateEnv,UA_CHANNEL_GATE_ENABLED:'false'}],['kanal nomi xato',{...gateEnv,UA_REQUIRED_CHANNEL:'x'}],['havola xato',{...gateEnv,UA_REQUIRED_CHANNEL_URL:'http://t.me/x'}]])
 test('tekshiruv '+label+' -> hech kim to‘xtatilmaydi, Telegram so‘ralmaydi',async()=>{const {result,calls}=await decide({env});assert.equal(result,null);assert.equal(calls.length,0);});
test('imzosi noto‘g‘ri ma‘lumot -> to‘xtatilmaydi (odatiy resume o‘z xatosini beradi)',async()=>{
 const {result,calls}=await decide({raw:'auth_date=1&hash=bad'});assert.equal(result,null);assert.equal(calls.length,0);
});

// ---- 2) haqiqiy kirish nuqtasi orqali ----
function fixture({reply='left',state='linked',staffRole=null,env:extra=gateEnv}={}){
 const botToken="654321:"+fresh(),telegramCalls=[],staffCalls=[];const url=new URL('postgres://hyperdrive.invalid:5432/inert');url.username=fresh();url.password=fresh();
 const env={UA_API_ORIGIN:api,UA_ALLOWED_ORIGINS:JSON.stringify([ui]),UA_SESSION_POLICY:JSON.stringify(testPolicy),
  UA_CLERK_PROVIDER_SETTINGS:JSON.stringify({issuer,authorizedParties:[ui],audience:{kind:'clerk_default_no_audience'},jwksCacheMs:300000,jwksCooldownMs:0,timeoutMs:1000,maxJwksBytes:65536}),
  UA_CLERK_SECRET_KEY:fresh(),HYPERDRIVE:{connectionString:url.toString()},UA_TELEGRAM_LOOKUP_TIMEOUT_MS:'3000',UA_TELEGRAM_BOT_TOKEN:botToken,...extra};
 class Client extends EventEmitter{
  async connect(){}
  async query(q){
   if(['BEGIN','BEGIN READ ONLY','ROLLBACK','COMMIT'].includes(q.text)||q.text.startsWith("SELECT set_config('ua."))return {rows:[],rowCount:0};
   if(/clock_timestamp/.test(q.text))return {rows:[{now_ms:String(clock)}],rowCount:1};
   if(q.text==='SELECT state FROM ua_private.lookup_telegram_start($1::bigint)')return {rows:[{state}],rowCount:1};
   if(q.text.includes('locate_telegram_return'))return {rows:[],rowCount:0};
   throw Error('Unexpected inert SQL');
  }
  async end(){}
 }
 const entry=createCloudflareEntrypoint({loadClient:async()=>Client,
  makeClerk:async()=>({verifier:{issuer,authorizedParties:[ui],audience:{kind:'clerk_default_no_audience'},trustedKeys:()=>{throw Error('no bypass');},now:()=>clock},
   liveness:async()=>{throw Error('provider must not run');},async close(){}}),
  transport:async request=>{const body=await request.json();telegramCalls.push(body);if(reply==='throw')throw Error('network');return reply==='down'?down():telegramReply(reply);},
  readStaff:async input=>{staffCalls.push(input);if(staffRole==='throw')throw Error('db');return staffRole;},now:()=>clock});
 const resume=async()=>entry.fetch(new Request(api+'/api/v1/auth/telegram/resume',{method:'POST',headers:{origin:ui},body:JSON.stringify({init_data:await signed(botToken)})}),env);
 return {resume,telegramCalls,staffCalls,env};
}
test('kirish nuqtasi: a‘zo emas, kabineti bor -> 403 CHANNEL_MEMBERSHIP_REQUIRED + kanal havolasi',async()=>{
 const f=fixture(),r=await f.resume();assert.equal(r.status,403);
 const body=await r.json();assert.equal(body.error.code,'CHANNEL_MEMBERSHIP_REQUIRED');assert.equal(body.error.channel_url,'https://t.me/PhysicsHubUZ');
 assert.equal(r.headers.get('access-control-allow-origin'),ui);assert.equal(r.headers.get('cache-control'),'no-store');
 assert.deepEqual(f.staffCalls,[{telegramUserId:4000000123}]);
});
test('kirish nuqtasi: yangi o‘quvchi (kabineti yo‘q) -> kanal so‘ralmaydi, odatiy "Clerk kerak" javobi',async()=>{
 const f=fixture({state:'needs_clerk'}),r=await f.resume();assert.equal(r.status,409);assert.equal((await r.json()).error.code,'TELEGRAM_LINK_REQUIRED');
 assert.equal(f.staffCalls.length,0);
});
test('kirish nuqtasi: a‘zo -> odatiy oqim, xodim bazasi so‘ralmaydi',async()=>{
 const f=fixture({reply:'member'}),r=await f.resume();assert.equal(r.status,409);assert.equal((await r.json()).error.code,'TELEGRAM_LINK_REQUIRED');assert.equal(f.staffCalls.length,0);
});
test('kirish nuqtasi: xodim -> to‘xtatilmaydi',async()=>{
 const f=fixture({staffRole:'teacher'}),r=await f.resume();assert.equal(r.status,409);
});
test('kirish nuqtasi: xodim bazasi xato -> to‘xtatilmaydi',async()=>{
 const f=fixture({staffRole:'throw'}),r=await f.resume();assert.equal(r.status,409);
});
for(const reply of ['down','throw'])test('kirish nuqtasi: Telegram xatosi ('+reply+') -> to‘xtatilmaydi',async()=>{
 const f=fixture({reply}),r=await f.resume();assert.equal(r.status,409);
});
test('kirish nuqtasi: tekshiruv o‘chiq -> Telegram\'ga umuman so‘rov yo‘q',async()=>{
 const f=fixture({env:{}}),r=await f.resume();assert.equal(r.status,409);assert.equal(f.telegramCalls.length,0);
});
test('kirish nuqtasi: "faqat ro‘yxatdan o‘tish" rejimi kabineti borligini yashirmaydi',async()=>{
 const f=fixture({env:{...gateEnv,UA_TELEGRAM_START_MODE:'registration_only'}}),r=await f.resume();assert.equal(r.status,403);
});

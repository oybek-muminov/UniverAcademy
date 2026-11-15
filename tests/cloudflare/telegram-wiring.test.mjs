import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createCloudflareEntrypoint} from '../../runtime/cloudflare-entry.mjs';
import {clock,testPolicy} from '../backend/http-fixture.ts';
const api='https://api.telegram-wiring.invalid',ui='https://mini.telegram-wiring.invalid',issuer='https://clerk.telegram-wiring.invalid';
const freshSecret=()=>Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
function fixture(patch={}){
 const clients=[],clerks=[],events=[],botToken=freshSecret(),clerkSecret=freshSecret();let providerCalls=0,loads=0;
 const url=new URL('postgres://hyperdrive.invalid:5432/inert');url.username=freshSecret();url.password=freshSecret();
 const env={UA_API_ORIGIN:api,UA_ALLOWED_ORIGINS:JSON.stringify([ui]),UA_SESSION_POLICY:JSON.stringify(testPolicy),
  UA_CLERK_PROVIDER_SETTINGS:JSON.stringify({issuer,authorizedParties:[ui],audience:{kind:'clerk_default_no_audience'},jwksCacheMs:300000,jwksCooldownMs:0,timeoutMs:1000,maxJwksBytes:65536}),
  UA_CLERK_SECRET_KEY:clerkSecret,HYPERDRIVE:{connectionString:url.toString()}};
 if(patch.telegram!==false)env.UA_TELEGRAM_BOT_TOKEN=botToken;
 class Client extends EventEmitter{
  constructor(options){super();this.options=options;this.ends=0;this.queries=[];clients.push(this);}
  async connect(){await patch.connect?.(this);}
  async query(q){
   assert.deepEqual(Object.keys(q).sort(),['text','values']);this.queries.push(q);events.push(q.text);await patch.query?.(q,this);
   if(q.text==='BEGIN'||q.text==='ROLLBACK'||q.text==='COMMIT'||q.text.startsWith("SELECT set_config('ua."))return {rows:[],rowCount:0};
   if(q.text==='SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms'||q.text==='SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms')return {rows:[{now_ms:String(clock)}],rowCount:1};
   if(q.text==='SELECT person_id::text FROM ua_private.locate_student_access($1::text)'||q.text==='SELECT person_id::text,person_enabled,issuer,subject,identity_enabled FROM ua_private.locate_telegram_return($1::bigint,$2::text)')return {rows:[],rowCount:0};
   throw Error('Unexpected inert SQL');
  }
  async end(){this.ends++;await patch.end?.(this);}
 }
 const entry=createCloudflareEntrypoint({loadClient:async()=>{loads++;return Client;},makeClerk:async(settings,options)=>{
  const record={closes:0,options};clerks.push(record);return {verifier:{issuer,authorizedParties:[ui],audience:{kind:'clerk_default_no_audience'},trustedKeys:()=>{throw Error('No synthetic JWT bypass');},now:()=>clock},
   liveness:async()=>{providerCalls++;throw Error('provider must not run for absent identity');},async close(){record.closes++;await patch.close?.();}};
 },transport:()=>{throw Error('real provider access forbidden');},now:()=>clock});
 const request=(path,body={},headers={},method='POST',signal)=>new Request(api+'/api/v1'+path,{method,headers:{origin:ui,...headers},...(method==='GET'?{}:{body:typeof body==='string'?body:JSON.stringify(body)}),...(signal?{signal}:{})});
 return {entry,env,clients,clerks,events,botToken,clerkSecret,request,get loads(){return loads;},get providerCalls(){return providerCalls;}};
}
async function signed(token){
 const enc=new TextEncoder(),fields=new URLSearchParams({auth_date:String(Math.floor(clock/1000)),user:JSON.stringify({id:4000000123,first_name:'NoProfile'})});
 const data=[...fields].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>k+'='+v).join('\n');
 const seed=await crypto.subtle.importKey('raw',enc.encode('WebAppData'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const secret=await crypto.subtle.sign('HMAC',seed,enc.encode(token));const key=await crypto.subtle.importKey('raw',secret,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 fields.set('hash',Buffer.from(await crypto.subtle.sign('HMAC',key,enc.encode(data))).toString('hex'));return fields.toString();
}
async function safe(f,r,status){assert.equal(r.status,status);assert.equal(r.headers.get('access-control-allow-origin'),ui);const text=await r.text();for(const s of [f.botToken,f.clerkSecret,'postgres://','private failure'])assert.ok(!text.includes(s));return JSON.parse(text);}
for(const path of ['/auth/telegram/link','/auth/telegram/resume'])for(const bad of ['absent','empty','wrong type','newline','getter'])test(path+' missing/invalid bot binding '+bad+' fails before resource creation',async()=>{
 const f=fixture({telegram:false});let getters=0;
 if(bad==='empty')f.env.UA_TELEGRAM_BOT_TOKEN='';if(bad==='wrong type')f.env.UA_TELEGRAM_BOT_TOKEN=7;if(bad==='newline')f.env.UA_TELEGRAM_BOT_TOKEN='\n';if(bad==='getter')Object.defineProperty(f.env,'UA_TELEGRAM_BOT_TOKEN',{get(){getters++;throw Error('private failure');},enumerable:true});
 await safe(f,await f.entry.fetch(f.request(path,{init_data:'unverified'}),f.env),503);assert.equal(f.loads,0);assert.equal(f.clerks.length,0);assert.equal(f.clients.length,0);assert.equal(getters,0);
});
test('resume is admitted and receives only the private generated bot secret for actual HMAC verification',async()=>{
 const f=fixture(),raw=await signed(f.botToken);const r=await safe(f,await f.entry.fetch(f.request('/auth/telegram/resume',{init_data:raw}),f.env),409);assert.equal(r.error.code,'TELEGRAM_LINK_REQUIRED');
 assert.equal(f.clients.length,1);assert.equal(f.clients[0].ends,1);assert.equal(f.clerks[0].closes,1);assert.equal(f.providerCalls,0);assert.ok(f.events.some(x=>x.includes('locate_telegram_return')));
});
test('link admission reaches the real strict body boundary without bypassing Clerk JWT',async()=>{
 const f=fixture();const r=await safe(f,await f.entry.fetch(f.request('/auth/telegram/link',{}),f.env),422);assert.equal(r.error.code,'VALIDATION_ERROR');assert.equal(f.loads,1);assert.equal(f.clerks[0].closes,1);assert.equal(f.clients.length,0);
});
for(const bad of ['absent','getter','wrong type'])test('unrelated accepted route works without evaluating optional Telegram secret '+bad,async()=>{
 const f=fixture({telegram:false});let gets=0;if(bad==='getter')Object.defineProperty(f.env,'UA_TELEGRAM_BOT_TOKEN',{get(){gets++;throw Error('private failure');},enumerable:true});if(bad==='wrong type')f.env.UA_TELEGRAM_BOT_TOKEN={};
 const r=await safe(f,await f.entry.fetch(f.request('/me',undefined,{authorization:'Bearer missing'},'GET'),f.env),401);assert.equal(r.error.code,'SESSION_REVOKED');assert.equal(gets,0);assert.equal(f.clients[0].ends,1);
});
for(const path of ['/lookupTelegramStart','/auth/telegram','/auth/telegram/lookup','/unknown/auth/telegram/resume'])test('default fetch never exposes private RPC or legacy provisioning '+path,async()=>{
 const f=fixture();await safe(f,await f.entry.fetch(f.request(path,{update_id:1,telegram_user_id:4000000123},{'x-trusted':'true'}),f.env),503);assert.equal(f.loads,0);assert.equal(f.providerCalls,0);assert.equal(f.clerks.length,0);
});
test('wrong Telegram method and denied origin do no private I/O',async()=>{
 const f=fixture();await safe(f,await f.entry.fetch(f.request('/auth/telegram/resume',undefined,{},'GET'),f.env),503);const r=await f.entry.fetch(f.request('/auth/telegram/link',{}, {origin:'https://foreign.invalid'}),f.env);assert.equal(r.status,403);assert.equal(r.headers.get('access-control-allow-origin'),null);assert.equal(f.loads,0);
});
test('resume rejects a caller Authorization header without SQL or provider use',async()=>{
 const f=fixture();await safe(f,await f.entry.fetch(f.request('/auth/telegram/resume',{init_data:await signed(f.botToken)},{authorization:'Bearer untrusted'}),f.env),422);assert.equal(f.clients.length,0);assert.equal(f.providerCalls,0);assert.equal(f.clerks[0].closes,1);
});
for(const kind of ['end','Clerk close'])test('new route '+kind+' failure keeps CORS and sanitized503',async()=>{
 const f=fixture(kind==='end'?{end(){throw Error('private failure');}}:{close(){throw Error('private failure');}});await safe(f,await f.entry.fetch(f.request('/auth/telegram/resume',{init_data:await signed(f.botToken)}),f.env),503);
 assert.equal(f.clients[0].ends,1);assert.equal(f.clerks[0].closes,1);
});
test('new proof routes retain body cap and abort behavior without construction',async()=>{
 const f=fixture();await safe(f,await f.entry.fetch(f.request('/auth/telegram/resume','x'.repeat(65537)),f.env),400);assert.equal(f.clients.length,0);
 const abort=new AbortController();abort.abort();await safe(f,await f.entry.fetch(f.request('/auth/telegram/resume',{init_data:'unverified'},{},'POST',abort.signal),f.env),503);assert.equal(f.clients.length,0);
});
const {createTelegramDirectory}=await import('../../runtime/cloudflare-telegram-directory.mjs');
const pause=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function directoryFixture(patch={}){
 const clients=[],loads=[],timers=[],cleared=[];const url=new URL('postgres://hyperdrive.invalid:5432/inert');url.username=freshSecret();url.password=freshSecret();
 const env={HYPERDRIVE:{connectionString:url.toString()},UA_TELEGRAM_LOOKUP_TIMEOUT_MS:'5000'};
 class Client extends EventEmitter{
  constructor(options){super();this.queries=[];this.ends=0;this.local={};this.options=options;clients.push(this);patch.construct?.(this);}
  async connect(){await patch.connect?.(this);}
  async query(q){
   assert.deepEqual(Object.keys(q).sort(),['text','values']);this.queries.push(q);await patch.query?.(q,this);
   if(q.text==='BEGIN READ ONLY'){this.open=true;return {rows:[],rowCount:0};}
   assert.equal(this.open,true);if(q.text==='ROLLBACK'){this.open=false;this.local={};return {rows:[],rowCount:0};}
   if(q.text.startsWith("SELECT set_config('ua.phase',$1,true),")){
    assert.deepEqual(q.values,['deny','','[]','','','']);this.local={phase:'deny'};return {rows:[],rowCount:0};
   }
   if(q.text==="SELECT set_config('ua.phase',$1,true)"){assert.deepEqual(q.values,['auth']);this.local.phase='auth';return {rows:[],rowCount:0};}
   assert.equal(q.text,'SELECT state FROM ua_private.lookup_telegram_start($1::bigint)');assert.equal(this.local.phase,'auth');
   return {rows:patch.rows??[{state:patch.state??(q.values[0]===2?'disabled':'linked')}],rowCount:1};
  }
  async end(){this.ends++;await patch.end?.(this);}
 }
 const directory=createTelegramDirectory({loadClient:async()=>{loads.push(1);await patch.load?.();return Client;},
  setTimer:(callback,ms)=>{const record={callback,ms};timers.push(record);return record;},clearTimer:timer=>cleared.push(timer)});
 return {directory,env,clients,loads,timers,cleared};
}
for(const status of ['linked','needs_clerk','disabled'])test('private interface maps internal '+status+' to exact external object and waits for end',async()=>{
 const f=directoryFixture({state:status}),result=await f.directory.lookupTelegramStart({update_id:0,telegram_user_id:1},f.env);
 assert.deepEqual(result,{status});assert.deepEqual(Reflect.ownKeys(result),['status']);assert.equal(Object.isFrozen(result),true);assert.equal(f.clients[0].ends,1);
 assert.ok(f.clients[0].queries.every(q=>!/^COMMIT|INSERT|UPDATE|DELETE/.test(q.text)));assert.equal(f.clients[0].queries.at(-1).text,'ROLLBACK');assert.equal(f.timers[0].ms,5000);assert.equal(f.cleared.length,1);
});
for(const input of [null,{},[],{update_id:1,telegram_user_id:0},{update_id:1,telegram_user_id:1,token:'untrusted'}])test('bad private input has fixed failure before config/Client loading '+JSON.stringify(input),async()=>{
 const f=directoryFixture();await assert.rejects(f.directory.lookupTelegramStart(input,f.env),e=>e.message==='SERVICE_UNAVAILABLE');assert.equal(f.loads.length,0);assert.equal(f.clients.length,0);
});
for(const deadline of [undefined,'','0','5001','1.5',5,{},' 5'])test('missing/invalid private RPC deadline fails closed '+JSON.stringify(deadline),async()=>{
 const f=directoryFixture();if(deadline===undefined)delete f.env.UA_TELEGRAM_LOOKUP_TIMEOUT_MS;else f.env.UA_TELEGRAM_LOOKUP_TIMEOUT_MS=deadline;
 await assert.rejects(f.directory.lookupTelegramStart({update_id:1,telegram_user_id:1},f.env),e=>e.message==='SERVICE_UNAVAILABLE');assert.equal(f.loads.length,0);
});
test('private input/config getters are rejected without invoking them; unrelated secret getters remain unread',async()=>{
 const f=directoryFixture();let gets=0;Object.defineProperty(f.env,'UA_CLERK_SECRET_KEY',{get(){gets++;throw Error('private details');}});Object.defineProperty(f.env,'UA_TELEGRAM_BOT_TOKEN',{get(){gets++;throw Error('private details');}});
 assert.deepEqual(await f.directory.lookupTelegramStart({update_id:1,telegram_user_id:1},f.env),{status:'linked'});assert.equal(gets,0);
 const g=directoryFixture();Object.defineProperty(g.env,'UA_TELEGRAM_LOOKUP_TIMEOUT_MS',{get(){gets++;throw Error('private details');}});await assert.rejects(g.directory.lookupTelegramStart({update_id:1,telegram_user_id:1},g.env),e=>e.message==='SERVICE_UNAVAILABLE');assert.equal(gets,0);
});
for(const rows of [[{state:'linked',profile:{private:true}}],[{state:'linked'},{state:'disabled'}],[{state:'unknown'}],[]])test('malformed private SQL data never becomes routing success '+JSON.stringify(rows),async()=>{
 const f=directoryFixture({rows});await assert.rejects(f.directory.lookupTelegramStart({update_id:1,telegram_user_id:1},f.env),e=>e.message==='SERVICE_UNAVAILABLE');assert.equal(f.clients[0].ends,1);
});
for(const phase of ['load','connect','query','end'])test('private '+phase+' failure is fixed safe error and disposed once',async()=>{
 const f=directoryFixture({[phase]:()=>{throw Error('private details');}});
 await assert.rejects(f.directory.lookupTelegramStart({update_id:1,telegram_user_id:1},f.env),e=>e.message==='SERVICE_UNAVAILABLE'&&!e.cause);
 if(f.clients.length)assert.equal(f.clients[0].ends,1);assert.equal(f.cleared.length,1);
});
test('private close is awaited, failure never returns a cached routing result',async()=>{
 const end=pause(),f=directoryFixture({end:()=>end.promise});let finished=false;
 const work=f.directory.lookupTelegramStart({update_id:1,telegram_user_id:1},f.env).then(()=>finished=true);for(let i=0;i<8;i++)await new Promise(setImmediate);
 assert.equal(finished,false);end.resolve();await work;assert.equal(finished,true);assert.equal(f.clients[0].ends,1);
});
for(const phase of ['load','connect','query'])test('private deadline cancels '+phase+' and no late result/duplicate disposal escapes',async()=>{
 const wait=pause(),entered=pause();const f=directoryFixture({[phase]:async()=>{entered.resolve();await wait.promise;}});
 const work=f.directory.lookupTelegramStart({update_id:1,telegram_user_id:1},f.env);await entered.promise;f.timers[0].callback();await assert.rejects(work,e=>e.message==='SERVICE_UNAVAILABLE');wait.resolve();await new Promise(setImmediate);
 assert.ok(f.clients.every(c=>c.ends===1));assert.equal(f.loads.length,1);assert.equal(f.cleared.length,1);
});
test('trusted owner signal cancels the internal factory; RPC accepts no cancellation/config override',async()=>{
 const abort=new AbortController(),entered=pause(),wait=pause(),f=directoryFixture({query:async()=>{entered.resolve();await wait.promise;}});
 const work=f.directory.lookupTelegramStart({update_id:1,telegram_user_id:1},f.env,{signal:abort.signal});await entered.promise;abort.abort();await assert.rejects(work,e=>e.message==='SERVICE_UNAVAILABLE');wait.resolve();assert.equal(f.clients[0].ends,1);
});
test('simultaneous private lookups share no Client/context and return only their own result',async()=>{
 const f=directoryFixture();const result=await Promise.all([f.directory.lookupTelegramStart({update_id:1,telegram_user_id:1},f.env),f.directory.lookupTelegramStart({update_id:2,telegram_user_id:2},f.env)]);
 assert.deepEqual(result,[{status:'linked'},{status:'disabled'}]);assert.equal(f.clients.length,2);for(const c of f.clients){assert.equal(c.ends,1);assert.equal(c.queries.filter(q=>q.text==='BEGIN READ ONLY').length,1);assert.deepEqual(c.local,{});}
});
test('platform module exports a real WorkerEntrypoint subclass, private object contract and no public fetch RPC',{concurrency:false},async()=>{
 // Test-only module resolution. This is NOT a workerd/Service Binding runtime
 // proof and is never imported into production. The application has no shim.
 const {registerHooks}=await import('node:module');const f=directoryFixture();globalThis.__telegramDirectoryClientForUnit=f;
 const platform='data:text/javascript,'+encodeURIComponent('export class WorkerEntrypoint {constructor(ctx,env){this.ctx=ctx;this.env=env;}}');
 const pg='data:text/javascript,'+encodeURIComponent('export class Client {constructor(options){const f=globalThis.__telegramDirectoryClientForUnit;this.q=[];this.ends=0;f.clients.push(this);}on(){}async connect(){}async query(q){this.q.push(q);return q.text.includes("lookup_telegram_start")?{rows:[{state:"linked"}],rowCount:1}:{rows:[],rowCount:0};}async end(){this.ends++;}}');
 const hook=registerHooks({resolve(specifier,context,next){if(specifier==='cloudflare:workers')return {url:platform,shortCircuit:true};if(specifier==='pg')return {url:pg,shortCircuit:true};return next(specifier,context);}});
 try{
  const module=await import('../../runtime/cloudflare-worker.mjs');const {WorkerEntrypoint}=await import('cloudflare:workers');assert.ok(module.TelegramAccountDirectory.prototype instanceof WorkerEntrypoint);
  const rpc=new module.TelegramAccountDirectory({waitUntil(){throw Error('unowned background work');}},f.env);
  assert.deepEqual(await rpc.lookupTelegramStart({update_id:1,telegram_user_id:1},{HYPERDRIVE:'forged override'}),{status:'linked'});assert.equal(f.clients[0].ends,1);
  assert.equal(typeof module.default.lookupTelegramStart,'undefined');const before=f.clients.length;const response=await rpc.fetch(new Request(api+'/lookupTelegramStart',{headers:{'x-trusted':'true'}}));assert.equal(response.status,404);assert.equal(f.clients.length,before);
  const text=await (await module.default.fetch(new Request(api+'/api/v1/lookupTelegramStart',{method:'POST',headers:{origin:ui,'x-trusted':'true'},body:'{}'}),fixture().env)).text();assert.ok(!text.includes('linked'));assert.equal(f.clients.length,before);
 }finally{hook.deregister();delete globalThis.__telegramDirectoryClientForUnit;}
});
for(const invalid of [undefined,null,{},'untrusted'])test('private missing/invalid Hyperdrive binding fails before load '+JSON.stringify(invalid),async()=>{
 const f=directoryFixture();if(invalid===undefined)delete f.env.HYPERDRIVE;else f.env.HYPERDRIVE=invalid;
 await assert.rejects(f.directory.lookupTelegramStart({update_id:1,telegram_user_id:1},f.env),e=>e.message==='SERVICE_UNAVAILABLE');assert.equal(f.loads.length,0);
});
test('private URL overrides/malformed connection cannot trigger Client import or construction',async()=>{
 const f=directoryFixture();f.env.HYPERDRIVE={connectionString:'https://private.invalid/'};await assert.rejects(f.directory.lookupTelegramStart({update_id:1,telegram_user_id:1},f.env),e=>e.message==='SERVICE_UNAVAILABLE');assert.equal(f.loads.length,0);
});
test('RPC-only deadline configuration is optional and unread for the public API',async()=>{
 const f=fixture({telegram:false});let gets=0;Object.defineProperty(f.env,'UA_TELEGRAM_LOOKUP_TIMEOUT_MS',{get(){gets++;throw Error('private failure');},enumerable:true});
 await safe(f,await f.entry.fetch(f.request('/me',undefined,{authorization:'Bearer absent'},'GET'),f.env),401);assert.equal(gets,0);assert.equal(f.clients[0].ends,1);
});
test('private deadline during end cannot emit a routing ACK and waits for one disposal outcome',async()=>{
 const end=pause(),entered=pause(),f=directoryFixture({end:async()=>{entered.resolve();await end.promise;}});
 const work=f.directory.lookupTelegramStart({update_id:1,telegram_user_id:1},f.env);await entered.promise;f.timers[0].callback();let finished=false;work.finally(()=>finished=true).catch(()=>{});await new Promise(setImmediate);assert.equal(finished,false);
 end.resolve();await assert.rejects(work,e=>e.message==='SERVICE_UNAVAILABLE');assert.equal(f.clients[0].ends,1);
});

test('private directory accepts exact platform query and preserves it for driver',async()=>{
 const f=directoryFixture();f.env.HYPERDRIVE.connectionString+='?sslmode=disable';
 assert.deepEqual(await f.directory.lookupTelegramStart({update_id:1,telegram_user_id:1},f.env),{status:'linked'});
 assert.equal(f.clients[0].options.connectionString,f.env.HYPERDRIVE.connectionString);
});
for(const query of ['?sslmode=disable&sslmode=disable','?sslmode=disable&x=1','?sslmode=require'])test('private directory rejects unsupported platform query '+query,async()=>{
 const f=directoryFixture();f.env.HYPERDRIVE.connectionString+=query;
 await assert.rejects(f.directory.lookupTelegramStart({update_id:1,telegram_user_id:1},f.env),e=>e.message==='SERVICE_UNAVAILABLE');assert.equal(f.loads.length,0);
});

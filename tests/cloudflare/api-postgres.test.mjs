import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createCloudflarePostgres,POSTGRES_DRIVER_MINIMUM} from '../../runtime/cloudflare-postgres.mjs';
import {createCloudflareApi} from '../../runtime/cloudflare-api.mjs';
import {createVercelNodeFunction} from '../../runtime/vercel-node.mjs';
import {PostgresTransactions} from '../../supabase/functions/univeracademy-api/storage/postgres-transaction.ts';
import {createConfiguredHttpHandler} from '../../supabase/functions/univeracademy-api/configured-http.ts';
import {proofHash} from '../../supabase/functions/univeracademy-api/student-state.ts';
import {MemoryPool} from '../backend/student-prepared/memory-pool.mjs';
import {ids,clock,botKey,testPolicy,testNumbers} from '../backend/http-fixture.ts';

const postgres={connectionString:'postgres://synthetic:synthetic@hyperdrive.invalid:5432/synthetic'};
const origin='https://api.offline.invalid',ui='https://mini.offline.invalid';
const denied=e=>e.status===503&&e.code==='SERVICE_UNAVAILABLE'&&!e.message.includes('private-fake-error')&&!e.cause;
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const rows=(rows=[])=>({rows,rowCount:rows.length});
function fake(patch={}){
  const clients=[];
  class Client extends EventEmitter{
    constructor(options){super();this.options=options;this.connects=0;this.ends=0;this.queries=[];clients.push(this);patch.construct?.(this);}
    async connect(){this.connects++;return patch.connect?.(this);}
    async query(q){this.queries.push(q);assert.deepEqual(Object.keys(q).sort(),['text','values']);return patch.query?patch.query(q,this):rows();}
    end(){this.ends++;return patch.end?patch.end(this):Promise.resolve();}
  }
  return {Client,clients};
}
test('request resource is inert until first checkout, caps checkout at one, and strips every statement name',async()=>{
  const f=fake(),r=createCloudflarePostgres(f.Client,postgres);assert.equal(f.clients.length,0);assert.equal(POSTGRES_DRIVER_MINIMUM,'8.16.3');
  const c=await r.pool.connect();assert.equal(f.clients.length,1);assert.equal(f.clients[0].connects,1);
  assert.deepEqual(f.clients[0].options,{...postgres,connectionTimeoutMillis:5000});
  await assert.rejects(r.pool.connect(),denied);
  const values=['not SQL interpolation',12];await c.query({name:'must-never-reach-driver',text:'SELECT $1,$2',values});
  assert.deepEqual(f.clients[0].queries,[{text:'SELECT $1,$2',values}]);assert.notEqual(f.clients[0].queries[0].values,values);
  c.release();c.release(true);const second=await r.pool.connect();second.release();assert.equal(f.clients.length,1);assert.equal(f.clients[0].connects,1);
  const closing=r.close();assert.equal(r.close(),closing);await closing;assert.equal(f.clients[0].ends,1);await assert.rejects(r.pool.connect(),denied);
});
for(const options of [undefined,{}, {connectionString:''},{connectionString:'postgres://user@host:5432/db'},
  {connectionString:'postgres://u:p@host/db'},{connectionString:'postgres://u:p@host:5432/db?sslmode=disable'},
  {...postgres,ssl:false},{...postgres,Client:()=>{}},{...postgres,connectionTimeoutMillis:0},Object.create(postgres)])
test('invalid or overridden private PostgreSQL options reject before construction '+JSON.stringify(options),()=>{
  const f=fake();assert.throws(()=>createCloudflarePostgres(f.Client,options),denied);assert.equal(f.clients.length,0);
});
test('private connection-string getter is not evaluated',()=>{
  let reads=0;const options={get connectionString(){reads++;throw Error('private-fake-error');}},f=fake();
  assert.throws(()=>createCloudflarePostgres(f.Client,options),denied);assert.equal(reads,0);assert.equal(f.clients.length,0);
});
test('PG contamination added after resource creation is checked by name before the actual lazy constructor',async()=>{
  const f=fake(),r=createCloudflarePostgres(f.Client,postgres);const saved=Object.getOwnPropertyDescriptor(globalThis,'process');let reads=0;
  try{
    const env={};Object.defineProperty(env,'PGOPTIONS',{enumerable:true,get(){reads++;throw Error('private-fake-error');}});
    Object.defineProperty(globalThis,'process',{configurable:true,value:{env}});
    await assert.rejects(r.pool.connect(),denied);
  }finally{Object.defineProperty(globalThis,'process',saved);}
  assert.equal(reads,0);assert.equal(f.clients.length,0);await r.close();
});
for(const kind of ['throw','reject','non-promise'])test('close '+kind+' is sanitized, cached, and never retried',async()=>{
  const f=fake({end(){if(kind==='throw')throw Error('private-fake-error');if(kind==='reject')return Promise.reject(Error('private-fake-error'));}}),r=createCloudflarePostgres(f.Client,postgres);
  (await r.pool.connect()).release();const close=r.close();assert.equal(r.close(),close);await assert.rejects(close,denied);await assert.rejects(r.close(),denied);assert.equal(f.clients[0].ends,1);
});
test('close before first checkout constructs nothing; pending connection cannot escape close',async()=>{
  const empty=fake(),never=createCloudflarePostgres(empty.Client,postgres);await never.close();await assert.rejects(never.pool.connect(),denied);assert.equal(empty.clients.length,0);
  const gate=deferred(),f=fake({connect:()=>gate.promise}),r=createCloudflarePostgres(f.Client,postgres);
  const acquiring=r.pool.connect();await Promise.resolve();await r.close();gate.resolve();await assert.rejects(acquiring,denied);assert.equal(f.clients[0].ends,1);
});
test('pending end cannot be reported as successful disposal or permit another checkout',async()=>{
  const gate=deferred(),f=fake({end:()=>gate.promise}),r=createCloudflarePostgres(f.Client,postgres);(await r.pool.connect()).release();
  let closed=false;const ending=r.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);
  await assert.rejects(r.pool.connect(),denied);gate.resolve();await ending;assert.equal(closed,true);assert.equal(f.clients[0].ends,1);
});
test('request abort cancels a pending connect and query, ending once without SQL retry',async()=>{
  for(const phase of ['connect','query']){
    const gate=deferred(),f=fake({[phase]:()=>gate.promise}),controller=new AbortController(),r=createCloudflarePostgres(f.Client,postgres,{signal:controller.signal});
    const work=phase==='connect'?r.pool.connect():(await r.pool.connect()).query({name:'fake',text:'SELECT $1',values:[1]});
    await Promise.resolve();controller.abort();await assert.rejects(work,denied);gate.resolve(rows());await r.close();assert.equal(f.clients[0].ends,1);assert.equal(f.clients[0].queries.length,phase==='query'?1:0);
  }
});
test('idle errors latch unavailable and end the owned client once',async()=>{
  const f=fake(),r=createCloudflarePostgres(f.Client,postgres);const c=await r.pool.connect();c.release();
  assert.equal(f.clients[0].listenerCount('error'),1);f.clients[0].emit('error',Error('private-fake-error'));
  await assert.rejects(r.pool.connect(),denied);await r.close();assert.equal(f.clients[0].ends,1);assert.equal(f.clients[0].listenerCount('error'),1);
});
test('constructor/connect/query failures are fixed safe errors with no replacement construction',async()=>{
  for(const phase of ['construct','connect','query']){
    const f=fake({[phase](){throw Error('private-fake-error');}}),r=createCloudflarePostgres(f.Client,postgres);
    await assert.rejects(phase==='query'?(async()=>{const c=await r.pool.connect();try{await c.query({name:'x',text:'SELECT $1',values:[1]});}finally{c.release(true);}})():r.pool.connect(),denied);
    await r.close();assert.equal(f.clients.length,1);if(phase!=='construct')assert.equal(f.clients[0].ends,1);await assert.rejects(r.pool.connect(),denied);
  }
});
for(const outcome of ['before','after'])test('accepted runner retains commit_unknown503 on '+outcome+' acknowledgement loss',async()=>{
  let committed=false;
  const f=fake({query(q){if(q.text.startsWith('SELECT id::text AS id'))return rows([{id:ids.person}]);if(q.text.includes('clock_timestamp'))return rows([{now_ms:String(clock)}]);
    if(q.text==='COMMIT'){committed=outcome==='after';throw Error('private-fake-error');}return rows();}}),r=createCloudflarePostgres(f.Client,postgres);
  await assert.rejects(new PostgresTransactions(r.pool).run([ids.person],async()=>1),e=>denied(e)&&e.outcome==='commit_unknown');await r.close();
  assert.equal(committed,outcome==='after');assert.equal(f.clients[0].queries.filter(x=>x.text==='COMMIT').length,1);assert.equal(f.clients[0].queries.some(x=>x.text==='ROLLBACK'),false);assert.equal(f.clients[0].ends,1);
  assert.deepEqual(f.clients[0].queries[1].values,['deny','','[]','','','']);
});

const request=(method='GET',path='/me',token,body,key='offline-key',signal)=>new Request(origin+'/api/v1'+path,{method,headers:{origin:ui,...(token?{authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':'application/json'}),'idempotency-key':key},...(body===undefined?{}:{body:JSON.stringify(body)}),...(signal?{signal}:{})});
const baseConfig=()=>({mode:'production',botToken:botKey,sessionPolicy:testPolicy,numericPresentation:testNumbers,now:()=>clock});
test('P2-CF-01 pending body abort cancels the source exactly once and releases its reader',async()=>{
  const entered=deferred(),abort=new AbortController(),f=fake();let source,cancels=0;
  const body=new ReadableStream({start(c){source=c;},pull(){entered.resolve();return new Promise(()=>{});},cancel(){cancels++;}});
  const req=new Request(origin+'/api/v1/auth/telegram',{method:'POST',headers:{origin:ui},body,duplex:'half',signal:abort.signal});
  const app=createCloudflareApi({apiOrigin:origin,allowedOrigins:[ui],Client:f.Client,postgres,configuration:baseConfig()});
  try{
    const pending=app.fetch(req);await entered.promise;await new Promise(r=>setImmediate(r));assert.equal(req.body.locked,true);
    abort.abort();const response=await pending;
    assert.equal(response.status,503);assert.equal((await response.json()).error.code,'SERVICE_UNAVAILABLE');
    assert.equal(cancels,1);assert.equal(req.body.locked,false);assert.equal(f.clients.length,0);
  }finally{abort.abort();try{source.error(Error('synthetic test teardown'));}catch{}}
});
test('P2-CF-02 missing private bindings retain only the valid origin CORS on sanitized503',async()=>{
  const app=createCloudflareApi({apiOrigin:origin,allowedOrigins:[ui],configuration:baseConfig()});
  const response=await app.fetch(request());assert.equal(response.status,503);assert.equal(response.headers.get('access-control-allow-origin'),ui);
  assert.ok(response.headers.get('vary').split(/,\s*/).includes('Origin'));assert.equal(response.headers.get('cache-control'),'no-store');
  const body=await response.json();assert.equal(body.error.code,'SERVICE_UNAVAILABLE');assert.deepEqual(Object.keys(body),['error']);
});
test('P2-CF-02 rejecting owned-client disposal retains CORS, sanitizes failure and ends once',async()=>{
  const f=fake({end:()=>Promise.reject(Error('private-fake-error'))}),app=createCloudflareApi({apiOrigin:origin,allowedOrigins:[ui],Client:f.Client,postgres,configuration:baseConfig()});
  const response=await app.fetch(request('GET','/me','synthetic-unresolved-session'));assert.equal(response.status,503);
  assert.equal(response.headers.get('access-control-allow-origin'),ui);assert.equal(f.clients[0].ends,1);assert.ok(!(await response.text()).includes('private-fake-error'));
});
for(const kind of ['rejecting','pending'])test('body cancellation hook '+kind+' cannot retain the source lock or repeat cancellation',async()=>{
  const entered=deferred(),abort=new AbortController();let source,cancels=0;
  const body=new ReadableStream({start(c){source=c;},pull(){entered.resolve();return new Promise(()=>{});},cancel(){cancels++;return kind==='rejecting'?Promise.reject(Error('private-fake-error')):new Promise(()=>{});}});
  const req=new Request(origin+'/api/v1/auth/telegram',{method:'POST',body,duplex:'half',signal:abort.signal});
  const app=createCloudflareApi({apiOrigin:origin,allowedOrigins:[ui]});
  try{
    const work=app.fetch(req);await entered.promise;await new Promise(r=>setImmediate(r));assert.equal(req.body.locked,true);abort.abort();
    const response=await work;assert.equal(response.status,503);assert.equal(req.body.locked,false);assert.equal(cancels,1);assert.ok(!(await response.text()).includes('private-fake-error'));
    abort.abort();assert.equal(cancels,1);
  }finally{abort.abort();try{source.error(Error('synthetic test teardown'));}catch{}}
});
for(const kind of ['missing','end failure'])test('fallback '+kind+' never reflects a foreign origin or bypasses the public URL/preflight checks',async()=>{
  const f=fake({end:()=>Promise.reject(Error('private-fake-error'))});
  const app=createCloudflareApi({apiOrigin:origin,allowedOrigins:[ui],configuration:baseConfig(),...(kind==='missing'?{}:{Client:f.Client,postgres})});
  const foreign=await app.fetch(new Request(origin+'/api/v1/me',{headers:{origin:'https://foreign.invalid'}}));assert.equal(foreign.status,403);assert.equal(foreign.headers.get('access-control-allow-origin'),null);
  const forwarded=await app.fetch(new Request('https://foreign.invalid/api/v1/me',{headers:{origin:ui,'x-forwarded-host':new URL(origin).host}}));assert.equal(forwarded.status,400);assert.equal(forwarded.headers.get('access-control-allow-origin'),null);
  const noOrigin=await app.fetch(new Request(origin+'/api/v1/me',{headers:{authorization:'Bearer synthetic'}}));assert.equal(noOrigin.status,503);assert.equal(noOrigin.headers.get('access-control-allow-origin'),null);
  const preflight=await app.fetch(new Request(origin+'/api/v1/exams',{method:'OPTIONS',headers:{origin:ui,'access-control-request-method':'GET'}}));assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),ui);
  const invalidRequest=new Request(origin+'/api/v1/exams',{method:'OPTIONS',headers:{origin:ui,'access-control-request-method':'DELETE'}});
  const control=await createVercelNodeFunction({apiOrigin:origin,allowedOrigins:[ui]}).fetch(invalidRequest.clone());
  const invalid=await app.fetch(invalidRequest);assert.equal(invalid.status,403);assert.equal(control.status,403);
  // Existing CORS retains the valid origin header even when its method is denied.
  assert.equal(invalid.headers.get('access-control-allow-origin'),control.headers.get('access-control-allow-origin'));assert.equal(invalid.headers.get('access-control-allow-origin'),ui);
});
test('CORS rejection never acquires the original request body reader',async()=>{
  let pulls=0,cancels=0;const body=new ReadableStream({pull(){pulls++;},cancel(){cancels++;}},{highWaterMark:0});
  const req=new Request(origin+'/api/v1/auth/telegram',{method:'POST',headers:{origin:'https://foreign.invalid'},body,duplex:'half'});
  const f=fake(),app=createCloudflareApi({apiOrigin:origin,allowedOrigins:[ui],Client:f.Client,postgres,configuration:baseConfig()});
  assert.equal((await app.fetch(req)).status,403);assert.equal(req.body.locked,false);assert.equal(pulls,0);assert.equal(cancels,0);assert.equal(f.clients.length,0);
});
test('missing private bindings/default configuration fail503; shared Web CORS and origin checks remain',async()=>{
  const app=createCloudflareApi({apiOrigin:origin,allowedOrigins:[ui]});
  const closed=await app.fetch(request());assert.equal(closed.status,503);assert.equal(closed.headers.get('cloudflare-cdn-cache-control'),'no-store');assert.equal(closed.headers.get('access-control-allow-origin'),ui);
  const preflight=await app.fetch(new Request(origin+'/api/v1/exams',{method:'OPTIONS',headers:{origin:ui,'access-control-request-method':'GET','access-control-request-headers':'authorization'}}));assert.equal(preflight.status,204);
  assert.equal((await app.fetch(new Request(origin+'/api/v1/me',{headers:{origin:'https://foreign.invalid'}}))).status,403);
  assert.equal((await app.fetch(new Request('https://foreign.invalid/api/v1/me',{headers:{'x-forwarded-host':new URL(origin).host}}))).status,400);
  const missing=createCloudflareApi({apiOrigin:origin,allowedOrigins:[ui],configuration:baseConfig()});const denied=await missing.fetch(request());assert.equal(denied.status,503);assert.equal((await denied.json()).error.code,'SERVICE_UNAVAILABLE');
});
test('CORS/preflight/body rejections construct no client; shared limit preserves raw bytes',async()=>{
  const f=fake(),app=createCloudflareApi({apiOrigin:origin,allowedOrigins:[ui],Client:f.Client,postgres,configuration:baseConfig()});
  const send=(body,headers={})=>app.fetch(new Request(origin+'/api/v1/auth/telegram',{method:'POST',headers,body,...(body instanceof ReadableStream?{duplex:'half'}:{})}));
  for(const headers of [{'content-length':'65537'},{'content-length':'2'}])assert.equal((await send('x',headers)).status,400);
  const chunks=new ReadableStream({start(c){c.enqueue(new Uint8Array(65537));c.close();}});assert.equal((await send(chunks)).status,400);
  const broken=new ReadableStream({start(c){c.error(Error('private-fake-error'));}});const response=await send(broken);assert.equal(response.status,400);assert.ok(!(await response.text()).includes('private-fake-error'));
  assert.equal((await app.fetch(new Request(origin+'/api/v1/exams',{method:'OPTIONS',headers:{origin:ui,'access-control-request-method':'GET'}}))).status,204);assert.equal(f.clients.length,0);
});

const clerkIdentity={issuer:'https://clerk.offline.invalid',userId:'user_SyntheticWorkerA',sessionId:'sess_SyntheticWorkerA'};
const clerkVerifier={issuer:clerkIdentity.issuer,authorizedParties:[ui],audience:{kind:'clerk_default_no_audience'},trustedKeys:()=>{throw Error('No signature bypass in opaque-session test');},now:()=>clock};
async function seed(clerk=false){
  const pool=new MemoryPool(),family=crypto.randomUUID(),token='synthetic-worker-opaque-session';
  pool.state.families[family]={personId:ids.person,expiresAt:clock+60000,revokedAt:null,logoutRetainUntil:null,authProvider:clerk?'clerk':'telegram'};
  pool.state.access[await proofHash(token)]={familyId:family,expiresAt:clock+15000,superseded:false};
  if(clerk){pool.state.people[ids.person].telegramId=null;pool.bindings[family]=clerkIdentity;pool.identities=[{issuer:clerkIdentity.issuer,subject:clerkIdentity.userId,person_id:ids.person,enabled:true}];pool.fences=[{issuer:clerkIdentity.issuer,subject:clerkIdentity.userId,sid:clerkIdentity.sessionId,person_id:ids.person,retired_at_ms:null}];}
  return {pool,token};
}
async function flow(send,token){
  for(const path of ['/me','/exams',`/exams/${ids.assignment}`])assert.equal((await send('GET',path,token)).status,200);
  const start=await send('POST',`/exams/${ids.assignment}/attempts`,token,{confirmed:true},'Cloudflare-Start');assert.equal(start.status,200,JSON.stringify(start));const a=start.data;
  assert.equal((await send('GET',`/attempts/${a.id}`,token)).status,200);
  const path=`/attempts/${a.id}/answers/${ids.question}`;
  assert.equal((await send('PUT',path,token,{selected_option_id:ids.wrong,expected_revision:0})).data.revision,1);
  assert.equal((await send('PUT',path,token,{selected_option_id:ids.correct,expected_revision:1})).data.revision,2);
  const stale=await send('PUT',path,token,{selected_option_id:ids.wrong,expected_revision:1});assert.equal(stale.status,409);assert.equal(stale.error.code,'REVISION_CONFLICT');
  const submitted=await send('POST',`/attempts/${a.id}/submit`,token,undefined,'Cloudflare-Submit');assert.equal(submitted.status,200,JSON.stringify(submitted));
  assert.deepEqual((await send('GET',`/attempts/${a.id}/result`,token)).data,submitted.data);
  const resume=await send('GET',`/attempts/${a.id}`,token);assert.equal(resume.data.deadline_at,a.deadline_at);assert.equal(resume.data.generation,a.generation);return a;
}
// Calibrate only the existing inert named-statement dispatcher. Replay through
// the actual unnamed port then requires exact observed SQL text, never SQL
// parsing, execution, a permissive recognizer or production fixture bypass.
let statements;
async function statementMap(){
  if(statements)return statements;
  const f=await seed(),map=new Map(),pool={async connect(){const c=await f.pool.connect();return {query:q=>{map.set(q.text,q.name);return c.query(q);},release:d=>c.release(d)};}};
  const handler=createConfiguredHttpHandler({...baseConfig(),storage:{kind:'postgres',pool}});
  await flow(async(...args)=>{const r=await handler(request(...args));return {status:r.status,...await r.json()};},f.token);
  const clerk=await seed(true),recording={async connect(){const c=await clerk.pool.connect();return {query:q=>{map.set(q.text,q.name);return c.query(q);},release:d=>c.release(d)};}};
  const control=createConfiguredHttpHandler({...baseConfig(),storage:{kind:'postgres',pool:recording},clerk:{verifier:clerkVerifier,liveness:async identity=>({...identity,status:'active',accountEnabled:true,expiresAt:clock+10000})}});
  assert.equal((await control(request('GET','/exams',clerk.token))).status,200);statements=map;return map;
}
async function workerFixture(clerk){
  const f=await seed(!!clerk),map=await statementMap(),clients=[];
  class Client extends EventEmitter{
    constructor(){super();this.ends=0;this.connects=0;this.queries=[];clients.push(this);}
    async connect(){this.connects++;this.lease=await f.pool.connect();}
    async query(q){assert.deepEqual(Object.keys(q).sort(),['text','values']);this.queries.push(q);const name=map.get(q.text);assert.ok(name,'Unexpected inert SQL text');return this.lease.query({...q,name});}
    async end(){this.ends++;this.lease?.release(false);}
  }
  const app=createCloudflareApi({apiOrigin:origin,allowedOrigins:[ui],Client,postgres,configuration:{...baseConfig(),now:()=>f.pool.now,...(clerk?{clerk:{verifier:clerkVerifier,liveness:clerk}}:{})}});
  return {...f,clients,app,send:async(...args)=>{const r=await app.fetch(request(...args));return {status:r.status,...await r.json()};}};
}
test('Cloudflare fetch preserves complete student flow and creates/closes an isolated client per request',async()=>{
  const f=await workerFixture();await flow(f.send,f.token);assert.deepEqual(f.pool.answerBranches,['INSERT','UPDATE']);
  assert.equal(f.clients.length,11);for(const c of f.clients){assert.equal(c.connects,1);assert.equal(c.ends,1);assert.equal(c.queries[0].text,'BEGIN');assert.deepEqual(c.queries[1].values,['deny','','[]','','','']);}
});
for(const [label,change,status]of [['revoked',s=>Object.values(s.families)[0].revokedAt=clock,401],['expired',s=>Object.values(s.families)[0].expiresAt=clock,401],['disabled',s=>s.people[ids.person].enabled=false,403]])
test('current '+label+' actor denies before private domain loading',async()=>{
  const f=await workerFixture();change(f.pool.state);const r=await f.send('GET','/exams',f.token);assert.equal(r.status,status);
  assert.equal(f.pool.events.some(e=>e.name==='ua_http_assignments'),false);assert.equal(f.clients[0].ends,1);
});
test('HTTP commit uncertainty yields503 without ACK or retry',async()=>{
  const f=await workerFixture();f.pool.failCommit='after';const r=await f.send('GET','/me',f.token);assert.equal(r.status,503);assert.equal(r.data,undefined);
  assert.equal(f.clients[0].queries.filter(q=>q.text==='COMMIT').length,1);assert.equal(f.clients[0].ends,1);
});
test('failed owned-client disposal cannot produce a successful HTTP acknowledgement',async()=>{
  const f=fake({end(){throw Error('private-fake-error');}}),app=createCloudflareApi({apiOrigin:origin,allowedOrigins:[ui],Client:f.Client,postgres,configuration:baseConfig()});
  const r=await app.fetch(request('GET','/me','synthetic-unresolved-session'));assert.equal(r.status,503);assert.ok(!(await r.text()).includes('private-fake-error'));assert.equal(f.clients[0].ends,1);
});
for(const [label,status,enabled]of [['revoked','revoked',true],['disabled account','active',false]])test('Clerk '+label+' denies401 before domain reads',async()=>{
  const f=await workerFixture(async identity=>({...identity,status,accountEnabled:enabled,expiresAt:clock+10000}));
  const r=await f.send('GET','/exams',f.token);assert.equal(r.status,401);assert.equal(f.pool.events.some(e=>e.name==='ua_http_assignments'),false);assert.equal(f.clients[0].ends,1);
});
test('Clerk lease shortened to the final clock boundary cannot commit or acknowledge',async()=>{
  let checks=0;const f=await workerFixture(async identity=>({...identity,status:'active',accountEnabled:true,expiresAt:++checks===1?clock+10000:clock+100}));
  f.pool.onStatement=name=>{if(name==='ua_http_assignments')f.pool.now=clock+100;};const r=await f.send('GET','/exams',f.token);
  assert.equal(r.status,401);assert.equal(f.clients[0].queries.some(q=>q.text==='COMMIT'),false);assert.equal(f.clients[0].ends,1);
});
test('HTTP cancellation reaches Clerk liveness and closes once even when its late response ignores abort',async()=>{
  const entered=deferred(),late=deferred(),controller=new AbortController();let providerSignal;
  const f=await workerFixture(async(identity,at,options)=>{providerSignal=options.signal;entered.resolve();await late.promise;return {...identity,status:'active',accountEnabled:true,expiresAt:clock+10000};});
  const work=f.send('GET','/exams',f.token,undefined,undefined,controller.signal);await entered.promise;controller.abort();
  const r=await work;assert.equal(r.status,503);assert.equal(providerSignal.aborted,true);assert.equal(f.clients[0].ends,1);
  late.resolve();await new Promise(r=>setImmediate(r));assert.equal(f.clients[0].queries.some(q=>q.text==='COMMIT'),false);assert.equal(f.clients[0].ends,1);
});
test('concurrent requests cannot share owned clients; request cancellation closes once and prevents ACK',async()=>{
  const f=await workerFixture();await Promise.all([f.send('GET','/me',f.token),f.send('GET','/me',f.token)]);assert.equal(f.clients.length,2);for(const c of f.clients)assert.equal(c.ends,1);
  // These two accepted labels have identical SQL text after name stripping.
  const controller=new AbortController();f.pool.onStatement=name=>{if(['ua_http_person','ua_clerk_person'].includes(name))controller.abort();};
  const r=await f.send('GET','/me',f.token,undefined,undefined,controller.signal);assert.equal(r.status,503);assert.equal(r.data,undefined);assert.equal(f.clients[2].ends,1);
});
test('new modules are factories without listener/global fetch/default deployment or Node SDK binding',async()=>{
  for(const path of ['cloudflare-api','cloudflare-postgres','clerk-worker-bindings']){
    const source=await readFile(new URL('../../runtime/'+path+'.mjs',import.meta.url),'utf8');
    assert.doesNotMatch(source,/from ["']node:|clerk-sdk-bindings|globalThis\.fetch\s*=|export default|\.listen\(/);
  }
});

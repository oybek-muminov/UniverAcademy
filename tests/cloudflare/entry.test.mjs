import {test} from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {readFile} from "node:fs/promises";
import entry,{createCloudflareEntrypoint} from "../../runtime/cloudflare-entry.mjs";
import {createClerkWorkerBindings} from "../../runtime/clerk-worker-bindings.mjs";
import {createConfiguredHttpHandler} from "../../supabase/functions/univeracademy-api/configured-http.ts";
import {createClerkVerifier} from "../../supabase/functions/univeracademy-api/clerk-auth.ts";
import {proofHash} from "../../supabase/functions/univeracademy-api/student-state.ts";
import {MemoryPool} from "../backend/student-prepared/memory-pool.mjs";
import {ids,clock,testPolicy,testNumbers} from "../backend/http-fixture.ts";

const api="https://api.entry.invalid",ui="https://mini.entry.invalid",issuer="https://clerk.entry.invalid";
const identity={issuer,userId:"user_EntrySyntheticA",sessionId:"sess_EntrySyntheticA"};
const secret="synthetic-entry-secret-never-echo";
const settings={issuer,authorizedParties:[ui],audience:{kind:"clerk_default_no_audience"},
  jwksCacheMs:300000,jwksCooldownMs:0,timeoutMs:1000,maxJwksBytes:65536};
const bindings=()=>({UA_API_ORIGIN:api,UA_ALLOWED_ORIGINS:JSON.stringify([ui]),UA_SESSION_POLICY:JSON.stringify(testPolicy),
  UA_CLERK_PROVIDER_SETTINGS:JSON.stringify(settings),UA_CLERK_SECRET_KEY:secret,
  HYPERDRIVE:{connectionString:"postgres://synthetic:synthetic@hyperdrive.invalid:5432/synthetic"}});
const request=(method="GET",path="/me",token,body,signal,origin=ui)=>new Request(api+"/api/v1"+path,
  {method,headers:{origin,...(token?{authorization:"Bearer "+token}:{}),...(body===undefined?{}:{"content-type":"application/json"})},
    ...(body===undefined?{}:{body:typeof body==="string"?body:JSON.stringify(body)}),...(signal?{signal}:{})});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function safe(response,status=503){
  assert.equal(response.status,status);assert.equal(response.headers.get("access-control-allow-origin"),ui);
  assert.equal(response.headers.get("cache-control"),"no-store");
  const text=await response.text();for(const privateText of [secret,"private-driver-failure","postgres://"])assert.ok(!text.includes(privateText));
  return JSON.parse(text);
}
const verifier=()=>({issuer,authorizedParties:[ui],audience:{kind:"clerk_default_no_audience"},
  trustedKeys:()=>{throw Error("No JWT verifier substitute in opaque-session unit test");},now:()=>clock});

async function seeded(){
  const pool=new MemoryPool(),family=crypto.randomUUID(),token="synthetic-entry-opaque-session";
  pool.state.people[ids.person].telegramId=null;
  pool.state.families[family]={personId:ids.person,expiresAt:clock+60000,revokedAt:null,logoutRetainUntil:null,authProvider:"clerk"};
  pool.state.access[await proofHash(token)]={familyId:family,expiresAt:clock+15000,superseded:false};
  pool.bindings[family]=identity;pool.identities=[{issuer,subject:identity.userId,person_id:ids.person,enabled:true}];
  pool.fences=[{issuer,subject:identity.userId,sid:identity.sessionId,person_id:ids.person,retired_at_ms:null}];
  return {pool,token};
}
// The accepted fake dispatcher needs statement labels, which pg never receives.
// Calibrate exact SQL from the real handler once; reject any unobserved SQL text.
// No SQL parsing/execution or permissive production fixture is involved.
let statementPromise;
function statementMap(){return statementPromise??=(async()=>{
  const f=await seeded(),map=new Map(),pool={async connect(){const c=await f.pool.connect();return {
    query:q=>{map.set(q.text,q.name);return c.query(q);},release:d=>c.release(d)};}};
  const control=createConfiguredHttpHandler({mode:"production",storage:{kind:"postgres",pool},sessionPolicy:testPolicy,
    numericPresentation:testNumbers,now:()=>clock,clerk:{verifier:verifier(),liveness:async id=>({...id,status:"active",accountEnabled:true,expiresAt:clock+10000})}});
  for(const path of ["/me","/exams"])assert.equal((await control(request("GET",path,f.token))).status,200);
  return map;
})();}
async function fixture(patch={}){
  const f=await seeded(),map=await statementMap(),clients=[],clerks=[],calls=[];let loads=0;
  class Client extends EventEmitter{
    constructor(options){super();this.options=options;this.ends=0;this.queries=[];clients.push(this);patch.construct?.(this);}
    async connect(){await patch.connect?.(this);this.lease=await f.pool.connect();}
    async query(q){
      assert.deepEqual(Object.keys(q).sort(),["text","values"]);this.queries.push(q);
      const name=map.get(q.text);assert.ok(name,"Unexpected inert SQL text");return this.lease.query({...q,name});
    }
    async end(){this.ends++;this.lease?.release(false);await patch.end?.(this);}
  }
  // Test-only provider port. It uses the real bounded Worker transport, but this
  // small join is not the JOSE/provider adapter and is never integration proof.
  const makeClerk=async(c,options)=>{
    const b=createClerkWorkerBindings({...options,issuer:c?.issuer}),v={...verifier(),issuer:c?.issuer,
      authorizedParties:c?.authorizedParties,audience:c?.audience,now:options.now};createClerkVerifier(v);
    const record={options,closes:0,b};clerks.push(record);
    return {verifier:v,liveness:async(id,at,extra)=>{
      const session=await b.getSession(id.sessionId,extra),user=await b.getUser(id.userId,extra);
      return {...id,userId:session.userId,sessionId:session.id,status:session.status,
        accountEnabled:!user.banned&&!user.locked&&!user.deprovisioned&&user.id===id.userId,
        expiresAt:Math.min(session.expireAt,session.abandonAt)};
    },async close(){record.closes++;b.close();await patch.clerkClose?.(record);}};
  };
  const transport=async r=>{
    calls.push(r);if(patch.transport)return patch.transport(r);
    const value=r.url.includes("/sessions/")?{id:identity.sessionId,user_id:identity.userId,status:patch.status??"active",
      expire_at:patch.expiry??clock+10000,abandon_at:patch.expiry??clock+10000,actor:null}:
      {id:identity.userId,banned:patch.disabled??false,locked:false,deprovisioned:false};
    return new Response(JSON.stringify(value),{headers:{"content-type":"application/json"}});
  };
  const app=createCloudflareEntrypoint({loadClient:async()=>{loads++;await patch.load?.();return Client;},makeClerk,transport,now:()=>f.pool.now});
  return {...f,app,clients,clerks,calls,get loads(){return loads;}};
}

test("default import and factory construction are inert; missing bindings fail closed without ambient fetch",async()=>{
  const before=globalThis.fetch;let fetched=0;
  globalThis.fetch=()=>{fetched++;throw Error(secret);};
  try{const r=await entry.fetch(request(),undefined);assert.equal(r.status,503);assert.ok(!(await r.text()).includes(secret));}
  finally{globalThis.fetch=before;}
  assert.equal(fetched,0);assert.equal(typeof entry.fetch,"function");
  const source=await readFile(new URL("../../runtime/cloudflare-entry.mjs",import.meta.url),"utf8");
  assert.doesNotMatch(source,/from ["'](?:node:|pg["'])|clerk-sdk|testNumbers|tests\/|\.listen\(|waitUntil/);
  assert.match(source,/await import\("pg"\)/);
});
for(const missing of ["UA_SESSION_POLICY","UA_CLERK_PROVIDER_SETTINGS","UA_CLERK_SECRET_KEY","HYPERDRIVE"])
test("missing private binding "+missing+" returns CORS503 and performs no I/O",async()=>{
  const f=await fixture(),env=bindings();delete env[missing];await safe(await f.app.fetch(request(),env));
  assert.equal(f.clients.length,0);assert.equal(f.calls.length,0);assert.equal(f.loads,0);
});
for(const patch of [
  {UA_SESSION_POLICY:"{"},{UA_SESSION_POLICY:"null"},{UA_SESSION_POLICY:JSON.stringify({...testPolicy,newLogin:"reuse"})},
  {UA_SESSION_POLICY:JSON.stringify({...testPolicy,accessTtlMs:-1})},{UA_SESSION_POLICY:JSON.stringify({...testPolicy,trusted:true})},
  {UA_CLERK_PROVIDER_SETTINGS:"[]"},{UA_CLERK_SECRET_KEY:""},{UA_CLERK_SECRET_KEY:"bad\nvalue"},
  {HYPERDRIVE:{}},{HYPERDRIVE:{connectionString:"postgres://u:p@host/db"}},
  {HYPERDRIVE:{connectionString:"postgres://u:p@host:5432/db?sslmode=disable"}},{trusted:true},
])test("malformed/overridden private binding fails closed "+Object.keys(patch)[0],async()=>{
  const f=await fixture();await safe(await f.app.fetch(request(),{...bindings(),...patch}));assert.equal(f.clients.length,0);assert.equal(f.calls.length,0);
});
test("binding getters and client header/body configuration do not become trusted resources",async()=>{
  const f=await fixture(),env=bindings();let reads=0;
  Object.defineProperty(env,"UA_SESSION_POLICY",{get(){reads++;throw Error(secret);}});
  await safe(await f.app.fetch(request(),env));assert.equal(reads,0);
  const missing=bindings();delete missing.HYPERDRIVE;
  const req=request("POST","/auth/clerk",undefined,{HYPERDRIVE:bindings().HYPERDRIVE,person_id:ids.person,trusted:true});req.headers.set("x-ua-clerk-secret-key",secret);
  await safe(await f.app.fetch(req,missing));assert.equal(f.loads,0);assert.equal(f.calls.length,0);assert.equal(f.clients.length,0);
});
test("nonstring public binding values cannot invoke coercion hooks",async()=>{
  const f=await fixture();let coerced=0;const hostile={toString(){coerced++;throw Error(secret);}};
  for(const key of ["UA_API_ORIGIN","UA_ALLOWED_ORIGINS"]){
    const r=await f.app.fetch(request(),{...bindings(),[key]:hostile});assert.equal(r.status,503);assert.equal(r.headers.get("access-control-allow-origin"),null);
  }
  assert.equal(coerced,0);assert.equal(f.loads,0);assert.equal(f.calls.length,0);
});
test("CORS, origin, preflight and registration route rejection happen before private setup",async()=>{
  const f=await fixture(),env={UA_API_ORIGIN:api,UA_ALLOWED_ORIGINS:JSON.stringify([ui])};
  const foreign=await f.app.fetch(request("GET","/me",undefined,undefined,undefined,"https://foreign.invalid"),env);assert.equal(foreign.status,403);assert.equal(foreign.headers.get("access-control-allow-origin"),null);
  const forwarded=await f.app.fetch(new Request("https://foreign.invalid/api/v1/me",{headers:{origin:ui,"x-forwarded-host":new URL(api).host}}),env);assert.equal(forwarded.status,400);assert.equal(forwarded.headers.get("access-control-allow-origin"),null);
  const preflight=await f.app.fetch(new Request(api+"/api/v1/exams",{method:"OPTIONS",headers:{origin:ui,"access-control-request-method":"GET","access-control-request-headers":"authorization"}}),env);assert.equal(preflight.status,204);
  for(const [method,path] of [["POST","/exams"],["PUT","/me"],["GET","/admin/groups"],["POST","/exams/00000000-0000-4000-8000-000000000001/attempts"]])await safe(await f.app.fetch(request(method,path),env));
  assert.equal(f.loads,0);assert.equal(f.clients.length,0);assert.equal(f.clerks.length,0);assert.equal(f.calls.length,0);
});
test("shared body limits and absent authorization reject without DB/provider I/O",async()=>{
  const f=await fixture();
  for(const body of ["x".repeat(65537),"{"]){const r=await f.app.fetch(request("POST","/auth/clerk",undefined,body),bindings());assert.ok([400,401].includes(r.status));}
  await safe(await f.app.fetch(request(),bindings()),401);
  assert.equal(f.clients.length,0);assert.equal(f.calls.length,0);for(const c of f.clerks)assert.equal(c.closes,1);
});
test("GET/exams traverses real current authorization and domain rows; it is not a canned empty response",async()=>{
  const f=await fixture(),r=await f.app.fetch(request("GET","/exams",f.token),bindings());assert.equal(r.status,200);
  const body=await r.json();assert.ok(body.data.length>0);assert.equal(body.data[0].assignment_id,ids.assignment);
  assert.ok(f.pool.events.some(e=>e.name==="ua_http_assignments"));assert.ok(f.calls.some(r=>r.url.endsWith("/users/"+identity.userId)));
  assert.equal(f.clients.length,1);assert.equal(f.clients[0].ends,1);assert.equal(f.clerks[0].closes,1);
  assert.deepEqual(f.clients[0].queries[1].values,["deny","","[]","","",""]);
  assert.equal(r.headers.get("access-control-allow-origin"),ui);
});
test("concurrent requests have separate clients, Clerk cancellation scopes and every-BEGIN context resets",async()=>{
  const f=await fixture();const replies=await Promise.all([f.app.fetch(request("GET","/exams",f.token),bindings()),f.app.fetch(request("GET","/exams",f.token),bindings())]);
  assert.deepEqual(replies.map(r=>r.status),[200,200]);assert.equal(f.clients.length,2);assert.equal(f.clerks.length,2);
  assert.notEqual(f.clerks[0].options.signal,f.clerks[1].options.signal);
  for(const c of f.clients){assert.equal(c.ends,1);assert.equal(c.queries[0].text,"BEGIN");assert.deepEqual(c.queries[1].values,["deny","","[]","","",""]);}
  for(const c of f.clerks)assert.equal(c.closes,1);
});
for(const patch of [{status:"revoked"},{disabled:true},{expiry:clock}])test("current provider denial prevents private reads "+JSON.stringify(patch),async()=>{
  const f=await fixture(patch);await safe(await f.app.fetch(request("GET","/exams",f.token),bindings()),401);
  assert.equal(f.pool.events.some(e=>e.name==="ua_http_assignments"),false);assert.equal(f.clients[0].ends,1);assert.equal(f.clerks[0].closes,1);
});
for(const phase of ["end","clerkClose","load"])test("owned-resource "+phase+" failure is sanitized CORS503 without a retry",async()=>{
  const f=await fixture({[phase](){throw Error(secret+" private-driver-failure");}});
  await safe(await f.app.fetch(request("GET","/exams",f.token),bindings()));assert.equal(f.loads,1);
  if(phase!=="load")assert.equal(f.clients[0].ends,1);assert.equal(f.clerks[0].closes,1);
});
test("no ACK precedes Client end and Clerk close completion",async()=>{
  const ending=deferred(),closing=deferred(),enteredEnd=deferred(),enteredClose=deferred();
  const f=await fixture({end(){enteredEnd.resolve();return ending.promise;},clerkClose(){enteredClose.resolve();return closing.promise;}});let done=false;
  const pending=f.app.fetch(request("GET","/exams",f.token),bindings()).then(r=>{done=true;return r;});
  await enteredEnd.promise;assert.equal(done,false);ending.resolve();await enteredClose.promise;assert.equal(done,false);closing.resolve();assert.equal((await pending).status,200);
  assert.equal(f.clients[0].ends,1);assert.equal(f.clerks[0].closes,1);
});
for(const lost of ["before","after"])test("COMMIT acknowledgement loss "+lost+" remains503 with one COMMIT and no retry",async()=>{
  const f=await fixture();f.pool.failCommit=lost;await safe(await f.app.fetch(request("GET","/exams",f.token),bindings()));
  assert.equal(f.clients[0].queries.filter(q=>q.text==="COMMIT").length,1);assert.equal(f.clients[0].queries.some(q=>q.text==="ROLLBACK"),false);assert.equal(f.clients[0].ends,1);assert.equal(f.clerks[0].closes,1);
});
test("abort during pending body consumption cancels/releases once and never constructs a Client",async()=>{
  const f=await fixture(),entered=deferred(),controller=new AbortController();let cancels=0;
  const stream=new ReadableStream({pull(){entered.resolve();return new Promise(()=>{});},cancel(){cancels++;}},{highWaterMark:0});
  const req=new Request(api+"/api/v1/auth/clerk",{method:"POST",headers:{origin:ui},body:stream,duplex:"half",signal:controller.signal});
  const pending=f.app.fetch(req,bindings());await entered.promise;controller.abort();await safe(await pending);
  assert.equal(cancels,1);assert.equal(req.body.locked,false);assert.equal(f.clients.length,0);assert.equal(f.calls.length,0);assert.equal(f.clerks[0].closes,1);
});
test("abort during provider read reaches the real Worker binding and cannot commit or retry SQL",async()=>{
  const entered=deferred(),late=deferred(),controller=new AbortController();let providerSignal;
  const f=await fixture({transport(r){providerSignal=r.signal;entered.resolve();return late.promise;}});
  const pending=f.app.fetch(request("GET","/exams",f.token,undefined,controller.signal),bindings());await entered.promise;controller.abort();await safe(await pending);
  assert.equal(providerSignal.aborted,true);assert.equal(f.clients[0].ends,1);assert.equal(f.clerks[0].closes,1);
  late.resolve(new Response("{}",{headers:{"content-type":"application/json"}}));await new Promise(r=>setImmediate(r));
  assert.equal(f.clients[0].queries.some(q=>q.text==="COMMIT"),false);assert.equal(f.clients[0].ends,1);
});
test("separate Wrangler API proposal has no bot/default-entry, account, binding ID, secrets or route",async()=>{
  const text=await readFile(new URL("../../wrangler.api.jsonc",import.meta.url),"utf8"),config=JSON.parse(text.split("\n").filter(l=>!l.trimStart().startsWith("//")).join("\n"));
  assert.deepEqual(config,{"$schema":"node_modules/wrangler/config-schema.json",name:"univeracademy-api",main:"runtime/cloudflare-worker.mjs",compatibility_date:"2026-11-11",compatibility_flags:["nodejs_compat"],workers_dev:false,preview_urls:false});
  assert.doesNotMatch(text,/univeracademy-bot|account_id|routes?\s*:|"id"\s*:/);
});
for(const patch of [{UA_API_ORIGIN:"http://localhost"},{UA_API_ORIGIN:api+"/"},{UA_ALLOWED_ORIGINS:"[\"*\"]"},{UA_ALLOWED_ORIGINS:"null"},{UA_ALLOWED_ORIGINS:"{"}])
test("invalid public configuration cannot authorize CORS or construct private resources",async()=>{
  const f=await fixture(),r=await f.app.fetch(request(),{...bindings(),...patch});assert.equal(r.status,503);assert.equal(r.headers.get("access-control-allow-origin"),null);
  assert.equal(f.loads,0);assert.equal(f.calls.length,0);assert.equal(f.clients.length,0);
});
test("abort before entry and during lazy module loading cannot construct a client or escape Clerk disposal",async()=>{
  const f=await fixture(),controller=new AbortController();controller.abort();await safe(await f.app.fetch(request("GET","/me",undefined,undefined,controller.signal),bindings()));
  assert.equal(f.loads,0);assert.equal(f.clerks.length,0);
  const entered=deferred(),late=deferred(),g=await fixture({load(){entered.resolve();return late.promise;}}),abort=new AbortController();
  const pending=g.app.fetch(request("GET","/exams",g.token,undefined,abort.signal),bindings());await entered.promise;abort.abort();late.resolve();await safe(await pending);
  assert.equal(g.clients.length,0);assert.equal(g.calls.length,0);assert.equal(g.clerks[0].closes,1);
});
test("one request cancellation does not cancel a concurrent request's Clerk/DB context",async()=>{
  const entered=deferred(),late=deferred(),abort=new AbortController();let first=true;
  const f=await fixture({transport(r){
    if(first){first=false;entered.resolve();return late.promise;}
    const value=r.url.includes("/sessions/")?{id:identity.sessionId,user_id:identity.userId,status:"active",expire_at:clock+10000,abandon_at:clock+10000,actor:null}:
      {id:identity.userId,banned:false,locked:false,deprovisioned:false};return new Response(JSON.stringify(value),{headers:{"content-type":"application/json"}});
  }});
  const one=f.app.fetch(request("GET","/exams",f.token,undefined,abort.signal),bindings());await entered.promise;
  const two=f.app.fetch(request("GET","/exams",f.token),bindings());abort.abort();await safe(await one);assert.equal((await two).status,200);
  late.resolve(new Response("{}",{headers:{"content-type":"application/json"}}));await new Promise(r=>setImmediate(r));
  assert.equal(f.clients.length,2);for(const c of f.clients)assert.equal(c.ends,1);for(const c of f.clerks)assert.equal(c.closes,1);
});
let joseAvailable=true;try{import.meta.resolve("jose");}catch{joseAvailable=false;}
test("actual accepted provider adapter serves bound opaque-session GET/exams through default entry composition",{skip:joseAvailable?false:"NOT_RUN:jose6.2.15 absent;unit provider port is not actual-adapter/JWT proof"},async()=>{
  const f=await fixture();let calls=0;
  // Replace neither verifier nor provider semantics. Reuse the fixture's trusted
  // Client constructor while binding the real Worker/JOSE adapter and fake Web I/O.
  const Client=class extends EventEmitter{
    async connect(){this.lease=await f.pool.connect();}
    async query(q){const name=(await statementMap()).get(q.text);assert.ok(name);return this.lease.query({...q,name});}
    async end(){this.lease?.release(false);}
  };
  const real=createCloudflareEntrypoint({loadClient:async()=>Client,now:()=>clock,transport:async r=>{
    calls++;const value=r.url.includes("/sessions/")?{id:identity.sessionId,user_id:identity.userId,status:"active",expire_at:clock+10000,abandon_at:clock+10000,actor:null}:
      {id:identity.userId,banned:false,locked:false,deprovisioned:false};return new Response(JSON.stringify(value),{headers:{"content-type":"application/json"}});
  }});
  assert.equal((await real.fetch(request("GET","/exams",f.token),bindings())).status,200);assert.ok(calls>=2);
});

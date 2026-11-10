import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createClerkSdkBindings,CLERK_BACKEND_VERSION} from "../../runtime/clerk-sdk-bindings.mjs";
import {createClerkProviderAdapter} from "../../supabase/functions/univeracademy-api/clerk-provider.ts";
import {requireLiveClerk} from "../../supabase/functions/univeracademy-api/clerk-auth.ts";
import {exportJWK} from "jose";
import {clerkFixture,users,sids,issuer as fixtureIssuer} from "./fixture.mjs";

const issuer="https://clerk.example.invalid",uid="user_SyntheticCaseA1",sid="sess_SyntheticCaseA1",at=Date.UTC(2026,10,7);
const rawSession=()=>({object:"session",id:sid,client_id:"client_SyntheticOnly",user_id:uid,status:"active",last_active_at:at,
  expire_at:at+60000,abandon_at:at+30000,created_at:at-1000,updated_at:at,actor:null});
const rawUser=()=>({object:"user",id:uid,banned:false,locked:false,deprovisioned:false,created_at:at-1000,updated_at:at,
  password_enabled:false,totp_enabled:false,backup_code_enabled:false,two_factor_enabled:false,image_url:"",has_image:false});
const json=value=>new Response(JSON.stringify(value),{headers:{"content-type":"application/json"}});
const denied=error=>error.status===503&&!error.message.includes("synthetic-server-secret");
async function fixture(t,mutate=()=>{}){
  const requests=[];
  const transport=async request=>{
    requests.push({url:request.url,method:request.method,redirect:request.redirect,credentials:request.credentials});
    const session=request.url.includes("/sessions/"),value=session?rawSession():rawUser();mutate(value,session);
    return json(value);
  };
  const bindings=await createClerkSdkBindings({secretKey:"synthetic-server-secret",transport,now:()=>at,timeoutMs:3000,maxResponseBytes:65536});
  t.after(()=>bindings.close());return{bindings,requests};
}
test("exact Clerk3.27.0 SDK converts actual snake_case Session/User responses; no global fetch replacement or real network",async t=>{
  const nativeFetch=globalThis.fetch,f=await fixture(t);
  const session=await f.bindings.getSession(sid),user=await f.bindings.getUser(uid);
  assert.equal(CLERK_BACKEND_VERSION,"3.27.0");assert.equal(globalThis.fetch,nativeFetch);
  assert.deepEqual(session,{id:sid,userId:uid,status:"active",expireAt:at+60000,abandonAt:at+30000,actor:null});
  assert.deepEqual(user,{id:uid,banned:false,locked:false,deprovisioned:false});
  assert.deepEqual(f.requests.map(r=>r.url),["https://api.clerk.com/v1/sessions/"+sid,"https://api.clerk.com/v1/users/"+uid]);
  for(const r of f.requests){assert.equal(r.method,"GET");assert.equal(r.redirect,"error");assert.equal(r.credentials,"omit");}
  const lock=JSON.parse(readFileSync(new URL("../../package-lock.json",import.meta.url)));
  assert.equal(lock.packages['node_modules/@clerk/backend'].version,"3.27.0");
  assert.equal(lock.packages['node_modules/@clerk/backend'].integrity,"sha512-pmhVVP9EsAOL1rlRU4xR0XSL1BJczxGAJIqv8c+C9fRz7TYzCndGUMSSE/Zg7i2QOA24ExJbEJUiOjILdUL2EQ==");
});
test("missing raw actor/deprovisioned is denied before SDK defaults can invent null/false",async t=>{
  for(const field of ["actor","deprovisioned","banned","locked"]){
    const f=await fixture(t,(value,isSession)=>{if(isSession===(field==="actor"))delete value[field];});
    await assert.rejects(field==="actor"?f.bindings.getSession(sid):f.bindings.getUser(uid),denied);
  }
});
test("SDK-normalized responses feed the existing provider adapter; current flag/revocation and model mismatch stay denied",async t=>{
  for(const kind of ["active","locked","revoked","mismatch"]){
    const f=await fixture(t,(value,session)=>{if(kind==="locked"&&!session)value.locked=true;if(kind==="revoked"&&session)value.status="revoked";if(kind==="mismatch"&&session)value.user_id="user_OtherSynthetic";});
    const adapter=createClerkProviderAdapter({issuer,authorizedParties:["https://student.example.invalid"],audience:{kind:"clerk_default_no_audience"},jwksCacheMs:300000,jwksCooldownMs:30000,timeoutMs:3000,maxJwksBytes:65536},f.bindings);
    const work=requireLiveClerk({issuer,userId:uid,sessionId:sid},at,adapter.liveness);
    if(kind==="active")assert.equal(await work,at+30000);else await assert.rejects(work,e=>e.status===401);
  }
});
test("SDK errors404/401/429/5xx map without retry or provider text leak; timeout/aborted reads never grant",async t=>{
  for(const status of [404,401,429,500]){
    let count=0;const bindings=await createClerkSdkBindings({secretKey:"synthetic-server-secret",transport:async()=>{count++;return new Response("private provider text",{status});},now:()=>at,timeoutMs:3000,maxResponseBytes:65536});
    t.after(()=>bindings.close());await assert.rejects(bindings.getSession(sid),e=>e.status===(status===404?404:503)&&!e.message.includes("private provider text"));assert.equal(count,1);
  }
  const f=await fixture(t),controller=new AbortController();controller.abort();await assert.rejects(f.bindings.getSession(sid,{signal:controller.signal}),denied);
  await assert.rejects(f.bindings.getSession(sid+"\n"),denied);
});

test("exact SDK raw/model binding completes the F1-protected local exchange; missing security evidence cannot create or supersede a family",async t=>{
  const f=await clerkFixture({fresh:true});const jwk=await exportJWK(f.pair.publicKey);jwk.kid="clerk-synthetic-rsa";let missingActor=false;
  const bindings=await createClerkSdkBindings({secretKey:"synthetic-server-secret",now:()=>f.store.time,timeoutMs:3000,maxResponseBytes:65536,transport:async request=>{
    if(request.url===fixtureIssuer+"/.well-known/jwks.json")return json({keys:[jwk]});
    if(request.url.includes("/sessions/")){const value={...rawSession(),id:sids.first,user_id:users.student,expire_at:f.store.time+60000,abandon_at:f.store.time+30000};if(missingActor)delete value.actor;return json(value);}
    return json({...rawUser(),id:users.student});
  }});t.after(()=>bindings.close());
  const adapter=createClerkProviderAdapter({issuer:fixtureIssuer,authorizedParties:["https://student.example.com"],audience:{kind:"clerk_default_no_audience"},jwksCacheMs:300000,jwksCooldownMs:30000,timeoutMs:3000,maxJwksBytes:65536},bindings);
  Object.assign(f.deps,adapter);f.resetHandler();
  const first=await f.exchange(await f.sign());assert.equal(first.status,200);const session=first.json.data;
  assert.equal(f.store.state.domain.student.people[session.profile.person_id].telegramId,null);
  const before=f.snapshot();missingActor=true;const denied=await f.exchange(await f.sign());assert.equal(denied.status,503);assert.equal(denied.json.data,undefined);assert.deepEqual(f.store.state,before);
  missingActor=false;assert.equal((await f.client.me(session.access_token)).data.person_id,session.profile.person_id);
});

test("SDK transport denies malformed security fields, oversized body, foreign response URL and redirect before model defaults",async t=>{
  const responses=[()=>json({...rawSession(),expire_at:"123"}),()=>json({...rawSession(),extra:"x".repeat(70000)}),
    ()=>new Response(null,{status:302,headers:{location:"https://attacker.invalid"}}),
    ()=>new Response("{}",{headers:{"content-type":"text/plain"}}),
    ()=>{const r=json(rawSession());Object.defineProperty(r,"url",{value:"https://attacker.invalid"});return r;}];
  for(const response of responses){
    const bindings=await createClerkSdkBindings({secretKey:"synthetic-server-secret",transport:async()=>response(),now:()=>at,timeoutMs:3000,maxResponseBytes:65536});
    t.after(()=>bindings.close());await assert.rejects(bindings.getSession(sid),denied);
  }
});

test("SDK read deadline cancels cooperative transport and never turns a late reply into authentication",async t=>{
  let aborted=false;
  const bindings=await createClerkSdkBindings({secretKey:"synthetic-server-secret",now:()=>at,timeoutMs:3000,maxResponseBytes:65536,transport:async request=>{
    await new Promise(resolve=>request.signal.addEventListener("abort",()=>{aborted=true;resolve();},{once:true}));return json(rawSession());
  }});t.after(()=>bindings.close());await assert.rejects(bindings.getSession(sid),denied);await bindings.close();assert.equal(aborted,true);
});

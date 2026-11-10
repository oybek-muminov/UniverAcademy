import {test} from "node:test";
import assert from "node:assert/strict";
import {getEventListeners} from "node:events";
import {setImmediate as turn} from "node:timers/promises";
import {exportJWK} from "jose";
import {createClerkSdkBindings} from "../../runtime/clerk-sdk-bindings.mjs";
import {createClerkProviderAdapter} from "../../supabase/functions/univeracademy-api/clerk-provider.ts";
import {clerkFixture,users,sids,issuer as fixtureIssuer} from "./fixture.mjs";

const at=Date.UTC(2026,10,7),issuer="https://clerk.example.invalid",uid="user_SyntheticCancelA1",sid="sess_SyntheticCancelA1";
const rawSession=(userId=uid,sessionId=sid)=>({object:"session",id:sessionId,user_id:userId,status:"active",expire_at:at+60000,abandon_at:at+30000,actor:null});
const rawUser=(userId=uid)=>({object:"user",id:userId,banned:false,locked:false,deprovisioned:false});
const json=value=>new Response(JSON.stringify(value),{headers:{"content-type":"application/json"}});
const unavailable=error=>error.status===503&&error.code==="SERVICE_UNAVAILABLE";
const config=(providerIssuer=issuer)=>({issuer:providerIssuer,authorizedParties:["https://student.example.com"],audience:{kind:"clerk_default_no_audience"},jwksCacheMs:300000,jwksCooldownMs:30000,timeoutMs:100,maxJwksBytes:65536});
async function bindings(t,transport){
  const value=await createClerkSdkBindings({secretKey:"synthetic-server-secret",transport,now:()=>at,timeoutMs:3000,maxResponseBytes:65536});
  t.after(()=>value.close());return value;
}

test("SDK-CANCEL-1: caller abort reaches active transport before close and removes listeners",{timeout:10000},async t=>{
  const entered=Promise.withResolvers(),held=Promise.withResolvers(),controller=new AbortController();
  const sdk=await bindings(t,request=>{entered.resolve(request);return held.promise;});
  const denied=assert.rejects(sdk.getSession(sid,{signal:controller.signal}),unavailable);
  const request=await entered.promise;assert.equal(request.signal.aborted,false);controller.abort();await denied;await turn();
  assert.equal(request.signal.aborted,true,"transport must abort before sdk.close()");
  assert.equal(getEventListeners(controller.signal,"abort").length,0);
  assert.equal(getEventListeners(request.signal,"abort").length,0);
  held.resolve(json(rawSession()));
});

test("100ms provider deadline cancels3000ms SDK read, without user lookup or waiting for close",{timeout:10000},async t=>{
  const entered=Promise.withResolvers(),held=Promise.withResolvers();let count=0;
  const sdk=await bindings(t,request=>{count++;entered.resolve(request);return held.promise;});
  const adapter=createClerkProviderAdapter(config(),sdk);
  const denied=assert.rejects(adapter.liveness({issuer,userId:uid,sessionId:sid},at),unavailable);
  const request=await entered.promise;await denied;await turn();
  assert.equal(request.signal.aborted,true);assert.equal(count,1);held.resolve(json(rawSession()));
});

test("SDK own3000ms deadline aborts active transport before close",{timeout:10000},async t=>{
  const entered=Promise.withResolvers(),held=Promise.withResolvers();
  const sdk=await bindings(t,request=>{entered.resolve(request);return held.promise;});
  const denied=assert.rejects(sdk.getSession(sid),unavailable),request=await entered.promise;
  await denied;await turn();assert.equal(request.signal.aborted,true);held.resolve(json(rawSession()));
});

test("abort while reading JSON cancels the reader, releases its lock and removes signal listeners",{timeout:10000},async t=>{
  const entered=Promise.withResolvers(),reading=Promise.withResolvers(),controller=new AbortController();let cancelled=0;
  const response=new Response(new ReadableStream({pull(){reading.resolve();},cancel(){cancelled++;}},{highWaterMark:0}),{headers:{"content-type":"application/json"}});
  const sdk=await bindings(t,request=>{entered.resolve(request);return response;});
  const denied=assert.rejects(sdk.getSession(sid,{signal:controller.signal}),unavailable),request=await entered.promise;
  await reading.promise;controller.abort();await denied;await turn();
  assert.equal(request.signal.aborted,true);assert.equal(cancelled,1);assert.equal(response.body.locked,false);
  assert.equal(getEventListeners(request.signal,"abort").length,0);
});

test("an uncooperative late reply is discarded and its body cancelled; later reads still succeed",{timeout:10000},async t=>{
  const entered=Promise.withResolvers(),held=Promise.withResolvers(),cancelled=Promise.withResolvers(),controller=new AbortController();let count=0;
  const sdk=await bindings(t,request=>{count++;if(count===1){entered.resolve(request);return held.promise;}return json(rawSession());});
  const denied=assert.rejects(sdk.getSession(sid,{signal:controller.signal}),unavailable);await entered.promise;controller.abort();await denied;
  held.resolve(new Response(new ReadableStream({cancel(){cancelled.resolve();}},{highWaterMark:0}),{headers:{"content-type":"application/json"}}));
  await cancelled.promise;assert.equal((await sdk.getSession(sid)).id,sid);assert.equal(count,2);
});

test("concurrent reads of the same session stay isolated when only one caller aborts",{timeout:10000},async t=>{
  const entries=[Promise.withResolvers(),Promise.withResolvers()],replies=[Promise.withResolvers(),Promise.withResolvers()];let count=0;
  const sdk=await bindings(t,request=>{const index=count++;entries[index].resolve(request);return replies[index].promise;});
  const controller=new AbortController(),denied=assert.rejects(sdk.getSession(sid,{signal:controller.signal}),unavailable);
  const first=await entries[0].promise,secondResult=sdk.getSession(sid),second=await entries[1].promise;
  controller.abort();await denied;assert.equal(first.signal.aborted,true);assert.equal(second.signal.aborted,false);
  replies[1].resolve(json(rawSession()));assert.equal((await secondResult).id,sid);replies[0].resolve(json(rawSession()));assert.equal(count,2);
});

test("successful and pre-aborted calls clean listeners, and a spent caller signal cannot cancel another call",{timeout:10000},async t=>{
  const requests=[],controller=new AbortController();
  const sdk=await bindings(t,request=>{requests.push(request);return json(rawSession());});
  assert.equal((await sdk.getSession(sid,{signal:controller.signal})).id,sid);
  assert.equal(getEventListeners(controller.signal,"abort").length,0);
  assert.equal(getEventListeners(requests[0].signal,"abort").length,0);
  controller.abort();await assert.rejects(sdk.getSession(sid,{signal:controller.signal}),unavailable);
  assert.equal((await sdk.getSession(sid)).id,sid);assert.equal(requests.length,2);
});

test("queued and repeated mixed Session/User cancellations leave no ghost transport or caller listeners",{timeout:10000},async t=>{
  let gate=null,count=0;
  const sdk=await bindings(t,request=>{count++;if(gate){gate.entered.resolve(request);return gate.held.promise;}return json(rawSession());});
  const queued=new AbortController(),denied=assert.rejects(sdk.getSession(sid,{signal:queued.signal}),unavailable);
  queued.abort();await denied;assert.equal((await sdk.getSession(sid)).id,sid);assert.equal(count,1);
  for(let i=0;i<6;i++){
    gate={entered:Promise.withResolvers(),held:Promise.withResolvers()};const controller=new AbortController(),isSession=i%2===0;
    const denied=assert.rejects(isSession?sdk.getSession(sid,{signal:controller.signal}):sdk.getUser(uid,{signal:controller.signal}),unavailable);
    const request=await gate.entered.promise;controller.abort();await denied;await turn();
    assert.equal(request.signal.aborted,true);assert.equal(getEventListeners(controller.signal,"abort").length,0);
    assert.equal(getEventListeners(request.signal,"abort").length,0);gate.held.resolve(json(isSession?rawSession():rawUser()));
  }
  gate=null;assert.equal((await sdk.getSession(sid)).id,sid);assert.equal(count,8);
});

test("close aborts all active transports, is idempotent, and prevents new reads",{timeout:10000},async t=>{
  const entries=[Promise.withResolvers(),Promise.withResolvers()],held=Promise.withResolvers();let count=0;
  const sdk=await bindings(t,request=>{entries[count++].resolve(request);return held.promise;});
  const first=assert.rejects(sdk.getSession(sid),unavailable),second=assert.rejects(sdk.getUser(uid),unavailable);
  const requests=await Promise.all(entries.map(e=>e.promise));await sdk.close();await Promise.all([first,second]);
  for(const request of requests){assert.equal(request.signal.aborted,true);assert.equal(getEventListeners(request.signal,"abort").length,0);}
  await sdk.close();await assert.rejects(sdk.getSession(sid),unavailable);assert.equal(count,2);held.resolve(json(rawSession()));
});

test("HTTP timeout and late active reply cannot create or replace profiles/proofs; existing family survives",{timeout:10000},async t=>{
  const f=await clerkFixture({fresh:true}),jwk=await exportJWK(f.pair.publicKey);jwk.kid="clerk-synthetic-rsa";
  const entered=Promise.withResolvers(),held=Promise.withResolvers(),lateCancelled=Promise.withResolvers();let stall=false,userReads=0;
  const sdk=await bindings(t,request=>{
    if(request.url===fixtureIssuer+"/.well-known/jwks.json")return json({keys:[jwk]});
    if(request.url.includes("/sessions/")){
      if(stall){entered.resolve(request);return held.promise;}
      return json({...rawSession(users.student,sids.first),expire_at:f.store.time+60000,abandon_at:f.store.time+30000});
    }
    userReads++;return json(rawUser(users.student));
  });
  const adapter=createClerkProviderAdapter(config(fixtureIssuer),{...sdk,now:()=>f.store.time});Object.assign(f.deps,adapter);f.resetHandler();
  const first=await f.exchange(await f.sign());assert.equal(first.status,200);const before=f.snapshot(),beforeReads=userReads;
  stall=true;const result=f.exchange(await f.sign()),request=await entered.promise;
  assert.equal((await result).status,503);assert.equal(request.signal.aborted,true);assert.deepEqual(f.store.state,before);assert.equal(userReads,beforeReads);
  held.resolve(new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(JSON.stringify(rawSession(users.student,sids.first))));},cancel(){lateCancelled.resolve();}}),{headers:{"content-type":"application/json"}}));
  await lateCancelled.promise;await turn();assert.deepEqual(f.store.state,before);
  stall=false;assert.equal((await f.client.me(first.json.data.access_token)).data.person_id,first.json.data.profile.person_id);
});

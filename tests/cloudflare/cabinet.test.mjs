import assert from 'node:assert/strict';
import test from 'node:test';
import {createWorkerCabinetHandler} from '../../runtime/cloudflare-cabinet.mjs';

const teacher='https://teacher.example.com', student='https://mini.example.com', api='https://api.example.com';
const env={
  UA_CABINET_STAGING_ENABLED:'true',UA_CABINET_RUNTIME:'worker',UA_CABINET_TEACHER_ORIGIN:teacher,
  UA_CABINET_STUDENT_ORIGIN:student,UA_API_ORIGIN:api, UA_CLERK_SECRET_KEY:'unit-test-only',
  UA_CLERK_PROVIDER_SETTINGS:JSON.stringify({authorizedParties:[student],timeoutMs:100}),
  CABINET_HYPERDRIVE:{connectionString:'postgresql://mock:fixture@localhost:5432/cabinet'}
};
const endpoint=(origin=teacher,role='teacher')=>origin+'/api/v1/'+role+'/pilot/dashboard';
const defaultClerk=()=>({verifier:{},liveness:async()=>{},close(){}});
const respond=()=>({fetch:async()=>Response.json({private:'result'})});
function runtime(patch={}) {
  return createWorkerCabinetHandler({createApi:respond,makeClerk:defaultClerk,loadClient:async()=>class {},...patch});
}

test('disabled transports and a disallowed audience never touch a private binding',async()=>{
  const h=runtime({makeClerk:()=>assert.fail('unexpected Clerk')});
  const untouched={...env};
  Object.defineProperty(untouched,'CABINET_HYPERDRIVE',{get(){assert.fail('unexpected database');}});
  for(const mode of ['node','',undefined]) {
    const result=await h.fetch(new Request(endpoint()),{...env,UA_CABINET_RUNTIME:mode});
    assert.equal(result.status,404);
  }
  assert.equal((await h.fetch(new Request(endpoint()),{...env,UA_CABINET_STAGING_ENABLED:'false'})).status,404);
  assert.equal((await h.fetch(new Request(endpoint(api)),untouched)).status,404);
  const denied=await h.fetch(new Request(endpoint(),{headers:{origin:student}}),untouched);
  assert.equal(denied.status,403);
  assert.equal(denied.headers.get('access-control-allow-origin'),null);
});

test('missing dedicated binding cannot fall back to the registration or bot databases',async()=>{
  const settings={...env,HYPERDRIVE:env.CABINET_HYPERDRIVE,TEACHER_PILOT_HYPERDRIVE:env.CABINET_HYPERDRIVE};
  delete settings.CABINET_HYPERDRIVE;
  let providers=0;
  const h=runtime({makeClerk(){providers++;return defaultClerk();}});
  const response=await h.fetch(new Request(endpoint()),settings);
  assert.equal(response.status,503);assert.equal(providers,0);
  assert.deepEqual((await response.json()).error,{code:'SERVICE_UNAVAILABLE',message:'SERVICE_UNAVAILABLE'});
});

test('cabinet-only Clerk audience and resources are per-request',async()=>{
  const parties=[],pools=[],secrets=[],closes=[];
  const h=runtime({makeClerk(config,{secretKey,signal}){
    parties.push(config.authorizedParties);secrets.push(secretKey);
    return {...defaultClerk(),close(){closes.push(signal);}};
  },createApi(options){
    pools.push(options.pool);assert.equal(options.allowLegacyTelegram,false);
    return respond();
  }});
  const replies=await Promise.all([h.fetch(new Request(endpoint()),env),h.fetch(new Request(endpoint(api,'student')),env)]);
  assert.deepEqual(replies.map(r=>r.status),[200,200]);
  assert.deepEqual(parties,[[student,teacher],[student,teacher]]);
  assert.deepEqual(JSON.parse(env.UA_CLERK_PROVIDER_SETTINGS).authorizedParties,[student]);
  assert.deepEqual(secrets,[env.UA_CLERK_SECRET_KEY,env.UA_CLERK_SECRET_KEY]);
  assert.equal(new Set(pools).size,2);assert.equal(new Set(closes).size,2);
});

test('request deadline cancels an unfinished incoming body and closes provider',async()=>{
  let started=0,cancelled=0,closed=0;
  const input=new ReadableStream({pull(){started++;},cancel(){cancelled++;}},{highWaterMark:0});
  const h=runtime({timeoutMs:50,makeClerk(){return {...defaultClerk(),close(){closed++;}};},
    createApi:()=>({async fetch(req){await req.arrayBuffer();return Response.json({});}})});
  const result=await h.fetch(new Request(endpoint(),{method:'POST',body:input,duplex:'half'}),env);
  assert.equal(result.status,503);assert.equal(started,1);assert.equal(cancelled,1);assert.equal(closed,1);
});

test('close failure prevents acknowledging successful private response',async()=>{
  const h=runtime({makeClerk:()=>({...defaultClerk(),close(){throw Error('sensitive-internal-text');}})});
  const result=await h.fetch(new Request(endpoint(),{headers:{origin:teacher}}),env);
  assert.equal(result.status,503);assert.equal(result.headers.get('access-control-allow-origin'),teacher);
  assert.equal(result.headers.get('cloudflare-cdn-cache-control'),'no-store');
  assert.doesNotMatch(await result.text(),/sensitive|private|result/);
});

test('late provider creation after client abort is reclaimed',async()=>{
  let resolveFactory,started,done;
  const startedPromise=new Promise(r=>started=r),donePromise=new Promise(r=>done=r);
  const h=runtime({makeClerk(){started();return new Promise(resolve=>{resolveFactory=resolve;});}});
  const controller=new AbortController();
  const response=h.fetch(new Request(endpoint(),{signal:controller.signal}),env);
  await startedPromise;controller.abort();
  assert.equal((await response).status,503);
  resolveFactory({...defaultClerk(),close(){done();}});
  await donePromise;
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createClerkWorkerBindings,createClerkWorkerAdapter} from '../../runtime/clerk-worker-bindings.mjs';
import {createClerkVerifier,requireLiveClerk,requireLiveClerkProfile,clerkDisplayNames} from '../../supabase/functions/univeracademy-api/clerk-auth.ts';

const issuer='https://clerk.offline.invalid',party='https://mini.offline.invalid',uid='user_SyntheticCaseA',sid='sess_SyntheticCaseA';
const now=Date.UTC(2026,10,11),secretKey='synthetic-private-not-a-real-credential';
const session=()=>({id:sid,user_id:uid,status:'active',expire_at:now+60000,abandon_at:now+30000,actor:null});
const user=()=>({id:uid,banned:false,locked:false,deprovisioned:false});
const json=v=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
const denied=e=>e.status===503&&e.message==='SERVICE_UNAVAILABLE'&&!e.cause;
const settings={issuer,authorizedParties:[party],audience:{kind:'clerk_default_no_audience'},jwksCacheMs:300000,jwksCooldownMs:0,timeoutMs:100,maxJwksBytes:65536};
function fixture(patch={}){
  const requests=[];const transport=async r=>{requests.push(r);return patch.respond?patch.respond(r):json(r.url.includes('/sessions/')?session():r.url.includes('/users/')?user():{keys:[]});};
  const options={issuer,secretKey,transport,now:()=>now,timeoutMs:100,maxResponseBytes:65536,...patch};delete options.respond;
  const bindings=createClerkWorkerBindings(options);return {bindings,requests,options};
}
test('construction is inert, uses only injected Web transport, and returns required camelCase models without defaults',async()=>{
  const native=globalThis.fetch,f=fixture();assert.equal(f.requests.length,0);
  assert.deepEqual(await f.bindings.getSession(sid),{id:sid,userId:uid,status:'active',expireAt:now+60000,abandonAt:now+30000,actor:null});
  assert.deepEqual(await f.bindings.getUser(uid),{...user(),firstName:null,lastName:null});assert.equal(globalThis.fetch,native);
  assert.deepEqual(f.requests.map(r=>r.url),['https://api.clerk.com/v1/sessions/'+sid,'https://api.clerk.com/v1/users/'+uid]);
  for(const r of f.requests){assert.equal(r.method,'GET');assert.equal(r.redirect,'error');assert.equal(r.credentials,'omit');assert.equal(r.cache,'no-store');assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('authorization'),'Bearer '+secretKey);assert.equal(r.headers.get('cookie'),null);}
  f.bindings.close();
});
for(const change of [{issuer:'http://clerk.invalid'},{issuer:issuer+'/'},{secretKey:''},{secretKey:'bad\nsecret'},
  {transport:undefined},{now:undefined},{timeoutMs:0},{timeoutMs:Infinity},{maxResponseBytes:0},{maxResponseBytes:1048577}])
test('missing/unsafe private Worker binding fails closed before reads '+Object.keys(change)[0],()=>{
  assert.throws(()=>fixture(change),denied);
});
for(const [kind,field]of [['sessions','actor'],['sessions','id'],['sessions','user_id'],['sessions','expire_at'],['sessions','abandon_at'],['sessions','status'],['users','id'],['users','banned'],['users','locked'],['users','deprovisioned']])
test('missing mandatory '+kind+'/'+field+' cannot receive an invented security default',async()=>{
  const f=fixture({respond:()=>{const value=kind==='sessions'?session():user();delete value[field];return json(value);}});
  try{await assert.rejects(kind==='sessions'?f.bindings.getSession(sid):f.bindings.getUser(uid),denied);}finally{f.bindings.close();}
});
for(const value of [sid+'\n','sess_../users/user_other','https://other.invalid','',null,'user_WrongKind'])
test('invalid session target never reaches transport '+JSON.stringify(value),async()=>{
  const f=fixture();try{await assert.rejects(f.bindings.getSession(value),denied);assert.equal(f.requests.length,0);}finally{f.bindings.close();}
});
for(const patch of [{expire_at:'123'},{abandon_at:null},{actor:false},{id:'sess_A\n'},{user_id:'user_A\n'}])
test('malformed raw session value denies503 '+Object.keys(patch)[0],async()=>{
  const f=fixture({respond:()=>json({...session(),...patch})});try{await assert.rejects(f.bindings.getSession(sid),denied);}finally{f.bindings.close();}
});
test('uncached reads preserve revoked state, all account flags and shortened expiry for the existing provider oracle',async()=>{
  let wire=session(),account=user();const f=fixture({respond:r=>json(r.url.includes('/sessions/')?wire:account)});
  try{
    assert.equal((await f.bindings.getSession(sid)).expireAt,now+60000);
    wire.expire_at=now+100;wire.status='revoked';assert.equal((await f.bindings.getSession(sid)).status,'revoked');assert.equal((await f.bindings.getSession(sid)).expireAt,now+100);
    for(const name of ['banned','locked','deprovisioned']){account={...user(),[name]:true};assert.equal((await f.bindings.getUser(uid))[name],true);}
    assert.equal(f.requests.length,6); // No session/account cache across reads.
  }finally{f.bindings.close();}
});
for(const status of [404,401,429,500])test('provider status '+status+' is sanitized without retry',async()=>{
  const f=fixture({respond:()=>new Response('must-not-echo-private-provider',{status})});
  try{await assert.rejects(f.bindings.getSession(sid),e=>e.status===(status===404?404:503)&&!e.message.includes('must-not-echo'));assert.equal(f.requests.length,1);}finally{f.bindings.close();}
});
for(const [label,respond]of [
  ['redirect',()=>new Response(null,{status:302,headers:{location:'https://other.invalid'}})],
  ['foreign URL',()=>{const r=json(session());Object.defineProperty(r,'url',{value:'https://other.invalid'});return r;}],
  ['MIME',()=>new Response('{}',{headers:{'content-type':'text/plain'}})],
  ['broken JSON',()=>new Response('{',{headers:{'content-type':'application/json'}})],
  ['invalid UTF8',()=>new Response(new Uint8Array([0xc3,0x28]),{headers:{'content-type':'application/json'}})],
  ['declared limit',()=>new Response('{}',{headers:{'content-type':'application/json','content-length':'65537'}})],
  ['length mismatch',()=>new Response('{}',{headers:{'content-type':'application/json','content-length':'1'}})],
  ['actual limit',()=>json({...session(),extra:'x'.repeat(70000)})],
  ['transport exception',()=>{throw Error('must-not-echo-private-provider');}],
])test(label+' denies before model authorization',async()=>{
  const f=fixture({respond});try{await assert.rejects(f.bindings.getSession(sid),denied);}finally{f.bindings.close();}
});
test('rejected response headers and over-limit streams dispose their body, without continuing reads',async()=>{
  for(const badHeader of [true,false]){
    let cancelled=0;
    const f=fixture({respond:()=>new Response(new ReadableStream({start(c){if(!badHeader)c.enqueue(new Uint8Array(65537));},cancel(){cancelled++;}}),{headers:{'content-type':badHeader?'text/plain':'application/json'}})});
    try{await assert.rejects(f.bindings.getSession(sid),denied);await Promise.resolve();assert.equal(cancelled,1);}finally{f.bindings.close();}
  }
});
test('timeout and caller abort cancel the injected transport, including ignored-abort late replies',async()=>{
  for(const cancelKind of ['timeout','caller','close']){
    let transportSignal,resolve,bodyCancelled=0;const late=new Promise(r=>{resolve=r;});
    const f=fixture({timeoutMs:15,respond:r=>{transportSignal=r.signal;return late;}}),controller=new AbortController();
    const result=f.bindings.getSession(sid,{signal:controller.signal});await Promise.resolve();
    if(cancelKind==='caller')controller.abort();if(cancelKind==='close')f.bindings.close();
    await assert.rejects(result,denied);assert.equal(transportSignal.aborted,true);
    resolve(new Response(new ReadableStream({cancel(){bodyCancelled++;}}),{headers:{'content-type':'application/json'}}));
    await new Promise(r=>setImmediate(r));assert.equal(bodyCancelled,1);f.bindings.close();
  }
});
test('cancellation while body read is pending cancels the body once and cannot return a model',async()=>{
  let cancelled=0;const controller=new AbortController();const f=fixture({respond:()=>new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-type':'application/json'}})});
  const pending=f.bindings.getSession(sid,{signal:controller.signal});await new Promise(r=>setImmediate(r));controller.abort();await assert.rejects(pending,denied);await new Promise(r=>setImmediate(r));assert.equal(cancelled,1);f.bindings.close();
});
test('parent cancellation and close deny new calls; concurrent reads keep independent cancellation',async()=>{
  const parent=new AbortController(),f=fixture({signal:parent.signal});parent.abort();await assert.rejects(f.bindings.getSession(sid),denied);assert.equal(f.requests.length,0);f.bindings.close();f.bindings.close();
  const g=fixture(),aborted=new AbortController();aborted.abort();
  const [one,two]=await Promise.allSettled([g.bindings.getSession(sid,{signal:aborted.signal}),g.bindings.getSession(sid)]);
  assert.equal(one.status,'rejected');assert.equal(two.status,'fulfilled');assert.equal(g.requests.length,1);g.bindings.close();await assert.rejects(g.bindings.getUser(uid),denied);
});
test('malformed per-read cancellation input fails with the fixed safe error before transport',async()=>{
  const f=fixture();try{await assert.rejects(f.bindings.getSession(sid,{signal:{aborted:false}}),denied);assert.equal(f.requests.length,0);}finally{f.bindings.close();}
});
test('JWKS uses only fixed issuer GET, without bearer/cookie or caller header forwarding',async()=>{
  const f=fixture(),url=issuer+'/.well-known/jwks.json';
  try{
    assert.deepEqual(await (await f.bindings.fetchJwks(new Request(url))).json(),{keys:[]});const r=f.requests[0];assert.equal(r.url,url);assert.equal(r.headers.has('authorization'),false);assert.equal(r.headers.has('cookie'),false);
    for(const request of [new Request('https://other.invalid/.well-known/jwks.json'),new Request(url,{method:'POST'}),new Request(url,{headers:{authorization:'Bearer caller'}}),new Request(url,{headers:{cookie:'caller=1'}})])await assert.rejects(f.bindings.fetchJwks(request),denied);
    assert.equal(f.requests.length,1);
  }finally{f.bindings.close();}
});

let joseAvailable=true;try{import.meta.resolve('jose');}catch{joseAvailable=false;}
test('missing production JOSE dependency fails503 without a verifier substitute or provider request',{skip:joseAvailable?'JOSE exists; covered by real verification test':false},async()=>{
  const f=fixture();await assert.rejects(createClerkWorkerAdapter(settings,f.options),denied);assert.equal(f.requests.length,0);f.bindings.close();
});
test('real provider/JOSE/HTTP exchange seeds names once and enforces signature, issuer, azp, liveness and expiry',{skip:joseAvailable?false:'NOT_RUN: jose6.2.15 absent; no install authorized'},async()=>{
  const {generateKeyPair,exportJWK,SignJWT}=await import('jose'),pair=await generateKeyPair('RS256'),jwk=await exportJWK(pair.publicKey);jwk.kid='worker-synthetic-key';
  let current=session(),account={...user(),first_name:'Provider',last_name:'Student'},calls=0;
  const adapter=await createClerkWorkerAdapter(settings,{secretKey,now:()=>now,timeoutMs:100,maxResponseBytes:65536,transport:async r=>{calls++;return json(r.url.includes('jwks')?{keys:[jwk]}:r.url.includes('/sessions/')?current:account);}});
  const sign=changes=>new SignJWT({iss:issuer,sub:uid,sid,iat:now/1000,nbf:now/1000,exp:now/1000+60,azp:party,jti:'synthetic-worker-jti',v:2,...changes}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).sign(pair.privateKey);
  try{
    const verify=createClerkVerifier(adapter.verifier),identity=await verify(await sign());assert.equal(identity.userId,uid);
    assert.equal(await requireLiveClerk(identity,now,adapter.liveness),now+30000);
    assert.deepEqual(await requireLiveClerkProfile(identity,now,adapter.liveness),{firstName:'Provider',lastName:'Student',expiresAt:now+30000});
    // Real signature/HTTP integration with a synthetic in-memory transaction;
    // this deliberately proves no PostgreSQL/RLS or live-provider behavior.
    const {createClerkCandidateHandler}=await import('../../supabase/functions/univeracademy-api/clerk-http.ts');
    const {testPolicy,testNumbers}=await import('../backend/http-fixture.ts');
    let state={domain:{student:{people:{},families:{},access:{},refresh:{},consumedInitData:{},grants:{},assignments:{},series:{},attempts:{},receipts:{},bonuses:{},cancellations:{}},memberships:{},staff:{}},identities:{},familyBindings:{},studentSessions:{},consumedTokens:{}};
    const handler=createClerkCandidateHandler({mode:'local_candidate',...adapter,sessionPolicy:testPolicy,numericPresentation:testNumbers,
      transactions:{async transaction(work){const draft=structuredClone(state),result=await work({state:draft,now:()=>now});state=draft;return result;}}});
    const exchange=token=>handler(new Request('https://api.example.invalid/api/v1/auth/clerk',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{}'}));
    const first=await exchange(await sign({jti:'names-first',first_name:'Forged claim',roles:['owner']}));assert.equal(first.status,200);
    const profile=(await first.json()).data.profile;assert.equal(profile.first_name,'Provider');assert.equal(profile.last_name,'Student');assert.equal(profile.registration_complete,false);assert.deepEqual(profile.roles,['student']);
    const stored=state.domain.student.people[profile.person_id];stored.profile.first_name='Edited';stored.profile.last_name='Platform';stored.profile.registration_complete=true;
    const pinned=structuredClone(stored);current={...session(),id:'sess_WorkerNamesSecond'};account={...user(),first_name:'Changed',last_name:'Provider'};
    const second=await exchange(await sign({jti:'names-second',sid:current.id}));assert.equal(second.status,200);assert.equal((await second.json()).data.profile.first_name,'Edited');assert.deepEqual(state.domain.student.people[profile.person_id],pinned);
    for(const [i,first_name]of ['x'.repeat(101),42,{},false,'bad\u0000name','\ud800'].entries()){
      account={...user(),first_name,last_name:{invalid:'unused for existing mapping'}};
      const bound={issuer,userId:uid,sessionId:current.id},live=await adapter.liveness(bound,now);
      assert.deepEqual(live.firstName,first_name);assert.equal(await requireLiveClerk(bound,now,adapter.liveness),now+30000);
      const relogin=await exchange(await sign({jti:'names-ignore-'+i,sid:current.id}));assert.equal(relogin.status,200);
      assert.deepEqual(state.domain.student.people[profile.person_id],pinned);
    }
    const before=structuredClone(state),bad=await sign({jti:'bad-name-signature',sid:current.id});
    assert.equal((await exchange(bad.slice(0,bad.lastIndexOf('.')+1)+'invalid')).status,401);assert.deepEqual(state,before);
    for(const change of [{iss:'https://other.invalid'},{azp:'https://other.invalid'},{exp:now/1000},{aud:'unexpected'}])await assert.rejects(verify(await sign(change)),e=>e.status===401);
    current={...session(),status:'revoked'};await assert.rejects(requireLiveClerk(identity,now,adapter.liveness),e=>e.status===401);
    for(const field of ['banned','locked','deprovisioned']){current=session();account={...user(),[field]:true};await assert.rejects(requireLiveClerk(identity,now,adapter.liveness),e=>e.status===401);}
    account=user();current={...session(),expire_at:now};await assert.rejects(requireLiveClerk(identity,now,adapter.liveness),e=>e.status===401);
    current={...session(),expire_at:now+100};assert.equal(await requireLiveClerk(identity,now,adapter.liveness),now+100);assert.ok(calls>6);
  }finally{adapter.close();}
});

for(const [label,raw,expected]of [
  ['both names',{first_name:'Aziz',last_name:'Karimov'},{firstName:'Aziz',lastName:'Karimov'}],
  ['null names',{first_name:null,last_name:null},{firstName:null,lastName:null}],
  ['missing names',{}, {firstName:null,lastName:null}],
  ['partial name',{first_name:'Aziz',last_name:null},{firstName:'Aziz',lastName:null}],
  ['blank names',{first_name:'',last_name:'  '},{firstName:'',lastName:'  '}],
  ['Unicode100',{first_name:'😀'.repeat(100),last_name:'O‘quvchi'},{firstName:'😀'.repeat(100),lastName:'O‘quvchi'}],
])test('selected raw Backend User display fields: '+label,async()=>{
  const f=fixture({respond:()=>json({...user(),...raw,firstName:'client-looking-ignored',lastName:'ignored',email_addresses:[{email_address:'fallback@invalid'}],unsafe_metadata:{roles:['owner'],first_name:'Forged'}})});
  try{
    const result=await f.bindings.getUser(uid);assert.deepEqual(result,{...user(),...expected});assert.ok(Object.isFrozen(result));
    assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,'https://api.clerk.com/v1/users/'+uid);
  }finally{f.bindings.close();}
});
for(const value of [42,true,{},[], 'x'.repeat(101),'😀'.repeat(101),'\ud800','\udc00','bad\u0000name'])
for(const field of ['first_name','last_name'])test('malformed raw name is carried without authorization impact but fails creation validation: '+field+'/'+JSON.stringify(value).slice(0,22),async()=>{
  const f=fixture({respond:()=>json({...user(),first_name:'Valid',last_name:'Name',[field]:value})});
  try{const model=await f.bindings.getUser(uid);assert.deepEqual(model[field==='first_name'?'firstName':'lastName'],value);
    assert.throws(()=>clerkDisplayNames(model),denied);assert.equal(f.requests.length,1);}finally{f.bindings.close();}
});
test('validated liveness profile binds exact identity, flags and expiry before returning names',async()=>{
  const identity={issuer,userId:uid,sessionId:sid},live={...identity,status:'active',accountEnabled:true,expiresAt:now+100,firstName:'Provider',lastName:'Name'};
  assert.deepEqual(await requireLiveClerkProfile(identity,now,async()=>live),{firstName:'Provider',lastName:'Name',expiresAt:now+100});
  assert.equal(await requireLiveClerk(identity,now,async()=>live),now+100); // Existing guard return shape stays numeric.
  for(const change of [{userId:'user_Wrong'},{sessionId:'sess_Wrong'},{issuer:'https://wrong.invalid'}, {status:'revoked'},{accountEnabled:false},{expiresAt:now}])
    await assert.rejects(requireLiveClerkProfile(identity,now,async()=>({...live,...change})),e=>e.status===401);
  for(const value of [[],101,'x'.repeat(101),'\ud800'])
    await assert.rejects(requireLiveClerkProfile(identity,now,async()=>({...live,firstName:value})),denied);
  assert.deepEqual(clerkDisplayNames({}),{firstName:null,lastName:null});
});
test('P2-NAMES-01 common liveness ignores optional display fields for an active existing identity',async()=>{
  const identity={issuer,userId:uid,sessionId:sid},at=1000;
  for(const firstName of ['x'.repeat(101),'😀'.repeat(101),42,{},[],false,'\ud800','\udc00','bad\u0000name']){
    const live={...identity,status:'active',accountEnabled:true,expiresAt:2000,firstName,lastName:{malformed:'display only'}};
    assert.equal(await requireLiveClerk(identity,at,async()=>live),2000);
    await assert.rejects(requireLiveClerkProfile(identity,at,async()=>live),denied);
  }
  let reads=0;const live={...identity,status:'active',accountEnabled:true,expiresAt:2000,
    get firstName(){reads++;throw Error('Display getter must not participate in authentication');}};
  assert.equal(await requireLiveClerk(identity,at,async()=>live),2000);assert.equal(reads,0);
  const mutable={...identity,status:'active',accountEnabled:true};
  Object.defineProperty(mutable,'expiresAt',{configurable:true,get(){
    queueMicrotask(()=>Object.defineProperty(mutable,'expiresAt',{value:3000,configurable:true}));return 2000;
  }});
  assert.equal(await requireLiveClerk(identity,at,async()=>mutable),2000,'Expiry must be copied before leaving the checked frame');
  for(const patch of [{issuer:'https://foreign.invalid'},{userId:'user_Other'},{sessionId:'sess_Other'},
    {status:'revoked'},{accountEnabled:false},{expiresAt:at}]){
    await assert.rejects(requireLiveClerk(identity,at,async()=>({...identity,status:'active',accountEnabled:true,expiresAt:2000,firstName:'x'.repeat(101),...patch})),e=>e.status===401);
  }
  await assert.rejects(requireLiveClerk(identity,at,async()=>{throw Error('synthetic provider failure');}),denied);
});
test('P2-NAMES-01 Worker transport retains only raw name fields until new-person selection',async()=>{
  const f=fixture({respond:()=>json({...user(),first_name:'x'.repeat(101),last_name:{malformed:'display only'},unsafe_metadata:{roles:['owner']}})});
  try{
    const model=await f.bindings.getUser(uid);assert.equal(model.firstName,'x'.repeat(101));assert.deepEqual(model.lastName,{malformed:'display only'});
    assert.deepEqual(Object.keys(model).sort(),['id','banned','locked','deprovisioned','firstName','lastName'].sort());
  }finally{f.bindings.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createAtomicTelegramRuntime} from '../src/telegram-atomic-runtime.ts';
import {StudentFailure} from '../src/transport.ts';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise}};
function setup(overrides={}){
 let identity={userId:'u1',sessionId:'s1'},raw='signed-launch',calls=[],verifications=0;
 const runtime=createAtomicTelegramRuntime({readLaunch:()=>raw,identity:()=>identity,reverify:async id=>{verifications++;return{...id,token:'jwt'}},
 connect:(method,signal,launch)=>{calls.push({method,signal,launch});return{auth:{person:()=>null,clear(){},logout:async()=>{},login:async()=>{throw new StudentFailure('conflict','TELEGRAM_LINK_REQUIRED')}},port:{}}},...overrides});
 return{runtime,calls,get verifications(){return verifications},switch(){identity={userId:'u2',sessionId:'s2'}},changeLaunch(){raw='another-launch'}};
}
test('resume runs once and only known missing-link allows explicit Clerk confirmation',async()=>{const h=setup();await h.runtime.resume();await h.runtime.resume();assert.equal(h.calls.length,1);assert.equal(h.runtime.snapshot().phase,'choose');assert.equal(h.verifications,0);await h.runtime.confirm('wrong');assert.equal(h.verifications,0);await h.runtime.confirm('link-telegram-account-v1');assert.equal(h.verifications,1);assert.deepEqual(h.calls.map(c=>c.method),['telegram_resume','telegram_atomic']);assert.equal(h.runtime.snapshot().phase,'blocked')});
test('unknown resume errors never fall back to Clerk linking',async()=>{for(const failure of [Error('timeout'),new StudentFailure('temporary','SERVICE_UNAVAILABLE'),new StudentFailure('auth','SESSION_REVOKED')]){const h=setup({connect:()=>({auth:{person:()=>null,clear(){},login:async()=>{throw failure}}})});await h.runtime.resume();assert.equal(h.runtime.snapshot().phase,'blocked');await h.runtime.confirm('link-telegram-account-v1');assert.equal(h.verifications,0)}});
test('Clerk revoked resume is known gate but post-login profile error cannot open linking',async()=>{for(const established of [false,true]){const h=setup({connect:()=>({auth:{person:()=>established?'p':null,clear(){},login:async()=>{throw new StudentFailure('auth','CLERK_SESSION_REVOKED')}}})});await h.runtime.resume();assert.equal(h.runtime.snapshot().phase,established?'blocked':'choose')}});
test('cancel/switch/dispose during real-proof await prevents atomic POST',async()=>{for(const action of ['cancel','switch','dispose']){const gate=deferred();const h=setup({reverify:()=>gate.promise});await h.runtime.resume();const p=h.runtime.confirm('link-telegram-account-v1');if(action==='switch')h.switch();else h.runtime[action]();gate.resolve({userId:'u1',sessionId:'s1',token:'jwt'});await p;assert.equal(h.calls.length,1)}});
test('changed raw launch or wrong proof identity never links',async()=>{for(const changed of [false,true]){const h=setup({reverify:async()=>({userId:'wrong',sessionId:'s1',token:'jwt'})});await h.runtime.resume();if(changed)h.changeLaunch();await h.runtime.confirm('link-telegram-account-v1');assert.equal(h.calls.length,1)}});
test('double click only reverifies once and cancellation result never links',async()=>{const gate=deferred();let n=0;const h=setup({reverify:()=>{n++;return gate.promise}});await h.runtime.resume();const p=h.runtime.confirm('link-telegram-account-v1');await h.runtime.confirm('link-telegram-account-v1');gate.resolve(null);await p;assert.equal(n,1);assert.equal(h.calls.length,1);assert.equal(h.runtime.snapshot().phase,'choose')});
test('real SDK useReverification wraps proof-only callback; atomic path isolated from legacy runtime',async()=>{const{readFile}=await import('node:fs/promises');const entry=await readFile(new URL('../src/telegram-atomic-entry.tsx',import.meta.url),'utf8');assert.match(entry,/useReverification\(async/);assert.match(entry,/reverificationError\(policy\)/);assert.match(entry,/getToken\(\{skipCache:true\}\)/);assert.match(entry,/afterMinutes:4/);assert.doesNotMatch(entry,/__internal|exchangeClerk|linkTelegramIdentity/);const wrapper=await readFile(new URL('../src/clerk-prebuilt-entry.tsx',import.meta.url),'utf8');assert.match(wrapper,/telegramAtomicEnabled && hasTelegramLaunchContext/);assert.ok(wrapper.indexOf('return <AtomicTelegramEntry')<wrapper.indexOf('return <LegacyPrebuiltReadyEntry'))});

test('successful atomic entry opens existing StudentFlow; same-device account switch retires it',async()=>{
 const calls=[];let person=null;
 const h=setup({connect:method=>{calls.push(method);return{auth:{person:()=>person,clear(){person=null},logout:async()=>{},login:async()=>{if(method==='telegram_resume')throw new StudentFailure('conflict','TELEGRAM_LINK_REQUIRED');return person='p1'}},port:{profile:async()=>({person:'p1',firstName:'A',lastName:'B',displayId:'1',registrationComplete:false})}}}});
 await h.runtime.resume();await h.runtime.confirm('link-telegram-account-v1');assert.equal(h.runtime.snapshot().phase,'ready');assert.equal(h.runtime.snapshot().flow.snapshot().screen,'profile');h.switch();h.runtime.observe();assert.equal(h.runtime.snapshot().phase,'blocked');assert.equal(person,null);assert.deepEqual(calls,['telegram_resume','telegram_atomic']);
});
test('successful signed resume opens cabinet without Clerk proof and never auto-links',async()=>{
 let person=null;const h=setup({connect:method=>{assert.equal(method,'telegram_resume');return{auth:{person:()=>person,clear(){},login:async()=>person='p1'},port:{profile:async()=>({person:'p1',registrationComplete:false})}}}});
 await h.runtime.resume();assert.equal(h.runtime.snapshot().phase,'ready');assert.equal(h.verifications,0);
});

test('owner atomic adapter preserves canonical deadline and account-switch abort, headers/body',async t=>{
 const{createOwnerPort}=await import('../src/owner-port.ts');const{STUDENT_CONTRACT_SHA256}=await import('../src/owner-client/student-client.ts');
 t.mock.timers.enable({apis:['setTimeout']});
 for(const kind of ['timeout','account-switch']){
  const external=new AbortController();let request;
  const connection=createOwnerPort({mode:'production',contractSha256:STUDENT_CONTRACT_SHA256,baseUrl:'https://api.example.test/api/v1',loginMethod:'telegram_atomic',loginSignal:external.signal,atomicInitData:'exact signed launch',view:()=>({title:'',groupLabel:'',startAllowed:false}),assetUrl:x=>x,fetcher:async r=>{request=r;return new Promise((_,reject)=>r.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))}});
  const result=connection.auth.login('a.b.c');const rejected=assert.rejects(result);
  await new Promise(r=>setImmediate(r));assert.equal(request.headers.get('authorization'),'Bearer a.b.c');assert.deepEqual(await request.clone().json(),{init_data:'exact signed launch',confirmation:'link-telegram-account-v1'});
  if(kind==='timeout')t.mock.timers.tick(10000);else external.abort();
  await rejected;assert.equal(request.signal.aborted,true);
 }
});

test('observe during linking immediately aborts outgoing request; late login never exposes cabinet',async()=>{
 const pending=deferred();let signal,person=null,profileReads=0,clears=0;
 const h=setup({connect:(method,s)=>({auth:{person:()=>person,clear(){person=null;clears++},login:async()=>{if(method==='telegram_resume')throw new StudentFailure('conflict','TELEGRAM_LINK_REQUIRED');signal=s;await pending.promise;return person='late-person'}},port:{profile:async()=>{profileReads++;return{person:'late-person',registrationComplete:false}}}})});
 await h.runtime.resume();const result=h.runtime.confirm('link-telegram-account-v1');await new Promise(r=>setImmediate(r));assert.equal(h.runtime.snapshot().phase,'linking');
 h.switch();h.runtime.observe();assert.equal(signal.aborted,true);assert.equal(h.runtime.snapshot().phase,'blocked');assert.match(h.runtime.snapshot().notice,/noaniq/);
 pending.resolve();await result;assert.equal(h.runtime.snapshot().phase,'blocked');assert.equal(h.runtime.snapshot().flow,null);assert.equal(person,null);assert.equal(profileReads,0);assert.ok(clears>=2);
});
test('observe while verifying invalidates proof immediately and requires new explicit confirmation',async()=>{
 const pending=deferred();const h=setup({reverify:()=>pending.promise});await h.runtime.resume();const result=h.runtime.confirm('link-telegram-account-v1');
 h.switch();h.runtime.observe();assert.equal(h.runtime.snapshot().phase,'choose');pending.resolve({userId:'u1',sessionId:'s1',token:'jwt'});await result;assert.equal(h.calls.length,1);assert.equal(h.runtime.snapshot().phase,'choose');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createQuickRegisterRuntime,describeFailure} from '../src/telegram-quick-register-runtime.ts';
import {StudentClientProtocolError} from '../src/owner-client/student-client.ts';
import {createTelegramRegisterClient,readTelegramNamePrefill} from '../src/telegram-register-client.ts';
import {StudentFailure} from '../src/transport.ts';

const profile=(complete,names={})=>({person:'p1',firstName:names.first??'',lastName:names.last??'',displayId:'0000000001',registrationComplete:complete});
function setup({register,ticket=async()=>'jwt',linked=false,entry,readProfile}={}){
  const calls=[],registered=[];let person=null,complete=false,names={};
  const runtime=createQuickRegisterRuntime({
    readLaunch:()=>'signed-launch',
    register:async input=>{calls.push('register');return register?register(input):{status:'ticket',ticket:'tkt'};},
    signInWithTicket:async t=>{calls.push('ticket:'+t);return ticket(t);},
    connect:(method,signal,raw)=>{calls.push(method);assert.equal(raw,'signed-launch');return{auth:{person:()=>person,clear(){person=null;},logout:async()=>{},
      login:async proof=>{
        if(method==='telegram_resume'){if(!linked)throw new StudentFailure('conflict','TELEGRAM_LINK_REQUIRED');complete=true;return person='p1';}
        if(entry)await entry(proof);assert.equal(proof,'jwt');linked=true;return person='p1';}},
      port:{profile:async()=>readProfile?readProfile():profile(complete,names),exams:async()=>[],register:async(f,l)=>{registered.push([f,l]);complete=true;names={first:f,last:l};return profile(true,names);}}};},
  });
  return{runtime,calls,registered};
}

test('new student: name card -> register -> ticket -> atomic entry -> cabinet, no second name prompt',async()=>{
  const h=setup();await h.runtime.resume();assert.equal(h.runtime.snapshot().phase,'name');
  await h.runtime.submit({firstName:' Aziz ',lastName:'Karimov'});
  assert.deepEqual(h.calls,['telegram_resume','register','ticket:tkt','telegram_atomic']);
  assert.equal(h.runtime.snapshot().phase,'ready');
  assert.deepEqual(h.registered,[['Aziz','Karimov']]);
  assert.equal(h.runtime.snapshot().flow.snapshot().screen,'exams');
});
test('returning student goes straight into the cabinet',async()=>{
  const h=setup({linked:true});await h.runtime.resume();
  assert.equal(h.runtime.snapshot().phase,'ready');assert.deepEqual(h.calls,['telegram_resume']);
});
test('already registered answer switches to the normal resume path',async()=>{
  let linked=false;const h=setup({register:async()=>{return {status:'already_registered'};}});
  await h.runtime.resume();
  // Server says another tab already finished: resume must now succeed.
  h.runtime.snapshot();await h.runtime.submit({firstName:'A',lastName:'B'});
  assert.deepEqual(h.calls,['telegram_resume','register','telegram_resume']);void linked;
});
test('double tap sends one registration only',async()=>{
  let release;const gate=new Promise(r=>release=r);
  const h=setup({register:async()=>{await gate;return {status:'ticket',ticket:'tkt'};}});
  await h.runtime.resume();
  const a=h.runtime.submit({firstName:'A',lastName:'B'}),b=h.runtime.submit({firstName:'A',lastName:'B'});
  release();await Promise.all([a,b]);
  assert.equal(h.calls.filter(c=>c==='register').length,1);
});
test('ordinary failure returns to the name card with a retry message, never to Clerk',async()=>{
  let fail=true;const h=setup({register:async()=>{if(fail)throw new StudentFailure('temporary','SERVICE_UNAVAILABLE');return {status:'ticket',ticket:'tkt'};}});
  await h.runtime.resume();await h.runtime.submit({firstName:'A',lastName:'B'});
  assert.equal(h.runtime.snapshot().phase,'name');assert.match(h.runtime.snapshot().notice,/Qayta urinib/);
  assert.doesNotMatch(h.runtime.snapshot().notice,/Internet/);assert.equal(h.runtime.snapshot().errorCode,'SERVICE_UNAVAILABLE');
  fail=false;await h.runtime.submit({firstName:'A',lastName:'B'});assert.equal(h.runtime.snapshot().phase,'ready');
});
test('ticket sign-in failure also stays on the name card',async()=>{
  const h=setup({ticket:async()=>{throw Error('clerk down');}});
  await h.runtime.resume();await h.runtime.submit({firstName:'A',lastName:'B'});
  assert.equal(h.runtime.snapshot().phase,'name');assert.ok(!h.calls.includes('telegram_atomic'));
});
test('expired Telegram data asks to reopen from the bot',async()=>{
  const h=setup({register:async()=>{throw new StudentFailure('auth','INIT_DATA_EXPIRED');}});
  await h.runtime.resume();await h.runtime.submit({firstName:'A',lastName:'B'});
  assert.equal(h.runtime.snapshot().phase,'blocked');assert.match(h.runtime.snapshot().notice,/\/start/);
});
test('empty names are not sent',async()=>{
  const h=setup();await h.runtime.resume();await h.runtime.submit({firstName:'  ',lastName:'B'});
  assert.ok(!h.calls.includes('register'));assert.equal(h.runtime.snapshot().phase,'name');
});
test('register client: exact request, strict answers, error codes kept',async()=>{
  const seen=[];const reply=(v,s=200)=>new Response(JSON.stringify(v),{status:s,headers:{'content-type':'application/json'}});
  let next=reply({status:'ticket',ticket:'abc'});
  const c=createTelegramRegisterClient({baseUrl:'https://api.example.com/api/v1',transport:async r=>{seen.push({url:r.url,body:await r.json(),auth:r.headers.get('authorization')});return next;}});
  assert.deepEqual(await c.register({init_data:'raw',first_name:'A',last_name:'B'}),{status:'ticket',ticket:'abc'});
  assert.deepEqual(seen[0],{url:'https://api.example.com/api/v1/auth/telegram/register',body:{init_data:'raw',first_name:'A',last_name:'B'},auth:null});
  next=reply({status:'already_registered'});assert.deepEqual(await c.register({init_data:'raw',first_name:'A',last_name:'B'}),{status:'already_registered'});
  next=reply({status:'ticket',ticket:'abc',user_id:'user_1'});await assert.rejects(c.register({init_data:'raw',first_name:'A',last_name:'B'}),e=>e.code==='CLIENT_INVALID_RESPONSE');
  next=reply({error:{code:'RATE_LIMITED'}},429);await assert.rejects(c.register({init_data:'raw',first_name:'A',last_name:'B'}),e=>e.code==='RATE_LIMITED'&&e.kind==='limited');
});
test('prefill uses Telegram names only as editable text, cleaned',()=>{
  assert.deepEqual(readTelegramNamePrefill({Telegram:{WebApp:{initDataUnsafe:{user:{first_name:'Aziz 🚀',last_name:'O‘g‘ilov'}}}}}),{firstName:'Aziz',lastName:'O‘g‘ilov'});
  assert.deepEqual(readTelegramNamePrefill({}),{firstName:'',lastName:''});
});
test('wiring: default off, chosen before other Telegram entries, no Clerk/Google window in quick path',async()=>{
  const wrapper=await readFile(new URL('../src/clerk-prebuilt-entry.tsx',import.meta.url),'utf8');
  assert.match(wrapper,/telegramQuickRegister && props\.config\.telegramEnabled && hasTelegramLaunchContext/);
  assert.ok(wrapper.indexOf('return <QuickTelegramEntry')<wrapper.indexOf('return <AtomicTelegramEntry'));
  const config=await readFile(new URL('../src/common-production-runtime.ts',import.meta.url),'utf8');
  assert.match(config,/telegramQuickRegister: env\.VITE_TELEGRAM_QUICK_REGISTER === 'true'/);
  const entry=await readFile(new URL('../src/telegram-quick-register-entry.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(entry,/SignInCard|SignIn\b|authenticateWithRedirect|oauth_google|openSignIn/);
  assert.match(entry,/strategy:'ticket'/);assert.match(entry,/getToken\(\{skipCache:true\}\)/);
  assert.match(entry,/signIn\.create\(\{strategy:'ticket',ticket\}\)/);assert.doesNotMatch(entry,/signIn\.ticket\(/);
  assert.match(entry,/className="error-code"/);
});
// Live 2026-11-27: entry 200, then the first profile read answered 401
// CLERK_SESSION_REVOKED, and the card said "check the internet".
test('a server refusal after sign-in is not called an internet problem; its code is shown',async()=>{
  const h=setup({readProfile:async()=>{throw new StudentFailure('auth','CLERK_SESSION_REVOKED');}});
  await h.runtime.resume();await h.runtime.submit({firstName:'A',lastName:'B'});
  const s=h.runtime.snapshot();
  assert.equal(s.phase,'name');assert.doesNotMatch(s.notice,/Internet/);assert.equal(s.errorCode,'CLERK_SESSION_REVOKED');
});
test('a request that never got an answer is called a connection problem',async()=>{
  const h=setup({register:async()=>{throw new StudentFailure('temporary','CLIENT_REQUEST_UNCONFIRMED');}});
  await h.runtime.resume();await h.runtime.submit({firstName:'A',lastName:'B'});
  assert.match(h.runtime.snapshot().notice,/Internet aloqasi uzildi/);assert.equal(h.runtime.snapshot().errorCode,'CLIENT_REQUEST_UNCONFIRMED');
});
test('Clerk ticket failure shows Clerk\'s own code',async()=>{
  const h=setup({ticket:async()=>{throw Object.assign(Error('x'),{code:'CLERK_TICKET_form_identifier_not_found'});}});
  await h.runtime.resume();await h.runtime.submit({firstName:'A',lastName:'B'});
  assert.equal(h.runtime.snapshot().errorCode,'CLERK_TICKET_FORM_IDENTIFIER_NOT_FOUND');assert.doesNotMatch(h.runtime.snapshot().notice,/Internet/);
});
test('blocked screen (reopen from the bot) also carries the code',async()=>{
  const h=setup({register:async()=>{throw new StudentFailure('conflict','INIT_DATA_REPLAY');}});
  await h.runtime.resume();await h.runtime.submit({firstName:'A',lastName:'B'});
  assert.equal(h.runtime.snapshot().phase,'blocked');assert.equal(h.runtime.snapshot().errorCode,'INIT_DATA_REPLAY');
});
test('describeFailure separates real network loss from everything else',()=>{
  assert.deepEqual(describeFailure(new StudentFailure('offline','OFFLINE')),{code:'OFFLINE',network:true});
  assert.deepEqual(describeFailure(new StudentFailure('temporary','CLIENT_REQUEST_UNCONFIRMED')),{code:'CLIENT_REQUEST_UNCONFIRMED',network:true});
  assert.deepEqual(describeFailure(new StudentFailure('temporary','SERVICE_UNAVAILABLE')),{code:'SERVICE_UNAVAILABLE',network:false});
  assert.deepEqual(describeFailure(new StudentClientProtocolError('CLIENT_REQUEST_UNCONFIRMED')),{code:'CLIENT_REQUEST_UNCONFIRMED',network:true});
  assert.deepEqual(describeFailure(new StudentClientProtocolError('CLIENT_INVALID_RESPONSE')),{code:'CLIENT_INVALID_RESPONSE',network:false});
  assert.deepEqual(describeFailure(Object.assign(Error('n'),{code:'network_error'})),{code:'NETWORK_ERROR',network:true});
  assert.deepEqual(describeFailure(new TypeError('Failed to fetch')),{code:'NETWORK_ERROR',network:true});
  assert.deepEqual(describeFailure(Error('Something odd')),{code:'SOMETHING_ODD',network:false});
  assert.deepEqual(describeFailure(42),{code:'UNKNOWN',network:false});
});

// The Ega (Owner) site's own DOM module with a controlled identity and HTTP boundary. Nothing here talks to a provider.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';
import { mountOwnerCabinet } from '../../apps/mini-app/owner-entrance/owner-workspace.mjs';
import { createOwnerTransport } from '../../apps/mini-app/owner-entrance/owner-transport.mjs';
import { ownerOrigin } from '../../apps/mini-app/owner-entrance/owner-route.mjs';
import { requestOwnerEmailCode } from '../../apps/mini-app/owner-entrance/email-code.mjs';

const {JSDOM} = createRequire(new URL('../teacher-local-pilot/tooling/package.json',import.meta.url))('jsdom');
const person = crypto.randomUUID(), endpoint = ownerOrigin + '/api/v1/owner/pilot/dashboard';
const identityValue = {userId:'provider-owner',generation:'session-1'};
const reply = (data,{status=200,headers={}}={}) => {
  const response = new Response(JSON.stringify(status<400?{data}:{error:data}),{status,headers:{'content-type':'application/json','cache-control':'no-store',...headers}});
  Object.defineProperty(response,'url',{value:endpoint});return response;
};
function context(dom,t) {
  for (const [name,value] of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location})) {
    const previous = Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
    t.after(() => { if (previous) Object.defineProperty(globalThis,name,previous); else delete globalThis[name]; });
  }
  t.after(() => dom.window.close());
}
function setup(t,{answer=()=>reply({role:'owner',person_id:person,name:'Loyiha egasi'}),url=ownerOrigin+'/'}={}) {
  const dom = new JSDOM('<div id="host"></div>',{url,pretendToBeVisual:true});
  context(dom,t);
  const host = document.getElementById('host'), calls = [];
  let identity = identityValue, notify, tokens = 0, signedOut = 0;
  const user = {current:()=>identity,subscribe(fn){notify=fn;return ()=>{};},async signOut(){signedOut++;identity=null;notify();}};
  const dispose = mountOwnerCabinet(host,{origin:ownerOrigin,identity:user,
    async getCurrentClerkToken(){return 'signed.' + (++tokens);},
    async fetch(target,options){calls.push({target,options});return answer(target,options,calls.length);}});
  t.after(dispose);
  const until = async check => { for (let i=0;i<200;i++) { if (check()) return; await pause(5); } assert.fail('Did not settle: ' + host.textContent); };
  return {host,calls,until,user,get tokens(){return tokens;},get signedOut(){return signedOut;},switchTo(next){identity=next;notify();}};
}

test('the Owner sees only their own name, read with one session-bound request to the Owner origin', async t => {
  const s = setup(t);
  await s.until(() => s.host.querySelector('h1'));
  assert.equal(s.host.querySelector('h1').textContent,'Ega kabineti');
  assert.match(s.host.textContent,/Loyiha egasi/);
  assert.equal(s.calls.length,1);
  const [{target,options}] = s.calls;
  assert.equal(target,endpoint); assert.equal(options.method,'GET'); assert.equal(options.credentials,'omit'); assert.equal(options.redirect,'error'); assert.equal(options.cache,'no-store');
  assert.equal(options.headers.Authorization,'Bearer signed.1'); assert.equal(options.body,undefined);
});
test('a denial closes the page: Owner-only for 403, session check for 401, with no data on screen', async t => {
  for (const [status,text] of [[403,/faqat Ega uchun/],[401,/sessiyasini tekshiring/]]) {
    const s = setup(t,{answer:()=>reply({code:'X'},{status})});
    await s.until(() => /faqat Ega|sessiyasini/.test(s.host.textContent));
    assert.match(s.host.textContent,text); assert(!s.host.textContent.includes('Loyiha'));
    assert.deepEqual([...s.host.querySelectorAll('button')].map(b=>b.textContent),['Qayta tekshirish','Chiqish']);
  }
});
test('an answer that is not exactly this Owner is refused', async t => {
  for (const data of [{role:'teacher',person_id:person,name:'X'},{role:'owner',person_id:'not-a-uuid',name:'X'},{role:'owner',person_id:person,name:'  '},{role:'owner',person_id:person},null,{role:'admin',person_id:person,name:'X'}]) {
    const s = setup(t,{answer:()=>reply(data)});
    await s.until(() => /faqat Ega uchun|yuklab bo/.test(s.host.textContent));
    assert(!s.host.querySelector('h1'));
  }
});
test('a response that is redirected, unmarked, wrong-typed, oversized or from another address is never shown', async t => {
  const bad = [
    () => { const r = reply({role:'owner',person_id:person,name:'X'}); Object.defineProperty(r,'url',{value:'https://evil.example/x'}); return r; },
    () => reply({role:'owner',person_id:person,name:'X'},{headers:{'cache-control':'public'}}),
    () => reply({role:'owner',person_id:person,name:'X'},{headers:{'content-type':'text/html'}}),
    () => reply({role:'owner',person_id:person,name:'X'},{headers:{'content-length':String(10*1024*1024)}}),
    () => { const r = reply({role:'owner',person_id:person,name:'X'}); Object.defineProperty(r,'redirected',{value:true}); return r; },
    () => { throw new TypeError('network'); },
  ];
  for (const answer of bad) {
    const s = setup(t,{answer});
    await s.until(() => /yuklab bo/.test(s.host.textContent));
    assert(!s.host.querySelector('h1')); assert(!s.host.textContent.includes('X'));
  }
});
test('switching to another session clears the page and a changed person is refused', async t => {
  let n = 0; const other = crypto.randomUUID();
  const s = setup(t,{answer:()=>reply({role:'owner',person_id:++n===1?person:other,name:'Loyiha egasi'})});
  await s.until(() => s.host.querySelector('h1'));
  s.switchTo({userId:'someone-else',generation:'session-9'});
  assert.equal(s.host.childNodes.length,0);
  await pause(30); assert.equal(s.calls.length,1,'a different identity never triggers a read for the old session');
});
test('sign-out ends the page and goes through the identity, not around it', async t => {
  const s = setup(t);
  await s.until(() => s.host.querySelector('button'));
  [...s.host.querySelectorAll('button')].find(b => b.textContent==='Chiqish').click();
  await s.until(() => s.signedOut === 1);
  assert.equal(s.host.childNodes.length,0);
});
test('the transport refuses any origin other than the page and sends the token nowhere else', async t => {
  const dom = new JSDOM('<div></div>',{url:ownerOrigin+'/',pretendToBeVisual:true}); context(dom,t);
  const make = origin => createOwnerTransport({origin,expected:identityValue,identity:{current:()=>identityValue},getCurrentClerkToken:async()=>'t.k',fetch:async()=>reply({}),signal:new AbortController().signal,onDenied(){}});
  for (const origin of ['https://ustoz.univeracademy.uz','http://ega.univeracademy.uz','https://ega.univeracademy.uz/x','https://evil.example']) assert.throws(() => make(origin));
  assert.doesNotThrow(() => make(ownerOrigin));
});
test('the Owner origin is the dedicated ega address, and the page is closed anywhere else', () => {
  assert.equal(ownerOrigin,'https://ega.univeracademy.uz');
});
test('an unknown email gets the same silent outcome as a locked one when requesting a code', async () => {
  for (const code of ['form_identifier_not_found','identifier_not_found','factor_not_found','user_locked','user_banned','sign_in_not_allowed_for_user'])
    assert.equal(await requestOwnerEmailCode({emailCode:{sendCode:async()=>{throw {code};}}},'a@b.c'),null);
  assert.equal(await requestOwnerEmailCode({id:'si_1',emailCode:{sendCode:async()=>({error:null})}},'a@b.c'),'si_1');
  await assert.rejects(requestOwnerEmailCode({emailCode:{sendCode:async()=>{throw new Error('boom');}}},'a@b.c'));
});

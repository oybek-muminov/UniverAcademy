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

// --- Teachers: list, look a student up by ID, make a Teacher after one explicit confirmation ---
const answerFor = (target, data, { status = 200, headers = {} } = {}) => {
  const response = new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
  Object.defineProperty(response, 'url', { value: target }); return response;
};
const commandUrl = name => ownerOrigin + '/api/v1/owner/pilot/commands/' + name;
function teacherSetup(t, { find = id => ({ found: true, univeracademy_id: id, name: 'Nomzod Sinov', role: 'student', eligible: true, reason: null }), assign, teachers } = {}) {
  let list = teachers ?? [{ id: crypto.randomUUID(), name: 'Ustoz Sinov', univeracademy_id: '0807896715', subjects: ['physics'] }];
  const s = setup(t, { answer: (target, options) => {
    if (target === endpoint) return answerFor(target, { role: 'owner', person_id: person, name: 'Loyiha egasi', teachers: list, canAssignTeacher: true });
    const body = JSON.parse(options.body);
    if (target === commandUrl('findStudent')) { const r = find(body.univeracademy_id); return r?.__status ? answerFor(target, r.error, { status: r.__status }) : answerFor(target, r); }
    if (target === commandUrl('assignTeacher')) {
      const r = assign ? assign(body, options) : { id: crypto.randomUUID(), univeracademy_id: body.univeracademy_id, name: 'Nomzod Sinov', subjectId: 'physics' };
      if (r?.__status) return answerFor(target, r.error, { status: r.__status });
      list = [...list, { id: r.id, name: r.name, univeracademy_id: r.univeracademy_id, subjects: ['physics'] }];
      return answerFor(target, r);
    }
    throw new Error('unexpected ' + target);
  } });
  const button = name => [...s.host.querySelectorAll('button')].find(b => b.textContent === name);
  const search = async id => { s.host.querySelector('input').value = id; button('Topish').click(); };
  return { ...s, button, search };
}
test('the Owner sees the Teachers already made and only well-formed entries', async t => {
  const s = teacherSetup(t, { teachers: [{ id: crypto.randomUUID(), name: 'Ustoz Sinov', univeracademy_id: '0807896715', subjects: ['physics'] },
    { id: 'x', name: '', univeracademy_id: '1', subjects: [] }, { name: 'Yomon', univeracademy_id: '0807896716', subjects: 'physics' }, null] });
  await s.until(() => s.host.querySelector('h2'));
  assert.deepEqual([...s.host.querySelectorAll('li')].map(x => x.textContent), ['Ustoz Sinov · ID 0807896715 · Fizika']);
  assert(!s.host.textContent.includes('Yomon'));
});
test('an invalid ID asks nothing of the server; a found student needs two explicit steps; the Teacher then appears', async t => {
  const s = teacherSetup(t);
  await s.until(() => s.button('Topish'));
  await s.search('12'); await pause(20);
  assert.match(s.host.textContent, /aynan 10 ta raqam/); assert.equal(s.calls.length, 1);
  await s.search('0101000041');
  await s.until(() => s.button('Ustoz qilish'));
  const lookupCall = s.calls[1];
  assert.equal(lookupCall.target, commandUrl('findStudent')); assert.equal(lookupCall.options.method, 'POST');
  assert.deepEqual(JSON.parse(lookupCall.options.body), { univeracademy_id: '0101000041' });
  assert.equal(lookupCall.options.credentials, 'omit'); assert.match(lookupCall.options.headers.Authorization, /^Bearer signed\./);
  assert.equal(s.calls.length, 2, 'looking up never changes anything');
  s.button('Ustoz qilish').click();
  assert.match(s.host.textContent, /Tasdiqlaysizmi\?/); assert.equal(s.calls.length, 2, 'the first press only asks to confirm');
  s.button('Ha, ustoz qilish').click();
  await s.until(() => /endi fizika ustozi/.test(s.host.textContent));
  const assignCall = s.calls[2];
  assert.equal(assignCall.target, commandUrl('assignTeacher'));
  assert.deepEqual(JSON.parse(assignCall.options.body), { univeracademy_id: '0101000041' });
  assert.match(assignCall.options.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/);
  assert.equal(s.calls.length, 4, 'the page reloads the list after the change');
  assert.deepEqual([...s.host.querySelectorAll('li')].map(x => x.textContent), ['Ustoz Sinov · ID 0807896715 · Fizika', 'Nomzod Sinov · ID 0101000041 · Fizika']);
});
test('a student who cannot become a Teacher gets a plain reason and no button', async t => {
  for (const [reason, text] of [['not_student', /allaqachon xodim/], ['incomplete', /tugatmagan/], ['in_group', /guruhdan chiqarish/]]) {
    const s = teacherSetup(t, { find: id => ({ found: true, univeracademy_id: id, name: 'Nomzod Sinov', role: 'student', eligible: false, reason }) });
    await s.until(() => s.button('Topish')); await s.search('0101000041');
    await s.until(() => text.test(s.host.textContent));
    assert(!s.button('Ustoz qilish'));
  }
  const missing = teacherSetup(t, { find: () => ({ found: false }) });
  await missing.until(() => missing.button('Topish')); await missing.search('0101000099');
  await missing.until(() => /Bunday ID topilmadi/.test(missing.host.textContent)); assert(!missing.button('Ustoz qilish'));
  const mismatch = teacherSetup(t, { find: () => ({ found: true, univeracademy_id: '0101000050', name: 'Boshqa', eligible: true, reason: null }) });
  await mismatch.until(() => mismatch.button('Topish')); await mismatch.search('0101000041');
  await mismatch.until(() => /Bunday ID topilmadi/.test(mismatch.host.textContent)); assert(!mismatch.button('Ustoz qilish'));
});
test('a refused assignment shows the reason and changes no list; cancelling sends nothing', async t => {
  const s = teacherSetup(t, { assign: () => ({ __status: 409, error: { code: 'TARGET_IN_GROUP' } }) });
  await s.until(() => s.button('Topish')); await s.search('0101000041');
  await s.until(() => s.button('Ustoz qilish')); s.button('Ustoz qilish').click();
  s.button('Bekor qilish').click(); assert.match(s.host.textContent, /Bekor qilindi/); assert.equal(s.calls.length, 2);
  await s.search('0101000041'); await s.until(() => s.button('Ustoz qilish'));
  s.button('Ustoz qilish').click(); s.button('Ha, ustoz qilish').click();
  await s.until(() => /guruhda/.test(s.host.textContent));
  assert.equal(s.host.querySelectorAll('li').length, 1);
});
test('a lost answer to the assignment is reported as unknown, never as done', async t => {
  const dom = teacherSetup(t, { assign: () => { throw new TypeError('network'); } });
  await dom.until(() => dom.button('Topish')); await dom.search('0101000041');
  await dom.until(() => dom.button('Ustoz qilish')); dom.button('Ustoz qilish').click(); dom.button('Ha, ustoz qilish').click();
  await dom.until(() => /Natija noma/.test(dom.host.textContent));
  assert(!/endi fizika ustozi/.test(dom.host.textContent)); assert(dom.button('Yangilash'));
});
test('a denial on a command closes the page like a denied read', async t => {
  const s = teacherSetup(t, { find: () => ({ __status: 403, error: { code: 'FORBIDDEN' } }) });
  await s.until(() => s.button('Topish')); await s.search('0101000041');
  await s.until(() => /faqat Ega uchun/.test(s.host.textContent));
  assert(!s.host.querySelector('input'));
});
test('the transport only builds the two Owner commands and a valid key', async t => {
  const dom = new JSDOM('<div></div>', { url: ownerOrigin + '/', pretendToBeVisual: true }); context(dom, t);
  const port = createOwnerTransport({ origin: ownerOrigin, expected: identityValue, identity: { current: () => identityValue }, getCurrentClerkToken: async () => 't.k',
    fetch: async () => answerFor(commandUrl('assignTeacher'), {}), signal: new AbortController().signal, onDenied() {} });
  assert.throws(() => port.assignTeacher('0101000041', 'bad key with spaces'));
  assert.throws(() => port.assignTeacher('0101000041', ''));
});


test('the Owner sees count-only overview and attention items, including genuine zeroes', async t => {
  const overview={activeTeachers:3,activeStudents:0,activeGroups:2,openAssignments:1,submittedLast7Days:7,pendingGroups:1,groupsWithoutUpcomingAssignment:0};
  const s=setup(t,{answer:()=>reply({role:'owner',person_id:person,name:'Loyiha egasi',overview,canAssignTeacher:false})});
  await s.until(()=>s.host.querySelector('dl'));
  assert.match(s.host.textContent,/Umumiy holat/);
  assert.deepEqual([...s.host.querySelectorAll('dd')].map(x=>x.textContent),['3','0','2','1','7','1','0']);
  assert.equal(s.calls.length,1);
});
test('invalid overview data never appears and lack of migration never enables teacher assignment', async t => {
  const s=setup(t,{answer:(target,options)=>target===endpoint
    ? reply({role:'owner',person_id:person,name:'Loyiha egasi',overview:{activeTeachers:'unexpected data'},canAssignTeacher:false})
    : answerFor(target,{found:true,univeracademy_id:JSON.parse(options.body).univeracademy_id,name:'Nomzod',eligible:true})});
  await s.until(()=>s.host.querySelector('input'));
  assert.equal(s.host.querySelector('dl'),null);
  const input=s.host.querySelector('input');input.value='0101000041';
  [...s.host.querySelectorAll('button')].find(x=>x.textContent==='Topish').click();
  await s.until(()=>s.host.textContent.includes('Nomzod'));
  assert.match(s.host.textContent,/Ustoz tayinlash hozir mavjud emas/);
  assert.equal([...s.host.querySelectorAll('button')].some(x=>x.textContent==='Ustoz qilish'),false);
  assert.equal(s.calls.length,2);
});
test('changing the cabinet ID clears an earlier appointment confirmation', async t => {
  const s=teacherSetup(t);
  await s.until(()=>s.button('Topish'));await s.search('0101000041');
  await s.until(()=>s.button('Ustoz qilish'));s.button('Ustoz qilish').click();
  const stale=s.button('Ha, ustoz qilish');
  const input=s.host.querySelector('input');input.value='0101000042';input.dispatchEvent(new window.Event('input'));
  assert.equal(s.button('Ha, ustoz qilish'),undefined);
  stale.click();
  assert.equal(s.calls.length,2);
});


test('owner teacher list includes group counts and recent appointment records only', async t => {
  const s=setup(t,{answer:()=>reply({role:'owner',person_id:person,name:'Loyiha egasi',
    teachers:[{name:'Ustoz Sinov',univeracademy_id:'0807896715',subjects:['physics'],activeGroupCount:2}],
    appointmentHistory:[{atMs:1795788000000,actorName:'Ega Sinov',targetName:'Ustoz Sinov'},{atMs:-1,actorName:'Invalid record',targetName:'Invalid record'}]})});
  await s.until(()=>s.host.textContent.includes('Ustoz tayinlash tarixi'));
  assert.match(s.host.textContent,/Faol guruhlar: 2/);assert.match(s.host.textContent,/Ega Sinov: Ustoz Sinov/);
  assert.doesNotMatch(s.host.textContent,/Invalid record/);assert.equal(s.calls.length,1);
});


test('the Owner can read a recorded teacher deletion request without approving it', async t => {
  const s=setup(t,{answer:()=>reply({role:'owner',person_id:person,name:'Loyiha egasi',
    accountRequestHistory:[{atMs:1795788000000,teacherName:'Ustoz Sinov'}]})});
  await s.until(()=>s.host.textContent.includes('Ustoz Sinov'));
  assert.match(s.host.textContent,/faqat ko‘rish uchun/);
  const actions=[...s.host.querySelectorAll('button')].map(x=>x.textContent);
  assert(!actions.some(x=>/tasdiqlash|rad etish/i.test(x)));
  assert.equal(s.calls.length,1);
});

// Exercise the actual Vite entry's DOM module. Only its static CSS/template/URL imports
// and the remote Clerk/HTTP boundary are adapted to run in Node.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';
import { createStaffTransport } from '../../apps/mini-app/teacher-entrance/staff-transport.mjs';

const {JSDOM} = createRequire(new URL('../teacher-local-pilot/tooling/package.json',import.meta.url))('jsdom');
const origin = 'https://ustoz.univeracademy.uz';
const person = crypto.randomUUID();
const identityValue = {userId:'provider-staff',generation:'session-1'};
const success = value => new Response(JSON.stringify({data:value}), {headers:{'content-type':'application/json','cache-control':'no-store'}});
function located(response, url) { Object.defineProperty(response,'url',{value:url}); return response; }
function context(dom,t) {
  for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,Option:dom.window.Option})) {
    const previous = Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
    t.after(() => { if(previous) Object.defineProperty(globalThis,name,previous); else delete globalThis[name]; });
  }
  t.after(() => dom.window.close());
}

test('the teacher can use a new group immediately and the staff browser keeps each request bound to its session', async t => {
  const dom = new JSDOM('<div id="host"></div>',{url:origin+'/',pretendToBeVisual:true});
  context(dom,t);
  const hooks = registerHooks({ resolve(specifier,ctx,next) {
    let value;
    if(specifier.endsWith('?raw')) value = readFileSync(new URL(specifier.split('?')[0],ctx.parentURL),'utf8');
    else if(specifier.includes('?url&no-inline')) value = '/assets/'+specifier.split('/').at(-1).split('?')[0];
    else if(specifier.endsWith('.css')) value = '';
    else return next(specifier,ctx);
    return {url:'data:text/javascript,'+encodeURIComponent('export default '+JSON.stringify(value)),shortCircuit:true};
  }});
  t.after(() => hooks.deregister());
  const {mountAuthenticatedWorkspace} = await import('../../apps/mini-app/teacher-entrance/staff-workspace.mjs');
  const host = document.getElementById('host');
  const el = id => host.querySelector('#'+id);
  const adminButton = () => [...host.querySelectorAll('button')].find(x=>x.textContent==='Admin bo‘limi');
  async function until(check) {
    for(let i=0;i<200;i++) { if(check()) return; await pause(5); }
    assert.fail('View did not settle: '+host.textContent.slice(0,240));
  }
  let identity = identityValue, notify, tokenCount = 0;
  const newId = crypto.randomUUID(), studentId = '0123456789', otherId = '0100000001';
  const directory = [{name:'Birinchi O‘quvchi',univeracademy_id:otherId},{name:'Sinov O‘quvchi',univeracademy_id:studentId}];
  const oldPage = Promise.withResolvers();
  let oldListSignal, unavailable = true;
  const testId = crypto.randomUUID(), telegramUrl = 'https://t.me/UniverTestBot?start=sample';
  const groups = [
    {id:crypto.randomUUID(),name:'8-B',subjectId:'physics',status:'active',members:[]},
    {id:crypto.randomUUID(),name:'Algebra',subjectId:'math',status:'active',members:[]},
  ];
  const newGroup = {id:newId,name:'8-A',subjectId:'physics',status:'active',teacherName:'Ustoz',members:[]};
  const tests = [{id:testId,title:'Kuch',status:'published',subjectId:'physics',duration_seconds:60,questionCount:1}];
  const assignments = [], calls = [], issuedTokens = new Set();
  const user = {current:()=>identity,subscribe(fn){notify=fn;return ()=>{};},async signOut(){identity=null;notify();}};
  const dispose = mountAuthenticatedWorkspace(host,{
    origin,identity:user,
    async getCurrentClerkToken() {
      const token = 'signed.' + (++tokenCount);
      issuedTokens.add('Bearer ' + token);
      return token;
    },
    async fetch(url,options) {
      const path=new URL(url).pathname;
      assert.equal(new URL(url).origin,origin);
      assert(issuedTokens.delete(options.headers.get('authorization')), 'Each call uses a fresh bearer');
      assert.equal(options.credentials,'omit'); assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
      calls.push([path,options]);
      const admin = path.includes('/admin/');
      if (path.endsWith('/dashboard')) return located(success({role:admin?'admin':'teacher',person_id:person,name:'Ustoz',
        groups:admin ? [newGroup] : groups,subjects:[{id:'physics',title:'Fizika'}],tests,results:[],assignments}),url);
      if (path.endsWith('/available-students')) {
        assert(!admin);
        assert.equal(options.method, 'GET');
        assert(!options.headers.has('idempotency-key'));
        if (path.includes(groups[0].id)) {
          oldListSignal = options.signal;
          await oldPage.promise;
          return located(success({students:[{name:'Oldingi guruh',univeracademy_id:'0000000000'}],nextCursor:null}),url);
        }
        assert.equal(path, '/api/v1/teacher/pilot/groups/' + newId + '/available-students');
        if (unavailable) {
          unavailable = false;
          return located(Response.json({error:{code:'SERVICE_UNAVAILABLE'}},{status:503,headers:{'cache-control':'no-store'}}),url);
        }
        const after = new URL(url).searchParams.get('after');
        assert(after === null || after === otherId);
        const remaining = directory.filter(row => !newGroup.members.some(member => member.univeracademy_id === row.univeracademy_id)
          && (after === null || row.univeracademy_id > after));
        return located(success({students:remaining.slice(0,1),nextCursor:remaining.length > 1 ? remaining[0].univeracademy_id : null}),url);
      }
      assert(!admin);
      assert(options.headers.get('idempotency-key'));
      const data = JSON.parse(options.body);
      switch (path.split('/').at(-1)) {
        case 'createGroup':
          assert.deepEqual(data,{name:'8-A',subjectId:'physics'});
          groups.push(newGroup);
          return located(success(newGroup),url);
        case 'addMember':
          assert.equal(data.groupId, newId);
          const member = directory.find(row => row.univeracademy_id === data.univeracademy_id);
          assert(member);
          newGroup.members.push(member);
          return located(success({ok:true}),url);
        case 'createInvite':
          assert.deepEqual(data,{groupId:newId});
          return located(success({telegramUrl}),url);
        case 'sendInvite':
          assert.deepEqual(data,{groupId:newId,univeracademy_id:studentId});
          return located(success({queued:true}),url);
        case 'assignTest':
          assert.deepEqual(data,{testId,groupId:newId});
          assignments.push(data);
          return located(success({id:crypto.randomUUID()}),url);
        default: assert.fail('Unexpected request ' + path);
      }
    },
  });
  t.after(dispose);
  await until(()=>el('identity-name')?.textContent==='Ustoz');
  assert.equal(el('test-subject').value,'physics');
  assert(!host.textContent.includes('Mahalliy'));
  const submit = (id, submitter) => el(id).dispatchEvent(new window.SubmitEvent('submit',{cancelable:true,submitter}));
  const settled = () => !el('main')?.hasAttribute('aria-busy');
  await until(() => oldListSignal && el('available-status').textContent.includes('yuklanmoqda'));
  el('group-name').value='8-A';
  submit('group-form');
  await until(()=>settled() && el('member-group')?.value===newId);
  assert.equal(el('group-status').textContent, 'Faol guruh');
  assert.equal(el('notice').textContent, 'Guruh yaratildi.');
  assert(!el('member-form').hidden && !el('invite-section').hidden);
  assert(oldListSignal.aborted);
  oldPage.resolve();
  await until(() => !el('available-retry').hidden);
  assert.equal(el('available-list').options.length, 0);
  el('available-retry').click();
  await until(() => !el('available-next').hidden);
  assert.equal(el('available-list').options[0].textContent, 'Birinchi O‘quvchi · ' + otherId);
  el('available-next').click();
  await until(() => !el('available-previous').hidden);
  assert.equal(el('available-list').options[0].textContent, 'Sinov O‘quvchi · ' + studentId);
  el('available-previous').click();
  await until(() => !el('available-next').hidden);
  el('available-next').click();
  await until(() => !el('available-previous').hidden);
  assert(el('available-add').disabled);
  el('available-list').value = studentId;
  el('available-list').dispatchEvent(new window.Event('change'));
  assert(!el('available-add').disabled);
  assert(!calls.some(([path]) => path.endsWith('/addMember')));
  submit('available-form');
  await until(() => settled() && el('members').textContent.includes(studentId) && el('available-list').options[0]?.value === otherId);
  assert(el('available-next').hidden && el('available-add').disabled);
  el('student-number').value = otherId;
  submit('member-form');
  await until(() => settled() && el('available-status').textContent.includes('o‘quvchi yo‘q'));
  assert.equal(el('available-list').options.length, 0);
  el('invite-button').click();
  await until(()=>settled() && !el('invite-detail').hidden);
  assert.equal(el('invite-url').value,telegramUrl);
  el('student-number').value = studentId;
  submit('member-form',el('member-form').querySelector('[value="send"]'));
  await until(()=>settled() && el('notice').textContent.includes('navbatiga'));
  host.querySelector('nav a[href="#testlar"]').click();
  assert(!el('testlar').hidden && !el('assign-form').hidden);
  assert.equal(el('assignment-group').value,newId);
  assert(![...el('assignment-group').options].some(option=>option.textContent==='Algebra'));
  submit('assign-form');
  await until(()=>settled() && el('assignment-info').textContent.includes('8-A'));
  assert.deepEqual(calls.filter(([path])=>path.includes('/commands/')).map(([path])=>path.split('/').at(-1)),
    ['createGroup','addMember','addMember','createInvite','sendInvite','assignTest']);
  assert(!calls.some(([path])=>path.includes('/admin/')));

  adminButton().click();
  await until(()=>host.querySelector('li')?.textContent.includes('8-A · Ustoz · Faol guruh'));
  assert(!host.textContent.includes('8-B') && !host.textContent.includes('Tasdiqlash'));
  assert.equal(tokenCount,calls.length);
  identity={...identityValue,generation:'different'};notify();
  assert.equal(host.childNodes.length,0);
});

test('token lookup races never dispatch or render for the replacement identity',async t=>{
  const dom=new JSDOM('',{url:origin});context(dom,t);
  let current=identityValue,release,sent=0;
  const port=createStaffTransport({role:'teacher',origin,expected:identityValue,identity:{current:()=>current},
    getCurrentClerkToken:()=>new Promise(resolve=>{release=resolve;}),fetch:()=>{sent++;},signal:new AbortController().signal,onDenied(){}});
  const operation=port.availableStudents(crypto.randomUUID(),null,new AbortController().signal);
  current={userId:'other-user',generation:'other-session'};release('stale');
  await assert.rejects(operation);assert.equal(sent,0);
});

test('private media uses the same bearer gate and accepts PNG only',async t=>{
  const dom=new JSDOM('',{url:origin});context(dom,t);
  const imageId=crypto.randomUUID();
  let type='image/svg+xml',calls=0;
  const port=createStaffTransport({role:'teacher',origin,expected:identityValue,identity:{current:()=>identityValue},
    getCurrentClerkToken:async()=>'staff-token',signal:new AbortController().signal,onDenied(){},async fetch(url,options){
      calls++;assert.equal(options.headers.get('authorization'),'Bearer staff-token');
      assert.equal(url,origin+'/api/v1/teacher/pilot/media/'+imageId);
      return located(new Response(Uint8Array.from([137,80,78,71]),{headers:{'cache-control':'no-store','content-type':type}}),url);
    }});
  await assert.rejects(port.image(imageId));type='image/png';
  assert.equal((await port.image(imageId)).type,'image/png');assert.equal(calls,2);
});

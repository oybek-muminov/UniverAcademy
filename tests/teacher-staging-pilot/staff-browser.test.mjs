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

async function workspace(t) {
  const hooks = registerHooks({ resolve(specifier,ctx,next) {
    let value;
    if(specifier.endsWith('?raw')) value = readFileSync(new URL(specifier.split('?')[0],ctx.parentURL),'utf8');
    else if(specifier.includes('?url&no-inline')) value = '/assets/'+specifier.split('/').at(-1).split('?')[0];
    else if(specifier.endsWith('.css')) value = '';
    else return next(specifier,ctx);
    return {url:'data:text/javascript,'+encodeURIComponent('export default '+JSON.stringify(value)),shortCircuit:true};
  }});
  t.after(() => hooks.deregister());
  return (await import('../../apps/mini-app/teacher-entrance/staff-workspace.mjs')).mountAuthenticatedWorkspace;
}

test('the teacher can use a new group immediately and the staff browser keeps each request bound to its session', async t => {
  const dom = new JSDOM('<div id="host"></div>',{url:origin+'/',pretendToBeVisual:true});
  context(dom,t);
  const mountAuthenticatedWorkspace = await workspace(t);
  const host = document.getElementById('host');
  const el = id => host.querySelector('#'+id);
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
  const archived = [], assignments = [], calls = [], issuedTokens = new Set();
  let deletionRequested = false;
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
        groups:admin ? [newGroup] : groups,archivedGroups:archived,subjects:[{id:'physics',title:'Fizika'}],tests,results:assignments.map(()=>({attemptId:'a',assignmentId:'b',groupId:newId,title:'Kuch',studentName:'Ali',earned:'1.0',maximum:'1.0',percentage:'100.00'})),assignments,deletionRequested}),url);
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
        case 'removeMember':
          assert.deepEqual(data,{groupId:newId,univeracademy_id:studentId});
          newGroup.members.splice(newGroup.members.findIndex(row => row.univeracademy_id === studentId),1);
          return located(success(newGroup),url);
        case 'requestAccountDeletion':
          assert.deepEqual(data,{});
          deletionRequested = true;
          return located(success({id:person,requested:true}),url);
        case 'deleteGroup':
          assert.deepEqual(data,{groupId:newId});
          groups.splice(groups.indexOf(newGroup),1);
          archived.push({id:newId,name:newGroup.name,status:'archived',subjectId:'physics'});
          return located(success({id:newId,status:'archived',outcome:'archived'}),url);
        case 'deleteTest':
          assert.deepEqual(data,{testId});
          tests.splice(tests.findIndex(row=>row.id===testId),1);
          return located(success({id:testId,outcome:'archived'}),url);
        case 'createInvite':
          assert.deepEqual(data,{groupId:newId});
          return located(success({telegramUrl}),url);
        case 'sendInvite':
          assert.deepEqual(data,{groupId:newId,univeracademy_id:studentId});
          return located(success({queued:true}),url);
        case 'assignTest':
          assert.deepEqual(data,{testId,groupId:newId,startsAt:Date.parse('2095-03-14T10:30:00Z')});
          assignments.push({...data,opensAt:data.startsAt,closesAt:Date.parse('2095-03-14T19:00:00Z')});
          return located(success({id:crypto.randomUUID()}),url);
        default: assert.fail('Unexpected request ' + path);
      }
    },
  });
  t.after(dispose);
  await until(()=>el('identity-name')?.textContent==='Ustoz');
  assert.equal(el('test-subject').value,'physics');
  assert(!host.textContent.includes('Mahalliy'));
  // The cabinet opens on the home page; both the side menu and the phone bottom bar carry the same four sections.
  assert(!el('bosh').hidden && el('guruhlar').hidden);
  assert(el('home-stats').children.length === 5);
  for (const bar of ['side-nav','bottom-nav']) {
    assert.deepEqual([...host.querySelectorAll('.'+bar+' a')].map(a => a.hash), ['#bosh','#guruhlar','#testlar','#natijalar','#profil']);
  }
  host.querySelector('.bottom-nav a[href="#guruhlar"]').click();
  assert(el('bosh').hidden && !el('guruhlar').hidden);
  assert.equal(host.querySelectorAll('nav a[aria-current="page"]').length, 2);
  // Messages float in their own corner, and the two group columns keep members left and unassigned students right.
  assert(el('notice').closest('#toasts') && el('problem').closest('#toasts') && !el('main').contains(el('notice')));
  assert(el('members').closest('.group-side') && !el('members-card').hidden && el('available-students').closest('.group-side'));
  assert(el('invite-section').closest('.group-main'));
  assert(el('members-card').tagName === 'DETAILS' && el('available-students').tagName === 'DETAILS'  && /^[0-9]+$/.test(el('members-count').textContent));
  const submit = (id, submitter) => el(id).dispatchEvent(new window.SubmitEvent('submit',{cancelable:true,submitter}));
  const settled = () => !el('main')?.hasAttribute('aria-busy');
  await until(() => oldListSignal && el('available-status').textContent.includes('yuklanmoqda'));
  el('refresh-groups').click(); el('refresh-groups').click();
  await pause(5);
  assert.equal(calls.filter(([path])=>path.endsWith('/available-students')).length,1);
  el('group-name').value='8-A';
  submit('group-form');
  await until(()=>settled() && el('member-group')?.value===newId);
  assert.equal(el('group-status').textContent, 'Faol guruh');
  assert.equal(el('notice').textContent, 'Guruh yaratildi.');
  await pause(3100);
  assert.equal(el('notice').textContent, '', 'the floating message disappears by itself after three seconds');
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
  // On a computer the two group lists always stay open; the summary does not fold them.
  el('members-card').querySelector('summary').click();
  assert(el('members-card').open && el('available-students').open);
  // Removing a student asks a second time first; cancelling sends nothing.
  assert.equal(el('members').querySelectorAll('.member-remove').length,2);
  el('members').querySelector('.member-remove').click();
  assert.equal(el('members').querySelector('.member-remove.danger').textContent,'Ha, chiqarish');
  [...el('members').querySelectorAll('button')].find(b => b.textContent === 'Bekor').click();
  assert(!calls.some(([path]) => path.endsWith('/removeMember')) && !el('members').querySelector('.danger'));
  el('members').querySelector('.member-remove').click();
  el('members').querySelector('.member-remove.danger').click();
  await until(() => settled() && !el('members').textContent.includes(studentId));
  assert.equal(el('notice').textContent,'O‘quvchi guruhdan chiqarildi.');
  assert.equal(el('members-count').textContent,'1');
  await until(() => [...el('available-list').options].some(option => option.value === studentId));
  host.querySelector('nav a[href="#testlar"]').click();
  assert(!el('testlar').hidden && !el('tests-new').hidden);
  el('tab-new').dispatchEvent(new window.KeyboardEvent('keydown', {key:'ArrowRight', cancelable:true}));
  assert.equal(document.activeElement,el('tab-drafts'));
  assert(!el('tests-drafts').hidden && !el('tests-empty').hidden);
  el('tab-published').click();
  assert(!el('tests-published').hidden && !el('assign-form').hidden);
  assert.equal(el('assignment-group').value,newId);
  assert(![...el('assignment-group').options].some(option=>option.textContent==='Algebra'));
  submit('assign-form');
  assert(el('problem').textContent.includes('vaqtini tanlang'));
  el('assign-form').querySelector('[value=scheduled]').click();
  assert(!el('assignment-start').disabled && el('assignment-start').required);
  el('assignment-start').value = '2020-03-14T15:30';
  submit('assign-form');
  assert(el('problem').textContent.includes('kelajakdagi'));
  assert(!calls.some(([path]) => path.endsWith('/assignTest')));
  el('assignment-start').value = '2095-03-14T15:30';
  submit('assign-form');
  await until(()=>settled() && el('assignment-info').textContent.includes('8-A'));
  assert.match(el('assignment-info').textContent,/15:30.*00:00.*Toshkent vaqti/);
  assert.deepEqual(calls.filter(([path])=>path.includes('/commands/')).map(([path])=>path.split('/').at(-1)),
    ['createGroup','addMember','addMember','createInvite','sendInvite','removeMember','assignTest']);
  assert(!calls.some(([path])=>path.includes('/admin/')));

  assert.equal(host.querySelector('a[href="/admin"]'),null,'an ordinary teacher sees no admin link');
  // Removing a test or a group asks first, and what students already used is archived rather than erased.
  assert.equal(host.querySelector('#workspace-actions button'),null,'the side menu keeps the name only; signing out lives on the profile page');
  el('tab-published').click();
  assert(!el('test-delete').hidden && el('test-delete-confirm').hidden);
  el('test-delete').click();
  assert(!el('test-delete-confirm').hidden && el('test-delete').hidden && /arxivga olinadi/.test(el('test-delete-text').textContent));
  el('test-delete-no').click();
  assert(el('test-delete-confirm').hidden && !el('test-delete').hidden && !calls.some(([path]) => path.endsWith('/deleteTest')));
  el('test-delete').click();
  el('test-delete-yes').click();
  await until(() => settled() && el('notice').textContent === 'Test arxivga olindi, natijalar saqlandi.');
  assert.equal(tests.length,0);
  host.querySelector('.bottom-nav a[href="#guruhlar"]').click();
  assert(!el('group-delete').hidden && el('group-delete-confirm').hidden);
  el('group-delete').click();
  assert(!el('group-delete-confirm').hidden && /saqlanadi/.test(el('group-delete-text').textContent));
  el('group-delete-no').click();
  assert(el('group-delete-confirm').hidden && !calls.some(([path]) => path.endsWith('/deleteGroup')));
  el('group-delete').click();
  el('group-delete-yes').click();
  await until(() => settled() && el('notice').textContent === 'Guruh arxivga olindi, natijalar saqlandi.');
  // The archived group leaves the working list and the home count, but stays in the results list.
  assert(![...el('member-group').options].some(option => option.value === newId));
  assert.equal(el('home-stats').children[0].querySelector('strong').textContent,String(groups.length));
  host.querySelector('.bottom-nav a[href="#natijalar"]').click();
  assert([...el('result-group').options].some(option => option.value === newId && option.textContent.endsWith('(arxiv)')));
  // The profile page shows who the teacher is and asks twice before a deletion request is sent.
  host.querySelector('.bottom-nav a[href="#profil"]').click();
  assert(!el('profil').hidden && el('testlar').hidden);
  assert.equal(el('profile-name').textContent,'Ustoz');
  assert.equal(el('profile-role').textContent,'O‘qituvchi');
  assert.equal(el('profile-subjects').textContent,'Fizika');
  assert.equal(el('delete-request').textContent,'Ega’ga so‘rov yuborish');
  el('delete-request').click();
  assert(!el('delete-confirm').hidden && el('delete-request').hidden);
  el('delete-no').click();
  assert(el('delete-confirm').hidden && !el('delete-request').hidden && !calls.some(([path]) => path.endsWith('/requestAccountDeletion')));
  el('delete-request').click();
  el('delete-yes').click();
  await until(() => settled() && el('delete-status').textContent.includes('yuborilgan'));
  assert(el('delete-request').hidden && el('delete-confirm').hidden);
  assert.equal(el('notice').textContent,'So‘rov Ega’ga yuborildi.');
  assert.equal(tokenCount,calls.length);
  el('profile-signout').click();
  await until(() => identity === null && host.childNodes.length === 0);
  identity={...identityValue,generation:'different'};notify();
  assert.equal(host.childNodes.length,0);
});

test('a delayed image and selected answer stay with their question; the first save binds the canonical draft even if its read must be retried', async t => {
  let dispose;
  t.after(()=>dispose?.());
  const dom = new JSDOM('<!doctype html><div id="host"></div>', {url:origin+'/',pretendToBeVisual:true});
  context(dom,t);
  const mount = await workspace(t);
  const id = crypto.randomUUID(), imageId = crypto.randomUUID(), media = Promise.withResolvers();
  let record, imports = 0, reads = 0, updates = 0, mediaStarted = false;
  const host = document.getElementById('host');
  const el = key => host.querySelector('#'+key);
  const controls = name => [...el('question-fields').children].find(field => field.querySelector('legend').textContent === name);
  const type = (control,text) => { control.value=text; control.dispatchEvent(new window.Event('input')); };
  const ask = key => el(key).dispatchEvent(new window.Event('change'));
  const submit = () => el('editor-form').dispatchEvent(new window.Event('submit',{cancelable:true}));
  async function until(check) {
    for(let i=0;i<200;i++) { if(check()) return; await pause(5); }
    assert.fail('Editor did not settle: '+el('notice')?.textContent+' / '+el('problem')?.textContent);
  }
  dispose = mount(host,{
    origin,identity:{current:()=>identityValue,subscribe:()=>()=>{},signOut:async()=>{}},getCurrentClerkToken:async()=>'test-bearer',
    async fetch(url,options) {
      assert.equal(options.headers.get('authorization'),'Bearer test-bearer');
      const path = new URL(url).pathname;
      const summary = () => ({id,title:record.draft.title,subjectId:'physics',status:'draft',revision:record.revision,
        duration_seconds:record.draft.duration_seconds,questionCount:record.draft.questions.length});
      if(path.endsWith('/dashboard')) return located(success({role:'teacher',person_id:person,name:'Ustoz',groups:[],subjects:[{id:'physics',title:'Fizika'}],
        tests: record ? [summary()] : [], assignments:[],results:[]}),url);
      if(path.endsWith('/media')) {
        mediaStarted = true; await media.promise; return located(success({id:imageId}),url);
      }
      if(path.endsWith('/media/'+imageId)) return located(new Response(Uint8Array.of(137,80,78,71),{
        headers:{'cache-control':'no-store','content-type':'image/png'}}),url);
      const body = JSON.parse(options.body);
      if(path.endsWith('/importTest')) {
        imports++;
        const {subjectId,...draft}=body; assert.equal(subjectId,'physics');
        for(const question of draft.questions) {
          question.id=crypto.randomUUID();
          for(const option of question.options) {
            const canonical=crypto.randomUUID();
            if(option.id===question.correct_option_id) question.correct_option_id=canonical;
            option.id=canonical;
          }
        }
        record={id,revision:2,draft};
        return located(success(summary()),url);
      }
      if(path.endsWith('/readDraft')) {
        assert.deepEqual(body,{testId:id});
        if(++reads===1) throw Error('Fixture connection interrupted after committed import');
        return located(success(record),url);
      }
      assert(path.endsWith('/updateDraft'));
      assert.deepEqual(Object.keys(body).sort(),['draft','expectedRevision','testId']);
      assert.equal(body.testId,id); assert.equal(body.expectedRevision,record.revision);
      assert.deepEqual(body.draft.questions.map(q=>[q.id,q.correct_option_id]),record.draft.questions.map(q=>[q.id,q.correct_option_id]));
      if(++updates===2) return located(Response.json({error:{code:'RESOURCE_REVISION_CONFLICT'}},
        {status:409,headers:{'cache-control':'no-store'}}),url);
      record={id,revision:3,draft:body.draft};
      return located(success(summary()),url);
    }
  });
  await until(()=>el('identity-name')?.textContent==='Ustoz');
  host.querySelector('a[href="#testlar"]').click();
  type(el('editor-title'),'Masofalar');
  function fill(prompt,correct) {
    type(controls('Savol mazmuni').querySelector('textarea'),prompt);
    for(let i=1;i<=4;i++) type(controls(i+'-javob').querySelector('textarea'),prompt+' '+i);
    controls(correct+'-javob').querySelector('input[type=radio]').click();
  }
  fill('Birinchi',3);
  const fields = controls('Savol mazmuni');
  [...fields.querySelectorAll('button')].find(b=>b.textContent==='Formula qo‘shish').click();
  type(controls('Savol mazmuni').querySelector('[data-formula-input]'),'x^2');
  [...controls('Yechim (ixtiyoriy)').querySelectorAll('button')].find(b=>b.textContent==='Matn qo‘shish').click();
  type(controls('Yechim (ixtiyoriy)').querySelector('textarea'),'Birinchi yechim');
  const file = controls('3-javob').querySelector('input[type=file]');
  Object.defineProperty(file,'files',{value:[new File(['PNG'],'diagram.png',{type:'image/png'})]});
  file.dispatchEvent(new window.Event('change'));
  await until(()=>mediaStarted);
  const first = el('editor-question').value;
  el('add-question').click();
  const second = el('editor-question').value;
  assert.notEqual(first,second);
  assert.equal(el('question-fields').querySelector('input:checked, img, [data-formula-input]'),null);
  assert([...el('question-fields').querySelectorAll('textarea')].every(input=>input.value===''));
  assert.equal(controls('Yechim (ixtiyoriy)').querySelector('textarea'),null);
  const secondPrompt = controls('Savol mazmuni').querySelector('textarea');
  fill('Ikkinchi',2);
  media.resolve(); await pause(20);
  assert.equal(secondPrompt,controls('Savol mazmuni').querySelector('textarea'));
  assert.equal(secondPrompt.value,'Ikkinchi');
  assert(controls('2-javob').querySelector('input:checked'));
  assert.equal(el('question-fields').querySelector('img, [data-formula-input]'),null);
  el('editor-question').value=first; ask('editor-question');
  assert.equal(controls('Savol mazmuni').querySelector('[data-formula-input]').value,'x^2');
  assert(controls('3-javob').querySelector('input:checked'));
  assert.equal(controls('Yechim (ixtiyoriy)').querySelector('textarea').value,'Birinchi yechim');
  type(controls('3-javob').querySelector('.block-row input:not([type])'),'Xususiy rasm');
  submit();
  await until(()=>el('save-editor').textContent.includes('qayta ochish') && !el('save-editor').disabled);
  assert.equal(imports,1); assert(el('editor-controls').disabled);
  submit();
  await until(()=>el('save-editor').textContent==='O‘zgarishlarni saqlash' && !el('editor-controls').disabled);
  assert.equal(imports,1);
  assert.equal(controls('3-javob').querySelector('input:checked').value,record.draft.questions[0].correct_option_id);
  assert.equal(controls('3-javob').querySelector('.block-row input:not([type])').value,'Xususiy rasm');
  type(el('editor-title'),'Masofa testi'); submit();
  await until(()=>updates===1 && !el('editor-controls').disabled);
  type(el('editor-title'),'Saqlanmagan tahrir'); submit();
  await until(()=>el('problem').textContent.includes('boshqa oynada'));
  assert.equal(el('editor-title').value,'Saqlanmagan tahrir');
  assert.equal(record.draft.title,'Masofa testi');
  assert.equal(imports,1); assert.equal(reads,2);
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

test('focus and navigation share one pending dashboard, and returning to a hidden cabinet keeps the page and rechecks permission once in the background', async t => {
  const dom = new JSDOM('<div id="host"></div>',{url:origin+'/',pretendToBeVisual:true});
  context(dom,t);
  const mount = await workspace(t), host = document.getElementById('host');
  const dashboard = {role:'teacher',person_id:person,name:'Ustoz',groups:[],subjects:[],tests:[],assignments:[],results:[]};
  const reads = [];
  const until = async predicate => {
    for (let i=0; i<200; i++) { if (predicate()) return; await pause(5); }
    assert.fail('The pending dashboard did not settle');
  };
  const dispose = mount(host,{origin,identity:{current:()=>identityValue,subscribe:()=>()=>{}},
    getCurrentClerkToken:async ()=>'signed',
    fetch(url) {
      assert(new URL(url).pathname.endsWith('/teacher/pilot/dashboard'));
      const response = Promise.withResolvers(); reads.push(response);
      return response.promise.then(value => located(value,url));
    }});
  t.after(dispose);
  await until(()=>reads.length === 1);
  reads[0].resolve(success(dashboard));
  await until(()=>host.querySelector('#identity-name')?.textContent==='Ustoz');
  assert.equal(host.querySelector('#editor-form'),null);
  window.dispatchEvent(new window.Event('focus'));
  for (const section of ['testlar','natijalar','guruhlar']) host.querySelector('a[href="#'+section+'"]').click();
  await until(()=>reads.length >= 2);
  assert.equal(reads.length,2);
  assert(host.querySelector('#editor-form'));
  reads[1].resolve(success({...dashboard,name:'Yangilangan'}));
  await until(()=>host.querySelector('#identity-name').textContent==='Yangilangan');
  window.dispatchEvent(new window.Event('focus'));
  await until(()=>reads.length === 3);
  // A pending response from before suspension must never repaint the new session.
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
  document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(host.querySelector('#identity-name').textContent,'Yangilangan'); // leaving the tab never blanks the page
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
  document.dispatchEvent(new window.Event('visibilitychange'));
  await until(()=>reads.length === 4);
  assert(host.querySelector('#identity-name')); // still on screen while the check runs
  window.dispatchEvent(new window.PageTransitionEvent('pageshow',{persisted:true}));
  await pause(5);
  assert.equal(reads.length,4);
  reads[3].resolve(new Response(null,{status:403,headers:{'cache-control':'no-store'}}));
  await until(()=>host.textContent.includes('ruxsat berilmagan'));
  reads[2].resolve(success(dashboard));
  await pause(5);
  assert.equal(host.querySelector('#identity-name'),null);
});

test('preview fetches private images as they approach the dialog and aborts deferred work at close', async t => {
  const dom = new JSDOM('<dialog open><div id="body"></div></dialog>',{url:origin+'/'});
  context(dom,t);
  const {showStudentView} = await import('../../apps/teacher-web/local-pilot/rich-editor.mjs');
  const observed = new Set(), loads = [], signal = new AbortController();
  let observe;
  window.IntersectionObserver = class {
    constructor(callback,{root}) { observe=callback; assert.equal(root.tagName,'DIALOG'); }
    observe(slot) { observed.add(slot); }
    unobserve(slot) { observed.delete(slot); }
    disconnect() { observed.clear(); }
  };
  const box = document.querySelector('#body');
  const questions = Array.from({length:200},(_,i)=>({prompt_blocks:[
    {type:'text',markdown:'Savol '+i},{type:'image',asset_id:String(i),alt:'Rasm '+i}],options:['bir','ikki','uch','to‘rt']}));
  showStudentView(box,{questions},(parent,blocks,scope)=>{
    assert.equal(scope,signal.signal);
    for (const block of blocks) {
      if (block.type==='image') loads.push(block.asset_id);
      else parent.append(document.createTextNode(block.markdown));
    }
  },signal.signal);
  assert.equal(box.querySelectorAll('input').length,800);
  assert(box.textContent.includes('Savol 199') && box.textContent.includes('Rasm 199'));
  assert.equal(observed.size,200);
  assert.deepEqual(loads,[]);
  const [first,second,third] = observed;
  const shown = target=>({isIntersecting:true,target});
  observe([shown(first),shown(second),shown(first)]);
  assert.deepEqual(loads,['0','1']);
  signal.abort(); observe([shown(third)]);
  assert.equal(observed.size,0);
  assert.deepEqual(loads,['0','1']);
});

test('formula input updates the saved source on every edit and typesets only the last value of a burst', async t => {
  const dom = new JSDOM('<div id="formula"></div>',{url:origin+'/'});
  context(dom,t);
  const {mountVisualFormula} = await import('../../apps/teacher-web/local-pilot/visual-formula.mjs');
  const changes=[], typeset=[];
  const box=document.querySelector('#formula');
  mountVisualFormula(box,{onChange:value=>changes.push(value),renderBlocks:(_,blocks)=>typeset.push(blocks[0].latex)});
  const field=box.querySelector('textarea');
  for (const input of ['x','x^','x^2']) { field.value=input; field.dispatchEvent(new window.Event('input')); }
  assert.deepEqual(changes,['x','x^','x^2']);
  await pause(120);
  assert.deepEqual(typeset,['x^2']);
  field.value='x^3'; field.dispatchEvent(new window.Event('input')); box.remove();
  await pause(120);
  assert.deepEqual(typeset,['x^2']);
});

for (const scenario of [
  {path:'/admin',role:'admin',heading:'Admin kabineti'},
  {path:'/',role:'teacher',denied:403},
  {path:'/admin',role:'admin',denied:403},
  {path:'/admin',role:'admin',replyRole:'owner'},
]) test('staff destination '+scenario.path+' accepts only its authorized dashboard ('+(scenario.denied??scenario.replyRole??'approved')+')', async t => {
  const {path,role,denied,replyRole,heading}=scenario;
  const dom=new JSDOM('<div id="host"></div>',{url:origin+path,pretendToBeVisual:true});
  context(dom,t);
  const mount=await workspace(t), host=document.getElementById('host'), reads=[];
  let identity=identityValue, notify;
  const dispose=mount(host,{origin,identity:{current:()=>identity,subscribe(fn){notify=fn;return ()=>{};}},
    getCurrentClerkToken:async ()=>'current-token',fetch:async (url,opts)=>{
      reads.push(url);
      assert.equal(opts.method,'GET');
      assert.equal(opts.headers.get('authorization'),'Bearer current-token');
      if(denied) return located(new Response(null,{status:denied,headers:{'cache-control':'no-store'}}),url);
      const data={role:replyRole??role,person_id:person,name:'Ega <b>Ism</b>'};
      if(data.role==='admin') data.groups=[{name:'8-A',teacherName:'Ustoz',status:'active'}];
      return located(success(data),url);
    }});
  t.after(dispose);
  const expected = heading ?? (denied === 401 ? 'Kirish sessiyasini tekshiring' : 'ruxsat berilmagan');
  for(let i=0;i<200&&!host.textContent.includes(expected);i++) await pause(5);
  assert(host.textContent.includes(expected),host.textContent);
  assert.deepEqual(reads,[origin+'/api/v1/'+role+'/pilot/dashboard']);
  if(heading) {
    assert.equal(host.querySelector('h1').textContent,heading);
    assert.equal(host.querySelector('li').textContent,'8-A · Ustoz · Faol guruh');
    assert.equal(host.querySelector('a').href,origin+'/');
    identity={...identityValue,generation:'another-session'};notify();
    assert.equal(host.childNodes.length,0);
  } else {
    assert(!host.querySelector('h1,li') && !host.textContent.includes('Ega <b>Ism</b>'));
    assert([...host.querySelectorAll('button')].some(b=>b.textContent==='Chiqish'));
  }
});

test('staff entrance accepts two canonical URLs (Teacher and Admin) and never treats role or session hints as a destination', async () => {
  const {staffDestination}=await import('../../apps/mini-app/teacher-entrance/staff-route.mjs');
  for(const [path,role] of [['/','teacher'],['/admin','admin']]) assert.equal(staffDestination(new URL(origin+path)).role,role);
  // The Owner has its own site (ega.univeracademy.uz); the Ustoz site has no Owner destination at all.
  for(const url of [origin+'/student',origin+'/admin/',origin+'/?role=owner',origin+'/owner',origin+'/owner#session',origin+'/teacher','https://example.test/owner','https://ega.univeracademy.uz/']) {
    assert.equal(staffDestination(new URL(url)),null);
  }
});

test('the Ustoz transport has no Owner role: the Owner is served only by its own site', async t => {
  const dom=new JSDOM('',{url:origin+'/'});context(dom,t);
  let calls=0;
  assert.throws(()=>createStaffTransport({origin,role:'owner',expected:identityValue,identity:{current:()=>identityValue},
    signal:new AbortController().signal,getCurrentClerkToken:async ()=>'token',fetch:()=>{calls++;}}));
  assert.equal(calls,0);
});

test('the group lists fold only on a phone and stay open on a computer', async t => {
  const dom = new JSDOM('<div id="host"></div>',{url:origin+'/',pretendToBeVisual:true});
  const listeners = new Set();
  const media = {matches:true,addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn)};
  dom.window.matchMedia = () => media;
  context(dom,t);
  const mountAuthenticatedWorkspace = await workspace(t);
  const host = document.getElementById('host');
  const el = id => host.querySelector('#'+id);
  let identity = identityValue, notify;
  const group = {id:crypto.randomUUID(),name:'8-B',subjectId:'physics',status:'active',members:[{name:'Sinov O‘quvchi',univeracademy_id:'0123456789'}]};
  const dispose = mountAuthenticatedWorkspace(host,{
    origin,identity:{current:()=>identity,subscribe(fn){notify=fn;return ()=>{};},async signOut(){identity=null;notify();}},
    async getCurrentClerkToken() { return 'signed.1'; },
    async fetch(url) {
      const path = new URL(url).pathname;
      if (path.endsWith('/available-students')) return located(success({students:[],nextCursor:null}),url);
      return located(success({role:'teacher',person_id:person,name:'Ustoz',groups:[group],subjects:[{id:'physics',title:'Fizika'}],tests:[],results:[],assignments:[]}),url);
    },
  });
  const until = async check => { for(let i=0;i<200;i++) { if(check()) return; await pause(5); } assert.fail('View did not settle'); };
  await until(() => el('identity-name')?.textContent === 'Ustoz');
  host.querySelector('nav a[href="#guruhlar"]').click();
  await until(() => !el('members-card').hidden);
  assert(!el('members-card').open && !el('available-students').open, 'on a phone both lists start folded');
  el('members-card').querySelector('summary').click();
  assert(el('members-card').open, 'on a phone a tap opens a list');
  el('members-card').open = false;
  media.matches = false;
  for (const listener of listeners) listener();
  assert(el('members-card').open && el('available-students').open, 'a computer shows both lists open');
  el('members-card').querySelector('summary').click();
  assert(el('members-card').open, 'on a computer the lists cannot be folded');
  dispose();
});

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

test('staff browser binds every operation to the latest bearer and removes the cabinet on session change', async t => {
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
  const groups = [], calls = [];
  const user = {current:()=>identity,subscribe(fn){notify=fn;return ()=>{};},async signOut(){identity=null;notify();}};
  const dispose = mountAuthenticatedWorkspace(host,{
    origin,identity:user,
    async getCurrentClerkToken() { return 'signed.'+(++tokenCount); },
    async fetch(url,options) {
      const path=new URL(url).pathname;
      assert.equal(new URL(url).origin,origin); assert.equal(options.headers.get('authorization'),'Bearer signed.'+tokenCount);
      assert.equal(options.credentials,'omit'); assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
      calls.push([path,options]);
      const admin = path.includes('/admin/');
      if(path.endsWith('/dashboard')) return located(success({role:admin?'admin':'teacher',person_id:person,name:'Ustoz',
        groups:structuredClone(groups),subjects:[{id:'physics',title:'Fizika'}],tests:[],results:[],assignments:[]}),url);
      if(path.endsWith('/createGroup')) {
        assert(options.headers.get('idempotency-key'));
        const data=JSON.parse(options.body);
        assert.deepEqual(data,{name:'8-A',subjectId:'physics'});
        groups.push({id:crypto.randomUUID(),name:data.name,subjectId:data.subjectId,status:'pending',teacherName:'Ustoz',members:[]});
        return located(success(groups[0]),url);
      }
      assert(path.endsWith('/approveGroup'));assert(admin);assert(options.headers.get('idempotency-key'));
      assert.deepEqual(JSON.parse(options.body),{groupId:groups[0].id});
      groups[0].status='active';
      return located(success(groups[0]),url);
    },
  });
  t.after(dispose);
  await until(()=>el('identity-name')?.textContent==='Ustoz');
  assert.equal(el('test-subject').value,'physics');
  assert(!host.textContent.includes('Mahalliy'));
  el('group-name').value='8-A';
  el('group-form').dispatchEvent(new window.Event('submit',{cancelable:true}));
  await until(()=>el('group-status')?.textContent.includes('Admin'));
  assert(el('member-form').hidden);
  adminButton().click();
  await until(()=>[...host.querySelectorAll('button')].some(x=>x.textContent==='Tasdiqlash'));
  [...host.querySelectorAll('button')].find(x=>x.textContent==='Tasdiqlash').click();
  await until(()=>host.textContent.includes('Tasdiq kutayotgan guruh yo‘q.'));
  assert.equal(tokenCount,calls.length);assert.equal(calls.length,6); // teacher read, request, re-read, admin read, approve, re-read
  identity={...identityValue,generation:'different'};notify();
  assert.equal(host.childNodes.length,0);
});

test('token lookup races never dispatch or render for the replacement identity',async t=>{
  const dom=new JSDOM('',{url:origin});context(dom,t);
  let current=identityValue,release,sent=0;
  const port=createStaffTransport({role:'teacher',origin,expected:identityValue,identity:{current:()=>current},
    getCurrentClerkToken:()=>new Promise(resolve=>{release=resolve;}),fetch:()=>{sent++;},signal:new AbortController().signal,onDenied(){}});
  const operation=port.request('dashboard');
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

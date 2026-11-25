// Switching windows must never blank the teacher cabinet, and a test being typed must survive in the browser.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';
import { browserStorage, createDraftStore } from '../../apps/teacher-web/local-pilot/draft-autosave.mjs';

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
const block = markdown => [{type:'text',markdown}];
const question = (prompt = '') => ({
  id:'q1', prompt_blocks:block(prompt), explanation_blocks:[], correct_option_id:'',
  options:['a','b','c','d'].map(id => ({id, blocks:block('')})),
});
const snapshot = (title, prompt = '') => ({v:1, savedAt:Date.now(), title, durationText:'0.5', originalSeconds:1800,
  metadata:{}, targetRevision:null, questions:[question(prompt)]});

test('browser copies belong to one teacher, expire after 14 days, ignore damaged data and refuse writes after wipe', () => {
  const data = new Map();
  const storage = {getItem:k=>data.get(k) ?? null, setItem:(k,v)=>void data.set(k,v), removeItem:k=>void data.delete(k),
    key:i=>[...data.keys()][i] ?? null, get length() { return data.size; }};
  let time = 1_000_000_000_000;
  const mine = createDraftStore({storage, owner:person, now:()=>time});
  const other = createDraftStore({storage, owner:crypto.randomUUID(), now:()=>time});
  assert(mine.write('new', snapshot('Fizika','Tezlik nima?')));
  assert.equal(mine.read('new').title,'Fizika');
  assert.equal(other.read('new'),null);
  assert.equal(other.hasAny(),false); assert.equal(mine.hasAny(),true);
  // An empty form is not worth offering back.
  mine.write('empty', snapshot('')); assert.equal(mine.read('empty').title,''); mine.remove('new');
  assert.equal(mine.hasAny(),false);
  mine.write('new', snapshot('Fizika'));
  const key = mine.key('new');
  data.set(mine.key('broken'),'{not json'); assert.equal(mine.read('broken'),null); assert.equal(data.has(mine.key('broken')),false);
  data.set(mine.key('shape'),JSON.stringify({v:1,savedAt:time,title:5})); assert.equal(mine.read('shape'),null);
  time += 14 * 24 * 60 * 60 * 1000 + 1;
  assert.equal(mine.read('new'),null); assert.equal(data.has(key),false);
  time -= 5; mine.write('new', snapshot('Yangi')); assert.equal(mine.hasAny(),true);
  mine.wipe(); assert.equal(data.size,0);
  assert.equal(mine.write('new', snapshot('Kech')),false); assert.equal(data.size,0);
  assert.throws(() => mine.key('../x'));
  // Blocked storage or a missing person id degrade to "not available" instead of throwing.
  assert.equal(createDraftStore({storage:null, owner:person}).available,false);
  assert.equal(createDraftStore({storage, owner:'not-an-id'}).available,false);
  const full = {...storage, setItem() { throw new Error('QuotaExceededError'); }};
  assert.equal(createDraftStore({storage:full, owner:person}).write('new', snapshot('x')),false);
  assert.equal(browserStorage({get localStorage() { throw new Error('blocked'); }}),null);
});

async function open(t, {dom, fetchState, confirms = [], signOuts = []}) {
  const mount = await workspace(t);
  const host = document.getElementById('host');
  host.replaceChildren();
  const reads = {dashboard:0};
  const unmount = mount(host, {
    origin, identity:{current:()=>identityValue, subscribe:()=>()=>{}, signOut:async()=>void signOuts.push(1)},
    getCurrentClerkToken:async()=>'test-bearer',
    async fetch(url) {
      const path = new URL(url).pathname;
      assert(path.endsWith('/dashboard'), path);
      reads.dashboard++;
      if(fetchState.fail) throw new Error('network down');
      return located(success({role:'teacher',person_id:person,name:'Ustoz',groups:[],subjects:[{id:'physics',title:'Fizika'}],tests:[],assignments:[],results:[]}),url);
    }
  });
  let closed = false;
  const dispose = () => { if (!closed) { closed = true; unmount(); } };
  const el = id => host.querySelector('#'+id);
  const until = async (check, why = '') => {
    for(let i=0;i<300;i++) { if(check()) return; await pause(5); }
    assert.fail('Did not settle ' + why);
  };
  await until(()=>el('identity-name')?.textContent==='Ustoz', 'dashboard');
  host.querySelector('a[href="#testlar"]').click();
  return {host, el, dispose, reads, until, confirms};
}
const type = (control, text) => { control.value = text; control.dispatchEvent(new window.Event('input')); };
const visibility = state => {
  Object.defineProperty(document,'visibilityState',{configurable:true,value:state});
  document.dispatchEvent(new window.Event('visibilitychange'));
};
const copies = () => Object.keys(window.localStorage).filter(name => name.startsWith('ua-teacher-draft:v1:'));

test('leaving the tab keeps the page and typing, checks permission quietly, and saves a browser copy about once a second', async t => {
  const dom = new JSDOM('<!doctype html><div id="host"></div>', {url:origin+'/',pretendToBeVisual:true});
  context(dom,t);
  const fetchState = {fail:false};
  const page = await open(t, {dom, fetchState});
  const {host, el, until, reads} = page;
  const prompt = () => [...el('question-fields').children].find(f => f.querySelector('legend').textContent === 'Savol mazmuni').querySelector('textarea');
  let writes = 0;
  const setItem = dom.window.Storage.prototype.setItem;
  dom.window.Storage.prototype.setItem = function(...args) { writes++; return setItem.apply(this,args); };
  type(el('editor-title'),'Fizika 7-sinf');
  type(prompt(),'Tezlik nima?');
  assert.match(el('autosave-status').textContent,/Saqlanmoqda/);
  for(let i=0;i<5;i++) { type(prompt(),'Tezlik nima? '+i); await pause(40); }
  assert.equal(writes,0); // still within the first second
  await until(()=>copies().length === 1, 'first copy');
  await pause(30);
  assert.equal(writes,1); // a burst of typing is one write
  assert.match(el('autosave-status').textContent,/Brauzerda saqlandi/);
  const stored = JSON.parse(window.localStorage.getItem(copies()[0]));
  assert.equal(stored.title,'Fizika 7-sinf'); assert.equal(stored.questions[0].prompt_blocks[0].markdown,'Tezlik nima? 4');
  assert.match(copies()[0], new RegExp(person));
  assert(!JSON.stringify(stored).includes('test-bearer'));

  // Switch window and come back: nothing is blanked, only a quiet check runs.
  const before = reads.dashboard;
  visibility('hidden');
  assert.equal(el('editor-title').value,'Fizika 7-sinf');
  visibility('visible');
  assert.equal(el('editor-title').value,'Fizika 7-sinf');
  await until(()=>reads.dashboard === before + 1, 'quiet check');
  await pause(20);
  assert.equal(host.querySelector('.session-note'),null);
  assert.equal(prompt().value,'Tezlik nima? 4');

  // A failed look-up (connection lost) keeps the page and says the work is safe.
  fetchState.fail = true;
  visibility('hidden'); visibility('visible');
  await until(()=>host.querySelector('.session-note')?.textContent.includes('Yozganlaringiz saqlangan'), 'warning');
  assert.equal(el('editor-title').value,'Fizika 7-sinf');
  fetchState.fail = false;
  [...host.querySelectorAll('.session-note button')].find(b => b.textContent === 'Qayta tekshirish').click();
  await until(()=>host.querySelector('.session-note') === null, 'warning removed');
  assert.equal(prompt().value,'Tezlik nima? 4');
  page.dispose();
});

test('a closed or crashed page offers its browser copy back; the teacher can continue or discard it', async t => {
  const dom = new JSDOM('<!doctype html><div id="host"></div>', {url:origin+'/',pretendToBeVisual:true});
  context(dom,t);
  const fetchState = {fail:false};
  let page = await open(t, {dom, fetchState});
  type(page.el('editor-title'),'Kuchlar');
  // Closing the cabinet inside the first second must still keep what was typed.
  page.dispose();
  assert.equal(copies().length,1);

  page = await open(t, {dom, fetchState});
  assert.equal(page.el('restore-banner').hidden,false);
  assert.match(page.el('restore-banner').textContent,/Davom ettirasizmi/);
  assert.equal(page.el('editor-title').value,'');
  type(page.el('editor-title'),'Yangi urinish'); // the copy is not overwritten while the choice is open
  await pause(1100);
  assert.equal(JSON.parse(window.localStorage.getItem(copies()[0])).title,'Kuchlar');
  type(page.el('editor-title'),'');
  [...page.el('restore-banner').querySelectorAll('button')].find(b => b.textContent === 'Davom ettirish').click();
  assert.equal(page.el('editor-title').value,'Kuchlar');
  assert.equal(page.el('restore-banner').hidden,true);
  assert.equal(page.el('save-editor').disabled,false);

  page.dispose();
  page = await open(t, {dom, fetchState});
  assert.equal(page.el('restore-banner').hidden,false);
  [...page.el('restore-banner').querySelectorAll('button')].find(b => b.textContent === 'O‘chirib tashlash').click();
  assert.equal(copies().length,0);
  assert.equal(page.el('restore-banner').hidden,true);
  page.dispose();
});

test('another window editing the same test is reported, and Chiqish asks before keeping or erasing browser copies', async t => {
  const dom = new JSDOM('<!doctype html><div id="host"></div>', {url:origin+'/',pretendToBeVisual:true});
  context(dom,t);
  const asked = [], signOuts = [];
  window.confirm = message => { asked.push(message); return asked.length === 1 ? false : true; };
  const fetchState = {fail:false};
  let page = await open(t, {dom, fetchState, signOuts});
  type(page.el('editor-title'),'Umumiy kompyuter');
  await pause(1100);
  const name = copies()[0];
  window.dispatchEvent(new window.StorageEvent('storage',{key:name,newValue:'{}'}));
  assert.match(page.el('autosave-status').textContent,/boshqa oynada/);

  const leave = () => [...page.host.querySelectorAll('#workspace-actions button')].find(b => b.textContent === 'Chiqish').click();
  type(page.el('editor-title'),'Umumiy kompyuter 2');
  leave(); // keep copies
  await page.until(()=>signOuts.length === 1, 'sign out');
  assert.equal(asked.length,1); assert.match(asked[0],/o‘chirib chiqish/);
  assert.equal(JSON.parse(window.localStorage.getItem(copies()[0])).title,'Umumiy kompyuter 2'); // the last second was flushed too

  page = await open(t, {dom, fetchState, signOuts});
  leave(); // erase copies
  await page.until(()=>signOuts.length === 2, 'second sign out');
  assert.equal(asked.length,2);
  assert.equal(copies().length,0);
  page.dispose();
});

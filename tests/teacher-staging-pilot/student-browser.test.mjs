import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {createStagingStudentPort} from '../../apps/mini-app/src/staging-student-port.ts';

const {JSDOM} = createRequire(new URL('../teacher-local-pilot/tooling/package.json',import.meta.url))('jsdom');
const ts = createRequire(new URL('../../package.json',import.meta.url))('typescript');
const mini = createRequire(new URL('../../apps/mini-app/package.json',import.meta.url));

test('normal ready StudentApp accepts a scoped invitation and saves and submits a rich group test',async t=>{
  const token='grp_'+'x'.repeat(32), person='person-one';
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://mini.example.org/?invite='+token});
  let mountedRoot;
  // JSDOM implements dialog markup but omits the native close method.
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  const originals=new Map();
  for(const name of ['window','document','location','history','navigator','HTMLElement','MutationObserver']){
    originals.set(name,Object.getOwnPropertyDescriptor(globalThis,name));
    Object.defineProperty(globalThis,name,{configurable:true,value:name==='window'?dom.window:dom.window[name]});
  }
  const hooks=registerHooks({load(url,context,next){
    if(url.endsWith('.css'))return {format:'module',source:'export {};',shortCircuit:true};
    if(url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{
      compilerOptions:{jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}
    }).outputText,shortCircuit:true};
    return next(url,context);
  }});
  t.after(async()=>{mountedRoot?.unmount();await delay(20);hooks.deregister();dom.window.close();for(const [name,value] of originals){if(value)Object.defineProperty(globalThis,name,value);else delete globalThis[name];}});
  const {createElement}=mini('react'),{createRoot}=mini('react-dom/client');
  const {StudentApp}=await import('../../apps/mini-app/src/student-app.tsx');
  const {StudentFlow}=await import('../../apps/mini-app/src/flow.ts');
  const group={id:'g',name:'Fizika'}, score={title:'Harakat',attemptId:'a',earned:'1.0',maximum:'1.0',percentage:'100.00'};
  const data={role:'student',person_id:person,univeracademy_id:'0123456789',name:'Ali',group:null,assignments:[],results:[]};
  const testAttempt={id:'a',status:'in_progress',deadlineAt:new Date(Date.now()+60000).toISOString(),answers:[],questions:[{
    id:'q',prompt_blocks:[{type:'text',markdown:'Tezlik?'},{type:'formula',latex:'v=s/t',display:'inline'}],
    options:[{id:'y',blocks:[{type:'text',markdown:'5 m/s'}]}],
  },{id:'q2',prompt_blocks:[{type:'text',markdown:'Ikkinchi savol'}],options:[{id:'z',blocks:[{type:'text',markdown:'Soniyalar'}]}]}]};
  const seen=[];
  const port=createStagingStudentPort({baseUrl:'https://api.example.org/api/v1',person,current:()=>person,access:fn=>fn('account-proof-in-memory'),
    fetcher: async req=>{
      const path=new URL(req.url).pathname.split('/').at(-1);seen.push(path);assert.equal(req.headers.get('authorization'),'Bearer account-proof-in-memory');
      if(path==='dashboard')return Response.json({data});
      const body=await req.json();assert(req.headers.get('Idempotency-Key'));
      if(path==='acceptInvite'){assert.deepEqual(body,{token});data.group=group;data.assignments=[{id:'assignment',title:'Harakat',attemptId:null,status:'available'}];return Response.json({data:group});}
      if(path==='startAttempt'){data.assignments[0].status='in_progress';data.assignments[0].attemptId='a';return Response.json({data:testAttempt});}
      if(path==='resumeAttempt')return Response.json({data:testAttempt});
      if(path==='saveAnswer'){assert.deepEqual(body,{attemptId:'a',questionId:'q',optionId:'y',expectedRevision:0});const row={questionId:'q',optionId:'y',revision:1};testAttempt.answers=[row];return Response.json({data:row});}
      assert.equal(path,'submitAttempt');data.assignments[0].status='submitted';data.results=[score];return Response.json({data:score});
    }});
  const flow=new StudentFlow({stagingPilot:expected=>{assert.equal(expected,person);return port}});
  flow.patch({screen:'exams',student:{person,displayId:'0123456789',firstName:'Ali',lastName:'S',registrationComplete:true}});
  const root=createRoot(document.querySelector('#root'));
  mountedRoot=root;
  root.render(createElement(StudentApp,{studentFlow:flow,mode:'telegram',stagingPilot:true}));
  async function until(read){for(let i=0;i<250;i++){const found=read();if(found)return found;await delay(10);}throw Error('Student DOM timeout: '+document.body.textContent);}
  const button=label=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent===label&&!b.disabled);
  const click=async label=>(await until(()=>button(label))).click();
  await click('Taklifni qabul qilish');await click('Testni boshlash');
  assert(!seen.includes('startAttempt'));await click('Ortga');await click('Testni boshlash');await click('Ha, boshlash');
  await until(()=>document.querySelector('math'));assert(!location.search.includes('invite'));
  (await until(()=>document.querySelector('input[type=radio]'))).click();
  await until(()=>document.body.textContent.includes('1-savolning javobi saqlandi.'));
  assert.equal(document.querySelectorAll('fieldset').length,1);
  assert.equal(document.querySelector('[aria-label="1-savol, javob tasdiqlangan"]').getAttribute('aria-current'),'step');
  await click('Keyingi →');await until(()=>document.body.textContent.includes('Ikkinchi savol'));
  assert(!document.querySelector('math'));assert(document.querySelector('[aria-label="2-savol, javobsiz"]'));
  document.querySelector('[aria-label="1-savol, javob tasdiqlangan"]').click();await until(()=>document.querySelector('input:checked'));
  await click('Saqlangan javoblarni yangilash');await until(()=>document.querySelector('input:checked'));
  await click('Testni yakunlash');assert(!seen.includes('submitAttempt'));await click('Testga qaytish');assert(!seen.includes('submitAttempt'));await click('Testni yakunlash');await click('Ha, javoblarni yuborish');
  await until(()=>document.body.textContent.includes('100.00%'));assert(seen.includes('resumeAttempt'));
  assert(!document.body.textContent.includes('Sinov hisobiga'));
});

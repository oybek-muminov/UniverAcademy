import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {createStagingStudentPort} from '../../apps/mini-app/src/staging-student-port.ts';

// Guruh testi ekrani: serverga tayangan soat, aloqa uzilganda javob berishning davom etishi,
// topshirgandan keyin natijaning yo'qolmasligi, ruxsat yo'qolganda haqiqiy holatning qayta o'qilishi.
// Haqiqiy ekran (jsdom) va soxta server; tashqi tarmoq yo'q.
const {JSDOM} = createRequire(new URL('../teacher-local-pilot/tooling/package.json',import.meta.url))('jsdom');
const ts = createRequire(new URL('../../package.json',import.meta.url))('typescript');
const mini = createRequire(new URL('../../apps/mini-app/package.json',import.meta.url));

const person='person-one', group={id:'g',name:'Fizika',status:'active'}, score={title:'Harakat',attemptId:'a',earned:'1.0',maximum:'1.0',percentage:'100.00'};
const names=['window','document','location','history','navigator','HTMLElement','MutationObserver'];
const originals=new Map();
let dom,hooks,StudentApp,StudentFlow,StudentFailure,createElement,createRoot;
before(async()=>{
  dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://mini.example.org/'});
  dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  for(const name of names){originals.set(name,Object.getOwnPropertyDescriptor(globalThis,name));
    Object.defineProperty(globalThis,name,{configurable:true,value:name==='window'?dom.window:dom.window[name]});}
  hooks=registerHooks({load(url,context,next){
    if(url.endsWith('.css'))return {format:'module',source:'export {};',shortCircuit:true};
    if(url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{
      compilerOptions:{jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText,shortCircuit:true};
    return next(url,context);
  }});
  ({createElement}=mini('react'));({createRoot}=mini('react-dom/client'));
  ({StudentApp}=await import('../../apps/mini-app/src/student-app.tsx'));
  ({StudentFlow}=await import('../../apps/mini-app/src/flow.ts'));
  ({StudentFailure}=await import('../../apps/mini-app/src/transport.ts'));
});
after(async()=>{await delay(80);hooks.deregister();dom.window.close();for(const [name,value] of originals){if(value)Object.defineProperty(globalThis,name,value);else delete globalThis[name];}});

const text=()=>document.body.textContent;
async function until(read,ms=6000){for(let i=0;i<ms/10;i++){const found=read();if(found)return found;await delay(10);}throw Error('DOM timeout: '+text());}
const button=label=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent===label&&!b.disabled);
const click=async label=>(await until(()=>button(label))).click();
const net=()=>{throw new TypeError('network down');};

// handlers: {dashboard, startAttempt, resumeAttempt, saveAnswer, submitAttempt} -> Response | throws
function mount(t,handlers,{attempt}) {
  document.querySelector('#root').replaceChildren();
  const seen=[],data={role:'student',person_id:person,univeracademy_id:'0123456789',name:'Ali',group,
    assignments:[{id:'assignment',title:'Harakat',attemptId:null,status:'available'}],results:[]};
  const defaults={
    dashboard:()=>Response.json({data}),
    startAttempt:()=>{data.assignments[0].status='in_progress';data.assignments[0].attemptId='a';return Response.json({data:attempt()});},
    resumeAttempt:()=>Response.json({data:attempt()}),
    saveAnswer:body=>Response.json({data:{questionId:body.questionId,optionId:body.optionId,revision:body.expectedRevision+1}}),
    submitAttempt:()=>{data.assignments[0].status='submitted';data.results=[score];return Response.json({data:score});},
  };
  const port=createStagingStudentPort({baseUrl:'https://api.example.org/api/v1',person,current:()=>person,access:fn=>fn('account-proof-in-memory'),
    fetcher:async req=>{
      const path=new URL(req.url).pathname.split('/').at(-1);seen.push(path);
      const body=path==='dashboard'?undefined:await req.json();
      return (handlers[path]??defaults[path])(body,data);
    }});
  const student={person,activeGroupId:group.id,displayId:'0123456789',firstName:'Ali',lastName:'S',registrationComplete:true};
  const flow=new StudentFlow({stagingPilot:()=>port,profile:async()=>student,exams:async()=>[]});
  flow.patch({screen:'exams',exams:[],student});
  const root=createRoot(document.querySelector('#root'));
  t.after(()=>root.unmount());
  root.render(createElement(StudentApp,{studentFlow:flow,mode:'telegram',stagingPilot:true}));
  return {seen,data};
}
const questions=[{id:'q',prompt_blocks:[{type:'text',markdown:'Tezlik?'}],options:[{id:'y',blocks:[{type:'text',markdown:'5 m/s'}]}]}];
const attemptAt=(deadline,serverNow)=>()=>({id:'a',status:'in_progress',deadlineAt:new Date(deadline).toISOString(),...(serverNow===undefined?{}:{serverNow}),answers:[],questions});
async function begin(){await click('Testni boshlash');await click('Ha, boshlash');await until(()=>document.querySelector('input[type=radio]'));}
const FUTURE=Date.UTC(2031,0,1,12,0,0); // far from this computer's clock on purpose

test('soat serverning vaqtiga tayanadi: telefon soati noto‘g‘ri bo‘lsa ham qolgan vaqt to‘g‘ri',async t=>{
  mount(t,{},{attempt:attemptAt(FUTURE,FUTURE-125000)});await begin();
  const timer=await until(()=>document.querySelector('[role=timer]'));
  assert.match(timer.textContent,/^02:0[45]$/);
  assert(!text().includes('Vaqt tugadi'));
  assert(!document.querySelector('fieldset').disabled);
});

test('aloqa uzilsa javob berish qulflanmaydi; saqlangan holat o‘zi qayta o‘qiladi va keyingi urinish saqlanadi',async t=>{
  let saves=0;
  const {seen}=mount(t,{saveAnswer:body=>{saves++;if(saves===1)net();return Response.json({data:{questionId:body.questionId,optionId:body.optionId,revision:body.expectedRevision+1}});}},
    {attempt:attemptAt(FUTURE,FUTURE-3600000)});
  await begin();
  document.querySelector('input[type=radio]').click();
  await until(()=>text().includes('Aloqa muammosi'));
  assert(!document.querySelector('fieldset').disabled,'javob berish ochiq qolishi kerak');
  await until(()=>seen.includes('resumeAttempt'));            // avtomatik qayta o‘qish
  await until(()=>!text().includes('Aloqa muammosi')||true);
  document.querySelector('input[type=radio]').click();
  await until(()=>text().includes('1-savolning javobi saqlandi.'));
  assert.equal(saves,2);
});

test('holat o‘zgargan xatoda (conflict) javob berish avval qayta o‘qilguncha qulflanadi',async t=>{
  let reads=0;
  const {seen}=mount(t,{saveAnswer:()=>Response.json({error:{code:'REVISION_CONFLICT',request_id:'r'}},{status:409}),
    resumeAttempt:()=>{reads++;return Response.json({data:attemptAt(FUTURE,FUTURE-3600000)()});}},{attempt:attemptAt(FUTURE,FUTURE-3600000)});
  await begin();
  document.querySelector('input[type=radio]').click();
  await until(()=>text().includes('Javob holati o‘zgargan'));
  assert(document.querySelector('fieldset').disabled);
  await until(()=>reads>=1&&!document.querySelector('fieldset').disabled);   // qayta o‘qilgach ochiladi
  assert(seen.includes('resumeAttempt'));
});

test('topshirilgandan keyin ro‘yxatni yangilash uzilsa ham natija ekranda qoladi',async t=>{
  let dashboards=0;
  mount(t,{dashboard:(_,data)=>{if(++dashboards>=2)net();return Response.json({data});}},{attempt:attemptAt(FUTURE,FUTURE-3600000)});
  await begin();
  document.querySelector('input[type=radio]').click();await until(()=>text().includes('1-savolning javobi saqlandi.'));
  await click('Testni yakunlash');await click('Ha, javoblarni yuborish');
  await until(()=>text().includes('100.00%'));
  await until(()=>text().includes('Natija saqlandi'));
  assert(text().includes('100.00%'));
});

test('ruxsat yo‘qolsa test yashiriladi, sababi aytiladi va haqiqiy holat qayta o‘qiladi',async t=>{
  let dashboards=0;
  const {seen}=mount(t,{dashboard:(_,data)=>{dashboards++;return Response.json({data});},
    saveAnswer:()=>Response.json({error:{code:'EXAM_ACCESS_REVOKED',request_id:'r'}},{status:403})},{attempt:attemptAt(FUTURE,FUTURE-3600000)});
  await begin();
  const before=dashboards;
  document.querySelector('input[type=radio]').click();
  await until(()=>!document.querySelector('input[type=radio]'));
  await until(()=>dashboards>before);
  await until(()=>text().includes('Bu testga kirish huquqingiz yopilgan.'));
  assert(!text().includes('Hozircha test yo‘q'));
  assert(seen.filter(p=>p==='dashboard').length>=2);
});

test('vaqt tugasa test qulflanadi, natija avtomatik tekshiriladi va ro‘yxatga qaytiladi',async t=>{
  const {seen}=mount(t,{resumeAttempt:(_,data)=>{data.assignments[0].status='expired';return Response.json({data:{id:'a',status:'expired',deadlineAt:new Date(FUTURE).toISOString(),answers:[],questions:[]}});}},
    {attempt:attemptAt(FUTURE,FUTURE-600)});
  await begin();
  await until(()=>document.querySelector('fieldset')?.disabled||text().includes('Vaqt tugadi'));
  await until(()=>seen.includes('resumeAttempt'));
  await until(()=>!document.querySelector('input[type=radio]')&&text().includes('Vaqt tugadi'),8000);
  assert(text().includes('Test yakunlangan.'));
});

test('oddiy ro‘yxat yuklanmasa "Hozircha test yo‘q" emas, haqiqiy sabab aytiladi',async t=>{
  const student={person,displayId:'0123456789',firstName:'Ali',lastName:'S',registrationComplete:true};
  let fail=true;
  const flow=new StudentFlow({profile:async()=>student,exams:async()=>{if(fail)throw new StudentFailure('forbidden','FORBIDDEN');return [];}});
  flow.patch({screen:'exams',exams:[],student});
  document.querySelector('#root').replaceChildren();
  const root=createRoot(document.querySelector('#root'));t.after(()=>root.unmount());
  root.render(createElement(StudentApp,{studentFlow:flow,mode:'telegram',stagingPilot:false}));
  await until(()=>text().includes('Hozircha test yo‘q'));              // xato bo‘lmaganda oddiy bo‘sh ro‘yxat
  await click('Testlar ro‘yxatini yangilash');
  await until(()=>text().includes('Testlar ro‘yxati yangilanmadi'));
  assert(!text().includes('Hozircha test yo‘q'));
  fail=false;await click('Testlar ro‘yxatini yangilash');
  await until(()=>text().includes('Hozircha test yo‘q'));
});

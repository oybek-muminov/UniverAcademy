import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudentFlow } from '../src/flow.ts';
const student = {person:'p1',firstName:'Namuna',lastName:'O‘quvchi',displayId:'0000000001',registrationComplete:true};
test('cabinet header and dashboard render accessible controls without placeholders',async()=>{
 const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{middlewareMode:true}});
 try {
  const {StudentApp}=await server.ssrLoadModule('/src/student-app.tsx');
  const {AccountDashboard}=await server.ssrLoadModule('/src/account-dashboard.tsx');
  const flow=new StudentFlow({});
  flow.patch({student,screen:'exams'});
  const html=renderToStaticMarkup(createElement(StudentApp,{studentFlow:flow,mode:'telegram'}));
  assert.match(html,/Namuna O‘quvchi/);
  assert.match(html,/>Dashboard<\/button>/);
  assert.doesNotMatch(html,/Salom,|Tez kunda/);
  flow.patch({student: {...student, teacherCabinet:true}});
  const teacherHtml = renderToStaticMarkup(createElement(StudentApp,{studentFlow:flow,mode:'telegram'}));
  assert.match(teacherHtml, /O‘qituvchi kabineti/);
  assert.match(teacherHtml, /href="https:\/\/ustoz\.univeracademy\.uz\/"/);
  assert.doesNotMatch(teacherHtml, /Mening testlarim|Dashboard<\/button>/);
  const panel=renderToStaticMarkup(createElement(AccountDashboard,{student,flow,busy:false,onLogout:async()=>{},onDeleteAccount(){}}));
  assert.match(panel,/UniverAcademy ID: 0000000001</);
  assert.match(panel,/dashboard-first-name/);
  assert.doesNotMatch(panel,/Kabinetga qaytish/);
  assert.match(panel,/account-action-row/);
  assert.match(panel,/>Chiqish<\/button>/);
  assert.match(panel,/class="danger-button">Hisobni o‘chirish/);
  const disabled=renderToStaticMarkup(createElement(AccountDashboard,{student,flow,busy:false}));
  assert.match(disabled,/class="danger-button" disabled=""/);
  const pending=renderToStaticMarkup(createElement(AccountDashboard,{student,flow,busy:false,deletionBusy:true,onDeleteAccount(){}}));
  assert.match(pending,/class="danger-button" disabled=""/);
 } finally {await server.close();}
});

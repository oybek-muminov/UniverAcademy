import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createProductionOwnerConnection} from '../src/production-connection.ts';
import {STUDENT_CONTRACT_SHA256} from '../src/owner-client/student-client.ts';
import {readStagingInvite} from '../src/staging-student-port.ts';

const packet = JSON.parse(readFileSync(new URL('./fixtures/wire.json',import.meta.url),'utf8'));
const profile = packet.cases.profileRegistered.data;
const group = {id:profile.active_group_id,name:'Fizika',status:'active'};
const dashboard = {role:'student',person_id:profile.person_id,group:null,assignments:[],results:[]};
const ok = data => Response.json({data});
const failure = (status,code) => Response.json({error:{code,request_id:crypto.randomUUID()}},{status});
async function student(exams,pilot,enabled=true,currentProfile=profile) {
  const paths=[];
  const connection=createProductionOwnerConnection({
    mode:'production',baseUrl:'https://api.example.test/api/v1',contractSha256:STUDENT_CONTRACT_SHA256
  },async request=>{
    const path=new URL(request.url).pathname.split('/api/v1')[1];
    paths.push(path);
    if(path==='/auth/clerk') return ok({access_token:'test-access',refresh_token:'test-refresh',token_type:'Bearer',
      expires_at:new Date(Date.now()+60000).toISOString(),refresh_expires_at:new Date(Date.now()+120000).toISOString(),profile:currentProfile});
    assert.equal(request.headers.get('Authorization'),'Bearer test-access');
    if(path==='/me') return ok(currentProfile);
    if(path==='/exams') return exams();
    assert.equal(path,'/student/pilot/dashboard');return pilot();
  },{loginMethod:'clerk',stagingPilotEnabled:enabled});
  await connection.auth.login('test-clerk-proof');
  return {...connection,paths};
}

test('enabling a group pilot keeps ordinary assignments and their original client for every student',async()=>{
  const source=packet.cases.examOpen.data;
  const c=await student(()=>ok([source]),()=>assert.fail('Ordinary list cannot depend on the pilot request'));
  assert.equal((await c.port.exams())[0].id,source.assignment_id);
  assert.deepEqual(c.paths,['/auth/clerk','/exams']);
});

test('registration-only exam list absence permits only a confirmed pilot member or explicit invitation',async t=>{
  const missing=()=>failure(404,'NOT_FOUND');
  const withoutGroup=await student(missing,()=>assert.fail('No pilot probe for ungrouped profile'),true,{...profile,active_group_id:null});
  assert.equal((await withoutGroup.port.profile()).activeGroupId,null);
  await assert.rejects(withoutGroup.port.exams(),{code:'NOT_FOUND'});
  assert.deepEqual(withoutGroup.paths,['/auth/clerk','/me','/exams']);
  const c=await student(missing,()=>ok({...dashboard,group}));
  assert.deepEqual(await c.port.exams(),[]);
  assert.deepEqual(c.paths,['/auth/clerk','/exams','/student/pilot/dashboard']);
  for(const [name,value] of [['unrelated',dashboard],['archived',{...dashboard,group:{...group,status:'archived'}}]]) {
    await t.test(name,async()=>{
      const c=await student(missing,()=>ok(value));
      await assert.rejects(c.port.exams(),{code:'NOT_FOUND'});
    });
  }
  const different=await student(missing,()=>ok({...dashboard,group,person_id:crypto.randomUUID()}));
  await assert.rejects(different.port.exams(),{code:'RESPONSE_INVARIANT_FAILED'});
  const bad=await student(missing,()=>ok({...dashboard,group,assignments:[null]}));
  await assert.rejects(bad.port.exams(),{code:'RESPONSE_INVARIANT_FAILED'});
  const unavailable=await student(missing,()=>failure(503,'SERVICE_UNAVAILABLE'));
  await assert.rejects(unavailable.port.exams(),{code:'SERVICE_UNAVAILABLE'});
  const noPilot=await student(missing,()=>assert.fail('disabled'),false);
  await assert.rejects(noPilot.port.exams(),{code:'NOT_FOUND'});
  const revoked=await student(()=>failure(401,'SESSION_REVOKED'),()=>assert.fail('no pilot after auth loss'));
  await assert.rejects(revoked.port.exams(),{code:'SESSION_REVOKED'});
  assert.equal(revoked.auth.person(),null);

  const url='https://mini.example.org/?invite=',token='grp_'+'x'.repeat(32);
  assert.equal(readStagingInvite(url+token),token);
  for(const value of [url+'grp_short',url+token+'&invite='+token,url+token+'%0a'])assert.equal(readStagingInvite(value),null);
  const previous=Object.getOwnPropertyDescriptor(globalThis,'location');
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'location',previous);else delete globalThis.location;});
  Object.defineProperty(globalThis,'location',{configurable:true,value:{href:url+token}});
  const invite=await student(missing,()=>ok(dashboard));
  assert.deepEqual(await invite.port.exams(),[]);
  assert(!invite.paths.some(p=>p.includes('commands')));
});

test('an optional pilot route failure does not reset the unrelated ordinary app session',async()=>{
  const c=await student(()=>ok([packet.cases.examOpen.data]),()=>failure(401,'UNKNOWN_GATEWAY'));
  await assert.rejects(c.port.stagingPilot(profile.person_id).dashboard(),{kind:'forbidden'});
  assert.equal(c.auth.person(),profile.person_id);
  assert.equal((await c.port.exams()).length,1);
});

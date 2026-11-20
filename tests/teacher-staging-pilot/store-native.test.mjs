import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createCluster,addProfile} from './cluster.mjs';
import {runStagingPilot} from '../../runtime/teacher-staging-store.mjs';

test('native migration can be withdrawn and restored without losing canonical scores, ownership or a private invitation',async t=>{
  const cluster=await createCluster();t.after(()=>cluster.close());const db=cluster.admin;
  const migration=async name=>db.query(await readFile(new URL('../../supabase/migrations/teacher-staging/'+name+'.sql',import.meta.url),'utf8'));
  await migration('up');
  async function staff(role,cabinetId){
    const personId=await addProfile(db,{name:role,role,cabinetId});
    if(role!=='student'){
      await db.query('INSERT INTO ua_private.staff_access VALUES($1,true,$2,false,$2,false)',[personId,role==='admin']);
      await db.query("INSERT INTO ua_private.staff_subject_scope VALUES($1,'physics',NULL)",[personId]);
      if(role==='teacher')await db.query("INSERT INTO ua_private.teacher_subject_approvals VALUES($1,'physics',true,NULL)",[personId]);
    }
    return {personId,role};
  }
  const teacher=await staff('teacher',null),admin=await staff('admin',null),student=await staff('student','0100000017');
  async function call(actor,action,input={},key=randomUUID()){
    await db.query('BEGIN');
    try{
      await db.query("SELECT 1 FROM ua_private.people WHERE id=$1 FOR UPDATE",[actor.personId]);
      await db.query('SET LOCAL ROLE ua_cabinet_stage');
      const result=await runStagingPilot({client:db,personIds:[actor.personId],now:Date.now()},actor,action,input,key);
      await db.query('COMMIT');return result;
    }catch(e){await db.query('ROLLBACK');throw e;}
  }
  const g=await call(teacher,'createGroup',{name:'Fizika'});
  await call(admin,'approveGroup',{groupId:g.id});
  const invite=await call(teacher,'createInvite',{groupId:g.id});
  await call(student,'acceptInvite',{token:invite.token});
  const test=await call(teacher,'importTest',{title:'Hisob',questions:[{text:'3+4',options:['5','6','7','8'],correctIndex:2}]});
  await call(teacher,'publishTest',{testId:test.id});
  const a=await call(teacher,'assignTest',{groupId:g.id,testId:test.id});
  const attempt=await call(student,'startAttempt',{assignmentId:a.id});
  const question=attempt.questions[0];
  await call(student,'saveAnswer',{attemptId:attempt.id,questionId:question.id,optionId:question.options.find(o=>o.text==='7').id,expectedRevision:0});
  await call(student,'submitAttempt',{attemptId:attempt.id});
  const before=await call(teacher,'dashboard');
  assert.equal(before.results[0].percentage,'100.00');
  await migration('down');
  assert.equal((await db.query("SELECT has_schema_privilege('ua_cabinet_stage','ua_cabinet_retained','usage') ok")).rows[0].ok,false);
  assert.equal((await db.query("SELECT count(*) n FROM ua_private.ordinary_results")).rows[0].n,'1');
  await migration('up');
  assert.deepEqual(await call(teacher,'dashboard'),before);
  assert.equal((await call(student,'acceptInvite',{token:invite.token})).id,g.id);
  const timed=await call(teacher,'importTest',{title:'Bitta savol',duration_seconds:1,questions:[{text:'1+1',options:['1','2','3','4'],correctIndex:1}]});
  await call(teacher,'publishTest',{testId:timed.id});
  const assigned=await call(teacher,'assignTest',{groupId:g.id,testId:timed.id});
  const late=await call(student,'startAttempt',{assignmentId:assigned.id});
  await delay(Math.max(0,Date.parse(late.deadlineAt)-Date.now())+25);
  const scores=(await call(teacher,'dashboard')).results;
  assert.equal(scores.find(s=>s.attemptId===late.id).percentage,'0.00');
  assert.equal((await db.query('SELECT count(*) n FROM ua_private.ordinary_results WHERE attempt_id=$1',[late.id])).rows[0].n,'1');
});

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {createTeacherStagingApi} from '../../runtime/teacher-staging-api.mjs';
import {createCluster,createServiceLogin} from './cluster.mjs';
import {party,provisionStaff,provisionStudent,testClerk} from './credentials.mjs';
import {apiOrigin,good,rejected,routes,studentOrigin} from './requests.mjs';

// Measure equivalent DB result rows at the actual pg driver boundary, not network latency.
test('cabinet data paths bound queries and avoid fetching authored content for answer acknowledgments',async t=>{
  const cluster=await createCluster(),db=cluster.admin;
  let pool,measure;
  t.after(async()=>{try{await pool?.end();}finally{await cluster.close();}});
  await db.query(await readFile(new URL('../../supabase/migrations/teacher-staging/up.sql',import.meta.url),'utf8'));
  const database=await createServiceLogin(cluster,'qa_query_budget',[
    {role:'ua_api_login',inherit:true,set:false},{role:'ua_cabinet_stage',inherit:false,set:true}]);
  pool=new pg.Pool({connectionString:database,max:4});
  const counted={async connect(){
    const client=await pool.connect();
    return {release:discard=>client.release(discard),async query(statement){
      const result=await client.query(statement);
      if(measure){
        measure.queries++;
        const body=JSON.stringify(result.rows);
        measure.bytes+=Buffer.byteLength(body);
        if(body.includes('UZ_TEXT_SENTINEL'))measure.contentReads++;
      }
      return result;
    }};
  }};
  const metrics={};
  async function sample(name,op){
    measure={queries:0,bytes:0,contentReads:0};
    try{return await good(op());}
    finally{metrics[name]=measure;measure=null;}
  }
  const clerk=await testClerk(),staff=await provisionStaff(db,'Ustoz','teacher');
  const pupil=await provisionStudent(db,'Talaba','0100000123',70000123,{clerk});
  const api=createTeacherStagingApi({enabled:true,pool:counted,teacherOrigin:party,studentOrigin,apiOrigin,verifier:clerk.verifier,liveness:clerk.liveness});
  const teacher=routes(api,'teacher',await clerk.sign(staff.subject)),student=routes(api,'student',pupil.token);
  await sample('emptyStaff',()=>teacher.dashboard());
  const group=await good(teacher.command('createGroup',{name:'Fizika'}));
  await good(teacher.command('addMember',{groupId:group.id,univeracademy_id:pupil.cabinetId}));
  const questions=Array.from({length:40},(_,i)=>({text:'UZ_TEXT_SENTINEL '+i+' '+'Savol matni. '.repeat(60),
    options:['A','B','C','D'].map(c=>c+' '+'Javob matni. '.repeat(18)),correctIndex:1}));
  const draft=await good(teacher.command('importTest',{title:'Qirq savol',questions}));
  const publishKey=randomUUID(),assignKey=randomUUID();
  await sample('publish',()=>teacher.command('publishTest',{testId:draft.id},publishKey));
  await sample('publishReplay',()=>teacher.command('publishTest',{testId:draft.id},publishKey));
  const spec={groupId:group.id,testId:draft.id};
  const assignment=await sample('assign',()=>teacher.command('assignTest',spec,assignKey));
  await sample('assignReplay',()=>teacher.command('assignTest',spec,assignKey));
  const staffHome=await sample('staffDashboard',()=>teacher.dashboard());
  assert.equal(staffHome.groups[0].members[0].univeracademy_id,pupil.cabinetId);
  assert.equal(staffHome.tests[0].questionCount,40);
  const home=await sample('studentDashboard',()=>student.dashboard());
  assert.equal(home.assignments[0].id,assignment.id);
  const attempt=await sample('start',()=>student.command('startAttempt',{assignmentId:assignment.id}));
  assert.equal(attempt.questions.length,40);
  const question=attempt.questions[0],save={attemptId:attempt.id,questionId:question.id,
    optionId:question.options.find(o=>o.text.startsWith('B ')).id,expectedRevision:0};
  const key=randomUUID();
  const ack=await sample('save',()=>student.command('saveAnswer',save,key));
  assert.deepEqual(await sample('saveReplay',()=>student.command('saveAnswer',save,key)),ack);
  const resumed=await sample('resume',()=>student.command('resumeAttempt',{attemptId:attempt.id}));
  assert.deepEqual(resumed.answers,[ack]);
  const score=await sample('submit',()=>student.command('submitAttempt',{attemptId:attempt.id}));
  assert.equal(score.percentage,'2.50');
  const results=await sample('results',()=>teacher.dashboard());
  assert.equal(results.results[0].percentage,'2.50');
  const text=await readFile(new URL('../../apps/teacher-web/local-pilot/sample.txt',import.meta.url),'utf8');
  const preview=()=>teacher.call('import-preview','POST',JSON.stringify({text}),{'content-type':'application/json'});
  assert.ok((await sample('textPreview',preview)).questions.length>0);
  if(process.env.UA_REPORT_CABINET_METRICS==='1')t.diagnostic('local pg data '+JSON.stringify(metrics));
  // Driver-command ceilings also cover auth and transaction setup/commit. Compare bytes
  // separately so a single SELECT cannot silently reintroduce all rich question text.
  assert.ok(metrics.textPreview.queries<metrics.emptyStaff.queries);
  // +1: the first teacher read per process checks whether the test archive table exists (then remembered).
  assert.ok(metrics.emptyStaff.queries<=23);
  assert.ok(metrics.staffDashboard.queries<=26);
  assert.ok(metrics.studentDashboard.queries<=22);
  for(const action of ['save','submit']){
    assert.equal(metrics[action].contentReads,0);
    assert.ok(metrics[action].queries<=28);
    assert.ok(metrics[action].bytes<35000);
  }
  for(const action of ['publishReplay','assignReplay'])assert.equal(metrics[action].contentReads,0);
  for(const action of ['publish','assign','start','resume'])assert.equal(metrics[action].contentReads,1);
  await db.query('UPDATE ua_private.student_families SET revoked_at_ms=$2 WHERE id=$1',[pupil.familyId,Date.now()]);
  await rejected(student.dashboard(),401);
  await db.query('UPDATE ua_private.staff_group_scope SET revoked_at_ms=1 WHERE person_id=$1 AND group_id=$2',[staff.id,group.id]);
  await rejected(teacher.command('assignTest',spec,assignKey),404);
  await db.query('UPDATE ua_private.teacher_subject_approvals SET revoked_at_ms=1 WHERE person_id=$1',[staff.id]);
  await rejected(teacher.command('publishTest',{testId:draft.id},publishKey),403);
  await rejected(preview(),403);
});

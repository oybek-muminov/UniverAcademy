import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {setImmediate as tick} from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import {assignmentSchedule} from '../../runtime/teacher-assignment-schedule.mjs';
import {createCabinetApi} from '../../runtime/teacher-cabinet-api.mjs';
import {startAttempt, submitAttempt} from '../../supabase/functions/univeracademy-api/attempts.ts';
import {decodePublished, encodePublished, encodeOrdinary} from '../../supabase/functions/univeracademy-api/storage/attempt-rows.ts';
import {runStagingPilot} from '../../runtime/teacher-staging-store.mjs';
import {addProfile, createCluster, createServiceLogin} from './cluster.mjs';
import {party, ownerParty, provisionStaff, testClerk} from './credentials.mjs';
import {apiOrigin, good, rejected, routes, studentOrigin} from './requests.mjs';

const candidate=new URL('../../docs/owner-group-transfer-fence.review.sql',import.meta.url);
const migration=new URL('../../supabase/migrations/teacher-staging/up.sql',import.meta.url);
const transferSql='SELECT ua_cabinet.owner_transfer_group_fence($1,$2,$3,$4,$5,$6) AS result';
const digest=s=>createHash('sha256').update(s).digest('hex');
const receiptKey=(actor,k)=>actor+'/staging/transferGroup/'+digest(k);
const dbCode=code=>error=>error?.code===code;
const fault=message=>error=>error?.message===message;

test('row-fence candidate with native restricted cabinet writers', {timeout:90000},async t=>{
  const cluster=await createCluster(), {admin}=cluster;
  let holder,writer,pool,attemptHttp;
  t.after(async()=>{
    try{await Promise.allSettled([holder?.end(),writer?.end(),pool?.end()]);}
    finally{await cluster.close();}
  });
  await cluster.installDeletion();
  await admin.query(await readFile(migration,'utf8'));
  await admin.query(await readFile(candidate,'utf8'));
  const serviceUrl=await createServiceLogin(cluster,'qa_transfer_fence_writer',[
    {role:'ua_api_login',inherit:true,set:false},{role:'ua_cabinet_stage',inherit:false,set:true}
  ]);
  const open=(connectionString,application_name)=>new pg.Client({
    connectionString,application_name, connectionTimeoutMillis:5000, query_timeout:7000
  });
  holder=open(cluster.adminUrl,'ua-h4-holder'); writer=open(serviceUrl,'ua-h4-writer');
  await holder.connect(); await writer.connect();
  pool=new pg.Pool({connectionString:serviceUrl,application_name:'ua-h4-http',max:1,
    connectionTimeoutMillis:5000,statement_timeout:6000,lock_timeout:4500,query_timeout:7000});
  const one=async (client,sql,values=[]) => (await client.query(sql,values)).rows[0];
  const holderPid=(await one(holder,'SELECT pg_backend_pid() pid')).pid;
  assert.notEqual(holderPid,(await one(writer,'SELECT pg_backend_pid() pid')).pid);
  const identity=await one(writer,`SELECT current_user::text role,rolsuper super,rolbypassrls bypass
    FROM pg_roles WHERE rolname=current_user`);
  assert.deepEqual(identity,{role:'qa_transfer_fence_writer',super:false,bypass:false});
  const people=[];
  for(const [name,role] of [['Ega','owner'],['Avvalgi ustoz','teacher'],['Yangi ustoz','teacher'],['Mustaqil ustoz','teacher']])
    people.push(await provisionStaff(admin,name,role));
  const [owner,source,dest,other]=people;
  const student=await addProfile(admin,{name:'Sinov o‘quvchi',role:'student',cabinetId:'0100000110'});
  const clerk=await testClerk();
  const api=createCabinetApi({enabled:true,pool,teacherOrigin:party,studentOrigin,apiOrigin,ownerOrigin:ownerParty,
    verifier:clerk.verifier,liveness:clerk.liveness,allowLegacyTelegram:false},async()=>{throw new Error('no media');});
  const teacherHttp=routes(api,'teacher',await clerk.sign(source.subject));

  async function begin(client,actor,restricted=false){
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SET LOCAL statement_timeout='6s'; SET LOCAL lock_timeout='4s'; SET LOCAL idle_in_transaction_session_timeout='14s'");
    await client.query(`SELECT set_config('ua.phase','auth',true),set_config('ua.person_id',$1,true),
      set_config('ua.person_ids',$2,true),set_config('ua.telegram_id','',true),
      set_config('ua.clerk_issuer','',true),set_config('ua.clerk_subject','',true)`,[actor,JSON.stringify([actor])]);
    if(restricted){
      assert.equal((await one(client,'SELECT id FROM ua_private.lock_people($1::uuid[])',[[actor]])).id,actor);
      await client.query('SET LOCAL ROLE ua_cabinet_stage');
      assert.equal((await one(client,'SELECT current_user AS role')).role,'ua_cabinet_stage');
    }
    await client.query("SELECT set_config('ua.phase','domain',true)");
  }
  async function inTx(client,actor,restricted,fn){
    try{await begin(client,actor,restricted);const result=await fn();await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  }
  const writerIn=(actor,fn)=>inTx(writer,actor,true,fn);
  const ownerIn=fn=>inTx(holder,owner.id,false,fn);
  const cmd=(who,role,action,input,commandKey=randomUUID(),now=Date.now())=>runStagingPilot(
    {client:writer,personIds:[who],now},{personId:who,role},action,input,commandKey);
  const teacher=(actor,action,input)=>writerIn(actor,()=>cmd(actor,'teacher',action,input));
  const group=(actor,name)=>teacher(actor,'createGroup',{name,subjectId:'physics'});
  const revision=async gid=>(await one(admin,'SELECT revision::text n FROM ua_private.groups WHERE id=$1',[gid])).n;
  const currentOwner=async gid=>(await one(admin,'SELECT teacher_id FROM ua_cabinet.group_requests WHERE id=$1',[gid])).teacher_id;
  const transfer=async(gid,from,to,rev,k,client=holder)=>(await one(client,transferSql,[owner.id,gid,from,to,rev,receiptKey(owner.id,k)])).result;
  const draft=async (who,title)=>{
    const d=await teacher(who,'importTest',{title,duration_seconds:300,questions:[{text:'2+2',options:['1','2','3','4'],correctIndex:3}]});
    await teacher(who,'publishTest',{testId:d.id});
    return d.id;
  };
  const examGroup=(await group(source.id,'Fizika sinov')).id;
  const handover=(await group(source.id,'Topshiriladigan guruh')).id;
  const independent=(await group(other.id,'Mustaqil guruh')).id;
  await teacher(source.id,'addMember',{groupId:examGroup,univeracademy_id:'0100000110'});
  const examRev=await revision(examGroup), targetRev=await revision(handover);
  async function waitForBlockedHttp(isSettled){
    const end=performance.now()+2500;
    do{
      const found=await one(admin,`SELECT 1 AS waiting FROM pg_stat_activity
        WHERE application_name='ua-h4-http' AND $1::int=ANY(pg_blocking_pids(pid)) LIMIT 1`,[holderPid]);
      if(found)return;
      assert.equal(isSettled(),false,'the genuine HTTP request completed instead of waiting on the fence');
      await tick();
    }while(performance.now()<end);
    assert.fail('genuine HTTP request was not observed waiting on the transfer holder');
  }

  await t.test('runtime role has no transfer execution or direct owner update even with valid-looking context',async()=>{
    await assert.rejects(writerIn(owner.id,()=>transfer(handover,source.id,dest.id,targetRev,'not-granted',writer)),dbCode('42501'));
    await assert.rejects(writerIn(source.id,()=>writer.query('UPDATE ua_cabinet.group_requests SET teacher_id=$2 WHERE id=$1',[handover,dest.id])),dbCode('42501'));
    assert.equal(await currentOwner(handover),source.id);
  });

  await t.test('restricted same-group assignment writer holds fence, but committed scheduled exam is still refused',async()=>{
    const testId=await draft(source.id,'Rejalangan fizika');
    const startsAt=Date.now()+600_000;
    try{
      await begin(writer,source.id,true);
      const assignment=await cmd(source.id,'teacher','assignTest',{groupId:examGroup,testId,startsAt});
      assert.equal(assignment.opensAt,startsAt);
      await assert.rejects(ownerIn(()=>transfer(examGroup,source.id,dest.id,examRev,'scheduled')),dbCode('55P03'));
      await writer.query('COMMIT');
    }finally{await writer.query('ROLLBACK');}
    await assert.rejects(ownerIn(()=>transfer(examGroup,source.id,dest.id,examRev,'scheduled')),fault('OPEN_OR_SCHEDULED_TEST'));
  });

  await t.test('restricted genuine attempt writer holds same fence and submits normally',async sub=>{
    const testId=await draft(source.id,'Fizika: darhol');
    const now=Date.now();
    if(Date.parse(assignmentSchedule(now).closes_at)-now<30_000){sub.skip('Under 30 seconds to Tashkent admission close');return;}
    const assignment=await teacher(source.id,'assignTest',{groupId:examGroup,testId});
    let attempt;
    try{
      await begin(writer,student,true);
      attempt=await cmd(student,'student','startAttempt',{assignmentId:assignment.id});
      assert.equal(attempt.status,'in_progress');
      await assert.rejects(ownerIn(()=>transfer(examGroup,source.id,dest.id,examRev,'active')),dbCode('55P03'));
      await writer.query('COMMIT');
    }finally{await writer.query('ROLLBACK');}
    await assert.rejects(ownerIn(()=>transfer(examGroup,source.id,dest.id,examRev,'active')),fault('ACTIVE_TEST_ATTEMPT'));
    const result=await writerIn(student,()=>cmd(student,'student','submitAttempt',{attemptId:attempt.id}));
    assert.match(result.percentage,/^[0-9]+\.[0-9]{2}$/);
    const terminal=await one(admin,"SELECT a.body->>'status' AS status, r.exact_result FROM ua_private.attempts a JOIN ua_private.ordinary_results r ON r.attempt_id=a.id WHERE a.id=$1",[attempt.id]);
    assert.equal(terminal?.status,'submitted');
    assert.ok(terminal.exact_result);
    await assert.rejects(ownerIn(()=>transfer(examGroup,source.id,dest.id,examRev,'still-open')),fault('OPEN_OR_SCHEDULED_TEST'));
  });

  await t.test('transfer preserves completed native history of a legitimately expired assignment',async()=>{
    const oldStudent=await addProfile(admin,{name:'Tarixiy oquvchi',role:'student',cabinetId:'0100000111'});
    const historyGroup=(await group(source.id,'Tarixiy guruh')).id;
    await teacher(source.id,'addMember',{groupId:historyGroup,univeracademy_id:'0100000111'});
    const testId=await draft(source.id,'Fizika: yakunlangan');
    const rev=await revision(historyGroup);
    // The teacher command already accepts a transaction time. Use its genuine
    // calendar logic to create an assignment on a past Tashkent admission day.
    const past=Date.now()-48*60*60*1000;
    const assignment=await writerIn(source.id,()=>cmd(source.id,'teacher','assignTest',
      {groupId:historyGroup,testId},randomUUID(),past));
    const historical=await one(admin,"SELECT record, demo_id, (record#>>'{admission,closesAt}')::numeric < extract(epoch FROM clock_timestamp())*1000 AS closed FROM ua_private.assignments WHERE id=$1",[assignment.id]);
    assert.equal(historical.closed,true);
    assert.equal(historical.record.cancelled,false);
    const epochs=await one(admin,'SELECT m.epoch, g.grant_epoch FROM ua_private.memberships m JOIN ua_private.grants g ON g.person_id=m.person_id WHERE m.person_id=$1 AND g.assignment_id=$2',[oldStudent,assignment.id]);
    assert.equal(epochs.epoch,epochs.grant_epoch);
    // Fixture only: build historical data with the real attempt engine and
    // native storage encoders. No assignment update, guard bypass, or clock override.
    const access={proofKind:'student_session',personId:oldStudent,enabled:true,assignmentIds:[assignment.id]};
    const started=startAttempt({access,admission:{...historical.record.admission,activeGroupId:historyGroup,
      rostered:true,profileComplete:true,membershipEpoch:Number(epochs.epoch),grantEpoch:Number(epochs.grant_epoch)},
      published:decodePublished(historical.record.published),existing:null,id:randomUUID(),confirmed:true,now:assignment.opensAt});
    const complete=submitAttempt(access,started,{id:started.id,generation:started.generation},started.startedAt+1).record;
    assert.equal(complete.status,'submitted');
    const {published,questionOrder,answers,ordinary,...body}=complete;
    assert.deepEqual(answers,[]);
    assert.ok(ordinary);
    try{
      await admin.query('BEGIN');
      await admin.query('INSERT INTO ua_private.attempts(id,person_id,assignment_id,demo_id,generation,state_revision,body,frozen_test,question_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [complete.id,oldStudent,assignment.id,historical.demo_id,complete.generation,complete.stateRevision,
          JSON.stringify(body),JSON.stringify(encodePublished(published)),JSON.stringify(questionOrder)]);
      await admin.query("INSERT INTO ua_private.exam_series(person_id,demo_id,id,current_attempt_id,generation,state_revision,normal_attempt_used,official_attempt_id,recovery_state,recovery_window) VALUES($1,$2,$3,$4,$5,$6,true,$4,'none',NULL)",
        [oldStudent,historical.demo_id,randomUUID(),complete.id,complete.generation,complete.seriesStateRevision]);
      await admin.query('INSERT INTO ua_private.ordinary_results(attempt_id,exact_result) VALUES($1,$2)',[complete.id,JSON.stringify(encodeOrdinary(ordinary))]);
      await admin.query('COMMIT');
    }finally{await admin.query('ROLLBACK');}
    const history=()=>one(admin,`SELECT
      (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.person_id) FROM ua_private.memberships m WHERE m.affinity_group_id=$1) AS members,
      (SELECT to_jsonb(a) FROM ua_private.assignments a WHERE a.id=$4 AND a.group_id=$1) AS assignment,
      (SELECT to_jsonb(a) FROM ua_private.attempts a WHERE a.id=$2) AS attempt,
      (SELECT to_jsonb(s) FROM ua_private.exam_series s WHERE s.current_attempt_id=$2) AS series,
      (SELECT to_jsonb(r) FROM ua_private.ordinary_results r WHERE r.attempt_id=$2) AS result,
      (SELECT to_jsonb(o) FROM ua_cabinet.test_owners o WHERE o.version_id=$3) AS authorship`,[historyGroup,complete.id,testId,assignment.id]);
    const before=await history();
    assert.ok(before.members?.length===1&&before.assignment&&before.attempt&&before.series&&before.result);
    assert.equal(before.attempt.body.status,'submitted');
    assert.equal(before.authorship.teacher_id,source.id);
    assert.equal((await ownerIn(()=>transfer(historyGroup,source.id,dest.id,rev,'history'))).groupId,historyGroup);
    assert.equal(await currentOwner(historyGroup),dest.id);
    assert.deepEqual(await history(),before);
  });

  await t.test('scope update holds conflicting authority lock; after commit destination is ineligible',async()=>{
    // Isolated operator fixture for direct authority write (no new grants to real runtime).
    const adminWriter=open(cluster.adminUrl,'ua-h4-scope-fixture');
    await adminWriter.connect();
    try{
      await adminWriter.query('BEGIN');
      await adminWriter.query("UPDATE ua_private.staff_subject_scope SET revoked_at_ms=1 WHERE person_id=$1 AND subject_id='physics'",[dest.id]);
      await assert.rejects(ownerIn(()=>transfer(handover,source.id,dest.id,targetRev,'scope')),dbCode('55P03'));
      await adminWriter.query('COMMIT');
      await assert.rejects(ownerIn(()=>transfer(handover,source.id,dest.id,targetRev,'scope')),fault('TEACHER_NOT_ELIGIBLE'));
      await adminWriter.query("UPDATE ua_private.staff_subject_scope SET revoked_at_ms=NULL WHERE person_id=$1 AND subject_id='physics'",[dest.id]);
    }finally{await adminWriter.query('ROLLBACK').catch(()=>{});await adminWriter.end();}
  });

  await t.test('owner first: unrelated restricted writer completes; waiting genuine old teacher reauthorizes',async()=>{
    const oldInvite=await teacher(source.id,'createInvite',{groupId:handover});
    let result,settled=false;
    try{
      await begin(holder,owner.id);
      result=await transfer(handover,source.id,dest.id,targetRev,'move');
      assert.equal((await teacher(other.id,'createInvite',{groupId:independent})).groupId,independent,
        'unrelated genuine restricted group writer must finish before the transfer commits');
      attemptHttp=teacherHttp.command('createInvite',{groupId:handover}).finally(()=>{settled=true;});
      // Observe native wait before releasing the holder; no sleep or guessed timing.
      await waitForBlockedHttp(()=>settled);
      await holder.query('COMMIT');
      await rejected(attemptHttp,404);
    }finally{
      await holder.query('ROLLBACK').catch(()=>{});
      if(attemptHttp)await Promise.allSettled([attemptHttp]);
    }
    assert.equal(await currentOwner(handover),dest.id);
    assert.equal((await teacher(dest.id,'createInvite',{groupId:handover})).groupId,handover);
    assert.deepEqual(await ownerIn(()=>transfer(handover,source.id,dest.id,targetRev,'move')),result);
    assert.equal((await one(admin,"SELECT count(*)::int n FROM ua_private.staff_audit WHERE action='transferGroup' AND target_id=$1",[handover])).n,1);
    await ownerIn(()=>transfer(handover,dest.id,source.id,result.revision,'move-back'));
    await assert.rejects(writerIn(student,()=>cmd(student,'student','acceptInvite',{token:oldInvite.token})),dbCode('INVITE_EXPIRED'));
    assert.equal((await one(admin,'SELECT expires_at<=clock_timestamp() AS expired FROM ua_cabinet.invites WHERE digest=$1',[digest(oldInvite.token)])).expired,true);
  });

  await t.test('legacy writers and outbox remain explicitly outside the current proof',async()=>{
    const sql=await readFile(candidate,'utf8');
    assert.doesNotMatch(sql,/\bLOCK\s+TABLE\b/i);
    assert.doesNotMatch(sql,/\bGRANT\s+EXECUTE\b/i);
    assert.match(sql,/SECURITY INVOKER/);
    assert.match(sql,/direct\/legacy writers/);
  });
});

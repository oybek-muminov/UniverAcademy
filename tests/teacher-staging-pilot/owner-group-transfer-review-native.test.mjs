import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import {addProfile, createCluster} from './cluster.mjs';
import {provisionStaff} from './credentials.mjs';
import {runStagingPilot} from '../../runtime/teacher-staging-store.mjs';
import {assignmentSchedule} from '../../runtime/teacher-assignment-schedule.mjs';

const proposal=new URL('../../docs/owner-group-transfer.review.sql',import.meta.url);
const staging=new URL('../../supabase/migrations/teacher-staging/up.sql',import.meta.url);
const digest=value=>createHash('sha256').update(value).digest('hex');
const key=(actor,value)=>actor+'/staging/transferGroup/'+digest(value);
const transferSQL='SELECT ua_cabinet.owner_transfer_group($1,$2,$3,$4,$5,$6) AS value';
const errorCode=code=>error=>error?.code===code;
const sqlFault=message=>error=>error?.message===message;

test('native review-only handover interlocks and cabinet writer reauthorization',
  {timeout:90000},async t=>{
  const cluster=await createCluster();
  const [first,second]=[1,2].map(()=>new pg.Client({
    connectionString:cluster.adminUrl, connectionTimeoutMillis:5000, query_timeout:6000,
  }));
  t.after(async()=>{
    try{await Promise.allSettled([first.end(),second.end()]);}
    finally{await cluster.close();}
  });
  await first.connect(); await second.connect();
  const {admin}=cluster;
  const pids=await Promise.all([first,second].map(c=>c.query('SELECT pg_backend_pid() AS n')));
  assert.notEqual(pids[0].rows[0].n,pids[1].rows[0].n,'must use two independent native database backends');
  await cluster.installDeletion();
  await admin.query(await readFile(staging,'utf8'));
  await admin.query(await readFile(proposal,'utf8'));
  const participants=[]; // Provision in series: fixture profile setup owns a transaction.
  for(const [name,role] of [['Ega A','owner'],['Ega B','owner'],['Avvalgi ustoz','teacher'],['Yangi ustoz','teacher']])
    participants.push((await provisionStaff(admin,name,role)).id);
  const [ownerA,ownerB,source,destination]=participants;
  const student=await addProfile(admin,{name:'Talaba',role:'student',cabinetId:'0100000101'});
  const visitor=await addProfile(admin,{name:'Tashrifchi',role:'student',cabinetId:'0100000102'});
  const begin=async(client,actor)=>{
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL statement_timeout='4s'; SET LOCAL lock_timeout='1s'; SET LOCAL idle_in_transaction_session_timeout='12s'");
    await client.query("SELECT set_config('ua.phase','domain',true),set_config('ua.person_id',$1,true)",[actor]);
  };
  const run=async(client,actor,fn,commit=true)=>{
    await begin(client,actor);
    try{const result=await fn(); await client.query(commit?'COMMIT':'ROLLBACK'); return result;}
    catch(error){await client.query('ROLLBACK').catch(()=>{}); throw error;}
  };
  const cmd=(client,personId,role,action,input,requestKey=randomUUID())=>
    runStagingPilot({client,personIds:[personId],now:Date.now()},{personId,role},action,input,requestKey);
  const revision=async id=>(await admin.query('SELECT revision::text AS n FROM ua_private.groups WHERE id=$1',[id])).rows[0].n;
  const transfer=async(client,actor,id,from,to,rev,receipt)=>
    (await client.query(transferSQL,[actor,id,from,to,rev,key(actor,receipt)])).rows[0].value;
  const makeGroup=name=>run(first,source,()=>cmd(first,source,'teacher','createGroup',{name,subjectId:'physics'}));
  const examGroup=(await makeGroup('Handover exam')).id;
  const spareGroup=(await makeGroup('Handover ready')).id;
  const unrelatedGroup=(await makeGroup('Unrelated')).id;
  const testVersion=await run(first,source,()=>cmd(first,source,'teacher','importTest',
    {title:'Fizika',duration_seconds:300,questions:[{text:'1+1',options:['1','2','3','4'],correctIndex:1}]}));
  await run(first,source,()=>cmd(first,source,'teacher','publishTest',{testId:testVersion.id}));
  await run(first,source,()=>cmd(first,source,'teacher','addMember',{groupId:examGroup,univeracademy_id:'0100000101'}));
  const examRevision=await revision(examGroup);
  const attemptHandover=()=>run(second,ownerA,()=>transfer(second,ownerA,examGroup,source,destination,examRevision,'exam'));
  await t.test('real teacher assignment writer first: fail fast; committed scheduled exam remains blocked',async()=>{
    const startsAt=Date.now()+10*60_000;
    await begin(first,source);
    try{
      // The completed command proves the actual writer reached its writes, without committing.
      const scheduled=await cmd(first,source,'teacher','assignTest',{groupId:examGroup,testId:testVersion.id,startsAt});
      assert.equal(scheduled.opensAt,startsAt);
      await assert.rejects(attemptHandover(),errorCode('55P03'));
      await first.query('COMMIT');
    }finally{await first.query('ROLLBACK');}
    await assert.rejects(attemptHandover(),sqlFault('OPEN_OR_SCHEDULED_TEST'));
  });

  await t.test('real student attempt writer first: fail fast, then recheck committed active attempt',async sub=>{
    // A distinct demo lets this group have both the scheduled assignment and an immediate one.
    const immediateDraft=await run(first,source,()=>cmd(first,source,'teacher','importTest',
      {title:'Fizika: darhol',duration_seconds:300,questions:[{text:'2+2',options:['1','2','3','4'],correctIndex:3}]}));
    await run(first,source,()=>cmd(first,source,'teacher','publishTest',{testId:immediateDraft.id}));
    const now=Date.now(),remaining=Date.parse(assignmentSchedule(now).closes_at)-now;
    if(remaining<30_000){
      sub.skip('Tashkent admission day closes in under 30 seconds; real attempt needs an open window');
      return;
    }
    const assignment=await run(first,source,()=>cmd(first,source,'teacher','assignTest',
      {groupId:examGroup,testId:immediateDraft.id}));
    await begin(first,student);
    try{
      const attempt=await cmd(first,student,'student','startAttempt',{assignmentId:assignment.id});
      assert.equal(attempt.status,'in_progress');
      await assert.rejects(attemptHandover(),errorCode('55P03'));
      await first.query('COMMIT');
    }finally{await first.query('ROLLBACK');}
    await assert.rejects(attemptHandover(),sqlFault('ACTIVE_TEST_ATTEMPT'));
  });

  await t.test('two Ega owners contend, then retry against new authority; the winner alone can replay its receipt',async()=>{
    const original=await revision(spareGroup), otherRevision=await revision(unrelatedGroup);
    const old=await run(first,source,()=>cmd(first,source,'teacher','createInvite',{groupId:spareGroup}));
    const compete=()=>run(second,ownerB,()=>transfer(second,ownerB,spareGroup,source,destination,original,'second-owner'));
    const winner=client=>transfer(client,ownerA,spareGroup,source,destination,original,'winner');
    let result;
    await begin(first,ownerA);
    try{
      result=await winner(first);
      await assert.rejects(compete(),errorCode('55P03'));
      // Raw lock evidence only; it deliberately shows that the conservative review
      // function also obstructs an unrelated writer, not a production-safe lock.
      await assert.rejects(run(second,source,()=>second.query('UPDATE ua_private.groups SET revision=revision+1 WHERE id=$1',[unrelatedGroup])),
        errorCode('55P03'));
      await first.query('COMMIT');
    }finally{await first.query('ROLLBACK');}
    assert.equal(await revision(unrelatedGroup),otherRevision);
    await assert.rejects(compete(),sqlFault('GROUP_TRANSFER_STALE'));
    assert.deepEqual(await run(second,ownerA,()=>winner(second)),result);
    const rows=(await admin.query(`SELECT a.actor_id,a.command_key,r.response
      FROM ua_private.staff_audit a JOIN ua_private.staff_receipts r ON r.actor_id=a.actor_id AND r.key=a.command_key
      WHERE a.action='transferGroup' AND a.target_id=$1`,[spareGroup])).rows;
    assert.deepEqual(rows,[{actor_id:ownerA,command_key:key(ownerA,'winner'),response:result}]);
    assert.equal(result.revision,(BigInt(original)+1n).toString());
    // Distinct from raw lock evidence: these go through the real cabinet authorization
    // and write code in NEW transactions after the transfer commits (not waiting requests).
    await assert.rejects(run(second,source,()=>cmd(second,source,'teacher','createInvite',{groupId:spareGroup})),errorCode('NOT_FOUND'));
    assert.equal((await run(second,destination,()=>cmd(second,destination,'teacher','createInvite',{groupId:spareGroup}))).groupId,spareGroup);
    await run(second,ownerB,()=>transfer(second,ownerB,spareGroup,destination,source,result.revision,'return'));
    await assert.rejects(run(second,visitor,()=>cmd(second,visitor,'student','acceptInvite',{token:old.token})),errorCode('INVITE_EXPIRED'));
    assert.equal((await admin.query('SELECT expires_at<=clock_timestamp() AS expired FROM ua_cabinet.invites WHERE digest=$1',[digest(old.token)])).rows[0]?.expired,true);
  });

  await t.test('captured revision domain and a post-mutation forced abort preserve group, scope and receipts',async()=>{
    // This is the bound in the checked-in captured catalog, not a live catalog query.
    const max='9007199254740991';
    const original=await revision(unrelatedGroup);
    const transferOther=rev=>transfer(second,ownerA,unrelatedGroup,source,destination,rev,'overflow-or-rollback');
    await assert.rejects(run(second,ownerA,async()=>{
      await second.query('UPDATE ua_private.groups SET revision=$2 WHERE id=$1',[unrelatedGroup,max]);
      await transferOther(max);
    }),sqlFault('GROUP_TRANSFER_REVISION_EXHAUSTED'));
    await assert.rejects(run(second,ownerA,async()=>{
      const result=await transferOther(original);
      assert.equal(result.destinationTeacherId,destination);
      // Force a DB error only AFTER the command has completed all its mutations.
      await second.query('SELECT 1/0');
    }),errorCode('22012'));
    assert.equal(await revision(unrelatedGroup),original);
    assert.deepEqual((await admin.query(`SELECT r.teacher_id,s.person_id FROM ua_cabinet.group_requests r
      JOIN ua_private.staff_group_scope s ON s.group_id=r.id AND revoked_at_ms IS NULL WHERE r.id=$1`,[unrelatedGroup])).rows,
      [{teacher_id:source,person_id:source}]);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM ua_private.staff_receipts WHERE key=$1',
      [key(ownerA,'overflow-or-rollback')])).rows[0].n,0);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM ua_private.staff_audit WHERE command_key=$1',
      [key(ownerA,'overflow-or-rollback')])).rows[0].n,0);
  });
});

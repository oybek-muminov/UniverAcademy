import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createTeacherStagingApi} from '../../runtime/teacher-staging-api.mjs';
import {createCluster,createServiceLogin} from './cluster.mjs';
import {party,provisionStaff,provisionStudent,testClerk} from './credentials.mjs';
import {apiOrigin,studentOrigin,routes,good,rejected,richDocument,graphSvg} from './requests.mjs';

test('teachers delete empty groups and unassigned tests, and archive the ones students already used',async t=>{
  const cluster=await createCluster(),db=cluster.admin;
  let pool;
  t.after(async()=>{try{await pool?.end();}finally{await cluster.close();}});
  const migration=async file=>db.query(await readFile(new URL('../../supabase/migrations/teacher-staging/'+file,import.meta.url),'utf8'));
  await migration('up.sql');
  // The managed installation lets one owner role hold every cabinet table.
  await db.query('ALTER SCHEMA ua_cabinet OWNER TO ua_owner');
  for(const table of ['group_requests','test_owners','media','assignment_media','invites','redemptions','private_starts','invite_delivery'])
    await db.query('ALTER TABLE ua_cabinet.'+table+' OWNER TO ua_owner');
  await migration('draft-edit/001_up.sql');
  await migration('delete-archive/001_up.sql');
  await migration('delete-archive/002_up.sql');
  const database=await createServiceLogin(cluster,'qa_delete_writer',[
    {role:'ua_api_login',inherit:true,set:false},{role:'ua_cabinet_stage',inherit:false,set:true}]);
  pool=new pg.Pool({connectionString:database,max:5});
  const clerk=await testClerk(),teacher=await provisionStaff(db,'Muallim','teacher'),other=await provisionStaff(db,'Muallima','teacher');
  const ali=await provisionStudent(db,'Ali','0101000051',711120051,{clerk}),vali=await provisionStudent(db,'Vali','0101000052',711120052,{clerk});
  const options={enabled:true,pool,teacherOrigin:party,studentOrigin,apiOrigin,verifier:clerk.verifier,liveness:clerk.liveness};
  const api=createTeacherStagingApi(options);
  const own=routes(api,'teacher',await clerk.sign(teacher.subject)),foreign=routes(api,'teacher',await clerk.sign(other.subject));
  const aliApi=routes(api,'student',ali.token);
  const count=async(sql,values=[])=>Number((await db.query(sql,values)).rows[0].n);
  const dashboard=()=>good(own.dashboard());

  // --- groups ---
  const empty=await good(own.command('createGroup',{name:'Bo‘sh'}));
  await rejected(foreign.command('deleteGroup',{groupId:empty.id}),404);
  assert.equal(await count('SELECT count(*) n FROM ua_private.groups WHERE id=$1',[empty.id]),1);
  const key=randomUUID();
  const gone=await good(own.command('deleteGroup',{groupId:empty.id},key));
  assert.equal(gone.outcome,'deleted');
  assert.deepEqual(await good(own.command('deleteGroup',{groupId:empty.id},key)),gone); // a repeated request still answers
  for(const sql of ['SELECT count(*) n FROM ua_private.groups WHERE id=$1','SELECT count(*) n FROM ua_cabinet.group_requests WHERE id=$1',
    'SELECT count(*) n FROM ua_private.staff_group_scope WHERE group_id=$1'])assert.equal(await count(sql,[empty.id]),0);
  assert.equal((await dashboard()).groups.length,0);
  await rejected(own.command('deleteGroup',{groupId:empty.id}),404);

  // A group with students but no test: the students go back to the "no group" list, then it disappears.
  const staffed=await good(own.command('createGroup',{name:'O‘quvchili'}));
  await good(own.command('addMember',{groupId:staffed.id,univeracademy_id:ali.cabinetId}));
  await good(own.command('createInvite',{groupId:staffed.id}));
  assert.equal((await good(own.command('deleteGroup',{groupId:staffed.id}))).outcome,'deleted');
  assert.equal(await count('SELECT count(*) n FROM ua_private.memberships WHERE person_id=$1 AND NOT active AND affinity_group_id IS NULL',[ali.id]),1);
  assert.equal(await count("SELECT count(*) n FROM ua_private.people WHERE id=$1 AND profile->>'active_group_id' IS NULL",[ali.id]),1);
  assert.equal(await count('SELECT count(*) n FROM ua_cabinet.invites'),0);

  // --- tests that were never given to a group ---
  const image=await good(own.upload(graphSvg,'image/svg+xml'));
  const make=async()=>good(own.command('importTest',richDocument(image.id)));
  const draftTest=await make();
  await rejected(foreign.command('deleteTest',{testId:draftTest.id}),404);
  assert.equal((await good(own.command('deleteTest',{testId:draftTest.id}))).outcome,'deleted');
  for(const sql of ['SELECT count(*) n FROM ua_private.test_versions WHERE id=$1','SELECT count(*) n FROM ua_private.draft_questions WHERE version_id=$1',
    'SELECT count(*) n FROM ua_cabinet.test_owners WHERE version_id=$1'])assert.equal(await count(sql,[draftTest.id]),0);
  assert.equal(await count('SELECT count(*) n FROM ua_private.demos'),0);
  const unused=await make();
  await good(own.command('publishTest',{testId:unused.id}));
  assert.equal((await good(own.command('deleteTest',{testId:unused.id}))).outcome,'deleted');
  assert.equal(await count('SELECT count(*) n FROM ua_private.test_versions'),0);

  // A test was given to the group but nobody started it: the group goes away with those unstarted assignments.
  const idle=await good(own.command('createGroup',{name:'Boshlanmagan'}));
  await good(own.command('addMember',{groupId:idle.id,univeracademy_id:vali.cabinetId}));
  const waiting=await make();
  await good(own.command('publishTest',{testId:waiting.id}));
  const unstarted=await good(own.command('assignTest',{testId:waiting.id,groupId:idle.id}));
  assert.equal(await count('SELECT count(*) n FROM ua_private.assignments WHERE group_id=$1',[idle.id]),1);
  assert.equal((await good(own.command('deleteGroup',{groupId:idle.id}))).outcome,'deleted');
  for(const sql of ['SELECT count(*) n FROM ua_private.groups WHERE id=$1','SELECT count(*) n FROM ua_private.assignments WHERE group_id=$1',
    'SELECT count(*) n FROM ua_private.grants WHERE assignment_id=$1'])assert.equal(await count(sql,[sql.includes('grants')?unstarted.id:idle.id]),0);
  assert.equal(await count('SELECT count(*) n FROM ua_private.test_versions WHERE id=$1',[waiting.id]),1);
  assert.equal((await dashboard()).archivedGroups.length,0);
  assert.equal((await good(own.command('deleteTest',{testId:waiting.id}))).outcome,'deleted');

  // --- a group and a test that students already used ---
  const used=await good(own.command('createGroup',{name:'Ishlagan'}));
  await good(own.command('addMember',{groupId:used.id,univeracademy_id:ali.cabinetId}));
  await good(own.command('addMember',{groupId:used.id,univeracademy_id:vali.cabinetId}));
  const real=await make();
  await good(own.command('publishTest',{testId:real.id}));
  const assignment=await good(own.command('assignTest',{testId:real.id,groupId:used.id}));
  const attempt=await good(aliApi.command('startAttempt',{assignmentId:assignment.id}));
  // Nobody can be released while a student is in the middle of the test.
  await rejected(own.command('deleteGroup',{groupId:used.id}),409);
  assert.equal(await count('SELECT count(*) n FROM ua_private.memberships WHERE affinity_group_id=$1 AND active',[used.id]),2);
  const q=attempt.questions[0];
  await good(aliApi.command('saveAnswer',{attemptId:attempt.id,questionId:q.id,optionId:q.options[0].id,expectedRevision:0}));
  await good(aliApi.command('submitAttempt',{attemptId:attempt.id}));
  // The test cannot vanish: it is archived and still shown with its results.
  const archivedTest=await good(own.command('deleteTest',{testId:real.id}));
  assert.equal(archivedTest.outcome,'archived');
  assert.deepEqual(await good(own.command('deleteTest',{testId:real.id},randomUUID())),archivedTest);
  let view=await dashboard();
  assert.equal(view.tests.length,0);
  assert.equal(view.results.length,1);
  assert.equal(view.assignments.length,1);
  for(const action of ['readDraft','previewTest','publishTest'])await rejected(own.command(action,{testId:real.id}),404);
  assert.equal(await count('SELECT count(*) n FROM ua_private.test_versions WHERE id=$1',[real.id]),1);
  assert.equal(await count('SELECT count(*) n FROM ua_cabinet.test_archive WHERE version_id=$1',[real.id]),1);
  // The group with results is archived, its students are free again and results stay readable.
  const archivedGroup=await good(own.command('deleteGroup',{groupId:used.id}));
  assert.equal(archivedGroup.outcome,'archived');
  assert.equal(archivedGroup.status,'archived');
  view=await dashboard();
  assert.deepEqual(view.groups,[]); // no longer among the working groups
  assert.deepEqual(view.archivedGroups.map(g=>g.status),['archived']);
  assert.equal(view.results.length,1);
  assert.equal(await count('SELECT count(*) n FROM ua_private.memberships WHERE affinity_group_id=$1',[used.id]),0);
  assert.equal(await count("SELECT count(*) n FROM ua_private.people WHERE id=ANY($1) AND profile->>'active_group_id' IS NULL",[[ali.id,vali.id]]),2);
  await rejected(own.command('addMember',{groupId:used.id,univeracademy_id:vali.cabinetId}),409);
  assert.equal((await good(own.command('deleteGroup',{groupId:used.id}))).outcome,'archived');
  const fresh=await good(own.command('createGroup',{name:'Yangi'}));
  await good(own.command('addMember',{groupId:fresh.id,univeracademy_id:vali.cabinetId}));

  // The database itself refuses what the application never asks for.
  const probe=await pool.connect();
  const direct=async(person,sql,values)=>{
    await probe.query('BEGIN');
    try{
      await probe.query('SET LOCAL ROLE ua_cabinet_stage');
      await probe.query("SELECT set_config('ua.phase','domain',true),set_config('ua.person_id',$1,true)",[person]);
      return (await probe.query(sql,values)).rowCount;
    }finally{await probe.query('ROLLBACK');}
  };
  try{
    assert.equal(await direct(teacher.id,'DELETE FROM ua_private.test_versions WHERE id=$1',[real.id]),0); // already assigned
    assert.equal(await direct(teacher.id,'DELETE FROM ua_private.demos WHERE id=(SELECT demo_id FROM ua_private.test_versions WHERE id=$1)',[real.id]),0);
    const spare=await make();
    assert.equal(await direct(other.id,'DELETE FROM ua_private.test_versions WHERE id=$1',[spare.id]),0); // not theirs
    assert.equal(await direct(other.id,'DELETE FROM ua_private.groups WHERE id=$1',[fresh.id]),0);
    await db.query('DELETE FROM ua_cabinet.invites');
    // fresh still has Vali, and used has assignments
    assert.equal(await direct(teacher.id,'DELETE FROM ua_private.groups WHERE id=$1',[fresh.id]),0);
    assert.equal(await direct(teacher.id,'DELETE FROM ua_private.groups WHERE id=$1',[used.id]),0);
    assert.equal(await direct(teacher.id,'DELETE FROM ua_private.grants WHERE assignment_id=$1',[assignment.id]),0); // someone started it
    assert.equal(await direct(teacher.id,'DELETE FROM ua_private.assignments WHERE id=$1',[assignment.id]),0);
    assert.equal(await direct(teacher.id,'DELETE FROM ua_private.staff_group_scope WHERE group_id=$1',[used.id]),0);
  }finally{probe.release();}
});

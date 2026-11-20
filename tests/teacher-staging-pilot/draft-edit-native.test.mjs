import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createTeacherStagingApi} from '../../runtime/teacher-staging-api.mjs';
import {createCluster,createServiceLogin} from './cluster.mjs';
import {party,provisionStaff,provisionStudent,testClerk} from './credentials.mjs';
import {apiOrigin,studentOrigin,routes,good,rejected,graphSvg,richDocument} from './requests.mjs';

test('an owner reopens a private rich draft and saves the same version with atomic optimistic concurrency',async t=>{
  const cluster=await createCluster(),db=cluster.admin;
  let pool;
  t.after(async()=>{try{await pool?.end();}finally{await cluster.close();}});
  const migration=async file=>db.query(await readFile(new URL('../../supabase/migrations/teacher-staging/'+file,import.meta.url),'utf8'));
  await migration('up.sql');
  const database=await createServiceLogin(cluster,'qa_draft_writer',[
    {role:'ua_api_login',inherit:true,set:false},{role:'ua_cabinet_stage',inherit:false,set:true}]);
  pool=new pg.Pool({connectionString:database,max:5});
  const clerk=await testClerk(),teacher=await provisionStaff(db,'Muallim','teacher'),other=await provisionStaff(db,'Muallima','teacher');
  const admin=await provisionStaff(db,'Admin','admin'),student=await provisionStudent(db,'O‘quvchi','0101000033',711120022,{clerk});
  const options={enabled:true,pool,teacherOrigin:party,studentOrigin,apiOrigin,verifier:clerk.verifier,liveness:clerk.liveness};
  const api=createTeacherStagingApi(options),staffToken=await clerk.sign(teacher.subject);
  const own=routes(api,'teacher',staffToken),foreign=routes(api,'teacher',await clerk.sign(other.subject));
  const studentApi=routes(api,'student',student.token),adminApi=routes(api,'admin',await clerk.sign(admin.subject));
  const image=await good(own.upload(graphSvg,'image/svg+xml')),file=richDocument(image.id);
  file.grading_config={individual_enabled:true};
  file.instructions_blocks=[{type:'formula',latex:'x^2',display:'inline'}];
  file.questions[0].individual_points='3';
  const draft=await good(own.command('importTest',file));
  // The earlier canonical writer also accepts a JSONB null draft snapshot.
  await db.query(`UPDATE ua_private.test_versions SET published_snapshot='null'::jsonb,revision=revision+1,
    wire=jsonb_set(wire,'{revision}',to_jsonb(revision+1)) WHERE id=$1`,[draft.id]);
  const read=()=>good(own.command('readDraft',{testId:draft.id}));
  const original=await read();
  assert.equal(original.id,draft.id);
  assert.equal(original.revision,draft.revision+1);
  assert.equal(original.draft.questions[0].expected_revision,0);
  assert.equal(original.draft.questions[0].correct_option_id,original.draft.questions[0].options[1].id);
  assert.equal(original.draft.questions[0].prompt_blocks[2].asset_id,image.id);
  assert.equal(original.draft.questions[0].explanation_blocks[0].markdown,'Maxsus o‘qituvchi izohi');
  assert.deepEqual(original.draft.instructions_blocks,file.instructions_blocks);
  assert.deepEqual(original.draft.grading_config,{individual_enabled:true});
  const demoId=(await db.query('SELECT demo_id FROM ua_private.test_versions WHERE id=$1',[draft.id])).rows[0].demo_id;

  // The import predates the additive permission migration; no draft data is rewritten at install.
  await db.query('ALTER SCHEMA ua_cabinet OWNER TO ua_owner');
  await migration('draft-edit/001_up.sql');
  const probe=await pool.connect();
  async function directChanges(person){
    await probe.query('BEGIN');
    try{
      await probe.query('SET LOCAL ROLE ua_cabinet_stage');
      await probe.query("SELECT set_config('ua.phase','domain',true),set_config('ua.person_id',$1,true)",[person]);
      const rename=await probe.query("UPDATE ua_private.demos SET title='probe' WHERE id=$1",[demoId]);
      const removal=await probe.query('DELETE FROM ua_private.draft_questions WHERE version_id=$1',[draft.id]);
      return [rename.rowCount,removal.rowCount];
    }finally{await probe.query('ROLLBACK');}
  }
  try{
    assert.deepEqual(await directChanges(other.id),[0,0]);
    assert.deepEqual(await directChanges(teacher.id),[1,1]);
  }finally{probe.release();}
  const changed=structuredClone(original.draft);
  changed.title='Davomi';changed.duration_seconds=1000;
  const oldQuestion=changed.questions[0];
  oldQuestion.position=2;
  oldQuestion.correct_option_id=oldQuestion.options[0].id;
  const added=richDocument(image.id).questions[0];
  added.individual_points='2';
  changed.questions.unshift(added);
  const write={testId:draft.id,expectedRevision:original.revision,draft:changed},commandKey=randomUUID();
  for(const visitor of [foreign,studentApi,adminApi]){
    await rejected(visitor.command('readDraft',{testId:draft.id}),404);
    await rejected(visitor.command('updateDraft',write),404);
  }
  const foreignImage=await good(foreign.upload(graphSvg,'image/svg+xml'));
  const bad=structuredClone(write);
  bad.draft.questions[0].prompt_blocks[2].asset_id=foreignImage.id;
  await rejected(own.command('updateDraft',bad),422);
  const brokenFormula=structuredClone(write);
  brokenFormula.draft.questions[0].prompt_blocks[1].latex='\\notAFormulaCommandXYZ';
  await rejected(own.command('updateDraft',brokenFormula),422);
  assert.deepEqual(await read(),original);
  const responses=await Promise.all([1,2].map(()=>good(own.command('updateDraft',write,commandKey))));
  assert.deepEqual(responses[0],responses[1]);
  assert.equal(responses[0].revision,original.revision+1);
  assert.equal(responses[0].id,draft.id);
  assert.equal(responses[0].questionCount,2);
  const loaded=await read();
  assert.deepEqual(loaded,{id:draft.id,revision:responses[0].revision,draft:changed});
  const forged={...write,draft:{...changed,title:'Ruxsatsiz almashtirish'}};
  await rejected(own.command('updateDraft',forged,commandKey),409);
  const stale=await own.command('updateDraft',forged);
  assert.equal(stale.status,409);assert.equal((await stale.json()).error.code,'RESOURCE_REVISION_CONFLICT');
  const restarted=routes(createTeacherStagingApi(options),'teacher',staffToken);
  assert.deepEqual(await good(restarted.command('readDraft',{testId:draft.id})),loaded);
  const reduced={...changed,questions:[{...oldQuestion,position:1}]};
  const contenders=['Birinchi','Ikkinchi'].map(title=>({...write,expectedRevision:loaded.revision,draft:{...reduced,title}}));
  const race=await Promise.all(contenders.map(input=>own.command('updateDraft',input)));
  assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
  const latest=await read();
  assert.deepEqual(latest.draft,contenders[race.findIndex(r=>r.ok)].draft);
  assert.equal(latest.revision,loaded.revision+1);
  assert.equal(latest.draft.questions[0].id,original.draft.questions[0].id);
  assert.equal(latest.draft.questions[0].correct_option_id,original.draft.questions[0].options[0].id);
  assert.equal((await db.query('SELECT demo_id FROM ua_private.test_versions WHERE id=$1',[draft.id])).rows[0].demo_id,demoId);
  const finalInput={testId:draft.id,expectedRevision:latest.revision,draft:{...latest.draft,title:'Yakuniy'}};
  await db.query('UPDATE ua_private.teacher_subject_approvals SET revoked_at_ms=1 WHERE person_id=$1',[teacher.id]);
  await rejected(own.command('readDraft',{testId:draft.id}),403);
  await rejected(own.command('updateDraft',write,commandKey),403);
  await db.query('UPDATE ua_private.teacher_subject_approvals SET revoked_at_ms=NULL WHERE person_id=$1',[teacher.id]);

  // A failed receipt/audit commit must restore the old questions, title and revision together.
  await db.query("ALTER TABLE ua_private.staff_audit ADD CONSTRAINT qa_reject_draft CHECK(action<>'updateDraft') NOT VALID");
  try{await rejected(own.command('updateDraft',finalInput),500);}
  finally{await db.query('ALTER TABLE ua_private.staff_audit DROP CONSTRAINT qa_reject_draft');}
  assert.deepEqual(await read(),latest);
  const sibling=randomUUID();
  await db.query(`INSERT INTO ua_private.test_versions(id,demo_id,revision,status,wire,published_snapshot)
    SELECT $2::uuid,demo_id,revision,status,jsonb_set(jsonb_set(wire,'{id}',to_jsonb($2::uuid::text)),'{version_no}','2'),NULL
    FROM ua_private.test_versions WHERE id=$1`,[draft.id,sibling]);
  const rename=await own.command('updateDraft',finalInput);
  assert.equal(rename.status,409);assert.equal((await rename.json()).error.code,'DEMO_TITLE_SHARED');
  assert.deepEqual(await read(),latest);
  await good(own.command('updateDraft',{...finalInput,draft:{...latest.draft,duration_seconds:90}}));
  const published=await good(own.command('publishTest',{testId:draft.id}));
  assert.equal(published.status,'published');
  for(const reply of [await own.command('readDraft',{testId:draft.id}),await own.command('updateDraft',write,commandKey)]){
    assert.equal(reply.status,409);
    assert.equal((await reply.json()).error.code,'VERSION_FROZEN');
  }
  const publicPreview=await good(own.command('previewTest',{testId:draft.id}));
  assert.doesNotMatch(JSON.stringify(publicPreview),/correct_option_id|explanation_blocks/);
  assert.equal((await db.query('SELECT count(*)::int n FROM ua_private.draft_questions WHERE version_id=$1',[draft.id])).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int n FROM ua_cabinet.test_owners WHERE teacher_id=$1',[teacher.id])).rows[0].n,1);
});

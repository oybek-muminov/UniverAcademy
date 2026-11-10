import {test} from "node:test";
import assert from "node:assert/strict";
import {firstTestFixture} from "./fixture.mjs";
import {id,signedInitData} from "../backend/http-fixture.ts";

test("relational first test: fresh registration, Teacher question/duration/publish, Admin roster/assignment, student save/resume/result/history survive restart",async t=>{
  const f=await firstTestFixture(t),person=f.student.profile.person_id,token=f.student.access_token;
  assert.deepEqual(f.read().assignments,{});assert.deepEqual(f.read().questions,{});
  assert.deepEqual((await f.client.exams(token)).data,[]);
  const published=await f.publish();assert.equal(published.id,f.version);assert.equal(published.revision,7);
  const snapshot=structuredClone(f.read().versions[f.version].published_snapshot);
  assert.equal(snapshot.test.questions[0].individualPoints.numerator,"1");
  assert.equal(snapshot.test.questions[0].individualPoints.denominator,"8");
  await f.restart();assert.equal((await f.member()).status,200);assert.equal((await f.member()).status,200);
  assert.equal(f.read().groups[f.group].revision,1);assert.equal(f.read().memberships[person].epoch,1);
  assert.equal((await f.client.me(token)).data.active_group_id,f.group);
  const assigned=await f.assign(published);assert.equal(assigned.status,201,JSON.stringify(assigned));
  assert.deepEqual(await f.assign(published),assigned);const assignment=assigned.json.data;
  assert.equal(assignment.version_id,published.id);assert.equal(f.read().grants[person][assignment.id].grantEpoch,1);
  await f.restart();assert.equal((await f.client.exams(token)).data[0].version_id,published.id);
  const attempt=(await f.client.startAttempt(token,assignment.id,{confirmed:true},"relational-student-start")).data;
  assert.equal(Date.parse(attempt.deadline_at)-Date.parse(attempt.started_at),420000);
  const question=attempt.questions.find(q=>q.id===id(300)),correct=question.options.find(o=>o.blocks[0].markdown==="Yangi A");
  const saved=(await f.client.saveAnswer(token,attempt.id,question.id,{selected_option_id:correct.id,expected_revision:0})).data;
  assert.equal(saved.revision,1);
  await assert.rejects(f.client.saveAnswer(token,attempt.id,question.id,{selected_option_id:null,expected_revision:0}),e=>e.status===409);
  const wire=JSON.stringify({published,assignment,attempt,saved});
  for(const field of ["correctOptionId","correct_option_id","published_snapshot","explanation_blocks","numerator","denominator"])assert.ok(!wire.includes(field),field);
  await f.restart();const resumed=(await f.client.resumeAttempt(token,attempt.id)).data;
  assert.equal(resumed.deadline_at,attempt.deadline_at);assert.equal(resumed.answers[0].revision,1);
  assert.equal(resumed.answers[0].selected_option_id,correct.id);
  const result=(await f.client.submitAttempt(token,attempt.id,"relational-student-submit")).data;
  assert.deepEqual(result.ordinary.display,{earned_points:"0.1",max_points:"0.3",percentage:"50.00"});
  assert.equal(result.statistical_bonus,null);
  await f.restart();assert.deepEqual((await f.client.result(token,attempt.id)).data,result);
  assert.deepEqual((await f.client.history(token,assignment.id)).data.attempts[0].score,result);
  assert.deepEqual(f.read().versions[f.version].published_snapshot,snapshot);
  assert.equal(Object.keys(f.read().staffReceipts).length,6);assert.equal(f.read().staffAudit.length,6);
  assert.equal(f.read().staffProjection,undefined); // No whole staff-state blob or RAM domain loader.
  assert.ok(!f.raw().includes(token));assert.ok(!f.raw().includes(f.actors.teacher.token));
  const events=f.pool.events;assert.ok(events.includes("ua_commit"));
});

test("draft question/metadata failures roll back revision, authored row, receipt and audit",async t=>{
  for(const fail of ["ua_first_version_write","ua_first_question_write","ua_first_receipt_write","ua_first_audit_write"]){
    const f=await firstTestFixture(t),q=f.plan.questions[0],before=f.raw();f.pool.failStatement=fail;
    const r=await f.call("PUT",`${f.versionPath}/questions/${q.id}`,q,"atomic-draft-command");
    assert.equal(r.status,500,fail);assert.equal(f.raw(),before,fail);assert.ok(f.pool.events.includes("ua_rollback"));
    assert.equal((await f.call("PUT",`${f.versionPath}/questions/${q.id}`,q,"atomic-draft-command")).status,200);
    assert.equal(f.read().versions[f.version].revision,4);assert.equal(f.read().staffAudit.length,1);
  }
});

test("membership failures roll back group/member revisions, epoch, person group, receipt and audit",async t=>{
  for(const fail of ["ua_first_group_write","ua_first_membership_write","ua_first_person_group_write","ua_first_receipt_write","ua_first_audit_write"]){
    const f=await firstTestFixture(t),before=f.raw();f.pool.failStatement=fail;
    assert.equal((await f.member()).status,500,fail);assert.equal(f.raw(),before,fail);
    assert.equal((await f.member()).status,200);assert.equal(f.read().staffAudit.length,1);
  }
});

test("assignment/grant/receipt/audit are atomic and retry never duplicates the grant",async t=>{
  for(const fail of ["ua_first_assignment_write","ua_first_grant_write","ua_first_receipt_write","ua_first_audit_write"]){
    const f=await firstTestFixture(t),published=await f.publish();assert.equal((await f.member()).status,200);
    const before=f.raw();f.pool.failStatement=fail;
    assert.equal((await f.assign(published)).status,500,fail);assert.equal(f.raw(),before,fail);
    const first=await f.assign(published);assert.equal(first.status,201);assert.deepEqual(await f.assign(published),first);
    assert.equal(Object.keys(f.read().assignments).length,1);assert.equal(Object.keys(f.read().grants[f.student.profile.person_id]).length,1);
  }
});

test("staff unknown COMMIT returns503, never ACKs/retries; same original command recovers exactly once",async t=>{
  for(const failure of ["before","after"]){
    const f=await firstTestFixture(t);f.pool.failCommit=failure;const r=await f.member();
    assert.equal(r.status,503);assert.equal(r.json.error.code,"SERVICE_UNAVAILABLE");
    assert.equal(f.read().staffAudit.length,failure==="after"?1:0);assert.equal(f.pool.releasedDiscard,true);
    assert.equal((await f.member()).status,200);assert.equal(f.read().staffAudit.length,1);
    assert.equal(f.read().memberships[f.student.profile.person_id].revision,1);
    const published=await f.publish();f.pool.failCommit=failure;
    assert.equal((await f.assign(published)).status,503);
    const recovered=await f.assign(published);assert.equal(recovered.status,201);
    assert.deepEqual(await f.assign(published),recovered);assert.equal(f.read().staffAudit.length,6);
    assert.equal(Object.keys(f.read().assignments).length,1);
  }
});

test("concurrent local draft CAS has one effect; published version is frozen and old receipt replay cannot edit it",async t=>{
  const f=await firstTestFixture(t),q=f.plan.questions[0],url=`${f.versionPath}/questions/${q.id}`;
  const r=await Promise.all([f.call("PUT",url,q,"local-race-key-one"),f.call("PUT",url,q,"local-race-key-two")]);
  assert.deepEqual(r.map(x=>x.status).sort(),[200,409]);assert.equal(f.read().versions[f.version].revision,4);
  const key=r[0].status===200?"local-race-key-one":"local-race-key-two";
  assert.equal((await f.call("PUT",`${f.versionPath}/questions/${f.plan.questions[1].id}`,f.plan.questions[1],"second-question")).status,200);
  assert.equal((await f.call("PATCH",f.versionPath,f.plan.metadata,"metadata-command")).status,200);
  assert.equal((await f.call("POST",f.versionPath+"/publish",f.plan.publish,"publish-command")).status,200);
  const before=f.raw();const replay=await f.call("PUT",url,q,key);
  assert.equal(replay.status,200);assert.equal(replay.json.data.status,"published");assert.equal(f.raw(),before);
  assert.equal((await f.call("PUT",url,{...q,expected_revision:7},"edit-frozen-draft")).status,409);assert.equal(f.raw(),before);
  assert.equal((await f.call("PUT",url,{...q,individual_points:"0.5"},key)).json.error.code,"IDEMPOTENCY_CONFLICT");assert.equal(f.raw(),before);
});

test("Admin A test-only assignment succeeds, roster-only assignment fails, revoked/scope-invalid receipt replay has no effect",async t=>{
  const f=await firstTestFixture(t),published=await f.publish(),admin=f.actors.admin.person;
  assert.equal((await f.member()).status,200);
  f.update(d=>{d.staffAccess[admin].manage_roster=false;});const before=f.raw();
  assert.equal((await f.member()).json.error.code,"CAPABILITY_REQUIRED");assert.equal(f.raw(),before);
  const assignment=await f.assign(published);assert.equal(assignment.status,201);const membership=structuredClone(f.read().memberships);
  for(const [change,status]of [
    [d=>{d.staffAccess[admin].manage_content=false;d.staffAccess[admin].manage_roster=true;},403],
    [d=>{d.staffGroups[admin][0].revoked_at_ms=f.pool.now;},404],
    [d=>{d.staffSubjects[admin][0].revoked_at_ms=f.pool.now;},404],
    [d=>{d.staffAccess[admin].approved=false;},403],
    [d=>{delete d.providerSessions[f.actors.admin.providerSession];},401]]){
    const current=f.read();f.update(change);const denied=f.raw();
    assert.equal((await f.assign(published)).status,status);assert.equal(f.raw(),denied);
    f.update(d=>Object.assign(d,current));
  }
  assert.deepEqual(f.read().memberships,membership);assert.equal(f.read().staffAudit.length,6);
});

test("Teacher approval is current and private questions are not loaded after revoked approval",async t=>{
  const f=await firstTestFixture(t),q=f.plan.questions[0],teacher=f.actors.teacher.person;
  f.update(d=>{d.teacherSubjects[teacher][0].approved=false;});const before=f.raw();f.pool.events.length=0;
  assert.equal((await f.call("PUT",`${f.versionPath}/questions/${q.id}`,q)).status,404);
  assert.equal(f.raw(),before);assert.ok(!f.pool.events.includes("ua_first_questions"));
});

test("resource lock waits refresh DB clock, staff session and permission before private domain reads",async t=>{
  for(const [hook,status]of [
    [(f,d)=>{f.pool.now+=901000;},401],
    [(f,d)=>{delete d.providerSessions[f.actors.teacher.providerSession];},401],
    [(f,d)=>{d.teacherSubjects[f.actors.teacher.person][0].approved=false;},404]]){
    const f=await firstTestFixture(t),before=f.raw(),q=f.plan.questions[0];f.pool.events.length=0;
    f.pool.beforeResourceLock=d=>hook(f,d);
    assert.equal((await f.call("PUT",`${f.versionPath}/questions/${q.id}`,q)).status,status);
    assert.equal(f.raw(),before);assert.ok(!f.pool.events.includes("ua_first_questions"));
    const events=f.pool.events,lock=events.indexOf("ua_first_version_lock");
    assert.ok(events.indexOf("ua_clock",lock+1)>lock);
  }
});

test("assignment stale membership cannot grant; unsupported transfer never falls back to cached/RAM staff state",async t=>{
  const f=await firstTestFixture(t),published=await f.publish();assert.equal((await f.member()).status,200);
  f.update(d=>{d.memberships[f.student.profile.person_id].active=false;});const before=f.raw();
  assert.equal((await f.assign(published)).status,404);assert.equal(f.raw(),before);
  const r=await f.call("POST",`/admin/students/${f.student.profile.person_id}/transfer`,{to_group_id:crypto.randomUUID(),reason:"synthetic",expected_membership_revision:1},"unsupported-transfer","admin");
  assert.equal(r.status,503);assert.equal(f.raw(),before);
});

test("explicit multi-student grants are atomic; another member receives no implicit assignment",async t=>{
  const f=await firstTestFixture(t),published=await f.publish();assert.equal((await f.member()).status,200);
  const extra=[];
  for(const [index,telegram]of [4000000301,4000000302].entries()){
    const session=(await f.client.telegramLogin({init_data:signedInitData(telegram,crypto.randomUUID(),f.pool.now)})).data;
    await f.client.updateProfile(session.access_token,{first_name:"Sintetik",last_name:"Qo‘shimcha"});
    extra.push(session.profile.person_id);
    assert.equal((await f.call("PUT",`/admin/groups/${f.group}/members`,{student_id:session.profile.person_id,status:"active",expected_revision:index+1,expected_membership_revision:0},`extra-membership-${index}`,"admin")).status,200);
  }
  const body={...f.assignmentBody(published),student_ids:[f.student.profile.person_id,extra[0]]};
  const assign=()=>f.call("POST","/admin/assignments",body,"explicit-multi-student","admin");
  const prior=f.pool.extension,before=f.raw();let grants=0;
  f.pool.extension=async(statement,d)=>{
    if(statement.name==="ua_first_grant_write"&&++grants===2)throw Error("SYNTHETIC_SECOND_GRANT_FAILURE");
    return prior(statement,d);
  };
  assert.equal((await assign()).status,500);assert.equal(f.raw(),before);assert.equal(grants,2);
  f.pool.extension=prior;const r=await assign();assert.equal(r.status,201);const assignment=r.json.data.id;
  for(const person of body.student_ids)assert.equal(f.read().grants[person][assignment].grantEpoch,1);
  assert.equal(f.read().grants[extra[1]]?.[assignment],undefined);
  assert.deepEqual(await assign(),r);
});

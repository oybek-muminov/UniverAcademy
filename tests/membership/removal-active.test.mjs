import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { guardRemovalActiveTest, REMOVAL_DECISION as D } from "../../supabase/functions/univeracademy-api/membership-activity.ts";
import { PostgresTransactions, StorageUnavailable } from "../../supabase/functions/univeracademy-api/storage/postgres-transaction.ts";
import { staffFixture, staffIds } from "../backend/staff-fixture.ts";
import { ids, id, clock } from "../backend/http-fixture.ts";
import { seriesKey } from "../../supabase/functions/univeracademy-api/student-state.ts";

// Domain preflight only. Optional traces contain paths, never proof values.
const traces = [], clone = value => structuredClone(value);
function paths(a,b,p="") {
  if(Object.is(a,b))return [];
  if(a&&b&&typeof a==="object"&&typeof b==="object")return [...new Set([...Object.keys(a),...Object.keys(b)])].sort().flatMap(k=>paths(a[k],b[k],`${p}/${k.replaceAll("~","~0").replaceAll("/","~1")}`));
  return [p];
}
function trace(case_id,before,after,extra={}){traces.push({case_id,write_paths:paths(before,after),...extra});}
async function fixture(){
  const f=staffFixture();f.store.state.groups[ids.group].revision=4;
  const {token,attempt}=await f.start();
  assert.equal((await f.studentCall("PUT",`/attempts/${attempt.id}/answers/${ids.question}`,{selected_option_id:ids.correct,expected_revision:0},token)).status,200);
  const deadline=Date.parse(attempt.deadline_at);f.store.time=deadline;
  const context={proof:{kind:"staff_verified",subject:"synthetic-admin",notBefore:clock-1,expiresAt:clock+1_000_000},groupId:ids.group,expectedGroupRevision:4,expectedMembershipRevision:7};
  return {...f,token,attemptId:attempt.id,deadline,context};
}
const run=(f,decision=D.CONTINUE,context=f.context)=>f.store.transaction(tx=>guardRemovalActiveTest(tx,ids.person,decision,context));
// Independent oracle for this fixed two-question/one-correct-answer fixture.
// It calls no production expiry, grading, membership or reconciliation helper.
async function expectedFixtureExpiry(before,now){
  const expected=clone(before);
  for(const [key,series]of Object.entries(before.student.series)){
    if(!key.startsWith(ids.person+"/"))continue;
    const old=before.student.attempts[series.currentAttemptId];
    assert.ok(old);assert.equal(old.id,series.currentAttemptId);assert.equal(old.generation,series.generation);
    if(old.status!=="in_progress"||now<old.deadlineAt)continue;
    assert.equal(old.published.individualEnabled,false);
    assert.deepEqual(old.published.questions.map(q=>q.id),[id(100),id(101)]);
    assert.equal(old.answers.length,1);assert.equal(old.answers[0].selectedOptionId,ids.correct);
    expected.student.attempts[old.id]={...old,status:"expired",completedAt:old.deadlineAt,
      stateRevision:old.stateRevision+1,seriesStateRevision:old.seriesStateRevision+1,
      ordinary:{earned:{numerator:1n,denominator:1n},maximum:{numerator:2n,denominator:1n},
        percentage:{numerator:50n,denominator:1n},calculatedAt:now}};
    const next=expected.student.series[key];next.officialAttemptId=old.id;
    if(old.generation>1){next.recoveryState="none";next.recovery=null;}
    const assignment=expected.student.assignments[old.assignmentId];assert.ok(now>=assignment.admission.closesAt);
    Object.assign(assignment.reviewGate,{eligible_unresolved_count:0,active_count:0,recovery_ready_count:0,
      barrier_complete:true,barrier_revision:before.student.assignments[old.assignmentId].reviewGate.barrier_revision+1});
  }
  return expected;
}
function saved(before,after,id){
  const a=before.student.attempts[id],b=after.student.attempts[id];
  assert.deepEqual(b.answers,a.answers);assert.equal(b.deadlineAt,a.deadlineAt);assert.deepEqual(b.questionOrder,a.questionOrder);assert.equal(b.generation,a.generation);
}

test("CF-01: CONTINUE cannot bypass a current active attempt",async()=>{
  const f=await fixture();f.store.time=f.deadline-1;const before=clone(f.store.state);
  assert.deepEqual(await run(f),{kind:"wait_for_active_test"});assert.deepEqual(f.store.state,before);trace("CF-01",before,f.store.state);
});
for(const [name,offset]of [["CF-02",0],["CF-03",1]])test(`${name}: deadline equality/after commits canonical E(a) only`,async()=>{
  const f=await fixture();f.store.time=f.deadline+offset;const before=clone(f.store.state),expected=await expectedFixtureExpiry(before,f.store.time);
  assert.equal(await run(f),D.CONTINUE);assert.deepEqual(f.store.state,expected);saved(before,f.store.state,f.attemptId);
  assert.equal(f.store.state.student.attempts[f.attemptId].status,"expired");trace(name,before,f.store.state,{canonical_E_paths:paths(before,expected)});
});
test("CF-04: submitted attempt produces no writes or queued continuation",async()=>{
  const f=await fixture();f.store.time=clock;assert.equal((await f.studentCall("POST",`/attempts/${f.attemptId}/submit`,undefined,f.token)).status,200);
  const before=clone(f.store.state);assert.equal(await run(f),D.CONTINUE);assert.deepEqual(f.store.state,before);trace("CF-04",before,f.store.state);
});
for(const [name,field,denied]of [["W02","expectedGroupRevision",D.DENY_GROUP_REVISION],["W03","expectedMembershipRevision",D.DENY_MEMBERSHIP_REVISION]])for(const hint of ["continue","matching-denial"]){
  test(`${name}-${hint}: authoritative clean CAS denial commits E(a) only`,async()=>{
    const f=await fixture(),context={...f.context,[field]:f.context[field]-1},before=clone(f.store.state),expected=await expectedFixtureExpiry(before,f.store.time);
    assert.equal(await run(f,hint==="continue"?D.CONTINUE:denied,context),denied);assert.deepEqual(f.store.state,expected);saved(before,f.store.state,f.attemptId);
    trace(`${name}-${hint}`,before,f.store.state,{reason:denied.reason,canonical_E_paths:paths(before,expected)});
  });
}
test("CF-05: group CAS precedes member CAS; CONTINUE cannot bypass either",async()=>{
  const f=await fixture(),before=clone(f.store.state);
  assert.equal(await run(f,D.CONTINUE,{...f.context,expectedGroupRevision:3,expectedMembershipRevision:6}),D.DENY_GROUP_REVISION);
  assert.deepEqual(f.store.state,await expectedFixtureExpiry(before,f.deadline));trace("CF-05",before,f.store.state);
});
test("CF-06: false or stale denial singleton fails before maintenance",async()=>{
  const f=await fixture(),before=clone(f.store.state);
  await assert.rejects(run(f,D.DENY_MEMBERSHIP_REVISION),e=>e.code==="RESPONSE_INVARIANT_FAILED"&&e.status===500);
  assert.deepEqual(f.store.state,before);trace("CF-06",before,f.store.state);
});
test("CF-07: lock-wait changes to authoritative CAS/time are observed",async()=>{
  const f=await fixture();f.store.time=f.deadline-1;f.store.events=[];let before;
  f.store.beforeWork=async()=>{f.store.time=f.deadline;f.store.state.groups[ids.group].revision++;before=clone(f.store.state);f.store.events.push("lock-wait-ended");};
  assert.equal(await run(f),D.DENY_GROUP_REVISION);assert.deepEqual(f.store.state,await expectedFixtureExpiry(before,f.deadline));
  assert.deepEqual(f.store.events,["lock","lock-wait-ended","clock","commit"]);trace("CF-07",before,f.store.state,{events:f.store.events});
});
for(const [name,change,status,code]of [
  ["disabled",f=>{f.store.state.staff["synthetic-admin"].enabled=false;},403,"ACCOUNT_DISABLED"],
  ["capability",f=>{f.store.state.staff["synthetic-admin"].capabilities.manage_roster=false;},403,"CAPABILITY_REQUIRED"],
  ["scope",f=>{f.store.state.staff["synthetic-admin"].scope.group_ids=[];},404,"NOT_FOUND"],
  ["teacher",f=>{f.context.proof.subject="synthetic-teacher";},403,"FORBIDDEN"],
  ["expired-proof",f=>{f.context.proof.expiresAt=f.deadline;},401,"STAFF_TOKEN_INVALID"],
  ["wrong-group",f=>{f.context.groupId=staffIds.targetGroup;},404,"NOT_FOUND"],
])test(`AUTH-${name}: authorization/privacy precedes E(a)`,async()=>{
  const f=await fixture();change(f);const before=clone(f.store.state);
  await assert.rejects(run(f),e=>e.status===status&&e.code===code);assert.deepEqual(f.store.state,before);trace(`AUTH-${name}`,before,f.store.state,{status,code});
});
test("CF-08: unstarted ready recovery remains unchanged for later policy",async()=>{
  for(const offset of [1000,-1000]){
    const f=await fixture();f.store.time=clock;assert.equal((await f.studentCall("POST",`/attempts/${f.attemptId}/submit`,undefined,f.token)).status,200);
    const series=f.store.state.student.series[seriesKey(ids.person,ids.demo)];series.recoveryState="ready";
    series.recovery={opensAt:clock+offset-500,closesAt:clock+offset,durationMs:500};const before=clone(f.store.state);
    assert.equal(await run(f),D.CONTINUE);assert.deepEqual(f.store.state,before);trace(`CF-08:${offset}`,before,f.store.state);
  }
});
for(const [name,offset]of [["active",-1],["expired",0]])test(`RECOVERY-${name}: current started recovery keeps existing completion semantics`,async()=>{
  const f=await fixture(),s=f.store.state,series=s.student.series[seriesKey(ids.person,ids.demo)];
  s.student.attempts[f.attemptId]={...s.student.attempts[f.attemptId],generation:2};series.generation=2;series.recoveryState="active";
  series.recovery={opensAt:clock-1,closesAt:f.deadline+1,durationMs:60000};f.store.time=f.deadline+offset;const before=clone(s);
  assert.deepEqual(await run(f),offset<0?{kind:"wait_for_active_test"}:D.CONTINUE);assert.deepEqual(f.store.state,await expectedFixtureExpiry(before,f.store.time));
  saved(before,f.store.state,f.attemptId);trace(`RECOVERY-${name}`,before,f.store.state);
});
test("CURRENT-01: foreign and historical generations stay equal while current target expires",async()=>{
  const f=await fixture(),s=f.store.state,original=clone(s.student.attempts[f.attemptId]),oldId=id(990),foreignId=id(991);
  s.student.attempts[oldId]={...clone(original),id:oldId,deadlineAt:f.deadline-1000};s.student.attempts[f.attemptId]={...clone(original),generation:2};
  s.student.series[seriesKey(ids.person,ids.demo)].generation=2;s.student.attempts[foreignId]={...clone(original),id:foreignId,personId:ids.other,deadlineAt:f.deadline-1000};
  const before=clone(s);assert.equal(await run(f),D.CONTINUE);assert.deepEqual(f.store.state,await expectedFixtureExpiry(before,f.deadline));
  assert.deepEqual(f.store.state.student.attempts[oldId],before.student.attempts[oldId]);assert.deepEqual(f.store.state.student.attempts[foreignId],before.student.attempts[foreignId]);trace("CURRENT-01",before,f.store.state);
});
for(const name of ["wrong-generation","missing-record","missing-series"])test(`CURRENT-${name}: incomplete authoritative context fails closed`,async()=>{
  const f=await fixture(),s=f.store.state,sk=seriesKey(ids.person,ids.demo);
  if(name==="wrong-generation")s.student.series[sk].generation++;else if(name==="missing-record")delete s.student.attempts[f.attemptId];else delete s.student.series[sk];
  const before=clone(s);await assert.rejects(run(f),e=>e.code==="RESPONSE_INVARIANT_FAILED");assert.deepEqual(f.store.state,before);trace(`CURRENT-${name}`,before,f.store.state);
});

// These are actual set-operation counters on the stated maintenance nodes,
// distinct from the supplementary before/after path diff. They are not global
// transient-write instrumentation or a database trace.
async function rejectIdContext(f,caseId,details={}){
  const S0=clone(f.store.state),writes={attemptMap:0,series:0,gate:0};
  const watch=(object,key)=>new Proxy(object,{set(target,field,value){writes[key]++;return Reflect.set(target,field,value);}});
  await assert.rejects(f.store.transaction(tx=>{
    tx.state.student.attempts=watch(tx.state.student.attempts,"attemptMap");
    for(const [key,series]of Object.entries(tx.state.student.series))tx.state.student.series[key]=watch(series,"series");
    for(const assignment of Object.values(tx.state.student.assignments))assignment.reviewGate=watch(assignment.reviewGate,"gate");
    return guardRemovalActiveTest(tx,ids.person,D.CONTINUE,f.context);
  }),e=>e.code==="RESPONSE_INVARIANT_FAILED"&&e.status===500);
  assert.deepEqual(f.store.state,S0);assert.deepEqual(writes,{attemptMap:0,series:0,gate:0});
  trace(caseId,S0,f.store.state,{...details,now:f.store.time,deadline:f.deadline,technical_error:"RESPONSE_INVARIANT_FAILED",maintenance_node_set_operations:writes,
    counter_scope:"Only attempt-map, series-field and review-gate set operations in this test"});
}
for(const [name,offset]of [["BEFORE",-1],["EQUALITY",0],["AFTER",1]])test(`C04-IDKEY-${name}: malformed key/value ID rejects before maintenance`,async()=>{
  const f=await fixture(),B=id(999);assert.notEqual(f.attemptId,B);
  f.store.state.student.attempts[f.attemptId]={...f.store.state.student.attempts[f.attemptId],id:B};
  f.store.time=f.deadline+offset;await rejectIdContext(f,`C04-IDKEY-${name}`);
});
test("C04-IDKEY-MIXED: valid elapsed series first cannot partially maintain before invalid current ID rejection",async()=>{
  const f=await fixture();f.store.time=clock;
  const other=f.store.state.student.assignments[staffIds.future];other.admission.opensAt=clock-1000;other.admission.closesAt=clock+1000;
  const started=await f.studentCall("POST",`/exams/${staffIds.future}/attempts`,{confirmed:true},f.token);assert.equal(started.status,200);
  const C=started.json.data.id;assert.equal((await f.studentCall("PUT",`/attempts/${C}/answers/${ids.question}`,{selected_option_id:ids.correct,expected_revision:0},f.token)).status,200);
  const s=f.store.state,otherKey=seriesKey(ids.person,s.student.attempts[C].published.demoId),ownKey=seriesKey(ids.person,ids.demo);
  assert.equal(s.student.series[otherKey].currentAttemptId,C);assert.equal(s.student.attempts[C].id,C);
  s.student.attempts[f.attemptId]={...s.student.attempts[f.attemptId],id:id(999)};
  s.student.series={[otherKey]:s.student.series[otherKey],[ownKey]:s.student.series[ownKey]};
  s.student.attempts={[C]:s.student.attempts[C],[f.attemptId]:s.student.attempts[f.attemptId]};
  f.store.time=f.deadline+1;assert.ok(s.student.attempts[C].deadlineAt<f.store.time);
  await rejectIdContext(f,"C04-IDKEY-MIXED",{validation_order:Object.keys(s.student.series),attempt_order:Object.keys(s.student.attempts),valid_elapsed_attempt:C,invalid_map_key:f.attemptId,invalid_record_id:id(999)});
});

test("IDENTITY-FIRST: hostile payloads cause no property, context, clock, call or thenable hooks",async()=>{
  const hooks={get:0,call:0,context:0,clock:0};
  const handler={get(){hooks.get++;throw Error("PAYLOAD_GET");},ownKeys(){hooks.get++;throw Error("OWN_KEYS");},getPrototypeOf(){hooks.get++;throw Error("PROTOTYPE");},apply(){hooks.call++;throw Error("CALL");}};
  const revoked=Proxy.revocable({},handler);revoked.revoke();const callable=()=>{hooks.call++;};
  const values=[
    ["getter",{get kind(){hooks.get++;throw Error("GETTER");}}],["proxy",new Proxy({},handler)],["revoked-proxy",revoked.proxy],
    ["callable",callable],["callable-proxy",new Proxy(callable,handler)],["thenable",{get then(){hooks.get++;throw Error("THENABLE");}}],
    ["lookalike",{...D.DENY_GROUP_REVISION}],["arbitrary409",{ok:false,status:409}],["wrapped-singleton",new Proxy(D.CONTINUE,handler)],
    ["coercible",{[Symbol.toPrimitive](){hooks.get++;throw Error("COERCION");}}],
  ];
  for(const [name,value]of values){
    const tx={get now(){hooks.clock++;throw Error("CLOCK_EARLY");}},context=new Proxy({},{get(){hooks.context++;throw Error("CONTEXT_EARLY");}});
    await assert.rejects(guardRemovalActiveTest(tx,ids.person,value,context),e=>e.code==="RESPONSE_INVARIANT_FAILED"&&e.status===500);
    assert.deepEqual(hooks,{get:0,call:0,context:0,clock:0});traces.push({case_id:`IDENTITY-FIRST:${name}`,write_paths:[],hooks:clone(hooks),classification:"PRE_EXECUTION_REJECTION"});
  }
});
for(const attack of ["old-six-writes","write-restore","nested-raw-alias","external-writer"])test(`REJECT-${attack}: callback capability never executes or starts maintenance`,async()=>{
  const f=await fixture(),before=clone(f.store.state);let calls=0,externalWrites=0,reconciles=0,guardClockReads=0,guardStateReads=0;
  await assert.rejects(f.store.transaction(tx=>{
    const raw=tx.state.memberships[ids.person],callback=async()=>{
      calls++;
      if(attack==="external-writer")externalWrites++;
      else if(attack==="old-six-writes"){
        raw.active=false;raw.epoch++;tx.state.student.people[ids.person].profile.active_group_id=null;tx.state.student.grants[ids.person][ids.assignment].rostered=false;
        tx.state.receipts.scratch={payload:"denied"};tx.state.audit.push({actorId:staffIds.admin,action:"must_not_run",targetId:ids.person,revision:8,at:clock});
      }else{raw.active=false;raw.active=true;}
      return {ok:false,status:409};
    };
    const payload=attack==="old-six-writes"?async()=>{reconciles++;}:callback;
    const boundary={get state(){guardStateReads++;return tx.state;},now(){guardClockReads++;return tx.now();}};
    return guardRemovalActiveTest(boundary,ids.person,payload,attack==="old-six-writes"?callback:f.context);
  }),e=>e.code==="RESPONSE_INVARIANT_FAILED"&&e.status===500);
  assert.equal(calls,0);assert.equal(externalWrites,0);assert.equal(reconciles,0);assert.equal(guardClockReads,0);assert.equal(guardStateReads,0);assert.deepEqual(f.store.state,before);
  assert.equal(f.store.state.student.attempts[f.attemptId].status,"in_progress");
  trace(`REJECT-${attack}`,before,f.store.state,{calls,externalWrites,reconciles,guardClockReads,guardStateReads,classification:"PRE_EXECUTION_REJECTION_NOT_POST_WRITE_ROLLBACK"});
});
test("CLOCK: invalid post-lock time fails closed",async()=>{
  for(const now of [-1,0.5,NaN,Infinity,8_640_000_000_000_001]){
    const f=await fixture();f.store.time=now;const before=clone(f.store.state);await assert.rejects(run(f),e=>e.code==="SERVICE_UNAVAILABLE");assert.deepEqual(f.store.state,before);
  }
});
for(const name of ["canonical-score","internal-reconciliation"])test(`EXCEPTION-${name}: technical maintenance failure rolls back E(a)`,async()=>{
  const f=await fixture();if(name==="canonical-score")f.store.state.student.attempts[f.attemptId].published.durationMs=0;
  else f.store.state.student.assignments[ids.assignment].reviewGate.barrier_revision=-1;
  const before=clone(f.store.state);await assert.rejects(run(f),e=>e instanceof Error);assert.deepEqual(f.store.state,before);trace(`EXCEPTION-${name}`,before,f.store.state,{classification:"TECHNICAL_ROLLBACK"});
});

// Actual coordinator, recording pool only. No SQL/socket or real COMMIT proof.
function poolDouble(initial,now,mode){
  let durable=clone(initial),staged;const counts={connect:0,commit:0,rollback:0},events=[];
  const client={async query(q){
    events.push(q.name);
    if(q.name==="ua_people_lock")return {rows:q.values[0].map(id=>({id})),rowCount:q.values[0].length};
    if(q.name==="ua_clock")return {rows:[{now_ms:String(now)}],rowCount:1};
    if(q.name==="ua_commit"){counts.commit++;if(mode==="before")throw Error("SYNTHETIC_COMMIT_BEFORE");durable=clone(staged);if(mode==="after")throw Error("SYNTHETIC_COMMIT_AFTER");}
    if(q.name==="ua_rollback"){counts.rollback++;staged=undefined;}return {rows:[],rowCount:0};
  },release(discard){events.push({release_discard:discard});}};
  return {connect:async()=>{counts.connect++;return client;},read:()=>clone(durable),stage:s=>{staged=clone(s);},counts,events};
}
function coordinated(pool,context,afterGuard){
  return new PostgresTransactions(pool).run([ids.person],async locked=>{
    const state=pool.read(),result=await guardRemovalActiveTest({state,now:()=>locked.now},ids.person,D.CONTINUE,context);
    pool.stage(state);if(afterGuard)await afterGuard();return result;
  });
}
for(const mode of ["before","after"])test(`COMMIT-${mode}: ACK loss stays unknown with no ACK, rollback claim or retry`,async()=>{
  const f=await fixture(),before=clone(f.store.state),pool=poolDouble(before,f.deadline,mode);let ack=0,error;
  try{await coordinated(pool,f.context);ack++;}catch(caught){error=caught;}
  assert.ok(error instanceof StorageUnavailable);assert.equal(error.outcome,"commit_unknown");assert.equal(error.status,503);assert.equal(ack,0);
  assert.deepEqual(pool.counts,{connect:1,commit:1,rollback:0});assert.deepEqual(pool.events.at(-1),{release_discard:true});
  assert.deepEqual(pool.read(),mode==="before"?before:await expectedFixtureExpiry(before,f.deadline));
  trace(`COMMIT-${mode}`,before,pool.read(),{ack,automatic_retries:0,outcome:error.outcome,counts:pool.counts,real_postgres:"NOT_RUN"});
});
for(const name of ["ordinary","storage"])test(`ROLLBACK-${name}: exception identity survives, never becomes a clean denial`,async()=>{
  const f=await fixture(),before=clone(f.store.state),pool=poolDouble(before,f.deadline,"ok"),fault=name==="ordinary"?Error("SYNTHETIC_FLUSH_FAILURE"):new StorageUnavailable("not_committed");let error,value;
  try{value=await coordinated(pool,f.context,async()=>{throw fault;});}catch(caught){error=caught;}
  assert.equal(error,fault);assert.equal(value,undefined);assert.deepEqual(pool.read(),before);assert.deepEqual(pool.counts,{connect:1,commit:0,rollback:1});
  trace(`ROLLBACK-${name}`,before,pool.read(),{exception_identity_preserved:true,counts:pool.counts});
});
test("REPEAT: completion/ordinary are created once and later explicit checks write nothing",async()=>{
  const f=await fixture(),original=clone(f.store.state);let first;
  for(let n=0;n<3;n++){
    f.store.time=f.deadline+n*100;const before=clone(f.store.state);assert.equal(await run(f),D.CONTINUE);
    if(n===0)first=clone(f.store.state);else assert.deepEqual(f.store.state,first);saved(original,f.store.state,f.attemptId);trace(`REPEAT:${n+1}`,before,f.store.state);
  }
  assert.equal(f.store.state.student.attempts[f.attemptId].stateRevision,original.student.attempts[f.attemptId].stateRevision+1);
});
// R03: literal corruption fixture adapted from the coordinator-delivered QA
// excerpt, not the original QA common.mjs bytes. No start/scoring/expiry helper
// constructs this state or its expected outcome. Bigints remain exact.
const r03A=id(900),r03B=id(901),r03T=clock+60000,r03K=seriesKey(ids.person,ids.demo);
const r03SourceURL=new URL("../../supabase/functions/univeracademy-api/membership-activity.ts",import.meta.url);
const r03SHA=createHash("sha256").update(readFileSync(r03SourceURL)).digest("hex");
const r03TestSHA=createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
const r03Rows=[];
function r03Fixture(){
  const published={demoId:ids.demo,versionId:id(30),durationMs:60000,individualEnabled:false,questions:[
    {id:id(100),optionIds:[id(200),id(201),id(202),id(203)],correctOptionId:id(200),individualPoints:{numerator:5n,denominator:2n}},
    {id:id(101),optionIds:[id(204),id(205),id(206),id(207)],correctOptionId:id(204),individualPoints:{numerator:5n,denominator:2n}}]};
  const record={id:r03A,personId:ids.person,assignmentId:ids.assignment,groupId:ids.group,generation:1,status:"in_progress",
    startedAt:clock,deadlineAt:r03T,completedAt:null,stateRevision:2,seriesStateRevision:2,published,
    questionOrder:published.questions.map(q=>({questionId:q.id,optionIds:[...q.optionIds]})),
    answers:[{questionId:id(100),selectedOptionId:id(200),revision:1,savedAt:clock,seriesStateRevision:2}],ordinary:null};
  return {student:{
    people:{[ids.person]:{telegramId:4000000001,enabled:true,profile:{person_id:ids.person,roles:["student"],registration_complete:true,
      active_group_id:ids.group,first_name:"QA",last_name:"Synthetic",qadam_id:"0100000001"}}},
    families:{},access:{},refresh:{},consumedInitData:{},grants:{[ids.person]:{[ids.assignment]:{rostered:true,membershipEpoch:7,grantEpoch:7}}},
    assignments:{[ids.assignment]:{admission:{assignmentId:ids.assignment,groupId:ids.group,activeGroupId:ids.group,
      rostered:true,profileComplete:true,membershipEpoch:7,grantEpoch:7,opensAt:clock-1000,closesAt:clock+1000},
      published:clone(published),title:"Independent literal QA",instructions:[],contents:{},cancelled:false,
      reviewGate:{id:id(50),status:"blocked",revision:0,barrier_revision:0,barrier_complete:false,eligible_unresolved_count:1,
        active_count:0,recovery_ready_count:0,timezone:"Asia/Tashkent",first_opened_at:null,opens_at:null,closes_at:null}}},
    series:{[r03K]:{currentAttemptId:r03A,generation:1,normalAttemptUsed:true,officialAttemptId:null,recoveryState:"none",recovery:null}},
    attempts:{[r03A]:record},receipts:{preserve:{payload:"student-sentinel"}},bonuses:{preserve:{marker:7n}},cancellations:{}},
    staff:{"synthetic-admin":{personId:id(501),enabled:true,approved:true,roles:["admin"],approvedSubjectIds:["physics"],
      capabilities:{manage_roster:true,manage_content:true},scope:{all_groups:false,group_ids:[ids.group],all_subjects:false,subject_ids:["physics"]}}},
    groups:{[ids.group]:{id:ids.group,revision:4}},memberships:{[ids.person]:{affinityGroupId:ids.group,active:true,revision:7,epoch:7}},
    versions:{},recoveryAssignments:{},notifications:{preserve:{studentId:ids.person,assignmentId:ids.assignment,epoch:7,status:"queued"}},
    approvals:{preserve:{studentId:ids.person,epoch:7,status:"pending"}},receipts:{preserve:{payload:"staff-sentinel"}},
    audit:[{actorId:id(501),action:"preserve",targetId:ids.person,revision:7,at:clock}]};
}
const r03Context=()=>({proof:{kind:"staff_verified",subject:"synthetic-admin",notBefore:clock-1,expiresAt:clock+1000000},
  groupId:ids.group,expectedGroupRevision:4,expectedMembershipRevision:7});
const r03Ordinary=(earned,percentage,calculatedAt)=>({earned:{numerator:BigInt(earned),denominator:1n},
  maximum:{numerator:2n,denominator:1n},percentage:{numerator:BigInt(percentage),denominator:1n},calculatedAt});
function r03Corrupt(){const s=r03Fixture();s.student.attempts[r03A].ordinary=r03Ordinary(2,100,r03T-50);return s;}

// Test-only recursive write-operation observation, including same-value sets.
// This observes reachable JS state writes, not SQL, hidden/external writers, or
// property reads. Profiler function call counts below are a separate mechanism.
function r03Watch(raw){
  const cache=new WeakMap(),reverse=new WeakMap(),writes=[];
  function strip(v,seen=new WeakSet()){
    if(!v||typeof v!=="object")return v;if(reverse.has(v))return reverse.get(v);if(seen.has(v))return v;seen.add(v);
    for(const k of Reflect.ownKeys(v)){const d=Reflect.getOwnPropertyDescriptor(v,k);if(d&&"value"in d){const x=strip(d.value,seen);if(x!==d.value)Reflect.defineProperty(v,k,{...d,value:x});}}
    return v;
  }
  function wrap(v,path){
    if(!v||typeof v!=="object")return v;if(cache.has(v))return cache.get(v);
    const note=(op,key)=>writes.push({op,path:path+"/"+String(key)});
    const proxy=new Proxy(v,{
      get(t,k){return wrap(Reflect.get(t,k,t),path+"/"+String(k));},
      set(t,k,value){note("set",k);return Reflect.set(t,k,strip(value),t);},
      defineProperty(t,k,d){note("defineProperty",k);return Reflect.defineProperty(t,k,{...d,...("value"in d?{value:strip(d.value)}:{})});},
      deleteProperty(t,k){note("delete",k);return Reflect.deleteProperty(t,k);},
      setPrototypeOf(t,v){note("setPrototypeOf","");return Reflect.setPrototypeOf(t,v);},
      preventExtensions(t){note("preventExtensions","");return Reflect.preventExtensions(t);},
    });cache.set(v,proxy);reverse.set(proxy,v);return proxy;
  }
  return {state:wrap(raw,""),writes};
}
async function r03Observe(s,caseId,{now=r03T,context=r03Context(),decision=D.CONTINUE}={}){
  const started=new Date().toISOString(),draft=clone(s),w=r03Watch(draft),session=new Session();
  const names={guardRemovalActiveTest:"guard",checkCurrentAttemptContext:"context",materializeElapsedAttempts:"maintenance",
    reconcileMembershipEffects:"reconcile",hasActiveAttempt:"active"};
  const calls={guard:0,context:0,maintenance:0,reconcile:0,active:0},functions=[];
  let value,error,clockReads=0,stateReads=0,guardInvocations=0;
  session.connect();
  try{
    await session.post("Profiler.enable");await session.post("Profiler.startPreciseCoverage",{callCount:true,detailed:true});
    await session.post("Profiler.takePreciseCoverage");
    try{guardInvocations++;value=await guardRemovalActiveTest({get state(){stateReads++;return w.state;},now(){clockReads++;return now;}},ids.person,decision,context);}
    catch(caught){error=caught;}
    const coverage=await session.post("Profiler.takePreciseCoverage"),prefix=new URL("../../supabase/",import.meta.url).href;
    for(const script of coverage.result)if(script.url.startsWith(prefix))for(const f of script.functions)if(names[f.functionName]){
      calls[names[f.functionName]]+=f.ranges[0].count;functions.push({name:f.functionName,count:f.ranges[0].count});
    }
  }finally{await session.post("Profiler.stopPreciseCoverage");session.disconnect();}
  const committed=error?clone(s):draft;
  const row={case_id:caseId,order:{series:Object.keys(s.student.series),attempts:Object.keys(s.student.attempts)},
    source_sha256:r03SHA,test_sha256:r03TestSHA,started_utc:started,finished_utc:new Date().toISOString(),now,
    command:[process.execPath,...process.execArgv,...process.argv.slice(1)],
    outcome:error?{code:error.code,status:error.status}:value,
    observed_function_entry_counts:calls,coverage_functions:functions,guard_invocations:guardInvocations,
    coverage_limit:"V8 async function entry counts can include resume; guard_invocations counts direct calls separately",
    clockReads,stateReads,state_write_attempts:w.writes.length,
    observed_state_writes:w.writes,staged_net_diff:paths(s,draft),committed_net_diff:paths(s,committed),
    commit_scope:"LOCAL_DOMAIN_DOUBLE_ONLY_NOT_SQL_COMMIT"};
  r03Rows.push(row);assert.equal(guardInvocations,1);return {value,error,draft,committed,writes:w.writes,calls,row};
}
async function r03Reject(s,name,options={}){
  const before=clone(s),r=await r03Observe(s,name,options);
  assert.equal(r.error?.code,"RESPONSE_INVARIANT_FAILED");assert.equal(r.error?.status,500);assert.equal(r.value,undefined);
  assert.deepEqual(r.draft,before);assert.deepEqual(r.committed,before);assert.deepEqual(s,before);
  assert.deepEqual(r.calls,{guard:1,context:1,maintenance:0,reconcile:0,active:0});assert.equal(r.writes.length,0);
}
for(const [name,offset]of [["BEFORE",-1],["EQUALITY",0],["AFTER",1]])test(`R03-${name}: existing ordinary rejects before any maintenance`,async()=>{
  await r03Reject(r03Corrupt(),`R03-${name}`,{now:r03T+offset});
});
for(const seriesValidFirst of [true,false])for(const attemptsValidFirst of [true,false])test(`R03-MIXED seriesValidFirst=${seriesValidFirst} attemptsValidFirst=${attemptsValidFirst}`,async()=>{
  const s=r03Corrupt(),J=id(11),demo=id(21),key=seriesKey(ids.person,demo);
  const record={...clone(s.student.attempts[r03A]),id:r03B,assignmentId:J,published:{...clone(s.student.attempts[r03A].published),demoId:demo,versionId:id(31)},deadlineAt:r03T-100,ordinary:null};
  const series={...clone(s.student.series[r03K]),currentAttemptId:r03B};
  const assignment=clone(s.student.assignments[ids.assignment]);Object.assign(assignment.admission,{assignmentId:J});
  assignment.published=clone(record.published);assignment.reviewGate.id=id(51);s.student.assignments[J]=assignment;
  s.student.grants[ids.person][J]={rostered:true,membershipEpoch:7,grantEpoch:7};
  s.student.series=seriesValidFirst?{[key]:series,[r03K]:s.student.series[r03K]}:{[r03K]:s.student.series[r03K],[key]:series};
  s.student.attempts=attemptsValidFirst?{[r03B]:record,[r03A]:s.student.attempts[r03A]}:{[r03A]:s.student.attempts[r03A],[r03B]:record};
  await r03Reject(s,`R03-MIXED:${seriesValidFirst}:${attemptsValidFirst}`);
});
for(const [name,field,denial]of [["GROUP","expectedGroupRevision",D.DENY_GROUP_REVISION],["MEMBER","expectedMembershipRevision",D.DENY_MEMBERSHIP_REVISION]])for(const hint of [false,true])test(`R03-CAS-${name} matchingDenialHint=${hint}: corrupt state cannot reach maintenance denial commit`,async()=>{
  const context=r03Context();context[field]--;
  await r03Reject(r03Corrupt(),`R03-CAS-${name}:${hint}`,{context,decision:hint?denial:D.CONTINUE});
});
for(const name of ["identity-first","disabled-auth","hidden-scope"])test(`R03-PRIORITY-${name}: existing rejection order precedes corrupt context`,async()=>{
  const s=r03Corrupt();let hooks=0,decision=D.CONTINUE;
  if(name==="identity-first")decision={get kind(){hooks++;throw Error("UNEXPECTED_PAYLOAD_READ");}};
  if(name==="disabled-auth")s.staff["synthetic-admin"].enabled=false;
  if(name==="hidden-scope")s.staff["synthetic-admin"].scope.group_ids=[];
  const r=await r03Observe(s,`R03-PRIORITY-${name}`,{decision});
  const [code,status]=name==="identity-first"?["RESPONSE_INVARIANT_FAILED",500]:name==="disabled-auth"?["ACCOUNT_DISABLED",403]:["NOT_FOUND",404];
  assert.equal(r.error?.code,code);assert.equal(r.error?.status,status);assert.equal(hooks,0);
  assert.deepEqual(r.draft,s);assert.deepEqual(r.committed,s);assert.equal(r.writes.length,0);
  assert.deepEqual(r.calls,{guard:1,context:0,maintenance:0,reconcile:0,active:0});
  if(name==="identity-first"){assert.equal(r.row.clockReads,0);assert.equal(r.row.stateReads,0);}
});
test("R03-VALID-ACTIVE: wait with null ordinary and unchanged S0",async()=>{
  const s=r03Fixture(),r=await r03Observe(s,"R03-VALID-ACTIVE",{now:r03T-1});
  assert.equal(r.error,undefined);assert.deepEqual(r.value,{kind:"wait_for_active_test"});assert.deepEqual(r.committed,s);assert.equal(r.writes.length,0);
  assert.deepEqual(r.calls,{guard:1,context:1,maintenance:1,reconcile:0,active:1});
});
for(const offset of [0,1])test(`R03-VALID-ELAPSED:${offset}: literal expiry and instrumentation positive control`,async()=>{
  const s=r03Fixture(),expected=clone(s),now=r03T+offset;
  Object.assign(expected.student.attempts[r03A],{status:"expired",completedAt:r03T,stateRevision:3,seriesStateRevision:3,ordinary:r03Ordinary(1,50,now)});
  expected.student.series[r03K].officialAttemptId=r03A;
  Object.assign(expected.student.assignments[ids.assignment].reviewGate,{eligible_unresolved_count:0,active_count:0,recovery_ready_count:0,barrier_complete:true,barrier_revision:1});
  const r=await r03Observe(s,`R03-VALID-ELAPSED:${offset}`,{now});
  assert.equal(r.error,undefined);assert.equal(r.value,D.CONTINUE);assert.deepEqual(r.committed,expected);
  assert.ok(r.calls.guard>=1);assert.deepEqual({...r.calls,guard:1},{guard:1,context:1,maintenance:1,reconcile:1,active:1});assert.equal(r.writes.length,7);
  assert.equal(r.writes.filter(w=>w.path.endsWith("/active_count")||w.path.endsWith("/recovery_ready_count")).length,2);
});
test("R03-VALID-TERMINAL: existing ordinary remains exact and is never recalculated",async()=>{
  const s=r03Fixture();Object.assign(s.student.attempts[r03A],{status:"expired",completedAt:r03T,stateRevision:3,seriesStateRevision:3,ordinary:r03Ordinary(1,50,r03T)});
  s.student.series[r03K].officialAttemptId=r03A;
  const r=await r03Observe(s,"R03-VALID-TERMINAL",{now:r03T+100});
  assert.equal(r.error,undefined);assert.equal(r.value,D.CONTINUE);assert.deepEqual(r.committed,s);assert.equal(r.writes.length,0);
  assert.deepEqual(r.calls,{guard:1,context:1,maintenance:1,reconcile:0,active:1});
});
after(()=>{
  if(process.env.UA_1A_TRACE_PATH)writeFileSync(process.env.UA_1A_TRACE_PATH,JSON.stringify({scope:"AUTHOR_LOCAL_DOMAIN_PREFLIGHT_NOT_INDEPENDENT_QA",traces},null,2)+"\n");
  if(process.env.UA_R03_TRACE_PATH)writeFileSync(process.env.UA_R03_TRACE_PATH,JSON.stringify({
    scope:"AUTHOR_R03_LITERAL_FIXTURE_NOT_ORIGINAL_QA_ARTIFACT_BYTES",cases:r03Rows,
    limits:"Recursive JS state-write observation and V8 precise function-call coverage are separate; no real SQL COMMIT, external effect or hidden-writer proof",
  },null,2)+"\n");
});

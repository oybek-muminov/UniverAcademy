import {test,after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {Session} from "node:inspector/promises";
import {studentView,saveAnswer,submitAttempt,result,startAttempt,expireForMembershipGuard} from "../../supabase/functions/univeracademy-api/attempts.ts";
import {materializeElapsedAttempts} from "../../supabase/functions/univeracademy-api/membership-activity.ts";
import {staffFixture} from "../backend/staff-fixture.ts";
import {ids as httpIds,signedInitData} from "../backend/http-fixture.ts";

const clone=structuredClone,id=n=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
const P=id(1),J=id(10),D=id(20),G=id(40),A=id(900),B=id(901),Q=id(100),O=id(200),K=P+"/"+D;
const C=Date.UTC(2026,10,5,12),T=C+60000;
const encode=value=>JSON.stringify(value,(_,v)=>typeof v==="bigint"?{$bigint:String(v)}:v);
const sha=value=>createHash("sha256").update(value).digest("hex");
const ordinary=(at=T,earned=1,percentage=50)=>({earned:{numerator:BigInt(earned),denominator:1n},maximum:{numerator:2n,denominator:1n},percentage:{numerator:BigInt(percentage),denominator:1n},calculatedAt:at});
function fixture(){
  const published={demoId:D,versionId:id(30),durationMs:60000,individualEnabled:false,questions:[
    {id:Q,optionIds:[O,id(201),id(202),id(203)],correctOptionId:O,individualPoints:{numerator:5n,denominator:2n}},
    {id:id(101),optionIds:[id(204),id(205),id(206),id(207)],correctOptionId:id(204),individualPoints:{numerator:5n,denominator:2n}}]};
  const record={id:A,personId:P,assignmentId:J,groupId:G,generation:1,status:"in_progress",startedAt:C,deadlineAt:T,completedAt:null,stateRevision:2,seriesStateRevision:2,published,
    questionOrder:published.questions.map(q=>({questionId:q.id,optionIds:[...q.optionIds]})),answers:[{questionId:Q,selectedOptionId:O,revision:1,savedAt:C,seriesStateRevision:2}],ordinary:null};
  return {record,access:{proofKind:"student_session",personId:P,enabled:true,assignmentIds:[J]},current:{id:A,generation:1},
    admission:{assignmentId:J,groupId:G,activeGroupId:G,rostered:true,profileComplete:true,membershipEpoch:7,grantEpoch:7,opensAt:C-1000,closesAt:T+1000}};
}
// Independent literal oracle: two questions, one correct; no production scorer,
// completion, expiry or reconciliation helper is called to create expectations.
function literalCompletion(record,now,status="expired"){
  return {...clone(record),status,completedAt:status==="expired"?record.deadlineAt:now,stateRevision:3,seriesStateRevision:3,ordinary:ordinary(now)};
}
function freeze(value){if(value&&typeof value==="object"){for(const key of Object.keys(value))freeze(value[key]);Object.freeze(value);}return value;}
const entries={
  view:(f,now)=>studentView(f.access,f.record,f.current,now),
  save:(f,now)=>saveAnswer(f.access,f.record,f.current,Q,{selected_option_id:O,expected_revision:1},now),
  submit:(f,now)=>submitAttempt(f.access,f.record,f.current,now),
  result:(f,now)=>result(f.access,f.record,f.current,now),
  start:(f,now)=>startAttempt({access:f.access,admission:f.admission,published:f.record.published,existing:f.record,id:id(999),confirmed:true,now,...f.startOverride}),
  membership:(f,now)=>expireForMembershipGuard(f.record,now),
};
const sourceURL=new URL("../../supabase/functions/univeracademy-api/attempts.ts",import.meta.url);
const fingerprints=[sourceURL,new URL(import.meta.url)].map(url=>{const b=readFileSync(url);return{path:url.pathname,bytes:b.length,sha256:sha(b)};});
const session=new Session();session.connect();await session.post("Profiler.enable");await session.post("Profiler.startPreciseCoverage",{callCount:true,detailed:true});
const results=[];
async function observe(ctx,work){
  await session.post("Profiler.takePreciseCoverage");let value,error;
  try{value=await work();}catch(e){error=e;}
  const report=await session.post("Profiler.takePreciseCoverage"),calls={expire:0,complete:0,ordinaryScore:0,materializeElapsedAttempts:0,reconcileMembershipEffects:0};
  for(const script of report.result)if(script.url.startsWith(new URL("../../supabase/",import.meta.url).href))for(const fn of script.functions)if(Object.hasOwn(calls,fn.functionName))calls[fn.functionName]+=fn.ranges[0].count;
  ctx.calls=calls;ctx.outcome=error?{name:error.name,code:error.code,status:error.status}:{ok:true,value};return{value,error};
}
function scenario(case_id,work){test(case_id,async()=>{const ctx={case_id,started_utc:new Date().toISOString(),evidence_layer:"PURE_TRANSITION_FROZEN_INPUT_NO_TRANSACTION"};let failure;try{await work(ctx);ctx.verdict="PASS";}catch(e){failure=e;ctx.verdict="FAIL";ctx.assertion={name:e.name,message:e.message};}finally{ctx.finished_utc=new Date().toISOString();ctx.exit=failure?1:0;ctx.source_fingerprints=fingerprints;results.push(ctx);}if(failure)throw failure;});}
const fault=(r,code,status)=>{assert.ok(r.error);assert.equal(r.error.code,code);assert.equal(r.error.status,status);};
const noRecompute=ctx=>{assert.equal(ctx.calls.complete,0);assert.equal(ctx.calls.ordinaryScore,0);};
function unchangedInput(ctx,f,before){assert.deepEqual(f,before);ctx.input_after=clone(f);ctx.input_net_diff="NONE";ctx.input_write_attempts="NOT_INSTRUMENTED_DEEPLY_FROZEN_INPUT";}

for(const name of Object.keys(entries))for(const offset of [-1,0,1])scenario(`SHARED-CORRUPT-${name}:${offset}`,async ctx=>{
  const f=fixture();f.record.ordinary=ordinary(T-50,2,100);const before=clone(f);freeze(f);ctx.input_before=before;ctx.now=T+offset;ctx.expected={code:"RESPONSE_INVARIANT_FAILED",status:500,input:"S0",complete:0,ordinaryScore:0};
  const r=await observe(ctx,()=>entries[name](f,T+offset));fault(r,"RESPONSE_INVARIANT_FAILED",500);noRecompute(ctx);assert.equal(ctx.calls.expire,1);unchangedInput(ctx,f,before);
});
for(const name of Object.keys(entries))scenario("SHARED-VALID-ACTIVE-"+name,async ctx=>{
  const f=fixture(),before=clone(f),now=T-1;freeze(f);ctx.input_before=before;const r=await observe(ctx,()=>entries[name](f,now));
  if(name==="result"){fault(r,"ATTEMPT_NOT_COMPLETED",409);noRecompute(ctx);}
  else{assert.equal(r.error,undefined);const record=r.value.record??r.value;
    if(name==="submit"){ctx.expected_record=literalCompletion(before.record,now,"submitted");assert.deepEqual(record,ctx.expected_record);assert.equal(ctx.calls.complete,1);}
    else if(name==="save"){const expected=clone(before.record);Object.assign(expected,{stateRevision:3,seriesStateRevision:3});Object.assign(expected.answers[0],{revision:2,savedAt:now,seriesStateRevision:3});ctx.expected_record=expected;assert.deepEqual(record,expected);noRecompute(ctx);}
    else{assert.deepEqual(record,before.record);noRecompute(ctx);}}
  unchangedInput(ctx,f,before);
});
for(const name of Object.keys(entries))for(const offset of [0,1])scenario(`SHARED-LITERAL-EXPIRY-${name}:${offset}`,async ctx=>{
  const f=fixture(),before=clone(f),now=T+offset;freeze(f);ctx.input_before=before;ctx.expected_record=literalCompletion(before.record,now);const r=await observe(ctx,()=>entries[name](f,now));assert.equal(r.error,undefined);assert.deepEqual(r.value.record??r.value,ctx.expected_record);assert.equal(ctx.calls.complete,1);assert.equal(ctx.calls.ordinaryScore,1);
  if(name==="save"){assert.equal(r.value.response.ok,false);assert.equal(r.value.response.error.code,"ATTEMPT_EXPIRED");assert.equal(r.value.response.error.status,409);}unchangedInput(ctx,f,before);
});
for(const status of ["submitted","expired"])for(const name of Object.keys(entries))scenario(`SHARED-TERMINAL-${status}-${name}`,async ctx=>{
  const f=fixture();f.record=literalCompletion(f.record,T,status);const before=clone(f);freeze(f);ctx.input_before=before;const r=await observe(ctx,()=>entries[name](f,T+1));
  if(name==="start")fault(r,"NORMAL_ATTEMPT_USED",409);else if(name==="save"&&status==="submitted")fault(r,"ATTEMPT_TERMINAL",409);else{assert.equal(r.error,undefined);assert.deepEqual(r.value.record??r.value,before.record);}
  noRecompute(ctx);unchangedInput(ctx,f,before);
});
for(const name of ["view","save","submit","result"])for(const [kind,edit,code,status]of [
  ["proof",f=>{f.access.proofKind="forged";},"FORBIDDEN",403],["disabled",f=>{f.access.enabled=false;},"ACCOUNT_DISABLED",403],
  ["foreign-person",f=>{f.access.personId=id(2);},"NOT_FOUND",404],["missing-grant",f=>{f.access.assignmentIds=[];},"NOT_FOUND",404],
  ["stale-id",f=>{f.current.id=id(999);},"ATTEMPT_SUPERSEDED",409],["stale-generation",f=>{f.current.generation=2;},"ATTEMPT_SUPERSEDED",409],
  ["cancelled",f=>{f.record.status="cancelled";},"ATTEMPT_SUPERSEDED",409],
])scenario(`SHARED-PRECEDENCE-${name}-${kind}`,async ctx=>{const f=fixture();f.record.ordinary=ordinary(T-50,2,100);edit(f);const before=clone(f);freeze(f);ctx.input_before=before;const r=await observe(ctx,()=>entries[name](f,T));fault(r,code,status);assert.equal(ctx.calls.expire,0);noRecompute(ctx);unchangedInput(ctx,f,before);});
for(const name of Object.keys(entries))scenario("SHARED-CLOCK-"+name,async ctx=>{const f=fixture();f.record.ordinary=ordinary(T-50,2,100);const before=clone(f);freeze(f);ctx.input_before=before;const r=await observe(ctx,()=>entries[name](f,NaN));fault(r,"SERVICE_UNAVAILABLE",503);noRecompute(ctx);unchangedInput(ctx,f,before);});
for(const [kind,edit,code,status]of [
  ["proof",f=>{f.access.proofKind="forged";},"FORBIDDEN",403],["disabled",f=>{f.access.enabled=false;},"ACCOUNT_DISABLED",403],
  ["missing-grant",f=>{f.access.assignmentIds=[];},"NOT_FOUND",404],["confirmation",f=>{f.startOverride={confirmed:false};},"VALIDATION_ERROR",422],
  ["profile",f=>{f.admission.profileComplete=false;},"PROFILE_INCOMPLETE",409],["roster",f=>{f.admission.rostered=false;},"EXAM_ACCESS_REVOKED",403],
  ["epoch",f=>{f.admission.grantEpoch=8;},"EXAM_ACCESS_REVOKED",403],["foreign-existing",f=>{f.record.personId=id(2);},"RESPONSE_INVARIANT_FAILED",500],
  ["foreign-demo",f=>{f.record.published.demoId=id(21);},"RESPONSE_INVARIANT_FAILED",500],
  ["other-assignment",f=>{f.record.assignmentId=id(11);},"NORMAL_ATTEMPT_USED",409],
])scenario("SHARED-START-PRECEDENCE-"+kind,async ctx=>{
  const f=fixture();f.record.ordinary=ordinary(T-50,2,100);edit(f);const before=clone(f);freeze(f);ctx.input_before=before;
  // The foreign-demo case needs an independently loaded requested snapshot.
  const invoke=kind==="foreign-demo"?()=>startAttempt({access:f.access,admission:f.admission,published:{...f.record.published,demoId:D},existing:f.record,id:id(999),confirmed:true,now:T}):()=>entries.start(f,T);
  const r=await observe(ctx,invoke);fault(r,code,status);assert.equal(ctx.calls.expire,0);noRecompute(ctx);unchangedInput(ctx,f,before);
});

function watch(raw,writes){
  const cache=new WeakMap(),reverse=new WeakMap();
  function strip(v,seen=new WeakSet()){if(!v||typeof v!=="object")return v;if(reverse.has(v))return reverse.get(v);if(seen.has(v))return v;seen.add(v);for(const k of Reflect.ownKeys(v)){const d=Reflect.getOwnPropertyDescriptor(v,k);if(d&&"value"in d){const x=strip(d.value,seen);if(x!==d.value)Reflect.defineProperty(v,k,{...d,value:x});}}return v;}
  function wrap(v,path){if(!v||typeof v!=="object")return v;if(cache.has(v))return cache.get(v);const proxy=new Proxy(v,{
    get(t,k){return wrap(Reflect.get(t,k,t),path+"/"+String(k));},
    set(t,k,value){const clean=strip(value);writes.push({op:"set",path:path+"/"+String(k),value:clone(clean)});return Reflect.set(t,k,clean,t);},
    deleteProperty(t,k){writes.push({op:"delete",path:path+"/"+String(k)});return Reflect.deleteProperty(t,k);},
    defineProperty(t,k,d){writes.push({op:"defineProperty",path:path+"/"+String(k)});return Reflect.defineProperty(t,k,{...d,...("value"in d?{value:strip(d.value)}:{})});},
  });cache.set(v,proxy);reverse.set(proxy,v);return proxy;}return wrap(raw,"");
}
function mixedFixture(seriesFirst,attemptsFirst,corrupt=true){
  const f=fixture(),first=clone(f.record);first.startedAt=C-10;first.deadlineAt=T-10;
  const second={...clone(f.record),id:B,assignmentId:id(11),published:{...clone(f.record.published),demoId:id(21)},ordinary:corrupt?ordinary(T-50,2,100):null},K2=P+"/"+id(21);
  const a={currentAttemptId:A,generation:1,normalAttemptUsed:true,officialAttemptId:null,recoveryState:"none",recovery:null},b={...a,currentAttemptId:B};
  return {student:{attempts:attemptsFirst?{[A]:first,[B]:second}:{[B]:second,[A]:first},series:seriesFirst?{[K]:a,[K2]:b}:{[K2]:b,[K]:a},receipts:{keep:{payload:"synthetic-history-sentinel"}},bonuses:{keep:7n}},memberships:{[P]:{affinityGroupId:G,active:true,revision:7,epoch:7}}};
}
function recordingTransaction(ctx,initial){
  let committed=clone(initial);const draft=clone(initial);ctx.events=["begin"];ctx.attempted_writes=[];
  return {async run(now){try{const effect=materializeElapsedAttempts(watch(draft,ctx.attempted_writes),P,now);ctx.events.push("commit");committed=clone(draft);return effect;}catch(e){ctx.events.push("rollback");throw e;}finally{ctx.staged=clone(draft);ctx.committed=clone(committed);}},read:()=>clone(committed)};
}
for(const offset of [-1,0,1])for(const sf of [true,false])for(const af of [true,false])scenario(`SHARED-MIXED:${offset}:series-first=${sf}:attempts-first=${af}`,async ctx=>{
  const s=mixedFixture(sf,af),now=T+offset;ctx.evidence_layer="SHARED_MAINTENANCE_RECORDING_TRANSACTION_DOUBLE_NOT_ACCEPTED_GUARD";ctx.input_before=clone(s);ctx.order={series:Object.keys(s.student.series),attempts:Object.keys(s.student.attempts)};const tx=recordingTransaction(ctx,s);
  const r=await observe(ctx,()=>tx.run(now));fault(r,"RESPONSE_INVARIANT_FAILED",500);assert.deepEqual(tx.read(),s);const expected=clone(s);
  if(af){expected.student.attempts[A]=literalCompletion(s.student.attempts[A],now);expected.student.series[K].officialAttemptId=A;}
  ctx.expected_staged=expected;ctx.expected_committed=clone(s);assert.deepEqual(ctx.staged,expected);assert.equal(ctx.attempted_writes.length,af?2:0);assert.equal(ctx.calls.complete,af?1:0);assert.equal(ctx.calls.ordinaryScore,af?1:0);assert.equal(ctx.calls.materializeElapsedAttempts,1);assert.equal(ctx.calls.reconcileMembershipEffects,0);assert.deepEqual(ctx.events,["begin","rollback"]);
});
scenario("SHARED-MIXED-valid-write-calibration",async ctx=>{const s=mixedFixture(true,true,false),ctxExpected=clone(s),now=T+1;ctx.evidence_layer="SHARED_MAINTENANCE_RECORDING_TRANSACTION_DOUBLE_NOT_ACCEPTED_GUARD";ctx.input_before=clone(s);for(const a of Object.values(ctxExpected.student.attempts)){ctxExpected.student.attempts[a.id]=literalCompletion(a,now);ctxExpected.student.series[P+"/"+a.published.demoId].officialAttemptId=a.id;}const tx=recordingTransaction(ctx,s);const r=await observe(ctx,()=>tx.run(now));assert.equal(r.error,undefined);ctx.expected_committed=ctxExpected;assert.deepEqual(tx.read(),ctxExpected);assert.equal(ctx.attempted_writes.length,4);assert.equal(ctx.calls.complete,2);assert.equal(ctx.calls.ordinaryScore,2);assert.deepEqual(ctx.events,["begin","commit"]);});
for(const kind of ["historical","foreign","stale-generation"])scenario("SHARED-MEMBERSHIP-CURRENTNESS-"+kind,async ctx=>{const s=mixedFixture(true,true);const a=s.student.attempts[B];if(kind==="historical")s.student.series[P+"/"+a.published.demoId].currentAttemptId=id(999);else if(kind==="foreign")a.personId=id(2);else s.student.series[P+"/"+a.published.demoId].generation=2;const before=clone(s),now=T;ctx.evidence_layer="CURRENTNESS_FILTER_CONTROL_NOT_SHARED_C04_VALIDATION";ctx.input_before=before;const tx=recordingTransaction(ctx,s);const r=await observe(ctx,()=>tx.run(now));assert.equal(r.error,undefined);assert.deepEqual(tx.read().student.attempts[B],before.student.attempts[B]);assert.equal(ctx.calls.complete,1);ctx.expected_preserved_attempt=before.student.attempts[B];});

for(const name of ["view","save","submit","result","start"])for(const offset of [-1,0,1])scenario(`SHARED-HTTP-${name}:${offset}`,async ctx=>{
  const f=staffFixture(),started=await f.start();f.store.time=f.store.state.student.attempts[started.attempt.id].deadlineAt+offset;
  // The existing fixture access proof expires after15s; authenticate afresh at
  // the chosen server time, before capturing S0 or injecting corrupt state.
  const fresh=await f.studentCall("POST","/auth/telegram",{init_data:signedInitData(4000000001,crypto.randomUUID(),f.store.time)});assert.equal(fresh.status,200);
  const record=f.store.state.student.attempts[started.attempt.id];record.ordinary=ordinary(record.deadlineAt-50,2,100);
  const before=clone(f.store.state),domain=clone(record);ctx.evidence_layer="EXISTING_STUDENT_HTTP_RAM_TRANSACTION_FIXTURE_NO_LIVE_SERVICE";ctx.input_before=domain;ctx.full_state_before_sha256=sha(encode(before));const eventStart=f.store.events.length;
  const route=name==="start"?`/exams/${httpIds.assignment}/attempts`:`/attempts/${record.id}`+(name==="save"?`/answers/${httpIds.question}`:name==="view"?"":"/"+name);
  const method=name==="save"?"PUT":["submit","start"].includes(name)?"POST":"GET",body=name==="save"?{selected_option_id:httpIds.correct,expected_revision:0}:name==="start"?{confirmed:true}:undefined;
  ctx.method=method;ctx.path=route;const r=await observe(ctx,()=>f.studentCall(method,route,body,fresh.json.data.access_token));assert.equal(r.error,undefined);assert.equal(r.value.status,500);assert.equal(r.value.json.error.code,"RESPONSE_INVARIANT_FAILED");noRecompute(ctx);assert.deepEqual(f.store.state,before);ctx.input_after=clone(f.store.state.student.attempts[record.id]);ctx.full_state_after_sha256=sha(encode(f.store.state));ctx.transaction_events=f.store.events.slice(eventStart);assert.equal(ctx.transaction_events.includes("commit"),false);ctx.input_write_attempts="NOT_INSTRUMENTED_HTTP_FIXTURE";
});

after(async()=>{await session.post("Profiler.stopPreciseCoverage");session.disconnect();if(process.env.UA_SHARED_EXPIRY_TRACE_PATH)writeFileSync(process.env.UA_SHARED_EXPIRY_TRACE_PATH,JSON.stringify({candidate:"R03-SHARED-EXPIRY-01",base:"63f0e9a557d689f775dfe7a1c5aab8c87d27acd5",scope:"AUTHOR_LOCAL_TRANSITION_AND_RECORDING_DOUBLE_NOT_INDEPENDENT_QA",command:[process.execPath,...process.execArgv,...process.argv.slice(1)],source_fingerprints:fingerprints,limits:"Public input snapshots are deeply frozen/net comparisons, not transient write traces. Mixed caller Proxy records reachable JS sets/defines/deletes. Recording-double committed state is not PostgreSQL durability. Accepted preflight zero-write controls are separate unchanged suites.",cases:results},(_,v)=>typeof v==="bigint"?{$bigint:String(v)}:v,2)+"\n");});

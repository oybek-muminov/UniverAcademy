import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { generateKeyPair, SignJWT } from "jose";
import { createMembershipPreflight, createRosterRemovalPreflight } from "../../supabase/functions/univeracademy-api/membership-preflight.ts";
import { guardRemovalActiveTest, guardRosterRemovalActiveTest, REMOVAL_DECISION as RD } from "../../supabase/functions/univeracademy-api/membership-activity.ts";
import { requireRosterAuthority } from "../../supabase/functions/univeracademy-api/staff-state.ts";
import { staffFixture, staffIds, transferBody } from "../backend/staff-fixture.ts";
import { ids as transferIds } from "../backend/http-fixture.ts";
import { expiryDelta } from "../../supabase/functions/univeracademy-api/storage/membership-preflight-port.ts";
import { createStaffJwtVerifier } from "../../supabase/functions/univeracademy-api/staff-jwt.ts";
import { ApiFault } from "../../supabase/functions/univeracademy-api/fault.ts";
import { StorageUnavailable } from "../../supabase/functions/univeracademy-api/storage/postgres-transaction.ts";

const clone=structuredClone,id=n=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
const P=id(1),Q=id(2),J=id(10),D=id(20),G=id(40),H=id(41),A=id(900),B=id(901),U=id(501),K=P+"/"+D;
const C=Date.UTC(2026,10,5,12),T=C+60000;
const ordinary=(earned=1,percentage=50,at=T)=>({earned:{numerator:BigInt(earned),denominator:1n},maximum:{numerator:2n,denominator:1n},percentage:{numerator:BigInt(percentage),denominator:1n},calculatedAt:at});
function fixture(){
  const published={demoId:D,versionId:id(30),durationMs:60000,individualEnabled:false,questions:[
    {id:id(100),optionIds:[id(200),id(201),id(202),id(203)],correctOptionId:id(200),individualPoints:{numerator:5n,denominator:2n}},
    {id:id(101),optionIds:[id(204),id(205),id(206),id(207)],correctOptionId:id(204),individualPoints:{numerator:5n,denominator:2n}}]};
  return {student:{people:{[P]:{telegramId:null,enabled:true,profile:{person_id:P,roles:["student"],registration_complete:true,
      active_group_id:G,first_name:"Port",last_name:"Synthetic",qadam_id:"0100000001"}}},families:{},access:{},refresh:{},consumedInitData:{},
    grants:{[P]:{[J]:{rostered:true,membershipEpoch:7,grantEpoch:7}}},
    assignments:{[J]:{admission:{assignmentId:J,groupId:G,activeGroupId:G,rostered:true,profileComplete:true,membershipEpoch:7,grantEpoch:7,opensAt:C-1000,closesAt:C+1000},published:clone(published),title:"Literal preflight",instructions:[],contents:{},cancelled:false,
      reviewGate:{id:id(50),status:"blocked",revision:0,barrier_revision:0,barrier_complete:false,eligible_unresolved_count:1,active_count:0,recovery_ready_count:0,timezone:"Asia/Tashkent",first_opened_at:null,opens_at:null,closes_at:null}}},
    series:{[K]:{currentAttemptId:A,generation:1,normalAttemptUsed:true,officialAttemptId:null,recoveryState:"none",recovery:null}},
    attempts:{[A]:{id:A,personId:P,assignmentId:J,groupId:G,generation:1,status:"in_progress",startedAt:C,deadlineAt:T,completedAt:null,stateRevision:2,seriesStateRevision:2,published,
      questionOrder:published.questions.map(q=>({questionId:q.id,optionIds:[...q.optionIds]})),answers:[{questionId:id(100),selectedOptionId:id(200),revision:1,savedAt:C,seriesStateRevision:2}],ordinary:null}},
    receipts:{keep:{payload:"student-sentinel"}},bonuses:{keep:{marker:7n}},cancellations:{}},
    staff:{[U]:{personId:U,enabled:true,approved:true,roles:["admin"],approvedSubjectIds:["physics"],capabilities:{manage_roster:true,manage_content:true},scope:{all_groups:false,group_ids:[G],all_subjects:false,subject_ids:["physics"]}}},
    groups:{[G]:{id:G,revision:4,status:"active"}},memberships:{[P]:{affinityGroupId:G,active:true,revision:7,epoch:7}},versions:{},recoveryAssignments:{},
    notifications:{keep:{studentId:P,assignmentId:J,epoch:7,status:"queued"}},approvals:{keep:{studentId:P,epoch:7,status:"pending"}},
    receipts:{keep:{payload:"staff-sentinel"}},audit:[{actorId:U,action:"preserve",targetId:P,revision:7,at:C}]};
}
// Independent literal expected state; no candidate expiry/grading/reconcile helper.
function expectedExpiry(s,now=T,{peerActive=false,peerReady=false}={}){
  const out=clone(s),a=out.student.attempts[A];
  Object.assign(a,{status:"expired",completedAt:T,stateRevision:3,seriesStateRevision:3,ordinary:ordinary(1,50,now)});
  Object.assign(out.student.series[K],{officialAttemptId:A,...(a.generation>1?{recoveryState:"none",recovery:null}:{})});
  Object.assign(out.student.assignments[J].reviewGate,{eligible_unresolved_count:peerActive||peerReady?1:0,
    active_count:peerActive?1:0,recovery_ready_count:peerReady?1:0,barrier_complete:!peerActive&&!peerReady,barrier_revision:1});
  return out;
}
function peer(s,kind){
  s.groups[H]={id:H,revision:1,status:"active"};s.student.people[Q]={...clone(s.student.people[P]),profile:{...clone(s.student.people[P].profile),person_id:Q,active_group_id:H}};
  s.memberships[Q]={affinityGroupId:H,active:true,revision:7,epoch:7};s.student.grants[Q]={[J]:{rostered:true,membershipEpoch:7,grantEpoch:7}};
  const key=Q+"/"+D,a={...clone(s.student.attempts[A]),id:B,personId:Q,groupId:H,deadlineAt:T+1000};
  s.student.series[key]={...clone(s.student.series[K]),currentAttemptId:B};
  if(kind==="ready"){
    Object.assign(a,{status:"submitted",completedAt:C+100,stateRevision:3,seriesStateRevision:3,ordinary:ordinary()});
    Object.assign(s.student.series[key],{officialAttemptId:B,recoveryState:"ready",recovery:{opensAt:T+10000,closesAt:T+20000,durationMs:1000}});
    s.recoveryAssignments[key]=J;
  }
  s.student.attempts[B]=a;return key;
}
function second(s){
  const demo=id(21),assignment=id(11),key=P+"/"+demo,a={...clone(s.student.attempts[A]),id:B,assignmentId:assignment,published:{...clone(s.student.attempts[A].published),demoId:demo},ordinary:null};
  s.student.assignments[assignment]=clone(s.student.assignments[J]);Object.assign(s.student.assignments[assignment].admission,{assignmentId:assignment});s.student.assignments[assignment].published=clone(a.published);s.student.assignments[assignment].reviewGate.id=id(51);
  s.student.grants[P][assignment]={rostered:true,membershipEpoch:7,grantEpoch:7};s.student.series[key]={...clone(s.student.series[K]),currentAttemptId:B};s.student.attempts[B]=a;
  return {key,assignment,a};
}
// Synthetic enumeration only. A consistently lying port can omit a hidden
// participant; this local contract cannot prove actual SQL exhaustiveness.
function receipt(s,scope,actor,ids,now){
  const ts=Object.keys(s.student.series).filter(k=>k.startsWith(P+"/"));
  const elapsed=ts.map(k=>s.student.attempts[s.student.series[k].currentAttemptId]).filter(a=>a&&a.status==="in_progress"&&now>=a.deadlineAt);
  const affected=Object.keys(s.student.assignments).filter(j=>elapsed.some(a=>a.assignmentId===j||a.published.demoId===s.student.assignments[j].published.demoId));
  const participants=affected.flatMap(j=>Object.keys(s.student.people).map(p=>[j,p]));
  const anchors=Object.entries(s.student.series).filter(([k,v])=>v.recoveryState==="ready"&&(k.startsWith(P+"/")||affected.includes(s.recoveryAssignments[k]??s.student.attempts[v.currentAttemptId]?.assignmentId)))
    .map(([k,v])=>[k,s.recoveryAssignments[k]??s.student.attempts[v.currentAttemptId]?.assignmentId]);
  const maps={staff:s.staff,groups:s.groups,people:s.student.people,memberships:s.memberships,assignments:s.student.assignments,series:s.student.series,attempts:s.student.attempts,recoveryAssignments:s.recoveryAssignments};
  const rows=Object.fromEntries(Object.entries(maps).map(([k,v])=>[k,{present:Object.keys(v),absent:[]}]));
  rows.grants={present:Object.entries(s.student.grants).flatMap(([p,g])=>Object.keys(g).map(j=>p+"/"+j)),absent:[]};
  for(const [j,p]of participants){if(!s.student.grants[p]?.[j])rows.grants.absent.push(p+"/"+j);const k=p+"/"+s.student.assignments[j].published.demoId;if(!s.student.series[k])rows.series.absent.push(k);}
  for(const [k]of anchors)if(!Object.hasOwn(s.recoveryAssignments,k))rows.recoveryAssignments.absent.push(k);
  for(const [c,k]of [["groups",scope.groupId],["people",scope.studentId],["memberships",scope.studentId]])if(!Object.hasOwn(maps[c],k))rows[c].absent.push(k);
  for(const facts of Object.values(rows))facts.absent=[...new Set(facts.absent)];
  const e=(name,keys)=>({enumerationId:ids.frameId+":"+name,keys});
  return {version:"r1-local-v1",...ids,scope:{actorId:actor.actorId,studentId:scope.studentId,groupId:scope.groupId},
    enumerations:{targetSeries:e("target",ts),affectedAssignments:e("affected",affected),participants:e("participants",participants),recoveryAnchors:e("anchors",anchors)},rows};
}

function watch(raw,writes){
  const cache=new WeakMap(),reverse=new WeakMap();
  function strip(v,seen=new WeakSet()){
    if(!v||typeof v!=="object")return v;if(reverse.has(v))return reverse.get(v);if(seen.has(v))return v;seen.add(v);
    for(const k of Reflect.ownKeys(v)){const d=Reflect.getOwnPropertyDescriptor(v,k);if(d&&"value"in d){const x=strip(d.value,seen);if(x!==d.value)Reflect.defineProperty(v,k,{...d,value:x});}}
    return v;
  }
  function wrap(v,path){
    if(!v||typeof v!=="object")return v;if(cache.has(v))return cache.get(v);
    const note=(op,k)=>writes.push({op,path:path+"/"+String(k)});
    const p=new Proxy(v,{get(t,k){return wrap(Reflect.get(t,k,t),path+"/"+String(k));},
      set(t,k,x){note("set",k);return Reflect.set(t,k,strip(x),t);},
      defineProperty(t,k,d){note("defineProperty",k);return Reflect.defineProperty(t,k,{...d,...("value"in d?{value:strip(d.value)}:{})});},
      deleteProperty(t,k){note("delete",k);return Reflect.deleteProperty(t,k);},setPrototypeOf(t,v){note("setPrototypeOf","");return Reflect.setPrototypeOf(t,v);},preventExtensions(t){note("preventExtensions","");return Reflect.preventExtensions(t);}});
    cache.set(v,p);reverse.set(p,v);return p;
  }
  return wrap(raw,"");
}
const sourcePaths=["supabase/functions/univeracademy-api/removal-authority.ts","supabase/functions/univeracademy-api/membership-activity.ts","supabase/functions/univeracademy-api/membership-preflight.ts","tests/membership/preflight-adapter.test.mjs"];
const project=new URL("../../",import.meta.url),fingerprints=sourcePaths.map(path=>{const b=readFileSync(new URL(path,project));return{path,bytes:b.length,sha256:createHash("sha256").update(b).digest("hex")};});
const guardURL=new URL("supabase/functions/univeracademy-api/membership-activity.ts",project),guardSource=readFileSync(guardURL,"utf8");
const guardSHA=createHash("sha256").update(guardSource).digest("hex");assert.equal(guardSHA,"c4149e06a68778b39bd2e229188605d84fc4dda756dc5fc95016259a9226eb6b");
const session=new Session();session.connect();await session.post("Debugger.enable");
let current;
globalThis.__r1GuardWriteObserver=raw=>{assert.ok(current);current.guardRaw=raw;current.guardBefore=clone(raw);return watch(raw,current.guardWrites);};
session.on("Debugger.paused",message=>{
  const observed=current;
  try{
    const frame=message.params.callFrames[0];assert.ok(["guardRemovalActiveTest","guardRosterRemovalActiveTest"].includes(frame.functionName));assert.ok(observed);
    observed.directGuard++;(observed.guardEntries??=[]).push(frame.functionName);observed.ledger.push("guard.enter");
    // Dispatch both inspector commands inside the paused callback, before any
    // Promise continuation; same-thread V8 resumes when this callback returns.
    void session.post("Debugger.evaluateOnCallFrame",{callFrameId:frame.callFrameId,expression:"(decision === REMOVAL_DECISION.CONTINUE || decision === REMOVAL_DECISION.DENY_GROUP_REVISION || decision === REMOVAL_DECISION.DENY_MEMBERSHIP_REVISION) ? (tx.state = globalThis.__r1GuardWriteObserver(tx.state)) : undefined"})
      .then(r=>{if(r.exceptionDetails)observed.instrumentationError="GUARD_OBSERVER_INSTALL_FAILED";},e=>{observed.instrumentationError=e.message;});
    void session.post("Debugger.resume").catch(e=>{observed.instrumentationError=e.message;});
  }catch(e){if(observed)observed.instrumentationError=e.message;}
});
const identityLines=guardSource.split("\n").flatMap((line,lineNumber)=>line.includes("if (decision !== REMOVAL_DECISION.CONTINUE && decision !== REMOVAL_DECISION.DENY_GROUP_REVISION")?[lineNumber]:[]);
assert.equal(identityLines.length,2);
const breakpoints=[];
for(const lineNumber of identityLines){const b=await session.post("Debugger.setBreakpointByUrl",{url:guardURL.href,lineNumber});assert.ok(b.locations.length);breakpoints.push(b);}
await session.post("Profiler.enable");await session.post("Profiler.startPreciseCoverage",{callCount:true,detailed:true});
const key=await generateKeyPair("RS256"),otherKey=await generateKeyPair("RS256");
async function token({expires=C+1000000,signer=key.privateKey}={}){
  return new SignJWT({role:"authenticated",session_id:id(700)}).setProtectedHeader({alg:"RS256",kid:"offline"}).setIssuer("https://offline.invalid").setAudience("local-preflight").setSubject(U).setIssuedAt(C/1000).setExpirationTime(expires/1000).sign(signer);
}
const validToken=await token();
const command=(overrides={})=>({credential:validToken,studentId:P,groupId:G,expectedGroupRevision:4,expectedMembershipRevision:7,...overrides});
const results=[];
function scenario(name,work){test(name,async()=>{
  const ctx={case_id:name,started_utc:new Date().toISOString(),ledger:[],directGuard:0,guardWrites:[],portWrites:[],flushes:0,verifyCalls:0,transactions:0,acknowledgements:0};
  current=ctx;await session.post("Profiler.takePreciseCoverage");let failure;
  try{await work(ctx);assert.equal(ctx.instrumentationError,undefined);ctx.verdict="PASS";}
  catch(e){failure=e;ctx.verdict="FAIL";ctx.assertion={name:e.name,message:e.message,stack:e.stack};}
  finally{
    const coverage=await session.post("Profiler.takePreciseCoverage"),calls={maintenance:0,reconcile:0};
    for(const script of coverage.result)if(script.url.startsWith(new URL("supabase/",project).href))for(const f of script.functions){if(f.functionName==="materializeElapsedAttempts")calls.maintenance+=f.ranges[0].count;if(f.functionName==="reconcileMembershipEffects")calls.reconcile+=f.ranges[0].count;}
    ctx.observed_functions=calls;
    try{
      const corrupt=name.startsWith("L4-C04-")||name.startsWith("L4-R03-");
      const expected=ctx.directGuard===0||corrupt?{maintenance:0,reconcile:0}:{maintenance:1,reconcile:ctx.guardWrites.length?1:0};
      assert.deepEqual(calls,ctx.expectedFunctions??expected);
      if(ctx.directGuard&&!ctx.direct_guard_case)assert.equal(ctx.ledger.indexOf("guard.enter"),ctx.ledger.indexOf("frame.return")+1);
    }catch(e){if(!failure){failure=e;ctx.verdict="FAIL";ctx.assertion={name:e.name,message:e.message,stack:e.stack};}}
    ctx.guardStaged=ctx.guardRaw?clone(ctx.guardRaw):null;delete ctx.guardRaw;
    if(ctx.readStore)ctx.committed=ctx.readStore();delete ctx.readStore;
    ctx.portStaged??=null;ctx.preparedProjection??=null;
    ctx.evidence_layer??="OFFLINE_NATIVE_JWT_LOCAL_CONTRACT_RECORDING_DOUBLE";
    ctx.staging_started=ctx.transactions>0;
    ctx.finished_utc=new Date().toISOString();ctx.exit=failure?1:0;ctx.source_fingerprints=fingerprints;ctx.guard_source_sha256=guardSHA;
    ctx.command=[process.execPath,...process.execArgv,...process.argv.slice(1)];results.push(ctx);current=undefined;
  }
  if(failure)throw failure;
});}
function double(ctx,initial=fixture(),options={}){
  let durable=clone(initial),draft,prepared,identity;ctx.initial=clone(initial);
  const verifier=createStaffJwtVerifier({issuer:"https://offline.invalid",audience:"local-preflight",algorithms:["RS256"],trustedKeys:async()=>key.publicKey,now:()=>C});
  const ids={transactionId:ctx.case_id+":tx",protectionId:ctx.case_id+":protect",frameId:ctx.case_id+":frame"};
  const port={
    async verifyAndLocate(credential){ctx.verifyCalls++;ctx.ledger.push("credential.verify");const proof=await verifier(credential);ctx.ledger.push("mapping.locate");identity={actorId:U,proof};return identity;},
    async transaction(actor,work){
      ctx.transactions++;ctx.ledger.push("tx.begin");draft=clone(durable);ctx.ledger.push("protection.acquire");
      const watched=watch(draft,ctx.portWrites);
      const tx={...ids,
        async prepareAndRefresh(verified,scope){
          ctx.ledger.push("prepare.load");ctx.ledger.push("prepare.wait");if(options.wait)await options.wait();
          prepared=clone(draft);
          ctx.ledger.push("refresh.mapping");if(options.mappingRevoked)throw new ApiFault("STAFF_TOKEN_INVALID",401);
          ctx.ledger.push("refresh.provider");if(options.providerFault)throw new ApiFault("SERVICE_UNAVAILABLE",503);if(options.providerRevoked)throw new ApiFault("STAFF_TOKEN_INVALID",401);
          ctx.ledger.push("refresh.authority");if(options.authority)options.authority(prepared);
          ctx.ledger.push("refresh.clock");const now=options.now??T;
          if(options.scopeMutation)scope.expectedGroupRevision=0;
          const frame={...ids,actor:verified,now,providerExpiresAt:options.providerExpiresAt??C+900000,state:prepared,coverage:receipt(prepared,scope,verified,ids,now)};
          if(options.frame)options.frame(frame);
          ctx.ledger.push("frame.return");return frame;
        },
        async flushExpiry(delta){
          ctx.flushes++;ctx.ledger.push("flush.begin");ctx.delta=clone(delta);
          assert.equal(Object.isFrozen(delta),true);assert.deepEqual(Object.keys(delta).sort(),["attempts","binding","gates","series"]);
          if(options.flushReply)return {status:409};
          if(options.forbiddenWriter)delta.membership={active:false};
          if(options.flushFaultBefore)throw options.flushFaultBefore;
          assert.deepEqual(delta.binding,{...ids,actorId:U,studentId:P,groupId:G});
          for(const a of delta.attempts){const old=draft.student.attempts[a.attemptId];assert.deepEqual({generation:old.generation,stateRevision:old.stateRevision,seriesStateRevision:old.seriesStateRevision,status:old.status,ordinary:old.ordinary},a.expected);if(options.casFault)throw new ApiFault("STATE_REVISION_CONFLICT",409);Object.assign(watched.student.attempts[a.attemptId],clone(a.next));if(options.partialFlush)throw new StorageUnavailable("not_committed");}
          for(const s of delta.series){const old=draft.student.series[s.seriesKey];assert.deepEqual({currentAttemptId:old.currentAttemptId,generation:old.generation,officialAttemptId:old.officialAttemptId,recoveryState:old.recoveryState,recovery:old.recovery},s.expected);Object.assign(watched.student.series[s.seriesKey],clone(s.next));}
          for(const g of delta.gates){const old=draft.student.assignments[g.assignmentId].reviewGate;assert.deepEqual({revision:old.revision,barrierRevision:old.barrier_revision},g.expected);Object.assign(watched.student.assignments[g.assignmentId].reviewGate,clone(g.next));}
          ctx.ledger.push("flush.done");
        },
      };
      let committing=false;
      try{
        if(options.loadFault)throw options.loadFault;
        const value=await work(tx);if(options.callbackAgain)await work(tx);ctx.ledger.push("callback.return");committing=true;ctx.ledger.push("commit.attempt");
        if(options.commit==="uncommitted"){ctx.ledger.push("connection.discard");throw new StorageUnavailable("commit_unknown");}
        durable=clone(draft);
        if(options.commit==="committed"){ctx.ledger.push("connection.discard");throw new StorageUnavailable("commit_unknown");}
        if(options.beforeAck)await options.beforeAck();ctx.ledger.push("commit.ack");
        return options.badAck?{transactionId:"foreign-tx",value}:{transactionId:ids.transactionId,value};
      }catch(e){if(!committing){ctx.ledger.push("rollback.attempt");if(options.rollbackAckLost)ctx.ledger.push("connection.discard");else ctx.ledger.push("rollback.ack");}throw e;}
      finally{ctx.portStaged=clone(draft);ctx.committed=clone(durable);ctx.preparedProjection=prepared?clone(prepared):null;}
    },
  };
  const factory=options.entry==="roster"?createRosterRemovalPreflight:createMembershipPreflight;
  const preflight=factory({mode:"local_contract",port,...options.factoryOptions});
  ctx.readStore=()=>clone(durable);
  return {port,preflight,read:()=>clone(durable),get identity(){return identity;}};
}
async function call(ctx,d,input=command()){
  try{const value=await d.preflight(input);ctx.acknowledgements++;ctx.ledger.push("caller.resolve");ctx.outcome=clone(value);return value;}
  catch(e){ctx.outcome={name:e.name,code:e.code,status:e.status,...(e.outcome?{storage_outcome:e.outcome}:{})};throw e;}
}
const technical=e=>e.code==="RESPONSE_INVARIANT_FAILED"&&e.status===500;
function assertCommitted(ctx,d,expected){ctx.expectedCommitted=clone(expected);assert.deepEqual(d.read(),expected);}
function unchanged(ctx,d,s){assertCommitted(ctx,d,s);ctx.expectedPortStaged=clone(s);assert.deepEqual(ctx.portStaged,s);assert.equal(ctx.acknowledgements,0);}

scenario("L1-valid-credential-canonical-actor",async ctx=>{const s=fixture(),d=double(ctx,s,{now:T-1});assert.deepEqual(await call(ctx,d),{kind:"wait_for_active_test"});assert.equal(d.identity.actorId,U);assert.equal(ctx.verifyCalls,1);assert.equal(ctx.directGuard,1);assert.equal(ctx.flushes,0);assertCommitted(ctx,d,s);});
for(const name of ["proof","state","now","role","decision","callback","port"])scenario("L1-reject-command-"+name,async ctx=>{const d=double(ctx);let reads=0;const input=command();Object.defineProperty(input,name,{get(){reads++;throw Error("REQUEST_HOOK");},enumerable:true});await assert.rejects(call(ctx,d,input),e=>e.code==="VALIDATION_ERROR");assert.equal(reads,0);assert.equal(ctx.verifyCalls,0);assert.equal(ctx.transactions,0);assert.equal(ctx.directGuard,0);});
scenario("L1-forged-credential",async ctx=>{const d=double(ctx);await assert.rejects(call(ctx,d,command({credential:await token({signer:otherKey.privateKey})})),e=>e.code==="STAFF_TOKEN_INVALID");assert.equal(ctx.transactions,0);assert.equal(ctx.directGuard,0);});
for(const mode of [undefined,"production"])scenario("L1-no-default-or-production-"+mode,async ctx=>{const d=double(ctx);assert.throws(()=>createMembershipPreflight({mode,port:d.port}),e=>e.code==="SERVICE_UNAVAILABLE");assert.equal(ctx.verifyCalls,0);});
scenario("L1-missing-binding",async ctx=>{assert.throws(()=>createMembershipPreflight({mode:"local_contract"}),e=>e.code==="SERVICE_UNAVAILABLE");assert.equal(ctx.directGuard,0);});
scenario("L1-port-cannot-retarget-command-scope",async ctx=>{const s=fixture(),d=double(ctx,s,{scopeMutation:true});await assert.rejects(call(ctx,d),e=>e instanceof TypeError);unchanged(ctx,d,s);assert.equal(ctx.directGuard,0);});
for(const [name,opts,code,status]of [
  ["mapping-revoked",{mappingRevoked:true},"STAFF_TOKEN_INVALID",401],
  ["provider-revoked",{providerRevoked:true},"STAFF_TOKEN_INVALID",401],
  ["provider-fault",{providerFault:true},"SERVICE_UNAVAILABLE",503],
  ["disabled",{authority:s=>{s.staff[U].enabled=false;}},"ACCOUNT_DISABLED",403],
  ["scope-revoked",{authority:s=>{s.staff[U].scope.group_ids=[];}},"NOT_FOUND",404],
  ["provider-expiry-equality",{providerExpiresAt:T},"STAFF_TOKEN_INVALID",401],
])scenario("L2-post-wait-"+name,async ctx=>{const s=fixture(),d=double(ctx,s,{wait:async()=>{ctx.ledger.push("wait.finished");},...opts});await assert.rejects(call(ctx,d),e=>e.code===code&&e.status===status);unchanged(ctx,d,s);assert.equal(ctx.directGuard,0);assert.equal(ctx.flushes,0);assert.equal(ctx.portWrites.length,0);});
for(const offset of [0,1])scenario("L2-proof-expiry-"+offset,async ctx=>{const s=fixture(),d=double(ctx,s,{now:T+offset});await assert.rejects(call(ctx,d,command({credential:await token({expires:T})})),e=>e.code==="STAFF_TOKEN_INVALID");unchanged(ctx,d,s);assert.equal(ctx.directGuard,0);assert.equal(ctx.flushes,0);});
scenario("L2-clock-after-wait-observed",async ctx=>{const s=fixture(),d=double(ctx,s,{wait:async()=>{ctx.ledger.push("deadline-crossed");},now:T});assert.equal((await call(ctx,d)).kind,"continue_existing_policy");assertCommitted(ctx,d,expectedExpiry(s));assert.ok(ctx.ledger.indexOf("refresh.clock")<ctx.ledger.indexOf("guard.enter"));assert.ok(ctx.ledger.indexOf("guard.enter")<ctx.ledger.indexOf("flush.begin"));});
const badFrames=[
  ["missing-receipt",f=>{delete f.coverage;}],["boolean-only",f=>{f.coverage={complete:true};}],
  ["stale-transaction",f=>{f.coverage.transactionId="stale";}],["stale-protection",f=>{f.coverage.protectionId="stale";}],["stale-frame",f=>{f.coverage.frameId="stale";}],
  ["scope",f=>{f.coverage.scope.groupId=H;}],["enumeration-omitted",f=>{delete f.coverage.enumerations.targetSeries;}],
  ["duplicate-key",f=>{f.coverage.enumerations.targetSeries.keys.push(K);}],["duplicate-enumeration-id",f=>{f.coverage.enumerations.participants.enumerationId=f.coverage.enumerations.targetSeries.enumerationId;}],
  ["contradictory-fact",f=>{f.coverage.rows.attempts.absent.push(A);}],["declared-row-missing",f=>{delete f.state.student.attempts[A];}],
  ["missing-participants",f=>{f.coverage.enumerations.participants.keys=[];}],["affected-closure-omitted",f=>{f.coverage.enumerations.affectedAssignments.keys=[];}],
  ["actor-frame-binding",f=>{f.actor={...f.actor,actorId:Q};}],["forged-frame-proof",f=>{f.actor={...f.actor,proof:{...f.actor.proof}};}],
];
for(const [name,edit]of badFrames)scenario("L3-"+name,async ctx=>{const s=fixture(),d=double(ctx,s,{frame:edit});await assert.rejects(call(ctx,d),technical);unchanged(ctx,d,s);assert.equal(ctx.directGuard,0);assert.equal(ctx.flushes,0);assert.equal(ctx.guardWrites.length,0);});
scenario("L3-proven-empty-enumeration",async ctx=>{const s=fixture();s.student.series={};s.student.attempts={};const d=double(ctx,s);assert.equal((await call(ctx,d)).kind,"continue_existing_policy");assertCommitted(ctx,d,s);assert.equal(ctx.directGuard,1);assert.equal(ctx.flushes,0);});
scenario("L3-explicit-absent-peer-grant-and-series",async ctx=>{const s=fixture();s.student.people[Q]=clone(s.student.people[P]);s.student.people[Q].profile.person_id=Q;s.memberships[Q]={affinityGroupId:H,active:false,revision:1,epoch:1};const d=double(ctx,s);await call(ctx,d);assertCommitted(ctx,d,expectedExpiry(s));assert.equal(ctx.directGuard,1);});
for(const kind of ["active","ready"])scenario("L3-off-group-peer-"+kind,async ctx=>{const s=fixture();peer(s,kind);const d=double(ctx,s);assert.equal((await call(ctx,d)).kind,"continue_existing_policy");assertCommitted(ctx,d,expectedExpiry(s,T,{peerActive:kind==="active",peerReady:kind==="ready"}));assert.equal(d.read().student.assignments[J].reviewGate.barrier_complete,false);assert.deepEqual(Object.keys(ctx.outcome),["kind"]);assert.equal(ctx.directGuard,1);});
scenario("L3-recovery-anchor-missing",async ctx=>{const s=fixture();peer(s,"ready");const d=double(ctx,s,{frame:f=>{f.coverage.enumerations.recoveryAnchors.keys=[];}});await assert.rejects(call(ctx,d),technical);unchanged(ctx,d,s);assert.equal(ctx.directGuard,0);assert.equal(ctx.flushes,0);});
scenario("L3-peer-foreign-record-rejected",async ctx=>{const s=fixture();peer(s,"active");s.student.attempts[B].personId=P;const d=double(ctx,s);await assert.rejects(call(ctx,d),technical);unchanged(ctx,d,s);assert.equal(ctx.directGuard,0);});
scenario("L3-explicit-absent-target-uses-guard-not-found",async ctx=>{const s=fixture();s.student.people={};s.memberships={};s.student.grants={};s.student.series={};s.student.attempts={};const d=double(ctx,s);ctx.expectedFunctions={maintenance:0,reconcile:0};await assert.rejects(call(ctx,d),e=>e.code==="NOT_FOUND"&&e.status===404);unchanged(ctx,d,s);assert.equal(ctx.directGuard,1);assert.equal(ctx.flushes,0);});
for(const corrupt of ["C04","R03"]){
  const damage=s=>{if(corrupt==="C04")s.student.attempts[A].id=id(999);else s.student.attempts[A].ordinary=ordinary(2,100,T-50);};
  for(const offset of [-1,0,1])scenario(`L4-${corrupt}-deadline:${offset}`,async ctx=>{const s=fixture();damage(s);const d=double(ctx,s,{now:T+offset});await assert.rejects(call(ctx,d),technical);unchanged(ctx,d,s);assert.equal(ctx.directGuard,1);assert.equal(ctx.guardWrites.length,0);assert.equal(ctx.flushes,0);});
  for(const sf of [true,false])for(const af of [true,false])scenario(`L4-${corrupt}-mixed:${sf}:${af}`,async ctx=>{const s=fixture(),other=second(s);damage(s);const valid=s.student.attempts[B],invalid=s.student.attempts[A];s.student.series=sf?{[other.key]:s.student.series[other.key],[K]:s.student.series[K]}:{[K]:s.student.series[K],[other.key]:s.student.series[other.key]};s.student.attempts=af?{[B]:valid,[A]:invalid}:{[A]:invalid,[B]:valid};const d=double(ctx,s);await assert.rejects(call(ctx,d),technical);unchanged(ctx,d,s);assert.equal(ctx.directGuard,1);assert.equal(ctx.guardWrites.length,0);assert.equal(ctx.flushes,0);});
}
for(const [name,field,reason]of [["group","expectedGroupRevision","group_revision_conflict"],["membership","expectedMembershipRevision","membership_revision_conflict"]])scenario("L4-clean-denial-"+name,async ctx=>{const s=fixture(),d=double(ctx,s);assert.deepEqual(await call(ctx,d,command({[field]:0})),{kind:"recognized_denial",reason});assertCommitted(ctx,d,expectedExpiry(s));assert.equal(ctx.directGuard,1);assert.equal(ctx.flushes,1);});
scenario("L4-owner-allowed",async ctx=>{const s=fixture();s.staff[U].roles=["owner"];s.staff[U].capabilities.manage_roster=false;const d=double(ctx,s,{now:T-1});assert.equal((await call(ctx,d)).kind,"wait_for_active_test");assertCommitted(ctx,d,s);});
scenario("L4-teacher-not-expanded",async ctx=>{const s=fixture();s.staff[U].roles=["teacher"];const d=double(ctx,s);await assert.rejects(call(ctx,d),e=>e.code==="FORBIDDEN"&&e.status===403);unchanged(ctx,d,s);assert.equal(ctx.directGuard,0);});
for(const offset of [0,1])scenario("L5-literal-expiry-"+offset,async ctx=>{const s=fixture(),d=double(ctx,s,{now:T+offset});assert.equal((await call(ctx,d)).kind,"continue_existing_policy");assertCommitted(ctx,d,expectedExpiry(s,T+offset));assert.equal(ctx.guardWrites.length,7);assert.equal(ctx.flushes,1);assert.ok(ctx.portWrites.length>0);assert.equal(ctx.directGuard,1);});
scenario("L5-started-recovery-completion-markers",async ctx=>{const s=fixture();s.student.attempts[A].generation=2;Object.assign(s.student.series[K],{generation:2,recoveryState:"active",recovery:{opensAt:C-1,closesAt:T+1,durationMs:60000}});const d=double(ctx,s);await call(ctx,d);assertCommitted(ctx,d,expectedExpiry(s));assert.equal(d.read().student.series[K].recoveryState,"none");});
for(const status of ["wait","continue","denial"])scenario("B-unstarted-ready-preserved-"+status,async ctx=>{const s=fixture(),extra=second(s);Object.assign(extra.a,{status:"submitted",completedAt:C+100,ordinary:ordinary()});Object.assign(s.student.series[extra.key],{officialAttemptId:B,recoveryState:"ready",recovery:{opensAt:T+1000,closesAt:T+2000,durationMs:500}});s.recoveryAssignments[extra.key]=extra.assignment;
  if(status!=="wait")Object.assign(s.student.attempts[A],{status:"submitted",completedAt:C+100,ordinary:ordinary()});
  const d=double(ctx,s,{now:T-1}),value=await call(ctx,d,command(status==="denial"?{expectedGroupRevision:0}:{}));assert.equal(value.kind,status==="wait"?"wait_for_active_test":status==="denial"?"recognized_denial":"continue_existing_policy");assertCommitted(ctx,d,s);assert.equal(ctx.flushes,0);
});
for(const [name,edit]of [
  ["membership",s=>{s.memberships[P].active=false;}],["group",s=>{s.groups[G].revision++;}],["grant",s=>{s.student.grants[P][J].rostered=false;}],
  ["auth",s=>{s.student.families.bad={personId:P};}],["profile",s=>{s.student.people[P].profile.first_name="changed";}],
  ["receipt",s=>{s.receipts.bad={payload:"bad"};}],["audit",s=>{s.audit.push({action:"bad"});}],
  ["answer",s=>{s.student.attempts[A].answers[0].revision++;}],["deadline",s=>{s.student.attempts[A].deadlineAt++;}],
  ["snapshot",s=>{s.student.attempts[A].published.durationMs++;}],
])scenario("L5-forbidden-delta-"+name,async ctx=>{const before=fixture(),after=expectedExpiry(before);edit(after);ctx.evidence_layer="DELTA_WHITELIST_UNIT_NOT_GUARD_RUN";ctx.initial=clone(before);ctx.forbiddenProposed=clone(after);ctx.forbiddenProposal=name;assert.throws(()=>expiryDelta(before,after,T,{transactionId:"t",protectionId:"p",frameId:"f",actorId:U,studentId:P,groupId:G}),technical);assert.equal(ctx.directGuard,0);assert.equal(ctx.flushes,0);});
scenario("L5-flush-does-not-receive-mutable-state-writer",async ctx=>{const s=fixture(),d=double(ctx,s,{forbiddenWriter:true});await assert.rejects(call(ctx,d),e=>e instanceof TypeError);unchanged(ctx,d,s);assert.equal(ctx.guardWrites.length,7);assert.equal(ctx.portWrites.length,0);});
scenario("L5-unsafe-expiry-revision-never-flushed",async ctx=>{const s=fixture();s.student.attempts[A].stateRevision=Number.MAX_SAFE_INTEGER;const d=double(ctx,s);await assert.rejects(call(ctx,d),technical);unchanged(ctx,d,s);assert.equal(ctx.flushes,0);assert.equal(ctx.directGuard,1);});
for(const [name,options]of [
  ["loader-exception",{loadFault:Error("SYNTHETIC_LOADER")}],["flush-storage",{flushFaultBefore:new StorageUnavailable("not_committed")}],
  ["flush-CAS",{casFault:true}],["partial-flush",{partialFlush:true}],["arbitrary409-reply",{flushReply:true}],
])scenario("L6-"+name,async ctx=>{const s=fixture(),d=double(ctx,s,options);await assert.rejects(call(ctx,d));assertCommitted(ctx,d,s);assert.equal(ctx.acknowledgements,0);assert.ok(ctx.ledger.includes("rollback.ack"));assert.equal(ctx.ledger.includes("commit.ack"),false);if(name==="partial-flush")assert.ok(ctx.portWrites.length>0);});
scenario("L6-rollback-ACK-loss-discards-without-confirmation",async ctx=>{const s=fixture(),d=double(ctx,s,{partialFlush:true,rollbackAckLost:true});await assert.rejects(call(ctx,d));assertCommitted(ctx,d,s);assert.equal(ctx.ledger.includes("rollback.ack"),false);assert.ok(ctx.ledger.includes("connection.discard"));assert.equal(ctx.acknowledgements,0);});
for(const mode of ["committed","uncommitted"])scenario("L7-COMMIT-ACK-loss-"+mode,async ctx=>{const s=fixture(),d=double(ctx,s,{commit:mode});await assert.rejects(call(ctx,d),e=>e instanceof StorageUnavailable&&e.outcome==="commit_unknown"&&e.status===503);assertCommitted(ctx,d,mode==="committed"?expectedExpiry(s):s);assert.equal(ctx.acknowledgements,0);assert.equal(ctx.transactions,1);assert.equal(ctx.verifyCalls,1);assert.equal(ctx.ledger.filter(x=>x==="commit.attempt").length,1);assert.equal(ctx.ledger.includes("rollback.attempt"),false);assert.ok(ctx.ledger.includes("connection.discard"));});
scenario("L7-value-visible-only-after-COMMIT-ACK",async ctx=>{let release;const gate=new Promise(r=>{release=r;});const s=fixture(),d=double(ctx,s,{beforeAck:async()=>{ctx.ledger.push("ack.pending");await gate;}});const pending=call(ctx,d);while(!ctx.ledger.includes("ack.pending"))await new Promise(r=>setImmediate(r));assert.equal(ctx.acknowledgements,0);release();await pending;assert.ok(ctx.ledger.indexOf("commit.ack")<ctx.ledger.indexOf("caller.resolve"));});
scenario("L7-wrong-transaction-ACK-cannot-certify-success",async ctx=>{const s=fixture(),d=double(ctx,s,{badAck:true});await assert.rejects(call(ctx,d),e=>e.outcome==="commit_unknown");assertCommitted(ctx,d,expectedExpiry(s));assert.equal(ctx.acknowledgements,0);assert.equal(ctx.ledger.includes("rollback.attempt"),false);});
scenario("L7-port-callback-reentry-cannot-repeat-mutation",async ctx=>{const s=fixture(),d=double(ctx,s,{callbackAgain:true});await assert.rejects(call(ctx,d),technical);assertCommitted(ctx,d,s);assert.equal(ctx.directGuard,1);assert.equal(ctx.flushes,1);assert.equal(ctx.acknowledgements,0);});

// REMOVAL-AUTH-01. Existing L1-L7/B assertions above retain their legacy entry.
const teacher=s=>{s.staff[U].roles=["teacher"];};
const guardContext=()=>({proof:{kind:"staff_verified",subject:U,notBefore:C-1,expiresAt:C+1000000},groupId:G,expectedGroupRevision:4,expectedMembershipRevision:7});
async function direct(ctx,s,{legacy=false,now=T-1,decision=RD.CONTINUE,context=guardContext(),boundary}={}){
  ctx.direct_guard_case=true;ctx.evidence_layer="DIRECT_DOMAIN_GUARD_NO_SQL_TRANSACTION";ctx.initial=clone(s);
  const draft=clone(s);ctx.clockReads=0;
  const tx=boundary??{state:draft,now(){ctx.clockReads++;return now;}};
  const entry=legacy?guardRemovalActiveTest:guardRosterRemovalActiveTest;
  let error;
  try{const value=await entry(tx,P,decision,context);ctx.outcome=clone(value);return value;}
  catch(e){error=e;ctx.outcome={name:e.name,code:e.code,status:e.status};throw e;}
  finally{ctx.committed=clone(error?s:draft);ctx.portStaged=null;ctx.domain_boundary="On error, preserved S0 models caller rollback; no real transaction was run";}
}
const authorityCases=[
  ["teacher-explicit",s=>teacher(s)],
  ["teacher-capability-before-hidden-target",s=>{teacher(s);s.staff[U].capabilities.manage_roster=false;delete s.groups[G];delete s.student.people[P];},"CAPABILITY_REQUIRED",403],
  ["admin-capability-before-hidden-target",s=>{s.staff[U].capabilities.manage_roster=false;delete s.groups[G];delete s.student.people[P];},"CAPABILITY_REQUIRED",403],
  ["teacher-no-explicit-grant",s=>{teacher(s);s.staff[U].scope.group_ids=[];},"NOT_FOUND",404],
  ["teacher-all-groups-only",s=>{teacher(s);s.staff[U].scope.group_ids=[];s.staff[U].scope.all_groups=true;},"NOT_FOUND",404],
  ["teacher-subject-only",s=>{teacher(s);s.staff[U].scope.group_ids=[];s.staff[U].capabilities.manage_content=false;s.staff[U].approvedSubjectIds=["physics"];},"NOT_FOUND",404],
  ["teacher-content-only",s=>{teacher(s);s.staff[U].scope.group_ids=[];s.staff[U].approvedSubjectIds=[];s.staff[U].capabilities.manage_content=true;},"NOT_FOUND",404],
  ["teacher-admin-all-groups",s=>{s.staff[U].roles=["teacher","admin"];s.staff[U].scope.group_ids=[];s.staff[U].scope.all_groups=true;}],
  ["teacher-admin-no-capability",s=>{s.staff[U].roles=["teacher","admin"];s.staff[U].scope.all_groups=true;s.staff[U].capabilities.manage_roster=false;},"CAPABILITY_REQUIRED",403],
  ["owner-teacher-bypass",s=>{s.staff[U].roles=["teacher","owner"];s.staff[U].capabilities.manage_roster=false;s.staff[U].scope.group_ids=[];}],
  ["owner-teacher-disabled",s=>{s.staff[U].roles=["teacher","owner"];s.staff[U].enabled=false;},"ACCOUNT_DISABLED",403],
  ["owner-teacher-unapproved",s=>{s.staff[U].roles=["teacher","owner"];s.staff[U].approved=false;},"STAFF_NOT_APPROVED",403],
  ["other-role",s=>{s.staff[U].roles=["student"];},"FORBIDDEN",403],
];
for(const mode of ["factory","guard"])for(const [name,edit,code,status]of authorityCases)scenario(`AUTH-${mode}-${name}`,async ctx=>{
  const s=fixture();edit(s);if(code)ctx.expectedFunctions={maintenance:0,reconcile:0};
  const d=mode==="factory"?double(ctx,s,{entry:"roster",now:T-1}):null;
  const invoke=()=>d?call(ctx,d):direct(ctx,s);
  if(code)await assert.rejects(invoke(),e=>e.code===code&&e.status===status);
  else assert.deepEqual(await invoke(),{kind:"wait_for_active_test"});
  if(d)assertCommitted(ctx,d,s);else{ctx.expectedCommitted=clone(s);assert.deepEqual(ctx.committed,s);}
  assert.equal(ctx.directGuard,mode==="guard"||!code?1:0);assert.equal(ctx.flushes,0);assert.equal(ctx.guardWrites.length,0);assert.equal(ctx.portWrites.length,0);
  if(ctx.directGuard)assert.deepEqual(ctx.guardEntries,["guardRosterRemovalActiveTest"]);
});
for(const mode of ["factory","guard"])for(const capability of [true,false])scenario(`AUTH-legacy-${mode}-teacher-cap:${capability}`,async ctx=>{
  const s=fixture();teacher(s);s.staff[U].capabilities.manage_roster=capability;ctx.expectedFunctions={maintenance:0,reconcile:0};
  if(mode==="factory"){const d=double(ctx,s);await assert.rejects(call(ctx,d),e=>e.code==="FORBIDDEN"&&e.status===403);unchanged(ctx,d,s);assert.equal(ctx.directGuard,0);}
  else{await assert.rejects(direct(ctx,s,{legacy:true}),e=>e.code==="FORBIDDEN"&&e.status===403);assert.deepEqual(ctx.committed,s);assert.deepEqual(ctx.guardEntries,["guardRemovalActiveTest"]);}
});
for(const role of ["admin","owner"])scenario("AUTH-legacy-direct-"+role,async ctx=>{const s=fixture();s.staff[U].roles=[role];if(role==="owner"){s.staff[U].capabilities.manage_roster=false;s.staff[U].scope.group_ids=[];}assert.deepEqual(await direct(ctx,s,{legacy:true}),{kind:"wait_for_active_test"});assert.deepEqual(ctx.committed,s);assert.deepEqual(ctx.guardEntries,["guardRemovalActiveTest"]);});
for(const mode of ["factory","guard"])for(const [name,payload]of [
  ["getter",hooks=>({get kind(){hooks.payload++;throw Error("HOSTILE_GET");}})],
  ["proxy",hooks=>new Proxy({},{get(){hooks.payload++;throw Error("HOSTILE_PROXY");},ownKeys(){hooks.payload++;throw Error("HOSTILE_KEYS");},getPrototypeOf(){hooks.payload++;throw Error("HOSTILE_PROTO");}})],
  ["revoked",()=>{const p=Proxy.revocable({},{});p.revoke();return p.proxy;}],
  ["callable",hooks=>()=>{hooks.payload++;}],
  ["thenable",hooks=>({get then(){hooks.payload++;throw Error("HOSTILE_THEN");}})],
  ["lookalike",()=>({...RD.CONTINUE})],
]){
  if(mode==="factory")continue; // Decisions are not factory command fields.
  for(const legacy of [true,false])scenario(`AUTH-identity-${legacy?"legacy":"roster"}-${name}`,async ctx=>{
    const s=fixture();teacher(s);const hooks={payload:0,clock:0,state:0,context:0};const decision=payload(hooks);
    const boundary={get now(){hooks.clock++;throw Error("EARLY_CLOCK");},get state(){hooks.state++;throw Error("EARLY_STATE");}};
    const context=new Proxy({},{get(){hooks.context++;throw Error("EARLY_CONTEXT");}});ctx.expectedFunctions={maintenance:0,reconcile:0};
    await assert.rejects(direct(ctx,s,{legacy,decision,boundary,context}),technical);
    assert.deepEqual(hooks,{payload:0,clock:0,state:0,context:0});ctx.hooks=hooks;assert.equal(ctx.directGuard,1);assert.equal(ctx.guardWrites.length,0);assert.deepEqual(ctx.committed,s);
  });
}
scenario("AUTH-new-command-field-precedes-verifier",async ctx=>{const s=fixture();teacher(s);const d=double(ctx,s,{entry:"roster"});let reads=0;const c=command();Object.defineProperty(c,"policy",{enumerable:true,get(){reads++;throw Error("POLICY_HOOK");}});await assert.rejects(call(ctx,d,c),e=>e.code==="VALIDATION_ERROR"&&e.status===422);assert.equal(reads,0);assert.equal(ctx.verifyCalls,0);assert.equal(ctx.transactions,0);assert.equal(ctx.directGuard,0);assertCommitted(ctx,d,s);});
for(const entry of ["legacy","roster"])scenario("AUTH-options-cannot-select-policy-"+entry,async ctx=>{const s=fixture();teacher(s);s.staff[U].scope.group_ids=[];let hooks=0;const d=double(ctx,s,{entry, factoryOptions:{policy:entry==="legacy"?"roster":"owner",role:"owner",guard:()=>{hooks++;}}});await assert.rejects(call(ctx,d),e=>e.code===(entry==="legacy"?"FORBIDDEN":"NOT_FOUND"));assert.equal(hooks,0);assert.equal(ctx.directGuard,0);assertCommitted(ctx,d,s);});
for(const mode of [undefined,"production"])scenario("AUTH-new-no-default-or-production-"+mode,async ctx=>{const d=double(ctx);assert.throws(()=>createRosterRemovalPreflight({mode,port:d.port}),e=>e.code==="SERVICE_UNAVAILABLE"&&e.status===503);assert.equal(ctx.verifyCalls,0);assert.equal(ctx.directGuard,0);});
for(const [name,options,code,status]of [
  ["grant-revoked",{authority:s=>{s.staff[U].scope.group_ids=[];}},"NOT_FOUND",404],
  ["capability-revoked",{authority:s=>{s.staff[U].capabilities.manage_roster=false;}},"CAPABILITY_REQUIRED",403],
  ["approval-revoked",{authority:s=>{s.staff[U].approved=false;}},"STAFF_NOT_APPROVED",403],
  ["disabled",{authority:s=>{s.staff[U].enabled=false;}},"ACCOUNT_DISABLED",403],
])scenario("AUTH-post-wait-"+name,async ctx=>{const s=fixture();teacher(s);const d=double(ctx,s,{entry:"roster",wait:async()=>{ctx.ledger.push("wait.finished");},...options});await assert.rejects(call(ctx,d),e=>e.code===code&&e.status===status);unchanged(ctx,d,s);assert.equal(ctx.directGuard,0);assert.equal(ctx.flushes,0);assert.equal(ctx.guardWrites.length,0);assert.equal(ctx.portWrites.length,0);});
for(const offset of [0,1])for(const owner of [false,true])scenario(`AUTH-proof-expiry-${owner?"owner-teacher":"teacher"}-${offset}`,async ctx=>{const s=fixture();teacher(s);if(owner)s.staff[U].roles.push("owner");const d=double(ctx,s,{entry:"roster",now:T+offset});await assert.rejects(call(ctx,d,command({credential:await token({expires:T})})),e=>e.code==="STAFF_TOKEN_INVALID"&&e.status===401);unchanged(ctx,d,s);assert.equal(ctx.directGuard,0);assert.equal(ctx.flushes,0);});
for(const [name,edit]of [
  ["missing",s=>{delete s.student.people[P];}],["disabled",s=>{s.student.people[P].enabled=false;}],
  ["incomplete",s=>{s.student.people[P].profile.registration_complete=false;}],["foreign-affinity",s=>{s.memberships[P].affinityGroupId=H;}],
])scenario("AUTH-target-"+name,async ctx=>{const s=fixture();teacher(s);edit(s);const d=double(ctx,s,{entry:"roster",now:T-1});ctx.expectedFunctions={maintenance:0,reconcile:0};await assert.rejects(call(ctx,d),e=>e.code==="NOT_FOUND"&&e.status===404);unchanged(ctx,d,s);assert.equal(ctx.directGuard,1);assert.equal(ctx.flushes,0);});
scenario("AUTH-inactive-preflight-is-not-final-removal409",async ctx=>{const s=fixture();teacher(s);s.memberships[P].active=false;s.student.people[P].profile.active_group_id=null;s.student.series={};s.student.attempts={};const d=double(ctx,s,{entry:"roster"});assert.equal((await call(ctx,d)).kind,"continue_existing_policy");assertCommitted(ctx,d,s);assert.equal(ctx.flushes,0);});
scenario("AUTH-shared-transfer-teacher-still-forbidden",async ctx=>{const f=staffFixture(),s=clone(f.store.state);assert.ok(s.staff["synthetic-teacher"].scope.group_ids.includes(transferIds.group));assert.ok(s.staff["synthetic-teacher"].scope.group_ids.includes(staffIds.targetGroup));const reply=await f.call(`/admin/students/${transferIds.person}/transfer`,transferBody(),{role:"synthetic-teacher-proof"});assert.equal(reply.status,403);assert.equal(reply.json.error.code,"FORBIDDEN");assert.deepEqual(f.store.state,s);ctx.initial=s;ctx.expectedCommitted=s;ctx.committed=clone(f.store.state);ctx.outcome={status:reply.status,code:reply.json.error.code};ctx.transfer_events=f.store.events;ctx.evidence_layer="EXISTING_TRANSFER_HTTP_RAM_CONTROL_NOT_PREFLIGHT";assert.equal(ctx.directGuard,0);});
for(const role of ["admin","owner"])scenario("AUTH-shared-authority-"+role,async ctx=>{const s=fixture();s.staff[U].roles=[role];if(role==="owner")s.staff[U].capabilities.manage_roster=false;const before=clone(s);requireRosterAuthority(s.staff[U]);assert.deepEqual(s,before);ctx.initial=before;ctx.committed=clone(s);ctx.evidence_layer="UNCHANGED_SHARED_AUTHORITY_UNIT_NOT_PREFLIGHT";});
for(const corrupt of ["C04","R03"]){
  const damage=s=>{if(corrupt==="C04")s.student.attempts[A].id=id(999);else s.student.attempts[A].ordinary=ordinary(2,100,T-50);};
  for(const offset of [-1,0,1])scenario(`AUTH-DOM-${corrupt}-deadline:${offset}`,async ctx=>{const s=fixture();teacher(s);damage(s);ctx.expectedFunctions={maintenance:0,reconcile:0};const d=double(ctx,s,{entry:"roster",now:T+offset});await assert.rejects(call(ctx,d),technical);unchanged(ctx,d,s);assert.deepEqual(ctx.guardEntries,["guardRosterRemovalActiveTest"]);assert.equal(ctx.guardWrites.length,0);assert.equal(ctx.flushes,0);});
  for(const sf of [true,false])for(const af of [true,false])scenario(`AUTH-DOM-${corrupt}-mixed:${sf}:${af}`,async ctx=>{const s=fixture();teacher(s);const other=second(s);damage(s);const valid=s.student.attempts[B],invalid=s.student.attempts[A];s.student.series=sf?{[other.key]:s.student.series[other.key],[K]:s.student.series[K]}:{[K]:s.student.series[K],[other.key]:s.student.series[other.key]};s.student.attempts=af?{[B]:valid,[A]:invalid}:{[A]:invalid,[B]:valid};ctx.expectedFunctions={maintenance:0,reconcile:0};const d=double(ctx,s,{entry:"roster"});await assert.rejects(call(ctx,d),technical);unchanged(ctx,d,s);assert.equal(ctx.directGuard,1);assert.equal(ctx.guardWrites.length,0);assert.equal(ctx.flushes,0);});
  for(const field of ["expectedGroupRevision","expectedMembershipRevision"])scenario(`AUTH-DOM-${corrupt}-corrupt-before-CAS-${field}`,async ctx=>{const s=fixture();teacher(s);damage(s);ctx.expectedFunctions={maintenance:0,reconcile:0};const d=double(ctx,s,{entry:"roster"});await assert.rejects(call(ctx,d,command({[field]:0})),technical);unchanged(ctx,d,s);assert.equal(ctx.guardWrites.length,0);assert.equal(ctx.flushes,0);});
}
for(const [name,field,reason]of [["group","expectedGroupRevision","group_revision_conflict"],["membership","expectedMembershipRevision","membership_revision_conflict"]])scenario("AUTH-DOM-clean-CAS-"+name,async ctx=>{const s=fixture();teacher(s);const d=double(ctx,s,{entry:"roster"});assert.deepEqual(await call(ctx,d,command({[field]:0})),{kind:"recognized_denial",reason});assertCommitted(ctx,d,expectedExpiry(s));assert.equal(ctx.guardWrites.length,7);assert.equal(ctx.flushes,1);assert.deepEqual(ctx.guardEntries,["guardRosterRemovalActiveTest"]);});
for(const offset of [0,1])scenario("AUTH-DOM-literal-expiry-"+offset,async ctx=>{const s=fixture();teacher(s);const d=double(ctx,s,{entry:"roster",now:T+offset});assert.equal((await call(ctx,d)).kind,"continue_existing_policy");assertCommitted(ctx,d,expectedExpiry(s,T+offset));assert.equal(ctx.guardWrites.length,7);assert.equal(ctx.portWrites.length,13);assert.equal(ctx.flushes,1);});
for(const [name,options]of [["flush-storage",{flushFaultBefore:new StorageUnavailable("not_committed")}],["flush-CAS",{casFault:true}],["partial-flush",{partialFlush:true}],["arbitrary409",{flushReply:true}],["immutable-delta-writer",{forbiddenWriter:true}]])scenario("AUTH-DOM-rollback-"+name,async ctx=>{const s=fixture();teacher(s);const d=double(ctx,s,{entry:"roster",...options});await assert.rejects(call(ctx,d));assertCommitted(ctx,d,s);assert.equal(ctx.acknowledgements,0);assert.ok(ctx.ledger.includes("rollback.ack"));assert.equal(ctx.ledger.includes("commit.attempt"),false);});
for(const mode of ["committed","uncommitted"])scenario("AUTH-DOM-COMMIT-ACK-loss-"+mode,async ctx=>{const s=fixture();teacher(s);const d=double(ctx,s,{entry:"roster",commit:mode});await assert.rejects(call(ctx,d),e=>e instanceof StorageUnavailable&&e.outcome==="commit_unknown"&&e.status===503);assertCommitted(ctx,d,mode==="committed"?expectedExpiry(s):s);assert.equal(ctx.acknowledgements,0);assert.equal(ctx.transactions,1);assert.equal(ctx.verifyCalls,1);assert.equal(ctx.ledger.filter(x=>x==="commit.attempt").length,1);assert.equal(ctx.ledger.includes("rollback.attempt"),false);});
for(const status of ["wait","continue","denial"])scenario("AUTH-B-ready-preserved-"+status,async ctx=>{const s=fixture();teacher(s);const extra=second(s);Object.assign(extra.a,{status:"submitted",completedAt:C+100,ordinary:ordinary()});Object.assign(s.student.series[extra.key],{officialAttemptId:B,recoveryState:"ready",recovery:{opensAt:T+1000,closesAt:T+2000,durationMs:500}});s.recoveryAssignments[extra.key]=extra.assignment;if(status!=="wait")Object.assign(s.student.attempts[A],{status:"submitted",completedAt:C+100,ordinary:ordinary()});const d=double(ctx,s,{entry:"roster",now:T-1});const result=await call(ctx,d,command(status==="denial"?{expectedGroupRevision:0}:{}));assert.equal(result.kind,status==="wait"?"wait_for_active_test":status==="denial"?"recognized_denial":"continue_existing_policy");assertCommitted(ctx,d,s);assert.equal(ctx.flushes,0);assert.equal(ctx.guardWrites.length,0);});

after(async()=>{
  await session.post("Profiler.stopPreciseCoverage");for(const b of breakpoints)await session.post("Debugger.removeBreakpoint",{breakpointId:b.breakpointId});session.disconnect();delete globalThis.__r1GuardWriteObserver;
  if(process.env.UA_R1_TRACE_PATH)writeFileSync(process.env.UA_R1_TRACE_PATH,JSON.stringify({scope:"AUTHOR_LOCAL_CONTRACT_OFFLINE_VERIFIER_RECORDING_DOUBLE_NOT_INDEPENDENT_QA",base:"b3d86559a743e13dcca65f2f6d227227ef297abf",source_fingerprints:fingerprints,
    observation_limits:"Debugger first guard identity line measures direct invocation; test-only argument Proxy observes subsequent reachable JS mutations. Probe attachment is excluded. Port-draft writes separately recorded. Precise coverage measures maintenance/reconcile. Net state snapshots are not transient traces. No SQL/provider locks or real COMMIT proof.",cases:results},(_,v)=>typeof v==="bigint"?{$bigint:String(v)}:v,2)+"\n");
});

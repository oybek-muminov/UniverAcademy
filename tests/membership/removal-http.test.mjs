import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { generateKeyPair, SignJWT } from "jose";
import { createMembershipRemovalHttpHandler } from "../../supabase/functions/univeracademy-api/membership-removal-http.ts";
import { createStaffJwtVerifier } from "../../supabase/functions/univeracademy-api/staff-jwt.ts";
import { STAFF_CONTRACT_SHA } from "../../supabase/functions/univeracademy-api/staff-state.ts";
import { ApiFault } from "../../supabase/functions/univeracademy-api/fault.ts";
import { StorageUnavailable } from "../../supabase/functions/univeracademy-api/storage/postgres-transaction.ts";
import { validate } from "../backend/staff-fixture.ts";

// All keys, proofs, identities and state are synthetic and offline.
const clone=structuredClone, id=n=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
const observed=new WeakMap(),cloneObserved=(v,...rest)=>clone(observed.get(v)??v,...rest);
globalThis.structuredClone=cloneObserved;
const P=id(1),Q=id(2),R=id(3),J=id(10),U=id(11),F=id(12),OLD=id(13),D=id(20),G=id(40),H=id(41),A=id(900),B=id(901),Z=id(902),K=P+"/"+D,S=id(501),C=Date.UTC(2026,10,5,12),T=C+60000,KEY="remove-0001";
const project=new URL("../../",import.meta.url),api="supabase/functions/univeracademy-api/";
const digest=x=>createHash("sha256").update(x).digest("hex");
const paths=[api+"membership-removal-http.ts","tests/membership/removal-http.test.mjs"];
const fingerprints=paths.map(path=>{const b=readFileSync(new URL(path,project));return{path,bytes:b.length,sha256:digest(b)};});
const pins=[
 [api+"membership-removal.ts","3477846790c594c6baf96ea5a15a0be83bcde6f33328d57feb5c6917139e4ccb"],
 [api+"membership-activity.ts","c4149e06a68778b39bd2e229188605d84fc4dda756dc5fc95016259a9226eb6b"],
 ["contracts/review-only.openapi.json",STAFF_CONTRACT_SHA],
 ["packages/api-client/staff-openapi.json","a1bdcd4e7177388e6eb0cf77bdde00a4a962ca7ac13fb921277f863ea0acacff"]];
for(const [path,sha]of pins)assert.equal(digest(readFileSync(new URL(path,project))),sha,path);
const issuer="https://offline.synthetic.invalid",audience="local-removal-review";
const keys=await generateKeyPair("RS256",{modulusLength:2048}),otherKeys=await generateKeyPair("RS256",{modulusLength:2048});
const verifyJwt=createStaffJwtVerifier({issuer,audience,algorithms:["RS256"],trustedKeys:async()=>keys.publicKey,now:()=>C});
async function signed({sub=S,iss=issuer,aud=audience,role="authenticated",anonymous=false,exp=(T+100000)/1000,key=keys.privateKey}={}){
 return new SignJWT({session_id:id(700),role,is_anonymous:anonymous}).setProtectedHeader({alg:"RS256"}).setIssuer(iss).setAudience(aud).setSubject(sub).setIssuedAt((C-1000)/1000).setExpirationTime(exp).sign(key);
}
const token=await signed(),route="/api/v1/admin/groups/"+G+"/members";
const ordinary=(at=C+20)=>({earned:{numerator:1n,denominator:1n},maximum:{numerator:2n,denominator:1n},percentage:{numerator:50n,denominator:1n},calculatedAt:at});
const proof=()=>({kind:"staff_verified",subject:S,notBefore:C-1,expiresAt:T+100000});
const body=()=>({student_id:P,status:"removed",expected_revision:4,expected_membership_revision:7});
const receiptKey=actor=>actor+"/PUT//admin/groups/"+G+"/members/"+KEY;
const payload='{"expected_membership_revision":7,"expected_revision":4,"status":"removed","student_id":"'+P+'"}';
const result=()=>({student_id:P,group_id:G,status:"removed",group_revision:5,membership_revision:8,revoked_unstarted_count:2});
function published(demo=D){return{demoId:demo,versionId:id(30),durationMs:60000,individualEnabled:false,questions:[
  {id:id(100),optionIds:[id(200),id(201),id(202),id(203)],correctOptionId:id(200),individualPoints:{numerator:2n,denominator:1n}},
  {id:id(101),optionIds:[id(204),id(205),id(206),id(207)],correctOptionId:id(204),individualPoints:{numerator:2n,denominator:1n}}]};}
function assignment(j,d,opensAt=C-1000,closesAt=C+5000){return{admission:{assignmentId:j,groupId:G,activeGroupId:null,rostered:false,profileComplete:false,membershipEpoch:0,grantEpoch:0,opensAt,closesAt},published:published(d),title:"Removal literal",instructions:[],contents:{},cancelled:false,
  reviewGate:{id:id(Number(j.slice(-3))+50),status:"blocked",revision:4,barrier_revision:0,barrier_complete:false,eligible_unresolved_count:1,active_count:0,recovery_ready_count:0,timezone:"Asia/Tashkent",first_opened_at:null,opens_at:null,closes_at:null}};}
function record(person=P,attempt=A,j=J,d=D){const pub=published(d);return{id:attempt,personId:person,assignmentId:j,groupId:G,generation:1,status:"submitted",startedAt:C,deadlineAt:T,completedAt:C+20,stateRevision:3,seriesStateRevision:3,published:pub,
  questionOrder:pub.questions.map(q=>({questionId:q.id,optionIds:[...q.optionIds]})),answers:[{questionId:id(100),selectedOptionId:id(200),revision:1,savedAt:C+10,seriesStateRevision:2}],ordinary:ordinary()};}
function fixture(){return{
 student:{people:{[P]:{telegramId:null,enabled:true,registeredAt:C-10000,profile:{person_id:P,first_name:"Literal",last_name:"Student",roles:["student"],registration_complete:true,active_group_id:G,qadam_id:"0100000001"}}},
 families:{keep:{personId:P,expiresAt:T+100000,revokedAt:null,logoutRetainUntil:null}},access:{keep:{familyId:"keep",expiresAt:T+1000,superseded:false}},refresh:{keep:{familyId:"keep",consumed:false}},consumedInitData:{keep:true},
 grants:{[P]:{[J]:{rostered:true,membershipEpoch:7,grantEpoch:7},[U]:{rostered:true,membershipEpoch:7,grantEpoch:7},[F]:{rostered:true,membershipEpoch:7,grantEpoch:7},[OLD]:{rostered:false,membershipEpoch:7,grantEpoch:6}}},
 assignments:{[J]:assignment(J,D),[U]:assignment(U,id(21),C-1000,T+1000),[F]:assignment(F,id(22),T+10000,T+20000),[OLD]:assignment(OLD,id(23))},
 series:{[K]:{id:id(800),currentAttemptId:A,generation:1,normalAttemptUsed:true,officialAttemptId:A,recoveryState:"none",recovery:null}},attempts:{[A]:record()},receipts:{keep:{payload:"student-history",attemptId:A}},
 bonuses:{[A]:{calculationId:id(999),earned:{numerator:3n,denominator:2n},calculatedAt:C+20}},cancellations:{keep:{cancelledAt:C-1,priorStatus:"submitted"}}},
 staff:{[S]:{personId:S,enabled:true,approved:true,roles:["teacher"],approvedSubjectIds:[],capabilities:{manage_roster:true,manage_content:false},scope:{all_groups:false,group_ids:[G],all_subjects:false,subject_ids:[]}}},
 groups:{[G]:{id:G,revision:4,status:"active"},[H]:{id:H,revision:2,status:"active"}},memberships:{[P]:{affinityGroupId:G,active:true,revision:7,epoch:7}},versions:{},recoveryAssignments:{},
 notifications:{started:{studentId:P,assignmentId:J,epoch:7,status:"queued"},unstarted:{studentId:P,assignmentId:U,epoch:7,status:"queued"},sent:{studentId:P,assignmentId:U,epoch:7,status:"sent"},newer:{studentId:P,assignmentId:F,epoch:8,status:"queued"},peer:{studentId:Q,assignmentId:U,epoch:7,status:"queued"}},
 approvals:{old:{studentId:P,epoch:7,status:"pending"},decided:{studentId:P,epoch:7,status:"approved"},newer:{studentId:P,epoch:8,status:"pending"},peer:{studentId:Q,epoch:7,status:"pending"}},
 receipts:{keep:{payload:"staff-history"}},audit:[{actorId:S,action:"keep",targetId:P,revision:7,at:C-1}]
};}
function active(s,deadline=T){Object.assign(s.student.attempts[A],{status:"in_progress",completedAt:null,stateRevision:2,seriesStateRevision:2,ordinary:null,deadlineAt:deadline});s.student.series[K].officialAttemptId=null;}
function ready(s,future=false){s.student.series[K].recoveryState="ready";s.student.series[K].recovery={opensAt:future?T+10000:T-1000,closesAt:T+20000,durationMs:3000};s.recoveryAssignments[K]=J;Object.assign(s.student.assignments[J].reviewGate,{eligible_unresolved_count:1,recovery_ready_count:1});}
function peer(s,person,kind){
 s.student.people[person]={...clone(s.student.people[P]),profile:{...clone(s.student.people[P].profile),person_id:person,active_group_id:H}};
 s.memberships[person]={affinityGroupId:H,active:true,revision:7,epoch:7};s.student.grants[person]={[U]:{rostered:true,membershipEpoch:7,grantEpoch:7}};
 const key=person+"/"+id(21),a=person===Q?B:Z,r=record(person,a,U,id(21));
 s.student.attempts[a]=r;s.student.series[key]={id:id(801),currentAttemptId:a,generation:1,normalAttemptUsed:true,officialAttemptId:a,recoveryState:"none",recovery:null};
 if(kind==="active"){Object.assign(r,{status:"in_progress",completedAt:null,stateRevision:2,seriesStateRevision:2,ordinary:null,deadlineAt:T+5000});s.student.series[key].officialAttemptId=null;}
 else {s.student.series[key].recoveryState="ready";s.student.series[key].recovery={opensAt:T+10000,closesAt:T+20000,durationMs:3000};s.recoveryAssignments[key]=U;}
}
// Independent literal whole-state oracle. Known fixture rows are set explicitly;
// no candidate guard, scorer, canonicalizer or effect helper supplies expected data.
function expectedSuccess(s,{readyRight=false,peerCount=0,activeCount=0,readyCount=0}={}){
 const out=clone(s);Object.assign(out.memberships[P],{active:false,revision:8,epoch:8});out.groups[G].revision=5;out.student.people[P].profile.active_group_id=null;
 out.student.grants[P][J].membershipEpoch=8;
 Object.assign(out.student.grants[P][U],{rostered:false,membershipEpoch:8});
 Object.assign(out.student.grants[P][F],{rostered:false,membershipEpoch:8});out.student.grants[P][OLD].membershipEpoch=8;
 out.notifications.started.status="cancelled";out.notifications.unstarted.status="cancelled";out.approvals.old.status="stale";
 Object.assign(out.student.assignments[U].reviewGate,{eligible_unresolved_count:peerCount,active_count:activeCount,recovery_ready_count:readyCount,barrier_complete:false,barrier_revision:1});
 Object.assign(out.student.assignments[F].reviewGate,{eligible_unresolved_count:0,active_count:0,recovery_ready_count:0,barrier_complete:false,barrier_revision:1});
 if(readyRight){out.recoveryRevocations=[{seriesKey:K,generation:1,assignmentId:J,actorId:S,oldEpoch:7,revokedAt:T,window:clone(s.student.series[K].recovery)}];out.student.series[K].recoveryState="none";out.student.series[K].recovery=null;
  Object.assign(out.student.assignments[J].reviewGate,{eligible_unresolved_count:0,active_count:0,recovery_ready_count:0,barrier_complete:true,barrier_revision:1});}
 out.receipts[receiptKey(S)]={payload,membership:result()};out.audit.push({actorId:S,action:"membership_removal",targetId:P,revision:8,at:T});return out;
}
function expectedExpiry(s,now=T){const out=clone(s);Object.assign(out.student.attempts[A],{status:"expired",completedAt:T,stateRevision:3,seriesStateRevision:3,ordinary:ordinary(now)});out.student.series[K].officialAttemptId=A;
 Object.assign(out.student.assignments[J].reviewGate,{eligible_unresolved_count:0,active_count:0,recovery_ready_count:0,barrier_complete:true,barrier_revision:1});return out;}

function watch(raw,ctx,faultPath){
 const cache=new WeakMap(),reverse=new WeakMap();
 function strip(v,seen=new WeakSet()){if(!v||typeof v!=="object")return v;if(reverse.has(v))return reverse.get(v);if(seen.has(v))return v;seen.add(v);for(const k of Reflect.ownKeys(v)){const d=Object.getOwnPropertyDescriptor(v,k);if(d&&"value"in d){const x=strip(d.value,seen);if(x!==d.value)Object.defineProperty(v,k,{...d,value:x});}}return v;}
 function wrap(v,path){if(!v||typeof v!=="object")return v;if(cache.has(v))return cache.get(v);
  const note=(op,k,value)=>{const p=path+"/"+String(k);ctx.writes.push({op,path:p,value:clone(strip(value))});ctx.ledger.push("write:"+op+":"+p);if(p===faultPath)throw ctx.injected;};
  const p=new Proxy(v,{get(t,k){if(path==="/receipts"&&typeof k==="string"&&k.includes("/PUT/"))ctx.ledger.push("receipt.lookup");return wrap(Reflect.get(t,k,t),path+"/"+String(k));},set(t,k,x){note("set",k,x);return Reflect.set(t,k,strip(x),t);},defineProperty(t,k,d){note("define",k,d.value);return Reflect.defineProperty(t,k,{...d,...("value"in d?{value:strip(d.value)}:{})});},deleteProperty(t,k){note("delete",k,undefined);return Reflect.deleteProperty(t,k);}});
  cache.set(v,p);reverse.set(p,v);observed.set(p,v);return p;
 }return wrap(raw,"");
}
let current;
const session=new Session();session.connect();await session.post("Debugger.enable");
session.on("Debugger.paused",e=>{try{assert.ok(current);const name=e.params.callFrames[0].functionName;const tag={removeRosterMember:"domain",guardRosterRemovalActiveTest:"guard",reconcileMembershipEffects:"effect"}[name];assert.ok(tag,name);current[tag]++;current.ledger.push(tag+".enter");void session.post("Debugger.resume").catch(e=>{current.instrumentation_error=e.message;});}catch(e){if(current)current.instrumentation_error=e.message;}});
const breakpoints=[];
for(const [file,needle,which]of [
 ["membership-removal.ts","  const now = tx.now();",0],
 ["membership-activity.ts","  if (decision !== REMOVAL_DECISION.CONTINUE && decision !== REMOVAL_DECISION.DENY_GROUP_REVISION",1],
 ["membership-effects.ts","  const s = state.student;",0]]){
 const url=new URL(api+file,project),lines=readFileSync(url,"utf8").split("\n").flatMap((l,i)=>l.startsWith(needle)?[i]:[]);
 assert.ok(lines.length>which,file);const bp=await session.post("Debugger.setBreakpointByUrl",{url:url.href,lineNumber:lines[which]});assert.ok(bp.locations.length,file);breakpoints.push(bp.breakpointId);
}
const cases=[];
function scenario(name,work){test(name,async()=>{const c={case_id:name,started_utc:new Date().toISOString(),layer:"AUTHOR_LOCAL_HTTP_OFFLINE_JWT_RECORDING_DOUBLE_NOT_DB",verify:0,transactions:0,domain:0,guard:0,effect:0,clock:0,commit_attempts:0,commit_acks:0,retries:0,ledger:[],writes:[]};current=c;let failure;
 try{await work(c);assert.equal(c.instrumentation_error,undefined);c.verdict="PASS";}catch(e){failure=e;c.verdict="FAIL";c.assertion={name:e.name,message:e.message,stack:e.stack};}
 finally{c.finished_utc=new Date().toISOString();c.source_fingerprints=fingerprints;c.accepted_source_pins=pins;c.command=[process.execPath,...process.execArgv,...process.argv.slice(1)];c.exit=failure?1:0;cases.push(c);current=null;}
 if(failure)throw failure;
});}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};}
function local(c,initial=fixture(),o={}){
 const state={value:clone(initial)};c.initial=clone(initial);c.injected=o.injected??new Error("SYNTHETIC_STORAGE_FAILURE");
 const transactions={async transaction(work){c.transactions++;c.ledger.push("transaction.begin");
  if(o.loadFault)throw new StorageUnavailable("not_committed");
  if(o.beforeWork)await o.beforeWork(state.value);c.ledger.push("lock.acquired");
  const draft=clone(state.value);c.authoritative_initial=clone(state.value);let committing=false;
  try{const value=await work({state:o.nativePlain?draft:watch(draft,c,o.faultPath),now(){c.clock++;c.ledger.push("clock.after-lock");return o.now??T;}});
   c.staged=clone(draft);c.ledger.push("work.return:"+value.kind);c.commit_attempts++;c.ledger.push("commit.attempt");committing=true;
   if(o.commitGate){c.ledger.push("commit.wait");o.entered?.resolve();await o.commitGate.promise;}
   if(o.commit==="uncommitted"){c.ledger.push("commit.ack.lost","connection.discard");throw new StorageUnavailable("commit_unknown");}
   if(o.preCommitFault){committing=false;throw new StorageUnavailable("not_committed");}
   state.value=clone(draft);
   if(o.commit==="committed"){c.ledger.push("commit.ack.lost","connection.discard");throw new StorageUnavailable("commit_unknown");}
   c.commit_acks++;c.ledger.push("commit.ack");return value;
  }catch(e){c.staged=clone(draft);c.transaction_error={name:e.name,code:e.code,status:e.status,outcome:e.outcome,message:e.message};
   if(!committing){c.ledger.push("rollback.attempt");if(o.rollbackAckLost)c.ledger.push("rollback.ack.lost","connection.discard");else c.ledger.push("rollback.ack");}
   throw e;
  }finally{c.committed=clone(state.value);}
 }};
 const verify=async credential=>{c.verify++;c.ledger.push("verifier.start");if(o.verifyUnexpected)throw new Error("OFFLINE_VERIFIER_FAULT");if(o.verifyFault)throw new ApiFault("SERVICE_UNAVAILABLE",503);const p=await verifyJwt(credential);c.ledger.push("verifier.verified");return p;};
 const check=(schema,value)=>{c.ledger.push("validate:"+schema);if(o.responseError&&schema==="MembershipMutation")throw o.responseError;if(o.responseInvalid&&schema==="MembershipMutation")return false;return validate(schema,value);};
 const deps={mode:"local_contract",transactions,verifyStaffToken:verify,contractSha:STAFF_CONTRACT_SHA,validate:check};
 const handler=createMembershipRemovalHttpHandler(deps);
 return{state,deps,handler};
}
function request(o={}){
 const headers={"authorization":"Bearer "+(o.token??token),"content-type":"application/json","idempotency-key":o.key??KEY,...o.headers};
 if(o.noAuth)delete headers.authorization;if(o.noKey)delete headers["idempotency-key"];
 return new Request("https://local.synthetic.invalid"+(o.path??route),{method:o.method??"PUT",headers,body:o.noBody?undefined:o.raw??JSON.stringify(o.body??body())});
}
async function call(c,l,o={}){c.request={method:o.method??"PUT",path:o.path??route,body:o.raw??o.body??body(),key:o.noKey?null:o.key??KEY,credential:"REDACTED_SYNTHETIC_OFFLINE_JWT"};const response=await l.handler(request(o));c.ledger.push("response.resolved");const json=await response.json();c.http={status:response.status,json,headers:Object.fromEntries(response.headers)};assert.equal(response.headers.get("cache-control"),"no-store");assert.equal(response.headers.get("content-type"),"application/json; charset=utf-8");return{response,json};}
function ok(r,expected=result()){assert.equal(r.response.status,200);assert.deepEqual(r.json,{data:expected});assert.ok(validate("MembershipMutation",r.json.data));}
function bad(r,code,status){assert.equal(r.response.status,status,JSON.stringify(r.json));assert.deepEqual(Object.keys(r.json),["error"]);assert.deepEqual(Object.keys(r.json.error).sort(),["code","message","request_id"]);assert.equal(r.json.error.code,code);assert.equal(r.json.error.message,code);assert.match(r.json.error.request_id,/^[0-9a-f-]{36}$/i);assert.ok(validate("Error",r.json));}
function same(c,s){assert.deepEqual(c.committed??c.initial,s);}
function expected(c,s){c.expected_committed=clone(s);same(c,s);}

scenario("HTTP-literal-success-Teacher",async c=>{const s=fixture(),l=local(c,s);ok(await call(c,l));expected(c,expectedSuccess(s));assert.equal(c.domain,1);assert.equal(c.guard,1);assert.equal(c.effect,1);assert.equal(c.commit_acks,1);assert.ok(c.writes.length>0);assert.ok(c.ledger.indexOf("commit.ack")<c.ledger.indexOf("response.resolved"));});
for(const [name,change]of [
 ["Admin",s=>s.staff[S].roles=["admin"]],["Owner",s=>{s.staff[S].roles=["owner"];s.staff[S].capabilities.manage_roster=false;s.staff[S].scope.group_ids=[];}],
 ["Owner-Teacher",s=>{s.staff[S].roles=["teacher","owner"];s.staff[S].capabilities.manage_roster=false;s.staff[S].scope.group_ids=[];}],
 ["Admin-Teacher-all",s=>{s.staff[S].roles=["teacher","admin"];s.staff[S].scope.group_ids=[];s.staff[S].scope.all_groups=true;}]
])scenario("HTTP-authority-success-"+name,async c=>{const s=fixture();change(s);const l=local(c,s);ok(await call(c,l));expected(c,expectedSuccess(s));});
for(const future of [false,true])scenario("HTTP-B-success-ready-future="+future,async c=>{const s=fixture();ready(s,future);const l=local(c,s);ok(await call(c,l));expected(c,expectedSuccess(s,{readyRight:true}));assert.equal(c.committed.recoveryRevocations.length,1);});
for(const kind of ["active","future-ready","both"])scenario("HTTP-peer-barrier-"+kind,async c=>{const s=fixture();peer(s,Q,kind==="both"?"active":kind);if(kind==="both")peer(s,R,"future-ready");const l=local(c,s);ok(await call(c,l));expected(c,expectedSuccess(s,{peerCount:kind==="both"?2:1,activeCount:kind==="future-ready"?0:1,readyCount:kind==="active"?0:1}));});

for(const [name,o,code,status]of [
 ["malformed",{raw:"{"},"MALFORMED_JSON",400],["empty",{raw:""},"MALFORMED_JSON",400],["null",{raw:"null"},"VALIDATION_ERROR",422],["array",{raw:"[]"},"VALIDATION_ERROR",422],
 ["active",{body:{...body(),status:"active"}},"VALIDATION_ERROR",422],["bad-status",{body:{...body(),status:"inactive"}},"VALIDATION_ERROR",422],
 ["student-format",{body:{...body(),student_id:"qadam-0100000001"}},"VALIDATION_ERROR",422],
 ["negative-group",{body:{...body(),expected_revision:-1}},"VALIDATION_ERROR",422],
 ["negative-member",{body:{...body(),expected_membership_revision:-1}},"VALIDATION_ERROR",422],
 ["fraction-group",{body:{...body(),expected_revision:4.5}},"VALIDATION_ERROR",422],
 ["unsafe-group",{raw:'{"student_id":"'+P+'","status":"removed","expected_revision":9007199254740992,"expected_membership_revision":7}'},"VALIDATION_ERROR",422],
 ["rounded-group",{raw:'{"student_id":"'+P+'","status":"removed","expected_revision":4.0000000000000001,"expected_membership_revision":7}'},"VALIDATION_ERROR",422],
 ["rounded-member",{raw:'{"student_id":"'+P+'","status":"removed","expected_revision":4,"expected_membership_revision":7.0000000000000001}'},"VALIDATION_ERROR",422],
 ["boolean-CAS",{body:{...body(),expected_revision:true}},"VALIDATION_ERROR",422],
 ["missing-key",{noKey:true},"VALIDATION_ERROR",422],["short-key",{key:"1234567"},"VALIDATION_ERROR",422],["long-key",{key:"k".repeat(129)},"VALIDATION_ERROR",422]
])scenario("HTTP-validation-"+name,async c=>{const s=fixture(),l=local(c,s);bad(await call(c,l,o),code,status);expected(c,s);assert.equal(c.writes.length,0);assert.equal(c.guard,0);});
for(const field of ["student_id","status","expected_revision","expected_membership_revision"])scenario("HTTP-validation-missing-"+field,async c=>{const s=fixture(),b=body();delete b[field];const l=local(c,s);bad(await call(c,l,{body:b}),"VALIDATION_ERROR",422);expected(c,s);assert.equal(c.domain,0);});
for(const field of ["proof","state","now","role","decision","callback","transactions","verifyStaffToken"])scenario("HTTP-request-cannot-bind-"+field,async c=>{const s=fixture(),l=local(c,s);bad(await call(c,l,{body:{...body(),[field]:{role:"owner"}}}),"VALIDATION_ERROR",422);expected(c,s);assert.equal(c.domain,0);});
for(const length of [8,128])scenario("HTTP-key-boundary-"+length,async c=>{const s=fixture(),l=local(c,s),key="k".repeat(length);ok(await call(c,l,{key}));const out=expectedSuccess(s);out.receipts[S+"/PUT//admin/groups/"+G+"/members/"+key]=out.receipts[receiptKey(S)];delete out.receipts[receiptKey(S)];expected(c,out);});
scenario("HTTP-integer-equivalent-source-lexemes",async c=>{const s=fixture(),l=local(c,s);ok(await call(c,l,{raw:'{"student_id":"'+P+'","status":"removed","expected_revision":4.0,"expected_membership_revision":7e0}'}));expected(c,expectedSuccess(s));});
scenario("HTTP-trailing-slash-canonical-receipt",async c=>{const s=fixture(),l=local(c,s);ok(await call(c,l,{path:route+"/"}));expected(c,expectedSuccess(s));});
for(const [name,o]of [
 ["wrong-prefix",{path:"/admin/groups/"+G+"/members"}],["extra-suffix",{path:route+"/remove"}],["bad-group",{path:"/api/v1/admin/groups/not-a-uuid/members"}],
 ["encoded-group",{path:"/api/v1/admin/groups/%30"+G.slice(1)+"/members"}],["GET",{method:"GET",noBody:true}],["POST",{method:"POST"}],["DELETE",{method:"DELETE"}]
])scenario("HTTP-route-"+name,async c=>{const s=fixture(),l=local(c,s);bad(await call(c,l,o),"NOT_FOUND",404);expected(c,s);assert.equal(c.domain,0);assert.equal(c.writes.length,0);});
for(const [name,o]of [["missing",{noAuth:true}],["scheme",{headers:{authorization:"Basic local-only"}}],["extra-token",{headers:{authorization:"Bearer a b"}}]])scenario("HTTP-token-header-"+name,async c=>{const s=fixture(),l=local(c,s);bad(await call(c,l,o),"STAFF_TOKEN_INVALID",401);same(c,s);assert.equal(c.verify,0);assert.equal(c.transactions,0);});
for(const [name,claims]of [
 ["signature",{key:otherKeys.privateKey}],["issuer",{iss:"https://other.synthetic.invalid"}],["audience",{aud:"other"}],["missing-staff",{sub:id(599)}],
 ["role",{role:"admin"}],["anonymous",{anonymous:true}],["expired",{exp:(C-1000)/1000}]
])scenario("HTTP-offline-JWT-"+name,async c=>{const s=fixture(),l=local(c,s);bad(await call(c,l,{token:await signed(claims)}),"STAFF_TOKEN_INVALID",401);same(c,s);assert.equal(c.domain,0);assert.equal(c.writes.length,0);});
scenario("HTTP-verifier-fault-fail-closed",async c=>{const s=fixture(),l=local(c,s,{verifyFault:true});bad(await call(c,l),"SERVICE_UNAVAILABLE",503);same(c,s);assert.equal(c.transactions,0);});

for(const [name,change,code,status]of [
 ["Teacher-no-cap",s=>s.staff[S].capabilities.manage_roster=false,"CAPABILITY_REQUIRED",403],
 ["Admin-no-cap",s=>{s.staff[S].roles=["admin"];s.staff[S].capabilities.manage_roster=false;},"CAPABILITY_REQUIRED",403],
 ["Teacher-all-only",s=>{s.staff[S].scope.group_ids=[];s.staff[S].scope.all_groups=true;},"NOT_FOUND",404],
 ["Teacher-no-grant",s=>s.staff[S].scope.group_ids=[],"NOT_FOUND",404],
 ["Teacher-subject-only",s=>{s.staff[S].scope.group_ids=[];s.staff[S].approvedSubjectIds=["physics"];},"NOT_FOUND",404],
 ["Teacher-content-only",s=>{s.staff[S].scope.group_ids=[];s.staff[S].capabilities.manage_content=true;},"NOT_FOUND",404],
 ["Admin-no-scope",s=>{s.staff[S].roles=["admin"];s.staff[S].scope.group_ids=[];},"NOT_FOUND",404],
 ["disabled",s=>s.staff[S].enabled=false,"ACCOUNT_DISABLED",403],
 ["unapproved",s=>s.staff[S].approved=false,"STAFF_NOT_APPROVED",403],
 ["other-role",s=>s.staff[S].roles=["observer"],"FORBIDDEN",403],
 ["missing-student",s=>delete s.student.people[P],"NOT_FOUND",404],
 ["disabled-student",s=>s.student.people[P].enabled=false,"NOT_FOUND",404],
 ["incomplete-student",s=>s.student.people[P].profile.registration_complete=false,"NOT_FOUND",404],
 ["foreign-affinity",s=>s.memberships[P].affinityGroupId=H,"NOT_FOUND",404]
])scenario("HTTP-current-authority-privacy-"+name,async c=>{const s=fixture();change(s);const l=local(c,s);bad(await call(c,l),code,status);expected(c,s);assert.equal(c.guard,0);assert.equal(c.writes.length,0);});
for(const role of ["teacher","admin"])scenario("HTTP-capability-before-body-target-"+role,async c=>{const s=fixture();s.staff[S].roles=[role];s.staff[S].capabilities.manage_roster=false;delete s.groups[G];delete s.student.people[P];const l=local(c,s);bad(await call(c,l,{raw:"{"}),"CAPABILITY_REQUIRED",403);expected(c,s);assert.equal(c.domain,0);assert.equal(c.writes.length,0);assert.equal(c.ledger.includes("validate:MemberWrite"),false);});
for(const [name,change,code,status]of [
 ["grant",s=>s.staff[S].scope.group_ids=[],"NOT_FOUND",404],["capability",s=>s.staff[S].capabilities.manage_roster=false,"CAPABILITY_REQUIRED",403],
 ["approval",s=>s.staff[S].approved=false,"STAFF_NOT_APPROVED",403],["disable",s=>s.staff[S].enabled=false,"ACCOUNT_DISABLED",403]
])scenario("HTTP-post-wait-revocation-"+name,async c=>{const l=local(c,fixture(),{beforeWork:async s=>{c.ledger.push("wait.finished");change(s);}});bad(await call(c,l),code,status);same(c,c.authoritative_initial);assert.equal(c.domain,0);assert.equal(c.guard,0);assert.equal(c.effect,0);assert.equal(c.writes.length,0);});
for(const delta of [0,1])scenario("HTTP-post-lock-proof-expiry:"+delta,async c=>{const s=fixture(),l=local(c,s,{now:T+100000+delta});bad(await call(c,l),"STAFF_TOKEN_INVALID",401);expected(c,s);assert.equal(c.domain,0);assert.equal(c.writes.length,0);});
for(const [name,change]of [
 ["default",d=>delete d.mode],["production",d=>d.mode="production"],["transactions",d=>delete d.transactions],["verifier",d=>delete d.verifyStaffToken],
 ["validator",d=>delete d.validate],["contract",d=>d.contractSha="0".repeat(64)]
])scenario("HTTP-binding-fail-closed-"+name,async c=>{const l=local(c);change(l.deps);l.handler=createMembershipRemovalHttpHandler(l.deps);bad(await call(c,l),"SERVICE_UNAVAILABLE",503);assert.equal(c.verify,0);assert.equal(c.transactions,0);assert.equal(c.writes.length,0);});
scenario("HTTP-binding-captured-not-request-selectable",async c=>{const s=fixture(),l=local(c,s);l.deps.transactions={transaction(){throw new Error("replacement must not run");}};l.deps.verifyStaffToken=()=>{throw new Error("replacement must not run");};l.deps.validate=()=>false;ok(await call(c,l));expected(c,expectedSuccess(s));});

for(const delta of [-1,0,1])for(const field of ["group","member"])scenario("HTTP-clean-CAS-"+field+":"+delta,async c=>{
 const s=fixture();active(s);const l=local(c,s,{now:T+delta}),b={...body(),[field==="group"?"expected_revision":"expected_membership_revision"]:field==="group"?3:6};
 bad(await call(c,l,{body:b}),field==="group"?"RESOURCE_REVISION_CONFLICT":"STATE_REVISION_CONFLICT",409);
 expected(c,delta<0?s:expectedExpiry(s,T+delta));assert.equal(c.commit_acks,1);assert.ok(c.ledger.includes("work.return:denied"));assert.equal(c.ledger.includes("rollback.attempt"),false);
 assert.ok(c.ledger.indexOf("commit.ack")<c.ledger.indexOf("response.resolved"));assert.equal(c.committed.memberships[P].active,true);assert.equal(c.committed.audit.length,1);
});
scenario("HTTP-group-CAS-precedes-member-CAS",async c=>{const s=fixture(),l=local(c,s);bad(await call(c,l,{body:{...body(),expected_revision:3,expected_membership_revision:6}}),"RESOURCE_REVISION_CONFLICT",409);expected(c,s);assert.equal(c.commit_acks,1);});
scenario("HTTP-active-waits",async c=>{const s=fixture();active(s,T+1);const l=local(c,s);bad(await call(c,l),"ACTIVE_EXAM_OR_RECOVERY",409);expected(c,s);assert.equal(c.writes.length,0);assert.equal(c.commit_acks,1);});
for(const delta of [0,1])scenario("HTTP-literal-expiry-then-remove:"+delta,async c=>{const s=fixture();active(s);const l=local(c,s,{now:T+delta});ok(await call(c,l));const out=expectedSuccess(expectedExpiry(s,T+delta));out.audit[1].at=T+delta;expected(c,out);});
for(const delta of [-1,0,1])scenario("HTTP-inactive-before-wait:"+delta,async c=>{const s=fixture();active(s);s.memberships[P].active=false;s.student.people[P].profile.active_group_id=null;const l=local(c,s,{now:T+delta});bad(await call(c,l),"MEMBERSHIP_STATE_CONFLICT",409);expected(c,delta<0?s:expectedExpiry(s,T+delta));assert.equal(c.commit_acks,1);assert.equal(c.committed.recoveryRevocations,undefined);});
for(const future of [false,true])for(const field of ["group","member"])scenario("HTTP-CAS-preserves-ready:"+future+":"+field,async c=>{const s=fixture();ready(s,future);const l=local(c,s);bad(await call(c,l,{body:{...body(),[field==="group"?"expected_revision":"expected_membership_revision"]:0}}),field==="group"?"RESOURCE_REVISION_CONFLICT":"STATE_REVISION_CONFLICT",409);expected(c,s);assert.equal(c.writes.length,0);});
for(const corrupt of ["IDKEY","ORDINARY"])for(const delta of [-1,0,1])scenario("HTTP-invariant-"+corrupt+":"+delta,async c=>{const s=fixture();active(s);if(corrupt==="IDKEY")s.student.attempts[A].id=B;else s.student.attempts[A].ordinary=ordinary(C-50);const l=local(c,s,{now:T+delta});bad(await call(c,l,{body:{...body(),expected_revision:3}}),"RESPONSE_INVARIANT_FAILED",500);expected(c,s);assert.equal(c.guard,1);assert.equal(c.effect,0);assert.equal(c.writes.length,0);assert.equal(c.commit_attempts,0);assert.ok(c.ledger.includes("rollback.ack"));});

function readded(){const s=expectedSuccess(fixture());Object.assign(s.memberships[P],{active:true,revision:9,epoch:9});s.groups[G].revision=6;s.student.people[P].profile.active_group_id=G;for(const g of Object.values(s.student.grants[P]))g.membershipEpoch=9;s.student.grants[P][J]={rostered:true,membershipEpoch:9,grantEpoch:9};s.student.grants[P][U]={rostered:true,membershipEpoch:9,grantEpoch:9};ready(s,true);return s;}
for(const mode of ["historical-inactive","readded-ready","later-elapsed-recovery"])scenario("HTTP-matching-replay-"+mode,async c=>{const s=mode==="historical-inactive"?expectedSuccess(fixture()):readded();if(mode==="later-elapsed-recovery"){const a=record(P,B);Object.assign(a,{generation:2,status:"in_progress",completedAt:null,stateRevision:2,seriesStateRevision:2,ordinary:null,deadlineAt:T-1});s.student.attempts[B]=a;Object.assign(s.student.series[K],{currentAttemptId:B,generation:2,recoveryState:"active"});}
 const l=local(c,s);ok(await call(c,l));expected(c,s);assert.equal(c.domain,1);assert.equal(c.guard,0);assert.equal(c.effect,0);assert.equal(c.writes.length,0);assert.equal(c.commit_acks,1);
});
for(const [name,change,code,status]of [
 ["capability",s=>s.staff[S].capabilities.manage_roster=false,"CAPABILITY_REQUIRED",403],
 ["grant",s=>s.staff[S].scope.group_ids=[],"NOT_FOUND",404],["approval",s=>s.staff[S].approved=false,"STAFF_NOT_APPROVED",403],
 ["disabled",s=>s.staff[S].enabled=false,"ACCOUNT_DISABLED",403],["hidden-target",s=>delete s.student.people[P],"NOT_FOUND",404]
])scenario("HTTP-replay-current-rights-"+name,async c=>{const s=expectedSuccess(fixture());change(s);const l=local(c,s);bad(await call(c,l),code,status);expected(c,s);assert.equal(c.guard,0);assert.equal(c.writes.length,0);assert.equal(c.ledger.includes("receipt.lookup"),false);});
scenario("HTTP-replay-expired-proof",async c=>{const s=expectedSuccess(fixture()),l=local(c,s,{now:T+100000});bad(await call(c,l),"STAFF_TOKEN_INVALID",401);expected(c,s);assert.equal(c.ledger.includes("receipt.lookup"),false);});
scenario("HTTP-replay-field-order-canonical",async c=>{const s=readded(),l=local(c,s);ok(await call(c,l,{raw:JSON.stringify({expected_membership_revision:7,expected_revision:4,status:"removed",student_id:P})}));expected(c,s);assert.equal(c.guard,0);});
for(const [name,b]of [
 ["revision",{...body(),expected_revision:3}],["member-revision",{...body(),expected_membership_revision:6}],["status",{...body(),status:"active"}]
])scenario("HTTP-mismatched-replay-"+name,async c=>{const s=readded(),l=local(c,s);bad(await call(c,l,{body:b}),"IDEMPOTENCY_CONFLICT",409);expected(c,s);assert.equal(c.guard,0);assert.equal(c.writes.length,0);});
for(const [name,roles,groups,all,allowed]of [
 ["Owner",["owner"],[],false,true],["Admin-both",["admin"],[G,H],false,true],["Admin-all",["admin"],[],true,true],
 ["Teacher-both",["teacher"],[G,H],false,true],["Teacher-no-H",["teacher"],[G],true,false],["Teacher-no-G",["teacher"],[H],true,false],["Admin-no-H",["admin"],[G],false,false]
])scenario("HTTP-replay-current-affinity-"+name,async c=>{const s=readded();s.memberships[P].affinityGroupId=H;s.student.people[P].profile.active_group_id=H;Object.assign(s.staff[S],{roles});Object.assign(s.staff[S].scope,{group_ids:groups,all_groups:all});const l=local(c,s);const r=await call(c,l);if(allowed)ok(r);else bad(r,"NOT_FOUND",404);expected(c,s);assert.equal(c.guard,0);assert.equal(c.writes.length,0);});
scenario("HTTP-real-recording-store-detached-body-and-replay",async c=>{const s=fixture(),l=local(c,s),r=await call(c,l);ok(r);const saved=clone(l.state.value),before={writes:c.writes.length,guard:c.guard,effect:c.effect};r.json.data.group_revision=999;r.json.data.status="active";assert.deepEqual(l.state.value,saved);const replay=await call(c,l);ok(replay);assert.deepEqual(l.state.value,saved);assert.equal(c.writes.length,before.writes);assert.equal(c.guard,before.guard);assert.equal(c.effect,before.effect);c.replay_delta={writes:c.writes.length-before.writes,guard:c.guard-before.guard,effect:c.effect-before.effect};});
scenario("HTTP-two-errors-fresh-request-id",async c=>{const l=local(c),a=await call(c,l,{noAuth:true}),b=await call(c,l,{noAuth:true});bad(a,"STAFF_TOKEN_INVALID",401);bad(b,"STAFF_TOKEN_INVALID",401);assert.notEqual(a.json.error.request_id,b.json.error.request_id);assert.equal(c.transactions,0);});

for(const [name,path]of [
 ["notification","/notifications/started/status"],["barrier","/student/assignments/"+U+"/reviewGate/barrier_revision"],
 ["receipt","/receipts/"+receiptKey(S)],["audit","/audit/1"]
])scenario("HTTP-technical-rollback-"+name,async c=>{const s=fixture(),l=local(c,s,{faultPath:path});bad(await call(c,l),"INTERNAL_ERROR",500);expected(c,s);assert.notDeepEqual(c.staged,s);assert.ok(c.writes.length>0);assert.equal(c.commit_acks,0);assert.ok(c.ledger.includes("rollback.ack"));});
scenario("HTTP-technical-arbitrary409-is-not-clean-denial",async c=>{const s=fixture(),l=local(c,s,{faultPath:"/notifications/started/status",injected:new ApiFault("STATE_REVISION_CONFLICT",409)});bad(await call(c,l),"STATE_REVISION_CONFLICT",409);expected(c,s);assert.notDeepEqual(c.staged,s);assert.equal(c.commit_attempts,0);});
scenario("HTTP-response-schema-failure-before-commit",async c=>{const s=fixture(),l=local(c,s,{responseInvalid:true});bad(await call(c,l),"RESPONSE_INVARIANT_FAILED",500);expected(c,s);assert.notDeepEqual(c.staged,s);assert.equal(c.commit_attempts,0);});
scenario("HTTP-known-precommit-failure",async c=>{const s=fixture(),l=local(c,s,{preCommitFault:true});bad(await call(c,l),"SERVICE_UNAVAILABLE",503);expected(c,s);assert.equal(c.transaction_error.outcome,"not_committed");assert.equal(c.commit_acks,0);assert.ok(c.ledger.includes("rollback.ack"));});
scenario("HTTP-loader-failure",async c=>{const s=fixture(),l=local(c,s,{loadFault:true});bad(await call(c,l),"SERVICE_UNAVAILABLE",503);same(c,s);assert.equal(c.domain,0);assert.equal(c.writes.length,0);});
scenario("HTTP-rollback-ACK-loss-no-confirmed-rollback",async c=>{const l=local(c,fixture(),{faultPath:"/notifications/started/status",rollbackAckLost:true});bad(await call(c,l),"INTERNAL_ERROR",500);assert.ok(c.ledger.includes("rollback.ack.lost"));assert.ok(c.ledger.includes("connection.discard"));assert.equal(c.ledger.includes("rollback.ack"),false);assert.equal(c.transaction_error.outcome,undefined);c.model_only_committed_snapshot=c.committed;delete c.committed;c.committed_state_guarantee="NONE: rollback ACK is unobservable to handler";c.rollback_claim="ACK_UNKNOWN; original error retained, not commit_unknown";});
for(const mode of ["committed","uncommitted"])scenario("HTTP-COMMIT-ACK-loss-"+mode,async c=>{const s=fixture(),l=local(c,s,{commit:mode});bad(await call(c,l),"SERVICE_UNAVAILABLE",503);expected(c,mode==="committed"?expectedSuccess(s):s);assert.equal(c.transaction_error.outcome,"commit_unknown");assert.equal(c.commit_acks,0);assert.equal(c.transactions,1);assert.equal(c.verify,1);assert.equal(c.commit_attempts,1);assert.equal(c.retries,0);assert.equal(c.ledger.includes("rollback.attempt"),false);assert.ok(c.ledger.includes("connection.discard"));});
for(const denial of [false,true])scenario("HTTP-no-response-before-transaction-resolution:"+denial,async c=>{const s=fixture(),gate=deferred(),entered=deferred(),l=local(c,s,{commitGate:gate,entered});let settled=false;
 const pending=call(c,l,denial?{body:{...body(),expected_revision:3}}:{}).then(r=>{settled=true;return r;});
 await entered.promise;await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.equal(c.commit_acks,0);assert.equal(c.ledger.includes("response.resolved"),false);assert.deepEqual(l.state.value,s);
 gate.resolve();const r=await pending;if(denial)bad(r,"RESOURCE_REVISION_CONFLICT",409);else ok(r);assert.equal(c.commit_acks,1);assert.ok(c.ledger.indexOf("commit.ack")<c.ledger.indexOf("response.resolved"));
 expected(c,denial?s:expectedSuccess(s));
});
scenario("HTTP-observer-negative-calibration",async c=>{const state={window:{at:1}},p=watch(state,c);const copied=structuredClone(p.window);assert.deepEqual(copied,{at:1});copied.at=2;assert.equal(state.window.at,1);assert.throws(()=>structuredClone(new Proxy({},{ })),e=>e.name==="DataCloneError");assert.throws(()=>structuredClone(()=>{}),e=>e.name==="DataCloneError");assert.equal(c.writes.length,0);});
for(const mode of ["ready","replay"])scenario("HTTP-native-plain-"+mode,async c=>{const s=mode==="replay"?expectedSuccess(fixture()):fixture();if(mode==="ready")ready(s,true);const l=local(c,s,{nativePlain:true});globalThis.structuredClone=clone;try{ok(await call(c,l));expected(c,mode==="replay"?s:expectedSuccess(s,{readyRight:true}));c.write_observation="NOT_INSTRUMENTED_NATIVE_PLAIN_CONTROL";}finally{globalThis.structuredClone=cloneObserved;}});


for(const code of ["RESOURCE_REVISION_CONFLICT","STATE_REVISION_CONFLICT","MEMBERSHIP_STATE_CONFLICT","ACTIVE_EXAM_OR_RECOVERY"])scenario("HTTP-thrown-business-code-is-technical:"+code,async c=>{const s=fixture(),l=local(c,s,{faultPath:"/notifications/started/status",injected:new ApiFault(code,409)});bad(await call(c,l),code,409);expected(c,s);assert.notDeepEqual(c.staged,s);assert.equal(c.commit_acks,0);assert.equal(c.commit_attempts,0);assert.equal(c.ledger.some(x=>x.startsWith("work.return:")),false);assert.equal(c.transaction_error.code,code);assert.ok(c.ledger.includes("rollback.ack"));});

for(const mode of ["Ea","rollback"])scenario("HTTP-native-plain-"+mode,async c=>{const s=fixture();if(mode==="Ea")active(s);const l=local(c,s,{nativePlain:true,preCommitFault:mode==="rollback"});globalThis.structuredClone=clone;try{const r=await call(c,l,mode==="Ea"?{body:{...body(),expected_revision:3}}:{});bad(r,mode==="Ea"?"RESOURCE_REVISION_CONFLICT":"SERVICE_UNAVAILABLE",mode==="Ea"?409:503);expected(c,mode==="Ea"?expectedExpiry(s):s);c.write_observation="NOT_INSTRUMENTED_NATIVE_PLAIN_CONTROL";}finally{globalThis.structuredClone=cloneObserved;}});
for(const future of [false,true])scenario("HTTP-wait-preserves-other-ready:"+future,async c=>{const s=fixture();ready(s,future);const d=id(21),sk=P+"/"+d,a=record(P,B,U,d);Object.assign(a,{status:"in_progress",completedAt:null,ordinary:null,deadlineAt:T+1});s.student.attempts[B]=a;s.student.series[sk]={currentAttemptId:B,generation:1,normalAttemptUsed:true,officialAttemptId:null,recoveryState:"none",recovery:null};const l=local(c,s);bad(await call(c,l),"ACTIVE_EXAM_OR_RECOVERY",409);expected(c,s);assert.equal(c.writes.length,0);assert.equal(c.effect,0);});
scenario("HTTP-parser-retains-existing-duplicate-key-behavior",async c=>{const s=fixture(),l=local(c,s);ok(await call(c,l,{raw:'{"student_id":"'+P+'","status":"active","status":"removed","expected_revision":4,"expected_membership_revision":7}'}));expected(c,expectedSuccess(s));});
scenario("HTTP-UUID-normalization-real-hex-letters",async c=>{const p="abcdefab-cdef-4abc-8def-abcdefabcdef",g="bcdefabc-defa-4bcd-8efa-bcdefabcdefa";
 function remap(v){if(typeof v==="string")return v.replaceAll(P,p).replaceAll(G,g);if(Array.isArray(v))return v.map(remap);if(v&&typeof v==="object")return Object.fromEntries(Object.entries(v).map(([k,x])=>[k.replaceAll(P,p).replaceAll(G,g),remap(x)]));return v;}
 const s=remap(fixture()),l=local(c,s);ok(await call(c,l,{path:"/api/v1/admin/groups/"+g.toUpperCase()+"/members",body:{...body(),student_id:p.toUpperCase()}}),{...result(),student_id:p,group_id:g});expected(c,remap(expectedSuccess(fixture())));
});
scenario("HTTP-Ea-clean409-waits-for-ACK",async c=>{const s=fixture();active(s);const gate=deferred(),entered=deferred(),l=local(c,s,{commitGate:gate,entered});let settled=false;
 const pending=call(c,l,{body:{...body(),expected_revision:3}}).then(r=>{settled=true;return r;});await entered.promise;await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.deepEqual(l.state.value,s);assert.deepEqual(c.staged,expectedExpiry(s));assert.equal(c.commit_acks,0);
 gate.resolve();bad(await pending,"RESOURCE_REVISION_CONFLICT",409);expected(c,expectedExpiry(s));assert.equal(c.commit_acks,1);assert.ok(c.ledger.indexOf("commit.ack")<c.ledger.indexOf("response.resolved"));
});
scenario("HTTP-started-recovery-waits",async c=>{const s=fixture(),a=record(P,B);Object.assign(a,{generation:2,status:"in_progress",completedAt:null,stateRevision:2,seriesStateRevision:2,ordinary:null,deadlineAt:T+1});s.student.attempts[B]=a;Object.assign(s.student.series[K],{generation:2,currentAttemptId:B,recoveryState:"active",recovery:{opensAt:T-100,closesAt:T+1000,durationMs:1000}});const l=local(c,s);bad(await call(c,l),"ACTIVE_EXAM_OR_RECOVERY",409);expected(c,s);assert.equal(c.writes.length,0);});

for(const replay of [false,true])for(const mode of ["ApiFault","unknown"])scenario("HTTP-validator-exception:"+mode+":replay="+replay,async c=>{
 const s=replay?expectedSuccess(fixture()):fixture(),fault=mode==="ApiFault"?new ApiFault("STATE_REVISION_CONFLICT",409):new Error("SYNTHETIC_VALIDATOR_EXCEPTION");
 const l=local(c,s,{responseError:fault});bad(await call(c,l),mode==="ApiFault"?"STATE_REVISION_CONFLICT":"INTERNAL_ERROR",mode==="ApiFault"?409:500);
 expected(c,s);assert.equal(c.commit_attempts,0);assert.equal(c.commit_acks,0);assert.equal(c.ledger.some(x=>x.startsWith("work.return:")),false);assert.ok(c.ledger.includes("rollback.ack"));
 assert.equal(c.transaction_error.message,fault.message);if(mode==="ApiFault"){assert.equal(c.transaction_error.code,fault.code);assert.equal(c.transaction_error.status,fault.status);}
 if(replay){assert.equal(c.guard,0);assert.equal(c.writes.length,0);}else assert.ok(c.writes.length>0);
});
scenario("HTTP-validator-false-replay-precommit",async c=>{const s=expectedSuccess(fixture()),l=local(c,s,{responseInvalid:true});bad(await call(c,l),"RESPONSE_INVARIANT_FAILED",500);expected(c,s);assert.equal(c.commit_attempts,0);assert.equal(c.guard,0);assert.equal(c.writes.length,0);assert.ok(c.ledger.includes("rollback.ack"));});
for(const [name,fault]of [["invariant",new ApiFault("RESPONSE_INVARIANT_FAILED",500)],["arbitrary409",new ApiFault("RESOURCE_REVISION_CONFLICT",409)]])scenario("HTTP-rollback-ACK-loss-original-"+name,async c=>{
 const l=local(c,fixture(),{faultPath:"/notifications/started/status",rollbackAckLost:true,injected:fault});bad(await call(c,l),fault.code,fault.status);
 assert.equal(c.transaction_error.code,fault.code);assert.equal(c.transaction_error.status,fault.status);assert.equal(c.transaction_error.outcome,undefined);assert.equal(c.commit_attempts,0);assert.equal(c.commit_acks,0);
 assert.ok(c.ledger.includes("rollback.ack.lost"));assert.ok(c.ledger.includes("connection.discard"));assert.equal(c.ledger.includes("rollback.ack"),false);
 c.model_only_committed_snapshot=c.committed;delete c.committed;c.committed_state_guarantee="NONE: only the original error is observable";c.rollback_claim="ACK_UNKNOWN; no confirmed rollback, no commit_unknown reclassification";
});
scenario("HTTP-unexpected-verifier-exception-is-internal500",async c=>{const s=fixture(),l=local(c,s,{verifyUnexpected:true});bad(await call(c,l),"INTERNAL_ERROR",500);same(c,s);assert.equal(c.verify,1);assert.equal(c.transactions,0);});
scenario("HTTP-postcommit-response-failure-keeps-committed-command",async c=>{
 const s=fixture(),l=local(c,s),NativeResponse=globalThis.Response;
 globalThis.Response=class extends NativeResponse{constructor(value,init){if(init?.status===200){assert.equal(c.commit_acks,1);c.ledger.push("delivery.failure.after-ack");throw new Error("SYNTHETIC_RESPONSE_DELIVERY_FAILURE");}super(value,init);}};
 try{bad(await call(c,l),"INTERNAL_ERROR",500);expected(c,expectedSuccess(s));assert.equal(c.transactions,1);assert.equal(c.commit_attempts,1);assert.equal(c.commit_acks,1);assert.equal(c.ledger.includes("rollback.attempt"),false);assert.ok(c.ledger.indexOf("commit.ack")<c.ledger.indexOf("delivery.failure.after-ack"));}
 finally{globalThis.Response=NativeResponse;}
});
after(async()=>{for(const id of breakpoints)await session.post("Debugger.removeBreakpoint",{breakpointId:id});session.disconnect();globalThis.structuredClone=clone;
 if(process.env.UA_REMOVAL_HTTP_TRACE_PATH)writeFileSync(process.env.UA_REMOVAL_HTTP_TRACE_PATH,JSON.stringify({candidate:"REMOVAL-HTTP-LOCAL-01-r2",base:"f5c1446fd6820119e9d070cd58643af127fe277b",source_fingerprints:fingerprints,accepted_source_pins:pins,limits:"Offline signed JWTs and trusted StaffTransactions recording double only. Direct domain/guard/effect entry debugger counters; Proxy observes reachable set/define/delete attempts. Committed state is not SQL durability or proof of exhaustive projection/protection. Native/plain controls do not instrument writes. No automatic mutation retry.",cases},(_,v)=>typeof v==="bigint"?{$bigint:String(v)}:v,2)+"\n");
});

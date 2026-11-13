import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ApiFault} from '../../supabase/functions/univeracademy-api/fault.ts';
import {createMembershipProtectionContract,LocalProtectionLedger,MembershipProtectionContract,PROTECTION_COLLECTIONS}
  from '../../supabase/functions/univeracademy-api/storage/membership-protection-contract.ts';

const base='e8c742ca518f084ada78f9a905ed65907c60f9b8';
const sourcePath=new URL('../../supabase/functions/univeracademy-api/storage/membership-protection-contract.ts',import.meta.url);
const sourceSha=createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
const testSha=createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const results=[], clone=structuredClone;let activeAssertions=[];let probeDetail={};
const scope={actorId:'actor',studentId:'target',groupId:'G',affinityGroupId:'H'};
const bindings=()=>({currentSeries:[{seriesKey:'target/D',demoId:'D',assignmentId:'J',attemptId:'A',generation:1}],
  grants:[{assignmentId:'J',demoId:'D'}],historicalAttempts:[{attemptId:'A',assignmentId:'J',demoId:'D'}],recoveryAnchors:[]});
const input=(tx='R')=>({mode:'local_contract',transactionId:tx,protectionId:tx+'-protection',scope:clone(scope),
  identityAnchors:['actor'],personIds:['target'],groupIds:['H','G'],versionIds:['V'],bindings:bindings()});
const staff=()=>({personId:'actor',enabled:true,approved:true,roles:['teacher'],approvedSubjectIds:[],
  capabilities:{manage_roster:true,manage_content:false},scope:{all_groups:false,group_ids:['G','H'],all_subjects:false,subject_ids:[]}});
const model=async(ledger=new LocalProtectionLedger(),v=input())=>({ledger,m:await createMembershipProtectionContract(v,ledger)});
function upper(m){for(const resource of [...m.plan]) assert.equal(m.acquire(resource),true);}
function lower(m){for(const resource of m.plan.filter(r=>['assignment','gate','series','attempt'].includes(r.kind)))assert.equal(m.acquire(resource),true);}
async function reread(m,ledger,b=m.input.bindings,read=ledger.statement(m.input.transactionId)){
  await m.rereadTargetBindings(read,b);
}
function projection(m,ledger,peer=null){
  const p={transactionId:m.input.transactionId,protectionId:m.input.protectionId,read:ledger.statement(m.input.transactionId),
    enumerations:{targetSeries:{enumerationId:'target-series',keys:['target/D']},protectedAssignments:{enumerationId:'assignments',keys:['J']},
      participants:{enumerationId:'participants',keys:[['J','target']]},recoveryAnchors:{enumerationId:'recovery',keys:[]}},
    rows:Object.fromEntries(PROTECTION_COLLECTIONS.map(c=>[c,{present:[],absent:[]}])) ,loaded:{},
    assignments:[{assignmentId:'J',demoId:'D'}],participants:[{assignmentId:'J',personId:'target',seriesKey:'target/D',currentAttemptId:'A',recoveryAssignmentId:null}]};
  const loaded={staff:['subject'],groups:['G','H'],people:['target'],memberships:['target'],grants:['target/J'],assignments:['J'],series:['target/D'],attempts:['A'],recoveryAssignments:[]};
  if(peer){
    p.enumerations.participants.keys.push(['J','peer']);
    p.participants.push({assignmentId:'J',personId:'peer',seriesKey:'peer/D',currentAttemptId:'B',recoveryAssignmentId:peer==='off-group-future-ready'?'J':null});
    for(const [c,k] of [['people','peer'],['memberships','peer'],['grants','peer/J'],['series','peer/D'],['attempts','B']])loaded[c].push(k);
    if(peer==='off-group-future-ready') {loaded.recoveryAssignments.push('peer/D');p.enumerations.recoveryAnchors.keys.push(['peer/D','J']);}
  }else{
    for(const [c,k] of [['people','peer'],['memberships','peer'],['grants','peer/J'],['series','peer/D'],['attempts','B']])p.rows[c].absent.push(k);
  }
  p.loaded=loaded;for(const c of PROTECTION_COLLECTIONS)p.rows[c].present=[...loaded[c]];
  return p;
}
function frame(m,ledger,change=()=>{}){
  const v={frameId:m.input.transactionId+'/frame',waitEpoch:m.waitEpoch,now:100,providerExpiresAt:200,
    scope:clone(scope),proof:{kind:'staff_verified',subject:'subject',notBefore:0,expiresAt:200},staff:{subject:staff()},affectedAssignmentIds:['J']};
  change(v);return ledger.refreshFrame(m.input.transactionId,v);
}
async function prepared(changeP=()=>{},peer=null){
  const {m,ledger}=await model();upper(m);await reread(m,ledger);const p=projection(m,ledger,peer);changeP(p);m.loadProjection(p);lower(m);return {m,ledger,p};
}
async function sealed(){const x=await prepared();x.r=x.m.seal(frame(x.m,x.ledger));return x;}
function fault(action,code='RESPONSE_INVARIANT_FAILED',status=500){assert.throws(action,e=>{activeAssertions.push({expected:{code,status},actual:{code:e.code,status:e.status}});return e.code===code&&e.status===status;});}
async function rejects(action,code='RESPONSE_INVARIANT_FAILED',status=500){await assert.rejects(action,e=>{activeAssertions.push({expected:{code,status},actual:{code:e.code,status:e.status}});return e.code===code&&e.status===status;});}
function observations(m,ledger){return {phase:m.phase,synthetic_lease_held:m.leaseHeld,lockedPersonIds:m.input.personIds,
  ledger:ledger.events,modeled_guard:ledger.events.filter(e=>e.event==='modeled.guard').length,
  modeled_flush:ledger.events.filter(e=>e.event==='modeled.flush').length};}
function checked(id,gate,run){test(id,async()=>{
  const started=new Date().toISOString();let detail={},error;activeAssertions=[];probeDetail={};
  try{detail=await run()||{};}catch(e){error=e;}
  results.push({id,gate,base,source_sha256:sourceSha,test_sha256:testSha,started_utc:started,finished_utc:new Date().toISOString(),
    verdict:error?'FAIL':'PASS',fault_assertions:clone(activeAssertions),layer:'SQL-free synthetic protocol model',...probeDetail,...detail,...(error?{assertion:{name:error.name,message:error.message,stack:error.stack}}:{})});
  if(error)throw error;
});}

checked('P01-positive-complete-lifetime','seal/lease',async()=>{
  const {m,ledger,p}=await prepared();const r=m.seal(frame(m,ledger));assert.deepEqual(r.lockedPersonIds,['target']);assert.deepEqual(r.demoFenceIds,['D']);
  assert.deepEqual(r.resourcePlan,[{kind:'identity',key:'actor'},{kind:'person',key:'target'},{kind:'group',key:'G'},{kind:'group',key:'H'},
    {kind:'version',key:'V'},{kind:'demo',key:'D'},{kind:'assignment',key:'J'},{kind:'gate',key:'J'},{kind:'series',key:'target/D'},{kind:'attempt',key:'A'}]);
  assert.deepEqual(ledger.events.filter(e=>e.event==='lock.acquired').map(e=>e.resource),r.resourcePlan);
  assert.equal(Object.isFrozen(r.rows.attempts.present),true);assert.notEqual(r.rows,p.rows);m.enterGuard(r);m.beginFlush(r);m.callbackReturned(r);
  assert.equal(m.leaseHeld,true);assert.equal(m.phase,'callback_returned');m.beginCommit();assert.equal(m.leaseHeld,true);m.commitAcknowledged();m.release();
  assert.equal(m.leaseHeld,false);assert.equal(m.phase,'released');
  return {receipt:r,...observations(m,ledger),expected:{modeled_guard:1,modeled_flush:1,release_after_ack:true}};
});
for(const mode of [undefined,'production','default'])checked('P02-mode-'+String(mode),'binding',async()=>{
  await rejects(()=>createMembershipProtectionContract({...input(),mode},new LocalProtectionLedger()),'SERVICE_UNAVAILABLE',503);
});
checked('P03-missing-ledger','binding',async()=>{await rejects(()=>createMembershipProtectionContract(input()),'SERVICE_UNAVAILABLE',503);});
checked('P04-public-constructor-cannot-forge','binding',async()=>{fault(()=>new MembershipProtectionContract(Symbol('fake'),input(),'fake',new LocalProtectionLedger()));});
checked('P05-canonical-binding-digest','hint',async()=>{
  const a=await model();const other=input('T');other.bindings={recoveryAnchors:[],historicalAttempts:[{demoId:'D',assignmentId:'J',attemptId:'A'}],
    grants:[{demoId:'D',assignmentId:'J'}],currentSeries:[{generation:1,attemptId:'A',assignmentId:'J',demoId:'D',seriesKey:'target/D'}]};
  const b=await model(new LocalProtectionLedger(),other);assert.equal(a.m.targetBindingDigest,b.m.targetBindingDigest);
  upper(a.m);await reread(a.m,a.ledger,other.bindings);return {digest:a.m.targetBindingDigest,...observations(a.m,a.ledger)};
});
checked('P06-all-target-binding-sources-fenced','scope',async()=>{
  const v=input();v.bindings.currentSeries.push({seriesKey:'target/Z',demoId:'Z',assignmentId:'JZ',attemptId:'AZ',generation:4});
  v.bindings.grants.push({demoId:'FUTURE',assignmentId:'JF'});v.bindings.historicalAttempts.push({demoId:'HISTORY',assignmentId:'JH',attemptId:'AH'});
  v.bindings.recoveryAnchors.push({seriesKey:'target/RECOVERY',demoId:'RECOVERY',assignmentId:'JR',generation:2});
  const {m}=await model(new LocalProtectionLedger(),v);assert.deepEqual(m.plan.filter(r=>r.kind==='demo').map(r=>r.key),['D','FUTURE','HISTORY','RECOVERY','Z']);
  assert.deepEqual(m.plan.slice(0,5),[{kind:'identity',key:'actor'},{kind:'person',key:'target'},{kind:'group',key:'G'},{kind:'group',key:'H'},{kind:'version',key:'V'}]);
  return {plan:m.plan,expected_demo_fences:['D','FUTURE','HISTORY','RECOVERY','Z']};
});
for(const field of ['currentSeries','grants','historicalAttempts','recoveryAnchors'])checked('P07-missing-binding-enum-'+field,'hint',async()=>{
  const v=input();delete v.bindings[field];await rejects(()=>model(new LocalProtectionLedger(),v));
});
for(const variant of ['new-demo','assignment','generation','current-attempt','removed-binding'])checked('P08-binding-change-'+variant,'hint',async()=>{
  const {m,ledger}=await model();upper(m);const b=clone(m.input.bindings);
  if(variant==='new-demo')b.grants.push({demoId:'NEW',assignmentId:'JN'});
  if(variant==='assignment')b.grants[0].assignmentId='OTHER';
  if(variant==='generation')b.currentSeries[0].generation++;
  if(variant==='current-attempt')b.currentSeries[0].attemptId='B';
  if(variant==='removed-binding')b.grants=[];
  await rejects(()=>reread(m,ledger,b));assert.equal(ledger.events.some(e=>e.event==='modeled.guard'||e.event==='modeled.flush'),false);
  return {...observations(m,ledger),expected:{modeled_guard:0,modeled_flush:0,automatic_retry:0,late_expansion:0}};
});
for(const variant of ['skip-identity','person-after-fence','group-after-fence','attempt-before-series','fence-after-attempt','reverse-person','reverse-demo'])checked('P09-rank-'+variant,'lock-order',async()=>{
  const v=input();if(variant==='reverse-person')v.personIds.push('aaa');if(variant==='reverse-demo')v.bindings.grants.push({demoId:'AAA',assignmentId:'JA'});
  const {m,ledger}=await model(new LocalProtectionLedger(),v);
  if(variant==='skip-identity')fault(()=>m.acquire({kind:'person',key:'target'}));
  else if(variant==='reverse-person'){assert.equal(m.acquire(m.plan[0]),true);fault(()=>m.acquire({kind:'person',key:'target'}));}
  else if(variant==='reverse-demo'){for(const r of m.plan.filter(r=>r.kind!=='demo'))m.acquire(r);fault(()=>m.acquire({kind:'demo',key:'D'}));}
  else{
    upper(m);await reread(m,ledger);m.loadProjection(projection(m,ledger));
    if(variant==='attempt-before-series')fault(()=>m.acquire({kind:'attempt',key:'A'}));
    else if(variant==='fence-after-attempt'){lower(m);fault(()=>m.acquire({kind:'demo',key:'D'}));}
    else fault(()=>m.acquire({kind:variant==='person-after-fence'?'person':'group',key:'peer'}));
  }
  return {...observations(m,ledger),expected:{modeled_guard:0,modeled_flush:0}};
});
checked('P10-foreign-fence-owner','ownership',async()=>{
  const ledger=new LocalProtectionLedger();ledger.register('W','WP');ledger.acquire('W',{kind:'demo',key:'D'});const {m}=await model(ledger);
  for(const r of m.plan.filter(r=>r.kind!=='demo'))m.acquire(r);assert.equal(m.acquire({kind:'demo',key:'D'}),false);
  await rejects(()=>reread(m,ledger));assert.equal(m.leaseHeld,true);return observations(m,ledger);
});
for(const variant of ['query-start-before-fence','copied-read','foreign-transaction-read','transaction-snapshot','relabel-old-snapshot'])checked('P11-statement-'+variant,'snapshot',async()=>{
  const {m,ledger}=await model();let read;
  if(variant==='query-start-before-fence')read=ledger.statement('R');
  if(variant==='foreign-transaction-read'){ledger.register('W','WP');read=ledger.statement('W');}
  upper(m);
  if(variant==='copied-read')read=clone(ledger.statement('R'));
  if(variant==='transaction-snapshot')read=ledger.statement('R','transaction_snapshot');
  if(variant==='relabel-old-snapshot')read={...ledger.statement('R','transaction_snapshot'),kind:'statement_fresh',startedOrdinal:999999};
  await rejects(()=>reread(m,ledger,m.input.bindings,read));return {...observations(m,ledger),expected:{modeled_guard:0,modeled_flush:0}};
});
checked('P12-stale-post-wait-snapshot','snapshot',async()=>{
  const {m,ledger}=await model();upper(m);const read=ledger.statement('R');ledger.register('W','WP');ledger.acquire('W',{kind:'demo',key:'UNRELATED'});
  ledger.writerCommitted('W',['UNRELATED'],['UNRELATED'],ledger.statement('W'));ledger.end('W','commit.ack');m.noteWait(ledger.version);
  await rejects(()=>reread(m,ledger,m.input.bindings,read));return observations(m,ledger);
});
const badProjections={
  'missing-enumeration':p=>delete p.enumerations.participants,
  'complete-true-only':p=>p.enumerations={complete:true},
  'duplicate-key':p=>p.enumerations.targetSeries.keys.push('target/D'),
  'duplicate-enum-id':p=>p.enumerations.participants.enumerationId=p.enumerations.targetSeries.enumerationId,
  'extra-present':p=>p.rows.attempts.present.push('MISSING'),
  'missing-present':p=>p.rows.attempts.present=[],
  'present-absent-overlap':p=>p.rows.attempts.absent.push('A'),
  'unknown-collection':p=>p.rows.unknown={present:[],absent:[]},
  'missing-collection':p=>delete p.rows.recoveryAssignments,
  'missing-loaded-collection':p=>delete p.loaded.grants,
  'wrong-assignment-pair':p=>p.enumerations.participants.keys=[['OTHER','target']],
  'wrong-person-pair':p=>p.enumerations.participants.keys=[['J','FOREIGN']],
  'wrong-demo-closure':p=>p.assignments[0].demoId='UNPROTECTED',
  'missing-target-series':p=>p.enumerations.targetSeries.keys=[],
  'unloaded-assignment':p=>{p.loaded.assignments=[];p.rows.assignments.present=[];},
  'missing-participant-grant-fact':p=>{p.loaded.grants=[];p.rows.grants.present=[];},
  'missing-recovery-row':p=>{p.participants[0].recoveryAssignmentId='J';p.enumerations.recoveryAnchors.keys=[['target/D','J']];},
  'unknown-protection':p=>p.protectionId='WRONG',
  'unknown-transaction':p=>p.transactionId='WRONG',
  'forged-query':p=>p.read={...p.read},
};
for(const [name,mutate]of Object.entries(badProjections))checked('P13-projection-'+name,'enumeration',async()=>{
  const {m,ledger}=await model();upper(m);await reread(m,ledger);const p=projection(m,ledger);mutate(p);fault(()=>m.loadProjection(p));
  return {...observations(m,ledger),expected:{modeled_guard:0,modeled_flush:0}};
});
checked('P14-proven-empty-enumeration','enumeration',async()=>{
  const v=input();for(const k of Object.keys(v.bindings))v.bindings[k]=[];const {m,ledger}=await model(new LocalProtectionLedger(),v);upper(m);await reread(m,ledger);
  const p=projection(m,ledger);p.assignments=[];p.participants=[];for(const e of Object.values(p.enumerations))e.keys=[];
  for(const c of ['grants','assignments','series','attempts']){p.loaded[c]=[];p.rows[c].present=[];}
  m.loadProjection(p);lower(m);const r=m.seal(frame(m,ledger,f=>f.affectedAssignmentIds=[]));m.enterGuard(r);m.callbackReturned(r);m.beginCommit();m.commitAcknowledged();m.release();
  assert.deepEqual(r.protectedAssignmentIds,[]);return {receipt:r,...observations(m,ledger)};
});
for(const variant of ['new-frame-id-only','old-wait-epoch','outside-affected-assignment','foreign-transaction','foreign-protection','query-after-refresh','wait-after-refresh'])checked('P15-frame-'+variant,'freshness',async()=>{
  const {m,ledger}=await prepared();let f=frame(m,ledger,v=>{
    if(variant==='old-wait-epoch')v.waitEpoch--;
    if(variant==='outside-affected-assignment')v.affectedAssignmentIds=['UNPROTECTED'];
  });
  if(variant==='new-frame-id-only')f={...f,frameId:'new-label'};
  if(variant==='foreign-transaction')f={...f,transactionId:'WRONG'};
  if(variant==='foreign-protection')f={...f,protectionId:'WRONG'};
  if(variant==='query-after-refresh')ledger.statement('R');
  if(variant==='wait-after-refresh')m.noteWait(ledger.version);
  fault(()=>m.seal(f));return {...observations(m,ledger),expected:{modeled_guard:0,modeled_flush:0}};
});
for(const [name,change,code,status] of [
  ['disabled',v=>v.staff.subject.enabled=false,'ACCOUNT_DISABLED',403],
  ['unapproved',v=>v.staff.subject.approved=false,'STAFF_NOT_APPROVED',403],
  ['capability-revoked',v=>v.staff.subject.capabilities.manage_roster=false,'CAPABILITY_REQUIRED',403],
  ['G-revoked',v=>v.staff.subject.scope.group_ids=['H'],'NOT_FOUND',404],
  ['H-hidden',v=>v.staff.subject.scope.group_ids=['G'],'NOT_FOUND',404],
  ['teacher-all-groups',v=>{v.staff.subject.scope.group_ids=[];v.staff.subject.scope.all_groups=true;},'NOT_FOUND',404],
  ['proof-equality',v=>v.proof.expiresAt=100,'STAFF_TOKEN_INVALID',401],
  ['proof-after',v=>v.proof.expiresAt=99,'STAFF_TOKEN_INVALID',401],
  ['provider-equality',v=>v.providerExpiresAt=100,'STAFF_TOKEN_INVALID',401],
])checked('P16-post-wait-'+name,'authority/GH',async()=>{
  const {m,ledger}=await prepared();m.noteWait(ledger.version);fault(()=>m.seal(frame(m,ledger,change)),code,status);
  assert.equal(ledger.events.filter(e=>e.event==='modeled.guard'||e.event==='modeled.flush').length,0);return observations(m,ledger);
});
for(const role of ['owner','admin'])checked('P17-current-'+role+'-GH','authority/GH',async()=>{
  const {m,ledger}=await prepared();const r=m.seal(frame(m,ledger,v=>{v.staff.subject.roles=[role];v.staff.subject.scope.group_ids=[];v.staff.subject.scope.all_groups=true;
    if(role==='owner')v.staff.subject.capabilities.manage_roster=false;}));m.enterGuard(r);return {receipt_scope:r.scope,...observations(m,ledger)};
});
for(const key of ['transactionId','protectionId','frameId'])checked('P18-receipt-binding-'+key,'binding',async()=>{
  const {m,ledger,r}=await sealed();fault(()=>m.revalidate(r,{...r,[key]:'FOREIGN'}));return observations(m,ledger);
});
for(const key of ['actorId','studentId','groupId','affinityGroupId'])checked('P19-receipt-scope-'+key,'binding',async()=>{
  const {m,ledger,r}=await sealed();fault(()=>m.enterGuard({...r,scope:{...r.scope,[key]:'FOREIGN'}}));return observations(m,ledger);
});
checked('P20-foreign-receipt-matching-public-ids','binding',async()=>{
  const a=await sealed(),b=await sealed();assert.deepEqual(a.r,b.r);fault(()=>a.m.enterGuard(b.r));return observations(a.m,a.ledger);
});
checked('P21-detached-caller-mutation','seal',async()=>{
  const {m,ledger,p}=await prepared(),f=frame(m,ledger),r=m.seal(f);p.loaded.attempts.push('FAKE');p.rows.attempts.present.push('FAKE');p.enumerations.participants.keys.push(['J','LATE']);
  assert.deepEqual(r.rows.attempts.present,['A']);assert.throws(()=>r.lockedPersonIds.push('peer'),TypeError);assert.throws(()=>r.scope.affinityGroupId='OTHER',TypeError);
  m.enterGuard(r);return {receipt:r,...observations(m,ledger)};
});
for(const stage of ['enumeration','seal','guard','flush','callback','commit-pending'])checked('P22-early-release-'+stage,'lease',async()=>{
  const {m,ledger}=await prepared();let r;if(stage!=='enumeration')r=m.seal(frame(m,ledger));
  if(['guard','flush','callback','commit-pending'].includes(stage))m.enterGuard(r);
  if(['flush','callback','commit-pending'].includes(stage))m.beginFlush(r);
  if(['callback','commit-pending'].includes(stage))m.callbackReturned(r);
  if(stage==='commit-pending')m.beginCommit();fault(()=>m.release());assert.equal(m.leaseHeld,true);return observations(m,ledger);
});
for(const variant of ['external-wait','unreported-query','ownership-released'])checked('P23-stale-sealed-'+variant,'seal',async()=>{
  const {m,ledger,r}=await sealed();
  if(variant==='external-wait')fault(()=>m.noteWait(ledger.version));
  if(variant==='unreported-query')ledger.statement('R');
  if(variant==='ownership-released')ledger.end('R','rollback.ack');
  fault(()=>m.enterGuard(r));return observations(m,ledger);
});
for(const now of [99,100,101])checked('P24-final-clock-new-affected-'+now,'scope',async()=>{
  const {m,ledger}=await prepared();const r=m.seal(frame(m,ledger,v=>{v.now=now;v.affectedAssignmentIds=now<100?[]:['J'];}));
  assert.deepEqual(r.protectedAssignmentIds,['J']);assert.deepEqual(r.affectedAssignmentIds,now<100?[]:['J']);m.enterGuard(r);
  return {receipt:r,oracle:'final affected set is literal subset; model does not calculate expiry',...observations(m,ledger)};
});
for(const outcome of ['commit-ack','known-rollback','committed-ack-loss','uncommitted-ack-loss','rollback-ack-loss'])checked('P25-outcome-'+outcome,'transaction',async()=>{
  const {m,ledger,r}=await sealed(),error=new ApiFault('IDEMPOTENCY_CONFLICT',409);let actual;
  const S0={ordinary:'preserve',membership:{active:true,epoch:7}},staged=clone(S0);staged.ordinary='modeled expiry';let committed=clone(S0);let confirmation='none';
  if(outcome.includes('rollback')){
    m.enterGuard(r);m.beginRollback(error);
    if(outcome==='known-rollback'){assert.equal(m.rollbackAcknowledged(),error);m.release();actual={rollbackAcknowledged:true};assert.deepEqual(committed,S0);confirmation='recording double known rollback only';}
    else {assert.equal(m.rollbackAcknowledgementLost(),error);assert.equal(m.phase,'rollback_unknown');m.discard();committed=null;actual={original_error:{code:error.code,status:error.status},rollbackConfirmed:false};confirmation='unconfirmed, no committed-S0 assertion';}
  }else{
    m.enterGuard(r);m.beginFlush(r);m.callbackReturned(r);m.beginCommit();
    if(outcome==='commit-ack'){m.commitAcknowledged();m.release();committed=clone(staged);actual={commitAcknowledged:true};confirmation='recording double commit only';}
    else {actual=m.commitAcknowledgementLost();assert.deepEqual(actual,{outcome:'commit_unknown',status:503,automaticMutationRetry:false});committed=outcome==='committed-ack-loss'?clone(staged):clone(S0);m.discard();confirmation='caller cannot distinguish either recording-double durability variant';}
  }
  return {durable_variant:outcome,S0,staged,committed,confirmation,caller:actual,...observations(m,ledger),physical_database_claim:'NOT_RUN'};
});
checked('P26-policy-B-preflight-rights-untouched','policy-B',async()=>{
  const rights={window:{opensAt:1000,closesAt:2000,durationMs:500},generation:4,anchor:'J',oldEpoch:7,history:[{result:'preserve'}]};const before=clone(rights);
  const {m,ledger,r}=await sealed();m.enterGuard(r);m.callbackReturned(r);m.beginCommit();m.commitAcknowledged();m.release();assert.deepEqual(rights,before);
  return {expected_rights:before,actual_rights:rights,reason:'protocol model has no removal/recovery writer',...observations(m,ledger)};
});

// Deterministic shared-ledger schedules. World writes and gate contributions are
// explicit recording-model operations, not transient observation of DB writers.
// Target is terminal; these literal contributions belong only to the peer.
const contribution=kind=>kind==='off-group-future-ready'?{unresolved:1,active:0,ready:1}:{unresolved:1,active:1,ready:0};
for(const kind of ['peer-start','off-group-future-ready','absent-insert'])for(const order of ['writer-first','removal-first'])checked('P27-'+kind+'-'+order,'schedule',async()=>{
  const ledger=new LocalProtectionLedger(),{m}=await model(ledger);ledger.register('W','writer-protection');ledger.acquire('W',{kind:'person',key:'peer'});
  const world={version:0,peer:null,peerGroup:'OFF-GROUP',gate:{unresolved:0,active:0,ready:0}},writes=[];
  const write=()=>{ledger.writerCommitted('W',['D'],['D'],ledger.statement('W'));world.peer=kind;world.version++;world.gate=contribution(kind);
    writes.push({op:'set',path:'/peer',value:kind},{op:'set',path:'/gate',value:clone(world.gate)});ledger.end('W','commit.ack');};
  let expectedPeer,readState;
  if(order==='writer-first'){
    assert.equal(ledger.acquire('W',{kind:'demo',key:'D'}),true);
    for(const r of m.plan.filter(r=>r.kind!=='demo'))m.acquire(r);
    assert.equal(m.acquire({kind:'demo',key:'D'}),false);write();assert.equal(m.acquire({kind:'demo',key:'D'}),true);m.noteWait(ledger.version);expectedPeer=kind;
  }else{
    upper(m);assert.equal(ledger.acquire('W',{kind:'demo',key:'D'}),false);assert.deepEqual(writes,[]);expectedPeer=null;
  }
  await reread(m,ledger);readState=clone(world);m.loadProjection(projection(m,ledger,world.peer));lower(m);const r=m.seal(frame(m,ledger));
  assert.equal(readState.peer,expectedPeer);assert.deepEqual(r.lockedPersonIds,['target']);assert.equal(r.lockedPersonIds.includes('peer'),false);
  if(expectedPeer)assert.equal(r.enumerations.participants.keys.some(v=>v[1]==='peer'),true);
  else assert.equal(r.rows.grants.absent.includes('peer/J'),true);
  m.enterGuard(r);m.beginFlush(r);m.callbackReturned(r);
  if(order==='removal-first'){assert.equal(ledger.acquire('W',{kind:'demo',key:'D'}),false);assert.equal(writes.length,0);}
  m.beginCommit();m.commitAcknowledged();m.release();
  if(order==='removal-first'){assert.equal(ledger.acquire('W',{kind:'demo',key:'D'}),true);write();}
  assert.deepEqual(world.gate,contribution(kind));assert.equal(writes.length,2);
  return {order,kind,expected_snapshot_peer:expectedPeer,read_state:readState,final_state:world,receipt:r,attempted_world_writes:writes,
    writer_gate_maintenance:'explicit model obligation, not production flush',...observations(m,ledger)};
});
checked('P28-group-demo-fence-negative-calibration','global-fence',async()=>{
  const ledger=new LocalProtectionLedger();ledger.register('A','AP');ledger.register('B','BP');
  assert.equal(ledger.acquire('A',{kind:'demo',key:'G/D'}),true);assert.equal(ledger.acquire('B',{kind:'demo',key:'H/D'}),true);
  const {m}=await model();for(const r of m.plan.filter(r=>r.kind!=='demo'))m.acquire(r);fault(()=>m.acquire({kind:'demo',key:'G/D'}));
  return {anti_control:'group/demo keys do not serialize, protocol plan rejects them',bad_ledger:ledger.events};
});
checked('P29-writer-fence-without-gate-maintenance','writer-obligation',async()=>{
  const ledger=new LocalProtectionLedger();ledger.register('W','WP');ledger.acquire('W',{kind:'demo',key:'D'});
  fault(()=>ledger.writerCommitted('W',['D'],[],ledger.statement('W')));assert.equal(ledger.version,0);return {ledger:ledger.events,expected:'no modeled commit without gate obligation'};
});
checked('P30-nonparticipating-writer-anti-control','assumption-limit',async()=>{
  const {m,ledger,r}=await sealed();const hidden={active:false};hidden.active=true; // Bypasses ledger AND fence by design.
  m.revalidate(r,r);m.enterGuard(r);assert.equal(hidden.active,true);assert.equal(r.enumerations.participants.keys.some(v=>v[1]==='hidden'),false);
  return {hidden_nonparticipant:clone(hidden),accepted_internally_consistent_receipt:true,
    safety_guarantee:false,expected:'validator cannot discover a consistently omitted hidden row or bypass writer',...observations(m,ledger)};
});
checked('P31-positive-write-observer-calibration','instrumentation',async()=>{
  const writes=[],state={gate:0};function set(value){writes.push({op:'set',path:'/gate',value});state.gate=value;}
  set(1);set(0);assert.deepEqual(state,{gate:0});assert.equal(writes.length,2);
  return {attempted_operations:writes,net_state:state,exhaustive_alias_or_SQL_observation:false};
});

checked('P32-observed-change-after-projection','seal',async()=>{
  const {m,ledger}=await prepared();ledger.register('W','WP');ledger.acquire('W',{kind:'demo',key:'OTHER'});
  ledger.writerCommitted('W',['OTHER'],['OTHER'],ledger.statement('W'));ledger.end('W','commit.ack');m.noteWait(ledger.version);
  fault(()=>m.seal(frame(m,ledger)));return {...observations(m,ledger),expected:'old projection cannot be relabelled with new frame/version'};
});
for(const value of [null,undefined,{}])checked('P33-missing-receipt-'+String(value),'binding',async()=>{
  const {m,ledger}=await sealed();fault(()=>m.enterGuard(value));return observations(m,ledger);
});
for(const key of ['actorId','studentId','groupId','affinityGroupId'])checked('P34-post-reread-scope-change-'+key,'scope/GH',async()=>{
  const {m,ledger}=await prepared();const f=frame(m,ledger,v=>{v.scope[key]='CHANGED';if(key==='affinityGroupId')v.staff.subject.scope.group_ids.push('CHANGED');});
  fault(()=>m.seal(f));return {...observations(m,ledger),expected:{modeled_guard:0,modeled_flush:0}};
});
checked('P35-new-hidden-affinity-before-scope-detail','scope/GH',async()=>{
  const {m,ledger}=await prepared();fault(()=>m.seal(frame(m,ledger,v=>v.scope.affinityGroupId='HIDDEN')),'NOT_FOUND',404);
  return observations(m,ledger);
});
checked('P36-external-ownership-loss-before-commit','lease',async()=>{
  const {m,ledger,r}=await sealed();m.enterGuard(r);m.callbackReturned(r);ledger.end('R','rollback.ack');fault(()=>m.beginCommit());
  return {...observations(m,ledger),expected:'no commit after synthetic protection loss'};
});
checked('P37-affected-subset-no-circular-expiry-oracle','scope',async()=>{
  const {m,ledger}=await prepared();const expected={protectedAssignmentIds:['J'],affectedAssignmentIds:[]};
  const r=m.seal(frame(m,ledger,v=>v.affectedAssignmentIds=[]));assert.deepEqual({protectedAssignmentIds:r.protectedAssignmentIds,affectedAssignmentIds:r.affectedAssignmentIds},expected);
  return {expected,actual:{protectedAssignmentIds:r.protectedAssignmentIds,affectedAssignmentIds:r.affectedAssignmentIds},...observations(m,ledger)};
});
checked('P38-cross-transaction-frame-matching-ids','binding',async()=>{
  const a=await prepared(),b=await prepared();const other=frame(b.m,b.ledger);fault(()=>a.m.seal(other));return observations(a.m,a.ledger);
});
checked('P39-zero-absence-facts-do-not-assert-exhaustiveness','assumption-limit',async()=>{
  const {m,ledger}=await prepared(p=>{for(const c of PROTECTION_COLLECTIONS)p.rows[c].absent=[];});
  const r=m.seal(frame(m,ledger));m.enterGuard(r);assert.equal(r.enumerations.participants.keys.length,1);
  return {model_accepted:true,hidden_SQL_participant_truth:'unmeasured',claim:'only exact declared facts, not hidden-row completeness',...observations(m,ledger)};
});
checked('P40-current-mapping-mismatch','authority/GH',async()=>{
  const {m,ledger}=await prepared();fault(()=>m.seal(frame(m,ledger,v=>v.staff.subject.personId='OTHER')));return observations(m,ledger);
});
for(const kind of ['person','group','demo'])checked('P41-writer-rank-'+kind,'writer-obligation',async()=>{
  const ledger=new LocalProtectionLedger();ledger.register('W','WP');ledger.acquire('W',{kind:'attempt',key:'A'});
  fault(()=>ledger.acquire('W',{kind,key:'LATE'}));return {ledger:ledger.events,expected:'participating writer cannot append higher-rank locks'};
});
checked('P42-writer-demo-order','writer-obligation',async()=>{
  const ledger=new LocalProtectionLedger();ledger.register('W','WP');ledger.acquire('W',{kind:'person',key:'peer'});ledger.acquire('W',{kind:'demo',key:'Z'});
  fault(()=>ledger.acquire('W',{kind:'demo',key:'A'}));return {ledger:ledger.events};
});
checked('P43-ended-ledger-transaction-cannot-reopen','lease',async()=>{
  const {m,ledger,r}=await sealed();m.enterGuard(r);m.callbackReturned(r);m.beginCommit();m.commitAcknowledged();m.release();
  fault(()=>ledger.acquire('R',{kind:'demo',key:'D'}));fault(()=>ledger.statement('R'));return observations(m,ledger);
});
for(const variant of ['missing-read','pre-fence-read','copied-read','wait-after-read'])checked('P44-writer-final-reread-'+variant,'writer-obligation',async()=>{
  const ledger=new LocalProtectionLedger();ledger.register('W','WP');ledger.acquire('W',{kind:'person',key:'peer'});let read;
  if(variant==='pre-fence-read')read=ledger.statement('W');
  ledger.acquire('W',{kind:'demo',key:'D'});
  if(variant==='copied-read')read=clone(ledger.statement('W'));
  if(variant==='wait-after-read'){read=ledger.statement('W');ledger.note('W','external.wait');}
  fault(()=>ledger.writerCommitted('W',['D'],['D'],read));assert.equal(ledger.version,0);return {ledger:ledger.events,expected:'no writer commit from missing/stale final recheck'};
});

// R2 red-before controls: expected oracles are literal review decisions. The
// original source is executed first; detail survives a failed assertion.
function observed(action){try{action();return {kind:'returned'};}catch(e){return {kind:'threw',code:e.code??null,status:e.status??null};}}
function expectedFault(action,expected,details){
  const actual=observed(action);probeDetail={expected:{kind:'threw',...expected},actual,...details()};
  assert.deepEqual(actual,{kind:'threw',...expected});return probeDetail;
}
for(const variant of ['rank','same-rank'])checked('F1-reentrant-watermark-'+variant,'r2-lock-watermark',async()=>{
  const ledger=new LocalProtectionLedger();ledger.register('W','WP');
  if(variant==='rank'){
    ledger.acquire('W',{kind:'person',key:'P'});ledger.acquire('W',{kind:'attempt',key:'A'});assert.equal(ledger.acquire('W',{kind:'person',key:'P'}),true);
    return expectedFault(()=>ledger.acquire('W',{kind:'group',key:'G'}),{code:'RESPONSE_INVARIANT_FAILED',status:500},()=>({ledger:ledger.events,new_lock_owned:ledger.owns('W',{kind:'group',key:'G'})}));
  }
  ledger.acquire('W',{kind:'demo',key:'A'});ledger.acquire('W',{kind:'demo',key:'Z'});assert.equal(ledger.acquire('W',{kind:'demo',key:'A'}),true);
  return expectedFault(()=>ledger.acquire('W',{kind:'demo',key:'M'}),{code:'RESPONSE_INVARIANT_FAILED',status:500},()=>({ledger:ledger.events,new_lock_owned:ledger.owns('W',{kind:'demo',key:'M'})}));
});
for(const variant of ['rank','same-rank'])checked('F1-reentrant-valid-next-'+variant,'r2-lock-watermark',async()=>{
  const ledger=new LocalProtectionLedger();ledger.register('W','WP');
  const first=variant==='rank'?{kind:'person',key:'P'}:{kind:'demo',key:'A'};
  const high=variant==='rank'?{kind:'attempt',key:'A'}:{kind:'demo',key:'Z'};
  const next=variant==='rank'?{kind:'attempt',key:'B'}:{kind:'demo',key:'ZZ'};
  ledger.acquire('W',first);ledger.acquire('W',high);assert.equal(ledger.acquire('W',first),true);assert.equal(ledger.acquire('W',next),true);
  return {ledger:ledger.events,expected:'owned reacquisition remains legal; new acquisition must exceed unchanged high watermark'};
});
for(const variant of ['query','reported-wait','version'])checked('F2-callback-commit-gap-'+variant,'r2-commit-freshness',async()=>{
  const {m,ledger,r}=await sealed();m.enterGuard(r);m.callbackReturned(r);
  if(variant==='query')ledger.statement('R');
  if(variant==='reported-wait')ledger.note('R','external.wait');
  if(variant==='version'){
    ledger.register('W','WP');ledger.acquire('W',{kind:'demo',key:'OTHER'});
    ledger.writerCommitted('W',['OTHER'],['OTHER'],ledger.statement('W'));ledger.end('W','commit.ack');
  }
  return expectedFault(()=>m.beginCommit(),{code:'RESPONSE_INVARIANT_FAILED',status:500},()=>observations(m,ledger));
});
for(const outcome of ['ack','committed-ack-loss','uncommitted-ack-loss'])checked('F2-normal-commit-ack-wait-'+outcome,'r2-commit-freshness',async()=>{
  const {m,ledger,r}=await sealed();m.enterGuard(r);m.beginFlush(r);m.callbackReturned(r);m.beginCommit();ledger.note('R','commit.ack.wait');
  const S0={value:'old'},staged={value:'new'};let committed,caller;
  if(outcome==='ack'){m.commitAcknowledged();m.release();committed=clone(staged);caller={ack:true};}
  else{caller=m.commitAcknowledgementLost();committed=outcome==='committed-ack-loss'?clone(staged):clone(S0);assert.deepEqual(caller,{outcome:'commit_unknown',status:503,automaticMutationRetry:false});m.discard();}
  return {S0,staged,committed,caller,...observations(m,ledger),expected:'ordinary ACK wait is not a new pre-COMMIT freshness check'};
});
const expiredProviderCases=[
  ['equality-disabled',100,v=>v.staff.subject.enabled=false],
  ['after-disabled',99,v=>v.staff.subject.enabled=false],
  ['equality-unapproved',100,v=>v.staff.subject.approved=false],
  ['equality-capability',100,v=>v.staff.subject.capabilities.manage_roster=false],
  ['equality-G-hidden',100,v=>v.staff.subject.scope.group_ids=['H']],
  ['equality-H-hidden',100,v=>v.staff.subject.scope.group_ids=['G']],
  ['equality-mapping',100,v=>v.staff.subject.personId='OTHER'],
  ['zero-disabled',0,v=>v.staff.subject.enabled=false],
];
for(const [name,value,other]of expiredProviderCases)checked('F3-provider-expiry-first-'+name,'r2-provider-precedence',async()=>{
  const {m,ledger}=await prepared();const f=frame(m,ledger,v=>{v.providerExpiresAt=value;other(v);});
  return expectedFault(()=>m.seal(f),{code:'STAFF_TOKEN_INVALID',status:401},()=>({provider_expires_at:value,...observations(m,ledger)}));
});
const malformedProviderCases=[['string','200'],['undefined',undefined],['null',null],['negative',-1],['fraction',100.5],['NaN',NaN],['Infinity',Infinity]];
for(const [name,value]of malformedProviderCases)checked('F3-provider-invariant-'+name,'r2-provider-precedence',async()=>{
  const {m,ledger}=await prepared();const f=frame(m,ledger,v=>v.providerExpiresAt=value);
  return expectedFault(()=>m.seal(f),{code:'RESPONSE_INVARIANT_FAILED',status:500},()=>({provider_input_representation:name,...observations(m,ledger)}));
});
for(const variant of ['disabled','expired-proof','capability','hidden-H'])checked('F3-provider-invariant-combined-'+variant,'r2-provider-precedence',async()=>{
  const {m,ledger}=await prepared();const f=frame(m,ledger,v=>{
    v.providerExpiresAt='malformed';if(variant==='disabled')v.staff.subject.enabled=false;
    if(variant==='expired-proof')v.proof.expiresAt=100;if(variant==='capability')v.staff.subject.capabilities.manage_roster=false;
    if(variant==='hidden-H')v.staff.subject.scope.group_ids=['G'];
  });
  return expectedFault(()=>m.seal(f),{code:'RESPONSE_INVARIANT_FAILED',status:500},()=>observations(m,ledger));
});
for(const [name,change,code,status]of [
  ['fresh-provider-disabled',v=>v.staff.subject.enabled=false,'ACCOUNT_DISABLED',403],
  ['fresh-provider-proof-equality',v=>v.proof.expiresAt=100,'STAFF_TOKEN_INVALID',401],
  ['fresh-provider-hidden-H',v=>v.staff.subject.scope.group_ids=['G'],'NOT_FOUND',404],
])checked('F3-original-authority-preserved-'+name,'r2-provider-precedence',async()=>{
  const {m,ledger}=await prepared();const f=frame(m,ledger,change);return expectedFault(()=>m.seal(f),{code,status},()=>observations(m,ledger));
});

after(()=>{if(process.env.UA_PROTECTION_TRACE_PATH)writeFileSync(process.env.UA_PROTECTION_TRACE_PATH,JSON.stringify({base,source_sha256:sourceSha,test_sha256:testSha,
  command:process.argv,case_count:results.length,pass:results.filter(r=>r.verdict==='PASS').length,fail:results.filter(r=>r.verdict==='FAIL').length,
  observation_limit:'Synthetic ledger and explicit world operations; no accepted guard/expiry/SQL writer instrumentation, no hidden omission detector.',results},null,2)+'\n');});

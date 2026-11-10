import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {PostgresTransactions,StorageUnavailable,own,query} from '../../supabase/functions/univeracademy-api/storage/postgres-transaction.ts';
import {ApiFault} from '../../supabase/functions/univeracademy-api/fault.ts';
import {createMembershipProtectionContract,LocalProtectionLedger,PROTECTION_COLLECTIONS} from '../../supabase/functions/univeracademy-api/storage/membership-protection-contract.ts';

const base='8bc48c4647099355a046bb395de5486e6afd251f';
const runnerUrl=new URL('../../supabase/functions/univeracademy-api/storage/postgres-transaction.ts',import.meta.url);
const modelUrl=new URL('../../supabase/functions/univeracademy-api/storage/membership-protection-contract.ts',import.meta.url);
const sha=x=>createHash('sha256').update(readFileSync(x)).digest('hex');
const sourceSha=sha(runnerUrl),testSha=sha(new URL(import.meta.url)),modelSha=sha(modelUrl);
assert.equal(modelSha,'ad4486106fb32ef8ee50e8db151549726bc8fa36b16a21396d7d02d1921d2ed8');
const P='00000000-0000-4000-8000-000000000001',Q='00000000-0000-4000-8000-000000000002';
const clone=structuredClone,results=[];let harnesses=[];
const fault=(code='RESPONSE_INVARIANT_FAILED',status=500)=>new ApiFault(code,status);
const encodedError=e=>e?{name:e.name,message:e.message,code:e.code,status:e.status,outcome:e.outcome}:null;
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const state=()=>({attempt:{status:'in_progress',revision:2,ordinary:null},membership:{active:true,revision:7},history:['sentinel']});
const expired=()=>({attempt:{status:'expired',revision:3,ordinary:{earned:1,maximum:2,percentage:50,calculatedAt:100}},membership:{active:true,revision:7},history:['sentinel']});
function checked(id,gate,body){test(id,async()=>{
  harnesses=[];const started=new Date().toISOString();let detail,error;
  try{detail=await body();}catch(e){error=e;}
  results.push({id,gate,base,source_sha256:sourceSha,test_sha256:testSha,model_sha256:modelSha,command:process.argv,
    started_utc:started,finished_utc:new Date().toISOString(),verdict:error?'FAIL':'PASS',detail,
    observations:harnesses.map(h=>h.snapshot()),...(error?{assertion:encodedError(error),stack:error.stack}:{})});
  if(error)throw error;
});}

// The scripted SQL recorder never invokes the critical gate. It records query
// ENTRY before any branch, and keeps storage state independent of the model.
function harness(o={}){
  const h={ledger:[],events:[],releases:[],writes:[],S0:state(),staged:state(),recordingCommitted:state(),connections:0,
    prepareCalls:0,workCalls:0,gateCalls:0,observerCalls:0,mutationRetries:0,commitEntered:deferred(),rollbackEntered:deferred()};
  harnesses.push(h);const clientId='checked-out-client';
  h.record=(event,extra={})=>h.ledger.push({event,...extra,phase:h.m?.phase??null,leaseHeld:h.m?.leaseHeld??null});
  h.set=(path,value)=>{h.writes.push({op:'set',path,value:clone(value)});h.staged[path]=clone(value);};
  h.client={async query(s){
    h.record('query.entry',{client:clientId,name:s.name,text:s.text,values:clone(s.values)});
    try{
      if(o.queryFailure===s.name)throw o.error;
      let rows=[];
      if(s.name==='ua_people_lock')rows=o.rows??s.values[0].map(id=>({id}));
      if(s.name==='ua_clock')rows=o.clockRows??[{now_ms:'100'}];
      if(s.name==='ua_commit'){
        h.commitEntered.resolve();if(o.commitWait)await o.commitWait.promise;
        if(o.commitLoss==='before')throw Error('scripted COMMIT ACK loss before recording commit');
        h.recordingCommitted=clone(h.staged);
        if(o.commitLoss==='after')throw Error('scripted COMMIT ACK loss after recording commit');
      }
      if(s.name==='ua_rollback'){
        h.rollbackEntered.resolve();if(o.rollbackWait)await o.rollbackWait.promise;
        if(o.rollbackLoss)throw Error('scripted ROLLBACK ACK loss');
        h.recordingCommitted=clone(h.S0);
      }
      h.record('query.resolve',{client:clientId,name:s.name});return {rows,rowCount:rows.length};
    }catch(error){h.record('query.reject',{client:clientId,name:s.name,error:encodedError(error)});throw error;}
  },release(discard){
    h.releases.push(discard);h.record('release.entry',{client:clientId,discard});
    if(o.releaseThrows)throw o.releaseThrows;
    h.record('release.return',{client:clientId});
  }};
  h.pool={async connect(){h.connections++;h.record('connect');assert.equal(h.connections,1,'no second checkout or retry');
    if(o.connectWait)await o.connectWait.promise;if(o.connectFailure)throw o.connectFailure;return h.client;}};
  h.runner=new PostgresTransactions(h.pool);
  h.options={prepare:async client=>{
    h.prepareCalls++;h.record('prepare.entry');assert.equal(client,h.client);
    await client.query({name:'trusted_authorization_anchor',text:'SELECT $1::text',values:['synthetic-anchor']});
    if(o.prepareError)throw o.prepareError;
    if(o.model!==false){
      h.protectionLedger=new LocalProtectionLedger();
      const scope={actorId:'actor',studentId:P,groupId:'G',affinityGroupId:'H'};
      h.m=await createMembershipProtectionContract({mode:'local_contract',transactionId:'T',protectionId:'protection',scope,
        identityAnchors:['actor'],personIds:[P],groupIds:['G','H'],versionIds:[],
        bindings:{currentSeries:[],grants:[{assignmentId:'J',demoId:'D'}],historicalAttempts:[],recoveryAnchors:[]}},h.protectionLedger);
      for(const r of h.m.plan)assert.equal(h.m.acquire(r),true);
    }
    h.record('prepare.return');return Object.hasOwn(o,'ids')?o.ids:[P];
  },beforeCommit:()=>{
    h.gateCalls++;h.record('gate.entry');
    if(o.gate)return o.gate(h);
    if(h.m){h.m.callbackReturned(h.receipt);h.m.beginCommit();}
    h.record('gate.return');
  },observe:event=>{
    h.observerCalls++;assert.equal(Object.isFrozen(event),true);assert.equal(Object.hasOwn(event,'value'),false);
    assert.throws(()=>{event.kind='forged';},TypeError);h.events.push(event);h.record('observe.entry',{kind:event.kind});
    if(o.observerBefore===event.kind)throw Error('observer failed before model notification');
    if(h.m){
      if(event.kind==='rollback_start'){h.originalError??=event.error;h.m.beginRollback(event.error);}
      if(event.kind==='commit_ack')h.m.commitAcknowledged();
      if(event.kind==='commit_unknown')h.m.commitAcknowledgementLost();
      if(event.kind==='rollback_ack')assert.equal(h.m.rollbackAcknowledged(),h.originalError);
      if(event.kind==='rollback_unknown')assert.equal(h.m.rollbackAcknowledgementLost(),h.originalError);
      if(event.kind==='cleanup'){
        // Only a synthetic capability lifetime, never physical lock confirmation.
        if(event.discardRequested)h.m.discard();else h.m.release();
      }
    }
    h.record('observe.return',{kind:event.kind});
    if(o.observerAfter===event.kind)throw Error('observer failed after model notification');
    return o.observerReturn?.(event);
  }};
  h.work=async tx=>{
    h.workCalls++;h.record('work.entry');assert.equal(tx.client,h.client);own(tx,P);
    if(h.m){
      await h.m.rereadTargetBindings(h.protectionLedger.statement('T'),h.m.input.bindings);
      const loaded={staff:['subject'],groups:['G','H'],people:[P],memberships:[P],grants:[P+'/J'],assignments:['J'],series:[],attempts:[],recoveryAssignments:[]};
      h.m.loadProjection({transactionId:'T',protectionId:'protection',read:h.protectionLedger.statement('T'),
        enumerations:{targetSeries:{enumerationId:'s',keys:[]},protectedAssignments:{enumerationId:'a',keys:['J']},
          participants:{enumerationId:'p',keys:[['J',P]]},recoveryAnchors:{enumerationId:'r',keys:[]}},loaded,
        rows:Object.fromEntries(PROTECTION_COLLECTIONS.map(c=>[c,{present:loaded[c],absent:c==='series'?[P+'/D']:[]}])),
        assignments:[{assignmentId:'J',demoId:'D'}],participants:[{assignmentId:'J',personId:P,seriesKey:P+'/D',currentAttemptId:null,recoveryAssignmentId:null}]});
      for(const r of h.m.plan.filter(r=>['assignment','gate'].includes(r.kind)))assert.equal(h.m.acquire(r),true);
      const frame=h.protectionLedger.refreshFrame('T',{frameId:'frame',waitEpoch:h.m.waitEpoch,now:tx.now,providerExpiresAt:200,scope:clone(h.m.input.scope),
        proof:{kind:'staff_verified',subject:'subject',notBefore:0,expiresAt:200},
        staff:{subject:{personId:'actor',enabled:true,approved:true,roles:['owner'],approvedSubjectIds:[],capabilities:{manage_roster:false,manage_content:false},
          scope:{all_groups:false,group_ids:[],all_subjects:false,subject_ids:[]}}},affectedAssignmentIds:[]});
      h.receipt=h.m.seal(frame);h.m.enterGuard(h.receipt);h.m.beginFlush(h.receipt);
    }
    if(o.work)return o.work(tx,h);
    h.set('attempt',expired().attempt);await query(tx,'ua_test_flush','SELECT $1::text',['recorded maintenance']);
    if(o.workError){h.originalError=o.workError;throw o.workError;}
    if(o.invalidate==='statement')h.protectionLedger.statement('T');
    if(o.invalidate==='wait')h.protectionLedger.note('T','external.wait');
    if(o.invalidate==='version'){
      h.protectionLedger.register('W','writer-protection');
      h.protectionLedger.writerCommitted('W',[],[],h.protectionLedger.statement('W'));
    }
    h.record('work.return');return o.value??{kind:'clean_denial',code:'MEMBERSHIP_STATE_CONFLICT',status:409};
  };
  h.run=()=>h.runner.runPrepared(h.options,h.work);
  h.snapshot=()=>({connections:h.connections,prepare:h.prepareCalls,work:h.workCalls,directGateInvocations:h.gateCalls,
    observerInvocations:h.observerCalls,automaticMutationRetry:h.mutationRetries,ledger:h.ledger,
    events:h.events.map(e=>e.kind==='rollback_start'?{...e,error:encodedError(e.error)}:e),releaseAttempts:h.releases,
    attemptedWrites:h.writes,S0:h.S0,staged:h.staged,recordingCommitted:h.recordingCommitted,
    modelPhase:h.m?.phase,syntheticLeaseHeld:h.m?.leaseHeld,protectionLedger:h.protectionLedger?.events});
  return h;
}
const entries=(h,name)=>h.ledger.filter(e=>e.event==='query.entry'&&e.name===name).length;
const isFault=(code,status)=>e=>e.code===code&&e.status===status;
async function fails(h,code='RESPONSE_INVARIANT_FAILED',status=500){let error;try{await h.run();}catch(e){error=e;h.originalError??=e;}
  assert.ok(error);assert.equal(error.code,code);assert.equal(error.status,status);return error;}
function rolledBack(h){assert.equal(entries(h,'ua_commit'),0);assert.equal(entries(h,'ua_rollback'),1);assert.deepEqual(h.recordingCommitted,h.S0);assert.deepEqual(h.releases,[false]);}

checked('B01-constructor-has-no-effects','composition',async()=>{const h=harness();assert.deepEqual(h.snapshot().ledger,[]);assert.equal(h.connections,0);});
checked('B02-actual-runner-order-and-clean409','actual runner',async()=>{
  const h=harness();const outcome=await h.run();assert.deepEqual(outcome,{kind:'clean_denial',code:'MEMBERSHIP_STATE_CONFLICT',status:409});
  assert.equal(h.connections,1);assert.equal(h.gateCalls,1);assert.equal(entries(h,'ua_commit'),1);assert.equal(entries(h,'ua_rollback'),0);
  assert.deepEqual(h.receipt.demoFenceIds,['D']);
  assert.deepEqual(h.recordingCommitted,expired());assert.deepEqual(h.releases,[false]);assert.equal(h.m.phase,'released');
  assert.deepEqual(h.ledger.filter(e=>['query.entry','prepare.entry','work.entry','gate.entry'].includes(e.event)).map(e=>e.name??e.event),
    ['ua_begin','prepare.entry','trusted_authorization_anchor','ua_people_context','ua_people_lock','ua_clock','work.entry','ua_test_flush','gate.entry','ua_commit']);
  const gateReturn=h.ledger.findIndex(e=>e.event==='gate.return');assert.equal(h.ledger[gateReturn+1].name,'ua_commit');
  assert.ok(h.ledger.filter(e=>e.event==='query.entry').every(e=>e.client==='checked-out-client'));
  return {literalExpectedCommitted:expired()};
});
for(const [label,options,work] of [
  ['missing',undefined,async()=>0],['prepare-missing',{beforeCommit(){}},async()=>0],['prepare-invalid',{prepare:1,beforeCommit(){}},async()=>0],
  ['gate-missing',{prepare:async()=>[P]},async()=>0],['gate-invalid',{prepare:async()=>[P],beforeCommit:1},async()=>0],
  ['observer-invalid',{prepare:async()=>[P],beforeCommit(){},observe:1},async()=>0],['work-invalid',{prepare:async()=>[P],beforeCommit(){}},1],
])checked('B03-invalid-binding-'+label,'composition',async()=>{
  const h=harness();await assert.rejects(h.runner.runPrepared(options,work),isFault('RESPONSE_INVARIANT_FAILED',500));assert.equal(h.connections,0);
});
for(const [label,ids] of [['null',null],['object',{}],['empty',[]],['sparse',new Array(1)],['undefined',[undefined]],['numeric',[1]],
  ['upper',[P.toUpperCase().replace('00000000','ABCDEF00')]],['noncanonical',[' '+P]],['invalid',['person']],['mixed',[P,{}]],['inherited',Object.assign(Object.create([P]),{length:1})]])
checked('B04-derived-IDs-'+label,'scope',async()=>{
  const h=harness({ids,model:false});await fails(h);rolledBack(h);assert.equal(entries(h,'ua_people_lock'),0);assert.equal(h.workCalls,0);
});
checked('B05-sorted-deduplicated-detached-scope-and-writable-clock','scope',async()=>{
  const ids=[Q,P,Q];const h=harness({model:false,ids,work:async tx=>{
    ids.push('intruder');assert.deepEqual(tx.personIds,[P,Q]);assert.notEqual(tx.personIds,ids);assert.equal(Object.isFrozen(tx.personIds),true);
    for(const key of ['personIds','client'])assert.deepEqual(Object.getOwnPropertyDescriptor(tx,key),{value:key==='client'?h.client:tx.personIds,writable:false,enumerable:true,configurable:false});
    assert.throws(()=>tx.personIds.push('intruder'),TypeError);assert.throws(()=>{tx.personIds=['intruder'];},TypeError);
    assert.throws(()=>Object.defineProperty(tx,'personIds',{value:['intruder']}),TypeError);
    assert.throws(()=>{tx.client={};},TypeError);assert.throws(()=>Object.defineProperty(tx,'client',{value:{}}),TypeError);
    assert.throws(()=>own(tx,'intruder'),isFault('NOT_FOUND',404));tx.now=101;assert.equal(tx.now,101);own(tx,Q);return 'allowed';
  }});assert.equal(await h.run(),'allowed');
  assert.deepEqual(h.ledger.find(e=>e.name==='ua_people_lock').values,[[P,Q]]);
});
for(const [label,rows] of [['missing',[]],['out-of-order',[{id:Q},{id:P}]],['duplicate',[{id:P},{id:P}]]])
checked('B06-valid-ID-invalid-rows-'+label,'scope',async()=>{const h=harness({ids:[P,Q],rows,model:false});await fails(h,'NOT_FOUND',404);rolledBack(h);assert.equal(h.workCalls,0);});
checked('B07-option-reassignment-cannot-replace-captured-callbacks','capture',async()=>{
  const wait=deferred(),h=harness({connectWait:wait});let replacement=0;const p=h.run();
  h.options.prepare=async()=>{replacement++;return [Q];};h.options.beforeCommit=()=>{replacement++;};h.options.observe=()=>{replacement++;};wait.resolve();
  await p;assert.equal(replacement,0);assert.equal(h.gateCalls,1);assert.equal(h.prepareCalls,1);assert.equal(h.m.phase,'released');
});
checked('B08-prepare-throw-original-identity','rollback',async()=>{
  const error=Error('prepare sentinel'),h=harness({prepareError:error});await assert.rejects(h.run(),e=>e===error);rolledBack(h);
  assert.equal(entries(h,'ua_people_lock'),0);assert.equal(h.workCalls,0);assert.equal(h.gateCalls,0);
});
for(const name of ['ua_people_context','ua_people_lock','ua_clock'])checked('B09-query-fault-'+name,'rollback',async()=>{
  const error=Error(name),h=harness({queryFailure:name,error,model:false});await assert.rejects(h.run(),e=>e===error);rolledBack(h);assert.equal(h.gateCalls,0);
});
for(const rows of [[],[{now_ms:'1.1'}],[{now_ms:'8640000000000001'}]])checked('B10-clock-invariant-'+JSON.stringify(rows),'rollback',async()=>{
  const h=harness({clockRows:rows,model:false});await fails(h);rolledBack(h);assert.equal(h.workCalls,0);
});
checked('B11-work-refresh-error-after-staging','rollback',async()=>{
  const error=Error('refresh failure'),h=harness({workError:error});await assert.rejects(h.run(),e=>e===error);rolledBack(h);
  assert.deepEqual(h.staged,expired());assert.equal(h.writes.length,1);assert.equal(h.gateCalls,0);assert.equal(h.m.phase,'released');
});
checked('B12-thrown409-is-technical-original-error','rollback',async()=>{
  const error=fault('MEMBERSHIP_STATE_CONFLICT',409),h=harness({workError:error});await assert.rejects(h.run(),e=>e===error);rolledBack(h);assert.deepEqual(h.staged,expired());
});
checked('B13-gate-throw-before-COMMIT-entry','critical gate',async()=>{
  const error=fault(),h=harness({gate:()=>{throw error;}});h.originalError=error;
  await assert.rejects(h.run(),e=>e===error);rolledBack(h);assert.equal(h.gateCalls,1);assert.deepEqual(h.staged,expired());assert.equal(h.m.phase,'released');
});
for(const variant of ['statement','wait','version'])checked('B14-accepted-model-stale-gate-'+variant,'critical gate',async()=>{
  const h=harness({invalidate:variant});const error=await fails(h);rolledBack(h);assert.equal(h.gateCalls,1);
  assert.equal(h.events.find(e=>e.kind==='rollback_start').error,error);assert.equal(h.events.some(e=>e.kind==='commit_unknown'),false);
});
for(const [label,make] of [['resolved',()=>Promise.resolve()],['rejected',()=>Promise.reject(Error('gate rejection'))],['pending',()=>new Promise(()=>{})],
  ['null',()=>null],['false',()=>false],['number',()=>1],['string',()=> 'void'],['object',()=>({})]])
checked('B15-nonvoid-gate-'+label,'critical gate',async()=>{
  const h=harness({model:false,gate:make});await fails(h);rolledBack(h);assert.equal(h.gateCalls,1);
});
for(const variant of ['getter','method','revoked-proxy'])checked('B16-arbitrary-thenable-never-assimilated-'+variant,'critical gate',async()=>{
  let touches=0;let value;if(variant==='getter')value={get then(){touches++;throw Error('then getter');}};
  if(variant==='method')value={then(){touches++;throw Error('then call');}};
  if(variant==='revoked-proxy'){const x=Proxy.revocable({},{});x.revoke();value=x.proxy;}
  const h=harness({model:false,gate:()=>value});await fails(h);rolledBack(h);assert.equal(touches,0);
});
checked('B17-native-Promise-overridden-then-not-read','critical gate',async()=>{
  let touches=0;const p=Promise.reject(Error('native rejection'));Object.defineProperty(p,'then',{get(){touches++;throw Error('caller then');}});
  const h=harness({model:false,gate:()=>p});await fails(h);rolledBack(h);assert.equal(touches,0);
});
checked('B18-deferred-COMMIT-ACK-holds-lease-and-caller','ACK',async()=>{
  const wait=deferred(),h=harness({commitWait:wait});let settled=false;const p=h.run().finally(()=>{settled=true;});await h.commitEntered.promise;
  assert.equal(settled,false);assert.equal(h.m.phase,'commit_pending');assert.equal(h.m.leaseHeld,true);assert.deepEqual(h.releases,[]);assert.deepEqual(h.recordingCommitted,h.S0);
  // ACK waiting does not require a new freshness frame.
  h.protectionLedger.statement('T');wait.resolve();await p;assert.equal(settled,true);assert.deepEqual(h.recordingCommitted,expired());assert.equal(h.m.phase,'released');
});
for(const variant of ['before','after'])checked('B19-COMMIT-loss-'+variant,'unknown',async()=>{
  const h=harness({commitLoss:variant});const error=await fails(h,'SERVICE_UNAVAILABLE',503);assert.ok(error instanceof StorageUnavailable);assert.equal(error.outcome,'commit_unknown');
  assert.equal(entries(h,'ua_commit'),1);assert.equal(entries(h,'ua_rollback'),0);assert.equal(h.connections,1);assert.equal(h.mutationRetries,0);
  assert.deepEqual(h.releases,[true]);assert.deepEqual(h.recordingCommitted,variant==='after'?expired():h.S0);assert.equal(h.m.phase,'discarded');
});
for(const loss of [false,true])checked('B20-deferred-ROLLBACK-'+String(loss),'rollback uncertainty',async()=>{
  const wait=deferred(),error=fault('MEMBERSHIP_STATE_CONFLICT',409),h=harness({workError:error,rollbackWait:wait,rollbackLoss:loss});let settled=false;
  const p=h.run().then(()=>assert.fail('must not succeed'),e=>{assert.equal(e,error);settled=true;});await h.rollbackEntered.promise;
  assert.equal(settled,false);assert.equal(h.m.phase,'rollback_pending');assert.equal(h.m.leaseHeld,true);assert.deepEqual(h.releases,[]);
  wait.resolve();await p;assert.deepEqual(h.releases,[loss]);assert.equal(entries(h,'ua_commit'),0);
  assert.equal(h.events.some(e=>e.kind==='commit_unknown'),false);assert.equal(h.m.phase,loss?'discarded':'released');
  return {rollbackAcknowledged:!loss,physicalOutcomeConfirmed:false,recordingStateOnly:true};
});
for(const kind of ['commit_ack','rollback_start','rollback_ack','commit_unknown','rollback_unknown','cleanup'])
for(const position of ['Before','After'])checked('B21-observer-'+position+'-'+kind,'observer',async()=>{
  const error=fault('MEMBERSHIP_STATE_CONFLICT',409),o={['observer'+position]:kind};
  if(kind==='commit_unknown')o.commitLoss='after';if(kind.startsWith('rollback'))o.workError=error;if(kind==='rollback_unknown')o.rollbackLoss=true;
  const h=harness(o);if(o.commitLoss)await fails(h,'SERVICE_UNAVAILABLE',503);else if(o.workError)await assert.rejects(h.run(),e=>e===error);else await h.run();
  assert.equal(h.releases.length,1);assert.deepEqual(h.recordingCommitted,o.workError?h.S0:expired());
  if(position==='Before'&&kind!=='cleanup')assert.equal(h.m.leaseHeld,true,'observer failure must not be reported as successful model cleanup');
});
checked('B22-observer-nonvoid-and-thenables-ignored','observer',async()=>{
  let touches=0;const h=harness({observerReturn:()=>({get then(){touches++;throw Error('must not read');}})});await h.run();assert.equal(touches,0);assert.equal(h.m.phase,'released');
});
checked('B23-observer-native-rejection-drained','observer',async()=>{
  const h=harness({observerReturn:()=>Promise.reject(Error('observer async rejection'))});await h.run();assert.deepEqual(h.recordingCommitted,expired());
});
for(const kind of ['success','thrown409','commit_unknown','rollback_unknown'])checked('B24-release-throw-preserves-'+kind,'cleanup',async()=>{
  const original=fault('MEMBERSHIP_STATE_CONFLICT',409),releaseError=Error('release effected then threw'),o={releaseThrows:releaseError};
  if(kind==='thrown409'||kind==='rollback_unknown')o.workError=original;if(kind==='commit_unknown')o.commitLoss='after';if(kind==='rollback_unknown')o.rollbackLoss=true;
  const h=harness(o);if(kind==='success')await h.run();else if(kind==='commit_unknown')await fails(h,'SERVICE_UNAVAILABLE',503);else await assert.rejects(h.run(),e=>e===original);
  assert.equal(h.releases.length,1);assert.deepEqual(h.events.at(-1),{kind:'cleanup',discardRequested:kind.endsWith('unknown'),releaseInvocation:'threw'});
  assert.equal(h.ledger.filter(e=>e.event==='release.entry').length,1);
});
for(const mode of ['missing-pool','connect-fault','missing-query','missing-release','bad-release'])checked('B25-unavailable-'+mode,'cleanup',async()=>{
  const h=harness({model:false});if(mode==='missing-pool')h.runner=new PostgresTransactions({});
  if(mode==='connect-fault')h.runner=new PostgresTransactions({connect:async()=>{throw Error('offline');}});
  if(mode==='missing-query')delete h.client.query;if(mode==='missing-release')delete h.client.release;if(mode==='bad-release')h.client.release=1;
  const e=await fails(h,'SERVICE_UNAVAILABLE',503);assert.equal(e.outcome,'not_committed');assert.equal(h.workCalls,0);
  const c=h.events.at(-1);assert.equal(c.kind,'cleanup');assert.equal(c.discardRequested,true);assert.equal(c.releaseInvocation,mode==='missing-query'?'returned':'unavailable');
});
checked('B26-BEGIN-fault-no-rollback-and-discard','cleanup',async()=>{
  const error=Error('BEGIN failed'),h=harness({queryFailure:'ua_begin',error,model:false});await assert.rejects(h.run(),e=>e===error);
  assert.equal(entries(h,'ua_rollback'),0);assert.equal(h.prepareCalls,0);assert.deepEqual(h.releases,[true]);
});
checked('B27-release-method-removed-after-work','cleanup',async()=>{
  const h=harness({model:false,work:async()=>{delete h.client.release;return 'committed';}});assert.equal(await h.run(),'committed');
  assert.deepEqual(h.events.at(-1),{kind:'cleanup',discardRequested:false,releaseInvocation:'unavailable'});assert.deepEqual(h.releases,[]);
});
checked('B28-legacy-run-context-mutable-and-no-hooks','legacy',async()=>{
  const h=harness({model:false});const value=await h.runner.run([Q,P,Q],async tx=>{assert.deepEqual(tx.personIds,[P,Q]);assert.equal(Object.isFrozen(tx.personIds),false);
    tx.now=200;assert.equal(tx.now,200);await query(tx,'legacy_work','SELECT $1',[123]);return 'legacy';});
  assert.equal(value,'legacy');assert.equal(h.prepareCalls,0);assert.equal(h.gateCalls,0);assert.equal(h.observerCalls,0);
  assert.deepEqual(h.ledger.filter(e=>e.event==='query.entry').map(e=>e.name),['ua_begin','ua_people_context','ua_people_lock','ua_clock','legacy_work','ua_commit']);
});
checked('B29-legacy-identity-order-context-and-no-hooks','legacy',async()=>{
  const h=harness({model:false});assert.equal(await h.runner.runIdentity(4000000001,async gate=>{
    assert.equal(gate.client,h.client);assert.equal(gate.telegramId,4000000001);assert.deepEqual(gate.personIds,[]);assert.equal(gate.now,100);return P;
  },async tx=>{own(tx,P);assert.throws(()=>own(tx,Q),isFault('NOT_FOUND',404));return 'identity';}),'identity');
  assert.deepEqual(h.ledger.filter(e=>e.event==='query.entry').map(e=>e.name),['ua_begin','ua_telegram_identity_lock','ua_telegram_identity_context','ua_clock','ua_people_context','ua_people_lock','ua_clock','ua_commit']);
  assert.equal(h.gateCalls,0);assert.equal(h.observerCalls,0);
});
for(const kind of ['run-invalid','identity-invalid','identity-ensure-fault','identity-derived-invalid','run-throw','run-commit-loss'])checked('B30-legacy-errors-'+kind,'legacy',async()=>{
  const error=Error('legacy work'),h=harness({model:false,commitLoss:kind==='run-commit-loss'?'after':undefined});
  if(kind==='run-invalid')await assert.rejects(h.runner.run(['bad'],async()=>0),isFault('NOT_FOUND',404));
  if(kind==='identity-invalid')await assert.rejects(h.runner.runIdentity(0,async()=>P,async()=>0),isFault('INIT_DATA_INVALID',401));
  if(kind==='identity-ensure-fault')await assert.rejects(h.runner.runIdentity(1,async()=>{throw error;},async()=>0),e=>e===error);
  if(kind==='identity-derived-invalid')await assert.rejects(h.runner.runIdentity(1,async()=> 'bad',async()=>0),isFault('RESPONSE_INVARIANT_FAILED',500));
  if(kind==='run-throw')await assert.rejects(h.runner.run([P],async()=>{throw error;}),e=>e===error);
  if(kind==='run-commit-loss')await assert.rejects(h.runner.run([P],async()=>0),e=>e.outcome==='commit_unknown'&&e.status===503);
  assert.equal(h.observerCalls,0);assert.equal(h.gateCalls,0);
});
for(const failure of [false,true])checked('B31-legacy-release-throw-still-masks-'+failure,'legacy',async()=>{
  const releaseError=Error('legacy release throw'),original=Error('work'),h=harness({model:false,releaseThrows:releaseError});
  await assert.rejects(h.runner.run([P],async()=>{if(failure)throw original;return 'success';}),e=>e===releaseError);assert.equal(h.releases.length,1);assert.equal(h.observerCalls,0);
});
checked('B32-strict-unhandled-rejection-native-and-hostile-controls','strict subprocess',async()=>{
  const script=`import assert from 'node:assert/strict';import {PostgresTransactions} from ${JSON.stringify(runnerUrl.href)};
    const P=${JSON.stringify(P)};let touches=0;
    const pool={connect:async()=>({query:async s=>({rows:s.name==='ua_people_lock'?[{id:P}]:s.name==='ua_clock'?[{now_ms:'100'}]:[],rowCount:1}),release(){}})};
    for(const beforeCommit of [()=>Promise.resolve(),()=>Promise.reject(Error('gate')),()=>new Promise(()=>{}),()=>({get then(){touches++;throw Error('hostile');}})]){
      await assert.rejects(new PostgresTransactions(pool).runPrepared({prepare:async()=>[P],beforeCommit,observe:()=>Promise.reject(Error('observer'))},async()=>1),e=>e.status===500);
    }
    await new PostgresTransactions(pool).runPrepared({prepare:async()=>[P],beforeCommit(){},observe:()=>Promise.reject(Error('observer success'))},async()=>1);
    await new Promise(r=>setImmediate(r));assert.equal(touches,0);console.log('STRICT_PASS');`;
  const stdout=execFileSync(process.execPath,['--unhandled-rejections=strict','--input-type=module','-e',script],{encoding:'utf8'});
  assert.equal(stdout.trim(),'STRICT_PASS');return {childCommand:[process.execPath,'--unhandled-rejections=strict','--input-type=module','-e',script],stdout};
});
checked('B33-intervening-statement-inside-critical-gate','critical gate',async()=>{
  const h=harness({gate:x=>{x.m.callbackReturned(x.receipt);x.protectionLedger.statement('T');x.m.beginCommit();}});
  const error=await fails(h);rolledBack(h);assert.equal(h.events.find(e=>e.kind==='rollback_start').error,error);assert.equal(h.gateCalls,1);
});
checked('B34-unowned-peer-cannot-expand-protection-scope','scope',async()=>{
  const h=harness({model:false,work:async tx=>{assert.throws(()=>own(tx,Q),isFault('NOT_FOUND',404));own(tx,P);return 'target only';}});
  assert.equal(await h.run(),'target only');assert.deepEqual(h.ledger.find(e=>e.name==='ua_people_lock').values,[[P]]);
});
checked('B35-partial-flush-storage-fault-is-technical','rollback',async()=>{
  const error=fault('ARBITRARY_STORAGE_CONFLICT',409),h=harness({queryFailure:'ua_test_flush',error});h.originalError=error;
  await assert.rejects(h.run(),e=>e===error);rolledBack(h);assert.deepEqual(h.staged,expired());assert.equal(h.writes.length,1);assert.equal(h.gateCalls,0);
});
checked('B36-gate-undefined-is-the-only-valid-return','critical gate',async()=>{
  const h=harness({model:false,gate:()=>undefined});await h.run();assert.equal(h.gateCalls,1);assert.equal(entries(h,'ua_commit'),1);assert.deepEqual(h.releases,[false]);
});
checked('B37-release-returned-rejected-Promise-drained','cleanup',async()=>{
  const h=harness({model:false});h.client.release=function(discard){h.releases.push(discard);return Promise.reject(Error('async release not an ACK'));};
  await h.run();assert.deepEqual(h.releases,[false]);assert.equal(h.events.at(-1).releaseInvocation,'returned');
});
checked('B38-observer-return-values-do-not-change-clean-denial','observer',async()=>{
  const h=harness({observerReturn:()=>({kind:'success',status:200})});assert.equal((await h.run()).status,409);assert.deepEqual(h.recordingCommitted,expired());
});
for(const validReads of [1,2])checked('B39-derived-own-getter-valid-'+validReads+'-then-invalid','single-read IDs',async()=>{
  let reads=0,workIds=null;const ids=[];
  Object.defineProperty(ids,0,{enumerable:true,get(){reads++;return reads<=validReads?P:'not-a-uuid';}});
  const h=harness({model:false,ids});const snapshot=h.snapshot;let observedError=null;
  h.snapshot=()=>({...snapshot(),derivedIDReads:reads,actualWorkIDs:workIds,observedError,
    queryEntries:{personContext:entries(h,'ua_people_context'),personLock:entries(h,'ua_people_lock'),commit:entries(h,'ua_commit'),rollback:entries(h,'ua_rollback')}});
  h.work=async tx=>{h.workCalls++;h.record('work.entry');workIds=clone(tx.personIds);return 'captured valid ID';};
  let value;try{value=await h.run();}catch(error){observedError=encodedError(error);}
  assert.equal(reads,1,'each own ID element is captured exactly once');assert.equal(observedError,null);assert.equal(value,'captured valid ID');
  assert.deepEqual(workIds,[P]);assert.equal(h.workCalls,1);assert.equal(entries(h,'ua_commit'),1);assert.equal(entries(h,'ua_rollback'),0);
  assert.deepEqual(h.ledger.find(e=>e.name==='ua_people_context').values,[JSON.stringify([P])]);
  assert.deepEqual(h.ledger.find(e=>e.name==='ua_people_lock').values,[[P]]);
});
checked('B40-derived-own-getter-invalid-first','single-read IDs',async()=>{
  let reads=0;const ids=[];Object.defineProperty(ids,0,{enumerable:true,get(){reads++;return reads===1?'not-a-uuid':P;}});
  const h=harness({model:false,ids});const snapshot=h.snapshot;let observedError=null;
  h.snapshot=()=>({...snapshot(),derivedIDReads:reads,observedError,
    queryEntries:{personContext:entries(h,'ua_people_context'),personLock:entries(h,'ua_people_lock'),commit:entries(h,'ua_commit'),rollback:entries(h,'ua_rollback')}});
  h.work=async()=>{h.workCalls++;h.record('work.entry');return 'must not execute';};
  try{await h.run();}catch(error){observedError=encodedError(error);}
  assert.equal(reads,1);assert.equal(observedError?.code,'RESPONSE_INVARIANT_FAILED');assert.equal(observedError?.status,500);
  assert.equal(entries(h,'ua_people_context'),0);assert.equal(entries(h,'ua_people_lock'),0);assert.equal(h.workCalls,0);rolledBack(h);
});
after(()=>{
  if(process.env.UA_TX_BRIDGE_TRACE_PATH)writeFileSync(process.env.UA_TX_BRIDGE_TRACE_PATH,JSON.stringify({schema:'actual-runner-scripted-client-v1',base,
    source_sha256:sourceSha,test_sha256:testSha,model_sha256:modelSha,layer:'actual PostgresTransactions, scripted PgClient and independent recording state',
    observationLimits:['No SQL execution or physical durability/lock confirmation.','Explicit set attempts cover this fixture; no exhaustive arbitrary-alias tracing.',
      'Protection ledger is synthetic and is not the recording committed-state oracle.','Observer failure retains the actual last model phase/lease.'],cases:results},null,2)+'\n');
});

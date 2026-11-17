import test from 'node:test';import assert from 'node:assert/strict';
import {createAccountDeletionRecoveryWorker} from '../../runtime/account-deletion-recovery-worker.mjs';
const issuer='https://clerk.example.com',job='11111111-1111-4111-8111-111111111111';
const env={UA_DELETION_RECOVERY_ENABLED:'true',HYPERDRIVE_DELETION_RECOVERY:{connectionString:'postgresql://restricted:private@hyperdrive.local:5432/postgres?sslmode=disable'},UA_CLERK_ISSUER:issuer,UA_CLERK_INSTANCE_ID:'ins_test',UA_CLERK_SECRET_KEY:'sk_private'};
function fixture({jobs=0,role='ua_deletion_recovery_login',closeError=false,closeHang=false,queryHang=false,providerError=false,runTimeoutMs=20000}={}){
 const events=[],logs=[];let remains=jobs;
 class Client{
  constructor(config){events.push(['constructor',config]);}on(){}async connect(){events.push(['connect']);}
  async query(q){events.push(['query',q.text]);if(queryHang)return new Promise(()=>{});let rows=[];
   if(q.text.includes('current_user AS role'))rows=[{role,elevated:false,inherited:false,writable:false}];
   else if(q.text.includes('due_account_deletions()'))rows=remains>0?[{job_id:job}]:[];
   else if(q.text.includes('claim_account_deletion('))rows=[{job_id:job,lease_id:q.values[1],issuer,subject:'user_a'}];
   else if(q.text.includes('mark_account_provider_deleted('))rows=[{ok:true}];
   else if(q.text.includes('finish_account_deletion(')){rows=[{ok:true}];remains--;}
   return {rows,rowCount:rows.length};
  }
  async end(){events.push(['end']);if(closeError)throw Error('private connection secret');if(closeHang)return new Promise(()=>{});}
 }
 const worker=createAccountDeletionRecoveryWorker({loadClient:async()=>Client,runTimeoutMs,closeTimeoutMs:10,log:(...v)=>logs.push(v),transport:async r=>{
  events.push(['http',r.method,r.url]);if(providerError)throw Error('sk_private do not log');
  if(r.url.endsWith('/instance'))return Response.json({id:'ins_test',environment_type:'production'});
  if(r.url.endsWith('/domains'))return Response.json({data:[{is_satellite:false,frontend_api_url:issuer}]});
  return Response.json({id:'user_a',object:'user',deleted:true});
 }});return {worker,events,logs};
}
test('disabled default and HTTP requests touch no DB/provider',async()=>{const f=fixture();assert.deepEqual(await f.worker.scheduled({},{}),{processed:0,disabled:true});assert.deepEqual(await f.worker.scheduled({},{UA_DELETION_RECOVERY_ENABLED:'false'}),{processed:0,disabled:true});assert.equal((await f.worker.fetch(new Request('https://evil/delete'),env)).status,404);assert.equal(f.events.length,0);});
test('strict bindings reject request Hyperdrive, extra fields and bad flags',async()=>{for(const e of [{...env,HYPERDRIVE:env.HYPERDRIVE_DELETION_RECOVERY},{...env,UA_DELETION_RECOVERY_ENABLED:true},{...env,HYPERDRIVE_DELETION_RECOVERY:undefined}]){const f=fixture();await assert.rejects(f.worker.scheduled({},e),{message:'ACCOUNT_DELETION_RECOVERY_UNCONFIRMED'});assert.equal(f.events.length,0);}});
test('empty queue creates one client and awaits close without provider',async()=>{const f=fixture();assert.deepEqual(await f.worker.scheduled({},env),{processed:0,disabled:false});assert.equal(f.events.filter(e=>e[0]==='constructor').length,1);assert.equal(f.events.filter(e=>e[0]==='end').length,1);assert.equal(f.events.some(e=>e[0]==='http'),false);});
test('bounded batch and provider ordering from accepted DB claims',async()=>{const f=fixture({jobs:10});assert.deepEqual(await f.worker.scheduled({},env),{processed:3,disabled:false});assert.equal(f.events.filter(e=>e[0]==='http'&&e[1]==='DELETE').length,3);assert.equal(f.events.filter(e=>e[0]==='constructor').length,1);assert.equal(f.events.filter(e=>e[0]==='end').length,1);const ix=f.events.findIndex(e=>e[0]==='http');assert.ok(f.events.slice(0,ix).some(e=>e[1]==='COMMIT'));});
test('request role cannot recover and never contacts provider',async()=>{const f=fixture({jobs:1,role:'ua_deletion_request_login'});await assert.rejects(f.worker.scheduled({},env));assert.equal(f.events.some(e=>e[0]==='http'),false);});
test('provider failure leaves job without finalization and logs no secrets',async()=>{const f=fixture({jobs:1,providerError:true});await assert.rejects(f.worker.scheduled({},env));assert.equal(f.events.some(e=>String(e[1]).includes('finish_account_deletion')),false);assert.deepEqual(f.logs,[['UA_ACCOUNT_DELETION_RECOVERY','RUN_UNCONFIRMED']]);});
test('failed close is never acknowledged as success',async()=>{const f=fixture({closeError:true});await assert.rejects(f.worker.scheduled({},env));assert.ok(f.logs.some(v=>v[1]==='CLOSE_UNCONFIRMED'));});
test('hung close has bounded failure',async()=>{const f=fixture({closeHang:true});await assert.rejects(f.worker.scheduled({},env));assert.ok(f.logs.some(v=>v[1]==='CLOSE_UNCONFIRMED'));});
test('query deadline aborts lifecycle before provider',async()=>{const f=fixture({jobs:1,queryHang:true,runTimeoutMs:10});await assert.rejects(f.worker.scheduled({},env));assert.equal(f.events.some(e=>e[0]==='http'),false);assert.equal(f.events.filter(e=>e[0]==='end').length,1);});
test('late driver load cannot acquire resources after deadline',async()=>{let resolve,constructed=0;const worker=createAccountDeletionRecoveryWorker({loadClient:()=>new Promise(r=>resolve=r),runTimeoutMs:5,closeTimeoutMs:5,log:()=>{},transport:()=>{throw Error('no');}});await assert.rejects(worker.scheduled({},env));resolve(class{constructor(){constructed++;}});await new Promise(r=>setTimeout(r,5));assert.equal(constructed,0);});

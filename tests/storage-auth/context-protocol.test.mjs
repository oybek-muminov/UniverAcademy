import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DiskExecutor,durableWrite} from './disk-executor.mjs';
import {PostgresTransactions} from '../../supabase/functions/univeracademy-api/storage/postgres-transaction.ts';
import {resetTrustedServerContext,setTrustedPhase,setTrustedPeople,setTrustedClerk,setTrustedTelegram,closeTrustedServerContext} from '../../supabase/functions/univeracademy-api/storage/trusted-server-context.ts';

const P='00000000-0000-4000-8000-000000000001',Q='00000000-0000-4000-8000-000000000002';
const resetSql="SELECT set_config('ua.phase',$1,true),set_config('ua.person_id',$2,true),set_config('ua.person_ids',$3,true),set_config('ua.clerk_issuer',$4,true),set_config('ua.clerk_subject',$5,true),set_config('ua.telegram_id',$6,true)";
const deny=['deny','','[]','','',''],keys=['phase','person_id','person_ids','clerk_issuer','clerk_subject','telegram_id'];
const phase=next=>({name:'ua_context_phase',text:"SELECT set_config('ua.phase',$1,true)",values:[next]});
const people=(id,ids)=>({name:'ua_people_context',text:"SELECT set_config('ua.person_id',$1,true),set_config('ua.person_ids',$2,true)",values:[id,ids]});
const query=(c,name,text,values=[])=>c.query({name,text,values});
async function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'ua-context-protocol-')),path=join(dir,'rows.json');t.after(()=>rmSync(dir,{recursive:true,force:true}));durableWrite(path,{people:{[P]:{},[Q]:{}},writes:0});return new DiskExecutor(path);
}
async function client(t,{auth=true}={}){
 const pool=await setup(t),c=await pool.connect();t.after(()=>{closeTrustedServerContext(c);try{c.release(true);}catch{}});await query(c,'ua_begin','BEGIN');await resetTrustedServerContext(c);if(auth)await setTrustedPhase(c,'auth');return{pool,c};
}
const rollback=c=>query(c,'ua_rollback','ROLLBACK');

test('actual six-key reset clears all stale session values before auth; SET LOCAL state does not carry to the next transaction',async t=>{
 const pool=await setup(t);pool.sessionContext={phase:'domain',person_id:Q,person_ids:JSON.stringify([Q]),clerk_issuer:'https://old.invalid',clerk_subject:'user_Old',telegram_id:'123'};
 for(let n=0;n<2;n++){
  const c=await pool.connect();await query(c,'ua_begin','BEGIN');assert.equal(c.context.person_id,Q);await resetTrustedServerContext(c);assert.deepEqual(c.context,Object.fromEntries(keys.map((k,i)=>[k,deny[i]])));
  await setTrustedPhase(c,'auth');await setTrustedPeople(c,[P]);await setTrustedClerk(c,'https://issuer.invalid','user_CaseSensitive');await setTrustedPhase(c,'exchange');assert.equal(c.context.person_id,P);assert.equal(c.context.telegram_id,'');
  await query(c,n?'ua_commit':'ua_rollback',n?'COMMIT':'ROLLBACK');assert.deepEqual(c.context,pool.sessionContext);closeTrustedServerContext(c);c.release();
 }
 assert.equal(pool.events.filter(x=>x==='ua_context_reset').length,2);
});
for(const [name,text,end,ending]of [['ua_begin','BEGIN','ua_commit','COMMIT'],['ua_clerk_begin','BEGIN','ua_clerk_rollback','ROLLBACK'],['ua_locator_begin','BEGIN','ua_locator_rollback','ROLLBACK'],['ua_clerk_locator_begin','BEGIN','ua_clerk_locator_rollback','ROLLBACK']])test('exact transaction/context lifecycle '+name,async t=>{
 const pool=await setup(t),c=await pool.connect();await query(c,name,text);await resetTrustedServerContext(c);await setTrustedPhase(c,'auth');await query(c,end,ending);c.release();assert.equal(pool.releasedDiscard,false);
});
test('data, reset and transaction ends require an active unreleased checkout',async t=>{
 const pool=await setup(t),c=await pool.connect();await assert.rejects(query(c,'ua_clock','SELECT now'),/TRANSACTION_REQUIRED/);await assert.rejects(query(c,'ua_context_reset',resetSql,deny),/TRANSACTION_REQUIRED/);c.release();await assert.rejects(query(c,'ua_begin','BEGIN'),/CLIENT_ALREADY_RELEASED/);assert.throws(()=>c.release(),/CLIENT_ALREADY_RELEASED/);
});
for(const [name,text,v]of [['ua_clock','SELECT now',[]],['ua_context_phase',phase('auth').text,['auth']],['ua_people_context',people(P,JSON.stringify([P])).text,[P,JSON.stringify([P])]]])test('reset is required before '+name,async t=>{
 const pool=await setup(t),c=await pool.connect();await query(c,'ua_begin','BEGIN');await assert.rejects(query(c,name,text,v),/CONTEXT_RESET_REQUIRED/);await rollback(c);c.release();
});
for(const [label,text,v]of [['session-setting',resetSql.replaceAll(',true)',',false)'),deny],['missing-key',resetSql.replace(",set_config('ua.telegram_id',$6,true)",''),deny],['duplicate-key',resetSql.replace('ua.telegram_id','ua.clerk_subject'),deny],['missing-value',resetSql,deny.slice(0,5)],['extra-value',resetSql,[...deny,'extra']],['stale-person',resetSql,['deny',P,'[]','','','']],['wrong-phase',resetSql,['auth','','[]','','','']],['null-value',resetSql,['deny',null,'[]','','','']]])test('malformed reset rejected: '+label,async t=>{
 const pool=await setup(t),c=await pool.connect();pool.extension=()=>assert.fail('CONTEXT_MUST_NOT_REACH_EXTENSION');await query(c,'ua_begin','BEGIN');await assert.rejects(query(c,'ua_context_reset',text,v),/CONTEXT_/);await assert.rejects(c.query(phase('auth')),/TRANSACTION_ABORTED/);await rollback(c);c.release();
});
test('reset getters are not invoked and a second reset cannot erase transaction authority',async t=>{
 const pool=await setup(t),c=await pool.connect();let gets=0;const v=[...deny];Object.defineProperty(v,'2',{get(){gets++;throw Error('unread');}});await query(c,'ua_begin','BEGIN');await assert.rejects(query(c,'ua_context_reset',resetSql,v),/CONTEXT_VALUES_SHAPE/);assert.equal(gets,0);await rollback(c);
 await query(c,'ua_begin','BEGIN');await resetTrustedServerContext(c);await assert.rejects(query(c,'ua_context_reset',resetSql,deny),/CONTEXT_RESET_ORDER/);await rollback(c);c.release();
});
test('deny phase permits no data reads and rollback still works',async t=>{const{c}=await client(t,{auth:false});await assert.rejects(query(c,'ua_clock','SELECT now'),/CONTEXT_AUTH_REQUIRED/);await rollback(c);});
test('transaction SQL, values and matching end names are strict; a failed transaction accepts only rollback',async t=>{
 const pool=await setup(t),c=await pool.connect();await assert.rejects(query(c,'ua_begin','BEGIN READ ONLY'),/TRANSACTION_SQL/);await assert.rejects(query(c,'ua_begin','BEGIN',['extra']),/CONTEXT_VALUES_SHAPE/);
 await query(c,'ua_begin','BEGIN');await resetTrustedServerContext(c);await setTrustedPhase(c,'auth');await assert.rejects(query(c,'ua_clerk_commit','COMMIT'),/UNHANDLED_STATEMENT/);await assert.rejects(query(c,'ua_clock','SELECT now'),/TRANSACTION_ABORTED/);await rollback(c);
 await query(c,'ua_begin','BEGIN');await assert.rejects(query(c,'ua_begin','BEGIN'),/TRANSACTION_ALREADY_ACTIVE/);await rollback(c);c.release();
});
test('malformed statement getters and unknown properties cannot reach dispatch',async t=>{
 const{c}=await client(t);let gets=0;const q={text:'SELECT now',values:[]};Object.defineProperty(q,'name',{enumerable:true,get(){gets++;throw Error('unread');}});await assert.rejects(c.query(q),/STATEMENT_SHAPE/);assert.equal(gets,0);await rollback(c);
});
for(const next of ['domain','exchange','unexpected'])test('phase transition rejects missing scope: '+next,async t=>{const{c}=await client(t);await assert.rejects(c.query(phase(next)),/CONTEXT_/);await rollback(c);});
for(const [id,ids]of [[Q,JSON.stringify([P])],[P,'[]'],[P,JSON.stringify([P,P])],['',JSON.stringify([Q,P])],[P,JSON.stringify([P+'\n'])],['','not-json']])test('person context rejects mismatched/invalid/noncanonical scope '+ids,async t=>{const{c}=await client(t);await assert.rejects(c.query(people(id,ids)),/CONTEXT_/);await rollback(c);});
test('ordered person locks match context exactly and cannot silently add a participant',async t=>{
 const{c}=await client(t);await setTrustedPeople(c,[P,Q]);const sql='SELECT id::text AS id FROM ua_private.lock_people($1::uuid[]) ORDER BY id';assert.deepEqual((await query(c,'ua_people_lock',sql,[[P,Q]])).rows,[{id:P},{id:Q}]);await assert.rejects(query(c,'ua_people_lock',sql,[[P]]),/CONTEXT_LOCK_SCOPE/);await rollback(c);
});
test('exchange requires a bound Clerk identity and one person; identities cannot be changed in domain',async t=>{
 const{c}=await client(t);await setTrustedPeople(c,[P]);await setTrustedClerk(c,'https://issuer.invalid','user_A');await setTrustedPhase(c,'domain');await assert.rejects(query(c,'ua_clerk_identity_context',"SELECT set_config('ua.clerk_issuer',$1,true),set_config('ua.clerk_subject',$2,true)",['https://issuer.invalid','user_B']),/CONTEXT_AUTH_PHASE/);await rollback(c);
});
test('a person alone cannot enter exchange and multiple people cannot enter domain',async t=>{
 const{c}=await client(t);await setTrustedPeople(c,[P]);await assert.rejects(c.query(phase('exchange')),/CONTEXT_CLERK_IDENTITY/);await rollback(c);
 await query(c,'ua_begin','BEGIN');await resetTrustedServerContext(c);await setTrustedPhase(c,'auth');await setTrustedPeople(c,[P,Q]);await assert.rejects(c.query(phase('domain')),/CONTEXT_SINGLE_PERSON_REQUIRED/);await rollback(c);
});
for(const [issuer,subject]of [['http://issuer.invalid','user_A'],['https://issuer.invalid/path','user_A'],['https://issuer.invalid','user_A\n'],['https://issuer.invalid','sess_Wrong']])test('malformed Clerk context rejected '+JSON.stringify([issuer,subject]),async t=>{
 const{c}=await client(t);await assert.rejects(query(c,'ua_clerk_identity_context',"SELECT set_config('ua.clerk_issuer',$1,true),set_config('ua.clerk_subject',$2,true)",[issuer,subject]),/CONTEXT_CLERK_IDENTITY/);await rollback(c);
});
test('the staff actor override stays within the established person array',async t=>{
 const{c}=await client(t);await setTrustedPeople(c,[P,Q]);const sql="SELECT set_config('ua.person_id',$1,true)";await query(c,'ua_clerk_person_context',sql,[P]);assert.equal(c.context.person_id,P);assert.equal(c.context.person_ids,JSON.stringify([P,Q]));await assert.rejects(query(c,'ua_clerk_person_context',sql,['00000000-0000-4000-8000-000000000099']),/CONTEXT_ACTOR_OUTSIDE_LOCK_SCOPE/);await rollback(c);
});
test('mixed Telegram/Clerk exchange is denied; Telegram value is an exact positive safe integer string',async t=>{
 const{c}=await client(t);await setTrustedPeople(c,[P]);await setTrustedClerk(c,'https://issuer.invalid','user_A');await setTrustedTelegram(c,42);await assert.rejects(c.query(phase('exchange')),/CONTEXT_MIXED_IDENTITY/);await rollback(c);
});
for(const value of ['0','01','-1','42\n','9007199254740992',42])test('malformed Telegram context '+JSON.stringify(value),async t=>{const{c}=await client(t);await assert.rejects(query(c,'ua_telegram_identity_context',"SELECT set_config('ua.telegram_id',$1,true)",[value]),/CONTEXT_TELEGRAM_ID/);await rollback(c);});
test('unexpected SQL remains an error; no extension can bypass malformed context protocol',async t=>{
 const{c}=await client(t);await assert.rejects(query(c,'ua_unknown','SELECT unexpected'),/UNHANDLED_STATEMENT/);await rollback(c);
});
for(const failure of ['before','after'])test('runner preserves commit_unknown and one discard with '+failure+' commit failure',async t=>{
 const pool=await setup(t);pool.failCommit=failure;await assert.rejects(new PostgresTransactions(pool).run([P],async()=>({ok:true})),e=>e.outcome==='commit_unknown');assert.equal(pool.events.filter(x=>x==='ua_commit').length,1);assert.equal(pool.events.filter(x=>x==='ua_rollback').length,0);assert.equal(pool.releasedDiscard,true);
 const c=await pool.connect();await query(c,'ua_begin','BEGIN');await resetTrustedServerContext(c);assert.equal(c.context.person_id,'');await rollback(c);c.release();
});
test('rollback/discard clears transaction state after reset failure and never ACKs active release',async t=>{
 const pool=await setup(t);pool.failStatement='ua_context_reset';await assert.rejects(new PostgresTransactions(pool).run([P],async()=>assert.fail('UNREACHABLE')),/SYNTHETIC_WRITE_FAILURE/);assert.equal(pool.events.filter(x=>x==='ua_rollback').length,1);assert.equal(pool.releasedDiscard,false);
 const c=await pool.connect();await query(c,'ua_begin','BEGIN');assert.throws(()=>c.release(),/ACTIVE_TRANSACTION_RELEASE/);
});

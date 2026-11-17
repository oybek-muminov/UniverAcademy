import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,people,job,lease,issuer,access,receipt,education,families} from './schema-fixture.mjs';
import pg from './tooling/node_modules/pg/lib/index.js';
const url=process.env.UA_SCHEMA_NATIVE_URL;
test('native PostgreSQL concurrent freeze, staff target and recovery fences',{skip:!url},async t=>{
 const db=await fixture(); t.after(()=>db.close());
 const writer=new pg.Client({connectionString:url,application_name:'ua-deletion-race-writer'});
 const staff=new pg.Client({connectionString:url,application_name:'ua-deletion-race-staff'});
 await writer.connect();await staff.connect();t.after(()=>writer.end());t.after(()=>staff.end());
 await db.exec('UPDATE ua_private.account_deletion_control SET accepting=true');
 const prepare=()=>db.query('SELECT * FROM ua_private.prepare_account_deletion($1,$2,$3,$4,$5,$6,$7,$8)',[job,people[0],access,issuer,'user_Test0','sess_Test0',receipt,Date.now()]);
 const waitLocks=async n=>{
  for(let i=0;i<100;i++){
   await db.query('SELECT pg_stat_clear_snapshot()');
   const r=await db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name LIKE 'ua-deletion-race-%' AND wait_event_type='Lock'");
   if(r.rows[0].n>=n)return;await new Promise(r=>setTimeout(r,20));
  }throw Error('expected competing clients to wait on lock');
 };
 await t.test('late profile writer and staff reference wait for freeze, then fail',async()=>{
  await db.exec('BEGIN');await prepare();
  const a=writer.query('UPDATE ua_private.people SET enabled=true WHERE id=$1',[people[0]]).then(()=>({ok:true}),e=>({error:e.message}));
  const b=staff.query("INSERT INTO ua_private.staff_audit VALUES('late',$1,'test',$2,1,$3)",[people[1],people[0],Date.now()]).then(()=>({ok:true}),e=>({error:e.message}));
  try{await waitLocks(2);}finally{await db.exec('COMMIT');}
  assert.match((await a).error,/ACCOUNT_DELETION_PENDING/);
  assert.match((await b).error,/ACCOUNT_DELETION_PENDING/);
 });
 const next='30000000-0000-4000-8000-000000000002';
 await t.test('lease takeover fences old provider completion',async()=>{
  await db.query('SELECT * FROM ua_private.claim_account_deletion($1,$2)',[job,lease]);
  await db.query('UPDATE ua_private.account_deletion_jobs SET lease_until_ms=1 WHERE id=$1',[job]);
  assert.equal((await db.query('SELECT * FROM ua_private.claim_account_deletion($1,$2)',[job,next])).rows.length,1);
  assert.equal((await writer.query('SELECT ua_private.mark_account_provider_deleted($1,$2) ok',[job,lease])).rows[0].ok,false);
  assert.equal((await db.query('SELECT ua_private.mark_account_provider_deleted($1,$2) ok',[job,next])).rows[0].ok,true);
 });
 await t.test('finish waits behind prepare retry without inverse job lock',async()=>{
  await db.exec('BEGIN');await prepare();
  await writer.query('BEGIN');
  const finishing=writer.query('SELECT ua_private.finish_account_deletion($1,$2) ok',[job,next]);
  try{await waitLocks(1);}finally{await db.exec('COMMIT');}
  assert.equal((await finishing).rows[0].ok,true);
  // Attempt/family rows are deleted but not committed. A delayed indirect child
  // writer must not resurrect data when the ownership lookup races finalization.
  const child=staff.query('INSERT INTO ua_private.answers VALUES($1,$2,NULL,1,$3,1)',[education.attempts[0],job,Date.now()])
   .then(()=>({ok:true}),e=>({error:e.message,code:e.code}));
  try{await waitLocks(1);}finally{await writer.query('COMMIT');}
  const failure=await child;assert.ok(failure.error);assert.ok(['42501','23503'].includes(failure.code),failure.error);
  await assert.rejects(()=>staff.query('INSERT INTO ua_private.answers VALUES($1,$2,NULL,1,$3,1)',[education.attempts[0],job,Date.now()]),e=>e.code==='23503');
  await assert.rejects(()=>staff.query("INSERT INTO ua_private.student_refresh VALUES($1,$2,false)",['9'.repeat(64),families[0]]),e=>e.code==='23503');
  assert.equal((await db.query('SELECT count(*)::int n FROM ua_private.people WHERE id=$1',[people[0]])).rows[0].n,0);
 });
});

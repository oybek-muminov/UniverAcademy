import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,people,families,job,lease,issuer,access,receipt,education,ownedTables,sharedTables} from './schema-fixture.mjs';
const prep=(db,subject='user_Test0',time=Date.now())=>db.query('SELECT * FROM ua_private.prepare_account_deletion($1,$2,$3,$4,$5,$6,$7,$8)',[job,people[0],access,issuer,subject,'sess_Test0',receipt,time]);
async function as(db,role,fn){await db.exec('SET ROLE '+role);try{return await fn()}finally{await db.exec('RESET ROLE')}}
test('isolated PostgreSQL lifecycle, exact role separation, ownership and replay barriers',async t=>{
 const db=await fixture(); t.after(()=>db.close());
 const preserved=new Map();
 for(const table of [...ownedTables,...sharedTables]){
  const rows=(await db.query('SELECT * FROM ua_private.'+table)).rows;
  preserved.set(table,sharedTables.includes(table)?rows:rows.filter(row=>[people[1],families[1],education.attempts[1]].some(id=>JSON.stringify(row).includes(id))));
  if(ownedTables.includes(table))assert.equal(preserved.get(table).length,1,table+' has other student fixture');
 }
 await t.test('default off: no freeze or job before activation',async()=>{
  await assert.rejects(()=>as(db,'ua_request',()=>prep(db)),/DELETION_REJECTED/);
  assert.equal((await db.query('SELECT count(*)::int n FROM ua_private.account_deletion_jobs')).rows[0].n,0);
  await db.exec('UPDATE ua_private.account_deletion_control SET accepting=true');
 });
 await t.test('wrong Clerk and stale verification denied without mutation',async()=>{
  await assert.rejects(()=>as(db,'ua_request',()=>prep(db,'user_Test1')),/DELETION_REJECTED/);
  await assert.rejects(()=>as(db,'ua_request',()=>prep(db,'user_Test0',Date.now()-301000)),/DELETION_REJECTED/);
  assert.equal((await db.query('SELECT enabled FROM ua_private.people WHERE id=$1',[people[0]])).rows[0].enabled,true);
 });
 await t.test('request cannot list jobs, claim or directly delete person',async()=>{
  await assert.rejects(()=>as(db,'ua_request',()=>db.query('SELECT * FROM ua_private.account_deletion_jobs')),/permission denied/);
  await assert.rejects(()=>as(db,'ua_request',()=>db.query('SELECT * FROM ua_private.claim_account_deletion($1,$2)',[job,lease])),/permission denied/);
  await assert.rejects(()=>as(db,'ua_request',()=>db.query('DELETE FROM ua_private.people')),/permission denied/);
 });
 await t.test('ordinary writer requires explicit helper ACL and can write before freeze',async()=>{
  await db.exec("CREATE ROLE ua_fixture_writer NOLOGIN; GRANT USAGE ON SCHEMA ua_private TO ua_fixture_writer; GRANT SELECT,UPDATE ON ua_private.people TO ua_fixture_writer; CREATE POLICY fixture_writer ON ua_private.people TO ua_fixture_writer USING(true) WITH CHECK(true)");
  await assert.rejects(()=>as(db,'ua_fixture_writer',()=>db.query('UPDATE ua_private.people SET enabled=true WHERE id=$1',[people[0]])),/permission denied for function assert_deletion_writable/);
  await db.exec('GRANT EXECUTE ON FUNCTION ua_private.assert_deletion_writable(text,jsonb) TO ua_fixture_writer');
  await as(db,'ua_fixture_writer',()=>db.query('UPDATE ua_private.people SET enabled=true WHERE id=$1',[people[0]]));
 });
 await t.test('staff references reject prepare; unrelated audit remains writable',async()=>{
  await db.exec("BEGIN");
  await db.query("INSERT INTO ua_private.staff_receipts VALUES($1,'guard-own','payload','{}')",[people[1]]);
  await db.query("INSERT INTO ua_private.staff_audit VALUES('guard-own',$1,'test',$2,1,$3)",[people[1],people[0],Date.now()]);
  await db.exec('COMMIT');
  await assert.rejects(()=>as(db,'ua_request',()=>prep(db)),/DELETION_REJECTED/);
  await db.exec("BEGIN; DELETE FROM ua_private.staff_audit WHERE command_key='guard-own'; DELETE FROM ua_private.staff_receipts WHERE key='guard-own'; COMMIT; BEGIN");
  await db.query("INSERT INTO ua_private.staff_receipts VALUES($1,'guard-other','payload','{}')",[people[1]]);
  await db.query("INSERT INTO ua_private.staff_audit VALUES('guard-other',$1,'test',$1,1,$2)",[people[1],Date.now()]);
  await db.exec("COMMIT");
 });
 await t.test('accepted request freezes same profile before external deletion',async()=>{
  assert.equal((await as(db,'ua_request',()=>prep(db))).rows[0].state,'pending');
  assert.equal((await db.query('SELECT enabled FROM ua_private.people WHERE id=$1',[people[0]])).rows[0].enabled,false);
  assert.equal((await db.query('SELECT enabled FROM ua_private.people WHERE id=$1',[people[1]])).rows[0].enabled,true);
  assert.ok((await db.query('SELECT revoked_at_ms FROM ua_private.student_families WHERE id=$1',[families[0]])).rows[0].revoked_at_ms);
  assert.equal((await as(db,'ua_request',()=>prep(db))).rows[0].state,'pending');
 });
 await t.test('pending deletion rejects stale writes and fresh sessions',async()=>{
  await assert.rejects(()=>as(db,'ua_fixture_writer',()=>db.query('UPDATE ua_private.people SET enabled=true WHERE id=$1',[people[0]])),/ACCOUNT_DELETION_PENDING/);
  await assert.rejects(()=>db.query('UPDATE ua_private.memberships SET active=true WHERE person_id=$1',[people[0]]),/ACCOUNT_DELETION_PENDING/);
  await assert.rejects(()=>db.query("INSERT INTO ua_private.student_families VALUES($1,$2,$3,NULL,NULL,'clerk')",[job,people[0],Date.now()+60000]),/ACCOUNT_DELETION_PENDING/);
  await assert.rejects(()=>db.query('UPDATE ua_private.student_access SET superseded=false WHERE digest=$1',[access]),/ACCOUNT_DELETION_PENDING/);
  await assert.rejects(()=>db.query('INSERT INTO ua_private.init_data_replays VALUES($1,$2,$3)',['3'.repeat(64),people[0],Date.now()]),/ACCOUNT_DELETION_PENDING/);
 });
 await t.test('late staff actor/target references and retargeting are frozen',async()=>{
  await assert.rejects(()=>db.query("INSERT INTO ua_private.staff_audit VALUES('late-target',$1,'test',$2,1,$3)",[people[1],people[0],Date.now()]),/ACCOUNT_DELETION_PENDING/);
  await assert.rejects(()=>db.query("INSERT INTO ua_private.staff_audit VALUES('late-actor',$1,'test',$2,1,$3)",[people[0],people[1],Date.now()]),/ACCOUNT_DELETION_PENDING/);
  await assert.rejects(()=>db.query("UPDATE ua_private.staff_audit SET target_id=$1 WHERE command_key='guard-other'",[people[0]]),/ACCOUNT_DELETION_PENDING/);
  await assert.rejects(()=>db.query("UPDATE ua_private.staff_audit SET actor_id=$1 WHERE command_key='guard-other'",[people[0]]),/ACCOUNT_DELETION_PENDING/);
  await assert.rejects(()=>db.query("INSERT INTO ua_private.staff_receipts VALUES($1,'late','payload','{}')",[people[0]]),/ACCOUNT_DELETION_PENDING/);
  await assert.rejects(()=>db.query("UPDATE ua_private.staff_receipts SET actor_id=$1 WHERE key='guard-other'",[people[0]]),/ACCOUNT_DELETION_PENDING/);
  await db.exec("UPDATE ua_private.staff_audit SET revision=2 WHERE command_key='guard-other'");
  await assert.rejects(()=>db.query('SELECT ua_private.assert_deletion_staff_writable($1::jsonb,$2::jsonb)',[JSON.stringify({actor_id:people[1],target_id:people[0]}),JSON.stringify({actor_id:people[1],target_id:people[1]})]),/ACCOUNT_DELETION_PENDING/);
  await assert.rejects(()=>db.query('SELECT ua_private.assert_deletion_staff_writable($1::jsonb,NULL)',[JSON.stringify({actor_id:people[0]})]),/ACCOUNT_DELETION_PENDING/);
 });
 await t.test('recovery cannot submit; single lease and stale completion denied',async()=>{
  await assert.rejects(()=>as(db,'ua_recovery',()=>prep(db)),/permission denied/);
  const r=await as(db,'ua_recovery',()=>db.query('SELECT * FROM ua_private.claim_account_deletion($1,$2)',[job,lease]));
  assert.equal(r.rows[0].subject,'user_Test0');
  assert.equal((await as(db,'ua_recovery',()=>db.query('SELECT * FROM ua_private.claim_account_deletion($1,$2)',[job,lease]))).rows.length,0);
  assert.equal((await as(db,'ua_recovery',()=>db.query('SELECT ua_private.finish_account_deletion($1,$2) ok',[job,lease]))).rows[0].ok,false);
  assert.equal((await as(db,'ua_recovery',()=>db.query('SELECT ua_private.mark_account_provider_deleted($1,$2) ok',[job,families[1]]))).rows[0].ok,false);
 });
 await t.test('confirmed provider completion deletes only accepted profile and releases Telegram',async()=>{
  await as(db,'ua_recovery',()=>db.query('SELECT ua_private.mark_account_provider_deleted($1,$2)',[job,lease]));
  assert.equal((await as(db,'ua_recovery',()=>db.query('SELECT ua_private.finish_account_deletion($1,$2) ok',[job,lease]))).rows[0].ok,true);
  for(const table of [...ownedTables,...sharedTables]){
   assert.deepEqual((await db.query('SELECT * FROM ua_private.'+table)).rows,preserved.get(table),table+' deletes only requested graph and preserves shared/other data byte-for-byte');
  }
  assert.equal((await db.query('SELECT count(*)::int n FROM ua_private.people')).rows[0].n,1);
  assert.equal((await as(db,'ua_request',()=>db.query('SELECT * FROM ua_private.account_deletion_status($1)',[receipt]))).rows[0].state,'completed');
  assert.equal((await db.query('SELECT count(*)::int n FROM ua_private.groups')).rows[0].n,1);
  await assert.rejects(()=>db.query('INSERT INTO ua_private.init_data_replays VALUES($1,$2,$3)',['1'.repeat(64),people[1],Date.now()]),/DELETED_PROOF_REPLAY/);
  await assert.rejects(()=>db.query('INSERT INTO ua_private.clerk_exchange_replays VALUES($1,$2,$3)',['2'.repeat(64),people[1],Date.now()]),/DELETED_PROOF_REPLAY/);
  await db.exec('BEGIN');
  await db.query('INSERT INTO ua_private.people VALUES($1,100,\'0000000009\',true,ARRAY[\'student\'],\'{}\')',[job]);
  await db.query('INSERT INTO ua_private.memberships VALUES($1,NULL,false,0,0)',[job]);
  await db.query('INSERT INTO ua_private.clerk_identities VALUES($1,\'user_New\',$2,true)',[issuer,job]);
  await db.exec('COMMIT');
  await assert.rejects(()=>db.query('INSERT INTO ua_private.clerk_identities VALUES($1,\'user_Test0\',$2,true)',[issuer,job]),/DELETED_CLERK_SUBJECT/);
 });
 await t.test('expired completed receipt is unknown, never fabricated completed',async()=>{
  await db.exec('UPDATE ua_private.account_deletion_jobs SET completed_at_ms=1');
  assert.equal((await as(db,'ua_request',()=>db.query('SELECT * FROM ua_private.account_deletion_status($1)',[receipt]))).rows.length,0);
 });
});

import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createCluster, addProfile } from '../../../tests/teacher-staging-pilot/cluster.mjs';
import { switchPhase, backfill } from '../cabinet-id/migrate.mjs';
import { renderManagedCabinet } from '../teacher-staging/managed.mjs';

const read = name => readFile(new URL(name, import.meta.url), 'utf8');
test('managed teacher notices preserve recipient binding, deduplication, ACLs and cleanup', async t => {
  const cluster=await createCluster(), db=cluster.admin;
  t.after(()=>cluster.close());
  const q=async(sql,args=[]) => (await db.query(sql,args)).rows;
  const first=async(sql,args=[]) => (await q(sql,args))[0];
  await db.query("SET statement_timeout='8s'");
  await cluster.installDeletion();
  await switchPhase(db,'forward'); await backfill(db);
  await q(`ALTER VIEW ua_private.people_registration OWNER TO ua_owner;
    ALTER FUNCTION ua_private.normalize_cabinet_profile() OWNER TO ua_owner;
    CREATE ROLE managed_operator NOLOGIN CREATEROLE BYPASSRLS NOSUPERUSER NOINHERIT;
    GRANT pg_read_all_data TO managed_operator WITH INHERIT TRUE,SET FALSE;
    GRANT ua_owner,ua_deletion_executor,ua_api_login TO managed_operator WITH ADMIN TRUE,INHERIT FALSE,SET FALSE;
    ALTER DATABASE postgres OWNER TO managed_operator;
    ALTER DEFAULT PRIVILEGES FOR ROLE ua_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS`);
  await q('SET SESSION AUTHORIZATION managed_operator');
  await db.query(await renderManagedCabinet('up'));
  await q('RESET SESSION AUTHORIZATION');
  const p=async name=>addProfile(db,{name,role:'teacher',telegramId:null});
  const access=(id,approved=true)=>q(`INSERT INTO ua_private.staff_access(person_id,approved,manage_roster,manage_content,all_groups,all_subjects)
    VALUES($1,$2,false,false,false,false) ON CONFLICT(person_id) DO UPDATE SET approved=excluded.approved`,[id,approved]);
  const grant=(id,subject='physics')=>q(`INSERT INTO ua_private.teacher_subject_approvals(person_id,subject_id,approved)
    VALUES($1,$2,true) ON CONFLICT(person_id,subject_id) DO UPDATE SET approved=true,revoked_at_ms=NULL`,[id,subject]);
  const teacher=await p('Ustoz'), pending=await p('Yangi'), spare=await p('Boshqa');
  await access(teacher); await grant(teacher); await grant(teacher,'math');
  await access(pending,false); await grant(pending);
  await q('UPDATE ua_private.people SET telegram_id=7000017 WHERE id=$1',[teacher]);
  await q('SET SESSION AUTHORIZATION managed_operator');
  const acl=()=>q(`SELECT roleid,member,grantor,admin_option,inherit_option,set_option FROM pg_auth_members WHERE
     roleid='ua_owner'::regrole ORDER BY roleid,member,grantor`);
  const baseline=await acl(), up=await read('001_teacher_notifications.sql');
  await assert.rejects(db.query(up.replace('COMMIT;',()=>"DO $$ BEGIN RAISE EXCEPTION 'rollback probe'; END $$; COMMIT;")),/rollback probe/);
  await q('ROLLBACK'); assert.deepEqual(await acl(),baseline);
  assert.equal((await first("SELECT to_regclass('ua_cabinet.teacher_notifications') AS name")).name,null);
  await db.query(up);assert.deepEqual(await acl(),baseline);
  await q('RESET SESSION AUTHORIZATION');
  const n='ua_cabinet.teacher_notifications';
  assert.deepEqual(await first('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',[n]),{relrowsecurity:true,relforcerowsecurity:false});
  assert.deepEqual(await q('SELECT polcmd FROM pg_policy WHERE polrelid=$1::regclass ORDER BY polcmd',[n]),[{polcmd:'r'},{polcmd:'w'}]);
  const row=async id=>first('SELECT * FROM '+n+' WHERE person_id=$1',[id]);
  assert.deepEqual((await q('SELECT person_id,state FROM '+n)),[{person_id:teacher,state:'queued'}]);
  await access(pending);assert.equal((await row(pending)).state,'queued');
  await access(spare);assert.equal(await row(spare),undefined);
  await grant(spare);await grant(spare);await grant(spare,'math');assert.ok(await row(spare));
  const removePerson=async id=>{
    await q('BEGIN');
    for(const table of ['teacher_subject_approvals','staff_access','memberships']) await q('DELETE FROM ua_private.'+table+' WHERE person_id=$1',[id]);
    await q('DELETE FROM ua_private.people WHERE id=$1',[id]);
    await q('COMMIT');
  };
  await removePerson(spare);
  assert.equal((await first('SELECT count(*) n FROM '+n+' WHERE person_id IS NULL')).n,'0');
  for (const role of ['anon','authenticated','service_role','ua_api_login','ua_cabinet_stage']) {
    const rights=await first(`SELECT has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE') any,
      has_table_privilege($1,$2,'DELETE') del,has_function_privilege($1,'ua_cabinet.wake_teacher_notification(bigint)','EXECUTE') wake`,[role,n]);
    assert.deepEqual(rights,{any:false,del:false,wake:false});
  }
  await q('SET ROLE ua_cabinet_delivery');
  await assert.rejects(q('INSERT INTO '+n+'(person_id) VALUES ($1)',[randomUUID()]),/permission denied/);
  assert.equal((await first("SELECT has_column_privilege(current_user,$1,'person_id','UPDATE') target",[n])).target,false);
  const out=(await row(teacher)).id;
  const send=async()=>q('UPDATE '+n+" SET state='sending',claim_id=gen_random_uuid(),claimed_at=now(),chat_id=7000017 WHERE id=$1",[out]);
  await send();
  await q('UPDATE '+n+" SET state='blocked',claim_id=NULL,claimed_at=NULL,chat_id=NULL,blocked_at=now() WHERE id=$1",[out]);
  await q('SELECT ua_cabinet.wake_teacher_notification(7000017)');assert.equal((await row(teacher)).state,'blocked');
  await q('INSERT INTO ua_cabinet.private_starts(telegram_id) VALUES(7000017)');
  await q('SELECT ua_cabinet.wake_teacher_notification(7000099)');assert.equal((await row(teacher)).state,'blocked');
  await q('SELECT ua_cabinet.wake_teacher_notification(7000017)');assert.equal((await row(teacher)).state,'queued');
  await send();
  await assert.rejects(q('UPDATE '+n+' SET chat_id=123 WHERE id=$1',[out]),/receipt transition/);
  await q('UPDATE '+n+" SET state='blocked',claim_id=NULL,claimed_at=NULL,chat_id=NULL,blocked_at=now() WHERE id=$1",[out]);
  await q('INSERT INTO ua_cabinet.private_starts(telegram_id) VALUES(7000017) ON CONFLICT DO NOTHING');
  await q('SELECT ua_cabinet.wake_teacher_notification(7000017)');
  assert.equal((await row(teacher)).state,'queued');
  await send();
  await q('RESET ROLE');
  await q('UPDATE ua_private.people SET telegram_id=NULL WHERE id=$1',[teacher]);
  await removePerson(teacher);
  await q('SET ROLE ua_cabinet_delivery');
  assert.deepEqual(await first('SELECT person_id,chat_id,state FROM '+n+' WHERE id=$1',[out]),{person_id:null,chat_id:'7000017',state:'sending'});
  await q('UPDATE '+n+` SET state='sent',claim_id=NULL,claimed_at=NULL,message_id=42,sent_at=now(),
    delete_after=now()+interval '24 hours',delete_until=now()+interval '48 hours' WHERE id=$1`,[out]);
  await assert.rejects(q('UPDATE '+n+' SET chat_id=123456 WHERE id=$1',[out]),/receipt transition/);
  await q('UPDATE '+n+" SET state='deleting',claim_id=gen_random_uuid(),claimed_at=now() WHERE id=$1",[out]);
  await q('UPDATE '+n+" SET state='delete_retry',claim_id=NULL,claimed_at=NULL,available_at=now() WHERE id=$1",[out]);
  await q('UPDATE '+n+" SET state='deleting',claim_id=gen_random_uuid(),claimed_at=now() WHERE id=$1",[out]);
  assert.equal((await q('UPDATE '+n+` SET state='deleted',claim_id=NULL,claimed_at=NULL,chat_id=NULL,message_id=NULL,
    sent_at=NULL,delete_after=NULL,delete_until=NULL WHERE id=$1 RETURNING id`,[out])).length,1);
  assert.equal((await q('SELECT FROM '+n+' WHERE id=$1',[out])).length,0);
  await q('RESET ROLE');
  const concurrent=await p('Parallel');
  const other=new pg.Client({connectionString:cluster.adminUrl});await other.connect();
  try {
    await other.query("SET statement_timeout='8s'");
    await other.query('BEGIN');
    await other.query("INSERT INTO ua_private.teacher_subject_approvals(person_id,subject_id,approved) VALUES($1,'physics',true)",[concurrent]);
    const grantingAccess=access(concurrent);
    await other.query('COMMIT');
    await grantingAccess;
  } finally {await other.end();}
  assert.equal((await row(concurrent)).state,'queued');
  await q('UPDATE '+n+" SET state='sending',claim_id=gen_random_uuid(),claimed_at=now(),chat_id=7000033 WHERE person_id=$1",[concurrent]);
  await q('SET SESSION AUTHORIZATION managed_operator');
  const withdraw=await read('001_withdraw.sql');
  await assert.rejects(db.query(withdraw),/Drain in-flight sends/);await q('ROLLBACK');assert.deepEqual(await acl(),baseline);
  await q('RESET SESSION AUTHORIZATION');
  await q('UPDATE '+n+" SET state='unconfirmed',chat_id=NULL,claim_id=NULL,claimed_at=NULL WHERE person_id=$1",[concurrent]);
  await grant(concurrent);assert.equal((await row(concurrent)).state,'unconfirmed');
  await q('SET SESSION AUTHORIZATION managed_operator');
  await db.query(withdraw);assert.deepEqual(await acl(),baseline);
  assert.deepEqual(await first("SELECT to_regclass('ua_cabinet.teacher_notifications') active, has_any_column_privilege('ua_cabinet_delivery','ua_private.teacher_notifications_v1_retained','SELECT,UPDATE') writer"),{active:null,writer:false});
  await db.query(await renderManagedCabinet('down'));await db.query(await renderManagedCabinet('restore'));
  await db.query(up);assert.deepEqual(await acl(),baseline);
  await q('RESET SESSION AUTHORIZATION');
  assert.equal((await row(concurrent)).state,'unconfirmed');
  assert.equal((await row(pending)).state,'queued');
});

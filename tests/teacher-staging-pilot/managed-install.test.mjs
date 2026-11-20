import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import {createCluster} from './cluster.mjs';
import {switchPhase,backfill} from '../../supabase/migrations/cabinet-id/migrate.mjs';
import {renderManagedCabinet} from '../../supabase/migrations/teacher-staging/managed.mjs';

test('managed PG17 operator installs, withdraws and restores with its original owner and database grants',async t=>{
  const cluster=await createCluster(),db=cluster.admin;
  t.after(()=>cluster.close());
  await cluster.installDeletion();
  await switchPhase(db,'forward');
  await backfill(db);
  await db.query(`ALTER VIEW ua_private.people_registration OWNER TO ua_owner;
    ALTER FUNCTION ua_private.normalize_cabinet_profile() OWNER TO ua_owner;
    CREATE ROLE managed_operator NOLOGIN CREATEROLE BYPASSRLS NOSUPERUSER NOINHERIT;
    GRANT pg_read_all_data TO managed_operator WITH INHERIT TRUE,SET FALSE;
    GRANT ua_owner,ua_deletion_executor,ua_api_login TO managed_operator WITH ADMIN TRUE,INHERIT FALSE,SET FALSE;
    ALTER DATABASE postgres OWNER TO managed_operator;
    ALTER DEFAULT PRIVILEGES FOR ROLE ua_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`);
  await db.query('SET SESSION AUTHORIZATION managed_operator');
  const first=async sql=>(await db.query(sql)).rows[0];
  const originalGrants=()=>first(`SELECT
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.grantor,a.grantee,a.privilege_type)
      FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a WHERE datname=current_database()) AS database,
    (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.roleid,m.member,m.grantor)
      FROM pg_auth_members m WHERE m.roleid IN('ua_owner'::regrole,'ua_deletion_executor'::regrole)) AS memberships`);
  const before=await originalGrants();
  assert.deepEqual(await first(`SELECT pg_has_role(current_user,'ua_owner','SET') AS can_set,
    has_table_privilege('ua_private.people','REFERENCES') AS can_reference,has_table_privilege('ua_private.people','TRIGGER') AS can_trigger`),
    {can_set:false,can_reference:false,can_trigger:false});
  const raw=await readFile(new URL('../../supabase/migrations/teacher-staging/up.sql',import.meta.url),'utf8');
  await assert.rejects(db.query(raw),e=>e.code==='42501');
  await db.query('ROLLBACK');
  const clean=()=>first(`SELECT to_regnamespace('ua_cabinet') AS storage,to_regrole('ua_cabinet_stage') AS stage,to_regrole('ua_cabinet_delivery') AS bot`);
  const baseline={storage:null,stage:null,bot:null};
  assert.deepEqual(await clean(),baseline);
  const up=await renderManagedCabinet('up');
  await assert.rejects(db.query(up.replace('END $verify$;', "RAISE EXCEPTION 'test rollback'; END $verify$;")),/test rollback/);
  await db.query('ROLLBACK');
  assert.deepEqual(await clean(),baseline);
  assert.deepEqual(await originalGrants(),before);
  await db.query(up);
  assert.deepEqual(await originalGrants(),before);
  await assert.rejects(db.query(up),/clean first installation/);
  await db.query('ROLLBACK');
  await db.query(`CREATE ROLE cabinet_api_probe NOLOGIN NOINHERIT; CREATE ROLE cabinet_bot_probe NOLOGIN NOINHERIT;
    GRANT ua_api_login TO cabinet_api_probe WITH INHERIT TRUE,SET FALSE;
    GRANT ua_cabinet_stage TO cabinet_api_probe WITH INHERIT FALSE,SET TRUE;
    GRANT ua_cabinet_delivery TO cabinet_bot_probe WITH INHERIT FALSE,SET TRUE;`);
  assert.deepEqual(await first(`SELECT pg_has_role('cabinet_api_probe','ua_api_login','USAGE') auth,
    pg_has_role('cabinet_api_probe','ua_cabinet_stage','SET') stage,pg_has_role('cabinet_api_probe','ua_cabinet_stage','USAGE') inherited,
    pg_has_role('cabinet_bot_probe','ua_cabinet_stage','MEMBER') bot_has_api`),
    {auth:true,stage:true,inherited:false,bot_has_api:false});
  const edit=async direction=>db.query(await readFile(new URL('../../supabase/migrations/teacher-staging/draft-edit/001_'+direction+'.sql',import.meta.url),'utf8'));
  const editAccess=()=>first(`SELECT has_table_privilege('ua_cabinet_stage','ua_private.draft_questions','DELETE') questions,
    has_column_privilege('ua_cabinet_stage','ua_private.demos','title','UPDATE') title,
    has_column_privilege('ua_cabinet_stage','ua_private.demos','subject_id','UPDATE') subject,
    has_table_privilege('ua_cabinet_delivery','ua_private.draft_questions','DELETE') bot,
    has_column_privilege('authenticated','ua_private.demos','title','UPDATE') client`);
  const closed={questions:false,title:false,subject:false,bot:false,client:false};
  assert.deepEqual(await editAccess(),closed);
  await edit('up');
  assert.deepEqual(await editAccess(),{...closed,questions:true,title:true});
  assert.deepEqual(await originalGrants(),before);
  await edit('down');
  assert.deepEqual(await editAccess(),closed);
  assert.deepEqual(await originalGrants(),before);
  await db.query('RESET SESSION AUTHORIZATION');
  await db.query('INSERT INTO ua_cabinet.private_starts(telegram_id) VALUES(1000017)');
  await db.query('SET SESSION AUTHORIZATION managed_operator');
  await db.query(await renderManagedCabinet('down'));
  assert.deepEqual(await originalGrants(),before);
  assert.equal((await first("SELECT has_schema_privilege('ua_cabinet_stage','ua_cabinet_retained','USAGE') AS ok")).ok,false);
  await db.query(await renderManagedCabinet('restore'));
  assert.deepEqual(await originalGrants(),before);
  assert.equal((await first('SELECT count(*) AS n FROM ua_cabinet.private_starts')).n,'1');
  await edit('up');
  assert.deepEqual(await editAccess(),{...closed,questions:true,title:true});
  assert.deepEqual(await originalGrants(),before);
});

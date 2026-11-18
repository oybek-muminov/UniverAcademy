-- REVIEW CANDIDATE ONLY. NOT AUTHORIZATION TO EXECUTE.
-- Separate guarded rollout after the staged managed installation.
-- Choose one out-of-band mode: ua.deletion_guard_change = 'enable-guards'
-- or 'disable-empty-guards'. Neither mode ever enables accepting.
-- This changes 31 trigger states on 25 real tables and therefore requires a
-- separately approved quiet maintenance window. NOWAIT rejects busy tables.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path=pg_catalog;
DO $preflight$ BEGIN
 IF current_setting('ua.deletion_guard_change',true) IS NULL OR current_setting('ua.deletion_guard_change',true) NOT IN('enable-guards','disable-empty-guards') THEN
  RAISE EXCEPTION 'GUARD_CHANGE_NOT_ARMED';
 END IF;
 IF current_user<>session_user OR current_user<>'postgres' OR current_database()<>'postgres'
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND NOT rolsuper AND rolcreaterole AND rolbypassrls)
  OR has_schema_privilege(current_user,'ua_private','CREATE')
  OR (SELECT count(*) FROM pg_auth_members WHERE roleid='ua_owner'::regrole OR member='ua_owner'::regrole)<>1
  OR NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='ua_owner'::regrole AND member=current_user::regrole
   AND grantor=10 AND admin_option AND NOT inherit_option AND NOT set_option) THEN
  RAISE EXCEPTION 'UNEXPECTED_GUARD_OPERATOR';
 END IF;
END $preflight$;
GRANT ua_owner TO CURRENT_USER WITH ADMIN FALSE, INHERIT TRUE, SET TRUE GRANTED BY CURRENT_USER;
DO $guard_change$
DECLARE tables text[]:=ARRAY['people','memberships','clerk_identities','clerk_student_sessions',
 'clerk_family_bindings','student_families','student_access','student_refresh','init_data_replays',
 'clerk_exchange_replays','answers','ordinary_results','attempt_cancellations','command_receipts',
 'statistical_bonuses','attempts','exam_series','grants','staff_access','staff_identities',
 'staff_group_scope','staff_subject_scope','teacher_subject_approvals','staff_audit','staff_receipts'];
 mode text:=current_setting('ua.deletion_guard_change'); wanted "char"; prior "char";
 table_name text; lock_list text; row record; actor record; privileges_ok boolean;
BEGIN
 wanted:=CASE WHEN mode='enable-guards' THEN 'O'::"char" ELSE 'D'::"char" END;
 prior:=CASE WHEN mode='enable-guards' THEN 'D'::"char" ELSE 'O'::"char" END;
 -- Freeze the writer surface and acceptance/queue/tombstone state together.
 -- No synthetic write is used to probe permissions. Busy => rollback, not retry.
 SELECT string_agg(format('ua_private.%I',v),',' ORDER BY v) INTO lock_list FROM unnest(tables||ARRAY[
  'account_deletion_control','account_deletion_jobs','deleted_clerk_subjects','deleted_proof_digests']) v;
 EXECUTE 'LOCK TABLE '||lock_list||' IN ACCESS EXCLUSIVE MODE NOWAIT';
 IF (SELECT count(*) FROM ua_private.account_deletion_control)<>1
  OR EXISTS(SELECT 1 FROM ua_private.account_deletion_control WHERE accepting OR guards_active<>(mode='disable-empty-guards'))
  OR EXISTS(SELECT 1 FROM ua_private.account_deletion_jobs)
  OR EXISTS(SELECT 1 FROM ua_private.deleted_clerk_subjects)
  OR EXISTS(SELECT 1 FROM ua_private.deleted_proof_digests) THEN
  RAISE EXCEPTION 'GUARD_CHANGE_REQUIRES_NO_HISTORY_AND_ACCEPTANCE_OFF';
 END IF;
 -- Pin the five callable guard bodies and their security semantics to the
 -- reviewed local source. No server-side function is invoked to verify this.
 -- prosrc hashes cover exact text between the CREATE FUNCTION dollar quotes.
 FOR row IN SELECT * FROM (VALUES
  ('ua_private.deletion_write_barrier()','b183fcc79ee20d213d535e7b7b6b17ab',false),
  ('ua_private.deletion_identity_barrier()','ecb64719e57e4e566e8b8bc81b8eb05f',true),
  ('ua_private.deletion_proof_barrier()','4d944aebd74db8c166d0078ef7c59f9b',true),
  ('ua_private.assert_deletion_writable(text,jsonb)','6cb6b329c9e6f92278b49e6a62f9a5ad',true),
  ('ua_private.assert_deletion_staff_writable(jsonb,jsonb)','1a0ff35872701c525e57c21421a0bf12',true)) x(signature,source_md5,definer) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure(row.signature) AND p.proowner='ua_deletion_executor'::regrole
    AND l.lanname='plpgsql' AND md5(p.prosrc)=row.source_md5 AND p.prosecdef=row.definer
    AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, ua_private']::text[]
    AND p.provolatile='v' AND p.proparallel='u' AND NOT p.proisstrict AND NOT p.proleakproof
    AND p.prokind='f' AND NOT p.proretset AND p.pronargdefaults=0 AND p.provariadic=0
    AND p.prorettype=CASE WHEN p.proname IN('assert_deletion_writable','assert_deletion_staff_writable')
     THEN 'void'::regtype ELSE 'trigger'::regtype END) THEN
   RAISE EXCEPTION 'GUARD_FUNCTION_FINGERPRINT_DRIFT: %',row.signature;
  END IF;
 END LOOP;
 -- Exact 25 freeze barriers plus six identity/proof barriers. Unknown or changed
 -- attachment/owner/state is a re-review condition, not a reason to blanket-enable.
 FOREACH table_name IN ARRAY tables LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('ua_private.'||quote_ident(table_name))
    AND t.tgname='deletion_write_barrier' AND t.tgfoid='ua_private.deletion_write_barrier()'::regprocedure
    AND NOT t.tgisinternal AND t.tgenabled=prior
    AND t.tgtype=31 AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgargs=decode('','hex')
    AND cardinality(t.tgattr::smallint[])=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgconstraint=0) THEN
   RAISE EXCEPTION 'UNEXPECTED_WRITE_BARRIER: %',table_name;
  END IF;
 END LOOP;
 FOR row IN SELECT * FROM (VALUES
  ('clerk_identities','deletion_identity_barrier','ua_private.deletion_identity_barrier()',23,ARRAY['issuer','subject'],decode('','hex'),0),
  ('clerk_identities','deletion_identity_after','ua_private.deletion_identity_barrier()',21,ARRAY['issuer','subject'],decode('','hex'),0),
  ('init_data_replays','deletion_telegram_proof','ua_private.deletion_proof_barrier()',23,ARRAY['digest'],decode('74656c656772616d00','hex'),1),
  ('init_data_replays','deletion_telegram_after','ua_private.deletion_proof_barrier()',21,ARRAY['digest'],decode('74656c656772616d00','hex'),1),
  ('clerk_exchange_replays','deletion_clerk_proof','ua_private.deletion_proof_barrier()',23,ARRAY['digest'],decode('636c65726b00','hex'),1),
  ('clerk_exchange_replays','deletion_clerk_after','ua_private.deletion_proof_barrier()',21,ARRAY['digest'],decode('636c65726b00','hex'),1)) x(tbl,trg,func,event_bits,columns,args,nargs) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('ua_private.'||quote_ident(row.tbl))
   AND t.tgname=row.trg AND t.tgfoid=to_regprocedure(row.func) AND t.tgenabled=prior AND NOT t.tgisinternal
   AND t.tgtype=row.event_bits AND t.tgqual IS NULL AND t.tgnargs=row.nargs AND t.tgargs=row.args
   AND ARRAY(SELECT a.attname::text FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY v(attnum,ord)
     JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=v.attnum ORDER BY v.ord)=row.columns
   AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgconstraint=0) THEN
   RAISE EXCEPTION 'UNEXPECTED_IDENTITY_OR_PROOF_BARRIER';
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='ua_private' AND p.proname IN('deletion_write_barrier','deletion_identity_barrier','deletion_proof_barrier'))<>31
  OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='ua_private'
   AND p.proname IN('deletion_write_barrier','deletion_identity_barrier','deletion_proof_barrier','assert_deletion_writable','assert_deletion_staff_writable')
   AND (p.proowner<>'ua_deletion_executor'::regrole OR NOT coalesce('search_path=pg_catalog, ua_private'=ANY(p.proconfig),false))) THEN
  RAISE EXCEPTION 'GUARD_DEFINITION_OR_COUNT_DRIFT';
 END IF;
 IF mode='enable-guards' THEN
  -- Audit effective DML capability, including inherited and column-level rights.
  -- pg_write_all_data is an unassigned builtin capability, not an application
  -- writer. Any non-superuser member of it must be reviewed before activation.
  IF EXISTS(SELECT 1 FROM pg_roles r WHERE NOT r.rolsuper AND r.rolname<>'pg_write_all_data'
    AND pg_has_role(r.oid,'pg_write_all_data','MEMBER')) THEN
   RAISE EXCEPTION 'UNREVIEWED_GLOBAL_WRITER';
  END IF;
  FOR actor IN SELECT DISTINCT r.oid,r.rolname FROM pg_roles r CROSS JOIN unnest(tables) t
   WHERE NOT r.rolsuper AND r.rolname<>'pg_write_all_data'
   AND has_schema_privilege(r.oid,'ua_private','USAGE')
   AND (has_table_privilege(r.oid,to_regclass('ua_private.'||quote_ident(t)),'INSERT,UPDATE,DELETE')
    OR has_any_column_privilege(r.oid,to_regclass('ua_private.'||quote_ident(t)),'INSERT,UPDATE')) LOOP
   IF actor.rolname NOT IN('postgres','ua_owner','ua_api_login','ua_runtime','ua_person_lock_owner','ua_clerk_lock_owner','ua_deletion_executor') THEN
    RAISE EXCEPTION 'UNREVIEWED_EFFECTIVE_WRITER: %',actor.rolname;
   END IF;
   IF actor.rolname<>'ua_deletion_executor' THEN
    privileges_ok:=has_function_privilege(actor.oid,'ua_private.assert_deletion_writable(text,jsonb)','EXECUTE');
    IF NOT privileges_ok THEN RAISE EXCEPTION 'MISSING_WRITER_GUARD_ACL: %',actor.rolname; END IF;
    IF (has_table_privilege(actor.oid,'ua_private.staff_audit','INSERT,UPDATE,DELETE')
       OR has_any_column_privilege(actor.oid,'ua_private.staff_audit','INSERT,UPDATE')
       OR has_table_privilege(actor.oid,'ua_private.staff_receipts','INSERT,UPDATE,DELETE')
       OR has_any_column_privilege(actor.oid,'ua_private.staff_receipts','INSERT,UPDATE'))
      AND NOT has_function_privilege(actor.oid,'ua_private.assert_deletion_staff_writable(jsonb,jsonb)','EXECUTE') THEN
     RAISE EXCEPTION 'MISSING_STAFF_WRITER_GUARD_ACL: %',actor.rolname;
    END IF;
   END IF;
  END LOOP;
 END IF;
 FOR row IN SELECT c.relname,t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
  JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='ua_private'
  AND p.proname IN('deletion_write_barrier','deletion_identity_barrier','deletion_proof_barrier') ORDER BY c.relname,t.tgname LOOP
  EXECUTE format('ALTER TABLE ua_private.%I %s TRIGGER %I',row.relname,
   CASE WHEN mode='enable-guards' THEN 'ENABLE' ELSE 'DISABLE' END,row.tgname);
 END LOOP;
 UPDATE ua_private.account_deletion_control SET guards_active=(mode='enable-guards') WHERE singleton;
 IF EXISTS(SELECT 1 FROM ua_private.account_deletion_control WHERE accepting)
  OR EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='ua_private' AND p.proname IN('deletion_write_barrier','deletion_identity_barrier','deletion_proof_barrier') AND t.tgenabled<>wanted) THEN
  RAISE EXCEPTION 'GUARD_CHANGE_POSTFLIGHT_FAILED';
 END IF;
END $guard_change$;
REVOKE ua_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
DO $close_owner_window$ BEGIN
 IF has_schema_privilege(current_user,'ua_private','CREATE') OR pg_has_role(current_user,'ua_owner','USAGE')
  OR pg_has_role(current_user,'ua_owner','SET')
  OR (SELECT count(*) FROM pg_auth_members WHERE roleid='ua_owner'::regrole OR member='ua_owner'::regrole)<>1
  OR NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='ua_owner'::regrole AND member=current_user::regrole
   AND grantor=10 AND admin_option AND NOT inherit_option AND NOT set_option) THEN
  RAISE EXCEPTION 'OWNER_WINDOW_NOT_CLOSED';
 END IF;
END $close_owner_window$;
COMMIT;
-- After enable-guards: barriers ON, acceptance still OFF. Observe genuine owner
-- activity before any acceptance approval. After disable-empty-guards: barriers
-- OFF, acceptance OFF, no deletion history. Never use this rollback after a job
-- or tombstone exists; keep safeguards/recovery/status and stop new acceptance.

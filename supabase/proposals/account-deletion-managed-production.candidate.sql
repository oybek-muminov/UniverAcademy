-- MANAGED SUPABASE PRODUCTION INSTALL CANDIDATE. NOT APPROVED OR APPLIED.
-- Installs disabled infrastructure only. Creates no users, attempts, results,
-- provider calls, credentials, scheduled tasks or accepted deletion jobs.
-- Separate approval, backup readiness and independent review are mandatory.
-- Run as the observed managed postgres operator only, in one dedicated session.
-- The out-of-band approval marker is an accident guard, NOT user authorization.
-- Do not replace a failed fingerprint/role check with a permissive condition.
-- This is a proposal, not a Supabase migration-history entry.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path=pg_catalog;
SET LOCAL createrole_self_grant='';
DO $preflight$
DECLARE observed text; operator_oid oid:=current_user::regrole; target text;
BEGIN
 IF current_setting('ua.deletion_production_install',true) IS DISTINCT FROM 'approved-disabled-2026-11-18' THEN
  RAISE EXCEPTION 'PRODUCTION_INSTALL_NOT_ARMED';
 END IF;
 IF current_database()<>'postgres' OR current_setting('server_version')<>'17.11'
  OR current_user<>session_user OR current_user<>'postgres'
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE oid=operator_oid AND NOT rolsuper AND rolcreaterole AND rolbypassrls)
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE oid=10 AND rolname='supabase_admin' AND rolsuper)
  OR has_schema_privilege(current_user,'ua_private','CREATE') THEN
  RAISE EXCEPTION 'UNEXPECTED_MANAGED_OPERATOR_OR_SCHEMA';
 END IF;
 FOREACH target IN ARRAY ARRAY['ua_owner','ua_access_locator_owner'] LOOP
  IF (SELECT count(*) FROM pg_auth_members WHERE roleid=target::regrole OR member=target::regrole)<>1
   OR NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=target::regrole AND member=operator_oid
     AND grantor=10 AND admin_option AND NOT inherit_option AND NOT set_option)
   OR pg_has_role(current_user,target,'USAGE') OR pg_has_role(current_user,target,'SET') THEN
   RAISE EXCEPTION 'UNEXPECTED_MANAGED_OWNER_MEMBERSHIP: %',target;
  END IF;
 END LOOP;
WITH snapshot AS (
 SELECT jsonb_build_object(
 'schema',(SELECT jsonb_build_object('owner',pg_get_userbyid(nspowner),'acl',nspacl::text) FROM pg_namespace WHERE nspname='ua_private'),
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'rls',c.relrowsecurity,'force',c.relforcerowsecurity) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ua_private' AND c.relkind IN('r','p','v','m','S','f')),
 'columns',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'acl',a.attacl::text,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='ua_private' AND c.relkind IN('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('table',c.conrelid::regclass::text,'domain',c.contypid::regtype::text,'name',c.conname,'def',pg_get_constraintdef(c.oid)) ORDER BY c.conrelid::regclass::text,c.contypid::regtype::text,c.conname) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='ua_private'),
 'functions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'definition',md5(pg_get_functiondef(p.oid))) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='ua_private'),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'enabled',t.tgenabled,'def',pg_get_triggerdef(t.oid)) ORDER BY c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ua_private' AND NOT t.tgisinternal),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.tablename,p.policyname) FROM pg_policies p WHERE schemaname='ua_private'),
 'roles',(SELECT jsonb_agg(jsonb_build_object('name',rolname,'super',rolsuper,'bypass',rolbypassrls,'inherit',rolinherit,'login',rolcanlogin,'createdb',rolcreatedb,'createrole',rolcreaterole,'replication',rolreplication) ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'ua_%'),
 'memberships',(SELECT jsonb_agg(jsonb_build_object('role',r.rolname,'member',m.rolname,'grantor',g.rolname,'admin',a.admin_option,'inherit',a.inherit_option,'set',a.set_option) ORDER BY r.rolname,m.rolname,g.rolname) FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member JOIN pg_roles g ON g.oid=a.grantor WHERE r.rolname LIKE 'ua_%' OR m.rolname LIKE 'ua_%')
 ) doc
) SELECT md5(doc::text) INTO observed FROM snapshot;
 IF observed IS DISTINCT FROM 'b4767335a593489e31cf101b1fd46111' THEN
  RAISE EXCEPTION 'PRODUCTION_CATALOG_DRIFT_REAUDIT_REQUIRED';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('ua_deletion_executor','ua_deletion_request_login','ua_deletion_recovery_login')) THEN
  RAISE EXCEPTION 'DELETION_ROLES_ALREADY_EXIST';
 END IF;
END $preflight$;
-- Each new role remains NOLOGIN with no supplied password. Managed PostgreSQL
-- creates a bootstrap-granted ADMIN-only creator edge; verify that shape below.
CREATE ROLE ua_deletion_executor NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
CREATE ROLE ua_deletion_request_login NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
CREATE ROLE ua_deletion_recovery_login NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
DO $creator_edges$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['ua_deletion_executor','ua_deletion_request_login','ua_deletion_recovery_login'] LOOP
  IF (SELECT count(*) FROM pg_auth_members WHERE roleid=target::regrole OR member=target::regrole)<>1
   OR NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=target::regrole AND member=current_user::regrole
    AND grantor=10 AND admin_option AND NOT inherit_option AND NOT set_option) THEN
   RAISE EXCEPTION 'UNEXPECTED_NEW_ROLE_CREATOR_EDGE: %',target;
  END IF;
 END LOOP;
END $creator_edges$;
-- Separate operator-granted transfer edges. Preserve bootstrap ADMIN-only rows.
GRANT ua_owner,ua_access_locator_owner,ua_deletion_executor TO CURRENT_USER
 WITH ADMIN FALSE, INHERIT TRUE, SET TRUE GRANTED BY CURRENT_USER;
-- ALTER FUNCTION OWNER needs destination CREATE while ownership is transferred.
GRANT CREATE ON SCHEMA ua_private TO ua_deletion_executor;

-- Verbatim business SQL source SHA256: 5bb1eee4089a9480a3bcf444e70805da9a3cb39be0948ded150341c2faa6b5cc
CREATE TABLE ua_private.account_deletion_control(singleton boolean PRIMARY KEY CHECK(singleton),accepting boolean NOT NULL DEFAULT false);
INSERT INTO ua_private.account_deletion_control VALUES(true,false);
CREATE TABLE ua_private.account_deletion_jobs(
 id uuid PRIMARY KEY, person_id uuid NOT NULL UNIQUE, issuer text NOT NULL, subject text NOT NULL,
 receipt_digest text NOT NULL UNIQUE CHECK(receipt_digest ~ '^[0-9a-f]{64}$'),
 state text NOT NULL CHECK(state IN ('pending','provider_deleted','completed')),
 created_at_ms bigint NOT NULL,completed_at_ms bigint,
 lease_id uuid,lease_until_ms bigint,attempts integer NOT NULL DEFAULT 0,
 UNIQUE(issuer,subject),CHECK((state='completed')=(completed_at_ms IS NOT NULL))
);
CREATE TABLE ua_private.deleted_clerk_subjects(issuer text NOT NULL,subject text NOT NULL,deleted_at_ms bigint NOT NULL,PRIMARY KEY(issuer,subject));
CREATE TABLE ua_private.deleted_proof_digests(kind text NOT NULL CHECK(kind IN ('clerk','telegram')),digest text NOT NULL,deleted_at_ms bigint NOT NULL,PRIMARY KEY(kind,digest));
ALTER TABLE ua_private.account_deletion_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE ua_private.account_deletion_control FORCE ROW LEVEL SECURITY;
ALTER TABLE ua_private.account_deletion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ua_private.account_deletion_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE ua_private.deleted_clerk_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE ua_private.deleted_clerk_subjects FORCE ROW LEVEL SECURITY;
ALTER TABLE ua_private.deleted_proof_digests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ua_private.deleted_proof_digests FORCE ROW LEVEL SECURITY;
CREATE POLICY deletion_control_executor ON ua_private.account_deletion_control TO ua_deletion_executor USING(true) WITH CHECK(true);
CREATE POLICY deletion_jobs_executor ON ua_private.account_deletion_jobs TO ua_deletion_executor USING(true) WITH CHECK(true);
CREATE POLICY deletion_subject_executor ON ua_private.deleted_clerk_subjects TO ua_deletion_executor USING(true) WITH CHECK(true);
CREATE POLICY deletion_proof_executor ON ua_private.deleted_proof_digests TO ua_deletion_executor USING(true) WITH CHECK(true);
GRANT USAGE ON SCHEMA ua_private TO ua_deletion_executor;
GRANT SELECT ON ua_private.account_deletion_control TO ua_deletion_executor;
GRANT SELECT,INSERT,UPDATE ON ua_private.account_deletion_jobs TO ua_deletion_executor;
GRANT SELECT,INSERT ON ua_private.deleted_clerk_subjects,ua_private.deleted_proof_digests TO ua_deletion_executor;
-- Exact dedicated executor rights; no runtime table DELETE, membership or DDL.
GRANT SELECT,UPDATE,DELETE ON ua_private.people,ua_private.clerk_identities,ua_private.student_families,ua_private.clerk_student_sessions TO ua_deletion_executor;
GRANT SELECT,DELETE ON ua_private.student_access,ua_private.student_refresh,ua_private.clerk_family_bindings,
 ua_private.init_data_replays,ua_private.clerk_exchange_replays,ua_private.answers,ua_private.ordinary_results,
 ua_private.attempt_cancellations,ua_private.command_receipts,ua_private.statistical_bonuses,
 ua_private.attempts,ua_private.exam_series,ua_private.grants,ua_private.memberships TO ua_deletion_executor;
GRANT SELECT ON ua_private.staff_access,ua_private.staff_identities,ua_private.staff_group_scope,ua_private.staff_subject_scope,
 ua_private.teacher_subject_approvals,ua_private.staff_receipts,ua_private.staff_audit TO ua_deletion_executor;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['people','clerk_identities','student_families','clerk_student_sessions','student_access','student_refresh',
 'clerk_family_bindings','init_data_replays','clerk_exchange_replays','answers','ordinary_results','attempt_cancellations',
 'command_receipts','statistical_bonuses','attempts','exam_series','grants','memberships','staff_access','staff_identities',
 'staff_group_scope','staff_subject_scope','teacher_subject_approvals','staff_receipts','staff_audit'] LOOP
 EXECUTE format('CREATE POLICY deletion_executor_only ON ua_private.%I TO ua_deletion_executor USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;
CREATE FUNCTION ua_private.prepare_account_deletion(p_id uuid,p_person uuid,p_access text,p_issuer text,p_subject text,p_sid text,p_receipt text,p_verified_at bigint)
RETURNS TABLE(job_id uuid,state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ua_private AS $$
DECLARE t bigint:=floor(extract(epoch FROM clock_timestamp())*1000); person record; j record; BEGIN
 IF NOT COALESCE(p_access ~ '^[0-9a-f]{64}$' AND p_receipt ~ '^[0-9a-f]{64}$' AND p_id IS NOT NULL AND p_person IS NOT NULL
  AND p_verified_at<=t AND p_verified_at>t-300000,false) THEN RAISE EXCEPTION 'DELETION_REJECTED' USING ERRCODE='42501'; END IF;
 -- Match existing auth lock ordering: Clerk identity advisory, mapping, person.
 PERFORM pg_advisory_xact_lock(1430348620,hashtext('['||to_json(p_issuer)::text||','||to_json(p_subject)::text||']'));
 PERFORM 1 FROM ua_private.clerk_identities WHERE issuer=p_issuer AND subject=p_subject AND person_id=p_person FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'DELETION_REJECTED' USING ERRCODE='42501'; END IF;
 SELECT * INTO person FROM ua_private.people WHERE id=p_person FOR UPDATE;
 IF NOT FOUND OR person.roles IS DISTINCT FROM ARRAY['student']::text[] THEN RAISE EXCEPTION 'DELETION_REJECTED' USING ERRCODE='42501'; END IF;
 t:=floor(extract(epoch FROM clock_timestamp())*1000);
 IF p_verified_at>t OR p_verified_at<=t-300000 THEN RAISE EXCEPTION 'DELETION_REJECTED' USING ERRCODE='42501'; END IF;
 SELECT * INTO j FROM ua_private.account_deletion_jobs WHERE person_id=p_person;
 -- Retry has to possess the same high-entropy receipt and fresh matching Clerk proof.
 IF FOUND THEN
  IF j.id=p_id AND j.issuer=p_issuer AND j.subject=p_subject AND j.receipt_digest=p_receipt THEN RETURN QUERY SELECT j.id,j.state; RETURN; END IF;
  RAISE EXCEPTION 'DELETION_REJECTED' USING ERRCODE='42501';
 END IF;
 IF NOT person.enabled OR NOT EXISTS(SELECT 1 FROM ua_private.account_deletion_control WHERE accepting AND guards_active)
  OR NOT EXISTS(SELECT 1 FROM ua_private.clerk_identities WHERE issuer=p_issuer AND subject=p_subject AND person_id=p_person AND enabled)
  OR (SELECT count(*) FROM ua_private.clerk_identities WHERE person_id=p_person)<>1
  OR NOT EXISTS(SELECT 1 FROM ua_private.student_access a JOIN ua_private.student_families f ON f.id=a.family_id
    JOIN ua_private.clerk_family_bindings b ON b.family_id=f.id AND b.person_id=f.person_id
    JOIN ua_private.clerk_student_sessions s ON s.issuer=b.issuer AND s.subject=b.subject AND s.sid=b.sid AND s.person_id=b.person_id
    WHERE a.digest=p_access AND a.expires_at_ms>t AND NOT a.superseded AND f.person_id=p_person AND f.expires_at_ms>t AND f.revoked_at_ms IS NULL
    AND f.auth_provider='clerk' AND b.issuer=p_issuer AND b.subject=p_subject AND b.sid=p_sid AND s.retired_at_ms IS NULL)
  OR EXISTS(SELECT 1 FROM ua_private.staff_access WHERE person_id=p_person)
  OR EXISTS(SELECT 1 FROM ua_private.staff_identities WHERE person_id=p_person)
  OR EXISTS(SELECT 1 FROM ua_private.staff_group_scope WHERE person_id=p_person)
  OR EXISTS(SELECT 1 FROM ua_private.staff_subject_scope WHERE person_id=p_person)
  OR EXISTS(SELECT 1 FROM ua_private.teacher_subject_approvals WHERE person_id=p_person)
  OR EXISTS(SELECT 1 FROM ua_private.staff_receipts WHERE actor_id=p_person)
  OR EXISTS(SELECT 1 FROM ua_private.staff_audit WHERE actor_id=p_person OR target_id=p_person)
 THEN RAISE EXCEPTION 'DELETION_REJECTED' USING ERRCODE='42501'; END IF;
 INSERT INTO ua_private.account_deletion_jobs(id,person_id,issuer,subject,receipt_digest,state,created_at_ms)
 VALUES(p_id,p_person,p_issuer,p_subject,p_receipt,'pending',t);
 UPDATE ua_private.people SET enabled=false WHERE id=p_person;
 UPDATE ua_private.clerk_identities SET enabled=false WHERE person_id=p_person;
 UPDATE ua_private.student_families SET revoked_at_ms=coalesce(revoked_at_ms,t),logout_retain_until_ms=greatest(coalesce(logout_retain_until_ms,0),t+86400000) WHERE person_id=p_person AND revoked_at_ms IS NULL;
 UPDATE ua_private.clerk_student_sessions SET retired_at_ms=coalesce(retired_at_ms,t) WHERE person_id=p_person;
 RETURN QUERY SELECT p_id,'pending'::text;
END $$;
CREATE FUNCTION ua_private.account_deletion_status(p_receipt text) RETURNS TABLE(job_id uuid,state text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,ua_private AS $$
 SELECT id,state FROM ua_private.account_deletion_jobs WHERE receipt_digest=p_receipt AND
 (completed_at_ms IS NULL OR completed_at_ms+86400000>floor(extract(epoch FROM clock_timestamp())*1000));
$$;
CREATE FUNCTION ua_private.claim_account_deletion(p_id uuid,p_lease uuid)
RETURNS TABLE(job_id uuid,lease_id uuid,issuer text,subject text,state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ua_private AS $$
DECLARE j record; t bigint:=floor(extract(epoch FROM clock_timestamp())*1000); BEGIN
 IF p_lease IS NULL THEN RAISE EXCEPTION 'INVALID_LEASE'; END IF;
 SELECT * INTO j FROM ua_private.account_deletion_jobs WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 t:=floor(extract(epoch FROM clock_timestamp())*1000);
 IF j.state='completed' OR coalesce(j.lease_until_ms,0)>t THEN RETURN; END IF;
 UPDATE ua_private.account_deletion_jobs SET lease_id=p_lease,lease_until_ms=t+60000,attempts=attempts+1 WHERE id=p_id;
 RETURN QUERY SELECT j.id,p_lease,j.issuer,j.subject,j.state;
END $$;
CREATE FUNCTION ua_private.due_account_deletions() RETURNS TABLE(job_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,ua_private AS $$
 SELECT id FROM ua_private.account_deletion_jobs WHERE state<>'completed' AND coalesce(lease_until_ms,0)<=floor(extract(epoch FROM clock_timestamp())*1000)
 -- Rotate retried jobs behind older unclaimed work instead of starving job 21.
 ORDER BY coalesce(lease_until_ms,created_at_ms),created_at_ms,id LIMIT 20;
$$;
CREATE FUNCTION ua_private.mark_account_provider_deleted(p_id uuid,p_lease uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ua_private AS $$
BEGIN
 UPDATE ua_private.account_deletion_jobs SET state='provider_deleted' WHERE id=p_id AND lease_id=p_lease AND state IN('pending','provider_deleted')
 AND lease_until_ms>floor(extract(epoch FROM clock_timestamp())*1000);
 RETURN FOUND;
END $$;
CREATE FUNCTION ua_private.finish_account_deletion(p_id uuid,p_lease uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ua_private AS $$
DECLARE j record; t bigint:=floor(extract(epoch FROM clock_timestamp())*1000); BEGIN
 SELECT * INTO j FROM ua_private.account_deletion_jobs WHERE id=p_id;
 IF NOT FOUND OR j.state<>'provider_deleted' OR j.lease_id IS DISTINCT FROM p_lease OR j.lease_until_ms<=t THEN RETURN false; END IF;
 -- Same global lock order as prepare; no simultaneous deletion for this person.
 PERFORM pg_advisory_xact_lock(1430348620,hashtext('['||to_json(j.issuer)::text||','||to_json(j.subject)::text||']'));
 PERFORM 1 FROM ua_private.clerk_identities WHERE issuer=j.issuer AND subject=j.subject FOR UPDATE;
 PERFORM 1 FROM ua_private.people WHERE id=j.person_id AND NOT enabled FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'DELETION_INVARIANT'; END IF;
 SELECT * INTO j FROM ua_private.account_deletion_jobs WHERE id=p_id FOR UPDATE;
 t:=floor(extract(epoch FROM clock_timestamp())*1000);
 IF j.state<>'provider_deleted' OR j.lease_id IS DISTINCT FROM p_lease OR j.lease_until_ms<=t THEN RETURN false; END IF;
 INSERT INTO ua_private.deleted_clerk_subjects VALUES(j.issuer,j.subject,t) ON CONFLICT DO NOTHING;
 INSERT INTO ua_private.deleted_proof_digests SELECT 'telegram',digest,t FROM ua_private.init_data_replays WHERE person_id=j.person_id ON CONFLICT DO NOTHING;
 INSERT INTO ua_private.deleted_proof_digests SELECT 'clerk',digest,t FROM ua_private.clerk_exchange_replays WHERE person_id=j.person_id ON CONFLICT DO NOTHING;
 DELETE FROM ua_private.answers WHERE attempt_id IN(SELECT id FROM ua_private.attempts WHERE person_id=j.person_id);
 DELETE FROM ua_private.ordinary_results WHERE attempt_id IN(SELECT id FROM ua_private.attempts WHERE person_id=j.person_id);
 DELETE FROM ua_private.attempt_cancellations WHERE person_id=j.person_id;
 DELETE FROM ua_private.command_receipts WHERE person_id=j.person_id;
 DELETE FROM ua_private.statistical_bonuses WHERE person_id=j.person_id;
 -- Existing attempt/series FKs and people/membership FK are deferred.
 DELETE FROM ua_private.attempts WHERE person_id=j.person_id;
 DELETE FROM ua_private.exam_series WHERE person_id=j.person_id;
 DELETE FROM ua_private.grants WHERE person_id=j.person_id;
 DELETE FROM ua_private.student_access WHERE family_id IN(SELECT id FROM ua_private.student_families WHERE person_id=j.person_id);
 DELETE FROM ua_private.student_refresh WHERE family_id IN(SELECT id FROM ua_private.student_families WHERE person_id=j.person_id);
 DELETE FROM ua_private.clerk_family_bindings WHERE person_id=j.person_id;
 DELETE FROM ua_private.student_families WHERE person_id=j.person_id;
 DELETE FROM ua_private.clerk_student_sessions WHERE person_id=j.person_id;
 DELETE FROM ua_private.clerk_identities WHERE person_id=j.person_id;
 DELETE FROM ua_private.init_data_replays WHERE person_id=j.person_id;
 DELETE FROM ua_private.clerk_exchange_replays WHERE person_id=j.person_id;
 DELETE FROM ua_private.memberships WHERE person_id=j.person_id;
 DELETE FROM ua_private.people WHERE id=j.person_id;
 UPDATE ua_private.account_deletion_jobs SET state='completed',completed_at_ms=t,lease_id=NULL,lease_until_ms=NULL WHERE id=p_id;
 RETURN true;
END $$;
-- Identity and consumed-proof resurrection barriers survive account removal.
CREATE FUNCTION ua_private.deletion_identity_barrier() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ua_private AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(1430348620,hashtext('['||to_json(NEW.issuer)::text||','||to_json(NEW.subject)::text||']'));
 IF EXISTS(SELECT 1 FROM ua_private.deleted_clerk_subjects WHERE issuer=NEW.issuer AND subject=NEW.subject)
 OR EXISTS(SELECT 1 FROM ua_private.account_deletion_jobs WHERE issuer=NEW.issuer AND subject=NEW.subject) THEN
  RAISE EXCEPTION 'DELETED_CLERK_SUBJECT' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER deletion_identity_barrier BEFORE INSERT OR UPDATE OF issuer,subject ON ua_private.clerk_identities FOR EACH ROW EXECUTE FUNCTION ua_private.deletion_identity_barrier();
CREATE TRIGGER deletion_identity_after AFTER INSERT OR UPDATE OF issuer,subject ON ua_private.clerk_identities FOR EACH ROW EXECUTE FUNCTION ua_private.deletion_identity_barrier();
CREATE FUNCTION ua_private.deletion_proof_barrier() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ua_private AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM ua_private.deleted_proof_digests WHERE kind=TG_ARGV[0] AND digest=NEW.digest) THEN
 RAISE EXCEPTION 'DELETED_PROOF_REPLAY' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER deletion_telegram_proof BEFORE INSERT OR UPDATE OF digest ON ua_private.init_data_replays FOR EACH ROW EXECUTE FUNCTION ua_private.deletion_proof_barrier('telegram');
CREATE TRIGGER deletion_clerk_proof BEFORE INSERT OR UPDATE OF digest ON ua_private.clerk_exchange_replays FOR EACH ROW EXECUTE FUNCTION ua_private.deletion_proof_barrier('clerk');
CREATE TRIGGER deletion_telegram_after AFTER INSERT OR UPDATE OF digest ON ua_private.init_data_replays FOR EACH ROW EXECUTE FUNCTION ua_private.deletion_proof_barrier('telegram');
CREATE TRIGGER deletion_clerk_after AFTER INSERT OR UPDATE OF digest ON ua_private.clerk_exchange_replays FOR EACH ROW EXECUTE FUNCTION ua_private.deletion_proof_barrier('clerk');
-- Invoker wrapper preserves the effective writer identity; only the non-login
-- executor can bypass the freeze. Never grant runtime membership in that role.
CREATE FUNCTION ua_private.assert_deletion_writable(p_table text,p_row jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ua_private AS $$
DECLARE p uuid; BEGIN
 IF p_table='people' THEN p:=(p_row->>'id')::uuid;
 ELSIF p_table IN ('student_access','student_refresh') THEN
  SELECT person_id INTO p FROM ua_private.student_families WHERE id=(p_row->>'family_id')::uuid;
 ELSIF p_table IN ('answers','ordinary_results') THEN
  SELECT person_id INTO p FROM ua_private.attempts WHERE id=(p_row->>'attempt_id')::uuid;
 ELSE p:=(p_row->>'person_id')::uuid;
 END IF;
 IF p IS NULL THEN RETURN; END IF;
 PERFORM 1 FROM ua_private.people WHERE id=p FOR UPDATE;
 IF EXISTS(SELECT 1 FROM ua_private.account_deletion_jobs WHERE person_id=p) THEN
  RAISE EXCEPTION 'ACCOUNT_DELETION_PENDING' USING ERRCODE='42501';
 END IF;
END $$;
-- Staff mutations can introduce a reference after prepare's initial rejection
-- check. Lock every OLD/NEW actor/target in sorted UUID order before checking.
CREATE FUNCTION ua_private.assert_deletion_staff_writable(p_old jsonb,p_new jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ua_private AS $$
DECLARE ids uuid[]; BEGIN
 SELECT array_agg(DISTINCT v ORDER BY v) INTO ids FROM unnest(ARRAY[
  (p_old->>'actor_id')::uuid,(p_old->>'target_id')::uuid,
  (p_new->>'actor_id')::uuid,(p_new->>'target_id')::uuid]) AS u(v) WHERE v IS NOT NULL;
 PERFORM 1 FROM ua_private.people WHERE id=ANY(ids) ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM ua_private.account_deletion_jobs WHERE person_id=ANY(ids)) THEN
  RAISE EXCEPTION 'ACCOUNT_DELETION_PENDING' USING ERRCODE='42501';
 END IF;
END $$;
CREATE FUNCTION ua_private.deletion_write_barrier() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,ua_private AS $$ BEGIN
 IF current_user<>'ua_deletion_executor' THEN
  IF TG_TABLE_NAME IN ('staff_audit','staff_receipts') THEN
   PERFORM ua_private.assert_deletion_staff_writable(
    CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END);
  ELSE
  IF TG_OP<>'INSERT' THEN PERFORM ua_private.assert_deletion_writable(TG_TABLE_NAME,to_jsonb(OLD)); END IF;
  IF TG_OP<>'DELETE' THEN PERFORM ua_private.assert_deletion_writable(TG_TABLE_NAME,to_jsonb(NEW)); END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['people','memberships','clerk_identities','clerk_student_sessions',
 'clerk_family_bindings','student_families','student_access','student_refresh','init_data_replays',
 'clerk_exchange_replays','answers','ordinary_results','attempt_cancellations','command_receipts',
 'statistical_bonuses','attempts','exam_series','grants','staff_access','staff_identities',
 'staff_group_scope','staff_subject_scope','teacher_subject_approvals','staff_audit','staff_receipts'] LOOP
 EXECUTE format('CREATE TRIGGER deletion_write_barrier BEFORE INSERT OR UPDATE OR DELETE ON ua_private.%I FOR EACH ROW EXECUTE FUNCTION ua_private.deletion_write_barrier()',t);
 END LOOP;
END $$;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure obj FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='ua_private' AND p.proname IN('prepare_account_deletion','account_deletion_status','claim_account_deletion','due_account_deletions',
 'mark_account_provider_deleted','finish_account_deletion','deletion_identity_barrier','deletion_proof_barrier','assert_deletion_writable','assert_deletion_staff_writable','deletion_write_barrier') LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO ua_deletion_executor',f.obj);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.obj);
 END LOOP;
END $$;

-- Staged install: accepting=false alone does NOT neutralize row triggers.
-- Disable every newly installed barrier before commit, while DDL locks are held.
ALTER TABLE ua_private.account_deletion_control ADD COLUMN guards_active boolean NOT NULL DEFAULT false;
ALTER TABLE ua_private.account_deletion_control ADD CONSTRAINT acceptance_requires_guards CHECK(NOT accepting OR guards_active);
DO $disable_installed_guards$ DECLARE t record; n integer:=0; BEGIN
 FOR t IN SELECT c.relname,t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
  JOIN pg_namespace ns ON ns.oid=c.relnamespace JOIN pg_proc f ON f.oid=t.tgfoid
  WHERE ns.nspname='ua_private' AND NOT t.tgisinternal AND f.proowner='ua_deletion_executor'::regrole
  AND f.proname IN('deletion_write_barrier','deletion_identity_barrier','deletion_proof_barrier')
  ORDER BY c.relname,t.tgname LOOP
  EXECUTE format('ALTER TABLE ua_private.%I DISABLE TRIGGER %I',t.relname,t.tgname);n:=n+1;
 END LOOP;
 IF n<>31 THEN RAISE EXCEPTION 'UNEXPECTED_DELETION_BARRIER_COUNT'; END IF;
END $disable_installed_guards$;

-- New tables belong to the existing schema owner, never the operator or runtime.
ALTER TABLE ua_private.account_deletion_control OWNER TO ua_owner;
ALTER TABLE ua_private.account_deletion_jobs OWNER TO ua_owner;
ALTER TABLE ua_private.deleted_clerk_subjects OWNER TO ua_owner;
ALTER TABLE ua_private.deleted_proof_digests OWNER TO ua_owner;
-- Remove any inherited default-ACL exposure on NEW objects only. Preserve the
-- exact executor table rights granted above. Never rewrite old unrelated ACLs.
DO $normalize_new_acl$ DECLARE obj record; a record; BEGIN
 FOR obj IN SELECT c.oid,c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='ua_private' AND c.relname IN('account_deletion_control','account_deletion_jobs','deleted_clerk_subjects','deleted_proof_digests') LOOP
  FOR a IN SELECT DISTINCT x.grantee FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
   WHERE c.oid=obj.oid AND x.grantee NOT IN(obj.relowner,'ua_deletion_executor'::regrole) LOOP
   EXECUTE format('REVOKE ALL ON TABLE %s FROM %s',obj.oid::regclass,
    CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END);
  END LOOP;
 END LOOP;
 FOR obj IN SELECT p.oid,p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='ua_private' AND p.proname IN('prepare_account_deletion','account_deletion_status','claim_account_deletion','due_account_deletions',
   'mark_account_provider_deleted','finish_account_deletion','deletion_identity_barrier','deletion_proof_barrier','assert_deletion_writable','assert_deletion_staff_writable','deletion_write_barrier') LOOP
  FOR a IN SELECT DISTINCT x.grantee FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
   WHERE p.oid=obj.oid AND x.grantee<>obj.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',obj.oid::regprocedure,
    CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END);
  END LOOP;
 END LOOP;
END $normalize_new_acl$;
GRANT USAGE ON SCHEMA ua_private TO ua_deletion_request_login,ua_deletion_recovery_login;
GRANT EXECUTE ON FUNCTION ua_private.locate_student_access(text),
 ua_private.prepare_account_deletion(uuid,uuid,text,text,text,text,text,bigint),
 ua_private.account_deletion_status(text) TO ua_deletion_request_login;
GRANT EXECUTE ON FUNCTION ua_private.due_account_deletions(),ua_private.claim_account_deletion(uuid,uuid),
 ua_private.mark_account_provider_deleted(uuid,uuid),ua_private.finish_account_deletion(uuid,uuid) TO ua_deletion_recovery_login;
-- Invoker triggers retain the effective writer identity. Helpers lock/check only;
-- these grants confer no job-table access, deletion entry or executor membership.
GRANT EXECUTE ON FUNCTION ua_private.assert_deletion_writable(text,jsonb) TO ua_runtime,ua_clerk_lock_owner,ua_person_lock_owner,ua_owner;
GRANT EXECUTE ON FUNCTION ua_private.assert_deletion_staff_writable(jsonb,jsonb) TO ua_runtime,ua_owner;
DO $$ DECLARE r text; f record; allowed text[]; BEGIN
 FOREACH r IN ARRAY ARRAY['ua_deletion_request_login','ua_deletion_recovery_login'] LOOP
  IF has_schema_privilege(r,'ua_private','CREATE')
    OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ua_private'
      AND c.relkind IN('r','p','v','m','f') AND (has_table_privilege(r,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(r,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
    OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r::regrole) THEN
   RAISE EXCEPTION 'ACL_RUNTIME_AUTHORITY_DRIFT: %',r;
  END IF;
  allowed:=CASE r WHEN 'ua_deletion_request_login' THEN ARRAY[
   'ua_private.locate_student_access(text)','ua_private.prepare_account_deletion(uuid,uuid,text,text,text,text,text,bigint)','ua_private.account_deletion_status(text)']
   ELSE ARRAY['ua_private.due_account_deletions()','ua_private.claim_account_deletion(uuid,uuid)',
   'ua_private.mark_account_provider_deleted(uuid,uuid)','ua_private.finish_account_deletion(uuid,uuid)'] END;
  FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='ua_private' LOOP
   IF has_function_privilege(r,f.oid,'EXECUTE') AND NOT f.oid=ANY(ARRAY(SELECT x::regprocedure::oid FROM unnest(allowed) x)) THEN
    RAISE EXCEPTION 'ACL_UNEXPECTED_EXECUTE: % %',r,f.oid::regprocedure;
   END IF;
  END LOOP;
 END LOOP;
END $$;

DO $disabled_state$ BEGIN
 IF (SELECT count(*) FROM ua_private.account_deletion_control)<>1
  OR EXISTS(SELECT 1 FROM ua_private.account_deletion_control WHERE accepting OR guards_active)
  OR EXISTS(SELECT 1 FROM ua_private.account_deletion_jobs)
  OR EXISTS(SELECT 1 FROM ua_private.deleted_clerk_subjects)
  OR EXISTS(SELECT 1 FROM ua_private.deleted_proof_digests) THEN
  RAISE EXCEPTION 'INSTALL_MUST_REMAIN_DISABLED_AND_EMPTY';
 END IF;
END $disabled_state$;
-- Close ALL transfer authority before commit. No credential or LOGIN activation.
REVOKE CREATE ON SCHEMA ua_private FROM ua_deletion_executor;
REVOKE ua_owner,ua_access_locator_owner,ua_deletion_executor FROM CURRENT_USER GRANTED BY CURRENT_USER;
DO $postflight$ DECLARE target text; obj record; allowed oid[]; a record; BEGIN
 FOREACH target IN ARRAY ARRAY['ua_owner','ua_access_locator_owner','ua_deletion_executor','ua_deletion_request_login','ua_deletion_recovery_login'] LOOP
  IF (SELECT count(*) FROM pg_auth_members WHERE roleid=target::regrole OR member=target::regrole)<>1
   OR NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=target::regrole AND member=current_user::regrole
    AND grantor=10 AND admin_option AND NOT inherit_option AND NOT set_option)
   OR pg_has_role(current_user,target,'USAGE') OR pg_has_role(current_user,target,'SET') THEN
   RAISE EXCEPTION 'TRANSFER_AUTHORITY_NOT_CLOSED: %',target;
  END IF;
  IF target<>'ua_owner' AND has_schema_privilege(target,'ua_private','CREATE') THEN
   RAISE EXCEPTION 'UNEXPECTED_SCHEMA_CREATE: %',target;
  END IF;
 END LOOP;
 IF has_schema_privilege(current_user,'ua_private','CREATE') THEN
  RAISE EXCEPTION 'OPERATOR_SCHEMA_AUTHORITY_NOT_CLOSED';
 END IF;
 FOREACH target IN ARRAY ARRAY['ua_deletion_executor','ua_deletion_request_login','ua_deletion_recovery_login'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=target AND NOT rolcanlogin AND NOT rolinherit
   AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication) THEN
   RAISE EXCEPTION 'UNSAFE_NEW_ROLE: %',target;
  END IF;
 END LOOP;
 FOR obj IN SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='ua_private' AND c.relname IN('account_deletion_control','account_deletion_jobs','deleted_clerk_subjects','deleted_proof_digests') LOOP
  IF obj.relowner<>'ua_owner'::regrole OR NOT obj.relrowsecurity OR NOT obj.relforcerowsecurity
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(obj.relacl,acldefault('r',obj.relowner))) x
     WHERE x.grantee NOT IN(obj.relowner,'ua_deletion_executor'::regrole) OR (x.grantee<>obj.relowner AND x.is_grantable)) THEN
   RAISE EXCEPTION 'UNEXPECTED_DELETION_TABLE_ACL';
  END IF;
 END LOOP;
 -- Exact effective function execution for the eleven NEW functions. PUBLIC and
 -- any unexpected grant, including a grant option, fail the installation.
 FOR obj IN SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='ua_private' AND p.proname IN('prepare_account_deletion','account_deletion_status','claim_account_deletion','due_account_deletions',
   'mark_account_provider_deleted','finish_account_deletion','deletion_identity_barrier','deletion_proof_barrier','assert_deletion_writable','assert_deletion_staff_writable','deletion_write_barrier') LOOP
  allowed:=ARRAY['ua_deletion_executor'::regrole::oid];
  IF obj.proname IN('prepare_account_deletion','account_deletion_status') THEN
   allowed:=allowed||'ua_deletion_request_login'::regrole::oid;
  ELSIF obj.proname IN('claim_account_deletion','due_account_deletions','mark_account_provider_deleted','finish_account_deletion') THEN
   allowed:=allowed||'ua_deletion_recovery_login'::regrole::oid;
  ELSIF obj.proname='assert_deletion_writable' THEN
   allowed:=allowed||ARRAY['ua_runtime'::regrole::oid,'ua_clerk_lock_owner'::regrole::oid,'ua_person_lock_owner'::regrole::oid,'ua_owner'::regrole::oid];
  ELSIF obj.proname='assert_deletion_staff_writable' THEN
   allowed:=allowed||ARRAY['ua_runtime'::regrole::oid,'ua_owner'::regrole::oid];
  END IF;
  IF obj.proowner<>'ua_deletion_executor'::regrole
   OR NOT coalesce('search_path=pg_catalog, ua_private'=ANY(obj.proconfig),false)
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(obj.proacl,acldefault('f',obj.proowner))) x
      WHERE NOT x.grantee=ANY(allowed) OR x.privilege_type<>'EXECUTE' OR x.is_grantable)
   OR EXISTS(SELECT 1 FROM unnest(allowed) roleid WHERE NOT has_function_privilege(roleid,obj.oid,'EXECUTE')) THEN
   RAISE EXCEPTION 'UNEXPECTED_DELETION_FUNCTION_ACL: %',obj.proname;
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_trigger t JOIN pg_proc f ON f.oid=t.tgfoid
  JOIN pg_namespace ns ON ns.oid=f.pronamespace WHERE ns.nspname='ua_private'
  AND f.proname IN('deletion_write_barrier','deletion_identity_barrier','deletion_proof_barrier') AND NOT t.tgisinternal)<>31
  OR EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc f ON f.oid=t.tgfoid
   JOIN pg_namespace ns ON ns.oid=f.pronamespace WHERE ns.nspname='ua_private'
   AND f.proname IN('deletion_write_barrier','deletion_identity_barrier','deletion_proof_barrier') AND t.tgenabled<>'D') THEN
  RAISE EXCEPTION 'INSTALL_BARRIERS_MUST_BE_DISABLED';
 END IF;
END $postflight$;
COMMIT;
-- End state: 31 DISABLED barriers, disabled acceptance; zero jobs; NOLOGIN roles; no
-- temporary SET/INHERIT/CREATE transfer authority remains. Separate approved
-- credential/binding/worker/UI activation must follow, not an automatic step.

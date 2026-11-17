-- REVIEW CANDIDATE ONLY. Not an approved production migration.
-- Install only in an isolated fixture; managed role ownership/ACL, all-writer
-- freeze coverage, privacy retention and provider/UI integration require audit.
-- Trust boundary: verified JWT/liveness/freshness supplied by server adapter;
-- no public request may set identity, verified_at or database context directly.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
DO $$ BEGIN
 IF current_setting('ua.review_deletion_install',true) IS DISTINCT FROM 'isolated-fixture' THEN
  RAISE EXCEPTION 'INACTIVE_REVIEW_SQL';
 END IF;
END $$;
CREATE ROLE ua_deletion_executor NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
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
 IF NOT person.enabled OR NOT EXISTS(SELECT 1 FROM ua_private.account_deletion_control WHERE accepting)
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
 UPDATE ua_private.student_families SET revoked_at_ms=coalesce(revoked_at_ms,t),logout_retain_until_ms=greatest(coalesce(logout_retain_until_ms,0),t+86400000) WHERE person_id=p_person;
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
 ORDER BY created_at_ms,id LIMIT 20;
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
-- No request/recovery grants here. An audited ACL composition must give only
-- prepare+status to request, and due+claim+mark+finish to recovery; no memberships.
COMMIT;

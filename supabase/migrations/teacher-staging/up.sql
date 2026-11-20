-- Isolated staging installation. No runtime or login role inherits either service role.
BEGIN;
DO $$ BEGIN
 IF to_regclass('ua_private.people_registration') IS NULL THEN RAISE EXCEPTION 'Apply the cabinet-id expand migration before teacher-staging'; END IF;
END $$;
DO $$
DECLARE r text; restoring boolean := to_regnamespace('ua_cabinet_retained') IS NOT NULL;
BEGIN
 IF to_regnamespace('ua_cabinet') IS NOT NULL THEN RAISE EXCEPTION 'Active staging schema already exists'; END IF;
 IF to_regnamespace('ua_cabinet_retained') IS NOT NULL THEN
  IF obj_description(to_regnamespace('ua_cabinet_retained'),'pg_namespace') IS DISTINCT FROM 'UniverAcademy teacher staging v1' THEN
   RAISE EXCEPTION 'Unknown retained staging schema'; END IF;
  ALTER SCHEMA ua_cabinet_retained RENAME TO ua_cabinet;
 ELSE
  CREATE SCHEMA ua_cabinet;
 END IF;
 FOREACH r IN ARRAY ARRAY['ua_cabinet_stage','ua_cabinet_delivery'] LOOP
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',r);
  ELSIF NOT restoring THEN RAISE EXCEPTION 'Staging role already exists before first installation: %',r;
  ELSIF EXISTS(SELECT FROM pg_auth_members m JOIN pg_roles me ON me.oid=m.member WHERE me.rolname=r) THEN
    RAISE EXCEPTION 'Staging service role unexpectedly inherits another role: %',r;
  ELSIF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=r AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls AND NOT rolreplication) THEN
    RAISE EXCEPTION 'Unexpected staging service role attributes: %',r;
  END IF;
 END LOOP;
END $$;
COMMENT ON SCHEMA ua_cabinet IS 'UniverAcademy teacher staging v1';
REVOKE ALL ON SCHEMA ua_cabinet FROM PUBLIC;
GRANT USAGE ON SCHEMA ua_cabinet,ua_private TO ua_cabinet_stage,ua_cabinet_delivery;

-- Pending requests do not masquerade as active canonical groups.
CREATE TABLE IF NOT EXISTS ua_cabinet.group_requests(
 id uuid PRIMARY KEY, teacher_id uuid NOT NULL REFERENCES ua_private.people(id),
 subject_id text NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 created_at timestamptz NOT NULL DEFAULT now(), approved_by uuid REFERENCES ua_private.people(id),
 active_group_id uuid UNIQUE REFERENCES ua_private.groups(id),
 CHECK ((approved_by IS NULL) = (active_group_id IS NULL)), CHECK (active_group_id IS NULL OR active_group_id=id));
CREATE INDEX IF NOT EXISTS request_teacher ON ua_cabinet.group_requests(teacher_id,id);
CREATE TABLE IF NOT EXISTS ua_cabinet.test_owners(
 version_id uuid PRIMARY KEY REFERENCES ua_private.test_versions(id), teacher_id uuid NOT NULL REFERENCES ua_private.people(id));
CREATE INDEX IF NOT EXISTS test_teacher ON ua_cabinet.test_owners(teacher_id,version_id);
CREATE TABLE IF NOT EXISTS ua_cabinet.media(
 id uuid PRIMARY KEY, teacher_id uuid NOT NULL REFERENCES ua_private.people(id), png bytea NOT NULL CHECK(octet_length(png) BETWEEN 1 AND 8388608));
CREATE TABLE IF NOT EXISTS ua_cabinet.assignment_media(
 assignment_id uuid REFERENCES ua_private.assignments(id),asset_id uuid REFERENCES ua_cabinet.media(id),PRIMARY KEY(assignment_id,asset_id));
CREATE INDEX IF NOT EXISTS public_asset ON ua_cabinet.assignment_media(asset_id,assignment_id);
CREATE TABLE IF NOT EXISTS ua_cabinet.invites(
 digest text PRIMARY KEY CHECK (digest ~ '^[a-f0-9]{64}$'),group_id uuid NOT NULL REFERENCES ua_private.groups(id),
 recipient_id uuid REFERENCES ua_private.people(id) ON DELETE CASCADE,expires_at timestamptz NOT NULL, created_by uuid NOT NULL REFERENCES ua_private.people(id));
CREATE INDEX IF NOT EXISTS invite_expiry ON ua_cabinet.invites(expires_at);
CREATE TABLE IF NOT EXISTS ua_cabinet.redemptions(
 invite_digest text NOT NULL REFERENCES ua_cabinet.invites(digest) ON DELETE CASCADE,student_id uuid NOT NULL REFERENCES ua_private.people(id) ON DELETE CASCADE,
 command_key text NOT NULL,redeemed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(invite_digest,student_id), UNIQUE(student_id,command_key));
CREATE TABLE IF NOT EXISTS ua_cabinet.private_starts(telegram_id bigint PRIMARY KEY CHECK (telegram_id BETWEEN 1 AND 9007199254740991), started_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ua_cabinet.invite_delivery(
 id uuid PRIMARY KEY,invite_digest text UNIQUE NOT NULL REFERENCES ua_cabinet.invites(digest) ON DELETE CASCADE,
 telegram_id bigint NOT NULL REFERENCES ua_cabinet.private_starts(telegram_id) ON DELETE CASCADE,
 token text NOT NULL CHECK (token ~ '^grp_[A-Za-z0-9_-]{32}$'), status text NOT NULL DEFAULT 'queued'
   CHECK(status IN ('queued','claimed','sent','unconfirmed','rejected','retry')),
 available_at timestamptz NOT NULL DEFAULT now(),claimed_at timestamptz,claim_id uuid UNIQUE);
CREATE INDEX IF NOT EXISTS delivery_ready ON ua_cabinet.invite_delivery(available_at,id) WHERE status IN ('queued','retry');
GRANT SELECT,INSERT ON ua_cabinet.group_requests,ua_cabinet.test_owners,ua_cabinet.media,
 ua_cabinet.assignment_media,ua_cabinet.invites,ua_cabinet.redemptions,ua_cabinet.invite_delivery TO ua_cabinet_stage;
GRANT UPDATE(approved_by,active_group_id) ON ua_cabinet.group_requests TO ua_cabinet_stage;
GRANT SELECT ON ua_cabinet.private_starts TO ua_cabinet_stage;
GRANT SELECT,INSERT ON ua_cabinet.private_starts TO ua_cabinet_delivery;
GRANT SELECT ON ua_cabinet.invites,ua_cabinet.invite_delivery,ua_cabinet.group_requests TO ua_cabinet_delivery;
GRANT SELECT(id,status) ON ua_private.groups TO ua_cabinet_delivery;
GRANT SELECT(person_id,approved) ON ua_private.staff_access TO ua_cabinet_delivery;
GRANT SELECT(person_id,subject_id,approved,revoked_at_ms) ON ua_private.teacher_subject_approvals TO ua_cabinet_delivery;
GRANT SELECT(person_id,group_id,revoked_at_ms) ON ua_private.staff_group_scope TO ua_cabinet_delivery;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['groups','staff_access','teacher_subject_approvals','staff_group_scope'] LOOP
  EXECUTE format('CREATE POLICY cabinet_stage_delivery_read ON ua_private.%I FOR SELECT TO ua_cabinet_delivery USING(true)',t);
 END LOOP;
END $$;
GRANT UPDATE(status,claimed_at,available_at,claim_id) ON ua_cabinet.invite_delivery TO ua_cabinet_delivery;
GRANT SELECT(id,enabled,roles,telegram_id) ON ua_private.people TO ua_cabinet_delivery;
CREATE POLICY cabinet_stage_delivery_people ON ua_private.people FOR SELECT TO ua_cabinet_delivery USING(true);

-- Existing applications keep their captured grants and RLS policies. These server-only
-- capabilities are dormant until a staging operator explicitly provisions service credentials.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['people','groups','memberships','staff_access','teacher_subject_approvals','staff_group_scope','staff_subject_scope',
 'demos','test_versions','draft_questions','assignments','grants','attempts','exam_series','answers','ordinary_results','command_receipts','staff_receipts','staff_audit'] LOOP
  EXECUTE format('GRANT SELECT ON ua_private.%I TO ua_cabinet_stage',t);
  EXECUTE format('CREATE POLICY cabinet_stage_read ON ua_private.%I FOR SELECT TO ua_cabinet_stage USING(true)',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['groups','staff_group_scope','demos','test_versions','draft_questions','assignments','grants','attempts','exam_series','answers','ordinary_results','command_receipts','staff_receipts','staff_audit'] LOOP
  EXECUTE format('GRANT INSERT ON ua_private.%I TO ua_cabinet_stage',t);
  EXECUTE format('CREATE POLICY cabinet_stage_insert ON ua_private.%I FOR INSERT TO ua_cabinet_stage WITH CHECK(true)',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['people','groups','memberships','test_versions','attempts','exam_series','answers'] LOOP
  EXECUTE format('CREATE POLICY cabinet_stage_update ON ua_private.%I FOR UPDATE TO ua_cabinet_stage USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;
GRANT UPDATE(profile) ON ua_private.people TO ua_cabinet_stage;
GRANT UPDATE(revision) ON ua_private.groups TO ua_cabinet_stage;
GRANT UPDATE(affinity_group_id,active,revision,epoch) ON ua_private.memberships TO ua_cabinet_stage;
GRANT UPDATE(revision,status,wire,published_snapshot) ON ua_private.test_versions TO ua_cabinet_stage;
GRANT UPDATE(state_revision,body) ON ua_private.attempts TO ua_cabinet_stage;
GRANT UPDATE(current_attempt_id,generation,state_revision,normal_attempt_used,official_attempt_id,recovery_state,recovery_window) ON ua_private.exam_series TO ua_cabinet_stage;
GRANT UPDATE(selected_option_id,revision,saved_at_ms,series_state_revision) ON ua_private.answers TO ua_cabinet_stage;
-- SELECT ... FOR SHARE requires an update privilege. These policies allow row locks while
-- rejecting writes to authority and enrollment-scope records.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['staff_access','staff_group_scope','teacher_subject_approvals','staff_subject_scope','grants','assignments'] LOOP
  EXECUTE format('GRANT UPDATE(%I) ON ua_private.%I TO ua_cabinet_stage',CASE WHEN t='assignments' THEN 'id' ELSE 'person_id' END,t);
  EXECUTE format('CREATE POLICY cabinet_stage_lock ON ua_private.%I FOR UPDATE TO ua_cabinet_stage USING(true) WITH CHECK(false)',t);
 END LOOP;
END $$;
GRANT SELECT ON ua_private.people_registration TO ua_cabinet_stage;
GRANT EXECUTE ON FUNCTION ua_private.ratio_shape(jsonb) TO ua_cabinet_stage;
-- Private-start consent can precede registration. Deletion/unlinking removes that chat
-- and its outbox; cascading recipient deletion destroys a targeted token rather than unbinding it.
CREATE OR REPLACE FUNCTION ua_cabinet.forget_private_start() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF OLD.telegram_id IS NOT NULL AND (TG_OP='DELETE' OR OLD.telegram_id IS DISTINCT FROM NEW.telegram_id) THEN
  EXECUTE format('DELETE FROM %I.private_starts WHERE telegram_id=$1',TG_ARGV[0]) USING OLD.telegram_id;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ua_cabinet.forget_private_start() FROM PUBLIC;
DROP TRIGGER IF EXISTS cabinet_forget_private_start ON ua_private.people;
CREATE TRIGGER cabinet_forget_private_start AFTER DELETE OR UPDATE OF telegram_id ON ua_private.people
FOR EACH ROW EXECUTE FUNCTION ua_cabinet.forget_private_start('ua_cabinet');
DO $$ BEGIN
 IF to_regprocedure('ua_private.assert_deletion_writable(text,jsonb)') IS NOT NULL THEN
  GRANT EXECUTE ON FUNCTION ua_private.assert_deletion_writable(text,jsonb),ua_private.assert_deletion_staff_writable(jsonb,jsonb) TO ua_cabinet_stage;
 END IF;
END $$;
COMMIT;

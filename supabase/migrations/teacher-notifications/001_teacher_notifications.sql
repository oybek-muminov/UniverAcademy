-- Private, once-per-person teacher role notification. PostgreSQL 17.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('ua.teacher_notifications.001',0));

-- A managed operator can grant a temporary SET edge while retaining its original
-- ADMIN-only membership. A superuser can already SET ROLE in native fixtures.
DO $op$ BEGIN
 IF current_user<>session_user OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
  OR (SELECT nspowner FROM pg_namespace WHERE nspname='ua_cabinet') IS DISTINCT FROM 'ua_owner'::regrole::oid
  OR to_regclass('ua_cabinet.private_starts') IS NULL THEN RAISE EXCEPTION 'Expected managed cabinet and database operator'; END IF;
 IF NOT pg_has_role(current_user,'ua_owner','SET') THEN
  IF NOT EXISTS(SELECT FROM pg_auth_members WHERE member=current_user::regrole AND roleid='ua_owner'::regrole
     AND admin_option AND NOT inherit_option AND NOT set_option AND grantor<>member)
   OR EXISTS(SELECT FROM pg_auth_members WHERE member=current_user::regrole AND roleid='ua_owner'::regrole AND grantor=member)
   THEN RAISE EXCEPTION 'Unexpected ua_owner administration'; END IF;
  GRANT ua_owner TO CURRENT_USER WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY CURRENT_USER;
  PERFORM set_config('ua.notice_temporary_set','yes',true);
 END IF;
END $op$;
SET LOCAL ROLE ua_owner;

DO $restore$ BEGIN
 IF to_regclass('ua_cabinet.teacher_notifications') IS NOT NULL THEN RAISE EXCEPTION 'Teacher notification v1 already installed'; END IF;
 IF to_regclass('ua_private.teacher_notifications_v1_retained') IS NOT NULL THEN
  IF NOT EXISTS(SELECT FROM pg_class WHERE oid='ua_private.teacher_notifications_v1_retained'::regclass
        AND relowner='ua_owner'::regrole AND relkind='r' AND relrowsecurity
        AND obj_description(oid,'pg_class')='UniverAcademy teacher notice v1 retained')
    THEN RAISE EXCEPTION 'Unexpected retained teacher-notification table'; END IF;
  ALTER TABLE ua_private.teacher_notifications_v1_retained SET SCHEMA ua_cabinet;
  ALTER TABLE ua_cabinet.teacher_notifications_v1_retained RENAME TO teacher_notifications;
 END IF;
END $restore$;
CREATE TABLE IF NOT EXISTS ua_cabinet.teacher_notifications(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 person_id uuid UNIQUE REFERENCES ua_private.people(id) ON DELETE SET NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN
   ('queued','retry','blocked','sending','sent','deleting','delete_retry','deleted','expired','rejected','unconfirmed')),
 available_at timestamptz DEFAULT now(),
 claim_id uuid UNIQUE, claimed_at timestamptz,
 chat_id bigint CHECK(chat_id BETWEEN 1 AND 9007199254740991),
 message_id bigint CHECK(message_id BETWEEN 1 AND 9007199254740991),
 sent_at timestamptz, delete_after timestamptz, delete_until timestamptz, blocked_at timestamptz,
 CHECK ((state IN ('sending','deleting')) = (claim_id IS NOT NULL) AND (claim_id IS NULL) = (claimed_at IS NULL)),
 CHECK ((state='blocked') = (blocked_at IS NOT NULL)),
 CHECK (state NOT IN ('queued','retry','delete_retry') OR available_at IS NOT NULL),
 CHECK ((state IN ('sending','sent','deleting','delete_retry')) = (chat_id IS NOT NULL)),
 CHECK ((state IN ('sent','deleting','delete_retry')) = (message_id IS NOT NULL)
   AND (message_id IS NULL) = (sent_at IS NULL) AND (sent_at IS NULL) = (delete_after IS NULL)
   AND (sent_at IS NULL) = (delete_until IS NULL)),
 CHECK (sent_at IS NULL OR (delete_after=sent_at+interval '24 hours' AND delete_until=sent_at+interval '48 hours'))
);
COMMENT ON TABLE ua_cabinet.teacher_notifications IS 'Private teacher notice outbox v1. Terminal rows only deduplicate by person.';
CREATE INDEX IF NOT EXISTS teacher_notice_due ON ua_cabinet.teacher_notifications(available_at,id) WHERE state IN('queued','retry');
CREATE INDEX IF NOT EXISTS teacher_notice_delete_due ON ua_cabinet.teacher_notifications(delete_after,id) WHERE state IN('sent','delete_retry');
CREATE INDEX IF NOT EXISTS teacher_notice_cleanup ON ua_cabinet.teacher_notifications(delete_until,id) WHERE state IN('sent','delete_retry','deleting');
CREATE INDEX IF NOT EXISTS teacher_notice_claim_age ON ua_cabinet.teacher_notifications(claimed_at,id) WHERE state IN('sending','deleting');
ALTER TABLE ua_cabinet.teacher_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY teacher_notice_delivery_read ON ua_cabinet.teacher_notifications FOR SELECT TO ua_cabinet_delivery USING(true);
CREATE POLICY teacher_notice_delivery_update ON ua_cabinet.teacher_notifications FOR UPDATE TO ua_cabinet_delivery USING(true) WITH CHECK(true);
REVOKE ALL ON ua_cabinet.teacher_notifications FROM PUBLIC;
GRANT SELECT ON ua_cabinet.teacher_notifications TO ua_cabinet_delivery;
GRANT UPDATE(state,available_at,claim_id,claimed_at,chat_id,message_id,sent_at,delete_after,delete_until,blocked_at)
 ON ua_cabinet.teacher_notifications TO ua_cabinet_delivery;

-- Only the object owner can use this policy. Its trigger reads at most the
-- current person's active subject grants even on the canonical FORCE-RLS table.
CREATE POLICY teacher_notice_subject_probe ON ua_private.teacher_subject_approvals
 FOR SELECT TO ua_owner USING (approved AND revoked_at_ms IS NULL AND
 person_id = nullif(current_setting('ua.teacher_notice_person',true),'')::uuid);

CREATE FUNCTION ua_cabinet.enqueue_teacher_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE person uuid; previous_scope text; has_subject boolean;
BEGIN
 IF TG_TABLE_NAME='people' THEN person=NEW.id; ELSE person=NEW.person_id; END IF;
 IF TG_TABLE_NAME<>'teacher_subject_approvals' THEN
  previous_scope=current_setting('ua.teacher_notice_person',true);
  PERFORM set_config('ua.teacher_notice_person',person::text,true);
  SELECT EXISTS(SELECT FROM ua_private.teacher_subject_approvals
    WHERE person_id=person AND approved AND revoked_at_ms IS NULL) INTO has_subject;
  PERFORM set_config('ua.teacher_notice_person',coalesce(previous_scope,''),true);
  IF NOT has_subject THEN RETURN NULL; END IF;
 END IF;
 -- The positive subject grant itself leaves a candidate even if role/access
 -- are completed in another transaction. The claim checks all three again.
 INSERT INTO ua_cabinet.teacher_notifications(person_id) VALUES(person) ON CONFLICT(person_id) DO NOTHING;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION ua_cabinet.enqueue_teacher_notification() FROM PUBLIC;
CREATE TRIGGER teacher_notice_subject_grant AFTER INSERT OR UPDATE OF approved,revoked_at_ms,person_id
 ON ua_private.teacher_subject_approvals FOR EACH ROW WHEN(NEW.approved AND NEW.revoked_at_ms IS NULL)
 EXECUTE FUNCTION ua_cabinet.enqueue_teacher_notification();
CREATE TRIGGER teacher_notice_staff_grant AFTER INSERT OR UPDATE OF approved,person_id
 ON ua_private.staff_access FOR EACH ROW WHEN(NEW.approved) EXECUTE FUNCTION ua_cabinet.enqueue_teacher_notification();
CREATE TRIGGER teacher_notice_person_grant AFTER INSERT OR UPDATE OF roles,enabled
 ON ua_private.people FOR EACH ROW WHEN(NEW.enabled AND 'teacher'=ANY(NEW.roles))
 EXECUTE FUNCTION ua_cabinet.enqueue_teacher_notification();

-- Called by the verified private bot /start transaction after its consent write.
-- Repeated /start calls also wake a 403 even if the original evidence exists.
CREATE FUNCTION ua_cabinet.wake_teacher_notification(linked_chat bigint) RETURNS void
LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 UPDATE ua_cabinet.teacher_notifications n SET state='queued',available_at=clock_timestamp(),blocked_at=NULL
 FROM ua_private.people p JOIN ua_cabinet.private_starts c ON c.telegram_id=p.telegram_id
 WHERE n.person_id=p.id AND p.enabled AND 'teacher'=ANY(p.roles)
 AND p.telegram_id=linked_chat AND n.state='blocked';
$fn$;
REVOKE ALL ON FUNCTION ua_cabinet.wake_teacher_notification(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ua_cabinet.wake_teacher_notification(bigint) TO ua_cabinet_delivery;

-- Rebinding after a definite denial may make the newly linked chat reachable.
-- Any confirmed or in-flight send retains its original Telegram destination.
CREATE FUNCTION ua_cabinet.teacher_notice_relinked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
 UPDATE ua_cabinet.teacher_notifications SET state='queued',available_at=clock_timestamp(),blocked_at=NULL
 WHERE person_id=NEW.id AND state='blocked';
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION ua_cabinet.teacher_notice_relinked() FROM PUBLIC;
CREATE TRIGGER teacher_notice_relinked AFTER UPDATE OF telegram_id ON ua_private.people
 FOR EACH ROW WHEN(NEW.telegram_id IS NOT NULL AND NEW.telegram_id IS DISTINCT FROM OLD.telegram_id)
 EXECUTE FUNCTION ua_cabinet.teacher_notice_relinked();

CREATE FUNCTION ua_cabinet.guard_teacher_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
 IF (OLD.state IN ('unconfirmed','deleted','expired','rejected') AND NEW.state<>OLD.state)
  OR (OLD.state='sending' AND NEW.state IN('sending','sent') AND NEW.chat_id IS DISTINCT FROM OLD.chat_id)
  OR (OLD.state IN ('sent','deleting','delete_retry') AND
      (NEW.state NOT IN('sent','deleting','delete_retry','deleted','expired','rejected')
       OR (NEW.state IN('sent','deleting','delete_retry') AND
          ROW(NEW.chat_id,NEW.message_id,NEW.sent_at,NEW.delete_after,NEW.delete_until)
           IS DISTINCT FROM ROW(OLD.chat_id,OLD.message_id,OLD.sent_at,OLD.delete_after,OLD.delete_until))))
 THEN RAISE EXCEPTION 'Invalid teacher notification receipt transition'; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION ua_cabinet.guard_teacher_receipt() FROM PUBLIC;
CREATE TRIGGER teacher_notice_guard_receipt BEFORE UPDATE ON ua_cabinet.teacher_notifications
 FOR EACH ROW EXECUTE FUNCTION ua_cabinet.guard_teacher_receipt();

CREATE FUNCTION ua_cabinet.forget_finished_teacher_notice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
 DELETE FROM ua_cabinet.teacher_notifications WHERE id=NEW.id AND person_id IS NULL
  AND state NOT IN('sending','sent','deleting','delete_retry');
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION ua_cabinet.forget_finished_teacher_notice() FROM PUBLIC;
CREATE TRIGGER teacher_notice_orphan AFTER UPDATE ON ua_cabinet.teacher_notifications
 FOR EACH ROW WHEN(NEW.person_id IS NULL AND NEW.state NOT IN('sending','sent','deleting','delete_retry'))
 EXECUTE FUNCTION ua_cabinet.forget_finished_teacher_notice();

-- An installation restored after a full cabinet rollback can contain anonymous
-- tombstones for people who were deleted while the feature was withdrawn.
DELETE FROM ua_cabinet.teacher_notifications WHERE person_id IS NULL
 AND state NOT IN ('sending','sent','deleting','delete_retry');
DO $verify_acl$
DECLARE who text;
BEGIN
 IF EXISTS (SELECT FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE c.oid='ua_cabinet.teacher_notifications'::regclass
     AND a.grantee NOT IN('ua_owner'::regrole,'ua_cabinet_delivery'::regrole))
 OR EXISTS (SELECT FROM pg_attribute c CROSS JOIN LATERAL aclexplode(c.attacl) a
   WHERE c.attrelid='ua_cabinet.teacher_notifications'::regclass
     AND a.grantee NOT IN('ua_owner'::regrole,'ua_cabinet_delivery'::regrole))
 THEN RAISE EXCEPTION 'Unexpected default privilege on private teacher notices'; END IF;
 FOREACH who IN ARRAY ARRAY['anon','authenticated','service_role','ua_api_login','ua_runtime','ua_cabinet_stage'] LOOP
  IF to_regrole(who) IS NOT NULL AND
   (has_any_column_privilege(who,'ua_cabinet.teacher_notifications','SELECT,INSERT,UPDATE')
    OR has_table_privilege(who,'ua_cabinet.teacher_notifications','DELETE,TRUNCATE,TRIGGER')
    OR has_function_privilege(who,'ua_cabinet.wake_teacher_notification(bigint)','EXECUTE'))
   THEN RAISE EXCEPTION 'Unexpected access to teacher notifications: %',who; END IF;
 END LOOP;
END $verify_acl$;

-- All three grant tables are now locked by CREATE TRIGGER. Take the existing
-- eligibility snapshot using the managed operator's read-only BYPASSRLS access.
RESET ROLE;
CREATE TEMP TABLE teacher_notification_backfill ON COMMIT DROP AS
 SELECT DISTINCT p.id FROM ua_private.teacher_subject_approvals s
 JOIN ua_private.staff_access a ON a.person_id=s.person_id AND a.approved
 JOIN ua_private.people p ON p.id=s.person_id AND p.enabled AND 'teacher'=ANY(p.roles)
 WHERE s.approved AND s.revoked_at_ms IS NULL;
GRANT SELECT ON pg_temp.teacher_notification_backfill TO ua_owner;
SET LOCAL ROLE ua_owner;
INSERT INTO ua_cabinet.teacher_notifications(person_id) SELECT id FROM pg_temp.teacher_notification_backfill
 ON CONFLICT(person_id) DO NOTHING;
RESET ROLE;
DO $op$ BEGIN
 IF current_setting('ua.notice_temporary_set',true)='yes' THEN
  REVOKE ua_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
  IF pg_has_role(current_user,'ua_owner','SET') THEN RAISE EXCEPTION 'Temporary owner access survived'; END IF;
 END IF;
END $op$;
COMMIT;

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

-- Withdraw the delivery feature before withdrawing the legacy eight-table cabinet.
LOCK TABLE ua_cabinet.teacher_notifications IN ACCESS EXCLUSIVE MODE;
DO $drain$ BEGIN
 IF EXISTS(SELECT FROM ua_cabinet.teacher_notifications WHERE state IN('sending','sent','deleting','delete_retry'))
  THEN RAISE EXCEPTION 'Drain in-flight sends and required Telegram deletions before withdrawal'; END IF;
END $drain$;
DROP TRIGGER teacher_notice_person_grant ON ua_private.people;
DROP TRIGGER teacher_notice_staff_grant ON ua_private.staff_access;
DROP TRIGGER teacher_notice_subject_grant ON ua_private.teacher_subject_approvals;
DROP TRIGGER teacher_notice_relinked ON ua_private.people;
DROP TRIGGER teacher_notice_guard_receipt ON ua_cabinet.teacher_notifications;
DROP TRIGGER teacher_notice_orphan ON ua_cabinet.teacher_notifications;
DROP FUNCTION ua_cabinet.enqueue_teacher_notification(),ua_cabinet.teacher_notice_relinked(),
 ua_cabinet.forget_finished_teacher_notice(),ua_cabinet.guard_teacher_receipt(),ua_cabinet.wake_teacher_notification(bigint);
DROP POLICY teacher_notice_subject_probe ON ua_private.teacher_subject_approvals;
DROP POLICY teacher_notice_delivery_read ON ua_cabinet.teacher_notifications;
DROP POLICY teacher_notice_delivery_update ON ua_cabinet.teacher_notifications;
REVOKE ALL ON ua_cabinet.teacher_notifications FROM ua_cabinet_delivery;
REVOKE UPDATE(state,available_at,claim_id,claimed_at,chat_id,message_id,sent_at,delete_after,delete_until,blocked_at)
 ON ua_cabinet.teacher_notifications FROM ua_cabinet_delivery;
ALTER TABLE ua_cabinet.teacher_notifications SET SCHEMA ua_private;
ALTER TABLE ua_private.teacher_notifications RENAME TO teacher_notifications_v1_retained;
COMMENT ON TABLE ua_private.teacher_notifications_v1_retained IS 'UniverAcademy teacher notice v1 retained';
RESET ROLE;
DO $op$ BEGIN
 IF current_setting('ua.notice_temporary_set',true)='yes' THEN
  REVOKE ua_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
  IF pg_has_role(current_user,'ua_owner','SET') THEN RAISE EXCEPTION 'Temporary owner access survived'; END IF;
 END IF;
END $op$;
COMMIT;

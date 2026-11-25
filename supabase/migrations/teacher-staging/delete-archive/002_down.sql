-- Withdraw unstarted-assignment deletion (run before 001_down.sql).
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('ua.cabinet_delete_archive.v2',0));
DO $operator$ BEGIN
 IF current_user<>session_user OR to_regclass('ua_cabinet.test_owners') IS NULL
    OR (SELECT relowner FROM pg_class WHERE oid='ua_private.draft_questions'::regclass)<>'ua_owner'::regrole
    OR (SELECT relowner FROM pg_class WHERE oid='ua_private.demos'::regclass)<>'ua_owner'::regrole
 THEN RAISE EXCEPTION 'Expected installed teacher cabinet on the canonical catalog'; END IF;
 IF NOT pg_has_role(current_user,'ua_owner','SET') THEN
   IF NOT EXISTS(SELECT FROM pg_auth_members WHERE member=current_user::regrole AND roleid='ua_owner'::regrole
       AND admin_option AND NOT inherit_option AND NOT set_option AND grantor<>member)
      OR EXISTS(SELECT FROM pg_auth_members WHERE member=current_user::regrole AND roleid='ua_owner'::regrole AND grantor=member)
   THEN RAISE EXCEPTION 'Unexpected ua_owner administration'; END IF;
   GRANT ua_owner TO CURRENT_USER WITH ADMIN FALSE,INHERIT FALSE,SET TRUE GRANTED BY CURRENT_USER;
   PERFORM set_config('ua.delete_archive2_temporary_set','yes',true);
 END IF;
END $operator$;
SET LOCAL ROLE ua_owner;

DROP POLICY cabinet_delete_unstarted_assignment ON ua_private.assignments;
DROP POLICY cabinet_delete_unstarted_grant ON ua_private.grants;
REVOKE DELETE ON ua_private.assignments,ua_private.grants,ua_cabinet.assignment_media FROM ua_cabinet_stage;

RESET ROLE;
DO $operator$ BEGIN
 IF current_setting('ua.delete_archive2_temporary_set',true)='yes' THEN
   REVOKE ua_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
   IF pg_has_role(current_user,'ua_owner','SET') THEN RAISE EXCEPTION 'Temporary owner access survived'; END IF;
 END IF;
END $operator$;
COMMIT;

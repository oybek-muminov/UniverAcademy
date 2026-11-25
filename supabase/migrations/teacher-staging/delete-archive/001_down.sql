-- Withdraw group/test removal and drain its transactions before running this rollback.
-- Already archived tests (ua_cabinet.test_archive) are kept as they are.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('ua.cabinet_delete_archive.v1',0));
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
   PERFORM set_config('ua.delete_archive_temporary_set','yes',true);
 END IF;
END $operator$;
SET LOCAL ROLE ua_owner;

DROP POLICY cabinet_delete_group ON ua_private.groups;
DROP POLICY cabinet_delete_group_scope ON ua_private.staff_group_scope;
DROP POLICY cabinet_delete_test_question ON ua_private.draft_questions;
DROP POLICY cabinet_delete_test_version ON ua_private.test_versions;
DROP POLICY cabinet_delete_test_demo ON ua_private.demos;
REVOKE DELETE ON ua_private.groups,ua_private.staff_group_scope,ua_private.test_versions,ua_private.demos FROM ua_cabinet_stage;
-- draft_questions deletion also belongs to the draft editor; keep that grant only when its policy is still installed.
DO $d$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='ua_private' AND tablename='draft_questions' AND policyname='cabinet_edit_question_delete') THEN
  REVOKE DELETE ON ua_private.draft_questions FROM ua_cabinet_stage;
 END IF;
END $d$;
REVOKE DELETE ON ua_cabinet.group_requests,ua_cabinet.invites,ua_cabinet.test_owners FROM ua_cabinet_stage;
REVOKE UPDATE(status) ON ua_private.groups FROM ua_cabinet_stage;
-- The archive table stays: archived tests remain hidden and keep their results. Only new archiving stops.
REVOKE INSERT ON ua_cabinet.test_archive FROM ua_cabinet_stage;
DROP FUNCTION ua_cabinet.acting_teacher();

RESET ROLE;
DO $operator$ BEGIN
 IF current_setting('ua.delete_archive_temporary_set',true)='yes' THEN
   REVOKE ua_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
   IF pg_has_role(current_user,'ua_owner','SET') THEN RAISE EXCEPTION 'Temporary owner access survived'; END IF;
 END IF;
END $operator$;
COMMIT;

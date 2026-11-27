-- Withdraw the Owner's teacher assignment. Drain Owner-site transactions before running this rollback.
-- Teachers already assigned keep their role; only the assignment path is removed.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('ua.owner_assign_teacher.001',0));
DO $op$ BEGIN
 IF current_user<>session_user OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
  OR to_regprocedure('ua_cabinet.owner_assign_teacher(uuid,uuid,text)') IS NULL THEN RAISE EXCEPTION 'Expected installed owner teacher assignment'; END IF;
 IF NOT pg_has_role(current_user,'ua_owner','SET') THEN
  IF NOT EXISTS(SELECT FROM pg_auth_members WHERE member=current_user::regrole AND roleid='ua_owner'::regrole
     AND admin_option AND NOT inherit_option AND NOT set_option AND grantor<>member)
   OR EXISTS(SELECT FROM pg_auth_members WHERE member=current_user::regrole AND roleid='ua_owner'::regrole AND grantor=member)
   THEN RAISE EXCEPTION 'Unexpected ua_owner administration'; END IF;
  GRANT ua_owner TO CURRENT_USER WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY CURRENT_USER;
  PERFORM set_config('ua.owner_assign_temporary_set','yes',true);
 END IF;
END $op$;
SET LOCAL ROLE ua_owner;
DROP FUNCTION ua_cabinet.owner_assign_teacher(uuid,uuid,text);
DROP POLICY owner_assign_people_read ON ua_private.people;
DROP POLICY owner_assign_people_update ON ua_private.people;
DROP POLICY owner_assign_access_read ON ua_private.staff_access;
DROP POLICY owner_assign_access_insert ON ua_private.staff_access;
DROP POLICY owner_assign_subject_insert ON ua_private.teacher_subject_approvals;
DROP POLICY owner_assign_scope_insert ON ua_private.staff_subject_scope;
DROP POLICY owner_assign_membership_read ON ua_private.memberships;
RESET ROLE;
DO $op$ BEGIN
 IF current_setting('ua.owner_assign_temporary_set',true)='yes' THEN
  REVOKE ua_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
  IF pg_has_role(current_user,'ua_owner','SET') THEN RAISE EXCEPTION 'Temporary owner access survived'; END IF;
 END IF;
END $op$;
COMMIT;

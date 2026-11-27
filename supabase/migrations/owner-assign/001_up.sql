-- Owner assigns the Teacher role. Apply after teacher-staging and teacher-notifications; PostgreSQL 17.
-- The cabinet server role still has NO write access to people roles or staff_access. It may only call
-- ua_cabinet.owner_assign_teacher(), which re-checks that the caller is the signed-in Owner of this
-- transaction and changes exactly one eligible student into a Teacher.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('ua.owner_assign_teacher.001',0));
DO $op$ BEGIN
 IF current_user<>session_user OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
  OR (SELECT nspowner FROM pg_namespace WHERE nspname='ua_cabinet') IS DISTINCT FROM 'ua_owner'::regrole::oid
  OR to_regclass('ua_cabinet.teacher_notifications') IS NULL
  OR to_regprocedure('ua_private.enforce_single_role()') IS NULL THEN RAISE EXCEPTION 'Expected managed cabinet, teacher notices, single-role rule and database operator'; END IF;
 IF to_regprocedure('ua_cabinet.owner_assign_teacher(uuid,uuid,text)') IS NOT NULL THEN RAISE EXCEPTION 'Owner teacher assignment already installed'; END IF;
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

-- These policies bind only the table owner (the function owner). They are open for exactly one
-- person each, named by settings that the function itself writes after it has verified the Owner.
CREATE POLICY owner_assign_people_read ON ua_private.people FOR SELECT TO ua_owner
 USING (id::text IN (current_setting('ua.assign_actor',true),current_setting('ua.assign_target',true)));
CREATE POLICY owner_assign_people_update ON ua_private.people FOR UPDATE TO ua_owner
 USING (id::text=current_setting('ua.assign_target',true) AND enabled AND roles=ARRAY['student']::text[])
 WITH CHECK (id::text=current_setting('ua.assign_target',true) AND enabled AND roles=ARRAY['teacher']::text[]);
CREATE POLICY owner_assign_access_read ON ua_private.staff_access FOR SELECT TO ua_owner
 USING (person_id::text=current_setting('ua.assign_actor',true));
CREATE POLICY owner_assign_access_insert ON ua_private.staff_access FOR INSERT TO ua_owner
 WITH CHECK (person_id::text=current_setting('ua.assign_target',true) AND approved
  AND NOT manage_roster AND NOT manage_content AND NOT all_groups AND NOT all_subjects);
CREATE POLICY owner_assign_subject_insert ON ua_private.teacher_subject_approvals FOR INSERT TO ua_owner
 WITH CHECK (person_id::text=current_setting('ua.assign_target',true) AND approved AND revoked_at_ms IS NULL AND subject_id='physics');
CREATE POLICY owner_assign_scope_insert ON ua_private.staff_subject_scope FOR INSERT TO ua_owner
 WITH CHECK (person_id::text=current_setting('ua.assign_target',true) AND revoked_at_ms IS NULL AND subject_id='physics');
CREATE POLICY owner_assign_membership_read ON ua_private.memberships FOR SELECT TO ua_owner
 USING (person_id::text=current_setting('ua.assign_target',true));

CREATE FUNCTION ua_cabinet.owner_assign_teacher(p_actor uuid, p_target uuid, p_subject text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE target record; changed integer;
BEGIN
 -- Only inside the signed-in Owner's own domain transaction, never for oneself.
 IF current_setting('ua.phase',true) IS DISTINCT FROM 'domain' OR p_actor IS NULL OR p_target IS NULL
    OR current_setting('ua.person_id',true) IS DISTINCT FROM p_actor::text OR p_actor=p_target
  THEN RAISE EXCEPTION 'ASSIGN_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF p_subject IS DISTINCT FROM 'physics' THEN RAISE EXCEPTION 'ASSIGN_SUBJECT_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM set_config('ua.assign_actor',p_actor::text,true);
 IF NOT EXISTS(SELECT FROM ua_private.people p JOIN ua_private.staff_access a ON a.person_id=p.id
    WHERE p.id=p_actor AND p.enabled AND p.roles=ARRAY['owner']::text[] AND a.approved)
  THEN RAISE EXCEPTION 'ASSIGN_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM set_config('ua.assign_target',p_target::text,true);
 SELECT p.enabled,p.roles,(p.profile->>'registration_complete')='true' AS complete,
        EXISTS(SELECT FROM ua_private.memberships m WHERE m.person_id=p.id AND m.active) AS grouped
   INTO target FROM ua_private.people p WHERE p.id=p_target;
 IF NOT FOUND OR NOT target.enabled THEN RAISE EXCEPTION 'ASSIGN_TARGET_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF target.roles IS DISTINCT FROM ARRAY['student']::text[] THEN RAISE EXCEPTION 'ASSIGN_TARGET_NOT_STUDENT' USING ERRCODE='P0001'; END IF;
 IF NOT target.complete THEN RAISE EXCEPTION 'ASSIGN_TARGET_INCOMPLETE' USING ERRCODE='P0001'; END IF;
 IF target.grouped THEN RAISE EXCEPTION 'ASSIGN_TARGET_IN_GROUP' USING ERRCODE='P0001'; END IF;
 UPDATE ua_private.people SET roles=ARRAY['teacher']::text[] WHERE id=p_target AND enabled AND roles=ARRAY['student']::text[];
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>1 THEN RAISE EXCEPTION 'ASSIGN_TARGET_NOT_STUDENT' USING ERRCODE='P0001'; END IF;
 INSERT INTO ua_private.staff_access(person_id,approved,manage_roster,manage_content,all_groups,all_subjects)
  VALUES(p_target,true,false,false,false,false);
 INSERT INTO ua_private.teacher_subject_approvals(person_id,subject_id,approved,revoked_at_ms) VALUES(p_target,p_subject,true,NULL);
 INSERT INTO ua_private.staff_subject_scope(person_id,subject_id,revoked_at_ms) VALUES(p_target,p_subject,NULL);
 PERFORM set_config('ua.assign_actor','',true);
 PERFORM set_config('ua.assign_target','',true);
END $fn$;
REVOKE ALL ON FUNCTION ua_cabinet.owner_assign_teacher(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ua_cabinet.owner_assign_teacher(uuid,uuid,text) TO ua_cabinet_stage;

RESET ROLE;
DO $op$ BEGIN
 IF current_setting('ua.owner_assign_temporary_set',true)='yes' THEN
  REVOKE ua_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
  IF pg_has_role(current_user,'ua_owner','SET') THEN RAISE EXCEPTION 'Temporary owner access survived'; END IF;
 END IF;
END $op$;
COMMIT;

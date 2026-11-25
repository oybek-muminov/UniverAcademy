-- Apply after teacher-staging installation (and the draft editor), before publishing group/test removal.
-- Teachers may delete their own EMPTY group or never-assigned test for good. Anything that students
-- already worked on is archived instead: the group status becomes 'archived', a test is listed in ua_cabinet.test_archive.
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

-- The acting teacher, only inside the server's domain phase for an approved, enabled teacher.
CREATE FUNCTION ua_cabinet.acting_teacher() RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT p.id FROM ua_private.people p
 JOIN ua_private.staff_access a ON a.person_id=p.id AND a.approved
 WHERE p.enabled AND 'teacher'=ANY(p.roles) AND current_setting('ua.phase',true)='domain'
   AND p.id::text=current_setting('ua.person_id',true)
$f$;
REVOKE ALL ON FUNCTION ua_cabinet.acting_teacher() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ua_cabinet.acting_teacher() TO ua_cabinet_stage;

-- Archived tests stay in the database with their assignments and results; the teacher no longer sees or edits them.
CREATE TABLE IF NOT EXISTS ua_cabinet.test_archive(
 version_id uuid PRIMARY KEY REFERENCES ua_private.test_versions(id),
 archived_by uuid NOT NULL REFERENCES ua_private.people(id),
 archived_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT,INSERT ON ua_cabinet.test_archive TO ua_cabinet_stage;
-- Group requests, invitations and test ownership rows are plain cabinet tables without row policies.
GRANT DELETE ON ua_cabinet.group_requests,ua_cabinet.invites,ua_cabinet.test_owners TO ua_cabinet_stage;
GRANT UPDATE(status) ON ua_private.groups TO ua_cabinet_stage;
GRANT DELETE ON ua_private.groups,ua_private.staff_group_scope,ua_private.draft_questions,ua_private.test_versions,ua_private.demos TO ua_cabinet_stage;

-- A group disappears only when it is the acting teacher's own, has no member and never had a test assigned.
CREATE POLICY cabinet_delete_group ON ua_private.groups FOR DELETE TO ua_cabinet_stage
 USING (EXISTS(SELECT FROM ua_cabinet.group_requests r WHERE r.active_group_id=groups.id AND r.teacher_id=ua_cabinet.acting_teacher())
   AND NOT EXISTS(SELECT FROM ua_private.assignments a WHERE a.group_id=groups.id)
   AND NOT EXISTS(SELECT FROM ua_private.memberships m WHERE m.affinity_group_id=groups.id));
CREATE POLICY cabinet_delete_group_scope ON ua_private.staff_group_scope FOR DELETE TO ua_cabinet_stage
 USING (person_id=ua_cabinet.acting_teacher() AND NOT EXISTS(SELECT FROM ua_private.assignments a WHERE a.group_id=staff_group_scope.group_id));

-- A test disappears only when it is the acting teacher's own and was never assigned to any group.
CREATE POLICY cabinet_delete_test_question ON ua_private.draft_questions FOR DELETE TO ua_cabinet_stage
 USING (EXISTS(SELECT FROM ua_cabinet.test_owners o WHERE o.version_id=draft_questions.version_id AND o.teacher_id=ua_cabinet.acting_teacher())
   AND NOT EXISTS(SELECT FROM ua_private.assignments a WHERE a.version_id=draft_questions.version_id));
CREATE POLICY cabinet_delete_test_version ON ua_private.test_versions FOR DELETE TO ua_cabinet_stage
 USING (EXISTS(SELECT FROM ua_cabinet.test_owners o WHERE o.version_id=test_versions.id AND o.teacher_id=ua_cabinet.acting_teacher())
   AND NOT EXISTS(SELECT FROM ua_private.assignments a WHERE a.version_id=test_versions.id));
CREATE POLICY cabinet_delete_test_demo ON ua_private.demos FOR DELETE TO ua_cabinet_stage
 USING (EXISTS(SELECT FROM ua_private.test_versions v JOIN ua_cabinet.test_owners o ON o.version_id=v.id AND o.teacher_id=ua_cabinet.acting_teacher() WHERE v.demo_id=demos.id)
   AND NOT EXISTS(SELECT FROM ua_private.test_versions v LEFT JOIN ua_cabinet.test_owners o ON o.version_id=v.id AND o.teacher_id=ua_cabinet.acting_teacher()
     WHERE v.demo_id=demos.id AND o.version_id IS NULL)
   AND NOT EXISTS(SELECT FROM ua_private.assignments a WHERE a.demo_id=demos.id)
   AND NOT EXISTS(SELECT FROM ua_private.exam_series s WHERE s.demo_id=demos.id));

RESET ROLE;
DO $operator$ BEGIN
 IF current_setting('ua.delete_archive_temporary_set',true)='yes' THEN
   REVOKE ua_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
   IF pg_has_role(current_user,'ua_owner','SET') THEN RAISE EXCEPTION 'Temporary owner access survived'; END IF;
 END IF;
END $operator$;
COMMIT;

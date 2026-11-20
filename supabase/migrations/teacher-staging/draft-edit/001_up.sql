-- Apply after teacher-staging installation or restore, before publishing the draft editor.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('ua.cabinet_draft_edit.v1',0));
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
   PERFORM set_config('ua.draft_edit_temporary_set','yes',true);
 END IF;
END $operator$;
SET LOCAL ROLE ua_owner;

-- Only the isolated server role can replace canonical questions and rename a single-version draft.
CREATE POLICY cabinet_edit_question_delete ON ua_private.draft_questions FOR DELETE TO ua_cabinet_stage
 USING (EXISTS (
   SELECT FROM ua_private.test_versions v
   JOIN ua_cabinet.test_owners o ON o.version_id=v.id
   JOIN ua_private.people p ON p.id=o.teacher_id AND p.enabled AND 'teacher'=ANY(p.roles)
   JOIN ua_private.staff_access a ON a.person_id=p.id AND a.approved
   JOIN ua_private.teacher_subject_approvals s ON s.person_id=p.id AND s.approved AND s.revoked_at_ms IS NULL
   JOIN ua_private.demos d ON d.id=v.demo_id AND d.subject_id=s.subject_id
   WHERE v.id=draft_questions.version_id AND v.status='draft' AND (v.published_snapshot IS NULL OR v.published_snapshot='null'::jsonb)
     AND current_setting('ua.phase',true)='domain' AND p.id::text=current_setting('ua.person_id',true)
 ));
CREATE POLICY cabinet_edit_demo_title ON ua_private.demos FOR UPDATE TO ua_cabinet_stage
 USING (EXISTS (
   SELECT FROM ua_private.test_versions v
   JOIN ua_cabinet.test_owners o ON o.version_id=v.id
   JOIN ua_private.people p ON p.id=o.teacher_id AND p.enabled AND 'teacher'=ANY(p.roles)
   JOIN ua_private.staff_access a ON a.person_id=p.id AND a.approved
   JOIN ua_private.teacher_subject_approvals s ON s.person_id=p.id AND s.approved AND s.revoked_at_ms IS NULL
   WHERE v.demo_id=demos.id AND s.subject_id=demos.subject_id AND v.status='draft' AND (v.published_snapshot IS NULL OR v.published_snapshot='null'::jsonb)
     AND current_setting('ua.phase',true)='domain' AND p.id::text=current_setting('ua.person_id',true)
     AND NOT EXISTS(SELECT FROM ua_private.test_versions sibling WHERE sibling.demo_id=v.demo_id AND sibling.id<>v.id)
 ));
GRANT DELETE ON ua_private.draft_questions TO ua_cabinet_stage;
GRANT UPDATE(title) ON ua_private.demos TO ua_cabinet_stage;

RESET ROLE;
DO $operator$ BEGIN
 IF current_setting('ua.draft_edit_temporary_set',true)='yes' THEN
   REVOKE ua_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
   IF pg_has_role(current_user,'ua_owner','SET') THEN RAISE EXCEPTION 'Temporary owner access survived'; END IF;
 END IF;
END $operator$;
COMMIT;

-- Stop and drain both staging service pools first. Preserve group ownership, outstanding
-- invite history and private media on rollback. Canonical exams/scores keep their FKs.
BEGIN;
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['people','groups','memberships','staff_access','teacher_subject_approvals','staff_group_scope','staff_subject_scope','demos','test_versions','draft_questions','assignments','grants','attempts','exam_series','answers','ordinary_results','command_receipts','staff_receipts','staff_audit'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS cabinet_stage_delivery_read ON ua_private.%I',t);
  EXECUTE format('REVOKE ALL ON ua_private.%I FROM ua_cabinet_delivery',t);
  EXECUTE format('DROP POLICY IF EXISTS cabinet_stage_lock ON ua_private.%I',t);
  EXECUTE format('DROP POLICY IF EXISTS cabinet_stage_read ON ua_private.%I',t);
  EXECUTE format('DROP POLICY IF EXISTS cabinet_stage_insert ON ua_private.%I',t);
  EXECUTE format('DROP POLICY IF EXISTS cabinet_stage_update ON ua_private.%I',t);
  EXECUTE format('REVOKE ALL ON ua_private.%I FROM ua_cabinet_stage',t);
 END LOOP;
END $$;
DROP POLICY cabinet_stage_delivery_people ON ua_private.people;
DO $$ BEGIN
 IF to_regprocedure('ua_private.assert_deletion_writable(text,jsonb)') IS NOT NULL THEN
  REVOKE EXECUTE ON FUNCTION ua_private.assert_deletion_writable(text,jsonb),ua_private.assert_deletion_staff_writable(jsonb,jsonb) FROM ua_cabinet_stage;
 END IF;
END $$;
REVOKE EXECUTE ON FUNCTION ua_private.ratio_shape(jsonb) FROM ua_cabinet_stage;
REVOKE ALL ON ua_private.people_registration FROM ua_cabinet_stage;
REVOKE SELECT(id,enabled,roles,telegram_id) ON ua_private.people FROM ua_cabinet_delivery;
REVOKE ALL ON ALL TABLES IN SCHEMA ua_cabinet FROM ua_cabinet_stage,ua_cabinet_delivery;
REVOKE ALL ON SCHEMA ua_cabinet,ua_private FROM ua_cabinet_stage,ua_cabinet_delivery;
ALTER SCHEMA ua_cabinet RENAME TO ua_cabinet_retained;
DROP TRIGGER cabinet_forget_private_start ON ua_private.people;
CREATE TRIGGER cabinet_forget_private_start AFTER DELETE OR UPDATE OF telegram_id ON ua_private.people
FOR EACH ROW EXECUTE FUNCTION ua_cabinet_retained.forget_private_start('ua_cabinet_retained');
COMMIT;

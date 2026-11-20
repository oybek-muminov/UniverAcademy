-- For the reviewed deletion subsystem when it is installed after this migration.
DO $$ BEGIN
 IF to_regprocedure('ua_private.assert_deletion_writable(text,jsonb)') IS NOT NULL THEN
  GRANT EXECUTE ON FUNCTION ua_private.assert_deletion_writable(text,jsonb),ua_private.assert_deletion_staff_writable(jsonb,jsonb) TO ua_cabinet_stage;
 END IF;
END $$;

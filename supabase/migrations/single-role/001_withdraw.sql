-- "Bitta odam - bitta rol" qoidasini qaytarish. Ma'lumotlar tiklanmaydi: xodim rolidagi odamga 'student' roli qaytarilmaydi.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('ua.single_role.001',0));
DO $op$ DECLARE cap text;
BEGIN
 IF current_user<>session_user OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
  OR NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='ua_private.people'::regclass AND tgname='single_role_normalize')
  THEN RAISE EXCEPTION 'Single-role rule is not installed or operator is unexpected'; END IF;
 FOREACH cap IN ARRAY ARRAY['ua_owner','ua_access_locator_owner'] LOOP
  IF NOT pg_has_role(current_user,cap,'SET') THEN
   IF NOT EXISTS(SELECT FROM pg_auth_members WHERE member=current_user::regrole AND roleid=cap::regrole
      AND admin_option AND NOT inherit_option AND NOT set_option AND grantor<>member)
    OR EXISTS(SELECT FROM pg_auth_members WHERE member=current_user::regrole AND roleid=cap::regrole AND grantor=member)
    THEN RAISE EXCEPTION 'Unexpected % administration',cap; END IF;
   EXECUTE format('GRANT %I TO CURRENT_USER WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY CURRENT_USER',cap);
   PERFORM set_config('ua.single_role_set_'||cap,'yes',true);
  END IF;
 END LOOP;
 PERFORM set_config('ua.single_role_locator_can_create',has_schema_privilege('ua_access_locator_owner','ua_private','CREATE')::text,true);
END $op$;
SET LOCAL ROLE ua_owner;
DROP TRIGGER single_role_normalize ON ua_private.people;
ALTER TABLE ua_private.people DROP CONSTRAINT people_single_role;
DROP FUNCTION ua_private.enforce_single_role();
DO $grant$ BEGIN
 IF current_setting('ua.single_role_locator_can_create')<>'true' THEN GRANT CREATE ON SCHEMA ua_private TO ua_access_locator_owner; END IF;
END $grant$;
RESET ROLE;
SET LOCAL ROLE ua_access_locator_owner;
DO $lookup$ DECLARE def text; new text:='NOT (''student''=ANY(p.roles))'; old text:='NOT (p.roles && ARRAY[''student'',''teacher'',''admin'',''owner'']::text[])';
BEGIN
 def:=pg_get_functiondef('ua_private.lookup_telegram_start(bigint)'::regprocedure);
 IF (length(def)-length(replace(def,old,'')))/length(old)<>1 THEN RAISE EXCEPTION 'Unexpected lookup_telegram_start definition'; END IF;
 EXECUTE replace(def,old,new);
END $lookup$;
RESET ROLE;
SET LOCAL ROLE ua_owner;
DO $revoke$ BEGIN
 IF current_setting('ua.single_role_locator_can_create')<>'true' THEN REVOKE CREATE ON SCHEMA ua_private FROM ua_access_locator_owner; END IF;
END $revoke$;
RESET ROLE;
DO $op$ DECLARE cap text;
BEGIN
 FOREACH cap IN ARRAY ARRAY['ua_owner','ua_access_locator_owner'] LOOP
  IF current_setting('ua.single_role_set_'||cap,true)='yes' THEN
   EXECUTE format('REVOKE %I FROM CURRENT_USER GRANTED BY CURRENT_USER',cap);
   IF pg_has_role(current_user,cap,'SET') THEN RAISE EXCEPTION 'Temporary % access survived',cap; END IF;
  END IF;
 END LOOP;
END $op$;
COMMIT;

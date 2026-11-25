-- "Bitta odam - bitta rol". PostgreSQL 17.
-- 1) Xodim roli (teacher/admin/owner) berilgan odamdan 'student' roli avtomatik olib tashlanadi.
-- 2) Bir odamda bir nechta xodim roli yoki bo'sh/ikki karra rol bo'lishi mumkin emas.
-- 3) Xodimning Telegram /start holati 'student' rolisiz ham 'linked' bo'lib qoladi.
-- Hamma narsa bitta tranzaksiyada; xato bo'lsa hech narsa o'zgarmaydi.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('ua.single_role.001',0));

-- Boshqariladigan operator uchun uchta rolga vaqtincha SET huquqi beriladi va oxirida qaytariladi.
DO $op$ DECLARE cap text;
BEGIN
 IF current_user<>session_user OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
  OR to_regclass('ua_private.people') IS NULL
  OR to_regprocedure('ua_private.lookup_telegram_start(bigint)') IS NULL THEN RAISE EXCEPTION 'Expected managed database operator and ua_private schema'; END IF;
 IF EXISTS(SELECT FROM pg_trigger WHERE tgrelid='ua_private.people'::regclass AND tgname='single_role_normalize')
  OR EXISTS(SELECT FROM pg_constraint WHERE conrelid='ua_private.people'::regclass AND conname='people_single_role')
  OR to_regprocedure('ua_private.enforce_single_role()') IS NOT NULL THEN RAISE EXCEPTION 'Single-role rule already installed'; END IF;
 FOREACH cap IN ARRAY ARRAY['ua_owner','ua_access_locator_owner','ua_deletion_executor'] LOOP
  IF NOT pg_has_role(current_user,cap,'SET') THEN
   IF NOT EXISTS(SELECT FROM pg_auth_members WHERE member=current_user::regrole AND roleid=cap::regrole
      AND admin_option AND NOT inherit_option AND NOT set_option AND grantor<>member)
    OR EXISTS(SELECT FROM pg_auth_members WHERE member=current_user::regrole AND roleid=cap::regrole AND grantor=member)
    THEN RAISE EXCEPTION 'Unexpected % administration',cap; END IF;
   EXECUTE format('GRANT %I TO CURRENT_USER WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY CURRENT_USER',cap);
   PERFORM set_config('ua.single_role_set_'||cap,'yes',true);
  END IF;
 END LOOP;
 PERFORM set_config('ua.single_role_members',
  (SELECT md5(string_agg(format('%s/%s/%s/%s/%s/%s',roleid,member,grantor,admin_option,inherit_option,set_option),',' ORDER BY roleid,member,grantor))
   FROM pg_auth_members WHERE roleid IN ('ua_owner'::regrole,'ua_access_locator_owner'::regrole,'ua_deletion_executor'::regrole) AND grantor<>member),true);
 PERFORM set_config('ua.single_role_lookup_acl',(SELECT coalesce(proacl::text,'') FROM pg_proc WHERE oid='ua_private.lookup_telegram_start(bigint)'::regprocedure),true);
 PERFORM set_config('ua.single_role_schema_acl',(SELECT coalesce(md5(string_agg(format('%s/%s/%s/%s',a.grantor,a.grantee,a.privilege_type,a.is_grantable),',' ORDER BY a.grantor,a.grantee,a.privilege_type)),'')
   FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='ua_private'),true);
 PERFORM set_config('ua.single_role_locator_can_create',has_schema_privilege('ua_access_locator_owner','ua_private','CREATE')::text,true);
END $op$;

-- Qoida triggeri va cheklov jadval egasi (ua_owner) tomonidan yaratiladi.
SET LOCAL ROLE ua_owner;
CREATE FUNCTION ua_private.enforce_single_role() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
DECLARE staff text[];
BEGIN
 IF NEW.roles IS NULL THEN RETURN NEW; END IF;
 staff:=ARRAY(SELECT DISTINCT r FROM unnest(NEW.roles) AS r WHERE r IN ('teacher','admin','owner') ORDER BY r);
 IF cardinality(staff)>1 THEN RAISE EXCEPTION 'SINGLE_ROLE_VIOLATION' USING ERRCODE='23514'; END IF;
 IF cardinality(staff)=1 THEN
  NEW.roles:=staff;
  -- The stored profile always mirrors the roles column.
  IF NEW.profile IS NOT NULL AND jsonb_typeof(NEW.profile)='object' AND NEW.profile ? 'roles' THEN
   NEW.profile:=jsonb_set(NEW.profile,'{roles}',to_jsonb(staff));
  END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION ua_private.enforce_single_role() FROM PUBLIC;
-- Nomi harfiy tartibda boshqa BEFORE triggerlardan (deletion_write_barrier, normalize_cabinet_profile) keyin turadi.
CREATE TRIGGER single_role_normalize BEFORE INSERT OR UPDATE ON ua_private.people
 FOR EACH ROW EXECUTE FUNCTION ua_private.enforce_single_role();
RESET ROLE;

-- Mavjud qatorlarni qoidaga keltirish (faqat shu ilovaning yozish roli orqali; trigger profilni ham moslaydi).
SET LOCAL ROLE ua_deletion_executor;
DO $data$ DECLARE changed integer;
BEGIN
 UPDATE ua_private.people SET roles=array_remove(roles,'student')
  WHERE 'student'=ANY(roles) AND roles && ARRAY['teacher','admin','owner']::text[];
 GET DIAGNOSTICS changed=ROW_COUNT;
 PERFORM set_config('ua.single_role_changed',changed::text,true);
END $data$;
-- Kechiktirilgan a'zolik tekshiruvini hozir bajarish kerak, aks holda jadvalni o'zgartirib bo'lmaydi.
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;
DO $check$ BEGIN
 IF EXISTS(SELECT FROM ua_private.people WHERE cardinality(roles)<>1) THEN
  RAISE EXCEPTION 'Existing people with more than one role must be resolved manually before the rule is installed'; END IF;
END $check$;

SET LOCAL ROLE ua_owner;
ALTER TABLE ua_private.people ADD CONSTRAINT people_single_role CHECK (cardinality(roles)=1);
-- Telegram boshlang'ich holat qidiruvi mavjud funksiya egasi (ua_access_locator_owner) orqali almashtiriladi.
DO $grant$ BEGIN
 IF current_setting('ua.single_role_locator_can_create')<>'true' THEN GRANT CREATE ON SCHEMA ua_private TO ua_access_locator_owner; END IF;
END $grant$;
RESET ROLE;

SET LOCAL ROLE ua_access_locator_owner;
DO $lookup$ DECLARE def text; old text:='NOT (''student''=ANY(p.roles))'; new text:='NOT (p.roles && ARRAY[''student'',''teacher'',''admin'',''owner'']::text[])';
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

-- Tekshiruv: trigger, cheklov, funksiya ACL va operator huquqlari.
DO $verify$ DECLARE cap text;
BEGIN
 IF NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='ua_private.people'::regclass AND tgname='single_role_normalize' AND tgenabled='O' AND NOT tgisinternal)
  OR NOT EXISTS(SELECT FROM pg_constraint WHERE conrelid='ua_private.people'::regclass AND conname='people_single_role' AND convalidated)
  OR (SELECT proowner FROM pg_proc WHERE oid='ua_private.enforce_single_role()'::regprocedure) IS DISTINCT FROM 'ua_owner'::regrole::oid
  OR EXISTS(SELECT FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
            WHERE p.oid='ua_private.enforce_single_role()'::regprocedure AND a.grantee<>p.proowner)
  THEN RAISE EXCEPTION 'Single-role rule is incomplete'; END IF;
 IF position('NOT (p.roles && ARRAY[''student'',''teacher'',''admin'',''owner'']::text[])' IN
      (SELECT prosrc FROM pg_proc WHERE oid='ua_private.lookup_telegram_start(bigint)'::regprocedure))=0
  OR (SELECT coalesce(proacl::text,'') FROM pg_proc WHERE oid='ua_private.lookup_telegram_start(bigint)'::regprocedure)<>current_setting('ua.single_role_lookup_acl')
  THEN RAISE EXCEPTION 'Telegram lookup was not updated exactly'; END IF;
 IF (SELECT coalesce(md5(string_agg(format('%s/%s/%s/%s',a.grantor,a.grantee,a.privilege_type,a.is_grantable),',' ORDER BY a.grantor,a.grantee,a.privilege_type)),'')
     FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='ua_private')
    IS DISTINCT FROM current_setting('ua.single_role_schema_acl') THEN RAISE EXCEPTION 'Schema permissions changed'; END IF;
END $verify$;

-- Vaqtincha berilgan operator huquqlari qaytariladi va avvalgi holat bilan solishtiriladi.
DO $op$ DECLARE cap text;
BEGIN
 FOREACH cap IN ARRAY ARRAY['ua_owner','ua_access_locator_owner','ua_deletion_executor'] LOOP
  IF current_setting('ua.single_role_set_'||cap,true)='yes' THEN
   EXECUTE format('REVOKE %I FROM CURRENT_USER GRANTED BY CURRENT_USER',cap);
   IF pg_has_role(current_user,cap,'SET') THEN RAISE EXCEPTION 'Temporary % access survived',cap; END IF;
  END IF;
 END LOOP;
 IF (SELECT md5(string_agg(format('%s/%s/%s/%s/%s/%s',roleid,member,grantor,admin_option,inherit_option,set_option),',' ORDER BY roleid,member,grantor))
     FROM pg_auth_members WHERE roleid IN ('ua_owner'::regrole,'ua_access_locator_owner'::regrole,'ua_deletion_executor'::regrole) AND grantor<>member)
    IS DISTINCT FROM current_setting('ua.single_role_members') THEN RAISE EXCEPTION 'Role memberships changed'; END IF;
END $op$;
COMMIT;

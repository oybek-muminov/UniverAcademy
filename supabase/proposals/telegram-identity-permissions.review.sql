-- INACTIVE REVIEW DERIVATIVE ONLY. No compilation, installation or execution.
-- Apply only within a separately reviewed exact activation composition. Frozen
-- baseline/activation/name/session SQL remains unchanged. No new table, user,
-- credential, Clerk metadata, public endpoint or runtime ownership is created.
-- Conventional trusted-server boundary: these context assertions do not defend
-- against a holder of the private DB credential. Telegram/Clerk verification
-- belongs to the trusted adapter; a preliminary lookup is never authentication.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path = pg_catalog, ua_private;
DO $preflight$
DECLARE operator_oid oid; bootstrap_oid oid; target text; target_oid oid;
BEGIN
 SELECT oid INTO STRICT operator_oid FROM pg_catalog.pg_roles WHERE rolname='postgres'
   AND oid=current_user::regrole AND current_user=session_user AND NOT rolsuper AND rolcreaterole AND rolbypassrls;
 SELECT oid INTO STRICT bootstrap_oid FROM pg_catalog.pg_roles WHERE oid=10 AND rolname='supabase_admin' AND rolsuper;
 IF NOT pg_catalog.pg_has_role(current_user,'ua_owner','SET') OR NOT pg_catalog.pg_has_role(current_user,'ua_owner','USAGE') THEN
   RAISE EXCEPTION 'OWNER_WINDOW_REQUIRED' USING ERRCODE='42501';
 END IF;
 FOREACH target IN ARRAY ARRAY['ua_access_locator_owner','ua_clerk_lock_owner'] LOOP
   SELECT oid INTO STRICT target_oid FROM pg_catalog.pg_roles WHERE rolname=target AND NOT rolcanlogin AND NOT rolinherit
     AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication;
   IF pg_catalog.has_schema_privilege(target_oid,'ua_private','CREATE')
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=target_oid)
     OR (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE roleid=target_oid)<>1
     OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid=target_oid AND member=operator_oid
       AND grantor=bootstrap_oid AND admin_option AND NOT inherit_option AND NOT set_option) THEN
     RAISE EXCEPTION 'UNEXPECTED_TELEGRAM_HELPER_OWNER' USING ERRCODE='42501';
   END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='ua_runtime' AND NOT rolcanlogin AND NOT rolinherit
     AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication)
   OR pg_catalog.has_column_privilege('ua_runtime','ua_private.people','telegram_id','UPDATE')
   OR pg_catalog.to_regprocedure('ua_private.lookup_telegram_start(bigint)') IS NOT NULL
   OR pg_catalog.to_regprocedure('ua_private.locate_telegram_return(bigint,text)') IS NOT NULL
   OR pg_catalog.to_regprocedure('ua_private.link_telegram_identity(uuid,bigint)') IS NOT NULL
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polname IN ('telegram_helper_people_read','telegram_helper_identity_read','telegram_helper_link_write','telegram_exchange_replay_insert')
     AND polrelid IN ('ua_private.people'::regclass,'ua_private.clerk_identities'::regclass,'ua_private.init_data_replays'::regclass)) THEN
   RAISE EXCEPTION 'TELEGRAM_DELTA_PRECONDITION_FAILED' USING ERRCODE='42501';
 END IF;
END $preflight$;
-- Existing restricted owners only. Temporary transfer authority is separate from
-- each preserved bootstrap-issued ADMIN-only creator row, and is closed below.
GRANT CREATE ON SCHEMA ua_private TO ua_access_locator_owner,ua_clerk_lock_owner;
GRANT ua_access_locator_owner,ua_clerk_lock_owner TO CURRENT_USER WITH ADMIN FALSE, INHERIT TRUE, SET TRUE GRANTED BY CURRENT_USER;
GRANT SELECT(id,telegram_id,enabled,roles) ON ua_private.people TO ua_access_locator_owner,ua_clerk_lock_owner;
GRANT SELECT(issuer,subject,person_id,enabled) ON ua_private.clerk_identities TO ua_access_locator_owner;
CREATE POLICY telegram_helper_people_read ON ua_private.people FOR SELECT TO ua_access_locator_owner,ua_clerk_lock_owner USING(true);
CREATE POLICY telegram_helper_identity_read ON ua_private.clerk_identities FOR SELECT TO ua_access_locator_owner USING(true);
GRANT UPDATE(telegram_id) ON ua_private.people TO ua_clerk_lock_owner;
CREATE POLICY telegram_helper_link_write ON ua_private.people FOR UPDATE TO ua_clerk_lock_owner
 USING(telegram_id IS NULL AND enabled AND 'student'=ANY(roles))
 WITH CHECK(telegram_id IS NOT NULL AND telegram_id>0 AND enabled AND 'student'=ANY(roles));

SET LOCAL ROLE ua_owner;
CREATE FUNCTION ua_private.lookup_telegram_start(p_telegram_id bigint) RETURNS TABLE(state text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, ua_private
AS $fn$ DECLARE p record; BEGIN
 IF NOT COALESCE(p_telegram_id>0 AND p_telegram_id<=9007199254740991,false)
   OR current_setting('ua.phase',true) IS DISTINCT FROM 'auth'
   OR current_setting('ua.person_id',true) IS DISTINCT FROM ''
   OR current_setting('ua.person_ids',true) IS DISTINCT FROM '[]'
   OR current_setting('ua.clerk_issuer',true) IS DISTINCT FROM ''
   OR current_setting('ua.clerk_subject',true) IS DISTINCT FROM ''
   OR current_setting('ua.telegram_id',true) IS DISTINCT FROM '' THEN
   RAISE EXCEPTION 'INVALID_TELEGRAM_LOOKUP_SCOPE' USING ERRCODE='42501';
 END IF;
 SELECT x.id,x.enabled,x.roles INTO p FROM ua_private.people x WHERE x.telegram_id=p_telegram_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'needs_clerk'::text; RETURN; END IF;
 IF NOT p.enabled OR NOT ('student'=ANY(p.roles)) OR
   (EXISTS(SELECT 1 FROM ua_private.clerk_identities i WHERE i.person_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM ua_private.clerk_identities i WHERE i.person_id=p.id AND i.enabled)) THEN
   RETURN QUERY SELECT 'disabled'::text;
 ELSIF EXISTS(SELECT 1 FROM ua_private.clerk_identities i WHERE i.person_id=p.id AND i.enabled) THEN
   RETURN QUERY SELECT 'linked'::text;
 ELSE RETURN QUERY SELECT 'needs_clerk'::text;
 END IF;
END $fn$;
SET LOCAL ROLE NONE;
ALTER FUNCTION ua_private.lookup_telegram_start(bigint) OWNER TO ua_access_locator_owner;
REVOKE ALL ON FUNCTION ua_private.lookup_telegram_start(bigint) FROM PUBLIC,anon,authenticated,service_role,ua_owner;
GRANT EXECUTE ON FUNCTION ua_private.lookup_telegram_start(bigint) TO ua_runtime;

SET LOCAL ROLE ua_owner;
CREATE FUNCTION ua_private.locate_telegram_return(p_telegram_id bigint,p_issuer text)
RETURNS TABLE(person_id uuid,person_enabled boolean,issuer text,subject text,identity_enabled boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, ua_private
AS $fn$ BEGIN
 IF NOT COALESCE(p_telegram_id>0 AND p_telegram_id<=9007199254740991,false)
   OR NOT COALESCE(p_issuer ~ '^https://[^/[:space:]]+$',false)
   OR current_setting('ua.phase',true) IS DISTINCT FROM 'auth'
   OR current_setting('ua.person_id',true) IS DISTINCT FROM ''
   OR current_setting('ua.person_ids',true) IS DISTINCT FROM '[]'
   OR current_setting('ua.clerk_issuer',true) IS DISTINCT FROM ''
   OR current_setting('ua.clerk_subject',true) IS DISTINCT FROM ''
   OR current_setting('ua.telegram_id',true) IS DISTINCT FROM '' THEN
   RAISE EXCEPTION 'INVALID_TELEGRAM_LOCATOR_SCOPE' USING ERRCODE='42501';
 END IF;
 -- Hint only, bounded at two rows so ambiguity is explicit. Disabled mappings
 -- remain visible and are never treated as a missing identity. No SID is guessed
 -- or returned here; current family/fence selection follows the ordered locks.
 RETURN QUERY SELECT p.id,p.enabled,i.issuer,i.subject,i.enabled
   FROM ua_private.people p LEFT JOIN ua_private.clerk_identities i ON i.person_id=p.id AND i.issuer=p_issuer
   WHERE p.telegram_id=p_telegram_id ORDER BY p.id,i.subject LIMIT 2;
END $fn$;
SET LOCAL ROLE NONE;
ALTER FUNCTION ua_private.locate_telegram_return(bigint,text) OWNER TO ua_access_locator_owner;
REVOKE ALL ON FUNCTION ua_private.locate_telegram_return(bigint,text) FROM PUBLIC,anon,authenticated,service_role,ua_owner;
GRANT EXECUTE ON FUNCTION ua_private.locate_telegram_return(bigint,text) TO ua_runtime;

SET LOCAL ROLE ua_owner;
CREATE FUNCTION ua_private.link_telegram_identity(p_person_id uuid,p_telegram_id bigint) RETURNS TABLE(state text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ua_private
AS $fn$ DECLARE prior_id bigint; changed_id uuid; BEGIN
 IF NOT COALESCE(p_telegram_id>0 AND p_telegram_id<=9007199254740991,false)
   OR current_setting('ua.phase',true) IS DISTINCT FROM 'exchange'
   OR current_setting('ua.person_id',true) IS DISTINCT FROM p_person_id::text
   OR current_setting('ua.person_ids',true)::jsonb IS DISTINCT FROM jsonb_build_array(p_person_id::text)
   OR NOT COALESCE(current_setting('ua.clerk_issuer',true) ~ '^https://[^/[:space:]]+$',false)
   OR NOT COALESCE(current_setting('ua.clerk_subject',true) ~ '^user_[A-Za-z0-9]+$',false)
   OR current_setting('ua.telegram_id',true) IS DISTINCT FROM '' THEN
   RAISE EXCEPTION 'INVALID_TELEGRAM_LINK_SCOPE' USING ERRCODE='42501';
 END IF;
 -- Caller already holds Clerk gate -> Telegram gate -> Clerk mapping row ->
 -- sorted person locks. Re-read current local authority; no context SET or
 -- transaction control occurs inside this helper.
 SELECT p.telegram_id INTO prior_id FROM ua_private.people p WHERE p.id=p_person_id AND p.enabled AND 'student'=ANY(p.roles)
   AND EXISTS(SELECT 1 FROM ua_private.clerk_identities i WHERE i.person_id=p.id AND i.enabled
     AND i.issuer=current_setting('ua.clerk_issuer',true) AND i.subject=current_setting('ua.clerk_subject',true));
 IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_TELEGRAM_LINK_AUTHORITY' USING ERRCODE='42501'; END IF;
 IF prior_id IS NOT NULL THEN
   RETURN QUERY SELECT (CASE WHEN prior_id=p_telegram_id THEN 'linked' ELSE 'conflict' END)::text; RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM ua_private.people p WHERE p.telegram_id=p_telegram_id AND p.id<>p_person_id) THEN
   RETURN QUERY SELECT 'conflict'::text; RETURN;
 END IF;
 BEGIN
   UPDATE ua_private.people SET telegram_id=p_telegram_id WHERE id=p_person_id AND telegram_id IS NULL RETURNING id INTO changed_id;
 EXCEPTION WHEN unique_violation THEN
   RETURN QUERY SELECT 'conflict'::text; RETURN;
 END;
 IF changed_id IS NULL THEN RETURN QUERY SELECT 'conflict'::text;
 ELSE RETURN QUERY SELECT 'linked'::text; END IF;
END $fn$;
SET LOCAL ROLE NONE;
ALTER FUNCTION ua_private.link_telegram_identity(uuid,bigint) OWNER TO ua_clerk_lock_owner;
REVOKE ALL ON FUNCTION ua_private.link_telegram_identity(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role,ua_owner;
GRANT EXECUTE ON FUNCTION ua_private.link_telegram_identity(uuid,bigint) TO ua_runtime;

-- Existing replay table; only the verified exchange owner may insert its row.
-- A global digest conflict yields zero INSERT RETURNING rows and the adapter
-- rolls back the entire operation. Same-pair links bypass this INSERT entirely.
GRANT INSERT(digest,person_id,consumed_at_ms) ON ua_private.init_data_replays TO ua_runtime;
CREATE POLICY telegram_exchange_replay_insert ON ua_private.init_data_replays FOR INSERT TO ua_runtime
WITH CHECK(current_setting('ua.phase',true)='exchange'
 AND current_setting('ua.person_id',true)=init_data_replays.person_id::text
 AND current_setting('ua.person_ids',true)::jsonb=jsonb_build_array(init_data_replays.person_id::text)
 AND current_setting('ua.telegram_id',true)=''
 AND COALESCE(current_setting('ua.clerk_issuer',true) ~ '^https://[^/[:space:]]+$',false)
 AND COALESCE(current_setting('ua.clerk_subject',true) ~ '^user_[A-Za-z0-9]+$',false)
 AND current_setting('ua.clerk_subject',true) !~ '[[:space:]]'
 AND EXISTS(SELECT 1 FROM ua_private.people p WHERE p.id=init_data_replays.person_id AND p.enabled AND 'student'=ANY(p.roles) AND p.telegram_id IS NOT NULL)
 AND EXISTS(SELECT 1 FROM ua_private.clerk_identities i WHERE i.person_id=init_data_replays.person_id AND i.enabled
   AND i.issuer=current_setting('ua.clerk_issuer',true) AND i.subject=current_setting('ua.clerk_subject',true)));
REVOKE CREATE ON SCHEMA ua_private FROM ua_access_locator_owner,ua_clerk_lock_owner;
REVOKE ua_access_locator_owner,ua_clerk_lock_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
DO $postflight$
DECLARE target text; target_oid oid; operator_oid oid:=current_user::regrole; f oid;
BEGIN
 FOREACH target IN ARRAY ARRAY['ua_access_locator_owner','ua_clerk_lock_owner'] LOOP
   target_oid:=target::regrole;
   IF pg_catalog.has_schema_privilege(target_oid,'ua_private','CREATE')
     OR pg_catalog.pg_has_role(current_user,target_oid,'SET') OR pg_catalog.pg_has_role(current_user,target_oid,'USAGE')
     OR (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE roleid=target_oid OR member=target_oid)<>1
     OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid=target_oid AND member=operator_oid
       AND grantor=10 AND admin_option AND NOT inherit_option AND NOT set_option) THEN
     RAISE EXCEPTION 'TELEGRAM_TRANSFER_WINDOW_NOT_CLOSED' USING ERRCODE='42501';
   END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['ua_private.lookup_telegram_start(bigint)'::regprocedure::oid,
   'ua_private.locate_telegram_return(bigint,text)'::regprocedure::oid,
   'ua_private.link_telegram_identity(uuid,bigint)'::regprocedure::oid] LOOP
   IF NOT pg_catalog.has_function_privilege('ua_runtime',f,'EXECUTE')
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p,
       LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
       WHERE p.oid=f AND (a.grantee NOT IN(p.proowner,'ua_runtime'::regrole)
         OR a.privilege_type<>'EXECUTE' OR a.is_grantable)) THEN
     RAISE EXCEPTION 'UNEXPECTED_TELEGRAM_HELPER_EXECUTE' USING ERRCODE='42501';
   END IF;
 END LOOP;
 IF pg_catalog.has_column_privilege('ua_runtime','ua_private.people','telegram_id','UPDATE') THEN
   RAISE EXCEPTION 'RUNTIME_TELEGRAM_UPDATE_FORBIDDEN' USING ERRCODE='42501';
 END IF;
END $postflight$;
-- Remains inactive. An execution packet must separately pin/review this delta,
-- restore the outer ua_owner window exactly, validate all ACLs and prove RLS
-- with the dedicated non-owner/NOBYPASSRLS role before any runtime activation.
ROLLBACK;

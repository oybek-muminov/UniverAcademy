-- No writes or copies of existing personal data in this phase. PostgreSQL 15+.
CREATE VIEW ua_private.people_registration WITH (security_invoker=true) AS
  SELECT id, telegram_id, qadam_id AS univeracademy_id, enabled, roles, profile
  FROM ua_private.people;
REVOKE ALL ON ua_private.people_registration FROM PUBLIC;
GRANT SELECT(id), INSERT(id, telegram_id, univeracademy_id, enabled, roles, profile)
  ON ua_private.people_registration TO ua_runtime;

-- An unchanged v1 server strictly decodes just the legacy profile key. Store
-- exactly one key until, through and after the cutover; the column stays unique.
CREATE FUNCTION ua_private.normalize_cabinet_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  destination text := TG_ARGV[0];
  source_key text := TG_ARGV[1];
BEGIN
  IF NEW.profile ? source_key THEN
    IF NEW.profile ? destination AND (NEW.profile->source_key) IS DISTINCT FROM (NEW.profile->destination) THEN
      RAISE EXCEPTION 'Conflicting cabinet identifiers' USING ERRCODE = '23514';
    END IF;
    NEW.profile := (NEW.profile - source_key) || jsonb_build_object(destination, NEW.profile->source_key);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION ua_private.normalize_cabinet_profile() FROM PUBLIC;
CREATE TRIGGER normalize_cabinet_profile BEFORE INSERT OR UPDATE ON ua_private.people
  FOR EACH ROW EXECUTE FUNCTION ua_private.normalize_cabinet_profile('qadam_id', 'univeracademy_id');

-- REVIEW ONLY. Isolated row-fence candidate, NOT a production migration.
-- Do not grant the runtime execution. Existing admission, direct/legacy writers,
-- deletion/recovery and invite delivery are not yet all proven to honor this fence.
BEGIN;
CREATE FUNCTION ua_cabinet.owner_transfer_group_fence(
  actor uuid, gid uuid, source_id uuid, destination_id uuid, expected_revision bigint, receipt_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE current_group record; prior record; result jsonb; signature text; now_ms bigint; changed integer;
  next_revision ua_private.groups.revision%TYPE; violation_type text;
BEGIN
  IF actor IS NULL OR current_setting('ua.phase',true) IS DISTINCT FROM 'domain'
    OR current_setting('ua.person_id',true) IS DISTINCT FROM actor::text THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF gid IS NULL OR source_id IS NULL OR destination_id IS NULL OR expected_revision IS NULL OR expected_revision<0
    OR receipt_key IS NULL OR receipt_key !~ ('^'||actor::text||'/staging/transferGroup/[a-f0-9]{64}$') THEN
    RAISE EXCEPTION 'VALIDATION_ERROR' USING ERRCODE='22023';
  END IF;
  -- Fail fast instead of holding locks while waiting for a conflicting writer.
  -- This key only guards a receipt replay across groups; the group row is the fence.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'GROUP_TRANSFER_BUSY' USING ERRCODE='55P03';
  END IF;
  PERFORM 1 FROM ua_private.people p JOIN ua_private.staff_access s ON s.person_id=p.id
    WHERE p.id=actor AND p.enabled AND p.roles=ARRAY['owner']::text[] AND s.approved
    FOR SHARE OF p,s NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('ua.owner_group_transfer_fence.v1.receipt:'||receipt_key,0)) THEN
    RAISE EXCEPTION 'GROUP_TRANSFER_BUSY' USING ERRCODE='55P03';
  END IF;

  signature:=jsonb_build_array(gid,source_id,destination_id,expected_revision::text)::text;
  SELECT payload,response INTO prior FROM ua_private.staff_receipts WHERE actor_id=actor AND key=receipt_key;
  IF FOUND THEN
    IF prior.payload IS DISTINCT FROM signature THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN prior.response::jsonb;
  END IF;
  -- Request before canonical row, matching the existing pilot writer. Split statements
  -- make lock order explicit; SELECT ... FOR UPDATE OF r,g does not do that.
  PERFORM 1 FROM ua_cabinet.group_requests r WHERE r.id=gid AND r.active_group_id=gid FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM ua_private.groups g WHERE g.id=gid FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT r.teacher_id,r.subject_id,g.revision,g.status INTO STRICT current_group
    FROM ua_cabinet.group_requests r JOIN ua_private.groups g ON g.id=r.active_group_id
    WHERE r.id=gid AND g.id=gid;
  IF current_group.teacher_id IS DISTINCT FROM source_id OR current_group.revision IS DISTINCT FROM expected_revision THEN RAISE EXCEPTION 'GROUP_TRANSFER_STALE'; END IF;
  IF current_group.status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'GROUP_NOT_ACTIVE'; END IF;
  IF source_id=destination_id THEN RAISE EXCEPTION 'SAME_TEACHER'; END IF;
  -- The same-group request/group fence is held. Lock exact extant authority
  -- records before rechecking them. Actor pre-locks or revocations may already
  -- hold rows, so NOWAIT avoids inversions with those transactions.
  PERFORM p.id FROM ua_private.people p WHERE p.id IN (source_id,destination_id)
    ORDER BY p.id FOR UPDATE NOWAIT;
  PERFORM s.person_id FROM ua_private.staff_access s WHERE s.person_id IN (source_id,destination_id)
    ORDER BY s.person_id FOR SHARE NOWAIT;
  PERFORM a.person_id FROM ua_private.teacher_subject_approvals a
    WHERE a.person_id=destination_id AND a.subject_id=current_group.subject_id FOR SHARE NOWAIT;
  PERFORM a.person_id FROM ua_private.staff_subject_scope a
    WHERE a.person_id=destination_id AND a.subject_id=current_group.subject_id FOR SHARE NOWAIT;
  PERFORM a.person_id FROM ua_private.staff_group_scope a WHERE a.group_id=gid
    ORDER BY a.person_id FOR UPDATE NOWAIT;
  PERFORM i.digest FROM ua_cabinet.invites i WHERE i.group_id=gid
    ORDER BY i.digest FOR UPDATE NOWAIT;
  IF (SELECT count(*) FROM ua_private.staff_group_scope WHERE group_id=gid AND revoked_at_ms IS NULL)<>1
    OR NOT EXISTS(SELECT 1 FROM ua_private.staff_group_scope WHERE group_id=gid AND person_id=source_id AND revoked_at_ms IS NULL) THEN
    RAISE EXCEPTION 'GROUP_SCOPE_INCONSISTENT';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM ua_private.people_registration p JOIN ua_private.staff_access s ON s.person_id=p.id
    WHERE p.id=destination_id AND p.enabled AND p.roles=ARRAY['teacher']::text[] AND s.approved
      AND NOT s.all_groups AND NOT s.all_subjects
      AND EXISTS(SELECT 1 FROM ua_private.teacher_subject_approvals a WHERE a.person_id=p.id
        AND a.subject_id=current_group.subject_id AND a.approved AND a.revoked_at_ms IS NULL)
      AND EXISTS(SELECT 1 FROM ua_private.staff_subject_scope a WHERE a.person_id=p.id
        AND a.subject_id=current_group.subject_id AND a.revoked_at_ms IS NULL)
      AND NOT EXISTS(SELECT 1 FROM ua_private.staff_audit a WHERE a.actor_id=p.id AND a.target_id=p.id AND a.action='requestAccountDeletion'))
    THEN RAISE EXCEPTION 'TEACHER_NOT_ELIGIBLE'; END IF;

  now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF EXISTS(SELECT 1 FROM ua_private.attempts t JOIN ua_private.assignments a ON a.id=t.assignment_id
    WHERE a.group_id=gid AND t.body->>'status'='in_progress'
      AND CASE WHEN jsonb_typeof(t.body->'deadlineAt')='number'
        THEN (t.body->>'deadlineAt')::numeric>now_ms ELSE true END) THEN RAISE EXCEPTION 'ACTIVE_TEST_ATTEMPT'; END IF;
  IF EXISTS(SELECT 1 FROM ua_private.assignments a WHERE a.group_id=gid
    AND a.record->'cancelled' IS DISTINCT FROM 'true'::jsonb
    AND CASE WHEN (a.record->'cancelled' IS NULL OR a.record->'cancelled' IN ('false'::jsonb,'null'::jsonb))
      AND jsonb_typeof(a.record#>'{admission,opensAt}')='number'
      AND jsonb_typeof(a.record#>'{admission,closesAt}')='number'
    THEN (a.record#>>'{admission,opensAt}')::numeric >= (a.record#>>'{admission,closesAt}')::numeric
      OR (a.record#>>'{admission,closesAt}')::numeric>now_ms ELSE true END)
    THEN RAISE EXCEPTION 'OPEN_OR_SCHEDULED_TEST'; END IF;

  -- Cast the single next-revision expression to the actual column domain in isolation.
  -- Constraint failures later (e.g. audit insertion) must propagate unchanged.
  BEGIN
    next_revision:=expected_revision+1;
  EXCEPTION
    WHEN numeric_value_out_of_range THEN
      RAISE EXCEPTION 'GROUP_TRANSFER_REVISION_EXHAUSTED' USING ERRCODE='22003';
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS violation_type=PG_DATATYPE_NAME;
      IF violation_type IS DISTINCT FROM 'safe_counter' THEN RAISE; END IF;
      RAISE EXCEPTION 'GROUP_TRANSFER_REVISION_EXHAUSTED' USING ERRCODE='22003';
  END;
  UPDATE ua_private.staff_group_scope SET revoked_at_ms=now_ms
    WHERE group_id=gid AND person_id=source_id AND revoked_at_ms IS NULL;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'GROUP_SCOPE_INCONSISTENT'; END IF;
  INSERT INTO ua_private.staff_group_scope(person_id,group_id,revoked_at_ms)
    VALUES(destination_id,gid,NULL) ON CONFLICT(person_id,group_id) DO UPDATE
    SET revoked_at_ms=NULL WHERE staff_group_scope.revoked_at_ms IS NOT NULL;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'GROUP_SCOPE_INCONSISTENT'; END IF;
  UPDATE ua_cabinet.group_requests SET teacher_id=destination_id WHERE id=gid AND teacher_id=source_id;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'GROUP_TRANSFER_STALE'; END IF;
  UPDATE ua_private.groups SET revision=next_revision WHERE id=gid AND revision=expected_revision;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'GROUP_TRANSFER_STALE'; END IF;

  -- Expire rather than delete, so previously redeemed invite history persists and an old
  -- invite cannot revive if the group is later transferred back to its author.
  UPDATE ua_cabinet.invites SET expires_at=to_timestamp(now_ms/1000.0)
    WHERE group_id=gid AND expires_at>to_timestamp(now_ms/1000.0);
  result:=jsonb_build_object('groupId',gid,'sourceTeacherId',source_id,'destinationTeacherId',destination_id,
    'previousRevision',expected_revision::text,'revision',next_revision::text);
  INSERT INTO ua_private.staff_receipts(actor_id,key,payload,response) VALUES(actor,receipt_key,signature,result);
  INSERT INTO ua_private.staff_audit(command_key,actor_id,action,target_id,revision,at_ms)
    VALUES(receipt_key,actor,'transferGroup',gid,next_revision,now_ms);
  RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION ua_cabinet.owner_transfer_group_fence(uuid,uuid,uuid,uuid,bigint,text) FROM PUBLIC;
COMMIT;

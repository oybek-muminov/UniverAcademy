import { ApiFault, fail } from "./fault.ts";
import { startAttempt, saveAnswer, studentView, submitAttempt, result } from "./attempts.ts";
import type { AttemptRecord, StudentAccess } from "./attempts.ts";
import { verifyTelegramInitData } from "./telegram.ts";
import { authenticate, bearer, checkSessionPolicy, issueProofs, proofHash, revokeFamily, seriesKey, studentPerson }
  from "./student-state.ts";
import type { NumericPresentation, SessionPolicy, StudentState, StudentTransactions }
  from "./student-state.ts";
import { answerWire, attemptWire, historyWire, metaWire, profileWire, scoreWire, utc }
  from "./student-wire.ts";

type Completion = { render(): unknown };
export type StudentHttpDependencies = {
  transactions: StudentTransactions;
  botToken?: string;
  sessionPolicy?: SessionPolicy;
  numericPresentation?: NumericPresentation;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function body(raw: string, required: readonly string[], optional: readonly string[] = []) {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { fail("MALFORMED_JSON", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("VALIDATION_ERROR", 422);
  const object = value as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(object, key)) ||
    Object.keys(object).some((key) => !required.includes(key) && !optional.includes(key))) {
    fail("VALIDATION_ERROR", 422);
  }
  return object;
}
function string(value: unknown, maximum: number): string {
  if (typeof value !== "string" || Array.from(value).length < 1 || Array.from(value).length > maximum) {
    fail("VALIDATION_ERROR", 422);
  }
  return value;
}
function errorCompletion(code: string, status: number): Completion {
  return { render() { fail(code, status); } };
}
function completed(value: unknown): Completion { return { render: () => value }; }
function projection(state: StudentState, map: (snapshot: StudentState) => unknown): Completion {
  // ponytail: whole-state copies are for this local adapter contract only;
  // production storage must load a scoped snapshot, never a full database.
  const snapshot = structuredClone(state);
  return { render: () => map(snapshot) };
}
function persist(state: StudentState, record: AttemptRecord): void {
  state.attempts[record.id] = record;
  const series = state.series[seriesKey(record.personId, record.published.demoId)];
  if (!series || series.currentAttemptId !== record.id || series.generation !== record.generation) {
    fail("RESPONSE_INVARIANT_FAILED", 500);
  }
  if (record.ordinary && record.status !== "cancelled") series.officialAttemptId = record.id;
  if (record.generation > 1 && record.status !== "in_progress") {
    series.recoveryState = "none";
    series.recovery = null;
  }
}
function currentGrant(state: StudentState, personId: string, assignmentId: string): boolean {
  const grant = state.grants[personId]?.[assignmentId], assignment = state.assignments[assignmentId];
  return Boolean(grant?.rostered && assignment && !assignment.cancelled &&
    grant.membershipEpoch === grant.grantEpoch &&
    state.people[personId].profile.active_group_id === assignment.admission.groupId);
}
function visible(state: StudentState, personId: string, assignmentId: string): boolean {
  return currentGrant(state, personId, assignmentId) || Object.values(state.attempts)
    .some((a) => a.personId === personId && a.assignmentId === assignmentId);
}
function accessFor(state: StudentState, personId: string, historical = false): StudentAccess {
  const person = state.people[personId];
  return { personId, proofKind: "student_session", enabled: person.enabled,
    assignmentIds: Object.keys(state.assignments).filter((id) => historical
      ? visible(state, personId, id) : currentGrant(state, personId, id)) };
}
function materializeCurrent(state: StudentState, personId: string, assignmentId: string, now: number) {
  const assignment = state.assignments[assignmentId];
  const series = state.series[seriesKey(personId, assignment.published.demoId)];
  const record = series && state.attempts[series.currentAttemptId];
  if (record?.assignmentId === assignmentId && record.status === "in_progress" && now >= record.deadlineAt) {
    const next = studentView(accessFor(state, personId, true), record,
      { id: series.currentAttemptId, generation: series.generation }, now);
    persist(state, next.record);
  }
}
function receiptKey(request: Request, personId: string, path: string) {
  const key = request.headers.get("idempotency-key");
  if (!key || key.length < 8 || key.length > 128) fail("VALIDATION_ERROR", 422);
  return `${personId}/${request.method}/${path}/${key}`;
}

// No listener, provider connection, secrets loader, default TTL or default numeric policy.
export function createStudentHttpHandler(deps: StudentHttpDependencies) {
  return async function handle(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/v1/")) fail("NOT_FOUND", 404);
      const path = url.pathname.slice("/api/v1".length).replace(/\/$/, "");
      // Read transport bytes before locks. Production body-size/rate/CORS policies are pending.
      const raw = await request.text();
      if (typeof deps.transactions?.transaction !== "function") fail("SERVICE_UNAVAILABLE", 503);
      const done = await deps.transactions.transaction(async ({ state, now: lockedClock }) => {
        const now = lockedClock(); // Required: storage invokes callback only after acquiring locks.
        utc(now);
        if (path === "/auth/telegram" && request.method === "POST") {
          const policy = checkSessionPolicy(deps.sessionPolicy);
          if (!deps.botToken) fail("SERVICE_UNAVAILABLE", 503);
          const input = body(raw, ["init_data"]);
          const seconds = Math.floor(now / 1000);
          const verified = await verifyTelegramInitData(string(input.init_data, 16384), deps.botToken,
            { notBeforeSeconds: Math.max(0, seconds - policy.initDataMaxAgeSeconds),
              notAfterSeconds: seconds + policy.futureSkewSeconds });
          const consumedHash = await proofHash(verified.replayKey);
          if (state.consumedInitData[consumedHash]) fail("INIT_DATA_REPLAY", 409);
          const person = studentPerson(state, verified.telegramUserId, verified.firstName,
            verified.lastName, policy);
          state.consumedInitData[consumedHash] = true;
          for (const family of Object.values(state.families)) {
            if (family.personId === person.profile.person_id && family.revokedAt === null) {
              revokeFamily(family, now, policy);
            }
          }
          const familyId = crypto.randomUUID();
          state.families[familyId] = { personId: person.profile.person_id,
            expiresAt: now + policy.familyTtlMs, revokedAt: null, logoutRetainUntil: null,authProvider:"telegram" };
          const proofs = await issueProofs(state, familyId, now, policy);
          return completed({ access_token: proofs.accessToken, refresh_token: proofs.refreshToken,
            expires_at: utc(proofs.expiresAt), refresh_expires_at: utc(proofs.refreshExpiresAt),
            token_type: "Bearer", profile: profileWire(person) });
        }
        if (path === "/auth/refresh" && request.method === "POST") {
          const policy = checkSessionPolicy(deps.sessionPolicy);
          const input = body(raw, ["refresh_token"]);
          const proof = state.refresh[await proofHash(string(input.refresh_token, 1024))];
          if (!proof) fail("REFRESH_INVALID", 401);
          const family = state.families[proof.familyId];
          if (!family || family.revokedAt !== null) fail("SESSION_REVOKED", 401);
          if (now >= family.expiresAt) fail("REFRESH_EXPIRED", 401);
          const person = state.people[family.personId];
          if (!person?.enabled) fail("ACCOUNT_DISABLED", 403);
          if (!person.profile.roles.includes("student")) fail("FORBIDDEN", 403);
          if (proof.consumed) {
            revokeFamily(family, now, policy);
            return errorCompletion("REFRESH_REUSED", 401); // Commit revocation before 401.
          }
          proof.consumed = true;
          for (const access of Object.values(state.access)) {
            if (access.familyId === proof.familyId) access.superseded = true;
          }
          const proofs = await issueProofs(state, proof.familyId, now, policy);
          return completed({ access_token: proofs.accessToken, refresh_token: proofs.refreshToken,
            expires_at: utc(proofs.expiresAt), refresh_expires_at: utc(proofs.refreshExpiresAt),
            token_type: "Bearer", profile: profileWire(person) });
        }
        if (path === "/auth/logout" && request.method === "POST") {
          const policy = checkSessionPolicy(deps.sessionPolicy);
          const accessToken = bearer(request, false);
          const auth = accessToken ? await authenticate(state, accessToken, now) : null;
          const input = raw ? body(raw, ["refresh_token"]) : null;
          // Logout has no maxLength in this draft; do not inherit Refresh's 1024 limit.
          const proof = input ? state.refresh[await proofHash(string(input.refresh_token, Number.MAX_SAFE_INTEGER))] : null;
          if (!auth && !input) fail("LOGOUT_PROOF_REQUIRED", 401);
          if (input && !proof) fail("REFRESH_INVALID", 401);
          if (auth && proof && auth.familyId !== proof.familyId) fail("LOGOUT_PROOF_MISMATCH", 401);
          const family = state.families[auth?.familyId ?? proof!.familyId];
          if (!family) fail("REFRESH_INVALID", 401);
          if (family.revokedAt !== null && family.logoutRetainUntil !== null && now < family.logoutRetainUntil) {
            return completed({ ok: true });
          }
          if (family.revokedAt !== null || now >= family.expiresAt) fail("REFRESH_EXPIRED", 401);
          revokeFamily(family, now, policy);
          return completed({ ok: true });
        }

        const auth = await authenticate(state, bearer(request)!, now);
        const { personId, person } = auth;
        if (path === "/me" && request.method === "GET") return completed(profileWire(person));
        if (path === "/me" && request.method === "PATCH") {
          const input = body(raw, ["first_name", "last_name"]);
          person.profile.first_name = string(input.first_name, 100);
          person.profile.last_name = string(input.last_name, 100);
          person.profile.registration_complete = true;
          return completed(profileWire(person));
        }
        if (path === "/exams" && request.method === "GET") {
          for (const id of Object.keys(state.assignments)) {
            if (visible(state, personId, id)) materializeCurrent(state, personId, id, now);
          }
          return projection(state, (s) => Object.values(s.assignments)
            .filter((a) => visible(s, personId, a.admission.assignmentId))
            .map((a) => metaWire(s, personId, a, now)));
        }
        const exam = path.match(/^\/exams\/([^/]+)(?:\/(attempts|history))?$/);
        if (exam) {
          if (!uuid.test(exam[1])) fail("NOT_FOUND", 404);
          const id = exam[1].toLowerCase(), assignment = state.assignments[id];
          if (!assignment || !visible(state, personId, id)) fail("NOT_FOUND", 404);
          if (exam[2] === "history" && request.method === "GET") {
            materializeCurrent(state, personId, id, now);
            return projection(state, (s) => historyWire(s, personId, s.assignments[id],
              deps.numericPresentation));
          }
          if (!exam[2] && request.method === "GET") {
            materializeCurrent(state, personId, id, now);
            return projection(state, (s) => metaWire(s, personId, s.assignments[id], now));
          }
          if (exam[2] === "attempts" && request.method === "POST") {
            const grant = state.grants[personId]?.[id];
            if (!currentGrant(state, personId, id)) fail("EXAM_ACCESS_REVOKED", 403);
            if (!person.profile.registration_complete) fail("PROFILE_INCOMPLETE", 409);
            const input = body(raw, ["confirmed"]);
            if (input.confirmed !== true) fail("VALIDATION_ERROR", 422);
            const key = receiptKey(request, personId, `/exams/${id}/attempts`);
            const payload = '{"confirmed":true}', prior = state.receipts[key];
            if (prior && prior.payload !== payload) fail("IDEMPOTENCY_CONFLICT", 409);
            const sk = seriesKey(personId, assignment.published.demoId), series = state.series[sk];
            const existing = series ? state.attempts[series.currentAttemptId] : null;
            if (prior) {
              if (!existing || existing.id !== prior.attemptId) fail("ATTEMPT_SUPERSEDED", 409);
              const resumed = studentView(accessFor(state, personId), existing,
                { id: series.currentAttemptId, generation: series.generation }, now);
              persist(state, resumed.record);
              return projection(state, (s) => attemptWire(s, s.attempts[existing.id], now));
            }
            const next = startAttempt({ access: accessFor(state, personId),
              admission: { ...assignment.admission, ...grant,
                activeGroupId: person.profile.active_group_id,
                profileComplete: person.profile.registration_complete },
              published: assignment.published, existing, id: crypto.randomUUID(), confirmed: true, now });
            if (!series) state.series[sk] = { id: crypto.randomUUID(), currentAttemptId: next.id,
              generation: 1, normalAttemptUsed: true, officialAttemptId: null,
              recoveryState: "none", recovery: null };
            persist(state, next);
            state.receipts[key] = { payload, attemptId: next.id };
            return projection(state, (s) => attemptWire(s, s.attempts[next.id], now));
          }
        }
        const attempt = path.match(/^\/attempts\/([^/]+)(?:\/(submit|result|answers\/([^/]+)))?$/);
        if (attempt) {
          if (!uuid.test(attempt[1])) fail("NOT_FOUND", 404);
          const id = attempt[1].toLowerCase(), record = state.attempts[id];
          if (!record || record.personId !== personId) fail("NOT_FOUND", 404);
          const series = state.series[seriesKey(personId, record.published.demoId)];
          if (!series) fail("RESPONSE_INVARIANT_FAILED", 500);
          const current = { id: series.currentAttemptId, generation: series.generation };
          if (!attempt[2] && request.method === "GET") {
            const next = studentView(accessFor(state, personId), record, current, now);
            persist(state, next.record);
            return projection(state, (s) => attemptWire(s, s.attempts[id], now));
          }
          if (attempt[3] && request.method === "PUT") {
            if (!uuid.test(attempt[3])) fail("NOT_FOUND", 404);
            const input = body(raw, ["selected_option_id", "expected_revision"]);
            if (input.selected_option_id !== null &&
              (typeof input.selected_option_id !== "string" || !uuid.test(input.selected_option_id))) {
              fail("VALIDATION_ERROR", 422);
            }
            const next = saveAnswer(accessFor(state, personId), record, current,
              attempt[3].toLowerCase(), { selected_option_id: typeof input.selected_option_id === "string"
                ? input.selected_option_id.toLowerCase() : null,
                expected_revision: input.expected_revision as number }, now);
            persist(state, next.record);
            if (!next.response.ok) return errorCompletion(next.response.error.code, next.response.error.status);
            return completed(answerWire(next.response.value));
          }
          if (attempt[2] === "submit" && request.method === "POST") {
            if (raw) fail("VALIDATION_ERROR", 422);
            // Core checks current scope/generation BEFORE returning any existing completion.
            const next = submitAttempt(accessFor(state, personId), record, current, now);
            const key = receiptKey(request, personId, `/attempts/${id}/submit`);
            const prior = state.receipts[key];
            if (prior && (prior.payload !== "null" || prior.attemptId !== id)) {
              fail("IDEMPOTENCY_CONFLICT", 409);
            }
            persist(state, next.record);
            state.receipts[key] = { payload: "null", attemptId: id };
            return projection(state, (s) => scoreWire(s, s.attempts[id], deps.numericPresentation));
          }
          if (attempt[2] === "result" && request.method === "GET") {
            const next = result(accessFor(state, personId, true), record, current, now);
            persist(state, next.record);
            return projection(state, (s) => scoreWire(s, s.attempts[id], deps.numericPresentation));
          }
        }
        fail("NOT_FOUND", 404);
      });
      // A committed transaction has resolved. Mapping/serialization errors cannot undo expiry.
      const data = done.render();
      return new Response(JSON.stringify({ data }), { status: 200, headers });
    } catch (error) {
      const fault = error instanceof ApiFault ? error : new ApiFault("INTERNAL_ERROR", 500);
      return new Response(JSON.stringify({ error: { code: fault.code, message: fault.code,
        request_id: requestId } }), { status: fault.status, headers });
    }
  };
}

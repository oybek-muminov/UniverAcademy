import { ApiFault, fail } from "./fault.ts";
import { hasActiveAttempt, materializeElapsedAttempts } from "./membership-activity.ts";
import { seriesKey } from "./student-state.ts";
import { parseStaffJson } from "./staff-json.ts";
import { addInitialMember, createPilotAssignment } from "./pilot-provisioning.ts";
import { writeDraftQuestion, publishDraft } from "./staff-content.ts";
import { canWriteContent, currentStaff, groupScope, nextRevision, owner, requireRosterAuthority,
  STAFF_CONTRACT_SHA } from "./staff-state.ts";
import type { MembershipEffect, StaffState, StaffTransactions, VerifiedStaffProof,
  TransferResult, TransferWrite, Version, VersionPatch, Assignment, AssignmentCreate, MemberWrite, MembershipMutation, QuestionWrite, Publish } from "./staff-state.ts";

type Outcome = { ok: true; data: TransferResult | Version | Assignment | MembershipMutation; schema: string; status?: 201 } |
  { ok: false; code: string; status: number };
export type StaffHttpDependencies = {
  transactions: StaffTransactions;
  // Signature/issuer/audience verification occurs before locks. The handler rechecks
  // proof times and authoritative current staff permissions after locks.
  verifyStaffToken?: (token: string) => Promise<VerifiedStaffProof>;
  contractSha?: string;
  validate?: (schema: string, value: unknown) => boolean;
  // Required transfer port: cancel queued notifications, invalidate affected pending
  // approvals, recompute barriers under the same transaction. Never external I/O.
  reconcileMembershipDependencies?: (state: StaffState, effect: MembershipEffect) => Promise<void>;
  validateInstructionAssets?: (state: StaffState, versionId: string, input: VersionPatch) => Promise<void>;
  newAssignmentId?: () => string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value);
}
function input<T>(raw: string, schema: string, deps: StaffHttpDependencies): T {
  let parsed: unknown;
  try { parsed = parseStaffJson(raw); } catch (error) {
    if (error instanceof ApiFault) throw error;
    fail("MALFORMED_JSON", 400);
  }
  if (!deps.validate!(schema, parsed)) fail("VALIDATION_ERROR", 422);
  return parsed as T;
}
function receiptKey(request: Request, actorId: string, path: string): string {
  const key = request.headers.get("idempotency-key");
  if (!key || key.length < 8 || key.length > 128) fail("VALIDATION_ERROR", 422);
  return actorId + "/" + request.method + "/" + path + "/" + key;
}
function materializeElapsedRights(state: StaffState, studentId: string, now: number): MembershipEffect | null {
  const s = state.student;
  const elapsed = materializeElapsedAttempts(state, studentId, now);
  const assignments = new Set(elapsed?.assignmentIds), demos = new Set(elapsed?.demoIds);
  for (const [key, series] of Object.entries(s.series)) {
    if (key.startsWith(studentId + "/") && series.recoveryState === "ready" &&
        series.recovery && now >= series.recovery.closesAt) {
      series.recoveryState = "lapsed";
      demos.add(key.slice(studentId.length + 1));
    }
  }
  return demos.size ? { kind: "elapsed", studentId, assignmentIds: [...assignments], demoIds: [...demos], now } : null;
}
// Local staff routes for the existing API module; no listener, provider, default store or JWT setup.
export function createStaffHttpHandler(deps: StaffHttpDependencies) {
  return async (request: Request): Promise<Response> => {
    const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
    try {
      if (typeof deps.transactions?.transaction !== "function" ||
          !deps.verifyStaffToken || !deps.validate || deps.contractSha !== STAFF_CONTRACT_SHA)
        fail("SERVICE_UNAVAILABLE", 503);
      const token = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
      if (!token) fail("STAFF_TOKEN_INVALID", 401);
      const proof = await deps.verifyStaffToken(token);
      const url = new URL(request.url), raw = await request.text();
      const transfer = url.pathname.match(/^\/api\/v1\/admin\/students\/([^/]+)\/transfer\/?$/);
      const version = url.pathname.match(/^\/api\/v1\/admin\/versions\/([^/]+)\/?$/);
      const members = url.pathname.match(/^\/api\/v1\/admin\/groups\/([^/]+)\/members\/?$/);
      const question = url.pathname.match(/^\/api\/v1\/admin\/versions\/([^/]+)\/questions\/([^/]+)\/?$/);
      const publish = url.pathname.match(/^\/api\/v1\/admin\/versions\/([^/]+)\/publish\/?$/);
      const outcome = await deps.transactions.transaction<Outcome>(async ({ state, now: clock }) => {
        const now = clock();
        if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) fail("SERVICE_UNAVAILABLE", 503);
        const staff = currentStaff(state, proof, now);
        if ((question && request.method === "PUT") || (publish && request.method === "POST")) {
          // Only existing Owner/approved-subject Teacher authority in this batch.
          // Admin A authorizes assignment; question/publish keeps this batch's existing Owner/Teacher scope.
          if (!owner(staff) && !staff.roles.includes("teacher")) fail("SERVICE_UNAVAILABLE", 503);
          const versionId = (question ?? publish)![1].toLowerCase();
          if (!uuid.test(versionId) || (question && !uuid.test(question[2]))) fail("NOT_FOUND", 404);
          const record = state.versions[versionId];
          if (!record || (!owner(staff) && !staff.approvedSubjectIds.includes(record.subjectId))) fail("NOT_FOUND", 404);
          if (question) {
            const questionId = question[2].toLowerCase(), body = input<QuestionWrite>(raw, "QuestionWrite", deps);
            body.id = body.id.toLowerCase(); body.correct_option_id = body.correct_option_id.toLowerCase();
            body.options = body.options.map((o) => ({ ...o, id: o.id.toLowerCase() }));
            if (body.id !== questionId) fail("IDENTIFIER_MISMATCH", 422);
            const key = receiptKey(request, staff.personId, `/admin/versions/${versionId}/questions/${questionId}`);
            return { ok: true, schema: "Version", data: writeDraftQuestion(state, record, body, key, canonical(body), staff.personId, now) };
          }
          const body = input<Publish>(raw, "Publish", deps);
          const key = receiptKey(request, staff.personId, `/admin/versions/${versionId}/publish`);
          return { ok: true, schema: "Version", data: publishDraft(state, record, body, key, canonical(body), staff.personId, now, deps.validate!) };
        }
        if (members && request.method === "PUT") {
          requireRosterAuthority(staff);
          if (!uuid.test(members[1])) fail("NOT_FOUND", 404);
          const groupId = members[1].toLowerCase();
          if (!state.groups[groupId] || !groupScope(staff, groupId)) fail("NOT_FOUND", 404);
          const body = input<MemberWrite>(raw, "MemberWrite", deps);
          body.student_id = body.student_id.toLowerCase();
          const key = receiptKey(request, staff.personId, `/admin/groups/${groupId}/members`);
          return { ok: true, schema: "MembershipMutation", data: addInitialMember(state, staff, groupId, body, key, canonical(body), now) };
        }
        if (/^\/api\/v1\/admin\/assignments\/?$/.test(url.pathname) && request.method === "POST") {
          const body = input<AssignmentCreate>(raw, "AssignmentCreate", deps);
          body.group_id = body.group_id.toLowerCase(); body.demo_id = body.demo_id.toLowerCase(); body.version_id = body.version_id.toLowerCase();
          body.student_ids = body.student_ids.map((id) => id.toLowerCase());
          const key = receiptKey(request, staff.personId, "/admin/assignments");
          if (!deps.newAssignmentId) fail("SERVICE_UNAVAILABLE", 503);
          return { ok: true, schema: "Assignment", status: 201,
            data: createPilotAssignment(state, staff, body, key, canonical(body), now, deps.newAssignmentId) };
        }
        if (transfer && request.method === "POST") {
          requireRosterAuthority(staff);
          if (!uuid.test(transfer[1])) fail("NOT_FOUND", 404);
          const studentId = transfer[1].toLowerCase();
          const person = state.student.people[studentId], membership = state.memberships[studentId];
          if (!person?.profile.roles.includes("student") || !membership ||
              (membership.affinityGroupId && !groupScope(staff, membership.affinityGroupId))) fail("NOT_FOUND", 404);
          const body = input<TransferWrite>(raw, "TransferWrite", deps);
          body.to_group_id = body.to_group_id.toLowerCase();
          if (!state.groups[body.to_group_id] || !groupScope(staff, body.to_group_id)) fail("NOT_FOUND", 404);
          const key = receiptKey(request, staff.personId, `/admin/students/${studentId}/transfer`);
          const payload = canonical(body), prior = state.receipts[key];
          if (prior) {
            if (prior.payload !== payload) fail("IDEMPOTENCY_CONFLICT", 409);
            if (!prior.transfer) fail("RESPONSE_INVARIANT_FAILED", 500);
            if (prior.transfer.previous_group_id && !groupScope(staff, prior.transfer.previous_group_id)) fail("NOT_FOUND", 404);
            return { ok: true, data: structuredClone(prior.transfer), schema: "TransferResult" };
          }
          if (!Number.isSafeInteger(body.expected_membership_revision)) fail("SERVICE_UNAVAILABLE", 503);
          if (!deps.reconcileMembershipDependencies) fail("SERVICE_UNAVAILABLE", 503);
          const elapsed = materializeElapsedRights(state, studentId, now);
          if (elapsed) await deps.reconcileMembershipDependencies(state, elapsed);
          // These errors must not roll back already materialized deadline/lapse transitions.
          if (membership.revision !== body.expected_membership_revision)
            return { ok: false, code: "STATE_REVISION_CONFLICT", status: 409 };
          if (!membership.affinityGroupId || membership.affinityGroupId === body.to_group_id)
            return { ok: false, code: "MEMBERSHIP_STATE_CONFLICT", status: 409 };
          if (hasActiveAttempt(state, studentId, now))
            return { ok: false, code: "ACTIVE_EXAM_OR_RECOVERY", status: 409 };
          const oldGroup = membership.affinityGroupId, oldEpoch = membership.epoch;
          const revision = nextRevision(membership.revision), epoch = nextRevision(oldEpoch);
          const revoked: string[] = [];
          const recoveryAnchors: string[] = [];
          for (const [sk, series] of Object.entries(state.student.series)) {
            if (!sk.startsWith(studentId + "/") || series.recoveryState !== "ready" || !series.recovery) continue;
            const anchor = state.recoveryAssignments[sk] ?? state.student.attempts[series.currentAttemptId]?.assignmentId;
            if (!anchor || !state.student.assignments[anchor]) fail("RESPONSE_INVARIANT_FAILED", 500);
            (state.recoveryRevocations ??= []).push({ seriesKey: sk, generation: series.generation,
              assignmentId: anchor, actorId: staff.personId, oldEpoch, revokedAt: now, window: structuredClone(series.recovery) });
            series.recoveryState = "none"; series.recovery = null;
            recoveryAnchors.push(anchor);
          }
          for (const [assignmentId, grant] of Object.entries(state.student.grants[studentId] || {})) {
            const started = Object.values(state.student.attempts).some((a) => a.personId === studentId && a.assignmentId === assignmentId);
            grant.membershipEpoch = epoch; // Derived current epoch also invalidates retained historical grants.
            if (grant.rostered && !started) { grant.rostered = false; revoked.push(assignmentId); }
          }
          membership.affinityGroupId = body.to_group_id; membership.active = true;
          membership.revision = revision; membership.epoch = epoch;
          person.profile.active_group_id = body.to_group_id;
          await deps.reconcileMembershipDependencies(state, { kind: "transferred", change: { actorId: staff.personId, studentId,
            fromGroupId: oldGroup, toGroupId: body.to_group_id, oldEpoch, newEpoch: epoch,
            // A ready-recovery anchor needs barrier/notification maintenance even if its normal test already started.
            revokedAssignmentIds: [...new Set([...revoked, ...recoveryAnchors])], now } });
          const result: TransferResult = { student_id: studentId, previous_group_id: oldGroup,
            active_group_id: body.to_group_id, membership_revision: revision, revoked_unstarted_count: revoked.length };
          state.receipts[key] = { payload, transfer: structuredClone(result) };
          state.audit.push({ actorId: staff.personId, action: "student_transfer", targetId: studentId, revision, at: now });
          return { ok: true, data: result, schema: "TransferResult" };
        }
        if (version && request.method === "PATCH") {
          if (!uuid.test(version[1])) fail("NOT_FOUND", 404);
          const versionId = version[1].toLowerCase(), record = state.versions[versionId];
          if (!record || !canWriteContent(staff, record.subjectId)) fail("NOT_FOUND", 404);
          const body = input<VersionPatch>(raw, "VersionPatch", deps);
          const key = receiptKey(request, staff.personId, `/admin/versions/${versionId}`), payload = canonical(body);
          const prior = state.receipts[key];
          if (prior) {
            if (prior.payload !== payload) fail("IDEMPOTENCY_CONFLICT", 409);
            if (prior.versionId !== versionId) fail("RESPONSE_INVARIANT_FAILED", 500);
            // Technical candidate: replay returns the current version projection,
            // retaining one command effect and never claiming an old draft remains editable.
            return { ok: true, data: structuredClone(record.wire), schema: "Version" };
          }
          if (!Number.isSafeInteger(body.expected_revision) || !Number.isSafeInteger(body.duration_seconds))
            fail("SERVICE_UNAVAILABLE", 503); // JS representation guard, not an approved product duration cap.
          if (record.wire.revision !== body.expected_revision) fail("RESOURCE_REVISION_CONFLICT", 409);
          if (record.wire.status !== "draft") fail("VERSION_FROZEN", 409);
          if (body.instructions_blocks.some((block) => block.type === "image")) {
            if (!deps.validateInstructionAssets) fail("SERVICE_UNAVAILABLE", 503);
            await deps.validateInstructionAssets(state, versionId, body);
          }
          const revision = nextRevision(record.wire.revision);
          record.wire = { ...record.wire, duration_seconds: body.duration_seconds,
            instructions_blocks: structuredClone(body.instructions_blocks), grading_config: structuredClone(body.grading_config), revision };
          state.receipts[key] = { payload, versionId };
          state.audit.push({ actorId: staff.personId, action: "draft_metadata", targetId: versionId, revision, at: now });
          return { ok: true, data: structuredClone(record.wire), schema: "Version" };
        }
        fail("NOT_FOUND", 404);
      });
      // Resolve means committed. Response errors never undo expiry or a committed command.
      if (!outcome.ok) fail(outcome.code, outcome.status);
      if (!deps.validate!(outcome.schema, outcome.data)) fail("RESPONSE_INVARIANT_FAILED", 500);
      return new Response(JSON.stringify({ data: outcome.data }), { status: outcome.status ?? 200, headers });
    } catch (error) {
      const fault = error instanceof ApiFault ? error : new ApiFault("INTERNAL_ERROR", 500);
      return new Response(JSON.stringify({ error: { code: fault.code, message: fault.code,
        request_id: crypto.randomUUID() } }), { status: fault.status, headers });
    }
  };
}

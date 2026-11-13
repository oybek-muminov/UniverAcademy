import { fail } from "./fault.ts";
import { guardRosterRemovalActiveTest, REMOVAL_DECISION } from "./membership-activity.ts";
import { requireRemovalAuthority } from "./removal-authority.ts";
import { reconcileMembershipEffects } from "./membership-effects.ts";
import { currentStaff, nextRevision } from "./staff-state.ts";
import type { MemberWrite, MembershipMutation, StaffTransaction, VerifiedStaffProof } from "./staff-state.ts";

export type MembershipRemovalOutcome =
  { kind: "removed" | "replayed"; membership: MembershipMutation } |
  { kind: "wait_for_active_test" } |
  { kind: "denied"; code: "RESOURCE_REVISION_CONFLICT" | "STATE_REVISION_CONFLICT" | "MEMBERSHIP_STATE_CONFLICT" };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Local domain command, not HTTP or a repository. The caller must provide the
// verifier-produced identity and COMPLETE protected state in one transaction.
// Return clean outcomes from that transaction; throwing rolls back every write.
// Neither a returned domain success nor this function's Promise is a COMMIT ACK.
export async function removeRosterMember(tx: StaffTransaction, proof: VerifiedStaffProof,
  rawGroupId: string, body: MemberWrite, idempotencyKey: string): Promise<MembershipRemovalOutcome> {
  const now = tx.now();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) fail("SERVICE_UNAVAILABLE", 503);
  const state = tx.state, staff = currentStaff(state, proof, now);
  const groupId = typeof rawGroupId === "string" ? rawGroupId.toLowerCase() : "";
  requireRemovalAuthority(staff, groupId); // Capability/privacy precedence is removal-specific.
  if (!uuid.test(groupId) || !body || typeof body.student_id !== "string" ||
      !uuid.test(body.student_id) || (body.status !== "removed" && body.status !== "active") ||
      Object.keys(body).some(k => !["student_id", "status", "expected_revision", "expected_membership_revision"].includes(k)) ||
      !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0 ||
      !Number.isSafeInteger(body.expected_membership_revision) || body.expected_membership_revision < 0 ||
      typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128)
    fail("VALIDATION_ERROR", 422);
  const studentId = body.student_id.toLowerCase();
  const group = state.groups[groupId], person = state.student.people[studentId], membership = state.memberships[studentId];
  if (!group || !person?.enabled || !person.profile.roles.includes("student") ||
      !person.profile.registration_complete || !membership || !membership.affinityGroupId ||
      !state.groups[membership.affinityGroupId])
    fail("NOT_FOUND", 404);
  // A historical receipt is visible only under current authority for BOTH its
  // original group and the target's current affinity. Teacher uses explicit
  // grants at both boundaries; all_groups is not a substitute for those grants.
  requireRemovalAuthority(staff, membership.affinityGroupId);

  const key = staff.personId + "/PUT//admin/groups/" + groupId + "/members/" + idempotencyKey;
  const payload = JSON.stringify({ expected_membership_revision: body.expected_membership_revision,
    expected_revision: body.expected_revision, status: body.status, student_id: studentId });
  const prior = state.receipts[key];
  if (prior) {
    if (prior.payload !== payload) fail("IDEMPOTENCY_CONFLICT", 409);
    if (body.status !== "removed") fail("VALIDATION_ERROR", 422); // This command never adds/re-adds.
    if (!prior.membership || prior.membership.student_id !== studentId ||
        prior.membership.group_id !== groupId || prior.membership.status !== "removed")
      fail("RESPONSE_INVARIANT_FAILED", 500);
    // Historical receipt: no old CAS, expiry, guard or newly granted right is touched.
    return { kind: "replayed", membership: structuredClone(prior.membership) };
  }
  if (body.status !== "removed") fail("VALIDATION_ERROR", 422);
  // Equality is a NEW removal precondition, not a historical-replay filter.
  if (membership.affinityGroupId !== groupId) fail("NOT_FOUND", 404);

  // One post-lock clock frame, as in the accepted explicit-port adapter. No
  // external provider/writer callback is accepted between authority and mutation.
  const outcome = await guardRosterRemovalActiveTest({ state, now: () => now }, studentId,
    REMOVAL_DECISION.CONTINUE, { proof, groupId, expectedGroupRevision: body.expected_revision,
      expectedMembershipRevision: body.expected_membership_revision });
  if (outcome.kind === "recognized_denial") return { kind: "denied",
    code: outcome.reason === "group_revision_conflict" ? "RESOURCE_REVISION_CONFLICT" : "STATE_REVISION_CONFLICT" };
  if (!membership.active) return { kind: "denied", code: "MEMBERSHIP_STATE_CONFLICT" };
  if (outcome.kind === "wait_for_active_test") return outcome;
  if (person.profile.active_group_id !== groupId) fail("RESPONSE_INVARIANT_FAILED", 500);

  const oldEpoch = membership.epoch, revision = nextRevision(membership.revision);
  const epoch = nextRevision(oldEpoch), groupRevision = nextRevision(group.revision!);
  const ready = Object.entries(state.student.series).filter(([sk, series]) =>
    sk.startsWith(studentId + "/") && series.recoveryState === "ready").map(([sk, series]) => {
      const anchor = state.recoveryAssignments[sk] ?? state.student.attempts[series.currentAttemptId]?.assignmentId;
      const assignment = anchor ? state.student.assignments[anchor] : undefined;
      if (!series.recovery || !anchor || !assignment ||
          assignment.published.demoId !== sk.slice(studentId.length + 1))
        fail("RESPONSE_INVARIANT_FAILED", 500);
      return { sk, series, anchor, window: structuredClone(series.recovery) };
    });
  const grants = Object.entries(state.student.grants[studentId] ?? {}).map(([assignmentId, grant]) => {
    const started = Object.values(state.student.attempts).some(a =>
      a.personId === studentId && a.assignmentId === assignmentId);
    if (grant.rostered && !started && !state.student.assignments[assignmentId]) fail("RESPONSE_INVARIANT_FAILED", 500);
    return { assignmentId, grant, started };
  });
  const revoked: string[] = [];
  for (const { assignmentId, grant, started } of grants) {
    grant.membershipEpoch = epoch;
    if (grant.rostered && !started) { grant.rostered = false; revoked.push(assignmentId); }
  }
  for (const r of ready) {
    (state.recoveryRevocations ??= []).push({ seriesKey: r.sk, generation: r.series.generation,
      assignmentId: r.anchor, actorId: staff.personId, oldEpoch, revokedAt: now, window: r.window });
    r.series.recoveryState = "none"; r.series.recovery = null;
  }
  membership.active = false; membership.revision = revision; membership.epoch = epoch;
  person.profile.active_group_id = null; group.revision = groupRevision;
  await reconcileMembershipEffects(state, { kind: "removed", change: {
    actorId: staff.personId, studentId, fromGroupId: groupId, oldEpoch, newEpoch: epoch,
    revokedAssignmentIds: [...new Set([...revoked, ...ready.map(r => r.anchor)])], now } });
  const result: MembershipMutation = { student_id: studentId, group_id: groupId, status: "removed",
    group_revision: groupRevision, membership_revision: revision, revoked_unstarted_count: revoked.length };
  state.receipts[key] = { payload, membership: structuredClone(result) };
  state.audit.push({ actorId: staff.personId, action: "membership_removal", targetId: studentId, revision, at: now });
  return { kind: "removed", membership: structuredClone(result) };
}

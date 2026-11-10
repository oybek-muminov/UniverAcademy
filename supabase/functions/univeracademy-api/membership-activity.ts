import { fail } from "./fault.ts";
import { expireForMembershipGuard } from "./attempts.ts";
import { seriesKey } from "./student-state.ts";
import { currentStaff, groupScope, requireRosterAuthority } from "./staff-state.ts";
import type { MembershipEffect, StaffState, StaffTransaction, VerifiedStaffProof } from "./staff-state.ts";
import { reconcileMembershipEffects } from "./membership-effects.ts";
import { requireRemovalAuthority } from "./removal-authority.ts";

type ElapsedAttempts = Extract<MembershipEffect, { kind: "elapsed" }>;

function checkClock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000)
    fail("SERVICE_UNAVAILABLE", 503);
}

// Caller already holds the target's person/series locks and current authority.
// Only the current generation is maintained; historical/foreign attempts stay intact.
export function materializeElapsedAttempts(state: StaffState, studentId: string, now: number): ElapsedAttempts | null {
  checkClock(now);
  const s = state.student, assignments = new Set<string>(), demos = new Set<string>();
  for (const record of Object.values(s.attempts)) {
    if (record.personId !== studentId) continue;
    const series = s.series[seriesKey(studentId, record.published.demoId)];
    if (!series || series.currentAttemptId !== record.id || series.generation !== record.generation) continue;
    const next = expireForMembershipGuard(record, now);
    if (next !== record) {
      s.attempts[record.id] = next;
      series.officialAttemptId = next.id;
      assignments.add(record.assignmentId); demos.add(record.published.demoId);
      if (next.generation > 1) { series.recoveryState = "none"; series.recovery = null; }
    }
  }
  return demos.size ? { kind: "elapsed", studentId, assignmentIds: [...assignments], demoIds: [...demos], now } : null;
}

export function hasActiveAttempt(state: StaffState, studentId: string, now: number): boolean {
  checkClock(now);
  const s = state.student;
  return Object.values(s.attempts).some((record) => {
    if (record.personId !== studentId) return false;
    const series = s.series[seriesKey(studentId, record.published.demoId)];
    return Boolean(series && series.currentAttemptId === record.id && series.generation === record.generation &&
      record.status === "in_progress" && now < record.deadlineAt);
  });
}

export const REMOVAL_DECISION = Object.freeze({
  CONTINUE: Object.freeze({ kind: "continue_existing_policy" } as const),
  DENY_GROUP_REVISION: Object.freeze({ kind: "recognized_denial", reason: "group_revision_conflict" } as const),
  DENY_MEMBERSHIP_REVISION: Object.freeze({ kind: "recognized_denial", reason: "membership_revision_conflict" } as const),
});
export type RemovalActiveTestOutcome = typeof REMOVAL_DECISION[keyof typeof REMOVAL_DECISION] |
  { kind: "wait_for_active_test" };
export type RemovalGuardContext = Readonly<{
  proof: VerifiedStaffProof; groupId: string;
  expectedGroupRevision: number; expectedMembershipRevision: number;
}>;

function checkCurrentAttemptContext(state: StaffState, studentId: string): void {
  const s = state.student;
  for (const [key, series] of Object.entries(s.series)) {
    if (!key.startsWith(studentId + "/")) continue;
    const record = s.attempts[series.currentAttemptId];
    if (!record || record.id !== series.currentAttemptId ||
        record.personId !== studentId || key !== seriesKey(studentId, record.published.demoId) ||
        record.generation !== series.generation ||
        (record.status === "in_progress" && record.ordinary !== null)) fail("RESPONSE_INVARIANT_FAILED", 500);
  }
  for (const record of Object.values(s.attempts))
    if (record.personId === studentId && record.status === "in_progress" &&
        !s.series[seriesKey(studentId, record.published.demoId)]) fail("RESPONSE_INVARIANT_FAILED", 500);
}

// Internal preflight only. No arbitrary continuation/reconciler is executed.
// Caller supplies a verifier-produced proof and authoritative state under the
// existing person/resource locks. A singleton is neither authority nor freshness.
// Receipt handling and final removal policy/HTTP mapping remain outside this API.
export async function guardRemovalActiveTest(tx: StaffTransaction, studentId: string,
  decision: unknown, context: RemovalGuardContext): Promise<RemovalActiveTestOutcome> {
  // FIRST: never inspect, coerce, await or log an unrecognized decision payload.
  if (decision !== REMOVAL_DECISION.CONTINUE && decision !== REMOVAL_DECISION.DENY_GROUP_REVISION &&
      decision !== REMOVAL_DECISION.DENY_MEMBERSHIP_REVISION) fail("RESPONSE_INVARIANT_FAILED", 500);
  return guardActiveTest(tx, studentId, decision, context, false);
}

/** Separate removal-specific entry. The policy is hard-wired here, never
 * selected by a request, an options field, a decision or a caller callback. */
export async function guardRosterRemovalActiveTest(tx: StaffTransaction, studentId: string,
  decision: unknown, context: RemovalGuardContext): Promise<RemovalActiveTestOutcome> {
  // FIRST, including for this entry: unrecognized payloads execute no hooks.
  if (decision !== REMOVAL_DECISION.CONTINUE && decision !== REMOVAL_DECISION.DENY_GROUP_REVISION &&
      decision !== REMOVAL_DECISION.DENY_MEMBERSHIP_REVISION) fail("RESPONSE_INVARIANT_FAILED", 500);
  return guardActiveTest(tx, studentId, decision, context, true);
}

async function guardActiveTest(tx: StaffTransaction, studentId: string,
  decision: unknown, context: RemovalGuardContext, rosterRemoval: boolean): Promise<RemovalActiveTestOutcome> {
  const now = tx.now(); // The transaction port supplies server time after locks.
  checkClock(now);
  const staff = currentStaff(tx.state, context.proof, now);
  if (rosterRemoval) requireRemovalAuthority(staff, context.groupId);
  else requireRosterAuthority(staff); // Preserve the legacy Admin/Owner boundary.
  const group = tx.state.groups[context.groupId], person = tx.state.student.people[studentId];
  const membership = tx.state.memberships[studentId];
  if (!group || !groupScope(staff, context.groupId) || !person?.enabled ||
      !person.profile.roles.includes("student") || !person.profile.registration_complete ||
      !membership || membership.affinityGroupId !== context.groupId) fail("NOT_FOUND", 404);
  for (const revision of [group.revision, membership.revision, context.expectedGroupRevision, context.expectedMembershipRevision])
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) fail("RESPONSE_INVARIANT_FAILED", 500);
  // Derive CAS from CURRENT locked state. CONTINUE cannot bypass a stale CAS;
  // a supplied denial must also agree with the authoritative first conflict.
  const current = group.revision !== context.expectedGroupRevision ? REMOVAL_DECISION.DENY_GROUP_REVISION :
    membership.revision !== context.expectedMembershipRevision ? REMOVAL_DECISION.DENY_MEMBERSHIP_REVISION : REMOVAL_DECISION.CONTINUE;
  if (decision !== REMOVAL_DECISION.CONTINUE && decision !== current) fail("RESPONSE_INVARIANT_FAILED", 500);
  checkCurrentAttemptContext(tx.state, studentId);
  const elapsed = materializeElapsedAttempts(tx.state, studentId, now);
  if (elapsed) await reconcileMembershipEffects(tx.state, elapsed);
  // A returned clean CAS denial commits canonical maintenance, without a writer.
  if (current !== REMOVAL_DECISION.CONTINUE) return current;
  if (hasActiveAttempt(tx.state, studentId, now)) return { kind: "wait_for_active_test" };
  // Not removal approval. Ready rights stay intact; B applies to future final removal.
  return REMOVAL_DECISION.CONTINUE;
}

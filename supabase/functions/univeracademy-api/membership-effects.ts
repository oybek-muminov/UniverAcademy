import { fail } from "./fault.ts";
import { seriesKey } from "./student-state.ts";
import { nextRevision } from "./staff-state.ts";
import type { MembershipEffect, StaffState } from "./staff-state.ts";

// Scoped snapshot projection for this RAM candidate. Production must load the
// actual protected participant/recovery set and commit every change atomically.
export async function reconcileMembershipEffects(state: StaffState, effect: MembershipEffect): Promise<void> {
  const s = state.student;
  if (effect.kind === "removed") {
    const c = effect.change;
    for (const notification of Object.values(state.notifications))
      if (notification.studentId === c.studentId && notification.epoch === c.oldEpoch && notification.status === "queued")
        notification.status = "cancelled";
    for (const approval of Object.values(state.approvals))
      if (approval.studentId === c.studentId && approval.epoch === c.oldEpoch && approval.status === "pending")
        approval.status = "stale";
  }
  if (effect.kind === "transferred") {
    const c = effect.change;
    for (const notification of Object.values(state.notifications))
      if (notification.studentId === c.studentId && notification.epoch === c.oldEpoch &&
          notification.status === "queued" && c.revokedAssignmentIds.includes(notification.assignmentId))
        notification.status = "cancelled";
    for (const approval of Object.values(state.approvals))
      if (approval.studentId === c.studentId && approval.epoch === c.oldEpoch && approval.status === "pending")
        approval.status = "stale";
  }
  const now = effect.kind === "elapsed" ? effect.now : effect.change.now;
  for (const assignment of Object.values(s.assignments)) {
    const id = assignment.admission.assignmentId;
    const affected = effect.kind === "elapsed" ?
      effect.assignmentIds.includes(id) || effect.demoIds.includes(assignment.published.demoId) :
      effect.change.revokedAssignmentIds.includes(id);
    if (!affected) continue;
    const unresolved = new Set<string>(), active = new Set<string>(), ready = new Set<string>();
    for (const [personId, grants] of Object.entries(s.grants)) {
      const grant = grants[id], person = s.people[personId], membership = state.memberships[personId];
      const series = s.series[seriesKey(personId, assignment.published.demoId)];
      if (now < assignment.admission.closesAt && !assignment.cancelled && !series?.normalAttemptUsed &&
          grant?.rostered && membership?.active && membership.epoch === grant.grantEpoch &&
          grant.membershipEpoch === grant.grantEpoch && person.profile.active_group_id === assignment.admission.groupId)
        unresolved.add(personId);
    }
    for (const [key, series] of Object.entries(s.series)) {
      const attempt = s.attempts[series.currentAttemptId];
      if (attempt?.assignmentId === id && attempt.generation === series.generation &&
          attempt.status === "in_progress" && now < attempt.deadlineAt) active.add(attempt.personId);
      if (series.recoveryState === "ready" && series.recovery && now < series.recovery.closesAt) {
        const anchor = state.recoveryAssignments[key] ?? attempt?.assignmentId;
        if (!anchor) fail("RESPONSE_INVARIANT_FAILED", 500);
        if (anchor === id) ready.add(key.split("/")[0]); // never exclude a future opensAt
      }
    }
    for (const id of [...active, ...ready]) unresolved.add(id);
    const gate = assignment.reviewGate;
    gate.eligible_unresolved_count = unresolved.size; gate.active_count = active.size; gate.recovery_ready_count = ready.size;
    gate.barrier_complete = now >= assignment.admission.closesAt && unresolved.size === 0;
    gate.barrier_revision = nextRevision(gate.barrier_revision as number);
    // Preserve review release/window and bonus state. Recalculation never opens review.
  }
}

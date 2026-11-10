import { fail } from "./fault.ts";
import { groupScope, nextRevision, owner, requireRosterAuthority } from "./staff-state.ts";
import type { Assignment, AssignmentCreate, DraftRecord, MemberWrite, MembershipMutation, StaffAccessRecord, StaffState } from "./staff-state.ts";
import type { AssignmentRecord } from "./student-state.ts";

function publishedContent(state: StaffState, version: DraftRecord):
  Pick<AssignmentRecord, "published" | "title" | "instructions" | "contents"> {
  const snapshot = version.publishedSnapshot;
  if (!snapshot) {
    // Compatibility with previously loaded published fixtures. A new publication
    // always takes the snapshot branch, never another version's content.
    const loaded = Object.values(state.student.assignments).find((a) =>
      a.published.versionId === version.wire.id && a.published.demoId === version.wire.demo_id);
    if (!loaded) fail("SERVICE_UNAVAILABLE", 503);
    return structuredClone({ published: loaded.published, title: loaded.title,
      instructions: loaded.instructions, contents: loaded.contents });
  }
  const demo = state.demos?.[version.wire.demo_id];
  if (!demo) fail("SERVICE_UNAVAILABLE", 503);
  const test = snapshot.test;
  if (demo.subjectId !== version.subjectId || typeof demo.title !== "string" ||
      test.demoId !== version.wire.demo_id || test.versionId !== version.wire.id ||
      test.durationMs !== version.wire.duration_seconds * 1000 ||
      test.individualEnabled !== version.wire.grading_config.individual_enabled ||
      snapshot.questions.length !== test.questions.length || !test.questions.length)
    fail("RESPONSE_INVARIANT_FAILED", 500);
  const contents = Object.fromEntries(snapshot.questions.map((q, index) => {
    const pinned = test.questions[index];
    if (q.id !== pinned.id || q.correct_option_id !== pinned.correctOptionId ||
        q.options.length !== pinned.optionIds.length || q.options.some((o, n) => o.id !== pinned.optionIds[n]))
      fail("RESPONSE_INVARIANT_FAILED", 500);
    // Only prompts/options enter the student content projection. Keys, authored
    // points and explanations stay in the private published snapshot.
    return [q.id, { prompt: q.prompt_blocks,
      options: Object.fromEntries(q.options.map((o) => [o.id, o.blocks])) }];
  }));
  return structuredClone({ published: test, title: demo.title, instructions: snapshot.instructions, contents });
}

// Narrow local provisioning candidate, not a complete roster/assignment subsystem.
export function addInitialMember(state: StaffState, staff: StaffAccessRecord, groupId: string,
  body: MemberWrite, key: string, payload: string, now: number): MembershipMutation {
  requireRosterAuthority(staff); // Owner/delegated Admin only in this narrow driver.
  const group = state.groups[groupId];
  if (!group || !groupScope(staff, groupId)) fail("NOT_FOUND", 404);
  const studentId = body.student_id.toLowerCase(), person = state.student.people[studentId];
  const membership = state.memberships[studentId];
  if (!person?.profile.roles.includes("student") || !person.enabled || !person.profile.registration_complete ||
      !membership || (membership.affinityGroupId && !groupScope(staff, membership.affinityGroupId))) fail("NOT_FOUND", 404);
  const prior = state.receipts[key];
  if (prior) {
    if (prior.payload !== payload) fail("IDEMPOTENCY_CONFLICT", 409);
    if (!prior.membership) fail("RESPONSE_INVARIANT_FAILED", 500);
    return structuredClone(prior.membership);
  }
  if (!Number.isSafeInteger(group.revision) || !Number.isSafeInteger(body.expected_revision) ||
      !Number.isSafeInteger(body.expected_membership_revision)) fail("SERVICE_UNAVAILABLE", 503);
  if (group.revision !== body.expected_revision) fail("RESOURCE_REVISION_CONFLICT", 409);
  if (membership.revision !== body.expected_membership_revision) fail("STATE_REVISION_CONFLICT", 409);
  if (group.status !== "active") fail("MEMBERSHIP_STATE_CONFLICT", 409);
  if (body.status !== "active") fail("SERVICE_UNAVAILABLE", 503); // removal/re-add not implemented here
  if (membership.affinityGroupId !== null || membership.active || person.profile.active_group_id !== null)
    fail("MEMBERSHIP_STATE_CONFLICT", 409);
  if (Object.keys(state.student.grants[studentId] ?? {}).length) fail("RESPONSE_INVARIANT_FAILED", 500);
  membership.affinityGroupId = groupId; membership.active = true;
  membership.revision = nextRevision(membership.revision); membership.epoch = nextRevision(membership.epoch);
  person.profile.active_group_id = groupId;
  group.revision = nextRevision(group.revision!);
  const result: MembershipMutation = { student_id: studentId, group_id: groupId, status: "active",
    group_revision: group.revision, membership_revision: membership.revision, revoked_unstarted_count: 0 };
  state.receipts[key] = { payload, membership: structuredClone(result) };
  state.audit.push({ actorId: staff.personId, action: "initial_membership", targetId: studentId,
    revision: membership.revision, at: now });
  return result;
}

export function isProtectedNextMidnight(opensAt: number, closesAt: number, timezone: string): boolean {
  if (!Number.isFinite(opensAt) || !Number.isFinite(closesAt) || closesAt <= opensAt || closesAt % 1000) return false;
  const format = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = (at: number) => Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
  const a = parts(opensAt), b = parts(closesAt);
  return b.hour === "00" && b.minute === "00" && b.second === "00" &&
    Date.UTC(+b.year, +b.month - 1, +b.day) === Date.UTC(+a.year, +a.month - 1, +a.day) + 86_400_000;
}

export function createPilotAssignment(state: StaffState, staff: StaffAccessRecord, body: AssignmentCreate,
  key: string, payload: string, now: number, assignmentId: () => string): Assignment {
  // User-confirmed policy A: test management authorizes assignment; roster is separate.
  if (!owner(staff)) {
    if (!staff.roles.includes("admin")) fail("SERVICE_UNAVAILABLE", 503); // Teacher delegation is a later step.
    if (!staff.capabilities.manage_content) fail("CAPABILITY_REQUIRED", 403);
  }
  const group = state.groups[body.group_id], version = state.versions[body.version_id];
  if (!group || group.status !== "active" || !version || version.wire.demo_id !== body.demo_id ||
      !groupScope(staff, body.group_id) || (!owner(staff) && !staff.scope.all_subjects &&
      !staff.scope.subject_ids.includes(version.subjectId))) fail("NOT_FOUND", 404);
  const prior = state.receipts[key];
  if (prior) {
    if (prior.payload !== payload) fail("IDEMPOTENCY_CONFLICT", 409);
    if (!prior.assignment) fail("RESPONSE_INVARIANT_FAILED", 500);
    return structuredClone(prior.assignment);
  }
  if (version.wire.status !== "published") fail("VERSION_FROZEN", 409);
  const opensAt = Date.parse(body.opens_at), closesAt = Date.parse(body.closes_at);
  if (!isProtectedNextMidnight(opensAt, closesAt, body.timezone)) fail("INVALID_TIME_WINDOW", 422);
  if (body.reminder_lead_seconds !== null || body.review_policy !== "teacher_approval") fail("SERVICE_UNAVAILABLE", 503);
  if (new Set(body.student_ids.map((v) => v.toLowerCase())).size !== body.student_ids.length) fail("VALIDATION_ERROR", 422);
  for (const id of body.student_ids) {
    const person = state.student.people[id], membership = state.memberships[id];
    if (!person?.enabled || !person.profile.registration_complete || !person.profile.roles.includes("student") ||
        !membership?.active || membership.affinityGroupId !== body.group_id || person.profile.active_group_id !== body.group_id)
      fail("NOT_FOUND", 404);
  }
  if (Object.values(state.student.assignments).some((a) => a.admission.groupId === body.group_id && a.published.demoId === body.demo_id))
    fail("ASSIGNMENT_CONFLICT", 409);
  const content = publishedContent(state, version);
  const id = assignmentId();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || state.student.assignments[id])
    fail("SERVICE_UNAVAILABLE", 503);
  state.student.assignments[id] = { ...content, cancelled: false,
    // Person-specific admission values are resolved from current profile/grant
    // under the student transaction lock, never copied from a template pupil.
    admission: { assignmentId: id, groupId: body.group_id, activeGroupId: null, opensAt, closesAt,
      rostered: false, profileComplete: false, membershipEpoch: 0, grantEpoch: 0 },
    reviewGate: { id: crypto.randomUUID(), status: "blocked", revision: 0,
      barrier_revision: 0, barrier_complete: false, eligible_unresolved_count: body.student_ids.length,
      active_count: 0, recovery_ready_count: 0, timezone: body.timezone, first_opened_at: null, opens_at: null, closes_at: null } };
  for (const personId of body.student_ids) {
    const membership = state.memberships[personId];
    (state.student.grants[personId] ??= {})[id] = { rostered: true,
      membershipEpoch: membership.epoch, grantEpoch: membership.epoch };
  }
  const result: Assignment = { id, demo_id: body.demo_id, version_id: body.version_id, group_id: body.group_id,
    opens_at: body.opens_at, closes_at: body.closes_at, timezone: body.timezone, review_policy: body.review_policy,
    reminder_lead_seconds: body.reminder_lead_seconds, admission_status: now < opensAt ? "scheduled" : now >= closesAt ? "closed" : "open", revision: 0 };
  state.receipts[key] = { payload, assignment: structuredClone(result) };
  state.audit.push({ actorId: staff.personId, action: "assignment_create", targetId: id, revision: 0, at: now });
  return result;
}

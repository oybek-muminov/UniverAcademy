import { createStudentHttpHandler } from "../supabase/functions/univeracademy-api/student-http.ts";
import { createStaffHttpHandler } from "../supabase/functions/univeracademy-api/staff-http.ts";
import { STAFF_CONTRACT_SHA } from "../supabase/functions/univeracademy-api/staff-state.ts";
import { StaffFixture, validate, verifySyntheticStaffToken } from "../tests/backend/staff-fixture.ts";
import { ids, testNumbers, botKey } from "../tests/backend/http-fixture.ts";
import { LOCAL_CANDIDATE_POLICY } from "./local-lab.mjs";
import { UNGROUPED, ungroupedSchedule } from "./ungrouped-fixture.mjs";

export function createUngroupedLab({ now = Date.now } = {}) {
  // ponytail: one existing RAM coordinator/global lock; no durable DB or provider adapter.
  const store = new StaffFixture(now), state = store.state, student = state.student;
  const person = student.people[UNGROUPED.studentId];
  person.profile.registration_complete = false; person.profile.active_group_id = null;
  student.people = { [UNGROUPED.studentId]: person }; student.grants = { [UNGROUPED.studentId]: {} };
  state.memberships = { [UNGROUPED.studentId]: { affinityGroupId: null, active: false, revision: 0, epoch: 0 } };
  state.groups[UNGROUPED.groupId] = { id: UNGROUPED.groupId, revision: 0, status: "active" };
  state.notifications = {}; state.approvals = {};
  const template = student.assignments[ids.assignment];
  template.published.durationMs = 300_000;
  template.title = "Fizika — faqat guruhsiz sintetik fixture";
  template.instructions = [{ type: "text", markdown: "Faqat lokal sinov: ikki sun’iy savol, bitta javob." }];
  for (const [i, q] of template.published.questions.entries()) template.contents[q.id] = {
    prompt: [{ type: "text", markdown: `Sintetik fizika savoli ${i + 1}` }],
    options: Object.fromEntries(q.optionIds.map((id, n) => [id, [{ type: "text", markdown: `Sintetik ${"ABCD"[n]}` }]])) };
  student.assignments = { [ids.assignment]: template }; // private ready template, no grant to the pupil
  state.versions[UNGROUPED.versionId] = { subjectId: "physics", questionIds: template.published.questions.map((q) => q.id),
    wire: { id: UNGROUPED.versionId, demo_id: UNGROUPED.demoId, version_no: 1, duration_seconds: 300,
      instructions_blocks: structuredClone(template.instructions), status: "published", revision: 1,
      grading_config: { individual_enabled: false } } };
  const pupil = createStudentHttpHandler({ transactions: store.studentTransactions, botToken: botKey,
    sessionPolicy: LOCAL_CANDIDATE_POLICY, numericPresentation: testNumbers });
  const staff = createStaffHttpHandler({ transactions: store, contractSha: STAFF_CONTRACT_SHA, validate,
    verifyStaffToken: (token) => verifySyntheticStaffToken(token, now()),
    reconcileMembershipDependencies: (state, effect) => store.effects(state, effect),
    newAssignmentId: () => UNGROUPED.assignmentId }); // reserved fixture UUID, not a production allocator
  return { store, handler: (request) => new URL(request.url).pathname.startsWith("/api/v1/admin/") ? staff(request) : pupil(request),
    run: { run_id: crypto.randomUUID(), mode: "LOCAL_UNGROUPED_SYNTHETIC_ONLY", fixture: UNGROUPED,
      schedule: ungroupedSchedule(now()), membership: { expected_revision: 0, expected_membership_revision: 0 },
      staffAuth: "SYNTHETIC_ONLY_NOT_REAL_JWT", assignmentWriter: "ADMIN_MANAGE_CONTENT_SCOPED_POLICY_A",
      recoveryGuard: "USER_CONFIRMED_TRANSFER_ACTIVE_ATTEMPT_ONLY_LOCAL_CANDIDATE" } };
}

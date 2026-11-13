import { fail } from "./fault.ts";
import type { AnswerAck, AttemptRecord } from "./attempts.ts";
import type { Ratio } from "./ordinary.ts";
import { seriesKey } from "./student-state.ts";
import type { AssignmentRecord, NumericPresentation, Person, StudentState } from "./student-state.ts";

export function utc(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 8_640_000_000_000_000) {
    fail("RESPONSE_INVARIANT_FAILED", 500);
  }
  return new Date(ms).toISOString();
}
export function profileWire(person: Person) {
  const p = person.profile;
  return { person_id: p.person_id, first_name: p.first_name, last_name: p.last_name,
    roles: [...p.roles], registration_complete: p.registration_complete,
    active_group_id: p.active_group_id, qadam_id: p.qadam_id };
}
export function numberWire(value: Ratio, policy: NumericPresentation | undefined): number {
  if (!policy?.policyId || typeof policy.toFiniteNumber !== "function") {
    fail("GRADING_POLICY_UNRESOLVED", 409);
  }
  const result = policy.toFiniteNumber(value);
  if (typeof result !== "number" || !Number.isFinite(result) || result < 0) {
    fail("GRADING_POLICY_UNRESOLVED", 409);
  }
  return result;
}

function halfUpDisplay(value: Ratio, scale: bigint, places: number): string {
  if (value.numerator < 0n || value.denominator <= 0n) fail("GRADING_POLICY_UNRESOLVED", 409);
  const scaled = value.numerator * scale;
  let cents = scaled / value.denominator;
  if ((scaled % value.denominator) * 2n >= value.denominator) cents++;
  return `${cents / scale}.${String(cents % scale).padStart(places, "0")}`;
}

// Percentage keeps the prior2dp candidate; approved student points policy is separate.
export const candidateHalfUp2 = (value: Ratio): string => halfUpDisplay(value, 100n, 2);
export const studentPointsHalfUp1 = (value: Ratio): string => halfUpDisplay(value, 10n, 1);

function studentPointsDisplayWire(value: Ratio, policy: NumericPresentation | undefined): string {
  if (!policy?.policyId || typeof policy.toStudentPointsDisplayString !== "function") {
    fail("GRADING_POLICY_UNRESOLVED", 409);
  }
  const rendered = policy.toStudentPointsDisplayString(value);
  if (typeof rendered !== "string" || !/^(0|[1-9][0-9]*)\.[0-9](?![\s\S])/.test(rendered)) {
    fail("GRADING_POLICY_UNRESOLVED", 409);
  }
  return rendered;
}

function displayWire(value: Ratio, policy: NumericPresentation | undefined): string {
  if (!policy?.policyId || typeof policy.toDisplayString !== "function") {
    fail("GRADING_POLICY_UNRESOLVED", 409);
  }
  const rendered = policy.toDisplayString(value);
  if (typeof rendered !== "string" || !/^(0|[1-9][0-9]*)\.[0-9]{2}(?![\s\S])/.test(rendered)) {
    fail("GRADING_POLICY_UNRESOLVED", 409);
  }
  return rendered;
}
export function scoreWire(state: StudentState, record: AttemptRecord,
  policy: NumericPresentation | undefined) {
  const source = record.ordinary;
  let ordinary = null;
  if (source) {
    const earned = numberWire(source.earned, policy), maximum = numberWire(source.maximum, policy);
    const percentage = numberWire(source.percentage, policy);
    if (maximum <= 0 || earned > maximum || percentage > 100) fail("GRADING_POLICY_UNRESOLVED", 409);
    ordinary = { earned_points: earned, max_points: maximum, percentage,
      calculated_at: utc(source.calculatedAt), display: {
        earned_points: studentPointsDisplayWire(source.earned, policy),
        max_points: studentPointsDisplayWire(source.maximum, policy),
        percentage: displayWire(source.percentage, policy),
      } };
  }
  if (["submitted", "expired", "forced"].includes(record.status) && !ordinary) {
    fail("RESPONSE_INVARIANT_FAILED", 500);
  }
  const bonus = state.bonuses[record.id];
  return {
    attempt_id: record.id, ordinary,
    statistical_bonus: bonus ? { calculation_id: bonus.calculationId,
      earned_points: numberWire(bonus.earned, policy), calculated_at: utc(bonus.calculatedAt),
      display: { earned_points: studentPointsDisplayWire(bonus.earned, policy) } } : null,
  };
}

function blocksWire(blocks: unknown[]) {
  return blocks.map((input) => {
    if (!input || typeof input !== "object") fail("RESPONSE_INVARIANT_FAILED", 500);
    const b = input as Record<string, unknown>;
    if (b.type === "text" && typeof b.markdown === "string" && Array.from(b.markdown).length <= 20000) {
      return { type: "text", markdown: b.markdown };
    }
    if (b.type === "formula" && typeof b.latex === "string" && Array.from(b.latex).length <= 10000 &&
      (b.display === "inline" || b.display === "block")) {
      return { type: "formula", latex: b.latex, display: b.display };
    }
    // Private-media signing/validation is not implemented. Never pass an internal asset through.
    if (b.type === "image") fail("SERVICE_UNAVAILABLE", 503);
    fail("RESPONSE_INVARIANT_FAILED", 500);
  });
}

export function seriesWire(state: StudentState, personId: string, demoId: string) {
  const s = state.series[seriesKey(personId, demoId)];
  const current = s ? state.attempts[s.currentAttemptId] : null;
  if (s && (!current || current.personId !== personId || current.generation !== s.generation)) {
    fail("RESPONSE_INVARIANT_FAILED", 500);
  }
  return { series_id: s?.id ?? null, demo_id: demoId,
    current_attempt_id: current?.id ?? null, generation: s?.generation ?? 0,
    state_revision: current?.seriesStateRevision ?? 0, current_status: current?.status ?? null,
    recovery_state: s?.recoveryState ?? "none",
    recovery: s?.recovery ? { opens_at: utc(s.recovery.opensAt),
      closes_at: utc(s.recovery.closesAt), duration_seconds: s.recovery.durationMs / 1000 } : null,
    official_result_attempt_id: s?.officialAttemptId ?? null,
    normal_attempt_used: s?.normalAttemptUsed ?? false };
}

export function answerWire(answer: AnswerAck) {
  return { question_id: answer.questionId, selected_option_id: answer.selectedOptionId,
    revision: answer.revision, saved_at: utc(answer.savedAt),
    series_state_revision: answer.seriesStateRevision };
}
export function attemptWire(state: StudentState, record: AttemptRecord, now: number) {
  const assignment = state.assignments[record.assignmentId];
  if (!assignment || assignment.published.versionId !== record.published.versionId) {
    fail("RESPONSE_INVARIANT_FAILED", 500);
  }
  return {
    id: record.id, demo_id: record.published.demoId, assignment_id: record.assignmentId,
    generation: record.generation, status: record.status, state_revision: record.stateRevision,
    started_at: utc(record.startedAt), deadline_at: utc(record.deadlineAt),
    completed_at: record.completedAt === null ? null : utc(record.completedAt),
    cancelled_at: record.status === "cancelled" ? utc(state.cancellations[record.id].cancelledAt) : null,
    completion_reason: { in_progress: null, submitted: "submitted", expired: "deadline_expired",
      forced: "admin_forced", cancelled: "technical_failure" }[record.status],
    server_now: utc(now), series: seriesWire(state, record.personId, record.published.demoId),
    questions: record.status !== "in_progress" ? [] : record.questionOrder.map((q, index) => {
      const content = assignment.contents[q.questionId];
      if (!content) fail("RESPONSE_INVARIANT_FAILED", 500);
      return { id: q.questionId, display_position: index + 1, prompt_blocks: blocksWire(content.prompt),
        options: q.optionIds.map((id, position) => {
          if (!content.options[id]) fail("RESPONSE_INVARIANT_FAILED", 500);
          return { id, display_position: position + 1, blocks: blocksWire(content.options[id]) };
        }) };
    }),
    answers: record.status === "in_progress" ? record.answers.map(answerWire) : [],
  };
}
function reviewWire(gate: Record<string, unknown>, now: number) {
  // Only the public ReviewGate fields; loader must derive the actual group-wide barrier.
  return { id: gate.id, status: gate.status, revision: gate.revision,
    barrier_revision: gate.barrier_revision, barrier_complete: gate.barrier_complete,
    eligible_unresolved_count: gate.eligible_unresolved_count, active_count: gate.active_count,
    recovery_ready_count: gate.recovery_ready_count, timezone: gate.timezone,
    first_opened_at: gate.first_opened_at, opens_at: gate.opens_at, closes_at: gate.closes_at,
    server_now: utc(now) };
}
export function metaWire(state: StudentState, personId: string, assignment: AssignmentRecord, now: number) {
  const { admission: a, published: p } = assignment;
  return { demo_id: p.demoId, version_id: p.versionId, assignment_id: a.assignmentId,
    title: assignment.title, instructions_blocks: blocksWire(assignment.instructions),
    question_count: p.questions.length, duration_seconds: p.durationMs / 1000,
    opens_at: utc(a.opensAt), closes_at: utc(a.closesAt),
    admission_status: assignment.cancelled ? "cancelled" : now < a.opensAt ? "scheduled"
      : now >= a.closesAt ? "closed" : "open",
    server_now: utc(now), series: seriesWire(state, personId, p.demoId),
    review_gate: reviewWire(assignment.reviewGate, now) };
}
export function historyWire(state: StudentState, personId: string, assignment: AssignmentRecord,
  policy: NumericPresentation | undefined) {
  return { series: seriesWire(state, personId, assignment.published.demoId),
    attempts: Object.values(state.attempts)
      .filter((a) => a.personId === personId && a.assignmentId === assignment.admission.assignmentId)
      .sort((a, b) => a.generation - b.generation)
      .map((a) => ({ lifecycle_status: a.status,
        score: a.ordinary ? scoreWire(state, a, policy) : null,
        started_at: utc(a.startedAt), deadline_at: utc(a.deadlineAt),
        completed_at: a.completedAt === null ? null : utc(a.completedAt),
        cancellation: a.status === "cancelled" ? {
          cancelled_at: utc(state.cancellations[a.id].cancelledAt),
          prior_status: state.cancellations[a.id].priorStatus, reason_code: "technical_failure",
        } : null })) };
}

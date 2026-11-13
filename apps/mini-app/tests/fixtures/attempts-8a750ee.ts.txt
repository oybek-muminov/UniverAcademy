import { ApiFault, fail } from "./fault.ts";
import { ordinaryScore, validatePublishedTest } from "./ordinary.ts";
import type { ExactOrdinary, PublishedTest } from "./ordinary.ts";

// All inputs below come from locked server state, NEVER from client identity/role claims.
// These are pure transitions, not a database, session verifier or HTTP implementation.
export type StudentAccess = Readonly<{
  proofKind: "student_session";
  personId: string;
  enabled: boolean;
  assignmentIds: readonly string[];
}>;
export type Admission = Readonly<{
  assignmentId: string;
  groupId: string;
  activeGroupId: string | null;
  rostered: boolean;
  profileComplete: boolean;
  membershipEpoch: number;
  grantEpoch: number;
  // Already resolved by the server, including protected Asia/Tashkent late-entry rights.
  opensAt: number;
  closesAt: number;
}>;
export type AnswerAck = Readonly<{
  questionId: string;
  selectedOptionId: string | null;
  revision: number;
  savedAt: number;
  seriesStateRevision: number;
}>;
export type AttemptRecord = Readonly<{
  id: string;
  personId: string;
  assignmentId: string;
  groupId: string;
  generation: number;
  status: "in_progress" | "submitted" | "expired" | "forced" | "cancelled";
  startedAt: number;
  deadlineAt: number;
  completedAt: number | null;
  stateRevision: number;
  seriesStateRevision: number;
  published: PublishedTest;
  questionOrder: readonly Readonly<{ questionId: string; optionIds: readonly string[] }>[];
  answers: readonly AnswerAck[];
  ordinary: ExactOrdinary | null;
}>;
export type CurrentAttempt = Readonly<{ id: string; generation: number }>;
export type Transition<T> = Readonly<{
  record: AttemptRecord;
  response: { ok: true; value: T } | { ok: false; error: ApiFault };
}>;

function authorize(access: StudentAccess, assignmentId: string, personId = access.personId): void {
  if (access.proofKind !== "student_session") fail("FORBIDDEN", 403);
  if (!access.enabled) fail("ACCOUNT_DISABLED", 403);
  if (access.personId !== personId || !access.assignmentIds.includes(assignmentId)) {
    fail("NOT_FOUND", 404);
  }
}

function checkCurrent(access: StudentAccess, record: AttemptRecord, current: CurrentAttempt): void {
  authorize(access, record.assignmentId, record.personId);
  if (record.id !== current.id || record.generation !== current.generation ||
    record.status === "cancelled") fail("ATTEMPT_SUPERSEDED", 409);
}

function checkClock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) {
    fail("SERVICE_UNAVAILABLE", 503);
  }
}

function shuffled<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const bound = i + 1;
    const limit = Math.floor(0x100000000 / bound) * bound;
    let sample: number;
    do { sample = crypto.getRandomValues(new Uint32Array(1))[0]; } while (sample >= limit);
    const j = sample % bound;
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function complete(record: AttemptRecord, now: number, status: "submitted" | "expired"): AttemptRecord {
  return {
    ...record,
    status,
    completedAt: status === "expired" ? record.deadlineAt : now,
    stateRevision: record.stateRevision + 1,
    seriesStateRevision: record.seriesStateRevision + 1,
    ordinary: ordinaryScore(record.published,
      new Map(record.answers.map((answer) => [answer.questionId, answer.selectedOptionId])), now),
  };
}

function expire(record: AttemptRecord, now: number): AttemptRecord {
  checkClock(now);
  return record.status === "in_progress" && now >= record.deadlineAt
    ? complete(record, now, "expired") : record;
}

// Internal maintenance transition. HTTP callers still require current staff auth,
// target visibility and transaction locks before loading/passing this record.
export function expireForMembershipGuard(record: AttemptRecord, now: number): AttemptRecord {
  return expire(record, now);
}

// Caller must lock person+stable demo and load existing across groups/versions/assignments.
// A DB unique constraint, idempotency receipt and durable transaction are still required.
export function startAttempt(input: {
  access: StudentAccess;
  admission: Admission;
  published: PublishedTest;
  existing: AttemptRecord | null;
  id: string;
  confirmed: true;
  now: number;
}): AttemptRecord {
  const { access, admission, published, existing, id, now } = input;
  authorize(access, admission.assignmentId);
  checkClock(now);
  if (input.confirmed !== true) fail("VALIDATION_ERROR", 422);
  if (!admission.profileComplete) fail("PROFILE_INCOMPLETE", 409);
  if (!admission.rostered || admission.activeGroupId !== admission.groupId ||
    admission.membershipEpoch !== admission.grantEpoch) fail("EXAM_ACCESS_REVOKED", 403);
  if (existing) {
    if (existing.personId !== access.personId || existing.published.demoId !== published.demoId) {
      fail("RESPONSE_INVARIANT_FAILED", 500);
    }
    if (existing.assignmentId === admission.assignmentId && existing.status === "in_progress") {
      return expire(existing, now);
    }
    fail("NORMAL_ATTEMPT_USED", 409);
  }
  if (!Number.isSafeInteger(admission.opensAt) || !Number.isSafeInteger(admission.closesAt) ||
    admission.opensAt >= admission.closesAt) fail("INVALID_TIME_WINDOW", 422);
  if (now < admission.opensAt || now >= admission.closesAt) fail("ADMISSION_CLOSED", 409);
  validatePublishedTest(published);
  checkClock(now + published.durationMs);
  const pinned = structuredClone(published);
  return {
    id, personId: access.personId, assignmentId: admission.assignmentId,
    groupId: admission.groupId, generation: 1, status: "in_progress",
    startedAt: now, deadlineAt: now + pinned.durationMs, completedAt: null,
    stateRevision: 1, seriesStateRevision: 1, published: pinned,
    questionOrder: shuffled(pinned.questions).map((question) => ({
      questionId: question.id, optionIds: shuffled(question.optionIds),
    })),
    answers: [], ordinary: null,
  };
}

// Internal safe projection; a later HTTP mapper supplies validated content + full API Series.
export function studentView(access: StudentAccess, record: AttemptRecord,
  current: CurrentAttempt, now: number) {
  checkCurrent(access, record, current);
  const next = expire(record, now);
  return {
    record: next,
    response: {
      ok: true as const,
      value: {
        attemptId: next.id, generation: next.generation, status: next.status,
        startedAt: next.startedAt, deadlineAt: next.deadlineAt,
        completedAt: next.completedAt, serverNow: now,
        questionOrder: next.status === "in_progress" ? structuredClone(next.questionOrder) : [],
        answers: next.status === "in_progress" ? structuredClone(next.answers) : [],
      },
    },
  };
}

export function saveAnswer(access: StudentAccess, record: AttemptRecord,
  current: CurrentAttempt, questionId: string,
  input: { selected_option_id: string | null; expected_revision: number },
  now: number): Transition<AnswerAck> {
  checkCurrent(access, record, current);
  const next = expire(record, now);
  // Commit this expired state and ordinary result BEFORE sending 409. Do not roll it back
  // by throwing inside a future transaction adapter.
  if (next.status === "expired") {
    return { record: next, response: { ok: false, error: new ApiFault("ATTEMPT_EXPIRED", 409) } };
  }
  if (next.status !== "in_progress") fail("ATTEMPT_TERMINAL", 409);
  if (!input || Object.keys(input).some((key) =>
    key !== "selected_option_id" && key !== "expected_revision") ||
    !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0 ||
    (input.selected_option_id !== null && typeof input.selected_option_id !== "string")) {
    fail("VALIDATION_ERROR", 422);
  }
  const question = next.published.questions.find((item) => item.id === questionId);
  if (!question) fail("NOT_FOUND", 404);
  if (input.selected_option_id !== null && !question.optionIds.includes(input.selected_option_id)) {
    fail("INVALID_OPTION", 422);
  }
  const previous = next.answers.find((answer) => answer.questionId === questionId);
  if (input.expected_revision !== (previous?.revision ?? 0)) fail("REVISION_CONFLICT", 409);
  const answer: AnswerAck = {
    questionId, selectedOptionId: input.selected_option_id,
    revision: input.expected_revision + 1, savedAt: now,
    seriesStateRevision: next.seriesStateRevision + 1,
  };
  return {
    record: {
      ...next, stateRevision: next.stateRevision + 1,
      seriesStateRevision: answer.seriesStateRevision,
      answers: [...next.answers.filter((item) => item.questionId !== questionId), answer],
    },
    response: { ok: true, value: structuredClone(answer) },
  };
}

export function submitAttempt(access: StudentAccess, record: AttemptRecord,
  current: CurrentAttempt, now: number): Transition<ExactOrdinary> {
  checkCurrent(access, record, current);
  const materialized = expire(record, now);
  const next = materialized.status === "in_progress"
    ? complete(materialized, now, "submitted") : materialized;
  if (!next.ordinary) fail("RESPONSE_INVARIANT_FAILED", 500);
  return { record: next, response: { ok: true, value: structuredClone(next.ordinary) } };
}

export function result(access: StudentAccess, record: AttemptRecord,
  current: CurrentAttempt, now: number): Transition<ExactOrdinary> {
  checkCurrent(access, record, current);
  const next = expire(record, now);
  if (!next.ordinary) fail("ATTEMPT_NOT_COMPLETED", 409);
  return { record: next, response: { ok: true, value: structuredClone(next.ordinary) } };
}

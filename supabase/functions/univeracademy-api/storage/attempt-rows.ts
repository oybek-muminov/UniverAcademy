import { fail } from "../fault.ts";
import { validatePublishedTest } from "../ordinary.ts";
import type { AttemptRecord, AnswerAck } from "../attempts.ts";
import type { ExactOrdinary, PublishedTest, Ratio } from "../ordinary.ts";
import { integer, own, query } from "./postgres-transaction.ts";
import type { LockedTransaction } from "./postgres-transaction.ts";

type StoredTest = Omit<PublishedTest, "questions"> & { questions: {
  id: string; optionIds: string[]; correctOptionId: string;
  individualPoints: { numerator: string; denominator: string } | null;
}[] };
const exact = (r: Ratio) => ({ numerator: r.numerator.toString(), denominator: r.denominator.toString() });
export function decodeRatio(value: { numerator: string; denominator: string }): Ratio {
  if (!/^(0|[1-9][0-9]*)$/.test(value.numerator) || !/^[1-9][0-9]*$/.test(value.denominator))
    fail("RESPONSE_INVARIANT_FAILED", 500);
  return { numerator: BigInt(value.numerator), denominator: BigInt(value.denominator) };
}
export function encodePublished(test: PublishedTest): StoredTest {
  return { ...test, questions: test.questions.map((q) => ({ ...q, optionIds: [...q.optionIds],
    individualPoints: q.individualPoints ? exact(q.individualPoints) : null })) };
}
export function decodePublished(stored: StoredTest): PublishedTest {
  const test: PublishedTest = { ...stored, questions: stored.questions.map((q) => ({ ...q,
    individualPoints: q.individualPoints ? decodeRatio(q.individualPoints) : null })) };
  validatePublishedTest(test);
  return test;
}
export function encodeOrdinary(o: ExactOrdinary) {
  return { earned: exact(o.earned), maximum: exact(o.maximum), percentage: exact(o.percentage), calculatedAt: o.calculatedAt };
}
function recordNumbers(record: Omit<AttemptRecord, "published" | "questionOrder" | "answers" | "ordinary">): void {
  const values = [record.generation, record.stateRevision, record.seriesStateRevision, record.startedAt, record.deadlineAt];
  if (values.some((n) => !Number.isSafeInteger(n) || n < 0) || record.generation < 1 ||
      record.deadlineAt <= record.startedAt || record.deadlineAt > 8_640_000_000_000_000 ||
      (record.completedAt !== null && (!Number.isSafeInteger(record.completedAt) || record.completedAt < record.startedAt)))
    fail("RESPONSE_INVARIANT_FAILED", 500);
}
export class AttemptRows {
  async insert(tx: LockedTransaction, record: AttemptRecord): Promise<void> {
    own(tx, record.personId); recordNumbers(record); validatePublishedTest(record.published);
    if (record.status !== "in_progress" || record.answers.length || record.ordinary || record.generation !== 1)
      fail("RESPONSE_INVARIANT_FAILED", 500);
    const { published, questionOrder, answers: _, ordinary: __, ...body } = record;
    const r = await query(tx, "ua_attempt_insert", "INSERT INTO ua_private.attempts(id,person_id,assignment_id,demo_id,generation,state_revision,body,frozen_test,question_order) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb) ON CONFLICT(id) DO NOTHING RETURNING id",
      [record.id, record.personId, record.assignmentId, published.demoId, record.generation, record.stateRevision,
        JSON.stringify(body), JSON.stringify(encodePublished(published)), JSON.stringify(questionOrder)]);
    if (r.rowCount !== 1) fail("RESPONSE_INVARIANT_FAILED", 500);
  }
  async load(tx: LockedTransaction, personId: string, attemptId: string): Promise<AttemptRecord> {
    own(tx, personId);
    const data = await query(tx, "ua_attempt_load", "SELECT body, frozen_test, question_order FROM ua_private.attempts WHERE id=$1 AND person_id=$2 FOR UPDATE", [attemptId, personId]);
    if (data.rows.length !== 1) fail("NOT_FOUND", 404);
    const row = data.rows[0], body = row.body as Omit<AttemptRecord, "published" | "questionOrder" | "answers" | "ordinary">;
    if (body.id !== attemptId || body.personId !== personId) fail("RESPONSE_INVARIANT_FAILED", 500);
    recordNumbers(body);
    const stored = row.frozen_test as StoredTest;
    const published = decodePublished(stored);
    const answers = await query(tx, "ua_answers_load", "SELECT question_id, selected_option_id, revision::text, saved_at_ms::text, series_state_revision::text FROM ua_private.answers WHERE attempt_id=$1 ORDER BY question_id", [attemptId]);
    const mapped: AnswerAck[] = answers.rows.map((a) => ({ questionId: a.question_id as string,
      selectedOptionId: a.selected_option_id as string | null, revision: integer(a.revision), savedAt: integer(a.saved_at_ms),
      seriesStateRevision: integer(a.series_state_revision) }));
    const result = await query(tx, "ua_ordinary_load", "SELECT exact_result FROM ua_private.ordinary_results WHERE attempt_id=$1", [attemptId]);
    const raw = result.rows[0]?.exact_result as ReturnType<typeof encodeOrdinary> | undefined;
    const ordinary = raw ? { earned: decodeRatio(raw.earned), maximum: decodeRatio(raw.maximum),
      percentage: decodeRatio(raw.percentage), calculatedAt: raw.calculatedAt } : null;
    return { ...body, published, questionOrder: row.question_order as AttemptRecord["questionOrder"], answers: mapped, ordinary };
  }
  async persist(tx: LockedTransaction, before: AttemptRecord, next: AttemptRecord): Promise<void> {
    own(tx, before.personId);
    recordNumbers(before); recordNumbers(next);
    if (next.answers.some((a) => [a.revision,a.savedAt,a.seriesStateRevision].some((n) => !Number.isSafeInteger(n) || n < 0) || a.revision < 1))
      fail("RESPONSE_INVARIANT_FAILED", 500);
    const pin = (a: AttemptRecord) => JSON.stringify({ id: a.id, personId: a.personId, assignmentId: a.assignmentId,
      groupId: a.groupId, generation: a.generation, startedAt: a.startedAt, deadlineAt: a.deadlineAt,
      published: encodePublished(a.published), questionOrder: a.questionOrder });
    if (pin(before) !== pin(next)) fail("RESPONSE_INVARIANT_FAILED", 500);
    if (before.ordinary && JSON.stringify(encodeOrdinary(before.ordinary)) !==
        (next.ordinary ? JSON.stringify(encodeOrdinary(next.ordinary)) : null)) fail("RESPONSE_INVARIANT_FAILED", 500);
    if (next.stateRevision === before.stateRevision) return; // Idempotent terminal projection.
    if (next.stateRevision !== before.stateRevision + 1 || next.seriesStateRevision !== before.seriesStateRevision + 1)
      fail("RESPONSE_INVARIANT_FAILED", 500);
    const { answers: _, ordinary: __, published: ___, questionOrder: ____, ...body } = next;
    const update = await query(tx, "ua_attempt_update", "UPDATE ua_private.attempts SET body=$1::jsonb, state_revision=$2 WHERE id=$3 AND person_id=$4 AND generation=$5 AND state_revision=$6 RETURNING id", [JSON.stringify(body), next.stateRevision, next.id, next.personId, next.generation, before.stateRevision]);
    if (update.rowCount !== 1) fail("STATE_REVISION_CONFLICT", 409);
    for (const answer of next.answers) {
      const old = before.answers.find((a) => a.questionId === answer.questionId);
      if (JSON.stringify(old) === JSON.stringify(answer)) continue;
      if (answer.revision !== (old?.revision ?? 0) + 1) fail("RESPONSE_INVARIANT_FAILED", 500);
      const saved = await query(tx, "ua_answer_cas", `INSERT INTO ua_private.answers(attempt_id,question_id,selected_option_id,revision,saved_at_ms,series_state_revision)
VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(attempt_id,question_id) DO UPDATE SET selected_option_id=EXCLUDED.selected_option_id,revision=EXCLUDED.revision,saved_at_ms=EXCLUDED.saved_at_ms,series_state_revision=EXCLUDED.series_state_revision
WHERE ua_private.answers.revision=$7 RETURNING question_id`, [next.id, answer.questionId, answer.selectedOptionId,
        answer.revision, answer.savedAt, answer.seriesStateRevision, old?.revision ?? 0]);
      if (saved.rowCount !== 1) fail("REVISION_CONFLICT", 409);
    }
    if (before.answers.some((a) => !next.answers.some((b) => b.questionId === a.questionId))) fail("RESPONSE_INVARIANT_FAILED", 500);
    if (next.ordinary) {
      const saved = await query(tx, "ua_ordinary_insert", "INSERT INTO ua_private.ordinary_results(attempt_id,exact_result) VALUES($1,$2::jsonb) ON CONFLICT(attempt_id) DO NOTHING RETURNING attempt_id", [next.id, JSON.stringify(encodeOrdinary(next.ordinary))]);
      if (saved.rowCount !== 1) fail("RESPONSE_INVARIANT_FAILED", 500);
    }
    const series = await query(tx, "ua_series_update", "UPDATE ua_private.exam_series SET state_revision=$1,official_attempt_id=CASE WHEN $2 THEN $3 ELSE official_attempt_id END WHERE person_id=$4 AND demo_id=$5 AND current_attempt_id=$3 AND generation=$6 RETURNING current_attempt_id", [next.seriesStateRevision, !!next.ordinary, next.id, next.personId, next.published.demoId, next.generation]);
    if (series.rowCount !== 1) fail("ATTEMPT_SUPERSEDED", 409);
  }
}

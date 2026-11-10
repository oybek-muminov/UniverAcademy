import { fail } from "./fault.ts";
import { parseIndividualQuestionPoints } from "./individual-points.ts";
import { ratio, validatePublishedTest } from "./ordinary.ts";
import { nextRevision } from "./staff-state.ts";
import type { PublishedTest } from "./ordinary.ts";
import type { AuthoredQuestion, DraftRecord, Publish, QuestionWrite, StaffState, Version } from "./staff-state.ts";

function replay(state: StaffState, record: DraftRecord, key: string, payload: string): Version | null {
  const prior = state.receipts[key];
  if (!prior) return null;
  if (prior.payload !== payload) fail("IDEMPOTENCY_CONFLICT", 409);
  if (prior.versionId !== record.wire.id) fail("RESPONSE_INVARIANT_FAILED", 500);
  return structuredClone(record.wire); // Current projection; never reapply a draft edit after publish.
}
function editable(record: DraftRecord, expected: number): void {
  if (!Number.isSafeInteger(expected)) fail("SERVICE_UNAVAILABLE", 503);
  if (record.wire.revision !== expected) fail("RESOURCE_REVISION_CONFLICT", 409);
  if (record.wire.status !== "draft" || record.publishedSnapshot) fail("VERSION_FROZEN", 409);
}
function contentChecks(q: AuthoredQuestion): void {
  if (!Number.isSafeInteger(q.position)) fail("SERVICE_UNAVAILABLE", 503);
  const options = q.options.map((o) => o.id);
  if (options.length !== 4 || new Set(options).size !== 4 || !options.includes(q.correct_option_id))
    fail("INVALID_OPTION", 422);
  if ([...q.prompt_blocks, ...q.explanation_blocks, ...q.options.flatMap((o) => o.blocks)]
      .some((block) => block.type === "image")) fail("SERVICE_UNAVAILABLE", 503);
  // No media validator/store is connected in this local candidate. No asset is silently trusted.
  if (q.individual_points != null) parseIndividualQuestionPoints(q.individual_points);
}

// Caller already holds current staff/content authorization and the version transaction lock.
export function writeDraftQuestion(state: StaffState, record: DraftRecord, body: QuestionWrite,
  key: string, payload: string, actorId: string, now: number): Version {
  const prior = replay(state, record, key, payload);
  if (prior) return prior;
  editable(record, body.expected_revision);
  contentChecks(body);
  if (Object.values(record.questions ?? {}).some((q) => q.id !== body.id && q.position === body.position))
    fail("VALIDATION_ERROR", 422);
  const { expected_revision: _, ...question } = body;
  (record.questions ??= {})[body.id] = structuredClone(question);
  if (!record.questionIds.includes(body.id)) record.questionIds.push(body.id);
  record.wire.revision = nextRevision(record.wire.revision);
  state.receipts[key] = { payload, versionId: record.wire.id };
  state.audit.push({ actorId, action: "draft_question", targetId: body.id, revision: record.wire.revision, at: now });
  return structuredClone(record.wire);
}

export function publishDraft(state: StaffState, record: DraftRecord, body: Publish, key: string,
  payload: string, actorId: string, now: number, validate: (schema: string, value: unknown) => boolean): Version {
  const prior = replay(state, record, key, payload);
  if (prior) return prior;
  editable(record, body.expected_revision);
  if (!validate("Version", record.wire) || record.questionIds.length === 0 ||
      new Set(record.questionIds).size !== record.questionIds.length) fail("INVALID_GRADING_CONFIG", 422);
  const questions = record.questionIds.map((id) => {
    const q = record.questions?.[id];
    if (!q || q.id !== id || !validate("QuestionWrite", { ...q, expected_revision: body.expected_revision }))
      fail("INVALID_GRADING_CONFIG", 422);
    contentChecks(q);
    return q;
  }).sort((a, b) => a.position - b.position);
  if (new Set(questions.map((q) => q.position)).size !== questions.length) fail("VALIDATION_ERROR", 422);
  if (record.wire.instructions_blocks.some((b) => b.type === "image")) fail("SERVICE_UNAVAILABLE", 503);
  const durationMs = record.wire.duration_seconds * 1000;
  if (!Number.isSafeInteger(durationMs)) fail("SERVICE_UNAVAILABLE", 503);
  const individualEnabled = record.wire.grading_config.individual_enabled;
  const test: PublishedTest = { demoId: record.wire.demo_id, versionId: record.wire.id, durationMs, individualEnabled,
    questions: questions.map((q) => {
      if (individualEnabled && q.individual_points == null) fail("INVALID_GRADING_CONFIG", 422);
      return { id: q.id, optionIds: q.options.map((o) => o.id), correctOptionId: q.correct_option_id,
        individualPoints: individualEnabled ? parseIndividualQuestionPoints(q.individual_points) : ratio(1n) };
    }) };
  validatePublishedTest(test);
  record.publishedSnapshot = structuredClone({ test, instructions: record.wire.instructions_blocks, questions });
  record.wire = { ...record.wire, status: "published", revision: nextRevision(record.wire.revision) };
  state.receipts[key] = { payload, versionId: record.wire.id };
  state.audit.push({ actorId, action: "version_publish", targetId: record.wire.id, revision: record.wire.revision, at: now });
  return structuredClone(record.wire); // Only the closed Version DTO crosses HTTP; no keys or Ratio/BigInt.
}

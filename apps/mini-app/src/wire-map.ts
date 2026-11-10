import { lifecycleLabel } from './flow.ts';
import type { Attempt, DisplayBlock, Exam, HistoryEntry, Lifecycle, Question, Result, SavedAnswer, SeriesView, Student } from './flow.ts';
import { StudentFailure } from './transport.ts';
import { display2, studentPointsDisplay, historySummary } from './display.ts';

// Pure UI projection of the pinned draft. No HTTP calls/routes, generated client,
// wire DTO declarations, session/bootstrap or Backend implementation imports.
type Context = { assignmentId: string; title: string };
type Policy = { assetUrl(value: string): string };
function bad(): never { throw new StudentFailure('protocol', 'RESPONSE_INVARIANT_FAILED'); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : bad(); }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : bad(); }
function text(value: unknown): string { return typeof value === 'string' ? value : bad(); }
function bool(value: unknown): boolean { return typeof value === 'boolean' ? value : bad(); }
function number(value: unknown, minimum = 0): number { return typeof value === 'number' && Number.isFinite(value) && value >= minimum ? value : bad(); }
function integer(value: unknown, minimum = 0): number { const n = number(value, minimum); return Number.isSafeInteger(n) ? n : bad(); }
function id(value: unknown): string { const s = text(value); return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(s) ? s : bad(); }
function nullableId(value: unknown): string | null { return value === null ? null : id(value); }
function time(value: unknown): string { const s = text(value); return s.endsWith('Z') && Number.isFinite(Date.parse(s)) ? s : bad(); }
function status(value: unknown): Lifecycle { const s = text(value); return Object.hasOwn(lifecycleLabel, s) ? s as Lifecycle : bad(); }
function series(value: unknown): SeriesView {
  const v = object(value); const recovery = text(v.recovery_state);
  if (!['none', 'ready', 'active', 'lapsed'].includes(recovery)) bad();
  return { currentAttemptId: nullableId(v.current_attempt_id), generation: integer(v.generation),
    officialResultAttemptId: nullableId(v.official_result_attempt_id), recovery: recovery as SeriesView['recovery'] };
}
function ordered(value: unknown): Record<string, unknown>[] {
  const rows = array(value).map(object).sort((a, b) => integer(a.display_position, 1) - integer(b.display_position, 1));
  if (rows.some((row, i) => integer(row.display_position, 1) !== i + 1)) bad();
  return rows;
}

export function createWireMap(policy: Policy) {
  function blocks(value: unknown): DisplayBlock[] {
    const rows = array(value);
    if (!rows.length) bad();
    return rows.map(raw => {
      const v = object(raw);
      if (v.type === 'text') return { kind: 'text', text: text(v.markdown) };
      if (v.type === 'formula') {
        if (v.display !== 'inline' && v.display !== 'block') bad();
        return { kind: 'formula', latex: text(v.latex), display: v.display };
      }
      if (v.type === 'image') {
        const asset = object(v.asset);
        return { kind: 'image', assetId: id(asset.asset_id), url: policy.assetUrl(text(asset.url)), expiresAt: time(asset.expires_at),
          contentType: text(asset.content_type), alt: text(v.alt), caption: v.caption === undefined ? null : text(v.caption) };
      }
      return bad();
    });
  }
  function plain(content: DisplayBlock[]) {
    return content.map(b => b.kind === 'text' ? b.text : b.kind === 'formula' ? b.latex : [b.alt, b.caption].filter(Boolean).join(' — ')).join('\n');
  }
  function profile(value: unknown): Student {
    const v = object(value);
    const displayId = v.qadam_id === null ? '—' : text(v.qadam_id);
    if (v.qadam_id !== null && !/^\d{10}$/.test(displayId)) bad();
    return { person: id(v.person_id), firstName: text(v.first_name), lastName: text(v.last_name),
      registrationComplete: bool(v.registration_complete), displayId };
  }
  function exam(value: unknown, context: Context & { startAllowed: boolean; groupLabel: string }): Exam {
    const v = object(value);
    if (id(v.assignment_id) !== context.assignmentId) bad();
    const content = blocks(v.instructions_blocks); const seconds = integer(v.duration_seconds, 1);
    return { id: context.assignmentId, title: text(v.title), group: context.groupLabel, count: integer(v.question_count, 1),
      durationLabel: seconds % 60 === 0 ? `${seconds / 60} daqiqa` : `${seconds} soniya`,
      startNotice: plain(content), instructionsContent: content, canStart: bool(context.startAllowed), series: series(v.series) };
  }
  function question(value: Record<string, unknown>): Question {
    const content = blocks(value.prompt_blocks); const options = ordered(value.options);
    if (options.length !== 4 || new Set(options.map(o => id(o.id))).size !== options.length) bad();
    return { id: id(value.id), prompt: plain(content), content,
      options: options.map(v => { const content = blocks(v.blocks); return { id: id(v.id), text: plain(content), content }; }) };
  }
  function answer(value: unknown, expectedQuestion: string): SavedAnswer {
    const v = object(value);
    if (id(v.question_id) !== expectedQuestion) bad();
    time(v.saved_at); integer(v.series_state_revision);
    return { optionId: nullableId(v.selected_option_id), revision: integer(v.revision, 1) };
  }
  function attempt(value: unknown, context: Context & { attemptId: string }): Attempt {
    const v = object(value); const lifecycle = status(v.status);
    if (id(v.assignment_id) !== context.assignmentId || id(v.id) !== context.attemptId) bad();
    const active = lifecycle === 'in_progress';
    const current = series(v.series);
    if (active && (current.currentAttemptId !== context.attemptId || current.generation !== integer(v.generation, 1))) bad();
    if (!active && (array(v.questions).length || array(v.answers).length)) bad();
    const questions = active ? ordered(v.questions).map(question) : [];
    if (active && (!questions.length || new Set(questions.map(q => q.id)).size !== questions.length)) bad();
    const answers: Record<string, SavedAnswer> = {};
    for (const raw of array(v.answers)) {
      const item = object(raw); const questionId = id(item.question_id); const q = questions.find(q => q.id === questionId);
      const saved = answer(item, questionId);
      if (!q || Object.hasOwn(answers, questionId) || (saved.optionId !== null && !q.options.some(o => o.id === saved.optionId))) bad();
      answers[questionId] = saved;
    }
    return { id: context.attemptId, assignmentId: context.assignmentId, generation: integer(v.generation, 1),
      status: lifecycle, active, statusLabel: lifecycleLabel[lifecycle], serverTime: time(v.server_now),
      deadline: v.deadline_at === null ? (active ? bad() : null) : time(v.deadline_at), questions, answers, series: current };
  }
  function result(value: unknown, expectedAttempt: string): Result | null {
    const v = object(value);
    if (id(v.attempt_id) !== expectedAttempt) bad();
    if (v.ordinary === null) return null;
    const ordinary = object(v.ordinary);
    number(ordinary.earned_points); const maximum = number(ordinary.max_points), percentage = number(ordinary.percentage);
    if (maximum <= 0 || percentage > 100) bad();
    time(ordinary.calculated_at);
    const display = object(ordinary.display);
    let bonus: string | null = null;
    if (v.statistical_bonus !== null) {
      const b = object(v.statistical_bonus); id(b.calculation_id); time(b.calculated_at);
      number(b.earned_points);
      bonus = studentPointsDisplay(object(b.display).earned_points);
    }
    return { earned: studentPointsDisplay(display.earned_points), maximum: studentPointsDisplay(display.max_points), percentage: display2(display.percentage),
      bonus, reviewMessage: 'Batafsil tahlil alohida ruxsat bilan ochiladi.', note: '' };
  }
  function history(value: unknown, context: Context): HistoryEntry[] {
    id(context.assignmentId); const v = object(value); const current = series(v.series);
    return array(v.attempts).map(raw => {
      const entry = object(raw); const lifecycle = status(entry.lifecycle_status);
      const score = entry.score === null ? null : object(entry.score);
      const attemptId = score === null ? null : id(score.attempt_id);
      const mapped = score === null ? null : result(score, attemptId!);
      if (['submitted', 'expired', 'forced'].includes(lifecycle) && mapped === null) bad();
      const official = mapped !== null && ['submitted', 'expired', 'forced'].includes(lifecycle) && attemptId !== null && attemptId === current.officialResultAttemptId;
      if (lifecycle === 'cancelled') {
        const cancelled = object(entry.cancellation); time(cancelled.cancelled_at); status(cancelled.prior_status);
        if (cancelled.reason_code !== 'technical_failure') bad();
      } else if (entry.cancellation !== null) bad();
      return { title: context.title, status: lifecycleLabel[lifecycle], attemptId, official, result: mapped,
        summary: historySummary(mapped, official, '.') };
    });
  }
  return { profile, exam, attempt, answer, result, history, blocks };
}

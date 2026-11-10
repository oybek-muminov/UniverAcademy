import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWireMap } from '../src/wire-map.ts';
import { lifecycleLabel } from '../src/flow.ts';
import { display2, studentPointsDisplay, historySummary } from '../src/display.ts';

const packet = JSON.parse(readFileSync(new URL('./fixtures/wire.json', import.meta.url), 'utf8'));
const fixture = name => structuredClone(packet.cases[name].data);
const context = packet.context;
// Only the media policy is injected; server display strings are never re-rounded.
const mapper = createWireMap({ assetUrl: url => {
  assert.equal(new URL(url).origin, 'https://media.invalid'); return url;
} });
const protocol = error => error.kind === 'protocol' && error.code === 'RESPONSE_INVARIANT_FAILED';

test('profile preserves authoritative registration and leading-zero display ID; no session/staff fields escape', () => {
  const source = fixture('profileIncomplete');
  source.access_token = 'explicit synthetic extra value';
  source.staff_note = 'explicit synthetic extra value';
  const projected = mapper.profile(source);
  assert.equal(projected.registrationComplete, false);
  assert.equal(projected.firstName, 'Namuna');
  assert.equal(projected.displayId, '0000000001');
  assert.deepEqual(Object.keys(projected).sort(), ['displayId', 'firstName', 'lastName', 'person', 'registrationComplete']);
  assert.equal(mapper.profile(fixture('profileRegistered')).registrationComplete, true);
});

test('metadata requires assignment/start permission context and never invents a group or admission rule', () => {
  const exam = mapper.exam(fixture('examOpen'), { ...context, groupLabel: 'Fixture guruhi', startAllowed: false });
  assert.equal(exam.id, context.assignmentId);
  assert.equal(exam.canStart, false);
  assert.equal(exam.group, 'Fixture guruhi');
  assert.equal(exam.durationLabel, '12 daqiqa');
  assert.equal(exam.series.currentAttemptId, null);
  assert.throws(() => mapper.exam(fixture('examOpen'), { ...context, assignmentId: context.successorId, groupLabel: '', startAllowed: false }), protocol);
});

test('question order follows frozen display positions and rich blocks remain structured and input remains unchanged', () => {
  const source = fixture('in_progress');
  source.questions[0].options.reverse();
  const before = structuredClone(source);
  const attempt = mapper.attempt(source, context);
  assert.deepEqual(source, before);
  assert.deepEqual(attempt.questions[0].options.map(o => o.text), ['Namuna A', 'Namuna B', 'Namuna C', 'Namuna D']);
  assert.deepEqual(attempt.questions[0].content.map(b => b.kind), ['text', 'formula', 'image']);
  assert.equal(attempt.questions[0].content[1].latex, 's = v t');
  assert.equal(attempt.questions[0].content[2].url, 'https://media.invalid/synthetic-diagram.png');
  assert.equal(attempt.questions[0].content[2].expiresAt, '2026-11-05T12:00:00Z');
  assert.deepEqual(attempt.answers[source.questions[0].id], { optionId: source.answers[0].selected_option_id, revision: 1 });
});

test('all seven lifecycle projections preserve server deadline/current generation without copying successor content', () => {
  for (const lifecycle of Object.keys(lifecycleLabel)) {
    const source = fixture(lifecycle); const attempt = mapper.attempt(source, { ...context, attemptId: source.id });
    assert.equal(attempt.status, lifecycle);
    assert.equal(attempt.statusLabel, lifecycleLabel[lifecycle]);
    assert.equal(attempt.active, lifecycle === 'in_progress');
    assert.equal(attempt.deadline, source.deadline_at);
    assert.equal(attempt.serverTime, source.server_now);
    if (lifecycle !== 'in_progress') { assert.deepEqual(attempt.questions, []); assert.deepEqual(attempt.answers, {}); }
  }
  const old = mapper.attempt(fixture('cancelledWithSuccessor'), context);
  assert.equal(old.id, context.attemptId);
  assert.equal(old.generation, 1);
  assert.equal(old.series.currentAttemptId, context.successorId);
  assert.equal(old.series.generation, 2);
  assert.deepEqual(old.answers, {});
  // The full started deadline extends beyond the fixture's admission close unchanged.
  assert.ok(Date.parse(mapper.attempt(fixture('in_progress'), context).deadline) > Date.parse(fixture('examOpen').closes_at));
});

test('ACK mapping preserves clear null and revision; wrong question or revision zero is not a successful save', () => {
  const saved = fixture('savedAnswer'); const clear = fixture('clearedAnswer');
  assert.deepEqual(mapper.answer(clear, clear.question_id), { optionId: null, revision: 2 });
  assert.equal(mapper.answer(saved, saved.question_id).revision, 1);
  assert.throws(() => mapper.answer(saved, context.successorId), protocol);
  saved.revision = 0;
  assert.throws(() => mapper.answer(saved, saved.question_id), protocol);
});

test('wrong scope, stale active generation, duplicate positions and invalid answer membership fail closed', () => {
  const wrong = fixture('in_progress'); wrong.assignment_id = context.successorId;
  assert.throws(() => mapper.attempt(wrong, context), protocol);
  const stale = fixture('in_progress'); stale.series.current_attempt_id = context.successorId; stale.series.generation = 2;
  assert.throws(() => mapper.attempt(stale, context), protocol);
  const duplicate = fixture('in_progress'); duplicate.questions[0].options[1].display_position = 1;
  assert.throws(() => mapper.attempt(duplicate, context), protocol);
  const answer = fixture('in_progress'); answer.answers[0].selected_option_id = context.successorId;
  assert.throws(() => mapper.attempt(answer, context), protocol);
  const unsafeId = fixture('in_progress'); unsafeId.questions[0].id = '__proto__';
  assert.throws(() => mapper.attempt(unsafeId, context), protocol);
});

test('terminal content and active content without a deadline cannot be rendered as a valid attempt', () => {
  const terminal = fixture('submitted'); terminal.questions = fixture('in_progress').questions;
  assert.throws(() => mapper.attempt(terminal, context), protocol);
  const active = fixture('in_progress'); active.deadline_at = null;
  assert.throws(() => mapper.attempt(active, context), protocol);
});

test('ordinary is independent of nullable bonus and canonical server display strings are preserved', () => {
  const pending = mapper.result(fixture('pendingResult'), context.attemptId);
  assert.equal(pending, null);
  const ordinary = mapper.result(fixture('ordinaryResult'), context.attemptId);
  const bonus = mapper.result(fixture('bonusResult'), context.attemptId);
  assert.equal(ordinary.bonus, null); assert.equal(bonus.bonus, '2.3');
  for (const field of ['earned', 'maximum', 'percentage']) assert.equal(bonus[field], ordinary[field]);
  assert.deepEqual([ordinary.earned, ordinary.maximum, ordinary.percentage], ['1.5', '2.0', '75.00']);
  assert.equal(mapper.result(fixture('successorResult'), context.successorId).bonus, null);
});

test('student display1 precision is strict while percentages retain2dp', () => {
  assert.equal(studentPointsDisplay('1.0'), '1.0');
  for (const bad of ['1.00', '1', '01.0', '1.0\n', '1.0\r', '1.0\u2028', '1.0\u2029', '1e1', 1])
    assert.throws(() => studentPointsDisplay(bad), protocol);
  const value = fixture('ordinaryResult'); value.ordinary.display.percentage = '75.0';
  assert.throws(() => mapper.result(value, context.attemptId), protocol);
});

test('double-rounding traps and totals above30 retain server display without browser policy', () => {
  const value = fixture('bonusResult');
  Object.assign(value.ordinary, { earned_points: 1.049, percentage: 52.45,
    display: { earned_points: '1.0', max_points: '2.0', percentage: '52.45' } });
  Object.assign(value.statistical_bonus, { earned_points: 2.35, display: { earned_points: '2.4' } });
  assert.equal(mapper.result(value, context.attemptId).earned, '1.0');
  Object.assign(value.ordinary, { earned_points: 60.04, max_points: 60.04, percentage: 100,
    display: { earned_points: '60.0', max_points: '60.0', percentage: '100.00' } });
  Object.assign(value.statistical_bonus, { earned_points: 120.04, display: { earned_points: '120.0' } });
  const mapped = mapper.result(value, context.attemptId);
  assert.deepEqual([mapped.earned, mapped.maximum, mapped.bonus], ['60.0', '60.0', '120.0']);
});

test('server midpoint and tiny-positive displays survive result and bonus mapping without arithmetic', () => {
  const value = fixture('bonusResult');
  Object.assign(value.ordinary, { earned_points: 1.005, percentage: 50.25,
    display: { earned_points: '1.0', max_points: '2.0', percentage: '50.25' } });
  Object.assign(value.statistical_bonus, { earned_points: 2.675, display: { earned_points: '2.7' } });
  const before = structuredClone(value); const projected = mapper.result(value, context.attemptId);
  assert.deepEqual([projected.earned, projected.maximum, projected.percentage, projected.bonus], ['1.0', '2.0', '50.25', '2.7']);
  assert.deepEqual(value, before);
  Object.assign(value.ordinary, { earned_points: 0.004, max_points: 0.004, percentage: 100,
    display: { earned_points: '0.0', max_points: '0.0', percentage: '100.00' } });
  value.statistical_bonus.display.earned_points = '0.0'; value.statistical_bonus.earned_points = 0.004;
  const small = mapper.result(value, context.attemptId);
  assert.deepEqual([small.earned, small.maximum, small.percentage, small.bonus], ['0.0', '0.0', '100.00', '0.0']);
});

test('display localization is lexical, retains precision and rejects trailing line terminators', () => {
  const large = '900719925474099312345678901234567890.00';
  assert.equal(display2(large), large);
  assert.equal(display2(large, ','), '900719925474099312345678901234567890,00');
  for (const invalid of ['1.01\n', '1.01\r', '1.01\r\n', '1.01\u2028', '1.01\u2029', '01.00', '-0.00', '1e2', ' 1.00', '1.0', '1.000', '1,00', '1.00%', 1]) {
    assert.throws(() => display2(invalid, ','), protocol);
  }
});

test('missing or malformed server display never falls back to approximate numbers', () => {
  for (const field of ['earned_points', 'max_points', 'percentage']) {
    const value = fixture('ordinaryResult'); delete value.ordinary.display[field];
    assert.throws(() => mapper.result(value, context.attemptId), protocol);
    value.ordinary.display[field] = '1.00\n';
    assert.throws(() => mapper.result(value, context.attemptId), protocol);
  }
  const ordinary = fixture('ordinaryResult'); delete ordinary.ordinary.display;
  assert.throws(() => mapper.result(ordinary, context.attemptId), protocol);
  const bonus = fixture('bonusResult'); delete bonus.statistical_bonus.display;
  assert.throws(() => mapper.result(bonus, context.attemptId), protocol);
});

test('history retains canonical displays and can localize repeatedly without changing attribution', () => {
  const value = fixture('historyRecovery');
  value.attempts[0].score.ordinary.earned_points = 1.005;
  value.attempts[0].score.ordinary.display.earned_points = '1.0';
  value.attempts[0].score.statistical_bonus.display.earned_points = '0.0';
  const before = structuredClone(value); const history = mapper.history(value, context);
  assert.equal(history[0].result.earned, '1.0'); assert.equal(history[0].result.bonus, '0.0');
  assert.equal(history[0].official, false); assert.equal(history[1].result, null);
  assert.equal(history[0].summary, 'Tarixiy natija, rasmiy emas · 1.0 / 2.0');
  assert.equal(historySummary(history[0].result, history[0].official, ','), 'Tarixiy natija, rasmiy emas · 1,0 / 2,0');
  assert.equal(historySummary(history[0].result, history[0].official, '.'), history[0].summary);
  assert.deepEqual(value, before);
});

test('ordinary null is independent of cancellation; terminal history requires an ordinary result', () => {
  const value = fixture('historyRecovery'); value.attempts[0].score.ordinary = null; value.attempts[0].score.statistical_bonus = null;
  const history = mapper.history(value, context);
  assert.equal(history[0].status, lifecycleLabel.cancelled); assert.equal(history[0].result, null);
  assert.equal(history[0].official, false); assert.equal(history[0].summary, 'Rasmiy natija yo‘q');
  for (const lifecycle of ['submitted', 'expired', 'forced']) {
    const completed = fixture('historyCompleted'); completed.attempts[0].lifecycle_status = lifecycle;
    completed.attempts[0].score.ordinary = null;
    assert.throws(() => mapper.history(completed, context), protocol);
    completed.attempts[0].score = null;
    assert.throws(() => mapper.history(completed, context), protocol);
  }
});

test('result scope and malformed numeric values fail without creating a zero result or a review grant', () => {
  assert.throws(() => mapper.result(fixture('ordinaryResult'), context.successorId), protocol);
  const invalid = fixture('ordinaryResult'); invalid.ordinary.percentage = NaN;
  assert.throws(() => mapper.result(invalid, context.attemptId), protocol);
  const zero = fixture('ordinaryResult'); zero.ordinary.max_points = 0;
  assert.throws(() => mapper.result(zero, context.attemptId), protocol);
  assert.match(mapper.result(fixture('ordinaryResult'), context.attemptId).reviewMessage, /alohida ruxsat/);
});

test('cancelled predecessor bonus remains historical; successor has no inherited result or invented history identity', () => {
  const history = mapper.history(fixture('historyRecovery'), context);
  assert.equal(history[0].attemptId, context.attemptId);
  assert.equal(history[0].result.bonus, '2.3');
  assert.equal(history[0].official, false);
  assert.match(history[0].summary, /Tarixiy natija, rasmiy emas/);
  assert.equal(history[1].attemptId, null);
  assert.equal(history[1].result, null);
  assert.equal(history[1].official, false);
  const current = mapper.history(fixture('historyCompleted'), context);
  assert.equal(current[0].official, true);
  assert.equal(current[0].title, context.title);
  const moved = fixture('historyCompleted'); moved.series.official_result_attempt_id = context.successorId;
  assert.equal(mapper.history(moved, context)[0].official, false);
});

test('unknown private fields do not reach UI projections and no media fetch is performed by mapping', () => {
  const source = fixture('in_progress');
  source.questions[0].internal_key = 'explicit synthetic extra field';
  source.questions[0].options[0].is_correct = true;
  source.staff_actor = 'explicit synthetic extra field';
  const projected = mapper.attempt(source, context);
  const encoded = JSON.stringify(projected);
  assert.ok(!encoded.includes('internal_key') && !encoded.includes('is_correct') && !encoded.includes('staff_actor'));
  let approvals = 0;
  const policy = createWireMap({ assetUrl: () => { approvals++; throw new Error('fixture media policy refused'); } });
  assert.throws(() => policy.attempt(fixture('in_progress'), context), /fixture media policy refused/);
  assert.equal(approvals, 1);
});

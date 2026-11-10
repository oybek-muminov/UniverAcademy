import test from 'node:test';
import assert from 'node:assert/strict';
import { StudentFlow } from '../src/flow.ts';
import { createDemoPort } from '../src/demo-port.ts';
import { createOperationJournal } from '../src/transport.ts';

async function started() {
  const demo = createDemoPort();
  let clock = 0;
  const flow = new StudentFlow(demo.port, () => clock);
  await flow.register('Namuna', 'O‘quvchi');
  await flow.openExam(flow.state.exams[0]);
  await flow.start();
  return { flow, demo, advance(ms) { clock += ms; } };
}

test('pending answer is not confirmed; clearing uses the next revision', async () => {
  const { flow } = await started();
  const write = flow.choose('sample-q1', 'sample-11');
  assert.equal(flow.state.attempt.answers['sample-q1'], undefined);
  assert.equal(flow.state.draft.optionId, 'sample-11');
  await write;
  assert.deepEqual(flow.state.attempt.answers['sample-q1'], { optionId: 'sample-11', revision: 1 });
  await flow.choose('sample-q1', null);
  assert.deepEqual(flow.state.attempt.answers['sample-q1'], { optionId: null, revision: 2 });
});

test('lost save acknowledgement requires a read before another save or submit', async () => {
  const { flow, demo } = await started();
  demo.setFault('lost-save');
  await flow.choose('sample-q1', 'sample-11');
  assert.equal(flow.state.needsRead, true);
  await flow.choose('sample-q2', 'sample-21');
  await flow.submit();
  assert.equal(flow.state.attempt.answers['sample-q2'], undefined);
  assert.equal(flow.submitKey, null);
  await flow.reconcile();
  assert.equal(flow.state.draft, null);
  assert.deepEqual(flow.state.attempt.answers['sample-q1'], { optionId: 'sample-11', revision: 1 });
});

test('CAS conflict preserves both intents until explicit selection at fresh revision', async () => {
  const { flow, demo } = await started();
  demo.setFault('conflict');
  await flow.choose('sample-q1', 'sample-11');
  await flow.reconcile();
  assert.equal(flow.state.draft.optionId, 'sample-11');
  assert.equal(flow.state.attempt.answers['sample-q1'].optionId, 'sample-12');
  await flow.choose('sample-q1', 'sample-11', true);
  assert.deepEqual(flow.state.attempt.answers['sample-q1'], { optionId: 'sample-11', revision: 2 });
  assert.equal(flow.state.draft, null);
});

test('new generation drops the old unsent draft and answers', async () => {
  const { flow, demo } = await started();
  await flow.choose('sample-q1', 'sample-11');
  demo.setFault('recovery');
  await flow.choose('sample-q2', 'sample-21');
  await flow.reconcile();
  assert.equal(flow.state.attempt.generation, 2);
  assert.equal(flow.state.draft, null);
  assert.deepEqual(flow.state.attempt.answers, {});
});

test('failed read blocks writes; local clock never declares a terminal result', async () => {
  const { flow, demo, advance } = await started();
  demo.setFault('offline');
  await flow.reconcile();
  assert.equal(flow.state.needsRead, true);
  demo.setFault('none');
  await flow.reconcile();
  const before = flow.remainingSeconds();
  advance(1000);
  assert.equal(flow.remainingSeconds(), before - 1);
  advance(1e9);
  assert.equal(flow.remainingSeconds(), 0);
  await flow.choose('sample-q1', 'sample-11');
  await flow.submit();
  assert.equal(flow.state.attempt.active, true);
  assert.equal(flow.state.result, null);
  assert.deepEqual(flow.state.attempt.answers, {});
});

test('uncertain submit retains its key, blocks edits and resolves with the same key', async () => {
  const { flow, demo } = await started();
  const seen = [];
  const submit = demo.port.submit;
  demo.port.submit = (...args) => { seen.push(args[2]); return submit(...args); };
  demo.setFault('lost-submit');
  await flow.submit();
  const key = flow.submitKey;
  assert.ok(key);
  await flow.choose('sample-q1', 'sample-11');
  assert.deepEqual(flow.state.attempt.answers, {});
  await flow.submit();
  assert.deepEqual(seen, [key, key]);
  assert.equal(flow.state.screen, 'result');
  assert.equal(flow.state.result.bonus, null);
  assert.match(flow.state.result.note, /hisoblanmaydi/);
});

test('current and history carry the selected assignment and reject cross-assignment content', async () => {
  const { flow, demo } = await started();
  const seen = [];
  const other = { ...flow.state.exam, id: 'sample-other', title: 'Other fixture' };
  demo.port.current = async id => { seen.push(['current', id]); return null; };
  demo.port.history = async id => { seen.push(['history', id]); return []; };
  await flow.openExam(other);
  await flow.showHistory(other);
  assert.deepEqual(seen, [['current', other.id], ['history', other.id]]);
  assert.equal(flow.state.exam.id, other.id);
  const wrong = (await started()).flow.state.attempt;
  demo.port.current = async () => wrong;
  await flow.openExam(other);
  assert.equal(flow.state.failure.kind, 'protocol');
  assert.equal(flow.state.attempt, null);
});

test('all lifecycle states are distinct; ready/cancelled/lapsed do not fetch or invent a result', async () => {
  const { flow, demo } = await started();
  let resultReads = 0;
  const result = demo.port.result;
  demo.port.result = (...args) => { resultReads++; return result(...args); };
  for (const status of ['ready', 'cancelled', 'recovery_lapsed', 'submitted', 'expired', 'forced']) {
    demo.setLifecycle(status);
    await flow.reconcile();
    assert.equal(flow.state.attempt.status, status);
    assert.equal(flow.state.attempt.active, false);
    assert.deepEqual(flow.state.attempt.questions, []);
    assert.deepEqual(flow.state.attempt.answers, {});
    assert.equal(flow.state.screen, ['submitted', 'expired', 'forced'].includes(status) ? 'result' : 'lifecycle');
    if (!['submitted', 'expired', 'forced'].includes(status)) assert.equal(flow.state.result, null);
  }
  assert.equal(resultReads, 3);
});

test('ready recovery only starts after explicit confirmation', async () => {
  const { flow, demo } = await started();
  demo.setLifecycle('ready');
  await flow.reconcile();
  assert.equal(flow.remainingSeconds(), 0);
  await flow.choose('sample-q1', 'sample-11');
  assert.deepEqual(flow.state.attempt.answers, {});
  assert.equal(flow.state.screen, 'lifecycle');
  await flow.start();
  assert.equal(flow.state.attempt.status, 'in_progress');
  assert.deepEqual(flow.state.attempt.answers, {});
});

test('reload reads authoritative state and restores an uncertain submit key without replaying edits', async () => {
  const values = new Map();
  const store = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  const demo = createDemoPort();
  const flow = new StudentFlow(demo.port, () => 0, createOperationJournal(store));
  await flow.register('Namuna', 'O‘quvchi');
  await flow.openExam(flow.state.exams[0]); await flow.start();
  const deadline = flow.state.attempt.deadline;
  const submit = demo.port.submit;
  const seen = [];
  demo.port.submit = async (...args) => { seen.push(args[2]); if (seen.length === 1) throw new Error('not acknowledged'); return submit(...args); };
  await flow.submit();
  const key = flow.submitKey;
  const reloaded = new StudentFlow(demo.port, () => 0, createOperationJournal(store));
  await reloaded.enter(); await reloaded.openExam(reloaded.state.exams[0]);
  assert.equal(reloaded.state.attempt.deadline, deadline);
  assert.equal(reloaded.submitKey, key);
  await reloaded.choose('sample-q1', 'sample-11');
  assert.deepEqual(reloaded.state.attempt.answers, {});
  await reloaded.submit();
  assert.deepEqual(seen, [key, key]);
  assert.equal(reloaded.state.screen, 'result');
});

test('server Retry-After delays explicit retry; auth and scope errors conceal protected content', async () => {
  const { flow, demo, advance } = await started();
  demo.setFault('limited'); await flow.reconcile();
  assert.equal(flow.state.failure.kind, 'limited');
  demo.setFault('none'); await flow.reconcile();
  assert.equal(flow.state.failure.kind, 'limited');
  advance(1001); await flow.reconcile();
  assert.equal(flow.state.failure, null);
  for (const fault of ['auth', 'forbidden', 'missing']) {
    const context = await started();
    context.demo.setFault(fault); await context.flow.reconcile();
    assert.equal(context.flow.state.failure.kind, fault);
    assert.equal(context.flow.state.attempt, null);
    assert.equal(context.flow.state.draft, null);
    assert.deepEqual(context.flow.state.exams, []);
    assert.equal(context.flow.state.screen, fault === 'auth' ? 'welcome' : 'exams');
  }
});

test('ordinary result does not wait for, add or inherit a nullable bonus', async () => {
  const { flow, demo } = await started();
  await flow.submit();
  const ordinary = { earned: flow.state.result.earned, maximum: flow.state.result.maximum, percentage: flow.state.result.percentage };
  assert.equal(flow.state.result.bonus, null);
  // Keep the returned fixture independent of the flow's temporary loading state.
  const snapshot = { ...flow.state.result, bonus: '9.00' };
  demo.port.result = async () => snapshot;
  await flow.reconcile();
  assert.equal(flow.state.result.bonus, '9.00');
  for (const key of Object.keys(ordinary)) assert.equal(flow.state.result[key], ordinary[key]);
  demo.setLifecycle('ready'); await flow.reconcile(); await flow.start();
  assert.equal(flow.state.result, null);
  assert.deepEqual(flow.state.attempt.answers, {});
});

test('missing ordinary at terminal completion is an invariant error rather than a zero or calculating result', async () => {
  const { flow, demo } = await started();
  demo.port.result = async () => null;
  for (const lifecycle of ['submitted', 'expired', 'forced']) {
    demo.setLifecycle(lifecycle); await flow.reconcile();
    assert.equal(flow.state.attempt.status, lifecycle);
    assert.equal(flow.state.failure.code, 'RESPONSE_INVARIANT_FAILED');
    assert.equal(flow.state.result, null); assert.equal(flow.state.screen, 'lifecycle');
  }
});

test('reload either resumes a committed start or retries an unconfirmed start with the same key', async () => {
  for (const committed of [false, true]) {
    const values = new Map();
    const store = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
    const demo = createDemoPort();
    const keys = [];
    const start = demo.port.start;
    demo.port.start = async (...args) => {
      keys.push(args[1]);
      if (keys.length === 1) { if (committed) await start(...args); throw new Error('lost reply'); }
      return start(...args);
    };
    const flow = new StudentFlow(demo.port, () => 0, createOperationJournal(store));
    await flow.register('Namuna', 'O‘quvchi'); await flow.openExam(flow.state.exams[0]); await flow.start();
    const reloaded = new StudentFlow(demo.port, () => 0, createOperationJournal(store));
    await reloaded.enter(); await reloaded.openExam(reloaded.state.exams[0]);
    if (committed) assert.equal(keys.length, 1);
    else { await reloaded.start(); assert.deepEqual(keys, [flow.startKey, flow.startKey]); }
    assert.equal(reloaded.state.attempt.status, 'in_progress');
    assert.deepEqual(reloaded.state.attempt.answers, {});
  }
});

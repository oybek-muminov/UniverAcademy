import './verify-backend-targets.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startLocalServer } from '../../../runtime/local-server.mjs';
import { syntheticLoginInput } from '../../../runtime/local-lab.mjs';
import { ids } from '../../../tests/backend/http-fixture.ts';
import { createLocalOwnerPort } from '../src/local-owner-port.ts';
import { STUDENT_CONTRACT_SHA256 } from '../src/owner-client/student-client.ts';
import { StudentFlow } from '../src/flow.ts';
import { numericLab } from './numeric-lab.mjs';

const launch = () => syntheticLoginInput().init_data;
for (const [input, expected] of [['2.34', '2.3'], ['2.35', '2.4'], ['2.355', '2.4'], ['2.349', '2.3']]) {
  test(`real HTTP exact-source rounding: ${input} -> ${expected}`, async () => {
    const server = await startLocalServer({ lab: numericLab(input) });
    let submitted, fetchedResult, fetchedHistory;
    try {
      const flow = await entered(adapter(server, async request => {
        const response = await fetch(request);
        const path = new URL(request.url).pathname;
        if (path.endsWith('/submit')) submitted = (await response.clone().json()).data;
        if (path.endsWith('/result')) fetchedResult = (await response.clone().json()).data;
        if (path.endsWith('/history')) fetchedHistory = (await response.clone().json()).data;
        return response;
      }));
      const q = flow.state.attempt.questions[0];
      await flow.choose(q.id, ids.correct);
      await flow.submit();
      assert.equal(flow.state.screen, 'result');
      assert.equal(flow.state.result.earned, expected);
      assert.equal(flow.state.result.maximum, expected);
      assert.equal(flow.state.result.percentage, '100.00');
      assert.equal(flow.state.result.bonus, null);
      await flow.showHistory();
      const entry = fetchedHistory.attempts[0];
      assert.equal(entry.lifecycle_status, 'submitted');
      assert.equal(entry.cancellation, null);
      assert.equal(entry.deadline_at, flow.state.attempt.deadline);
      for (const field of ['started_at', 'completed_at']) assert.ok(typeof entry[field] === 'string' && entry[field].endsWith('Z'));
      assert.equal(entry.score.attempt_id, submitted.attempt_id);
      assert.deepEqual(entry.score, submitted);
      assert.deepEqual(entry.score, fetchedResult);
      assert.deepEqual(entry.score.ordinary.display,
        { earned_points: expected, max_points: expected, percentage: '100.00' });
      assert.equal(entry.score.statistical_bonus, null);
      assert.equal(flow.state.history[0].result.earned, expected);
    } finally { await server.close(); }
  });
}
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
function adapter(server, fetcher = fetch, extra = {}) {
  return createLocalOwnerPort({ mode: 'local_fixture', contractSha256: STUDENT_CONTRACT_SHA256,
    baseUrl: server.baseUrl, fetcher, assetUrl: value => value,
    // Explicit synthetic fixture UI context, not a new grant/capability rule.
    view: () => ({ title: 'Sun’iy fizika', groupLabel: 'Sintetik guruh', startAllowed: true }), ...extra });
}
async function entered(app) {
  await app.auth.login(launch());
  const flow = new StudentFlow(app.port);
  await flow.enter();
  if (flow.state.screen === 'profile') await flow.register('Suniy', 'Namuna');
  assert.equal(flow.state.screen, 'exams');
  await flow.openExam(flow.state.exams[0]);
  if (flow.state.screen === 'instructions') await flow.start();
  assert.equal(flow.state.screen, 'attempt');
  return flow;
}

test('real HTTP: register/start/server timer/CAS clear/submit/history use owner client and1dp points', async () => {
  const server = await startLocalServer();
  const reading = gate(), ack = gate(); let delaySave = true;
  try {
    const app = adapter(server, async request => {
      const response = await fetch(request);
      if (request.method === 'PUT' && delaySave) { delaySave = false; reading.release(); await ack.promise; }
      return response;
    });
    const flow = await entered(app); const attempt = flow.state.attempt;
    const q = attempt.questions.find(question => question.id === ids.question);
    const option = q.options.find(option => option.id === ids.correct);
    const save = flow.choose(q.id, option.id);
    await reading.promise;
    assert.equal(flow.state.attempt.answers[q.id], undefined);
    assert.equal(flow.state.draft.optionId, option.id);
    ack.release(); await save;
    assert.equal(flow.state.attempt.answers[q.id].revision, 1);
    await flow.choose(q.id, null); assert.equal(flow.state.attempt.answers[q.id].revision, 2);
    await flow.choose(q.id, option.id); assert.equal(flow.state.attempt.answers[q.id].revision, 3);
    assert.equal(flow.state.attempt.deadline, attempt.deadline);
    assert.ok(flow.remainingSeconds() > 0 && flow.remainingSeconds() <= 300);
    // Explicit start replay retains the existing attempt, deadline and saved answers.
    const replay = await app.port.start(attempt.assignmentId, flow.startKey);
    assert.equal(replay.id, attempt.id); assert.equal(replay.deadline, attempt.deadline);
    assert.equal(replay.answers[q.id].revision, 3);
    const submitKey = flow.journal.key(flow.scope('submit'));
    await flow.submit(); assert.equal(flow.state.screen, 'result');
    assert.deepEqual([flow.state.result.earned, flow.state.result.maximum, flow.state.result.percentage, flow.state.result.bonus], ['1.0', '2.0', '50.00', null]);
    await app.port.submit(attempt.id, attempt.generation, submitKey);
    await flow.showHistory(); assert.equal(flow.state.history[0].result.earned, '1.0');
    assert.equal(flow.state.history[0].official, true);
  } finally { ack.release(); await server.close(); }
});

test('real HTTP: new device revokes old context and resumes saved answers/generation/deadline', async () => {
  const server = await startLocalServer();
  try {
    const first = adapter(server), old = await entered(first), before = old.state.attempt;
    const q = before.questions[0]; await old.choose(q.id, q.options[0].id);
    const second = adapter(server); await second.auth.login(launch());
    await old.reconcile();
    assert.equal(first.auth.person(), null); assert.equal(old.state.failure.code, 'SESSION_REVOKED');
    assert.equal(old.state.attempt, null); assert.equal(old.state.student, null); assert.equal(old.state.draft, null);
    const fresh = new StudentFlow(second.port); await fresh.enter(); await fresh.openExam(fresh.state.exams[0]);
    assert.equal(fresh.state.attempt.id, before.id); assert.equal(fresh.state.attempt.generation, before.generation);
    assert.equal(fresh.state.attempt.deadline, before.deadline); assert.equal(fresh.state.attempt.answers[q.id].revision, 1);
    assert.equal(fresh.state.draft, null); assert.ok(fresh.remainingSeconds() <= 300);
  } finally { await server.close(); }
});

test('real HTTP: lost logout ACK retries only explicitly with identical refresh proof and no bearer', async () => {
  const server = await startLocalServer(); const bodies = [], statuses = []; let refreshes = 0;
  try {
    const app = adapter(server, async request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/auth/refresh')) refreshes++;
      if (path.endsWith('/auth/logout')) {
        assert.equal(request.headers.has('authorization'), false); assert.equal(request.credentials, 'omit');
        bodies.push(await request.clone().text());
      }
      const response = await fetch(request);
      if (path.endsWith('/auth/logout')) {
        statuses.push(response.status);
        if (bodies.length === 1) { await response.arrayBuffer(); throw new Error('Synthetic lost ACK after actual commit'); }
      }
      return response;
    }, { logoutReceiptPolicy: { retentionMs: 120000 } });
    await app.auth.login(launch()); await assert.rejects(app.auth.logout(), error => error.code === 'UNCONFIRMED');
    assert.equal(app.auth.person(), null); const operation = app.auth.logoutReceipt();
    assert.equal(operation.state, 'uncertain'); assert.equal(bodies.length, 1);
    await app.auth.retryLogoutReceipt(operation.operationId);
    assert.equal(app.auth.logoutReceipt().state, 'confirmed');
    assert.ok(bodies[0] === bodies[1], 'Original proof reused without logging its value');
    assert.deepEqual(statuses, [200, 200]); assert.equal(refreshes, 0);
  } finally { await server.close(); }
});

test('real HTTP: late logout ACK cannot revoke or overwrite a fresh same-person login', async () => {
  const server = await startLocalServer(); const arrived = gate(), release = gate(); let delay = true;
  try {
    const app = adapter(server, async request => {
      const response = await fetch(request);
      if (new URL(request.url).pathname.endsWith('/auth/logout') && delay) { delay = false; arrived.release(); await release.promise; }
      return response;
    }, { logoutReceiptPolicy: { retentionMs: 120000 } });
    await app.auth.login(launch()); const person = app.auth.person();
    const pending = app.auth.logout(); const rejected = assert.rejects(pending, error => error.code === 'LOGOUT_RECEIPT_SUPERSEDED');
    await arrived.promise; await app.auth.login(launch()); release.release(); await rejected;
    assert.equal(app.auth.person(), person); assert.equal((await app.port.profile()).person, person);
    assert.equal(app.auth.logoutReceipt().state, 'cancelled');
  } finally { release.release(); await server.close(); }
});

test('real HTTP: concurrent client expiry checks share exactly one refresh operation', async () => {
  const server = await startLocalServer(); let clock = Date.now(), refreshes = 0;
  try {
    const app = adapter(server, async request => {
      if (new URL(request.url).pathname.endsWith('/auth/refresh')) refreshes++;
      return fetch(request);
    }, { now: () => clock });
    await entered(app); clock += 1000000;
    const [profile, exams] = await Promise.all([app.port.profile(), app.port.exams()]);
    assert.ok(profile.person); assert.equal(exams.length, 1); assert.equal(refreshes, 1);
  } finally { await server.close(); }
});

for (const status of [200, 401]) {
  test(`real HTTP: delayed${status} me body is superseded before affecting fresh login`, async () => {
    const server = await startLocalServer(); const reading = gate(), release = gate(); let hold = false;
    try {
      const app = adapter(server, async request => {
        const response = await fetch(request);
        if (hold && new URL(request.url).pathname.endsWith('/me')) {
          hold = false; assert.equal(response.status, status);
          const native = response.json.bind(response);
          response.json = async () => { reading.release(); await release.promise; return native(); };
        }
        return response;
      });
      await app.auth.login(launch());
      if (status === 401) await adapter(server).auth.login(launch());
      hold = true; const pending = app.port.profile();
      const rejected = assert.rejects(pending, error => error.code === 'ACCESS_SUPERSEDED');
      await reading.promise; await app.auth.login(launch()); release.release(); await rejected;
      assert.equal((await app.port.profile()).person, app.auth.person());
    } finally { release.release(); await server.close(); }
  });
}

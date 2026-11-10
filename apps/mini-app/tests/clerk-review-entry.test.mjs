import './verify-backend-targets.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startClerkReviewServer } from '../../../runtime/clerk-review-server.mjs';
import { STUDENT_CONTRACT_SHA256 } from '../src/owner-client/student-client.ts';
import { createClerkReviewEntry } from '../src/clerk-review-entry.ts';
import { createStudentTransport } from '../src/transport.ts';

function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const turn = () => new Promise(resolve => setImmediate(resolve));
async function harness(t, options = {}) {
  const local = await startClerkReviewServer(); t.after(() => local.close());
  const { lab } = local, calls = [];
  let currentToken = null, googleNo = 0;
  const runtime = createClerkReviewEntry({ mode: 'local_fixture', baseUrl: local.baseUrl,
    contractSha256: STUDENT_CONTRACT_SHA256,
    view: (_id, meta) => ({ title: meta?.title ?? '', groupLabel: '', startAllowed: meta?.admission_status === 'open' }),
    assetUrl: value => value,
    provider: {
      google: async () => {
        const count = ++googleNo;
        currentToken = options.google ? await options.google(lab, count) : await lab.sign(lab.actors.existing);
        return { proof: currentToken };
      },
      sendCode: async email => { assert.equal(email, 'oquvchi@example.test'); return { challenge: 'synthetic-challenge' }; },
      verifyCode: async (challenge, code) => {
        assert.equal(challenge, 'synthetic-challenge'); assert.equal(code, '246810');
        currentToken = await lab.sign(lab.actors.fresh); return { proof: currentToken };
      },
    },
    fetcher: async request => {
      const path = new URL(request.url).pathname;
      calls.push({ path, request: request.clone() });
      return options.fetcher ? options.fetcher(request, () => fetch(request), lab) : fetch(request);
    },
  });
  t.after(() => runtime.dispose());
  const email = async () => { await runtime.sendCode('oquvchi@example.test'); await runtime.verifyCode('246810'); };
  return { local, lab, runtime, calls, email, currentToken: () => currentToken };
}
function holdJson(response, reading, release, capture = () => {}) {
  const json = response.json.bind(response);
  response.json = async () => { const value = await json(); capture(value); reading.resolve(); await release.promise; return value; };
  return response; // Deliberately ignores cancellation after headers: epoch must still win.
}

test('Clerk review entry exchanges once, uses opaque proofs and completes save/clear/resume, submit/result/history and body-only logout over TCP', async t => {
  const h = await harness(t); await h.runtime.google();
  const flow = h.runtime.snapshot().flow; assert.equal(flow.state.screen, 'exams');
  const exchange = h.calls[0].request;
  assert.equal(exchange.url, h.local.baseUrl + '/auth/clerk'); assert.deepEqual(await exchange.json(), {});
  assert.equal(exchange.headers.get('authorization'), 'Bearer ' + h.currentToken());
  assert.equal(h.calls.filter(c => c.path.endsWith('/auth/clerk')).length, 1);
  const access = h.calls.find(c => c.path.endsWith('/me')).request.headers.get('authorization');
  assert.notEqual(access, exchange.headers.get('authorization'));
  await flow.openExam(flow.state.exams[0]); await flow.start();
  const attempt = flow.state.attempt, q = attempt.questions.find(q => q.id === h.lab.ids.question); assert(flow.remainingSeconds() > 0);
  await flow.choose(q.id, h.lab.ids.correct); assert.equal(flow.state.attempt.answers[q.id].revision, 1);
  await flow.choose(q.id, null); assert.equal(flow.state.attempt.answers[q.id].revision, 2);
  await flow.choose(q.id, h.lab.ids.correct); await flow.reconcile();
  assert.equal(flow.state.attempt.id, attempt.id); assert.equal(flow.state.attempt.deadline, attempt.deadline);
  assert.equal(flow.state.attempt.answers[q.id].revision, 3);
  await flow.submit(); assert.equal(flow.state.screen, 'result');
  assert.deepEqual([flow.state.result.earned, flow.state.result.maximum, flow.state.result.percentage, flow.state.result.bonus], ['1.0', '2.0', '50.00', null]);
  await flow.showHistory(); assert.equal(flow.state.history[0].attemptId, attempt.id);
  await h.runtime.logout(); assert.equal(h.runtime.snapshot().flow, null); assert.match(h.runtime.snapshot().notice, /tasdiqladi/);
  const logout = h.calls.find(c => c.path.endsWith('/auth/logout')).request;
  assert.equal(logout.headers.has('authorization'), false); assert.deepEqual(Object.keys(await logout.json()), ['refresh_token']);
  assert.equal((await fetch(h.local.baseUrl + '/me', { headers: { authorization: access } })).status, 401);
  await assert.rejects(flow.port.profile(), error => error.kind === 'auth');
  for (const c of h.calls) { assert.equal(c.request.redirect, 'error'); assert.equal(c.request.credentials, 'omit'); assert.equal(c.request.cache, 'no-store'); }
});

test('email evidence creates a fresh ungrouped student; canonical profile controls registration and empty exams', async t => {
  const h = await harness(t); await h.email();
  const flow = h.runtime.snapshot().flow; assert.equal(flow.state.screen, 'profile');
  const person = flow.state.student.person; assert.notEqual(person, h.lab.ids.person);
  assert.equal(h.lab.store.state.domain.student.people[person].telegramId, null);
  await flow.register('Suniy', 'Yangi'); assert.equal(flow.state.screen, 'exams'); assert.deepEqual(flow.state.exams, []);
  const snapshot = JSON.stringify(h.runtime.snapshot());
  for (const marker of [h.currentToken(), '246810', 'oquvchi@example.test', 'synthetic-challenge']) assert(!snapshot.includes(marker));
  await h.runtime.logout();
});

test('cancelled provider completion never exchanges or replaces the newer email flow', async t => {
  const release = gate(); const h = await harness(t, { google: async lab => { await release.promise; return lab.sign(); } });
  const old = h.runtime.google(); h.runtime.reset(); await h.email(); const fresh = h.runtime.snapshot().flow;
  release.resolve(); await old; assert.equal(h.runtime.snapshot().flow, fresh);
  assert.equal(h.calls.filter(c => c.path.endsWith('/auth/clerk')).length, 1);
  await h.runtime.logout();
});

test('cancel after exchange headers rejects the late body and preserves a newer login even when fetch ignores abort', async t => {
  const reading = gate(), release = gate(); let first = true;
  const h = await harness(t, { fetcher: async (request, send) => {
    const response = await send();
    if (first && request.url.endsWith('/auth/clerk')) { first = false; return holdJson(response, reading, release); }
    return response;
  } });
  const old = h.runtime.google(); await reading.promise; h.runtime.reset(); await h.email(); const fresh = h.runtime.snapshot().flow;
  release.resolve(); await old; assert.equal(h.runtime.snapshot().flow, fresh); assert.equal(h.runtime.snapshot().step, 'ready');
  await fresh.port.profile(); await h.runtime.logout();
});

test('cancel while profile body is pending retires the known app session and cannot expose its old payload', async t => {
  const reading = gate(), release = gate(); let first = true;
  const h = await harness(t, { fetcher: async (request, send) => {
    const response = await send();
    if (first && request.url.endsWith('/me')) { first = false; return holdJson(response, reading, release); }
    return response;
  } });
  const old = h.runtime.google(); await reading.promise;
  const access = h.calls.find(c => c.path.endsWith('/me')).request.headers.get('authorization');
  h.runtime.reset(); await h.email(); const fresh = h.runtime.snapshot().flow;
  release.resolve(); await old; assert.equal(h.runtime.snapshot().flow, fresh);
  assert(h.calls.some(c => c.path.endsWith('/auth/logout')));
  assert.equal((await fetch(h.local.baseUrl + '/me', { headers: { authorization: access } })).status, 401);
  await h.runtime.logout();
});

test('a delayed logout ACK cannot clear or alter a newer login; logout rejection remains observed', async t => {
  const reading = gate(), release = gate(); let first = true;
  const h = await harness(t, { fetcher: async (request, send) => {
    const response = await send();
    if (first && request.url.endsWith('/auth/logout')) { first = false; return holdJson(response, reading, release); }
    return response;
  } });
  await h.runtime.google(); const logout = h.runtime.logout().catch(error => error); await reading.promise;
  assert.equal(h.runtime.snapshot().flow, null); await h.email(); const fresh = h.runtime.snapshot().flow;
  release.resolve(); assert.equal((await logout).code, 'SUPERSEDED'); assert.equal(h.runtime.snapshot().flow, fresh);
  await fresh.port.profile(); await h.runtime.logout();
});

test('lost exchange reply is not replayed, and a fresh verified proof recovers without restoring the cancelled context', async t => {
  let token, failed = false;
  const h = await harness(t, {
    google: async (lab, count) => count < 3 ? (token ??= await lab.sign()) : lab.sign(),
    fetcher: async (request, send) => { const response = await send(); if (!failed && request.url.endsWith('/auth/clerk')) { failed = true; throw new Error('synthetic lost reply'); } return response; },
  });
  await h.runtime.google(); assert.equal(h.runtime.snapshot().flow, null);
  await h.runtime.google(); assert.equal(h.runtime.snapshot().flow, null);
  assert.equal(h.calls.filter(c => c.path.endsWith('/auth/clerk')).length, 1);
  await h.runtime.google(); assert.equal(h.runtime.snapshot().step, 'ready');
  assert.equal(h.calls.filter(c => c.path.endsWith('/auth/clerk')).length, 2); await h.runtime.logout();
});

test('logout during an exchange body wait clears locally and never claims a server ACK or revives its late session', async t => {
  const reading = gate(), release = gate(); let first = true;
  const h = await harness(t, { fetcher: async (request, send) => {
    const response = await send();
    if (first && request.url.endsWith('/auth/clerk')) { first = false; return holdJson(response, reading, release); }
    return response;
  } });
  const old = h.runtime.google(); await reading.promise; await h.runtime.logout();
  assert.match(h.runtime.snapshot().notice, /tasdiqlanmagan/); assert.equal(h.runtime.snapshot().flow, null);
  assert.equal(h.calls.filter(c => c.path.endsWith('/auth/logout')).length, 0);
  await h.email(); const fresh = h.runtime.snapshot().flow; release.resolve(); await old;
  assert.equal(h.runtime.snapshot().flow, fresh); await fresh.port.profile(); await h.runtime.logout();
});

test('failed logout stays locally signed out, reports uncertainty and cannot resurrect the old flow', async t => {
  let fail = true;
  const h = await harness(t, { fetcher: async (request, send) => {
    if (fail && request.url.endsWith('/auth/logout')) throw new Error('synthetic offline logout');
    return send();
  } });
  await h.runtime.google(); const old = h.runtime.snapshot().flow;
  await assert.rejects(h.runtime.logout()); assert.equal(h.runtime.snapshot().flow, null);
  assert.match(h.runtime.snapshot().notice, /tasdig‘i kelmadi/);
  await assert.rejects(old.port.profile(), error => error.kind === 'auth');
  await h.email(); const fresh = h.runtime.snapshot().flow; await fresh.port.profile();
  assert.equal(h.runtime.snapshot().flow, fresh); fail = false; await h.runtime.logout();
});

test('provider revocation hides the old flow; a new verified session resumes server answers and deadline', async t => {
  const h = await harness(t, { google: async (lab, count) => {
    if (count > 1) { lab.activate(lab.users.student, lab.sids.second); return lab.sign({ sessionId: lab.sids.second }); }
    return lab.sign();
  } });
  await h.runtime.google(); const old = h.runtime.snapshot().flow; await old.openExam(old.state.exams[0]); await old.start();
  const attempt = old.state.attempt, q = attempt.questions[0]; await old.choose(q.id, q.options[0].id);
  h.lab.live.get(h.lab.sids.first).status = 'revoked'; await old.enter();
  assert.equal(old.state.student, null); assert.equal(old.state.attempt, null); assert.equal(old.state.screen, 'welcome');
  assert.match(old.state.notice, /Google yoki email orqali yangidan kiring/);
  assert(!old.state.notice.includes('Telegram'));
  h.runtime.reset(); await h.runtime.google(); const fresh = h.runtime.snapshot().flow;
  await fresh.openExam(fresh.state.exams[0]); assert.equal(fresh.state.attempt.id, attempt.id);
  assert.equal(fresh.state.attempt.deadline, attempt.deadline); assert.equal(fresh.state.attempt.answers[q.id].revision, 1);
  await h.runtime.logout();
});

test('local transport clear invalidates pending login and an old success without a server logout claim', async () => {
  const login = gate(), read = gate();
  const proof = { access: 'synthetic-access', refresh: 'synthetic-refresh', person: 'synthetic-person', expiresAt: 1000 };
  const transport = createStudentTransport({ origin: 'https://mock.invalid/api/v1', now: () => 1,
    fetcher: async () => { throw new Error('unused'); }, sessions: { login: () => login.promise, rotate: async () => proof, logout: async () => {} } });
  const opening = transport.login('synthetic-provider-proof').catch(error => error); transport.clear(); login.resolve(proof);
  assert.equal((await opening).kind, 'auth'); assert.equal(transport.person(), null);
  await transport.login('synthetic-fresh-proof'); const pending = transport.withAccess(() => read.promise).catch(error => error);
  transport.clear(); read.resolve('OLD_PRIVATE_VALUE'); assert.equal((await pending).code, 'ACCESS_SUPERSEDED'); assert.equal(transport.person(), null);
  assert.equal(transport.logoutReceipt(), null);
});

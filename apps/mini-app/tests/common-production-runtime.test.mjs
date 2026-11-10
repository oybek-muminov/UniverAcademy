import './verify-backend-targets.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startClerkReviewServer } from '../../../runtime/clerk-review-server.mjs';
import { STUDENT_CONTRACT_SHA256 } from '../src/owner-client/student-client.ts';
import { readCommonEntryConfig, createCommonProductionRuntime } from '../src/common-production-runtime.ts';
import { fakeClerkSdk } from './fixtures/clerk-sdk.fixture.mjs';

const env = { VITE_MINI_APP_ORIGIN: 'https://app.example.test', VITE_API_ORIGIN: 'https://api.example.test',
  VITE_STUDENT_CONTRACT_SHA256: STUDENT_CONTRACT_SHA256,
  VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_' + btoa('clerk.example.test$'),
  VITE_CLERK_FRONTEND_ORIGIN: 'https://clerk.example.test' };
const config = () => readCommonEntryConfig(env, env.VITE_MINI_APP_ORIGIN);
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

test('common config pins HTTPS app/API/Clerk host and fixed callback, with Telegram explicitly optional', () => {
  const c = config(); assert(Object.isFrozen(c)); assert.equal(c.callbackUrl, 'https://app.example.test/auth/callback');
  assert.equal(c.signInUrl, 'https://app.example.test/sign-in'); assert.equal(c.telegramEnabled, false);
  assert.equal(readCommonEntryConfig({ ...env, VITE_TELEGRAM_SDK_ENABLED: 'true' }, env.VITE_MINI_APP_ORIGIN).telegramEnabled, true);
});
for (const values of [
  { VITE_CLERK_PUBLISHABLE_KEY: undefined }, { VITE_CLERK_PUBLISHABLE_KEY: 'not-a-key' },
  { VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_' + btoa('other.example.test$') },
  { VITE_CLERK_FRONTEND_ORIGIN: 'http://clerk.example.test' },
  { VITE_CLERK_FRONTEND_ORIGIN: 'https://clerk.example.test/path' },
  { VITE_CLERK_FRONTEND_ORIGIN: 'https://clerk.example.test?redirect=elsewhere' },
  { VITE_CLERK_FRONTEND_ORIGIN: 'https://clerk.example.test:444' },
  { VITE_CLERK_FRONTEND_ORIGIN: 'https://user:synthetic@clerk.example.test' },
  { VITE_CLERK_FRONTEND_ORIGIN: ' https://clerk.example.test' },
]) test('common config fails closed before SDK/API on ' + Object.keys(values)[0] + '=' + JSON.stringify(Object.values(values)[0]), () => {
  assert.throws(() => readCommonEntryConfig({ ...env, ...values }, env.VITE_MINI_APP_ORIGIN), e => e.kind === 'protocol');
});
test('stale contract, app mismatch and callback override are rejected before provider IO', () => {
  assert.throws(() => readCommonEntryConfig({ ...env, VITE_STUDENT_CONTRACT_SHA256: 'old' }, env.VITE_MINI_APP_ORIGIN), e => e.code === 'CONTRACT_HASH_MISMATCH');
  assert.throws(() => readCommonEntryConfig(env, 'https://different.example.test'), e => e.code === 'APP_ORIGIN_MISMATCH');
  const { sdk, calls } = fakeClerkSdk(); sdk.callbackUrl = 'https://elsewhere.example.test/auth/callback';
  assert.throws(() => createCommonProductionRuntime(config(), sdk, 'browser'), e => e.code === 'CALLBACK_CONFIG_MISMATCH');
  assert.equal(calls.length, 0);
});

async function harness(t, options = {}) {
  const server = await startClerkReviewServer(); t.after(() => server.close());
  const { lab } = server, calls = [];
  const h = fakeClerkSdk({ ...options.sdk, token: async () => lab.sign(options.fresh ? lab.actors.fresh : lab.actors.existing) });
  const runtime = createCommonProductionRuntime(config(), h.sdk, options.context ?? 'browser', async request => {
    assert.equal(new URL(request.url).origin, env.VITE_API_ORIGIN);
    calls.push({ request: request.clone() });
    const url = new URL(request.url), target = new URL(server.baseUrl); url.protocol = target.protocol; url.host = target.host;
    const send = () => fetch(new Request(url, request));
    return options.send ? options.send(request, send) : send();
  });
  t.after(() => runtime.dispose());
  return { ...h, runtime, server, lab, calls, sdkCalls: h.calls };
}
test('public SDK facade -> production owner client -> real loopback exchange -> save/resume/result/history -> targeted logout', async t => {
  const h = await harness(t); await h.runtime.google();
  const flow = h.runtime.snapshot().flow; assert.equal(flow.state.screen, 'exams'); assert.equal(flow.signInMethod, 'clerk');
  const exchange = h.calls[0].request; assert.equal(exchange.url, env.VITE_API_ORIGIN + '/api/v1/auth/clerk');
  assert.deepEqual(await exchange.json(), {});
  const sdkProof = exchange.headers.get('authorization'); const appProof = h.calls[1].request.headers.get('authorization');
  assert.notEqual(sdkProof, appProof);
  await flow.openExam(flow.state.exams[0]); await flow.start();
  const attempt = flow.state.attempt, q = attempt.questions.find(q => q.id === h.lab.ids.question);
  // Node-only synthetic Backend key; never assume shuffled option order.
  await flow.choose(q.id, h.lab.ids.correct); await flow.choose(q.id, null); await flow.choose(q.id, h.lab.ids.correct);
  await flow.reconcile(); assert.equal(flow.state.attempt.deadline, attempt.deadline); assert(flow.remainingSeconds() > 0);
  assert.equal(flow.state.attempt.answers[q.id].revision, 3); await flow.submit(); assert.equal(flow.state.screen, 'result');
  assert.deepEqual([flow.state.result.earned, flow.state.result.maximum, flow.state.result.percentage, flow.state.result.bonus], ['1.0', '2.0', '50.00', null]);
  await flow.showHistory(); assert.equal(flow.state.history[0].attemptId, attempt.id);
  const sid = h.sdk.session().id; await h.runtime.logout(); assert.equal(h.runtime.snapshot().flow, null);
  assert.equal(h.calls.filter(c => c.request.url.endsWith('/auth/logout')).length, 1);
  const out = h.calls.find(c => c.request.url.endsWith('/auth/logout')).request;
  assert(!out.headers.has('authorization')); assert.deepEqual(Object.keys(await out.json()), ['refresh_token']);
  assert.equal(h.sdk.session(), null);
  assert(h.calls.every(c => c.request.credentials === 'omit' && c.request.cache === 'no-store' && c.request.redirect === 'error' && c.request.mode === 'cors'));
  assert.deepEqual(h.calls.filter(c => c.request.url.includes('/auth/telegram')), []);
  assert.equal(h.calls.filter(c => c.request.url.endsWith('/auth/clerk')).length, 1);
  // SDK audit is separate from the HTTP audit; the captured provider session only.
  assert.deepEqual(h.sdkCalls.filter(c => c[0] === 'signOut'), [['signOut', sid]]);
});
test('email SDK proof enters server-owned registration and an ungrouped student has no tests', async t => {
  const h = await harness(t, { fresh: true });
  await h.runtime.sendCode('Student@example.test'); await h.runtime.verifyCode('123456');
  assert.equal(h.runtime.snapshot().step, 'ready'); assert.equal(h.runtime.snapshot().flow.signInMethod, 'clerk');
  const flow = h.runtime.snapshot().flow; assert.equal(flow.state.screen, 'profile');
  await flow.register('Suniy', 'Email'); assert.equal(flow.state.screen, 'exams'); assert.deepEqual(flow.state.exams, []);
  await h.runtime.logout();
});
test('Telegram WebView Google path is stopped before popup/API; email remains available', async t => {
  const h = await harness(t, { context: 'telegram_webview' }); await h.runtime.google();
  assert.equal(h.runtime.snapshot().step, 'browser_required'); assert.equal(h.calls.length, 0);
  h.runtime.reset(); await turn(); await h.runtime.sendCode('student@example.test'); assert.equal(h.runtime.snapshot().step, 'code');
});
test('cancel after SDK finalize began cannot exchange its late session; explicit re-entry uses fresh proof', async t => {
  const wait = gate(); let first = true;
  const h = await harness(t, { sdk: { finalize: async (kind, input, activate) => {
    if (first) { first = false; const id = h.sdk[kind].createdSessionId; await wait.promise; activate(id); return { error: null }; }
    activate(h.sdk[kind].createdSessionId); return { error: null };
  } } });
  const old = h.runtime.google(); await turn(); h.runtime.reset(); wait.release(); await old; await turn();
  assert.equal(h.calls.length, 0); assert.equal(h.runtime.snapshot().flow, null); assert.equal(h.sdk.session(), null);
  await h.runtime.google(); assert.equal(h.runtime.snapshot().step, 'ready'); await h.runtime.logout();
});
test('logout local clear precedes HTTP ACK, blocks new SDK auth until captured cleanup and cannot auto-reactivate', async t => {
  const wait = gate(), read = gate(); let first = true;
  const h = await harness(t, { send: async (request, send) => {
    const response = await send(); if (first && request.url.endsWith('/auth/logout')) {
      first = false; const json = response.json.bind(response); response.json = async () => { const value = await json(); read.release(); await wait.promise; return value; };
    } return response;
  } });
  await h.runtime.google(); const old = h.runtime.snapshot().flow; const out = h.runtime.logout().catch(e => e); await read.promise;
  assert.equal(h.runtime.snapshot().flow, null); await h.runtime.google(); assert.equal(h.runtime.snapshot().flow, null);
  assert.match(h.runtime.snapshot().notice, /Oldingi kirish/); wait.release(); assert.equal((await out).code, 'SUPERSEDED');
  await turn(); assert.equal(h.sdk.session(), null); assert.equal(h.runtime.snapshot().flow, null);
  await assert.rejects(old.port.profile(), e => e.kind === 'auth');
  await h.runtime.google(); assert.equal(h.runtime.snapshot().step, 'ready'); await h.runtime.logout();
});
test('provider signout failure preserves an actual app ACK without claiming the SDK session was closed', async t => {
  const h = await harness(t, { sdk: { signOut: async () => { throw new Error('Synthetic SDK offline'); } } });
  await h.runtime.google(); const old = h.runtime.snapshot().flow;
  await assert.rejects(h.runtime.logout(), e => e.code === 'PROVIDER_LOGOUT_UNCONFIRMED');
  assert.equal(h.runtime.snapshot().flow, null); assert(h.sdk.session());
  assert.equal(h.calls.filter(c => c.request.url.endsWith('/auth/logout')).length, 1);
  assert.match(h.runtime.snapshot().notice, /Server sessiya yopilganini tasdiqladi.*Kirish xizmatidagi chiqish tasdiqlanmadi/);
  await assert.rejects(old.port.profile(), e => e.kind === 'auth');
  await turn(); assert.equal(h.runtime.snapshot().flow, null);
});

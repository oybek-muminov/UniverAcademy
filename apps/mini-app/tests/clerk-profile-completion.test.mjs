import './verify-backend-targets.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSignInController, EntryFailure } from '../src/sign-in-controller.ts';
import { createPrebuiltSessionGate } from '../src/clerk-prebuilt-session.ts';
import { createCommonProductionRuntime, readCommonEntryConfig } from '../src/common-production-runtime.ts';
import { STUDENT_CONTRACT_SHA256 } from '../src/owner-client/student-client.ts';
import { fakeClerkSdk } from './fixtures/clerk-sdk.fixture.mjs';
import { startClerkReviewServer } from '../../../runtime/clerk-review-server.mjs';
import { StudentFailure } from '../src/transport.ts';

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const profile = (extra = {}) => ({ person: 'synthetic-person', firstName: 'Server Ism', lastName: 'Server Familiya',
  displayId: '0000000001', registrationComplete: false, ...extra });
function harness(options = {}) {
  const calls = [];
  const initial = profile(options.profile);
  const port = {
    profile: async () => { calls.push(['profile']); return options.read ? options.read() : initial; },
    register: async (first, last) => { calls.push(['register', first, last]); return options.register
      ? options.register(first, last) : { ...initial, firstName: first, lastName: last, registrationComplete: true }; },
    exams: async () => { calls.push(['exams']); return []; },
  };
  const provider = { current: async () => { calls.push(['current']);
    return { proof: 'synthetic-proof', firstName: 'FORGED SDK NAME', lastName: 'FORGED SDK LAST' }; },
    google: async () => ({ proof: 'synthetic-proof' }), sendCode: async () => ({ challenge: 'synthetic-code' }),
    verifyCode: async () => ({ proof: 'synthetic-proof' }), cancel() {},
  };
  const runtime = createSignInController({ context: 'telegram_webview', provider,
    authorize: async () => { calls.push(['authorize']); return options.authorize ? options.authorize() : { person: initial.person, port }; },
    retire: async () => { calls.push(['retire']); return 'none'; },
  });
  return { runtime, calls, initial, port };
}
const writes = h => h.calls.filter(c => c[0] === 'register');

test('both valid SERVER names complete once before authorized empty exams; raw SDK names are ignored', async () => {
  const h = harness(); await h.runtime.continueSession();
  assert.deepEqual(h.calls, [['current'], ['authorize'], ['profile'], ['register', 'Server Ism', 'Server Familiya'], ['exams']]);
  const state = h.runtime.snapshot(); assert.equal(state.step, 'ready');
  assert.equal(state.flow.state.screen, 'exams'); assert.equal(state.flow.state.student.registrationComplete, true);
  assert.deepEqual(state.flow.state.exams, []);
  assert.equal(JSON.stringify(state).includes('FORGED SDK'), false);
});
test('names use the existing manual trim behavior', async () => {
  const h = harness({ profile: { firstName: '  Ali  ', lastName: '  Valiyev  ' } });
  await h.runtime.continueSession(); assert.deepEqual(writes(h), [['register', 'Ali', 'Valiyev']]);
});
test('100 Unicode code points accepted even when longer than100 UTF-16 units', async () => {
  const name = '𐐀'.repeat(100), h = harness({ profile: { firstName: name } });
  assert.equal(name.length, 200); await h.runtime.continueSession();
  assert.equal(writes(h).length, 1); assert.equal(writes(h)[0][1], name);
});
for (const [label, values] of [
  ['first only', { lastName: '' }], ['last only', { firstName: '' }],
  ['neither', { firstName: '', lastName: '' }], ['whitespace', { firstName: ' \t\n' }],
  ['missing', { firstName: undefined }], ['wrong type', { firstName: 17 }],
  ['101 code points', { firstName: '𐐀'.repeat(101) }],
  ['oversized before trim', { firstName: ' ' + 'A'.repeat(99) + ' ' }],
]) {
  test(`incomplete ${label} retains existing profile form, with no PATCH/exams`, async () => {
    const h = harness({ profile: values }); await h.runtime.continueSession();
    const s = h.runtime.snapshot(); assert.equal(s.step, 'ready'); assert.equal(s.flow.state.screen, 'profile');
    assert.deepEqual(s.flow.state.student, h.initial); assert.deepEqual(writes(h), []);
    assert.equal(h.calls.some(c => c[0] === 'exams'), false);
  });
}
test('completed edited profile is preserved without any login write', async () => {
  const h = harness({ profile: { registrationComplete: true, firstName: 'Tahrirlangan', lastName: 'Saqlangan' } });
  await h.runtime.continueSession(); assert.deepEqual(writes(h), []);
  assert.equal(h.runtime.snapshot().flow.state.student.firstName, 'Tahrirlangan');
});
test('repeated Continue joins a pending completion rather than sending another PATCH', async () => {
  const wait = deferred(), h = harness({ register: () => wait.promise });
  const a = h.runtime.continueSession(); await turn();
  assert.equal(h.runtime.snapshot().flow, null); assert.equal(writes(h).length, 1);
  const b = h.runtime.continueSession(); assert.equal(a, b);
  wait.resolve(profile({ registrationComplete: true })); await Promise.all([a, b]);
  await h.runtime.continueSession(); assert.equal(writes(h).length, 1);
});
test('changed person from initial profile is rejected before completion', async () => {
  const h = harness({ read: () => profile({ person: 'other-person' }) }); await h.runtime.continueSession();
  assert.equal(h.runtime.snapshot().flow, null); assert.deepEqual(writes(h), []);
});
for (const [label, result] of [['different person', profile({ person: 'other-person', registrationComplete: true })],
  ['missing result', null], ['not completed', profile()]]) {
  test(`PATCH ${label} never opens cabinet or reads exams`, async () => {
    const h = harness({ register: async () => result }); await h.runtime.continueSession();
    assert.equal(writes(h).length, 1); assert.equal(h.runtime.snapshot().flow, null);
    assert.equal(h.calls.some(c => c[0] === 'exams'), false);
  });
}
for (const failure of [new StudentFailure('server', 'SERVICE_UNAVAILABLE'),
  new StudentFailure('offline', 'UNCONFIRMED', null, true), new EntryFailure('APP_DENIED')]) {
  test(`PATCH ${failure.code} has no cabinet or automatic retry`, async () => {
    const h = harness({ register: async () => { throw failure; } }); await h.runtime.continueSession();
    await turn(); await turn(); assert.equal(h.runtime.snapshot().flow, null); assert.equal(writes(h).length, 1);
    assert.equal(h.calls.some(c => c[0] === 'exams'), false); assert(h.runtime.snapshot().notice);
  });
}
test('reset while profile read is pending prevents completion', async () => {
  const wait = deferred(), h = harness({ read: () => wait.promise });
  const pending = h.runtime.continueSession(); await turn(); await h.runtime.reset();
  wait.resolve(profile()); await pending; assert.equal(writes(h).length, 0); assert.equal(h.runtime.snapshot().flow, null);
});
test('SDK session change during pending completion invalidates the gate and ignores late PATCH', async () => {
  const wait = deferred(), h = harness({ register: () => wait.promise });
  let session = { id: 'sess_FirstSynthetic', status: 'active' };
  const gate = createPrebuiltSessionGate(h.runtime, () => session);
  const pending = gate.enter(); await turn(); assert.equal(writes(h).length, 1);
  session = { id: 'sess_SecondSynthetic', status: 'active' };
  assert.equal(gate.matches(), false); await gate.observe();
  wait.resolve(profile({ registrationComplete: true })); await pending;
  assert.equal(gate.matches(), false); assert.equal(h.runtime.snapshot().flow, null);
  assert.equal(h.calls.some(c => c[0] === 'exams'), false);
});
test('late old PATCH cannot overwrite a fresh ready context', async () => {
  const wait = deferred(); let first = true;
  const h = harness({ register: () => wait.promise, authorize: () => {
    if (first) { first = false; return { person: h.initial.person, port: h.port }; }
    return { person: 'new-person', port: { profile: async () => profile({ person: 'new-person', registrationComplete: true }), exams: async () => [] } };
  } });
  const pending = h.runtime.continueSession(); await turn(); await h.runtime.reset(); await h.runtime.continueSession();
  const current = h.runtime.snapshot().flow; assert.equal(current.state.student.person, 'new-person');
  wait.resolve(profile({ registrationComplete: true })); await pending; assert.equal(h.runtime.snapshot().flow, current);
});

async function httpHarness(t, { failPatch = false } = {}) {
  const server = await startClerkReviewServer(); t.after(() => server.close());
  // Simulated server-returned prefill, not the new Backend prefill implementation.
  const person = server.lab.store.state.domain.student.people[server.lab.ids.person];
  Object.assign(person.profile, { first_name: 'Server Ism', last_name: 'Server Familiya', registration_complete: false });
  server.lab.store.state.domain.student.assignments = {}; // No exam seed required.
  const fixture = fakeClerkSdk({ token: () => server.lab.sign(server.lab.actors.existing) });
  fixture.setSession(fixture.makeSession(server.lab.actors.existing.sessionId));
  const config = readCommonEntryConfig({ VITE_MINI_APP_ORIGIN: 'https://app.example.test', VITE_API_ORIGIN: 'https://api.example.test',
    VITE_STUDENT_CONTRACT_SHA256: STUDENT_CONTRACT_SHA256, VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_' + btoa('clerk.example.test$'),
    VITE_CLERK_FRONTEND_ORIGIN: 'https://clerk.example.test' }, 'https://app.example.test');
  const requests = [];
  const runtime = createCommonProductionRuntime(config, fixture.sdk, 'telegram_webview', request => {
    requests.push(request.clone()); const url = new URL(request.url), target = new URL(server.baseUrl);
    assert.equal(url.origin, 'https://api.example.test'); assert.equal(target.hostname, '127.0.0.1');
    if (failPatch && request.method === 'PATCH') server.lab.store.failCommit = 'before';
    url.protocol = target.protocol; url.host = target.host; return fetch(new Request(url, request));
  });
  const gate = createPrebuiltSessionGate(runtime, fixture.sdk.session); t.after(() => gate.dispose());
  return { runtime, gate, requests };
}
test('production owner path uses one authorized PATCH /me with server names and accepts empty GET /exams', async t => {
  const h = await httpHarness(t); await h.gate.enter();
  assert.equal(h.runtime.snapshot().flow.state.screen, 'exams'); assert.deepEqual(h.runtime.snapshot().flow.state.exams, []);
  assert.deepEqual(h.requests.map(r => [r.method, new URL(r.url).pathname]), [
    ['POST', '/api/v1/auth/clerk'], ['GET', '/api/v1/me'], ['PATCH', '/api/v1/me'], ['GET', '/api/v1/exams'],
  ]);
  assert.deepEqual(await h.requests[2].json(), { first_name: 'Server Ism', last_name: 'Server Familiya' });
  assert.equal(h.requests[2].headers.get('authorization'), h.requests[1].headers.get('authorization'));
  assert.notEqual(h.requests[2].headers.get('authorization'), h.requests[0].headers.get('authorization'));
  assert.equal(h.requests.some(r => /telegram|link/.test(r.url)), false);
});
test('real loopback PATCH503 fails closed and the mutation transport never retries it', async t => {
  const h = await httpHarness(t, { failPatch: true }); await h.gate.enter(); await turn(); await turn();
  assert.equal(h.runtime.snapshot().flow, null);
  assert.equal(h.requests.filter(r => r.method === 'PATCH').length, 1);
  assert.equal(h.requests.some(r => new URL(r.url).pathname === '/api/v1/exams'), false);
});

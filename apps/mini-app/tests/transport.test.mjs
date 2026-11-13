import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationJournal, createStudentTransport, failureMessage, StudentFailure } from '../src/transport.ts';

// Synthetic proof projections only. No live credentials or network requests.
const initial = () => ({ access: 'synthetic-access-a', refresh: 'synthetic-refresh-a', person: 'sample-person', expiresAt: 10000 });
const rotated = () => ({ access: 'synthetic-access-b', refresh: 'synthetic-refresh-b', person: 'sample-person', expiresAt: 20000 });
const ok = data => new Response(JSON.stringify({ data }), { status: 200 });
const error = (status, code, headers) => new Response(JSON.stringify({ error: { code, message: 'untrusted server detail', request_id: 'sample-request' } }), { status, headers });
function setup(fetcher, overrides = {}, now = () => 100) {
  return createStudentTransport({ origin: 'https://mock.invalid/api/v1', fetcher, now,
    sessions: { login: async () => initial(), rotate: async () => rotated(), logout: async () => {}, ...overrides } });
}

test('student proof, no-store, omitted cookies and exact key are used without logging proof', async () => {
  let sent;
  const transport = setup(async (url, init) => { sent = { url, init }; return ok({ example: true }); });
  await transport.login('synthetic launch');
  assert.deepEqual(await transport.request({ method: 'POST', path: '/exams/sample/attempts', key: 'sample-operation-key', body: { confirmed: true } }), { example: true });
  assert.equal(sent.url, 'https://mock.invalid/api/v1/exams/sample/attempts');
  assert.equal(sent.init.headers.Authorization, 'Bearer synthetic-access-a');
  assert.equal(sent.init.headers['Idempotency-Key'], 'sample-operation-key');
  assert.equal(sent.init.cache, 'no-store');
  assert.equal(sent.init.credentials, 'omit');
  assert.equal(sent.init.redirect, 'error');
  assert.equal(sent.init.body, '{"confirmed":true}');
});

test('expired access refreshes once for concurrent requests before any mutation is sent', async () => {
  let count = 0, fetched = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const transport = setup(async () => { fetched++; return ok(null); }, {
    login: async () => ({ ...initial(), expiresAt: 0 }),
    rotate: async () => { count++; await gate; return rotated(); },
  });
  await transport.login('synthetic launch');
  const a = transport.request({ method: 'GET', path: '/me' });
  const b = transport.request({ method: 'GET', path: '/exams' });
  await Promise.resolve();
  assert.equal(count, 1); assert.equal(fetched, 0);
  release(); await Promise.all([a, b]);
  assert.equal(count, 1); assert.equal(fetched, 2);
});

test('a late 401 for an old proof does not rotate the new refresh proof again', async () => {
  let rotations = 0, oldCalls = 0, release;
  const late = new Promise(resolve => { release = resolve; });
  const transport = setup(async (_url, init) => {
    if (init.headers.Authorization === 'Bearer synthetic-access-a') {
      oldCalls++; if (oldCalls === 2) await late;
      return error(401, 'APP_SESSION_EXPIRED');
    }
    return ok(null);
  }, { rotate: async () => { rotations++; return rotated(); } });
  await transport.login('synthetic launch');
  const first = transport.request({ method: 'GET', path: '/me' });
  const second = transport.request({ method: 'GET', path: '/exams' });
  await first; release(); await second;
  assert.equal(rotations, 1);
});

test('401 mutations are never replayed automatically; lost refresh requires a fresh launch', async () => {
  let fetches = 0, rotations = 0;
  const mutation = setup(async () => { fetches++; return error(401, 'APP_SESSION_EXPIRED'); }, { rotate: async () => { rotations++; return rotated(); } });
  await mutation.login('synthetic launch');
  await assert.rejects(mutation.request({ method: 'POST', path: '/attempts/sample/submit', key: 'same-operation-key' }), e => e.kind === 'auth');
  assert.equal(fetches, 1); assert.equal(rotations, 0); assert.equal(mutation.person(), null);
  const lost = setup(async () => ok(null), { login: async () => ({ ...initial(), expiresAt: 0 }), rotate: async () => { rotations++; throw new Error('lost reply'); } });
  await lost.login('synthetic launch');
  await assert.rejects(lost.request({ method: 'GET', path: '/me' }), e => e.code === 'FRESH_LAUNCH_REQUIRED');
  await assert.rejects(lost.request({ method: 'GET', path: '/me' }));
  assert.equal(rotations, 1); assert.equal(lost.person(), null);
});

test('403/404/409/422/429/503 are distinct and do not expose raw server messages or retry', async () => {
  const kinds = [[403, 'FORBIDDEN', 'forbidden'], [404, 'NOT_FOUND', 'missing'], [409, 'REVISION_CONFLICT', 'conflict'], [422, 'INVALID_OPTION', 'validation'], [429, 'RATE_LIMITED', 'limited'], [503, 'SERVICE_UNAVAILABLE', 'temporary']];
  for (const [status, code, kind] of kinds) {
    let calls = 0;
    const transport = setup(async () => { calls++; return error(status, code, { 'Retry-After': '2' }); });
    await transport.login('synthetic launch');
    await assert.rejects(transport.request({ method: 'GET', path: '/me' }), e => {
      assert.equal(e.kind, kind); assert.equal(e.code, code);
      assert.ok(!failureMessage(e).includes('untrusted server detail'));
      assert.equal(e.retryAfterMs, status === 429 ? 2000 : null); return true;
    });
    assert.equal(calls, 1);
  }
});

test('offline mutation and malformed success cannot be acknowledged or silently resent', async () => {
  let calls = 0;
  const transport = setup(async () => { calls++; throw new Error('offline'); });
  await transport.login('synthetic launch');
  await assert.rejects(transport.request({ method: 'PUT', path: '/attempts/sample/answers/sample' }), e => e.kind === 'offline' && e.uncertain);
  assert.equal(calls, 1);
  const malformed = setup(async () => new Response('{"unexpected":true}', { status: 200 }));
  await malformed.login('synthetic launch');
  await assert.rejects(malformed.request({ method: 'GET', path: '/me' }), e => e.kind === 'protocol');
  await assert.rejects(malformed.request({ method: 'GET', path: '//other.invalid' }), e => e.kind === 'protocol');
});

test('lost login is not replayed; a new transport has no persisted proofs', async () => {
  let logins = 0;
  const transport = setup(async () => ok(null), { login: async () => { logins++; throw new Error('lost reply'); } });
  await assert.rejects(transport.login('synthetic launch'), StudentFailure);
  await assert.rejects(transport.request({ method: 'GET', path: '/me' }), StudentFailure);
  assert.equal(logins, 1);
  const reloaded = setup(async () => { throw new Error('must not be called'); });
  assert.equal(reloaded.person(), null);
  await assert.rejects(reloaded.request({ method: 'GET', path: '/me' }), e => e.kind === 'auth');
  await assert.rejects(reloaded.logout(), e => e.code === 'LOGOUT_PROOF_REQUIRED');
});

test('operation keys survive a journal reload and stay scoped to person/assignment/attempt/generation', () => {
  const values = new Map();
  const store = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  const first = createOperationJournal(store);
  const key = first.key('person-a/assignment-a/attempt-a/generation-1/submit');
  const reloaded = createOperationJournal(store);
  assert.equal(reloaded.key('person-a/assignment-a/attempt-a/generation-1/submit'), key);
  assert.notEqual(reloaded.key('person-b/assignment-a/attempt-a/generation-1/submit'), key);
  assert.notEqual(reloaded.key('person-a/assignment-b/attempt-a/generation-1/submit'), key);
  assert.notEqual(reloaded.key('person-a/assignment-a/attempt-a/generation-2/submit'), key);
  reloaded.clear('person-a/assignment-a/attempt-a/generation-1/submit');
  assert.equal(reloaded.peek('person-a/assignment-a/attempt-a/generation-1/submit'), null);
  for (const value of values.values()) assert.match(value, /^[0-9a-f-]{36}$/);
});

test('a pending rotation cannot restore proofs after logout or overwrite a fresh login', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const transport = setup(async () => ok(null), {
    login: async raw => raw === 'new synthetic launch' ? rotated() : ({ ...initial(), expiresAt: 0 }),
    rotate: async () => { await gate; return initial(); },
  });
  await transport.login('synthetic launch');
  const pending = transport.request({ method: 'GET', path: '/me' });
  const rejected = assert.rejects(pending, e => e.kind === 'auth');
  await transport.logout();
  await transport.login('new synthetic launch');
  release(); await rejected;
  assert.equal(transport.person(), 'sample-person');
  assert.equal(await transport.request({ method: 'GET', path: '/me' }), null);
});

// F1: headers have arrived, but the real Response body stream is still pending.
async function bodyReadRace(outcome, transition, method = 'GET') {
  let stream, started;
  const reading = new Promise(resolve => { started = resolve; });
  const response = new Response(new ReadableStream({ start(controller) { stream = controller; } }), { status: outcome.status });
  const readBody = response.json.bind(response);
  response.json = () => { started(); return readBody(); };
  let calls = 0, rotations = 0;
  const headers = [];
  const next = { ...rotated(), person: transition === 'different-person-login' ? 'sample-other-person' : 'sample-person' };
  const transport = setup(async (_url, init) => {
    calls++; headers.push(init.headers.Authorization);
    return calls === 1 ? response : ok({ fresh: true });
  }, {
    login: async raw => raw === 'fresh synthetic launch' ? next : initial(),
    rotate: async () => { rotations++; return rotated(); },
  });
  await transport.login('synthetic launch');
  const pending = transport.request({ method, path: method === 'GET' ? '/me' : '/attempts/sample/submit',
    ...(method === 'POST' ? { key: 'synthetic-operation-key' } : {}) }).then(value => ({ value }), error => ({ error }));
  await reading; // The pre-body epoch check has completed before the session changes.
  if (transition === 'logout-only' || transition === 'logout-and-same-person-login') await transport.logout();
  if (transition !== 'logout-only') await transport.login('fresh synthetic launch');
  stream.enqueue(new TextEncoder().encode(outcome.body)); stream.close();
  const settled = await pending;
  assert.equal(settled.error?.code, 'ACCESS_SUPERSEDED');
  assert.equal(settled.error.kind, 'auth');
  assert.equal(settled.error.uncertain, method !== 'GET');
  assert.equal(Object.hasOwn(settled, 'value'), false);
  assert.equal(calls, 1, 'Old response must not retry with the new proof');
  assert.equal(rotations, 0, 'Old response must not rotate the new session');
  if (transition === 'logout-only') {
    assert.equal(transport.person(), null);
    await assert.rejects(transport.request({ method: 'GET', path: '/me' }), e => e.code === 'FRESH_LAUNCH_REQUIRED');
    assert.equal(calls, 1);
  } else {
    assert.equal(transport.person(), next.person);
    assert.deepEqual(await transport.request({ method: 'GET', path: '/me' }), { fresh: true });
    assert.equal(headers[1], `Bearer ${next.access}`, 'The new proof must remain usable');
    assert.equal(calls, 2);
    assert.equal(rotations, 0);
  }
}

const bodyOutcomes = [
  { name: 'success', status: 200, body: '{"data":{"synthetic_old_payload":true}}' },
  { name: 'revoked 401', status: 401, body: '{"error":{"code":"SESSION_REVOKED"}}' },
  { name: 'expired 401', status: 401, body: '{"error":{"code":"APP_SESSION_EXPIRED"}}' },
  { name: 'JSON parse failure', status: 200, body: '{invalid synthetic JSON' },
];
for (const outcome of bodyOutcomes) {
  for (const transition of ['logout-only', 'same-person-login', 'logout-and-same-person-login']) {
    test(`F1 body-read epoch: ${outcome.name}, ${transition}`, () => bodyReadRace(outcome, transition));
  }
}
test('F1 body-read epoch: success after a different-person login', () => bodyReadRace(bodyOutcomes[0], 'different-person-login'));
test('F1 body-read epoch: malformed 401 body after same-person login', () => bodyReadRace({ name: 'malformed 401', status: 401, body: '{invalid synthetic JSON' }, 'same-person-login'));
for (const outcome of [bodyOutcomes[0], bodyOutcomes[2]]) {
  test(`F1 body-read epoch: mutation ${outcome.name} preserves uncertainty and never retries`, () => bodyReadRace(outcome, 'same-person-login', 'POST'));
}
test('F1 parser failure in the current epoch remains protocol failure without clearing its proof', async () => {
  const transport = setup(async () => new Response('{invalid synthetic JSON', { status: 200 }));
  await transport.login('synthetic launch');
  await assert.rejects(transport.request({ method: 'GET', path: '/me' }), e => e.kind === 'protocol' && e.code === 'RESPONSE_INVARIANT_FAILED');
  assert.equal(transport.person(), 'sample-person');
});

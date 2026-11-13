import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Strict child processes detect orphan rejections without any global handler.
// All hooks/proofs are synthetic;120000ms remains an injected review parameter.
const source = new URL('../src/transport.ts', import.meta.url).href;
const cases = ['auth-policy', 'offline-no-policy', 'validation-policy', 'malformed-policy',
  'auth-no-policy', 'offline-with-policy', 'limited-policy', 'retry-sync-auth',
  'cancel-inline', 'relogin-inline', 'deadline-inline', 'ack', 'async-auth', 'thenable-error'];

for (const mode of cases) {
  test(`receipt synchronous boundary: ${mode} leaves no orphan rejection or abort listener`, () => {
    const script = `
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createStudentTransport, StudentFailure } from ${JSON.stringify(source)};
const mode = ${JSON.stringify(mode)};
let transport, signal, calls = 0, rotations = 0, fetches = 0, clock = 0, freshLogin;
const proofs = [];
function hook(refresh, currentSignal) {
  calls++; proofs.push(refresh); signal = currentSignal;
  if (mode === 'ack') return Promise.resolve();
  if (mode === 'async-auth') return Promise.reject(new StudentFailure('auth', 'REFRESH_INVALID'));
  if (mode === 'auth-policy' || mode === 'auth-no-policy') throw new StudentFailure('auth', 'REFRESH_INVALID');
  if (mode === 'validation-policy') throw new StudentFailure('validation', 'VALIDATION_ERROR');
  if (mode === 'malformed-policy') throw new StudentFailure('protocol', 'MALFORMED_JSON');
  if (mode === 'limited-policy') {
    if (calls === 1) throw new StudentFailure('limited', 'RATE_LIMITED', 2000);
    return Promise.resolve();
  }
  if (mode === 'retry-sync-auth' && calls === 2) throw new StudentFailure('auth', 'REFRESH_INVALID');
  if (mode === 'cancel-inline') transport.cancelLogoutReceipt(transport.logoutReceipt().operationId);
  if (mode === 'relogin-inline') freshLogin = transport.login('fresh');
  if (mode === 'deadline-inline') { clock = 120000; transport.logoutReceipt(); }
  if (mode === 'thenable-error') return Object.defineProperty({}, 'then', { get() { throw new Error('Synthetic then getter failure'); } });
  throw new Error('Synthetic synchronous offline failure');
}
const noPolicy = mode.endsWith('no-policy');
transport = createStudentTransport({
  origin: 'https://mock.invalid/api/v1', now: () => 1,
  ...(!noPolicy ? { logoutReceiptPolicy: { retentionMs: 120000, monotonicNow: () => clock } } : {}),
  fetcher: async () => { fetches++; throw new Error('Must not fetch'); },
  sessions: {
    login: async raw => ({ access: 'synthetic-access-' + raw, refresh: 'synthetic-refresh-' + raw, person: raw, expiresAt: 1000 }),
    rotate: async () => { rotations++; throw new Error('Must not refresh'); },
    logout: hook,
  },
});
await transport.login('first');
const pending = transport.logout();
assert.equal(calls, 1, 'Hook invocation remains eager');
if (mode === 'ack') {
  await pending;
  assert.equal(transport.logoutReceipt().state, 'confirmed');
} else {
  const error = await pending.catch(error => error);
  assert.ok(error instanceof StudentFailure);
  assert.equal(error.uncertain, true);
  const expected = mode === 'cancel-inline' || mode === 'relogin-inline' ? 'LOGOUT_RECEIPT_SUPERSEDED'
    : mode === 'deadline-inline' ? 'LOGOUT_RECEIPT_EXPIRED'
    : mode === 'validation-policy' ? 'VALIDATION_ERROR'
    : mode === 'malformed-policy' ? 'MALFORMED_JSON'
    : mode === 'limited-policy' ? 'RATE_LIMITED'
    : mode.startsWith('auth-') || mode === 'async-auth' ? 'REFRESH_INVALID' : 'UNCONFIRMED';
  assert.equal(error.code, expected);
  assert.equal(error.kind, expected.startsWith('LOGOUT_RECEIPT_') || expected === 'MALFORMED_JSON' ? 'protocol'
    : expected === 'REFRESH_INVALID' ? 'auth' : expected === 'VALIDATION_ERROR' ? 'validation'
    : expected === 'RATE_LIMITED' ? 'limited' : 'offline');
  assert.equal(getEventListeners(signal, 'abort').length, 0, 'Abort listener is removed before caller observes failure');
  const operation = transport.logoutReceipt();
  if (mode === 'limited-policy') {
    assert.equal(operation.state, 'uncertain');
    await assert.rejects(transport.retryLogoutReceipt(operation.operationId), error => error.code === 'RATE_LIMITED' && error.retryAfterMs === 2000);
    assert.equal(calls, 1);
    clock = 2000;
    await transport.retryLogoutReceipt(operation.operationId);
    assert.equal(transport.logoutReceipt().operationId, operation.operationId);
    assert.equal(transport.logoutReceipt().state, 'confirmed');
    assert.deepEqual(proofs, ['synthetic-refresh-first', 'synthetic-refresh-first']);
  } else if (mode === 'retry-sync-auth') {
    assert.equal(operation.state, 'uncertain');
    await assert.rejects(transport.retryLogoutReceipt(operation.operationId), error => error.code === 'REFRESH_INVALID' && error.uncertain);
    assert.equal(transport.logoutReceipt().operationId, operation.operationId);
    assert.equal(transport.logoutReceipt().state, 'unavailable');
    assert.deepEqual(proofs, ['synthetic-refresh-first', 'synthetic-refresh-first']);
  } else if (['offline-with-policy', 'thenable-error'].includes(mode)) {
    assert.equal(operation.state, 'uncertain');
    assert.equal(calls, 1, 'No automatic replay');
    transport.cancelLogoutReceipt(operation.operationId);
  } else if (mode === 'cancel-inline' || mode === 'relogin-inline') {
    assert.equal(operation.state, 'cancelled');
  } else if (mode === 'deadline-inline') {
    assert.equal(operation.state, 'expired');
  } else {
    assert.equal(operation.state, 'unavailable');
    await assert.rejects(transport.retryLogoutReceipt(operation.operationId), error => error.code === 'LOGOUT_RECEIPT_UNAVAILABLE');
    assert.equal(calls, 1);
  }
}
if (freshLogin) await freshLogin;
assert.equal(transport.person(), mode === 'relogin-inline' ? 'fresh' : null);
assert.equal(getEventListeners(signal, 'abort').length, 0);
assert.equal(signal.aborted, !['ack', 'limited-policy'].includes(mode));
assert.equal(rotations, 0);
assert.equal(fetches, 0);
await new Promise(resolve => setImmediate(resolve));
console.log('NO_ORPHAN_REJECTION_OR_ABORT_LISTENER');
`;
    const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, JSON.stringify({ mode, status: child.status, signal: child.signal,
      stdout: child.stdout, stderr: child.stderr, error: child.error?.message }));
    assert.match(child.stdout, /NO_ORPHAN_REJECTION_OR_ABORT_LISTENER/);
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudentTransport, StudentFailure } from '../src/transport.ts';

// Synthetic hooks only. 120000ms is an explicit review candidate, not a default.
function setup(logout, policy = { retentionMs: 120000, monotonicNow: () => 0 }) {
  let rotations = 0, fetches = 0;
  const seen = [];
  const transport = createStudentTransport({ origin: 'https://mock.invalid/api/v1', now: () => 1,
    ...(policy ? { logoutReceiptPolicy: policy } : {}),
    fetcher: async (_url, init) => { fetches++; seen.push(init.headers.Authorization); return new Response('{"data":{"fresh":true}}'); },
    sessions: {
      login: async raw => ({ access: 'synthetic-access-' + raw, refresh: 'synthetic-refresh-' + raw, person: raw.startsWith('same') ? 'synthetic-same-person' : raw, expiresAt: 0 }),
      rotate: async () => { rotations++; return { access: 'synthetic-next-access', refresh: 'synthetic-next-refresh', person: transport.person(), expiresAt: 1000 }; },
      logout,
    },
  });
  return { transport, counts: () => ({ rotations, fetches }), seen };
}
function gate() {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  return { pending, release };
}
const unavailable = e => e.code === 'LOGOUT_RECEIPT_UNAVAILABLE';
const superseded = e => e.code === 'LOGOUT_RECEIPT_SUPERSEDED' && e.uncertain;

test('receipt accepts its own post-clear ACK and gives the hook only original refresh proof', async () => {
  const received = [];
  const { transport, counts } = setup(async (...args) => { received.push(args); });
  await transport.login('same-first');
  await transport.logout();
  assert.equal(transport.person(), null);
  assert.equal(transport.logoutReceipt().state, 'confirmed');
  assert.deepEqual(counts(), { rotations: 0, fetches: 0 });
  assert.equal(received[0].length, 2);
  assert.equal(received[0][0], 'synthetic-refresh-same-first');
  assert.ok(received[0][1] instanceof AbortSignal);
  assert.ok(!JSON.stringify(transport.logoutReceipt()).includes('synthetic-refresh'));
});

test('receipt retries are explicit and keep the original operation and proof', async () => {
  const proofs = [];
  const { transport, counts } = setup(async proof => { proofs.push(proof); if (proofs.length === 1) throw new Error('synthetic lost response'); });
  await transport.login('first');
  await assert.rejects(transport.logout(), e => e.code === 'UNCONFIRMED' && e.uncertain);
  const operation = transport.logoutReceipt();
  assert.equal(operation.state, 'uncertain');
  assert.equal(proofs.length, 1); // No automatic mutation replay.
  await assert.rejects(transport.retryLogoutReceipt('unrelated-operation'), unavailable);
  await transport.retryLogoutReceipt(operation.operationId);
  assert.equal(transport.logoutReceipt().operationId, operation.operationId);
  assert.equal(transport.logoutReceipt().state, 'confirmed');
  assert.deepEqual(proofs, ['synthetic-refresh-first', 'synthetic-refresh-first']);
  assert.deepEqual(counts(), { rotations: 0, fetches: 0 });
  await transport.retryLogoutReceipt(operation.operationId);
  assert.equal(proofs.length, 2); // A confirmed local operation sends nothing again.
});

test('only the same receipt operation is single-flight; repeated logout does not clear twice', async () => {
  const deferred = gate(); let calls = 0;
  const { transport } = setup(async () => { calls++; await deferred.pending; });
  await transport.login('first');
  const first = transport.logout(); const op = transport.logoutReceipt();
  const retry = transport.retryLogoutReceipt(op.operationId); const duplicate = transport.logout();
  assert.equal(calls, 1);
  deferred.release(); await Promise.all([first, retry, duplicate]);
  assert.equal(transport.logoutReceipt().state, 'confirmed');
});

test('receipt retry never extends its first-clear deadline, including equality', async () => {
  let now = 0, calls = 0;
  const { transport } = setup(async () => { calls++; throw new Error('synthetic offline'); }, { retentionMs: 120000, monotonicNow: () => now });
  await transport.login('first'); await assert.rejects(transport.logout());
  const { operationId } = transport.logoutReceipt();
  now = 119999; await assert.rejects(transport.retryLogoutReceipt(operationId), e => e.code === 'UNCONFIRMED');
  now = 120000; await assert.rejects(transport.retryLogoutReceipt(operationId), e => e.code === 'LOGOUT_RECEIPT_EXPIRED' && e.uncertain);
  assert.equal(transport.logoutReceipt().state, 'expired'); assert.equal(calls, 2);
});

test('receipt deadline aborts an unresponsive hook and releases the retry capability', async () => {
  let signal;
  const { transport } = setup(async (_proof, s) => { signal = s; await new Promise(() => {}); }, { retentionMs: 20 });
  await transport.login('first');
  await assert.rejects(transport.logout(), e => e.code === 'LOGOUT_RECEIPT_EXPIRED' && e.uncertain);
  assert.equal(signal.aborted, true);
  await assert.rejects(transport.retryLogoutReceipt(transport.logoutReceipt().operationId), e => e.code === 'LOGOUT_RECEIPT_EXPIRED');
});

for (const outcome of ['success', '401', 'parse-error']) {
  for (const next of ['same-second', 'different-person']) {
    test(`late receipt ${outcome} cannot touch a fresh ${next} login`, async () => {
      const deferred = gate(); let signal;
      const { transport, counts, seen } = setup(async (_proof, s) => {
        signal = s; await deferred.pending;
        if (outcome === '401') throw new StudentFailure('auth', 'SESSION_REVOKED');
        if (outcome === 'parse-error') throw new SyntaxError('synthetic malformed body');
      });
      await transport.login('same-first');
      const old = transport.logout(); const rejected = assert.rejects(old, superseded);
      await transport.login(next);
      assert.equal(signal.aborted, true);
      deferred.release(); await rejected;
      assert.equal(transport.person(), next === 'same-second' ? 'synthetic-same-person' : next);
      assert.equal(transport.logoutReceipt().state, 'cancelled');
      // Expired test access rotates only for this fresh explicit request, never for receipt.
      assert.deepEqual(counts(), { rotations: 0, fetches: 0 });
      assert.deepEqual(await transport.request({ method: 'GET', path: '/me' }), { fresh: true });
      assert.deepEqual(seen, ['Bearer synthetic-next-access']);
    });
  }
}

test('terminal receipt proof errors stop retention and never trigger refresh or replay', async () => {
  for (const [kind, code] of [['auth', 'REFRESH_EXPIRED'], ['auth', 'REFRESH_INVALID'], ['forbidden', 'FORBIDDEN'], ['validation', 'VALIDATION_ERROR'], ['protocol', 'MALFORMED_JSON']]) {
    let calls = 0;
    const { transport, counts } = setup(async () => { calls++; throw new StudentFailure(kind, code); });
    await transport.login('first'); await assert.rejects(transport.logout(), e => e.code === code && e.uncertain);
    assert.equal(transport.logoutReceipt().state, 'unavailable');
    await assert.rejects(transport.retryLogoutReceipt(transport.logoutReceipt().operationId), unavailable);
    assert.equal(calls, 1); assert.deepEqual(counts(), { rotations: 0, fetches: 0 });
  }
});

test('receipt 429 honors Retry-After for explicit retry without moving its deadline', async () => {
  let now = 0, calls = 0;
  const { transport } = setup(async () => { calls++; throw new StudentFailure('limited', 'RATE_LIMITED', 2000); }, { retentionMs: 3000, monotonicNow: () => now });
  await transport.login('first'); await assert.rejects(transport.logout());
  const { operationId } = transport.logoutReceipt();
  now = 1000; await assert.rejects(transport.retryLogoutReceipt(operationId), e => e.code === 'RATE_LIMITED' && e.retryAfterMs === 1000);
  assert.equal(calls, 1);
  now = 2000; await assert.rejects(transport.retryLogoutReceipt(operationId), e => e.code === 'RATE_LIMITED');
  assert.equal(calls, 2);
  now = 3000; await assert.rejects(transport.retryLogoutReceipt(operationId), e => e.code === 'LOGOUT_RECEIPT_EXPIRED');
});

test('explicit cancel aborts the operation and makes its proof unavailable', async () => {
  const deferred = gate(); let signal, calls = 0;
  const { transport } = setup(async (_proof, s) => { calls++; signal = s; await deferred.pending; });
  await transport.login('first'); const pending = transport.logout();
  const rejected = assert.rejects(pending, superseded); const { operationId } = transport.logoutReceipt();
  transport.cancelLogoutReceipt(operationId); deferred.release(); await rejected;
  assert.equal(signal.aborted, true);
  await assert.rejects(transport.retryLogoutReceipt(operationId), superseded); assert.equal(calls, 1);
});

test('an old logout completion cannot confirm or discard the newer logout operation', async () => {
  const oldGate = gate(), newGate = gate(); let calls = 0;
  const { transport } = setup(async () => { calls++; await (calls === 1 ? oldGate.pending : newGate.pending); });
  await transport.login('same-first');
  const first = transport.logout(); const firstRejected = assert.rejects(first, superseded);
  const firstId = transport.logoutReceipt().operationId;
  await transport.login('same-second');
  const second = transport.logout(); const secondOp = transport.logoutReceipt();
  assert.notEqual(secondOp.operationId, firstId);
  oldGate.release(); await firstRejected;
  assert.deepEqual(transport.logoutReceipt(), secondOp);
  newGate.release(); await second;
  assert.deepEqual(transport.logoutReceipt(), { operationId: secondOp.operationId, state: 'confirmed' });
});

test('reload has no receipt proof; omitted policy enables no retained-proof retry', async () => {
  let calls = 0;
  const { transport } = setup(async () => { calls++; throw new Error('synthetic lost response'); }, null);
  await transport.login('first'); await assert.rejects(transport.logout());
  assert.equal(transport.logoutReceipt().state, 'unavailable');
  await assert.rejects(transport.retryLogoutReceipt(transport.logoutReceipt().operationId), unavailable);
  const reloaded = setup(async () => { throw new Error('must not send'); }).transport;
  assert.equal(reloaded.logoutReceipt(), null);
  await assert.rejects(reloaded.retryLogoutReceipt('old-operation'), unavailable); assert.equal(calls, 1);
});

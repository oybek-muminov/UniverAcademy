import './verify-backend-targets.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startClerkReviewServer } from '../../../runtime/clerk-review-server.mjs';
import { STUDENT_CONTRACT_SHA256 } from '../src/owner-client/student-client.ts';
import { readCommonEntryConfig, createCommonProductionRuntime } from '../src/common-production-runtime.ts';
import { createPrebuiltSessionGate } from '../src/clerk-prebuilt-session.ts';
import { fakeClerkSdk } from './fixtures/clerk-sdk.fixture.mjs';

const wait = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
const turn = () => new Promise(r => setImmediate(r));
async function harness(t, options = {}) {
  const server = await startClerkReviewServer(); t.after(() => server.close());
  const fixture = fakeClerkSdk({ token: async () => server.lab.sign(), ...options.sdk });
  const config = readCommonEntryConfig({ VITE_MINI_APP_ORIGIN: 'https://app.example.test', VITE_API_ORIGIN: 'https://api.example.test',
    VITE_STUDENT_CONTRACT_SHA256: STUDENT_CONTRACT_SHA256, VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_' + btoa('clerk.example.test$'),
    VITE_CLERK_FRONTEND_ORIGIN: 'https://clerk.example.test' }, 'https://app.example.test');
  const calls = [];
  const runtime = createCommonProductionRuntime(config, fixture.sdk, 'browser', async request => {
    calls.push(request.clone());
    const url = new URL(request.url), base = new URL(server.baseUrl); url.protocol = base.protocol; url.host = base.host;
    const send = () => fetch(new Request(url, request));
    return options.send ? options.send(request, send) : send();
  });
  const gate = createPrebuiltSessionGate(runtime, fixture.sdk.session);
  t.after(() => gate.dispose());
  const session = id => fixture.setSession(fixture.makeSession(id));
  return { ...fixture, runtime, gate, calls, session };
}
test('prebuilt: cached SDK session waits for explicit Continue and fresh Backend exchange', async t => {
  const h = await harness(t); h.session('sess_Cached');
  assert.equal(h.gate.matches(), false); assert.equal(h.gate.observe(), null); await turn();
  assert.equal(h.calls.length, 0); assert.equal(h.runtime.snapshot().flow, null);
  await h.gate.enter(); assert(h.gate.matches()); assert.equal(h.runtime.snapshot().flow.signInMethod, 'clerk');
  assert.equal(h.calls.filter(r => r.url.endsWith('/auth/clerk')).length, 1);
  assert.deepEqual(h.calls[0].method, 'POST');
});
test('prebuilt: missing, pending and task-bound SDK sessions cannot exchange', async t => {
  const h = await harness(t);
  for (const value of [null, { ...h.makeSession('sess_Pending'), status: 'pending' }, { ...h.makeSession('sess_Task'), currentTask: { key: 'synthetic-task' } }]) {
    h.setSession(value); await h.gate.enter(); assert.equal(h.gate.matches(), false);
  }
  assert.equal(h.calls.length, 0); assert.equal(h.runtime.snapshot().flow, null);
});
test('prebuilt: SDK context changes hide ready data before observer and require explicit new entry', async t => {
  const h = await harness(t); h.session('sess_First'); await h.gate.enter();
  const old = h.runtime.snapshot().flow; h.session('sess_Second'); assert.equal(h.gate.matches(), false);
  await h.gate.observe(); assert.equal(h.runtime.snapshot().flow, null); assert.equal(h.sdk.session().id, 'sess_Second');
  const count = h.calls.length; await turn(); assert.equal(h.calls.length, count);
  await assert.rejects(old.port.profile(), e => e.kind === 'auth');
  await h.gate.enter(); assert(h.gate.matches()); assert.notEqual(h.runtime.snapshot().flow, old);
  assert.deepEqual(h.calls.filter(r => r.url.endsWith('/auth/clerk')).length, 2);
});
test('prebuilt: Continue before observer cannot relabel an old ready app flow as a new SDK session', async t => {
  const h = await harness(t); h.session('sess_First'); await h.gate.enter(); const old = h.runtime.snapshot().flow;
  h.session('sess_Second'); await h.gate.enter();
  assert(h.gate.matches()); assert.notEqual(h.runtime.snapshot().flow, old);
  assert.equal(h.calls.filter(r => r.url.endsWith('/auth/clerk')).length, 2);
  assert.deepEqual(h.calls.filter(r => r.url.endsWith('/auth/logout')).length, 1);
  assert.equal(h.sdk.session().id, 'sess_Second');
});
test('prebuilt: delayed old exchange body after SDK replacement cannot reopen the app', async t => {
  const reading = wait(), release = wait(); let first = true;
  const h = await harness(t, { send: async (request, send) => {
    const response = await send(); if (first && request.url.endsWith('/auth/clerk')) {
      first = false; const json = response.json.bind(response);
      response.json = async () => { const value = await json(); reading.release(); await release.promise; return value; };
    } return response;
  } });
  h.session('sess_First'); const old = h.gate.enter(); await reading.promise;
  h.session('sess_Second'); const cleanup = h.gate.observe(); release.release(); await Promise.all([old, cleanup]);
  assert.equal(h.runtime.snapshot().flow, null); assert.equal(h.sdk.session().id, 'sess_Second');
  assert.equal(h.calls.filter(r => r.url.endsWith('/me')).length, 0);
  await h.gate.enter(); assert(h.gate.matches()); assert.equal(h.runtime.snapshot().step, 'ready');
});
test('prebuilt: own SDK signout observer does not supersede captured app logout ACK', async t => {
  const h = await harness(t); h.session('sess_Own'); await h.gate.enter();
  const off = h.runtime.subscribe(() => { if (!h.sdk.session()) h.gate.observe(); });
  await h.gate.logout(); off();
  assert.equal(h.gate.observe(), null); assert.equal(h.runtime.snapshot().flow, null); assert.equal(h.sdk.session(), null);
  assert.equal(h.runtime.snapshot().notice, 'Server sessiya yopilganini tasdiqladi.');
  const request = h.calls.find(r => r.url.endsWith('/auth/logout'));
  assert(!request.headers.has('authorization')); assert.deepEqual(Object.keys(await request.json()), ['refresh_token']);
});
test('prebuilt: reset clears immediately but its cleanup promise waits for targeted SDK signout', async t => {
  const release = wait(), started = wait();
  const h = await harness(t, { sdk: { signOut: async () => { started.release(); await release.promise; } } });
  h.session('sess_First'); await h.gate.enter(); const cleanup = h.gate.reset();
  assert.equal(h.runtime.snapshot().flow, null); assert.equal(h.gate.matches(), false);
  let settled = false; cleanup.then(() => { settled = true; }); await started.promise; await turn(); assert.equal(settled, false);
  h.session('sess_Second'); release.release(); await cleanup;
  assert.equal(h.sdk.session().id, 'sess_Second'); assert.equal(h.gate.matches(), false);
  await h.gate.enter(); assert(h.gate.matches());
});
test('prebuilt: SDK revocation clears app context and late old data never changes a new login', async t => {
  const h = await harness(t); h.session('sess_First'); await h.gate.enter();
  h.setSession(null); assert.equal(h.gate.matches(), false); await h.gate.observe(); assert.equal(h.runtime.snapshot().flow, null);
  h.session('sess_New'); assert.equal(h.gate.observe(), null); assert.equal(h.runtime.snapshot().flow, null);
  await h.gate.enter(); assert(h.gate.matches());
});

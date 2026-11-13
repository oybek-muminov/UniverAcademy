import test from 'node:test';
import assert from 'node:assert/strict';
import { createClerkSdkAdapter } from '../src/clerk-sdk-adapter.ts';
import { fakeClerkSdk } from './fixtures/clerk-sdk.fixture.mjs';
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

test('SDK email OTP uses public Future API, privacy-preserving signup transfer and a fresh default JWT', async () => {
  const h = fakeClerkSdk(), provider = createClerkSdkAdapter(h.sdk);
  const sent = await provider.sendCode('student@example.test'); const proof = await provider.verifyCode(sent.challenge, '123456');
  assert(proof.proof.startsWith('synthetic-sdk-proof-'));
  assert.deepEqual(h.calls.find(c => c[0] === 'signIn.create')[1], { identifier: 'student@example.test', signUpIfMissing: true });
  assert.deepEqual(h.calls.find(c => c[0] === 'verifyCode')[1], { code: '123456' });
  assert.deepEqual(h.calls.find(c => c[0] === 'getToken')[1], { skipCache: true });
});
test('verified missing account transfers to signup only after Clerk explicitly requests it', async () => {
  const h = fakeClerkSdk({ verify: async () => ({ error: { errors: [{ code: 'sign_up_if_missing_transfer' }] } }) });
  const p = createClerkSdkAdapter(h.sdk), sent = await p.sendCode('new@example.test'); await p.verifyCode(sent.challenge, '123456');
  assert.deepEqual(h.calls.find(c => c[0] === 'signUp.create')[1], { transfer: true });
  assert(h.calls.some(c => c[0] === 'signUp.finalize'));
});
test('wrong code is sanitized and remains retryable on its current challenge', async () => {
  let wrong = true; const h = fakeClerkSdk({ verify: async () => {
    if (wrong) return { error: { errors: [{ code: 'form_code_incorrect', longMessage: 'PRIVATE_PROVIDER_TEXT' }] } };
    h.sdk.signIn.status = 'complete'; h.sdk.signIn.createdSessionId = 'sess_Correct'; return { error: null };
  } });
  const p = createClerkSdkAdapter(h.sdk), sent = await p.sendCode('student@example.test');
  await assert.rejects(p.verifyCode(sent.challenge, '000000'), e => e.code === 'INVALID_CODE' && !e.message.includes('PRIVATE'));
  wrong = false; await p.verifyCode(sent.challenge, '123456');
});
test('missing or stale challenge never reaches the SDK verification', async () => {
  const h = fakeClerkSdk(), p = createClerkSdkAdapter(h.sdk);
  await assert.rejects(p.verifyCode('missing', '123456'), e => e.code === 'CODE_EXPIRED');
  const sent = await p.sendCode('student@example.test'); p.cancel();
  await assert.rejects(p.verifyCode(sent.challenge, '123456'), e => e.code === 'CODE_EXPIRED');
  assert(!h.calls.some(c => c[0] === 'verifyCode'));
});
test('Google opens only a user-gesture popup and passes fixed same-origin callback URLs', async () => {
  const h = fakeClerkSdk(), p = createClerkSdkAdapter(h.sdk); const pending = p.google();
  assert.equal(h.calls[0][0], 'popup.open'); await pending;
  assert.deepEqual(h.calls.find(c => c[0] === 'sso')[1], { strategy: 'oauth_google', redirectUrl: h.sdk.callbackUrl, redirectCallbackUrl: h.sdk.callbackUrl });
});
test('popup block never attempts OAuth or returns evidence', async () => {
  const h = fakeClerkSdk({ popupBlocked: true }), p = createClerkSdkAdapter(h.sdk);
  await assert.rejects(p.google(), e => e.code === 'POPUP_BLOCKED'); assert.equal(h.calls.length, 1);
});
test('a verified transferable Google account signs up through the public transfer API', async () => {
  const h = fakeClerkSdk({ sso: async () => { h.sdk.signIn.isTransferable = true; return { error: null }; } });
  await createClerkSdkAdapter(h.sdk).google();
  assert.deepEqual(h.calls.find(c => c[0] === 'signUp.create')[1], { transfer: true });
  assert(h.calls.some(c => c[0] === 'signUp.finalize'));
});
test('cancelled SDK send cannot mutate a new auth attempt; SDK single-flight ends before explicit re-entry', async () => {
  const wait = gate(); let first = true;
  const h = fakeClerkSdk({ send: async () => { if (first) { first = false; await wait.promise; } return { error: null }; } });
  const p = createClerkSdkAdapter(h.sdk), old = p.sendCode('old@example.test').catch(e => e);
  await turn(); p.cancel();
  await assert.rejects(p.sendCode('new@example.test'), e => e.code === 'AUTH_CLEANUP_PENDING');
  wait.release(); assert.equal((await old).code, 'CANCELLED');
  const sent = await p.sendCode('new@example.test'); await p.verifyCode(sent.challenge, '123456');
});
test('late finalize after cancel is quarantined and signs out only its captured session before new SDK auth', async () => {
  const wait = gate(); let first = true;
  const h = fakeClerkSdk({ finalize: async (kind, input, activate) => {
    if (first) { first = false; const id = h.sdk[kind].createdSessionId; await wait.promise; activate(id); return { error: null }; }
    const id = h.sdk[kind].createdSessionId; activate(id); return { error: null };
  } });
  const p = createClerkSdkAdapter(h.sdk), sent = await p.sendCode('old@example.test');
  const old = p.verifyCode(sent.challenge, '123456').catch(e => e); await turn(); p.cancel();
  await assert.rejects(p.sendCode('new@example.test'), e => e.code === 'AUTH_CLEANUP_PENDING');
  wait.release(); assert.equal((await old).code, 'CANCELLED');
  assert.deepEqual(h.calls.filter(c => c[0] === 'signOut'), [['signOut', h.sdk.signIn.createdSessionId]]);
  const next = await p.sendCode('new@example.test'); await p.verifyCode(next.challenge, '123456'); assert(h.sdk.session());
});
test('cancel cleanup never signs out an unrelated SDK session activated outside the captured operation', async () => {
  const wait = gate();
  const h = fakeClerkSdk({ finalize: async () => { await wait.promise; return { error: null }; } });
  const p = createClerkSdkAdapter(h.sdk); const old = p.google().catch(e => e); await turn();
  p.cancel(); h.setSession(h.makeSession('sess_IndependentNewLogin')); wait.release();
  assert.equal((await old).code, 'CANCELLED'); assert.equal(h.sdk.session().id, 'sess_IndependentNewLogin');
  assert.deepEqual(h.calls.filter(c => c[0] === 'signOut'), []);
});
test('logout captures a specific session, waits for app receipt and never uses global SDK signout', async () => {
  const app = gate(), out = gate(); const h = fakeClerkSdk({ signOut: () => out.promise });
  const p = createClerkSdkAdapter(h.sdk); await p.google(); const id = h.sdk.session().id;
  p.cancel(); const logout = p.signOut(app.promise); await turn(); assert(!h.calls.some(c => c[0] === 'signOut'));
  app.release(); await turn(); assert.deepEqual(h.calls.find(c => c[0] === 'signOut'), ['signOut', id]);
  await assert.rejects(p.google(), e => e.code === 'AUTH_CLEANUP_PENDING'); out.release(); await logout;
  await p.google(); assert.notEqual(h.sdk.session().id, id);
});
test('failed app receipt still requests targeted provider signout without implying app ACK', async () => {
  const h = fakeClerkSdk(), p = createClerkSdkAdapter(h.sdk); await p.google(); p.cancel();
  const denied = Promise.reject(new Error('app uncertain')); await p.signOut(denied);
  assert.equal(h.sdk.session(), null); assert.equal(h.calls.filter(c => c[0] === 'signOut').length, 1);
});
for (const status of ['needs_second_factor', 'needs_client_trust', 'needs_protect_check'])
  test(`SDK ${status} never becomes app evidence`, async () => {
    const h = fakeClerkSdk({ verify: async () => { h.sdk.signIn.status = status; return { error: null }; } });
    const p = createClerkSdkAdapter(h.sdk), sent = await p.sendCode('student@example.test');
    await assert.rejects(p.verifyCode(sent.challenge, '123456'), e => e.code === 'VERIFICATION_REQUIRED');
    assert(!h.calls.some(c => c[0] === 'getToken'));
  });
test('session tasks and session changes during JWT fetch deny evidence', async () => {
  const wait = gate(), h = fakeClerkSdk({ token: () => wait.promise }), p = createClerkSdkAdapter(h.sdk);
  h.setSession({ ...h.makeSession('sess_Task'), currentTask: { key: 'synthetic-task' } });
  await assert.rejects(p.current(), e => e.code === 'VERIFICATION_REQUIRED');
  h.setSession(h.makeSession('sess_First')); const pending = p.current(); await turn();
  h.setSession(h.makeSession('sess_Other')); wait.release('synthetic-old-proof');
  await assert.rejects(pending, e => e.code === 'VERIFICATION_REQUIRED');
});

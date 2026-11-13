import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommonEntryPrototype, EntryDemoFailure } from '../src/common-entry-prototype.ts';
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
function harness(options = {}) {
  const calls = [], profile = { person: 'synthetic-person', firstName: 'Suniy', lastName: 'Kirish', displayId: '0000000001', registrationComplete: true };
  let challengeNo = 0;
  const port = { profile: async () => { calls.push('profile'); return options.profile ?? profile; },
    exams: async () => { calls.push('exams'); return []; }, register: async () => profile,
    current: async () => null, start: async () => { throw new Error('NO_TEST_STARTED'); },
    save: async () => { throw new Error('NO_TEST_STARTED'); }, submit: async () => {}, result: async () => null, history: async () => [] };
  const provider = {
    google: async () => { calls.push('google'); return options.google ? options.google() : { proof: 'synthetic-provider-proof' }; },
    sendCode: async email => { calls.push(['send', email]); return options.sendCode ? options.sendCode(email) : { challenge: 'synthetic-challenge-' + ++challengeNo }; },
    verifyCode: async (challenge, code) => { calls.push(['verify', challenge, code]); return options.verifyCode ? options.verifyCode(challenge, code) : { proof: 'synthetic-provider-proof' }; },
  };
  const runtime = createCommonEntryPrototype({ mode: 'synthetic', context: options.context ?? 'browser', provider,
    authorize: async evidence => {
      calls.push('authorize');
      if (options.authorize) return options.authorize(evidence);
      assert.equal(evidence.proof, 'synthetic-provider-proof'); return { person: 'synthetic-person', port };
    } });
  return { runtime, calls, port };
}
test('prototype mode is explicit; no provider or HTTP contract is inferred', () => {
  assert.throws(() => createCommonEntryPrototype({ mode: 'production' }), error => error.code === 'SYNTHETIC_MODE_REQUIRED');
});
test('Google evidence must pass separate app authorization/profile before a student flow appears', async () => {
  const h = harness(); await h.runtime.google();
  assert.deepEqual(h.calls, ['google', 'authorize', 'profile', 'exams']);
  assert.equal(h.runtime.snapshot().step, 'ready'); assert.equal(h.runtime.snapshot().flow.state.screen, 'exams');
});
test('provider completion while app authorization is pending does not reveal a flow', async () => {
  const wait = gate(); const h = harness({ authorize: () => wait.promise });
  const pending = h.runtime.google(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.runtime.snapshot().step, 'authorizing'); assert.equal(h.runtime.snapshot().flow, null);
  wait.release({ person: 'synthetic-person', port: h.port }); await pending; assert.equal(h.runtime.snapshot().step, 'ready');
});
test('app rejection after provider success never loads profile/exams and has no raw error message', async () => {
  const h = harness({ authorize: async () => { throw new EntryDemoFailure('APP_DENIED'); } }); await h.runtime.google();
  assert.equal(h.runtime.snapshot().flow, null); assert.equal(h.runtime.snapshot().step, 'choose'); assert(!h.calls.includes('profile'));
});
test('email is synthetic-only, normalized, masked in snapshots and a code uses its captured challenge', async () => {
  const h = harness(); await h.runtime.sendCode('  Oquvchi@EXAMPLE.TEST  ');
  assert.equal(h.runtime.snapshot().step, 'code'); assert.equal(h.runtime.snapshot().maskedEmail, 'o***@example.test');
  await h.runtime.verifyCode('246810'); assert.deepEqual(h.calls[0], ['send', 'oquvchi@example.test']);
  assert.deepEqual(h.calls[1], ['verify', 'synthetic-challenge-1', '246810']); assert.equal(h.runtime.snapshot().step, 'ready');
});
test('non-synthetic email never reaches the provider', async () => {
  const h = harness(); await h.runtime.sendCode('someone@example.com'); assert.equal(h.calls.length, 0); assert.equal(h.runtime.snapshot().flow, null);
});
test('invalid code format does not call a provider', async () => {
  const h = harness(); await h.runtime.sendCode('oquvchi@example.test');
  for (const code of ['', '123', 'abcdef', '1234567', '12345\n']) await h.runtime.verifyCode(code);
  assert.equal(h.calls.filter(c => Array.isArray(c) && c[0] === 'verify').length, 0); assert.equal(h.runtime.snapshot().step, 'code');
});
test('wrong provider code is retryable without app authorization', async () => {
  let wrong = true;
  const h = harness({ verifyCode: async () => { if (wrong) throw new EntryDemoFailure('INVALID_CODE'); return { proof: 'synthetic-provider-proof' }; } });
  await h.runtime.sendCode('oquvchi@example.test'); await h.runtime.verifyCode('111111');
  assert.equal(h.runtime.snapshot().step, 'code'); assert(!h.calls.includes('authorize'));
  wrong = false; await h.runtime.verifyCode('246810'); assert.equal(h.runtime.snapshot().step, 'ready');
});
test('expired code drops challenge and cannot be reused', async () => {
  const h = harness({ verifyCode: async () => { throw new EntryDemoFailure('CODE_EXPIRED'); } });
  await h.runtime.sendCode('oquvchi@example.test'); await h.runtime.verifyCode('246810'); const count = h.calls.length;
  await h.runtime.verifyCode('246810'); assert.equal(h.calls.length, count); assert.equal(h.runtime.snapshot().step, 'choose');
});
test('resend replaces the old challenge explicitly', async () => {
  const h = harness(); await h.runtime.sendCode('oquvchi@example.test'); await h.runtime.resend(); await h.runtime.verifyCode('246810');
  assert.deepEqual(h.calls.find(c => Array.isArray(c) && c[0] === 'verify'), ['verify', 'synthetic-challenge-2', '246810']);
});
test('app authorization failure consumes the finished code step, without code replay', async () => {
  const h = harness({ authorize: async () => { throw new EntryDemoFailure('APP_DENIED'); } });
  await h.runtime.sendCode('oquvchi@example.test'); await h.runtime.verifyCode('246810'); const count = h.calls.length;
  await h.runtime.verifyCode('246810'); assert.equal(h.calls.length, count); assert.equal(h.runtime.snapshot().step, 'choose');
});
test('WebView Google action is blocked before provider/app calls, while email remains available', async () => {
  const h = harness({ context: 'telegram_webview' }); await h.runtime.google(); assert.equal(h.calls.length, 0); assert.equal(h.runtime.snapshot().step, 'browser_required');
  h.runtime.reset(); await h.runtime.sendCode('oquvchi@example.test'); await h.runtime.verifyCode('246810'); assert.equal(h.runtime.snapshot().step, 'ready');
});
for (const code of ['CANCELLED', 'VERIFICATION_REQUIRED', 'RATE_LIMITED']) test(`provider ${code} cannot authorize the app`, async () => {
  const h = harness({ google: async () => { throw new EntryDemoFailure(code); } }); await h.runtime.google();
  assert.deepEqual(h.calls, ['google']); assert.equal(h.runtime.snapshot().flow, null); assert(h.runtime.snapshot().notice);
});
test('same pending action is single-flight', async () => {
  const wait = gate(); const h = harness({ google: () => wait.promise });
  const a = h.runtime.google(), b = h.runtime.google(); assert.equal(a, b); assert.deepEqual(h.calls, ['google']);
  wait.release({ proof: 'synthetic-provider-proof' }); await a;
});
test('late provider success after reset cannot enter the new context', async () => {
  const wait = gate(); const h = harness({ google: () => wait.promise }); const old = h.runtime.google(); h.runtime.reset();
  await h.runtime.sendCode('oquvchi@example.test'); await h.runtime.verifyCode('246810'); const flow = h.runtime.snapshot().flow;
  wait.release({ proof: 'synthetic-old-proof' }); await old; assert.equal(h.runtime.snapshot().flow, flow); assert.equal(h.calls.filter(c => c === 'authorize').length, 1);
});
test('late app authorization cannot change a fresh flow after reset', async () => {
  const wait = gate(); let first = true;
  const h = harness({ authorize: async () => { if (first) { first = false; return wait.promise; } return { person: 'synthetic-person', port: h.port }; } });
  const old = h.runtime.google(); await new Promise(resolve => setImmediate(resolve)); h.runtime.reset();
  await h.runtime.sendCode('oquvchi@example.test'); await h.runtime.verifyCode('246810'); const flow = h.runtime.snapshot().flow;
  wait.release({ person: 'synthetic-old-person', port: h.port }); await old; assert.equal(h.runtime.snapshot().flow, flow);
});
test('late rejection after reset does not overwrite a new ready flow', async () => {
  const wait = gate(); const h = harness({ google: async () => { await wait.promise; throw new Error('synthetic-private-error'); } });
  const old = h.runtime.google(); h.runtime.reset(); await h.runtime.sendCode('oquvchi@example.test'); await h.runtime.verifyCode('246810'); const flow = h.runtime.snapshot().flow;
  wait.release(); await old; assert.equal(h.runtime.snapshot().flow, flow); assert.equal(h.runtime.snapshot().notice, '');
});
test('profile identity mismatch is rejected before exams', async () => {
  const h = harness({ profile: { person: 'synthetic-other', registrationComplete: true } }); await h.runtime.google(); assert(!h.calls.includes('exams')); assert.equal(h.runtime.snapshot().flow, null);
});
test('incomplete server profile enters registration without loading exams', async () => {
  const h = harness({ profile: { person: 'synthetic-person', registrationComplete: false } }); await h.runtime.google(); assert.equal(h.runtime.snapshot().flow.state.screen, 'profile'); assert(!h.calls.includes('exams'));
});
test('empty provider evidence fails before app authorization', async () => {
  const h = harness({ google: async () => ({ proof: '' }) }); await h.runtime.google(); assert(!h.calls.includes('authorize')); assert.equal(h.runtime.snapshot().flow, null);
});
test('snapshots omit email, OTP, evidence and raw failures', async () => {
  const h = harness({ verifyCode: async () => { throw new Error('synthetic-private-proof-and-error'); } });
  await h.runtime.sendCode('oquvchi@example.test'); await h.runtime.verifyCode('246810'); const text = JSON.stringify(h.runtime.snapshot());
  for (const raw of ['oquvchi@example.test', '246810', 'synthetic-challenge', 'synthetic-provider-proof', 'synthetic-private']) assert(!text.includes(raw));
});
test('dispose prevents late responses and further actions; no unhandled synchronous hook rejection', async () => {
  const h = harness({ google: () => { throw new Error('synthetic-sync-failure'); } }); await h.runtime.google(); assert.equal(h.runtime.snapshot().flow, null);
  h.runtime.dispose(); const count = h.calls.length; await h.runtime.google(); await h.runtime.sendCode('oquvchi@example.test'); assert.equal(h.calls.length, count);
});

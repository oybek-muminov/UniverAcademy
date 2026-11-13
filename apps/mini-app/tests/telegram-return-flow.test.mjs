import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCommonProductionRuntime, readCommonEntryConfig } from '../src/common-production-runtime.ts';
import { createTelegramReturnLaunch } from '../src/telegram-return-launch.ts';
import { createProductionOwnerConnection } from '../src/production-connection.ts';
import { createProductionStudentClient, STUDENT_CONTRACT_SHA256 } from '../src/owner-client/student-client.ts';
import { createStudentTransport, StudentFailure } from '../src/transport.ts';
import { fakeClerkSdk } from './fixtures/clerk-sdk.fixture.mjs';

// Actual published Backend-owned canonical operations and production owner factory.
// HTTP and Clerk SDK are inert injected transports only; no live Backend/provider.
const RAW = 'query_id=synthetic%2B&auth_date=0&hash=UNVERIFIED_INERT_PROOF';
const A = '00000000-0000-4000-8000-000000000001', B = '00000000-0000-4000-8000-000000000002';
const ACCESS = 'synthetic-app-access', REFRESH = 'synthetic-app-refresh';
const env = { VITE_MINI_APP_ORIGIN: 'https://app.example.test', VITE_API_ORIGIN: 'https://api.example.test',
  VITE_STUDENT_CONTRACT_SHA256: STUDENT_CONTRACT_SHA256, VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_' + btoa('clerk.example.test$'),
  VITE_CLERK_FRONTEND_ORIGIN: 'https://clerk.example.test', VITE_TELEGRAM_SDK_ENABLED: 'true' };
const config = readCommonEntryConfig(env, env.VITE_MINI_APP_ORIGIN);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const fault = (code, status) => json({ error: { code, request_id: 'synthetic-request' } }, status);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
let nativeFetch, outbound = 0, storageReads = 0;
const storageDescriptors = new Map();
before(() => {
  nativeFetch = globalThis.fetch; globalThis.fetch = () => { outbound++; throw new Error('LIVE_NETWORK_FORBIDDEN'); };
  for (const key of ['localStorage', 'sessionStorage']) {
    storageDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, get() { storageReads++; throw new Error('DURABLE_STORAGE_FORBIDDEN'); } });
  }
});
after(() => {
  globalThis.fetch = nativeFetch;
  for (const [key, descriptor] of storageDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
  assert.equal(outbound, 0); assert.equal(storageReads, 0);
});

function harness(options = {}) {
  const requests = [], sdkProofs = [];
  const profile = { person_id: A, first_name: 'Edited', last_name: 'Preserved', qadam_id: '0000000001',
    roles: ['student'], active_group_id: null, registration_complete: true, ...options.profile };
  let linked = false, unsafeReads = 0;
  const bridge = { initData: RAW };
  Object.defineProperty(bridge, 'initDataUnsafe', { get() { unsafeReads++; throw new Error('UNSAFE_IDENTITY_FORBIDDEN'); } });
  const scope = { bridge };
  const launch = options.browser ? undefined : createTelegramReturnLaunch(() => scope.bridge);
  const sdk = fakeClerkSdk({ token: async () => {
    const n = sdkProofs.length + 1;
    const generated = 'eyJhbGciOiJub25lIn0.' + btoa(JSON.stringify({ sequence: n })).replace(/=/g, '') + '.c3ludGhldGlj';
    const proof = options.token ? await options.token(generated, n) : generated; sdkProofs.push(proof); return proof;
  } });
  sdk.setSession(sdk.makeSession('sess_SyntheticInitial'));
  const session = () => ({ token_type: 'Bearer', access_token: ACCESS, refresh_token: REFRESH,
    expires_at: '2035-01-01T00:00:00.000Z', profile: { ...profile } });
  async function send(request) {
    const item = { url: request.url, path: new URL(request.url).pathname, method: request.method,
      auth: request.headers.get('authorization'), body: request.method === 'GET' ? undefined : await request.clone().json() };
    requests.push(item);
    assert.equal(new URL(request.url).origin, env.VITE_API_ORIGIN);
    assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'error'); assert.equal(request.cache, 'no-store');
    assert.equal(request.headers.get('idempotency-key'), null);
    if (request.method === 'POST' || request.method === 'PATCH') assert.equal(request.headers.get('content-type'), 'application/json');
    const ordinary = async () => {
      if (item.path === '/api/v1/auth/clerk') {
        assert.deepEqual(item.body, {}); assert.equal(item.auth, 'Bearer ' + sdkProofs[0]);
        return json({ data: session() });
      }
      if (item.path === '/api/v1/auth/telegram/link') {
        assert.deepEqual(item.body, { init_data: RAW }); assert.equal(item.auth, 'Bearer ' + sdkProofs[1]);
        assert.notEqual(item.auth, 'Bearer ' + ACCESS); linked = true; return json({ data: { ok: true } });
      }
      if (item.path === '/api/v1/auth/telegram/resume') {
        assert.deepEqual(item.body, { init_data: RAW }); assert.equal(item.auth, null);
        if (options.resumeError) return fault(...options.resumeError);
        return json({ data: session() });
      }
      if (item.path === '/api/v1/auth/logout') {
        assert.equal(item.auth, null); assert.deepEqual(item.body, { refresh_token: REFRESH });
        return json({ data: { ok: true } });
      }
      assert.equal(item.auth, 'Bearer ' + ACCESS);
      if (item.path === '/api/v1/me' && item.method === 'GET') return json({ data: { ...profile, ...options.me } });
      if (item.path === '/api/v1/me' && item.method === 'PATCH') {
        assert.equal(options.browser || linked, true);
        Object.assign(profile, item.body, { registration_complete: true }); return json({ data: { ...profile } });
      }
      if (item.path === '/api/v1/exams') return json({ data: [] });
      throw new Error('UNEXPECTED_HTTP_OPERATION');
    };
    return options.send ? options.send(item, ordinary) : ordinary();
  }
  const runtime = createCommonProductionRuntime(config, sdk.sdk, options.browser ? 'browser' : 'telegram_webview', send, { launch });
  return { ...sdk, runtime, launch, scope, requests, sdkProofs, profile, unsafeReads: () => unsafeReads };
}
const paths = h => h.requests.map(x => x.path);
const calls = (h, suffix) => h.requests.filter(x => x.path.endsWith(suffix));

test('published canonical client exposes exact link/resume operations through the production factory', async () => {
  const c = createProductionStudentClient({ mode: 'production', baseUrl: config.apiBaseUrl,
    contractSha256: STUDENT_CONTRACT_SHA256, transport: async () => { throw new Error('NO_IO'); } });
  assert.equal(typeof c.linkTelegramIdentity, 'function'); assert.equal(typeof c.resumeTelegramSession, 'function');
  const requests = [], connection = createProductionOwnerConnection({ mode: 'production', baseUrl: config.apiBaseUrl,
    contractSha256: STUDENT_CONTRACT_SHA256 }, async request => { requests.push(request); throw new Error('NO_IO'); }, { loginMethod: 'telegram_resume' });
  await connection.auth.requireTelegramReturn(); assert.equal(requests.length, 0);
});
test('obsolete contract hash fails before any HTTP and cannot substitute the project bearer', () => {
  let calls = 0;
  assert.throws(() => createProductionOwnerConnection({ mode: 'production', baseUrl: config.apiBaseUrl,
    contractSha256: 'f6226aa1cea63ae1fbc603b80aed9232bc4dd5213c4cc081cc13300ee0179b28' }, async () => { calls++; throw new Error('NO_IO'); }), /CONTRACT_HASH_MISMATCH/);
  assert.equal(calls, 0);
});
test('ordinary non-Telegram existing canonical login stays supported, with no link/resume', async () => {
  const h = harness({ browser: true }); await h.runtime.continueSession();
  assert.equal(h.runtime.snapshot().flow.state.student.person, A);
  assert.deepEqual(paths(h), ['/api/v1/auth/clerk', '/api/v1/me', '/api/v1/exams']);
});
test('actual canonical client: exchange -> FRESH Clerk-JWT link -> edited existing profile -> authorized empty exams', async () => {
  const h = harness(); await h.runtime.continueSession();
  assert.deepEqual(paths(h), ['/api/v1/auth/clerk', '/api/v1/auth/telegram/link', '/api/v1/me', '/api/v1/exams']);
  assert.equal(h.sdkProofs.length, 2); assert.notEqual(h.sdkProofs[0], h.sdkProofs[1]);
  assert.deepEqual(h.calls.filter(x => x[0] === 'getToken').map(x => x[1]), [{ skipCache: true }, { skipCache: true }]);
  assert.equal(h.runtime.snapshot().flow.state.student.firstName, 'Edited'); assert.equal(calls(h, '/me').some(x => x.method === 'PATCH'), false);
  assert.equal(h.runtime.snapshot().flow.state.student.person, A); assert.equal(h.unsafeReads(), 0);
  assert.equal(h.launch.phase(), 'linked'); assert.equal(calls(h, '/auth/telegram/resume').length, 0);
  const snapshot = JSON.stringify(h.runtime.snapshot());
  for (const value of [RAW, ACCESS, REFRESH, ...h.sdkProofs]) assert.equal(snapshot.includes(value), false);
});
test('actual canonical client: new incomplete server names complete once after link, never before ACK', async () => {
  const h = harness({ profile: { first_name: 'Server First', last_name: 'Server Last', registration_complete: false } });
  await h.runtime.continueSession();
  assert.deepEqual(paths(h), ['/api/v1/auth/clerk', '/api/v1/auth/telegram/link', '/api/v1/me', '/api/v1/me', '/api/v1/exams']);
  assert.deepEqual(calls(h, '/me').find(x => x.method === 'PATCH').body, { first_name: 'Server First', last_name: 'Server Last' });
  assert.equal(h.runtime.snapshot().flow.state.screen, 'exams');
});
for (const [first, last] of [['Only First', ''], ['', 'Only Last'], ['', '']]) {
  test(`partial server names ${first}/${last} retain the existing profile form`, async () => {
    const h = harness({ profile: { first_name: first, last_name: last, registration_complete: false } });
    await h.runtime.continueSession(); assert.equal(h.runtime.snapshot().flow.state.screen, 'profile');
    assert.equal(h.runtime.snapshot().flow.state.student.firstName, first);
    assert.equal(h.requests.some(x => x.method === 'PATCH'), false); assert.equal(calls(h, '/exams').length, 0);
  });
}
test('100 supplementary-plane code points retain the accepted profile completion limit', async () => {
  const name = '𐐀'.repeat(100), h = harness({ profile: { first_name: name, registration_complete: false } });
  await h.runtime.continueSession(); assert.equal(calls(h, '/me').find(x => x.method === 'PATCH').body.first_name, name);
});
test('returning launch sends init_data only with NO bearer, then same-person profile/cabinet without Clerk form/exchange', async () => {
  const h = harness(); await h.runtime.resumeSession();
  assert.deepEqual(paths(h), ['/api/v1/auth/telegram/resume', '/api/v1/me', '/api/v1/exams']);
  assert.equal(h.sdkProofs.length, 0); assert.equal(h.runtime.snapshot().flow.state.student.person, A); assert.equal(h.launch.phase(), 'resumed');
});
test('unknown-link409 is the sole new-user navigation branch; original launch can link after Clerk, never immediately resume again', async () => {
  const h = harness({ resumeError: ['TELEGRAM_LINK_REQUIRED', 409] }); await h.runtime.resumeSession();
  assert.equal(h.runtime.snapshot().flow, null); assert.equal(h.launch.phase(), 'needs_clerk');
  await h.runtime.continueSession(); assert.equal(h.runtime.snapshot().flow.state.student.person, A);
  assert.equal(calls(h, '/auth/telegram/resume').length, 1); assert.equal(calls(h, '/auth/telegram/link').length, 1);
});
test('revoked401 requires renewed Clerk authentication rather than a Telegram-only grant', async () => {
  const h = harness({ resumeError: ['CLERK_SESSION_REVOKED', 401] }); await h.runtime.resumeSession();
  assert.equal(h.runtime.snapshot().flow, null); assert.equal(h.launch.phase(), 'needs_clerk');
  h.setSession(h.makeSession('sess_SyntheticRenewed')); await h.runtime.continueSession();
  assert.equal(h.runtime.snapshot().flow.state.student.person, A); assert.equal(calls(h, '/auth/telegram/resume').length, 1);
});
for (const error of [['SERVICE_UNAVAILABLE', 503], ['ACCOUNT_DISABLED', 403], ['TELEGRAM_INIT_DATA_INVALID', 401], ['UNEXPECTED_CONFLICT', 409],
  ['TELEGRAM_LINK_REQUIRED', 401], ['CLERK_SESSION_REVOKED', 409], ['CLERK_IDENTITY_REVOKED', 401]]) {
  test(`resume ${error.join('/')} never falls back to Clerk/new user or auto-retries`, async () => {
    const h = harness({ resumeError: error }); await h.runtime.resumeSession(); await turn();
    assert.equal(h.launch.phase(), 'failed'); assert.equal(h.runtime.snapshot().flow, null);
    await h.runtime.continueSession(); assert.equal(calls(h, '/auth/clerk').length, 0); assert.equal(calls(h, '/auth/telegram/resume').length, 1);
  });
}
for (const [code, status] of [['IDENTITY_LINK_CONFLICT', 409], ['SERVICE_UNAVAILABLE', 503]]) {
  test(`link ${code} admits no cabinet/profile write and cannot retry the same launch`, async () => {
    const h = harness({ send: (item, ordinary) => item.path.endsWith('/telegram/link') ? fault(code, status) : ordinary() });
    await h.runtime.continueSession(); await turn();
    assert.equal(h.runtime.snapshot().flow, null); assert.equal(h.launch.phase(), 'failed');
    assert.equal(calls(h, '/me').length, 0); assert.equal(calls(h, '/exams').length, 0);
    await h.runtime.continueSession(); assert.equal(calls(h, '/auth/clerk').length, 1); assert.equal(calls(h, '/auth/telegram/link').length, 1);
  });
}
for (const value of [{ data: { ok: false } }, { data: { ok: true, person: B } }, { data: null }]) {
  test('malformed/ambiguous link ACK never opens or retries a cabinet', async () => {
    const h = harness({ send: (item, ordinary) => item.path.endsWith('/telegram/link') ? json(value) : ordinary() });
    await h.runtime.continueSession(); assert.equal(h.runtime.snapshot().flow, null); assert.equal(h.launch.phase(), 'failed');
    await h.runtime.continueSession(); assert.equal(calls(h, '/auth/telegram/link').length, 1);
  });
}
test('double Continue shares pending link and does not duplicate exchange, completion or consume launch through resume', async () => {
  const entered = deferred(), wait = deferred();
  const h = harness({ profile: { registration_complete: false }, send: async (item, ordinary) => {
    if (item.path.endsWith('/telegram/link')) { entered.resolve(); await wait.promise; } return ordinary();
  } });
  const first = h.runtime.continueSession(); await entered.promise; const second = h.runtime.continueSession();
  assert.equal(first, second); assert.equal(h.runtime.snapshot().flow, null); wait.resolve(); await first;
  await h.runtime.continueSession(); assert.equal(calls(h, '/auth/clerk').length, 1); assert.equal(calls(h, '/auth/telegram/link').length, 1);
  assert.equal(h.requests.filter(x => x.method === 'PATCH').length, 1); assert.equal(calls(h, '/auth/telegram/resume').length, 0);
});
test('double returning launch joins one pending resume; ready document does not replay consumed initData', async () => {
  const entered = deferred(), wait = deferred(); const h = harness({ send: async (item, ordinary) => {
    if (item.path.endsWith('/telegram/resume')) { entered.resolve(); await wait.promise; } return ordinary();
  } });
  const first = h.runtime.resumeSession(); await entered.promise; assert.equal(first, h.runtime.resumeSession());
  wait.resolve(); await first; await h.runtime.resumeSession(); assert.equal(calls(h, '/auth/telegram/resume').length, 1);
});
for (const mode of ['bridge lost', 'raw changed', 'bridge replaced']) {
  test(`${mode} after Clerk exchange cannot be bridged by ID or linked`, async () => {
    const entered = deferred(), wait = deferred(); const h = harness({ send: async (item, ordinary) => {
      const result = await ordinary(); if (item.path.endsWith('/auth/clerk')) { entered.resolve(); await wait.promise; } return result;
    } });
    const pending = h.runtime.continueSession(); await entered.promise;
    if (mode === 'bridge lost') h.scope.bridge = undefined;
    else if (mode === 'raw changed') h.scope.bridge.initData = 'changed'; else h.scope.bridge = { initData: RAW };
    wait.resolve(); await pending; assert.equal(h.runtime.snapshot().flow, null); assert.equal(calls(h, '/auth/telegram/link').length, 0);
  });
}
test('SDK person/session switch while exchange is pending cannot link the new SDK account or open the old cabinet', async () => {
  const entered = deferred(), wait = deferred(); const h = harness({ send: async (item, ordinary) => {
    const result = await ordinary(); if (item.path.endsWith('/auth/clerk')) { entered.resolve(); await wait.promise; } return result;
  } });
  const pending = h.runtime.continueSession(); await entered.promise; h.setSession(h.makeSession('sess_SyntheticOther'));
  wait.resolve(); await pending; assert.equal(h.runtime.snapshot().flow, null); assert.equal(calls(h, '/auth/telegram/link').length, 0);
});
test('SDK switch during second fresh JWT prevents link and does not sign out the unrelated new session', async () => {
  const entered = deferred(), wait = deferred(); const h = harness({ token: async (proof, n) => {
    if (n === 2) { entered.resolve(); await wait.promise; } return proof;
  } });
  const pending = h.runtime.continueSession(); await entered.promise; h.setSession(h.makeSession('sess_SyntheticOther'));
  wait.resolve(); await pending; assert.equal(h.runtime.snapshot().flow, null); assert.equal(calls(h, '/auth/telegram/link').length, 0);
  assert.equal(h.calls.some(x => x[0] === 'signOut' && x[1] === 'sess_SyntheticOther'), false);
});
test('late successful link after cancellation never opens a cabinet or retries the uncertain write', async () => {
  const entered = deferred(), wait = deferred(); const h = harness({ send: async (item, ordinary) => {
    const result = await ordinary(); if (item.path.endsWith('/telegram/link')) { entered.resolve(); await wait.promise; } return result;
  } });
  const pending = h.runtime.continueSession(); await entered.promise; await h.runtime.reset(); wait.resolve(); await pending;
  assert.equal(h.runtime.snapshot().flow, null); assert.equal(h.launch.phase(), 'failed');
  await h.runtime.continueSession(); assert.equal(calls(h, '/auth/telegram/link').length, 1);
});
test('a lost response after simulated link commit is not retried or treated as permission to resume consumed initData', async () => {
  const h = harness({ send: async (item, ordinary) => {
    const value = await ordinary(); if (item.path.endsWith('/telegram/link')) throw new Error('SYNTHETIC_RESPONSE_LOST'); return value;
  } });
  await h.runtime.continueSession(); assert.equal(h.runtime.snapshot().flow, null); assert.equal(h.launch.phase(), 'failed');
  await h.runtime.continueSession(); await h.runtime.resumeSession();
  assert.equal(calls(h, '/auth/telegram/link').length, 1); assert.equal(calls(h, '/auth/telegram/resume').length, 0);
});
test('SDK identity switch while a link ACK is pending cannot open the prior account for the new SDK context', async () => {
  const entered = deferred(), wait = deferred(); const h = harness({ send: async (item, ordinary) => {
    const response = await ordinary(); if (item.path.endsWith('/telegram/link')) { entered.resolve(); await wait.promise; } return response;
  } });
  const pending = h.runtime.continueSession(); await entered.promise; h.setSession(h.makeSession('sess_SyntheticOther'));
  wait.resolve(); await pending; assert.equal(h.runtime.snapshot().flow, null); assert.equal(h.launch.phase(), 'failed');
  assert.equal(calls(h, '/me').length, 0);
});
test('resume profile person mismatch cannot complete profile, read exams or open a wrong-person cabinet', async () => {
  const h = harness({ me: { person_id: B } }); await h.runtime.resumeSession();
  assert.equal(h.runtime.snapshot().flow, null); assert.equal(calls(h, '/exams').length, 0); assert.equal(h.requests.some(x => x.method === 'PATCH'), false);
});
test('raw proof/JWTs are never introduced into request URLs or durable browser storage', async () => {
  const h = harness(); await h.runtime.continueSession(); assert.equal(h.unsafeReads(), 0);
  for (const req of h.requests) {
    const url = new URL(req.url); assert.equal(url.search, ''); assert.equal(url.hash, '');
    for (const value of [RAW, ACCESS, REFRESH, ...h.sdkProofs]) {
      assert(!req.url.includes(value)); assert(!req.url.includes(encodeURIComponent(value)));
    }
  }
  assert.equal(storageReads, 0);
});
for (const raw of [undefined, '', '   ', { telegram_id: 42 }]) {
  test('required Telegram return with absent/invalid raw proof cannot use unsafe ID or an ordinary Clerk-only portal as a bridge', async () => {
    const h = harness(); h.scope.bridge.initData = raw; await h.runtime.continueSession();
    assert.equal(h.runtime.snapshot().flow, null); assert.equal(h.launch.phase(), 'failed'); assert.deepEqual(h.requests, []); assert.equal(h.unsafeReads(), 0);
  });
}
test('ordinary login failure normalization remains unchanged; return mode preserves only typed operation failures', async () => {
  const cause = new StudentFailure('conflict', 'TELEGRAM_LINK_REQUIRED');
  const make = (loginFailurePolicy, failure) => createStudentTransport({ origin: config.apiOrigin, loginFailurePolicy,
    fetcher: () => { throw new Error('NO_IO'); }, sessions: { login: async () => { throw failure; }, rotate: async () => { throw new Error('NO_ROTATE'); }, logout: async () => {} } });
  await assert.rejects(make(undefined, cause).login(RAW), e => e.code === 'FRESH_LAUNCH_REQUIRED');
  await assert.rejects(make('telegram_return', cause).login(RAW), e => e === cause);
  await assert.rejects(make('telegram_return', new Error('PRIVATE_DETAIL')).login(RAW), e => e.code === 'FRESH_LAUNCH_REQUIRED');
});
test('canonical and owner client/type bytes remain identical; no shared ownership edit masquerades as wiring', async () => {
  for (const file of ['student-client.ts', 'student-types.d.ts']) {
    const expected = await readFile(new URL('../../../packages/api-client/' + file, import.meta.url));
    const owner = await readFile(new URL('../src/owner-client/' + file, import.meta.url));
    assert.deepEqual(owner, expected);
  }
});

for (const [label, status, body] of [
  ['unexpected successful status', 201, { data: { ok: true } }],
  ['error envelope on200', 200, { data: { ok: true }, error: { code: 'UNTRUSTED' } }],
]) test('canonical link '+label+' fails closed without retry or profile access', async () => {
  const h = harness({ send: (item, ordinary) => item.path.endsWith('/telegram/link') ? json(body, status) : ordinary() });
  await h.runtime.continueSession(); await h.runtime.continueSession();
  assert.equal(h.runtime.snapshot().flow, null); assert.equal(h.launch.phase(), 'failed');
  assert.equal(calls(h, '/auth/telegram/link').length, 1); assert.equal(calls(h, '/me').length, 0);
});
test('fresh SDK retrieval yielding a replayed JWT is denied by the inert server outcome without retry', async () => {
  const token = 'eyJhbGciOiJub25lIn0.eyJqdGkiOiJzYW1lIn0.c3ludGhldGlj';
  const h = harness({ token: () => token, send: (item, ordinary) => item.path.endsWith('/telegram/link') ? fault('CLERK_TOKEN_REPLAY', 409) : ordinary() });
  await h.runtime.continueSession();
  assert.deepEqual(h.sdkProofs, [token, token]);
  const requestCount = h.requests.length; await h.runtime.continueSession();
  assert.equal(h.requests.length, requestCount); // A repeated click does not resend either proof operation.
  assert.equal(h.runtime.snapshot().flow, null); assert.equal(calls(h, '/auth/telegram/link').length, 1);
  assert.equal(calls(h, '/auth/telegram/resume').length, 0); assert.equal(calls(h, '/me').length, 0);
});

for (const operation of ['continueSession', 'resumeSession']) test(operation+' wrong-person server profile cannot expose exams or complete names', async () => {
  const h = harness({ me: { person_id: B, registration_complete: false } }); await h.runtime[operation]();
  assert.equal(h.runtime.snapshot().flow, null); assert.equal(calls(h, '/exams').length, 0);
  assert.equal(h.requests.some(x => x.method === 'PATCH'), false);
});
test('canonical incomplete-name PATCH503 produces no cabinet or automatic proof/profile retry', async () => {
  const h = harness({ profile: { registration_complete: false }, send: (item, ordinary) => item.method === 'PATCH' ? fault('SERVICE_UNAVAILABLE', 503) : ordinary() });
  await h.runtime.continueSession(); await turn(); await h.runtime.continueSession();
  assert.equal(h.runtime.snapshot().flow, null); assert.equal(calls(h, '/exams').length, 0);
  assert.equal(h.requests.filter(x => x.method === 'PATCH').length, 1);
  assert.equal(calls(h, '/auth/clerk').length, 1); assert.equal(calls(h, '/auth/telegram/link').length, 1);
});
test('partial-name profile uses existing manual registration then authorized empty exams through canonical client', async () => {
  const h = harness({ profile: { first_name: 'Only First', last_name: '', registration_complete: false } });
  await h.runtime.continueSession(); const flow = h.runtime.snapshot().flow;
  assert.equal(flow.state.screen, 'profile'); assert.equal(flow.state.student.firstName, 'Only First');
  await flow.register('Chosen First', 'Chosen Last');
  assert.deepEqual(h.requests.find(x => x.method === 'PATCH').body, { first_name: 'Chosen First', last_name: 'Chosen Last' });
  assert.equal(flow.state.screen, 'exams'); assert.deepEqual(flow.state.exams, []);
  assert.equal(calls(h, '/auth/telegram/link').length, 1);
});
test('late resume response after reset cannot open a cabinet or consume the proof again', async () => {
  const entered = deferred(), wait = deferred(); const h = harness({ send: async (item, ordinary) => {
    const result = await ordinary(); if (item.path.endsWith('/telegram/resume')) { entered.resolve(); await wait.promise; } return result;
  } });
  const pending = h.runtime.resumeSession(); await entered.promise; await h.runtime.reset(); wait.resolve(); await pending;
  await h.runtime.resumeSession(); assert.equal(h.runtime.snapshot().flow, null);
  assert.equal(calls(h, '/auth/telegram/resume').length, 1); assert.equal(calls(h, '/me').length, 0);
});
test('overlong server name is never silently truncated or treated as complete', async () => {
  const name = '𐐀'.repeat(101), h = harness({ profile: { first_name: name, registration_complete: false } });
  await h.runtime.continueSession(); const flow = h.runtime.snapshot().flow;
  assert.equal(flow.state.screen, 'profile'); assert.equal(flow.state.student.firstName, name);
  assert.equal(h.requests.some(x => x.method === 'PATCH'), false); assert.equal(calls(h, '/exams').length, 0);
});

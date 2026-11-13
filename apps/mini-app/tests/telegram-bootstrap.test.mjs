import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramBootstrap, readTelegramBridge } from '../src/telegram-bootstrap.ts';
import { createOwnerPort } from '../src/owner-port.ts';
import { STUDENT_CONTRACT_SHA256 } from '../src/owner-client/student-client.ts';

// Synthetic bridge/transport with the pinned production owner constructor.
// No native fetch, real Telegram SDK, bot key or external network is used.
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rawA = 'query_id=synthetic-first&user=%7B%22id%22%3A1%7D&hash=synthetic%2B%3D';
const rawB = 'query_id=synthetic-second&user=%7B%22id%22%3A2%7D&hash=synthetic%2B%3D';
const profile = (person, registered = true) => ({ person_id: person, first_name: 'Suniy', last_name: 'Bootstrap',
  roles: ['student'], registration_complete: registered, active_group_id: null, qadam_id: '0000000001' });
const ok = data => new Response(JSON.stringify({ data }), { status: 200 });
const fail = (status, code) => new Response(JSON.stringify({ error: { code,
  message: 'Synthetic error', request_id: id(900) } }), { status });
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }

function harness(options = {}) {
  const bridge = { initData: rawA, readyCalls: 0, ready() { this.readyCalls++; } };
  Object.defineProperty(bridge, 'initDataUnsafe', { get() { throw new Error('UNTRUSTED_IDENTITY_MUST_NOT_BE_READ'); } });
  const calls = [], connections = [];
  let time = 1_800_000_000_000;
  const defaultReply = (call, person, registered) => {
    if (call.path === '/auth/telegram') return ok({ token_type: 'Bearer', access_token: 'synthetic-access-' + person,
      refresh_token: 'synthetic-refresh-' + person, expires_at: new Date(time + 60000).toISOString(),
      refresh_expires_at: new Date(time + 120000).toISOString(), profile: profile(person, registered) });
    if (call.path === '/me' && call.method === 'GET') return ok(profile(person, registered));
    if (call.path === '/me' && call.method === 'PATCH') return ok(profile(person, true));
    if (call.path === '/exams') return ok([]);
    if (call.path === '/auth/logout') return ok({ ok: true });
    if (call.path === '/auth/refresh') return ok({ token_type: 'Bearer', access_token: 'synthetic-rotated-access-' + person,
      refresh_token: 'synthetic-rotated-refresh-' + person, expires_at: new Date(time + 60000).toISOString(),
      refresh_expires_at: new Date(time + 120000).toISOString(), profile: profile(person, registered) });
    throw new Error('UNEXPECTED_SYNTHETIC_REQUEST');
  };
  const createConnection = config => {
    assert.equal(config.mode, 'production');
    assert.equal(config.baseUrl, 'https://api.example.test/api/v1');
    assert.equal(config.contractSha256, STUDENT_CONTRACT_SHA256);
    if (options.reuseConnection && connections.length) return connections[0];
    let person = id(8);
    const registered = options.registered ?? true;
    // The actual production constructor receives a reserved .test HTTPS origin
    // and injected RAM transport. No local-only guard is changed or bypassed.
    const connection = createOwnerPort({ mode: 'production', baseUrl: config.baseUrl,
      contractSha256: config.contractSha256, now: () => time,
      fetcher: async request => {
        const body = request.method === 'GET' ? undefined : JSON.parse(await request.clone().text());
        const call = { path: new URL(request.url).pathname.replace('/api/v1', ''), method: request.method,
          body, headers: request.headers, cache: request.cache, credentials: request.credentials, redirect: request.redirect };
        if (call.path === '/auth/telegram') person = body.init_data === rawB ? id(9) : id(8);
        calls.push(call);
        return options.respond ? options.respond(call, () => defaultReply(call, person, registered))
          : defaultReply(call, person, registered);
      }, view: () => ({ title: 'Synthetic', groupLabel: 'Synthetic', startAllowed: false }),
      assetUrl: () => { throw new Error('NO_ASSETS_IN_BOOTSTRAP'); } });
    connections.push(connection);
    return connection;
  };
  const runtime = createTelegramBootstrap({ apiBaseUrl: 'https://api.example.test/api/v1',
    contractSha256: STUDENT_CONTRACT_SHA256, readBridge: () => options.noBridge ? undefined : bridge,
    createConnection });
  return { runtime, bridge, calls, connections, setTime(value) { time = value; } };
}

test('raw SDK initData goes unchanged to owner login; only server profile is used', async () => {
  const h = harness();
  const flow = await h.runtime.start();
  assert.equal(h.calls[0].path, '/auth/telegram');
  assert.deepEqual(h.calls[0].body, { init_data: rawA });
  assert.equal(h.calls[0].headers.has('authorization'), false);
  assert.equal(flow.state.student.person, id(8));
  assert.equal(flow.state.screen, 'exams');
  assert.equal(h.runtime.getSnapshot().phase, 'ready');
  for (const request of h.calls) {
    assert.equal(request.cache, 'no-store'); assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'error');
  }
});

test('incomplete registration hydrates profile without fetching exams', async () => {
  const h = harness({ registered: false });
  assert.equal((await h.runtime.start()).state.screen, 'profile');
  assert(!h.calls.some(call => call.path === '/exams'));
});

test('missing Telegram bridge never creates an API connection', async () => {
  const h = harness({ noBridge: true });
  await assert.rejects(h.runtime.start(), error => error.code === 'TELEGRAM_LAUNCH_REQUIRED');
  assert.equal(h.connections.length, 0); assert.equal(h.calls.length, 0);
});

test('empty initData does not fall back to unsafe user, URL or storage values', async () => {
  const h = harness(); h.bridge.initData = '   ';
  await assert.rejects(h.runtime.start(), error => error.code === 'TELEGRAM_LAUNCH_REQUIRED');
  assert.equal(h.calls.length, 0);
});

test('bridge ready preserves its SDK receiver and runs once per bridge', () => {
  const h = harness(); assert.equal(h.runtime.ready(), true); assert.equal(h.runtime.ready(), true);
  assert.equal(h.bridge.readyCalls, 1); assert.equal(h.calls.length, 0);
});

test('ready SDK exceptions are sanitized instead of reflecting raw data', () => {
  const h = harness(); h.bridge.ready = () => { throw new Error(rawA); };
  assert.throws(() => h.runtime.ready(), error => error.code === 'TELEGRAM_BRIDGE_UNAVAILABLE' && !error.message.includes(rawA));
});

test('concurrent starts share one login and one hydration', async () => {
  const reading = gate(), release = gate();
  const h = harness({ respond: async (call, reply) => {
    if (call.path === '/auth/telegram') { reading.release(); await release.promise; }
    return reply();
  } });
  const first = h.runtime.start(), second = h.runtime.start(); assert.equal(first, second);
  await reading.promise; release.release();
  assert.equal(await first, await second);
  assert.equal(h.calls.filter(call => call.path === '/auth/telegram').length, 1);
});

test('an already hydrated RAM session does not replay the launch', async () => {
  const h = harness(); const first = await h.runtime.start();
  assert.equal(await h.runtime.start(), first);
  assert.equal(h.calls.filter(call => call.path === '/auth/telegram').length, 1);
});

test('Telegram auth loss keeps Telegram guidance and a fresh launch can re-enter', async () => {
  let revoked = false;
  const h = harness({ respond: async (call, reply) => call.path === '/me' && revoked ? fail(401, 'SESSION_REVOKED') : reply() });
  const old = await h.runtime.start(); revoked = true; await old.enter();
  assert.equal(old.state.student, null); assert.equal(old.state.screen, 'welcome');
  assert.match(old.state.notice, /Telegramdan yangidan kiring/); assert(!old.state.notice.includes('Google'));
  revoked = false; h.bridge.initData = rawB;
  const fresh = await h.runtime.start(); assert.notEqual(fresh, old); assert.equal(fresh.state.student.person, id(9));
});

test('profile retry uses existing RAM session after a temporary read failure', async () => {
  let failed = false;
  const h = harness({ respond: async (call, reply) => {
    if (call.path === '/me' && !failed) { failed = true; return fail(503, 'SERVICE_UNAVAILABLE'); }
    return reply();
  } });
  await assert.rejects(h.runtime.start());
  Object.defineProperty(h.bridge, 'initData', { get() { throw new Error('MUST_NOT_REPLAY_BRIDGE'); } });
  assert.equal((await h.runtime.start()).state.student.person, id(8));
  assert.equal(h.calls.filter(call => call.path === '/auth/telegram').length, 1);
});

test('RAM hydration retry refreshes an expired session without replaying Telegram data', async () => {
  let failed = false;
  const h = harness({ respond: async (call, reply) => {
    if (call.path === '/me' && !failed) { failed = true; return fail(503, 'SERVICE_UNAVAILABLE'); }
    return reply();
  } });
  await assert.rejects(h.runtime.start()); h.setTime(1_800_000_060_001);
  await h.runtime.start();
  assert.equal(h.calls.filter(call => call.path === '/auth/telegram').length, 1);
  const rotations = h.calls.filter(call => call.path === '/auth/refresh');
  assert.equal(rotations.length, 1); assert.equal(rotations[0].headers.has('authorization'), false);
});

test('ambiguous login cannot automatically replay the same raw launch', async () => {
  let first = true;
  const h = harness({ respond: async (call, reply) => {
    if (call.path === '/auth/telegram' && first) { first = false; throw new Error('SYNTHETIC_LOST_REPLY'); }
    return reply();
  } });
  await assert.rejects(h.runtime.start());
  await assert.rejects(h.runtime.start(), error => error.code === 'FRESH_LAUNCH_REQUIRED');
  assert.equal(h.calls.filter(call => call.path === '/auth/telegram').length, 1);
  h.bridge.initData = rawB;
  assert.equal((await h.runtime.start()).state.student.person, id(9));
});

test('profile person mismatch never hydrates identity into the UI', async () => {
  const h = harness({ respond: async (call, reply) => call.path === '/me' ? ok(profile(id(999))) : reply() });
  await assert.rejects(h.runtime.start(), error => error.code === 'PROFILE_SESSION_MISMATCH');
  assert.equal(h.runtime.getSnapshot().flow.state.student, null);
});

test('logout clears visible context immediately and sends a body-only receipt', async () => {
  const reading = gate(), release = gate();
  const h = harness({ respond: async (call, reply) => {
    if (call.path === '/auth/logout') { reading.release(); await release.promise; }
    return reply();
  } });
  await h.runtime.start(); const pending = h.runtime.logout();
  assert.equal(h.runtime.getSnapshot().flow, null);
  await reading.promise;
  const request = h.calls.find(call => call.path === '/auth/logout');
  assert.equal(request.headers.has('authorization'), false);
  assert.deepEqual(Object.keys(request.body), ['refresh_token']);
  release.release(); await pending;
  assert.equal(h.runtime.getSnapshot().phase, 'logged_out');
  await assert.rejects(h.runtime.start(), error => error.code === 'FRESH_LAUNCH_REQUIRED');
});

for (const status of [200, 401]) test(`late logout ${status} cannot change a fresh login`, async () => {
  const reading = gate(), release = gate();
  const h = harness({ respond: async (call, reply) => {
    if (call.path === '/auth/logout') { reading.release(); await release.promise; return status === 200 ? reply() : fail(401, 'SESSION_REVOKED'); }
    return reply();
  } });
  await h.runtime.start(); const old = h.runtime.logout().catch(error => error);
  await reading.promise; h.bridge.initData = rawB; const next = await h.runtime.start();
  release.release(); assert.equal((await old).code, 'ACCESS_SUPERSEDED');
  assert.equal(h.runtime.getSnapshot().flow, next); assert.equal(next.state.student.person, id(9));
});

test('late old bootstrap body cannot replace the next session UI', async () => {
  const reading = gate(), release = gate(); let delayed = true;
  const h = harness({ respond: async (call, reply) => {
    const response = reply();
    if (call.path === '/me' && delayed) {
      delayed = false; const json = response.json.bind(response);
      response.json = async () => { reading.release(); await release.promise; return json(); };
    }
    return response;
  } });
  const old = h.runtime.start().catch(error => error);
  await reading.promise; await h.runtime.logout(); h.bridge.initData = rawB;
  const next = await h.runtime.start(); release.release();
  assert.equal((await old).code, 'ACCESS_SUPERSEDED');
  assert.equal(h.runtime.getSnapshot().flow, next); assert.equal(next.state.student.person, id(9));
});

test('pending old registration is isolated in a retired flow after logout and fresh login', async () => {
  const reading = gate(), release = gate();
  const h = harness({ registered: false, respond: async (call, reply) => {
    if (call.path === '/me' && call.method === 'PATCH') { reading.release(); await release.promise; }
    return reply();
  } });
  const retired = await h.runtime.start(); const mutation = retired.register('Suniy', 'Old');
  await reading.promise; await h.runtime.logout(); h.bridge.initData = rawB;
  const next = await h.runtime.start(); release.release(); await mutation;
  assert.notEqual(next, retired); assert.equal(h.runtime.getSnapshot().flow, next);
  assert.equal(next.state.student.person, id(9));
});

test('disposal during pending login conceals data and does not claim server logout', async () => {
  const reading = gate(), release = gate();
  const h = harness({ respond: async (call, reply) => {
    if (call.path === '/auth/telegram') { reading.release(); await release.promise; }
    return reply();
  } });
  const pending = h.runtime.start().catch(error => error); await reading.promise;
  h.runtime.dispose(); release.release(); assert.equal((await pending).code, 'ACCESS_SUPERSEDED');
  assert.equal(h.runtime.getSnapshot().flow, null);
  assert(!h.calls.some(call => call.path === '/auth/logout'));
  await assert.rejects(h.runtime.start(), error => error.code === 'BOOTSTRAP_DISPOSED');
});

test('logout during pending login cannot resurrect that connection after a fresh launch', async () => {
  const reading = gate(), release = gate();
  const h = harness({ respond: async (call, reply) => {
    if (call.path === '/auth/telegram' && call.body.init_data === rawA) { reading.release(); await release.promise; }
    return reply();
  } });
  const old = h.runtime.start().catch(error => error); await reading.promise;
  await assert.rejects(h.runtime.logout(), error => error.code === 'LOGOUT_PROOF_REQUIRED');
  assert.equal(h.runtime.getSnapshot().flow, null);
  h.bridge.initData = rawB; const next = await h.runtime.start(); release.release();
  assert.equal((await old).code, 'ACCESS_SUPERSEDED');
  assert.equal(h.runtime.getSnapshot().flow, next); assert.equal(next.state.student.person, id(9));
  assert(!h.calls.some(call => call.path === '/auth/logout'));
});

test('window bridge discovery reads neither storage nor initDataUnsafe', () => {
  const h = harness(); const scope = { Telegram: { WebApp: h.bridge } };
  Object.defineProperty(scope, 'localStorage', { get() { throw new Error('NO_STORAGE'); } });
  Object.defineProperty(scope, 'sessionStorage', { get() { throw new Error('NO_STORAGE'); } });
  assert.equal(readTelegramBridge(scope), h.bridge);
  assert.equal(readTelegramBridge({}), undefined);
  assert.equal(readTelegramBridge(undefined), undefined);
});

test('snapshot and observer notifications expose no launch or opaque proofs', async () => {
  const h = harness(); let calls = 0; const stop = h.runtime.subscribe(() => { calls++; });
  await h.runtime.start(); const value = JSON.stringify(h.runtime.getSnapshot());
  for (const secret of [rawA, 'synthetic-access-', 'synthetic-refresh-']) assert(!value.includes(secret));
  assert(calls >= 2); stop(); h.runtime.dispose();
});

test('production configuration never relaxes HTTPS, endpoint or contract pins', () => {
  for (const apiBaseUrl of ['http://127.0.0.1:8789/api/v1', '/api/v1', 'https://api.example.test/other',
    'https://proof@local.invalid/api/v1', 'https://api.example.test/api/v1?proof=synthetic']) {
    assert.throws(() => createTelegramBootstrap({ apiBaseUrl, contractSha256: STUDENT_CONTRACT_SHA256,
      readBridge: () => undefined, createConnection: () => { throw new Error('NOT_CALLED'); } }),
    error => error.code === 'API_ENDPOINT_INVALID');
  }
  assert.throws(() => createTelegramBootstrap({ apiBaseUrl: 'https://api.example.test/api/v1', contractSha256: 'wrong',
    readBridge: () => undefined, createConnection: () => {} }), error => error.code === 'CONTRACT_HASH_MISMATCH');
});

test('a singleton connection cannot be reused after logout for a new launch', async () => {
  const h = harness({ reuseConnection: true }); await h.runtime.start(); await h.runtime.logout();
  h.bridge.initData = rawB;
  await assert.rejects(h.runtime.start(), error => error.code === 'PRODUCTION_CONNECTION_REUSED');
  assert.equal(h.calls.filter(call => call.path === '/auth/telegram').length, 1);
});

test('a constructor cannot silently restore a preauthenticated proof context', async () => {
  const h = harness(); const existing = await h.runtime.start();
  const runtime = createTelegramBootstrap({ apiBaseUrl: 'https://api.example.test/api/v1',
    contractSha256: STUDENT_CONTRACT_SHA256, readBridge: () => h.bridge,
    createConnection: () => h.connections[0] });
  await assert.rejects(runtime.start(), error => error.code === 'PRODUCTION_CONNECTION_REUSED');
  assert.equal(existing.state.student.person, id(8));
});

test('a synchronous owner logout hook throw is handled by the returned rejection', async () => {
  let person = null;
  const port = { profile: async () => ({ person: id(8), firstName: 'Suniy', lastName: 'Hook',
    displayId: '0000000001', registrationComplete: true }), exams: async () => [],
    register: async () => {}, current: async () => null, start: async () => {}, save: async () => {},
    submit: async () => {}, result: async () => null, history: async () => [] };
  const runtime = createTelegramBootstrap({ apiBaseUrl: 'https://api.example.test/api/v1',
    contractSha256: STUDENT_CONTRACT_SHA256, readBridge: () => ({ initData: rawA }),
    createConnection: () => ({ port, auth: { login: async () => { person = id(8); return person; },
      person: () => person, logout: () => { throw new Error(rawA); } } }) });
  await runtime.start();
  await assert.rejects(runtime.logout(), error => error.code === 'UNCONFIRMED' && !error.message.includes(rawA));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.getSnapshot().flow, null);
});

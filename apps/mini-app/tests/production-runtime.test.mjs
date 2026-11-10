import test from 'node:test';
import assert from 'node:assert/strict';
import { readProductionConfig, createProductionApiTransport, prepareTelegramEntry } from '../src/production-runtime.ts';
import { STUDENT_CONTRACT_SHA256, createLocalStudentClient, createProductionStudentClient } from '../src/owner-client/student-client.ts';

const env = { VITE_MINI_APP_ORIGIN: 'https://app.invalid', VITE_API_ORIGIN: 'https://api.example.test',
  VITE_STUDENT_CONTRACT_SHA256: STUDENT_CONTRACT_SHA256 };
const config = () => readProductionConfig(env, env.VITE_MINI_APP_ORIGIN);
const code = expected => error => error.code === expected;

test('explicit HTTPS origins produce the pinned /api/v1 boundary without credentials', () => {
  assert.deepEqual(config(), { appOrigin: 'https://app.invalid', apiOrigin: 'https://api.example.test',
    apiBaseUrl: 'https://api.example.test/api/v1', contractSha256: STUDENT_CONTRACT_SHA256 });
  assert(Object.isFrozen(config()));
});
for (const origin of [undefined, '', ' https://api.example.test', 'http://localhost', '//local.invalid',
  'https://user:synthetic@local.invalid', 'https://api.example.test/api/v1', 'https://api.example.test/?q=1', 'https://api.example.test/#x', 'https://lo\ncal.invalid', 'https://api.example.test\\' ]) {
  test(`invalid public API origin is rejected before connection (${JSON.stringify(origin)})`, () => {
    assert.throws(() => readProductionConfig({ ...env, VITE_API_ORIGIN: origin }, env.VITE_MINI_APP_ORIGIN), code('ORIGIN_CONFIG_INVALID'));
  });
}
test('page origin mismatch and stale contract pin fail before SDK identity is read', () => {
  assert.throws(() => readProductionConfig(env, 'https://different.invalid'), code('APP_ORIGIN_MISMATCH'));
  assert.throws(() => readProductionConfig({ ...env, VITE_STUDENT_CONTRACT_SHA256: 'old' }, env.VITE_MINI_APP_ORIGIN), code('CONTRACT_HASH_MISMATCH'));
});
test('uncomposed entry helper requires a Backend production factory; it has no global or local-client fallback', () => {
  const scope = { get Telegram() { throw new Error('MUST_NOT_BE_READ_WITHOUT_CONNECTOR'); },
    __UA_SYNTHETIC_INIT_DATA__: 'synthetic-unused' };
  assert.throws(() => prepareTelegramEntry({ env, pageOrigin: env.VITE_MINI_APP_ORIGIN, scope }), code('PRODUCTION_CONNECTION_REQUIRED'));
  assert.throws(() => createLocalStudentClient({ mode: 'production', contractSha256: STUDENT_CONTRACT_SHA256,
    baseUrl: config().apiBaseUrl, transport: async () => new Response() }), error => error.message === 'DRAFT_CLIENT_LOCAL_ONLY');
});
test('owner-built mutation preserves body/key/auth/signal while enforcing cross-origin request flags', async () => {
  let observed;
  const fetcher = function(request) { assert.equal(this, undefined); observed = request; return Promise.resolve(new Response('{}')); };
  const send = createProductionApiTransport(config(), fetcher);
  const abort = new AbortController();
  const request = new Request('https://api.example.test/api/v1/attempts/synthetic/submit', { method: 'POST', signal: abort.signal,
    headers: { authorization: 'Bearer synthetic-access', 'idempotency-key': 'synthetic-key', 'content-type': 'application/json' }, body: '{"synthetic":true}' });
  await send(request);
  assert.equal(observed.mode, 'cors'); assert.equal(observed.credentials, 'omit');
  assert.equal(observed.cache, 'no-store'); assert.equal(observed.redirect, 'error');
  assert.equal(observed.headers.get('authorization'), 'Bearer synthetic-access');
  assert.equal(observed.headers.get('idempotency-key'), 'synthetic-key');
  assert.equal(await observed.text(), '{"synthetic":true}');
  abort.abort(); assert(observed.signal.aborted);
});
test('body-only owner logout gains no Authorization, refresh or hidden retry', async () => {
  const calls = [];
  const send = createProductionApiTransport(config(), async request => { calls.push(request); throw new Error('Synthetic offline'); });
  await assert.rejects(send(new Request('https://api.example.test/api/v1/auth/logout', { method: 'POST',
    body: '{"refresh_token":"synthetic-refresh"}', headers: { 'content-type': 'application/json' } })));
  assert.equal(calls.length, 1); assert.equal(calls[0].headers.has('authorization'), false);
});
for (const [url, method] of [['https://else.invalid/api/v1/me', 'GET'], ['https://api.example.test/admin', 'POST'],
  ['https://api.example.test/api/v10/me', 'GET'], ['http://local.invalid/api/v1/me', 'GET'],
  ['https://api.example.test/api/v1/me#hidden', 'GET'], ['https://api.example.test/api/v1/me', 'DELETE']]) {
  test(`request boundary rejects ${method} ${url}`, async () => {
    let calls = 0; const send = createProductionApiTransport(config(), async () => { calls++; return new Response(); });
    await assert.rejects(send(new Request(url, { method })), code('API_REQUEST_OUT_OF_SCOPE')); assert.equal(calls, 0);
  });
}
test('owner client executes the prepared transport with an injected response; no native network', async () => {
  const calls = [];
  const transport = createProductionApiTransport(config(), async request => { calls.push(request); return new Response('{"data":[]}'); });
  // Real pinned production constructor with an injected synthetic Response, no network.
  const client = createProductionStudentClient({ mode: 'production', baseUrl: config().apiBaseUrl,
    contractSha256: STUDENT_CONTRACT_SHA256, transport });
  assert.deepEqual(await client.exams('synthetic-access'), { data: [] });
  assert.equal(calls[0].url, 'https://api.example.test/api/v1/exams'); assert.equal(calls[0].mode, 'cors');
});

for (const host of ['localhost', '127.0.0.2', '[::1]', 'local.invalid', 'invalid']) {
  test(`owner production destination policy rejects ${host} before bridge/I/O`, () => {
    assert.throws(() => readProductionConfig({ ...env, VITE_API_ORIGIN: 'https://' + host }, env.VITE_MINI_APP_ORIGIN), code('API_ENDPOINT_INVALID'));
  });
}

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hasTelegramLaunchContext, readTelegramBridge } from '../src/telegram-bootstrap.ts';
import { createTelegramReturnLaunch } from '../src/telegram-return-launch.ts';
import { createCommonProductionRuntime, readCommonEntryConfig } from '../src/common-production-runtime.ts';
import { STUDENT_CONTRACT_SHA256 } from '../src/owner-client/student-client.ts';
import { fakeClerkSdk } from './fixtures/clerk-sdk.fixture.mjs';

// Official SDK defaults outside Telegram are platform="unknown", initData="".
// Synthetic surfaces/transports only: no SDK download, provider or live account.
const sdkDefault = () => ({ platform: 'unknown', initData: '' });
const scopeOf = bridge => bridge ? { Telegram: { WebApp: bridge } } : {};
const config = readCommonEntryConfig({
  VITE_MINI_APP_ORIGIN: 'https://app.example.test', VITE_API_ORIGIN: 'https://api.example.test',
  VITE_STUDENT_CONTRACT_SHA256: STUDENT_CONTRACT_SHA256,
  VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_' + btoa('clerk.example.test$'),
  VITE_CLERK_FRONTEND_ORIGIN: 'https://clerk.example.test', VITE_TELEGRAM_SDK_ENABLED: 'true',
}, 'https://app.example.test');
const person = '00000000-0000-4000-8000-000000000001';
const profile = { person_id: person, first_name: 'Synthetic', last_name: 'Browser',
  qadam_id: '0000000001', roles: ['student'], active_group_id: null, registration_complete: true };
const json = data => new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
let nativeFetch, outbound = 0;
before(() => { nativeFetch = globalThis.fetch; globalThis.fetch = () => { outbound++; throw Error('NETWORK_FORBIDDEN'); }; });
after(() => { globalThis.fetch = nativeFetch; assert.equal(outbound, 0); });

function harness(bridge, { rejectTelegram = false } = {}) {
  const scope = scopeOf(bridge), webview = hasTelegramLaunchContext(scope), requests = [];
  let proofs = 0;
  const sdk = fakeClerkSdk({ token: async () => 'e30.' + btoa(JSON.stringify({ sequence: ++proofs })).replace(/=/g, '') + '.c2ln' });
  sdk.setSession(sdk.makeSession('sess_SyntheticContext'));
  const launch = config.telegramEnabled && webview ? createTelegramReturnLaunch(() => readTelegramBridge(scope)) : undefined;
  const send = async request => {
    const item = { path: new URL(request.url).pathname, method: request.method,
      auth: request.headers.get('authorization'), body: request.method === 'GET' ? undefined : await request.json() };
    requests.push(item);
    if (item.path.includes('/auth/telegram/') && rejectTelegram)
      return new Response(JSON.stringify({ error: { code: 'INIT_DATA_INVALID', request_id: 'synthetic' } }),
        { status: 401, headers: { 'content-type': 'application/json' } });
    if (item.path === '/api/v1/auth/clerk' || item.path === '/api/v1/auth/telegram/resume')
      return json({ token_type: 'Bearer', access_token: 'synthetic-access', refresh_token: 'synthetic-refresh',
        expires_at: '2035-01-01T00:00:00.000Z', refresh_expires_at: '2035-01-02T00:00:00.000Z', profile });
    if (item.path === '/api/v1/auth/telegram/link' || item.path === '/api/v1/auth/logout') return json({ ok: true });
    if (item.path === '/api/v1/me') return json(profile);
    if (item.path === '/api/v1/exams') return json([]);
    throw Error('UNEXPECTED_SYNTHETIC_REQUEST');
  };
  return { scope, webview, launch, requests, runtime: createCommonProductionRuntime(config, sdk.sdk,
    webview ? 'telegram_webview' : 'browser', send, { launch }) };
}

for (const [name, bridge, expected] of [
  ['no SDK', undefined, false], ['official ordinary-browser default', sdkDefault(), false],
  ['known Telegram platform with empty proof', { platform: 'ios', initData: '' }, true],
  ['known Telegram platform with missing proof', { platform: 'android' }, true],
  ['ambiguous bridge with no platform', { initData: '' }, true],
  ['unknown platform with nonempty unverified proof', { platform: 'unknown', initData: 'unverified' }, true],
  ['unknown platform with whitespace proof', { platform: 'unknown', initData: ' ' }, true],
  ['unknown platform with malformed proof', { platform: 'unknown', initData: { id: 42 } }, true],
]) test('entry classification: ' + name, () => assert.equal(hasTelegramLaunchContext(scopeOf(bridge)), expected));

test('entry classification never reads unsafe Telegram identity', () => {
  const bridge = sdkDefault();
  Object.defineProperty(bridge, 'initDataUnsafe', { get() { throw Error('UNSAFE_IDENTITY_FORBIDDEN'); } });
  assert.equal(hasTelegramLaunchContext(scopeOf(bridge)), false);
  bridge.initData = 'unverified';
  assert.equal(hasTelegramLaunchContext(scopeOf(bridge)), true);
});

for (const path of ['/', '/sign-in']) test('SDK-loaded ordinary browser can use Clerk-only entry at ' + path, async () => {
  const h = harness(sdkDefault());
  assert.equal(h.webview, false); assert.equal(h.launch, undefined);
  if (path === '/') { await h.runtime.resumeSession(); assert.deepEqual(h.requests, []); }
  await h.runtime.continueSession();
  assert.equal(h.runtime.snapshot().step, 'ready');
  assert.equal(h.runtime.snapshot().flow.state.student.person, person);
  assert.deepEqual(h.requests.map(r => r.path), ['/api/v1/auth/clerk', '/api/v1/me', '/api/v1/exams']);
  assert.equal(h.requests.some(r => r.path.includes('/auth/telegram')), false);
});

for (const [name, bridge] of [
  ['known platform, empty proof', { platform: 'ios', initData: '' }],
  ['known platform, missing proof', { platform: 'android' }],
  ['ambiguous bridge, empty proof', { initData: '' }],
]) for (const action of ['resumeSession', 'continueSession']) test(name + ' stays fail-closed on ' + action, async () => {
  const currentBridge = { ...bridge };
  const h = harness(currentBridge); await h.runtime[action]();
  assert.equal(h.webview, true); assert.equal(h.launch.phase(), 'failed');
  assert.equal(h.runtime.snapshot().flow, null); assert.deepEqual(h.requests, []);
  // A later local change to SDK defaults cannot downgrade the already-created
  // launch into a Clerk-only flow or authorize retry with the missing proof.
  currentBridge.platform = 'unknown'; currentBridge.initData = '';
  await h.runtime.continueSession();
  assert.equal(h.launch.phase(), 'failed'); assert.deepEqual(h.requests, []);
});

test('nonempty proof on unknown platform is submitted to Backend and its rejection blocks entry', async () => {
  const h = harness({ platform: 'unknown', initData: 'NOT_A_SIGNED_PROOF' }, { rejectTelegram: true });
  await h.runtime.resumeSession();
  assert.equal(h.launch.phase(), 'failed'); assert.equal(h.runtime.snapshot().flow, null);
  assert.deepEqual(h.requests, [{ path: '/api/v1/auth/telegram/resume', method: 'POST', auth: null,
    body: { init_data: 'NOT_A_SIGNED_PROOF' } }]);
});

test('known Telegram launch preserves exchange and link before cabinet admission', async () => {
  const h = harness({ platform: 'tdesktop', initData: 'SYNTHETIC_UNVERIFIED_LAUNCH' });
  await h.runtime.continueSession();
  assert.equal(h.launch.phase(), 'linked'); assert.equal(h.runtime.snapshot().step, 'ready');
  assert.deepEqual(h.requests.map(r => r.path), ['/api/v1/auth/clerk', '/api/v1/auth/telegram/link', '/api/v1/me', '/api/v1/exams']);
  assert.deepEqual(h.requests[1].body, { init_data: 'SYNTHETIC_UNVERIFIED_LAUNCH' });
  assert.notEqual(h.requests[1].auth, h.requests[0].auth);
});

test('production prebuilt entry uses the tested context classifier', async () => {
  const source = await readFile(new URL('../src/clerk-prebuilt-entry.tsx', import.meta.url), 'utf8');
  assert.match(source, /const webview = hasTelegramLaunchContext\(scope\);/);
  assert.doesNotMatch(source, /const webview = !!readTelegramBridge\(scope\);/);
});

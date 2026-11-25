import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createTelegramBrowserLinkClient, TELEGRAM_BROWSER_LINK_CONTRACT_SHA256 } from '../src/telegram-browser-link-client.ts';
import { StudentApiError, StudentClientProtocolError } from '../src/owner-client/student-client.ts';

const contract = readFileSync(new URL('../../../contracts/telegram-browser-link.review.openapi.json', import.meta.url));
const JWT = 'aaa.bbb.ccc', BODY = { code: 'abcdefgh12345', code_verifier: 'v'.repeat(43) };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function client(reply, extra = {}) {
  const calls = [];
  const transport = async request => { calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text(), credentials: request.credentials, redirect: request.redirect }); return typeof reply === 'function' ? reply() : reply; };
  return { calls, api: createTelegramBrowserLinkClient({ baseUrl: 'https://api.example.org/api/v1', transport, contractSha256: TELEGRAM_BROWSER_LINK_CONTRACT_SHA256, ...extra }) };
}
const isProtocol = e => e instanceof StudentClientProtocolError;

test('the client is pinned to the reviewed contract file', () => {
  assert.equal(TELEGRAM_BROWSER_LINK_CONTRACT_SHA256, createHash('sha256').update(contract).digest('hex'));
  assert.throws(() => createTelegramBrowserLinkClient({ baseUrl: 'https://api.example.org/api/v1', transport: async () => json({}), contractSha256: 'f'.repeat(64) }), isProtocol);
  const spec = JSON.parse(contract), operation = spec.paths['/api/v1/auth/telegram/browser-link'].post;
  assert.deepEqual(operation.requestBody.content['application/json'].schema.required, ['code', 'code_verifier']);
});
test('one POST with the Clerk proof in the header and only the code and verifier in the body', async () => {
  const { calls, api } = client(json({ data: { ok: true } }));
  assert.deepEqual(await api.link(JWT, BODY), { ok: true });
  assert.equal(calls.length, 1); const [call] = calls;
  assert.equal(call.url, 'https://api.example.org/api/v1/auth/telegram/browser-link'); assert.equal(call.method, 'POST');
  assert.equal(call.headers.authorization, 'Bearer ' + JWT); assert.equal(call.credentials, 'omit'); assert.equal(call.redirect, 'error');
  assert.deepEqual(JSON.parse(call.body), BODY); assert(!call.url.includes(BODY.code));
});
test('server rejections keep their status and code', async () => {
  for (const [status, code] of [[401, 'INIT_DATA_INVALID'], [409, 'IDENTITY_LINK_CONFLICT'], [409, 'INIT_DATA_REPLAY'], [503, 'SERVICE_UNAVAILABLE'], [403, 'FORBIDDEN']]) {
    const { api } = client(json({ error: { code, message: code, request_id: 'r' } }, status));
    await assert.rejects(api.link(JWT, BODY), e => e instanceof StudentApiError && e.status === status && e.code === code);
  }
});
test('anything unexpected is a protocol problem, a lost connection is reported as unconfirmed, nothing is retried', async () => {
  for (const reply of [json({ data: { ok: false } }), json({ data: { ok: true, extra: 1 } }), json({ ok: true }), json({}), json({ data: { ok: true } }, 201),
    new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }), new Response('{bad', { status: 200, headers: { 'content-type': 'application/json' } })]) {
    const { calls, api } = client(reply); await assert.rejects(api.link(JWT, BODY), isProtocol); assert.equal(calls.length, 1);
  }
  const { calls, api } = client(() => { throw new TypeError('network'); });
  await assert.rejects(api.link(JWT, BODY), e => isProtocol(e) && e.message === 'CLIENT_REQUEST_UNCONFIRMED'); assert.equal(calls.length, 1);
  const bad = client(json({ error: { code: 'lowercase' } }, 400)); await assert.rejects(bad.api.link(JWT, BODY), isProtocol);
});
test('malformed input never reaches the network', async () => {
  const { calls, api } = client(json({ data: { ok: true } }));
  for (const [jwt, input] of [['x', BODY], ['a.b', BODY], [JWT, {}], [JWT, { code: 'short', code_verifier: BODY.code_verifier }], [JWT, { code: BODY.code, code_verifier: 'tooshort' }],
    [JWT, { ...BODY, extra: 1 }], [JWT, null], [JWT, { code: 'has space in', code_verifier: BODY.code_verifier }], ['a.b.c'.repeat(6000), BODY]])
    await assert.rejects(api.link(jwt, input), isProtocol);
  assert.equal(calls.length, 0);
});
test('only the HTTPS production API base is accepted', () => {
  for (const baseUrl of ['http://api.example.org/api/v1', 'https://api.example.org/other', 'https://u:p@api.example.org/api/v1', 'https://api.example.org/api/v1?x=1', 'nope'])
    assert.throws(() => createTelegramBrowserLinkClient({ baseUrl, transport: async () => json({}), contractSha256: TELEGRAM_BROWSER_LINK_CONTRACT_SHA256 }), isProtocol);
});

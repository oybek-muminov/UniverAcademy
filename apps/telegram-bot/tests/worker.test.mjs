import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker, { createBotWorker, readAuthUrl } from '../src/worker.mjs';

// All identities and the webhook secret below are fixed offline fixtures.
const AUTH_URL = 'https://quick-zebra-3590.accounts.dev/sign-in';
const SECRET = 'offline_webhook_fixture_not_a_secret';
const BASE = 'https://worker.example.org/telegram/webhook';
let realFetch;
let forbiddenCalls = 0;
before(() => { realFetch = globalThis.fetch; globalThis.fetch = () => {
  forbiddenCalls++; throw new Error('Outbound calls are forbidden in this stateless suite');
}; });
after(() => { globalThis.fetch = realFetch; assert.equal(forbiddenCalls, 0); });
function fixture() {
  return { app: createBotWorker(), env: { AUTH_SIGN_IN_URL: AUTH_URL, TELEGRAM_WEBHOOK_SECRET: SECRET } };
}
const start = (id = 1, text = '/start') => ({ update_id: id, message: {
  message_id: 7, from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, text,
} });
function request(update = start(), { url = BASE, method = 'POST', headers = {}, raw } = {}) {
  return new Request(url, { method, headers: {
    'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET, ...headers,
  }, ...(['GET', 'HEAD'].includes(method) ? {} : { body: raw ?? JSON.stringify(update) }) });
}
async function rejected(f, req, status, code) {
  const response = await f.app.fetch(req, f.env);
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error: { code } });
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(forbiddenCalls, 0);
  return response;
}
async function ignored(update) {
  const f = fixture();
  const response = await f.app.fetch(request(update), f.env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(forbiddenCalls, 0);
  return f;
}
const expectedAction = { method: 'sendMessage', chat_id: 42,
  text: 'Assalomu alaykum! UniverAcademy’ga xush kelibsiz.\n\nHisobingiz bo‘lsa kiring, yangi foydalanuvchi bo‘lsangiz ro‘yxatdan o‘ting. Quyidagi tugma Clerk kirish oynasini ochadi.',
  reply_markup: { inline_keyboard: [[{ text: 'Kirish / Ro‘yxatdan o‘tish', web_app: { url: AUTH_URL } }]] },
};
test('pristine private-human /start returns one fixed webhook-reply action, not a delivery confirmation', async () => {
  const f = fixture();
  const response = await f.app.fetch(request(), f.env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(await response.json(), expectedAction);
  assert.equal(forbiddenCalls, 0);
});

for (const text of ['/start@univeracademybot', '/start@UniverAcademyBot', '/start payload_123']) {
  test(`recognized command ${text} never echoes the payload`, async () => {
    const f = fixture();
    const r = await f.app.fetch(request(start(1, text)), f.env);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), expectedAction);
  });
}
for (const text of ['/help', '/stop', '/starter', '/START', '/START@univeracademybot',
  '/start@otherbot', '/start ', '/start two words', '/start <script>', ' /start', '/start\n', '/start ' + 'x'.repeat(65)]) {
  test(`unsupported command/text ignored: ${JSON.stringify(text)}`, () => ignored(start(1, text)));
}
for (const [name, mutate] of [
  ['group', u => { u.message.chat.type = 'group'; u.message.chat.id = -42; }],
  ['supergroup', u => { u.message.chat.type = 'supergroup'; }],
  ['channel', u => { u.message.chat.type = 'channel'; }],
  ['future chat type', u => { u.message.chat.type = 'future'; }],
  ['bot sender', u => { u.message.from.is_bot = true; }],
  ['unconfirmed human', u => { delete u.message.from.is_bot; }],
  ['missing sender', u => { delete u.message.from; }],
  ['mismatched private peer', u => { u.message.chat.id = 43; }],
  ['zero private peer', u => { u.message.chat.id = 0; }],
  ['photo without text', u => { delete u.message.text; u.message.photo = []; }],
  ['service message', u => { delete u.message.text; u.message.new_chat_members = []; }],
]) {
  test(`nonpilot update ignored: ${name}`, () => { const u = start(); mutate(u); return ignored(u); });
}
for (const field of ['business_connection_id', 'guest_query_id', 'sender_chat', 'forward_origin',
  'forward_from', 'forward_from_chat', 'forward_sender_name', 'forward_date', 'is_automatic_forward', 'via_bot', 'via_business_bot']) {
  for (const location of ['update', 'message']) {
    test(`${location}.${field} context never sends or binds`, () => {
      const u = start(); (location === 'update' ? u : u.message)[field] = false;
      return ignored(u);
    });
  }
}
for (const update of [{ update_id: 0 }, { update_id: 2, channel_post: {} },
  { update_id: 3, edited_message: start().message }, { update_id: 4, callback_query: {} },
  { update_id: 5, my_chat_member: {} }, { update_id: 6, future_provider_type: { any: 'content' } }]) {
  test(`forward-compatible irrelevant update ${update.update_id} empty ACK, no action`, () => ignored(update));
}

for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) {
  test(`${method} rejected before body or action`, async () => {
    const f = fixture();
    const response = await rejected(f, request(start(), { method }), 405, 'METHOD_NOT_ALLOWED');
    assert.equal(response.headers.get('Allow'), 'POST');
  });
}
for (const suffix of ['/', '?token=never-log', '/extra', '%2f', '?x=1', '#x']) {
  test(`noncanonical route ${suffix} rejected`, () => rejected(fixture(), request(start(), { url: BASE + suffix }), 404, 'NOT_FOUND'));
}
test('HTTP route rejected', () => rejected(fixture(), request(start(), { url: BASE.replace('https:', 'http:') }), 400, 'HTTPS_REQUIRED'));
for (const secret of ['', 'wrong', 'x'.repeat(257), 'bad value']) {
  test(`wrong/invalid webhook secret (${secret.length}) rejected before malformed body`, () =>
    rejected(fixture(), request(null, { raw: '{', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret } }), 401, 'UNAUTHORIZED'));
}
test('missing secret rejected', async () => {
  const r = request(); r.headers.delete('X-Telegram-Bot-Api-Secret-Token');
  await rejected(fixture(), r, 401, 'UNAUTHORIZED');
});
for (const value of [undefined, '', 'bad secret', 'x'.repeat(257)]) {
  test(`invalid configured secret fails closed (${String(value).length})`, () => {
    const f = fixture(); f.env.TELEGRAM_WEBHOOK_SECRET = value;
    return rejected(f, request(), 503, 'BOT_NOT_CONFIGURED');
  });
}
for (const contentType of ['', 'text/plain', 'application/json; charset=latin1', 'application/jsonp']) {
  test(`wrong MIME ${contentType} rejected`, () => rejected(fixture(), request(start(), { headers: { 'Content-Type': contentType } }), 415, 'UNSUPPORTED_CONTENT_TYPE'));
}
test('JSON UTF-8 MIME allowed', async () => {
  const f = fixture(); assert.equal((await f.app.fetch(request(start(), { headers: { 'Content-Type': 'application/json; charset=utf-8' } }), f.env)).status, 200);
});
test('encoded body not accepted', () => rejected(fixture(), request(start(), { headers: { 'Content-Encoding': 'gzip' } }), 415, 'UNSUPPORTED_CONTENT_TYPE'));
for (const length of ['65537', '9999999999999999999999', '-1', 'NaN']) {
  test(`invalid/large declared body ${length} rejected`, () => rejected(fixture(), request(start(), { headers: { 'Content-Length': length } }), 413, 'BODY_TOO_LARGE'));
}
test('actual UTF-8 byte limit enforced without trusting declared length', () => rejected(fixture(), request(null, { raw: 'é'.repeat(32769), headers: { 'Content-Length': '1' } }), 413, 'BODY_TOO_LARGE'));
test('streamed chunk overflow rejected', async () => {
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(32000)); c.enqueue(new Uint8Array(34000)); c.close(); } });
  const r = new Request(BASE, { method: 'POST', headers: request().headers, body, duplex: 'half' });
  await rejected(fixture(), r, 413, 'BODY_TOO_LARGE');
});
for (const raw of ['', '{', '{}\n{}', 'nullx']) {
  test(`malformed JSON ${JSON.stringify(raw)} rejected`, () => rejected(fixture(), request(null, { raw }), 400, 'MALFORMED_JSON'));
}
test('invalid UTF-8 rejected', () => rejected(fixture(), request(null, { raw: new Uint8Array([0xff]) }), 400, 'MALFORMED_JSON'));
for (const value of [null, [], {}, { update_id: -1 }, { update_id: 1.5 }, { update_id: '1' }, { update_id: 2 ** 53 }]) {
  test(`invalid update envelope ${JSON.stringify(value)}`, () => rejected(fixture(), request(value), 422, 'INVALID_UPDATE'));
}
for (const [name, mutate] of [
  ['message null', u => { u.message = null; }],
  ['message id', u => { delete u.message.message_id; }],
  ['chat null', u => { u.message.chat = null; }],
  ['chat id', u => { u.message.chat.id = '42'; }],
  ['chat type', u => { u.message.chat.type = null; }],
  ['text object', u => { u.message.text = {}; }],
  ['sender array', u => { u.message.from = []; }],
  ['sender id', u => { u.message.from.id = 0; }],
  ['sender bot type', u => { u.message.from.is_bot = 'false'; }],
]) {
  test(`invalid recognized message shape ${name}`, () => { const u = start(); mutate(u); return rejected(fixture(), request(u), 422, 'INVALID_UPDATE'); });
}

for (const url of [undefined, '', 'http://auth.example.org/sign-in', 'https://user:pass@auth.example.org/sign-in',
  'https://auth.example.org:8443/sign-in', 'https://auth.example.org/sign-in?redirect=evil',
  'https://auth.example.org/sign-in#secret', 'https://auth.example.org/sign-up', 'https://auth.example.org/sign-in/',
  'https://localhost/sign-in', 'https://auth.local/sign-in', 'https://127.0.0.1/sign-in',
  'https://[::1]/sign-in', 'https://auth.invalid/sign-in', 'https://auth.example.org/%73ign-in',
  'https://AUTH.example.org/sign-in', ' https://auth.example.org/sign-in', 'https://auth.example.org\\sign-in']) {
  test(`invalid auth URL fails closed ${JSON.stringify(url)}`, () => {
    const f = fixture(); f.env.AUTH_SIGN_IN_URL = url;
    return rejected(f, request(), 503, 'BOT_NOT_CONFIGURED');
  });
}
test('public production replacement is configuration-only', async () => {
  assert.equal(readAuthUrl('https://auth.univeracademy.uz/sign-in'), 'https://auth.univeracademy.uz/sign-in');
  const f = fixture(); f.env.AUTH_SIGN_IN_URL = 'https://auth.univeracademy.uz/sign-in';
  const response = await f.app.fetch(request(), f.env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reply_markup.inline_keyboard[0][0].web_app.url, f.env.AUTH_SIGN_IN_URL);
});
test('sequential duplicate update_id deliberately returns identical greetings', async () => {
  const f = fixture();
  const first = await f.app.fetch(request(), f.env);
  const second = await f.app.fetch(request(), f.env);
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.deepEqual(await first.json(), expectedAction);
  assert.deepEqual(await second.json(), expectedAction);
});
test('concurrent duplicate update_id deliberately returns two identical actions', async () => {
  const f = fixture();
  const responses = await Promise.all([f.app.fetch(request(), f.env), f.app.fetch(request(), f.env)]);
  for (const r of responses) { assert.equal(r.status, 200); assert.deepEqual(await r.json(), expectedAction); }
});
test('new worker instance repeats greeting without a dedupe/storage dependency', async () => {
  const a = fixture(), b = fixture();
  for (const f of [a, b]) assert.deepEqual(await (await f.app.fetch(request(), f.env)).json(), expectedAction);
});
test('duplicate unsupported updates always return empty ACKs', async () => {
  await ignored({ update_id: 1, callback_query: {} });
  await ignored({ update_id: 1, callback_query: {} });
});
test('no token, storage binding or outbound fetch is read or used', async () => {
  const f = fixture(); const accessed = [];
  const env = new Proxy(f.env, { get(target, key) {
    accessed.push(key);
    if (!['TELEGRAM_WEBHOOK_SECRET', 'AUTH_SIGN_IN_URL'].includes(key)) throw new Error('Forbidden storage/credential access');
    return target[key];
  } });
  const r = await worker.fetch(request(), env);
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), expectedAction);
  assert.deepEqual(accessed, ['TELEGRAM_WEBHOOK_SECRET', 'AUTH_SIGN_IN_URL']);
  assert.equal(forbiddenCalls, 0);
});
test('ignored authenticated update needs no auth URL, token or storage', async () => {
  const env = new Proxy({ TELEGRAM_WEBHOOK_SECRET: SECRET }, { get(target, key) {
    if (key !== 'TELEGRAM_WEBHOOK_SECRET') throw new Error('Ignored update must not read action config');
    return target[key];
  } });
  const r = await worker.fetch(request({ update_id: 1 }), env);
  assert.equal(r.status, 200); assert.equal(await r.text(), '');
});
test('update URL/IDs/linking payload and bearer header never choose or decorate the button destination', async () => {
  const f = fixture(); const u = start(1, '/start LINKING_PAYLOAD');
  Object.assign(u, { AUTH_SIGN_IN_URL: 'https://evil.invalid/sign-in', token: 'UNTRUSTED_TOKEN', person_id: 'UNTRUSTED_PERSON', url: 'https://evil.invalid/' });
  Object.assign(u.message.from, { username: 'UNTRUSTED_NAME', first_name: 'NEVER_ECHO' });
  const r = await f.app.fetch(request(u, { headers: { Authorization: 'Bearer UNTRUSTED_BEARER' } }), f.env);
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), expectedAction);
});
test('validated private peer determines chat_id only, not greeting, URL or account binding', async () => {
  const f = fixture(); const u = start(); u.message.from.id = u.message.chat.id = 99;
  const r = await f.app.fetch(request(u), f.env);
  assert.deepEqual(await r.json(), { ...expectedAction, chat_id: 99 });
});
test('thrown config errors cannot reveal secrets or arbitrary error text', async () => {
  const f = fixture(); Object.defineProperty(f.env, 'AUTH_SIGN_IN_URL', { get() { throw new Error(SECRET + ' PRIVATE_ERROR'); } });
  await rejected(f, request(), 503, 'DEPENDENCY_UNAVAILABLE');
});
test('actual hanging body is bounded and returns no action', { timeout: 15000 }, async () => {
  const body = new ReadableStream({ start() {} });
  const r = new Request(BASE, { method: 'POST', headers: request().headers, body, duplex: 'half' });
  await rejected(fixture(), r, 503, 'DEPENDENCY_UNAVAILABLE');
});
test('legacy greeting remains a fixture; deployment explicitly selects lookup-first entry with no token/storage requirement', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url), 'utf8'));
  assert.deepEqual(config, { name: 'univeracademy-bot', main: 'src/returning-worker.mjs', compatibility_date: '2026-11-11', keep_vars: true });
  const source = await readFile(new URL('../src/worker.mjs', import.meta.url), 'utf8');
  assert.ok(source.startsWith('// Stateless launcher; duplicate greetings permitted; delivery unconfirmed; no identity or business state changes.'));
});

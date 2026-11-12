import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker, { createReturningBotWorker, readMiniDestinations } from '../src/returning-worker.mjs';
import { lookupValidatedStart } from '../src/private-start-lookup.mjs';

// Synthetic identities/secret/URLs only. No host at these URLs is contacted.
const SECRET = 'offline_returning_webhook_fixture';
const CABINET = 'https://mini.example.org/';
const SIGN_IN = 'https://mini.example.org/sign-in';
const WEBHOOK = 'https://bot.example.org/telegram/webhook';
const start = (id = 42, updateId = 7) => ({ update_id: updateId, message: {
  message_id: 8, from: { id, is_bot: false }, chat: { id, type: 'private' }, text: '/start',
} });
function request(update = start(), { method = 'POST', url = WEBHOOK, headers = {}, raw } = {}) {
  return new Request(url, { method, headers: { 'Content-Type': 'application/json',
    'X-Telegram-Bot-Api-Secret-Token': SECRET, ...headers },
    ...(['GET', 'HEAD'].includes(method) ? {} : { body: raw ?? JSON.stringify(update) }) });
}
function fixture(status = 'linked') {
  const calls = [];
  return { calls, env: { TELEGRAM_WEBHOOK_SECRET: SECRET,
    TELEGRAM_START_LOOKUP: { lookupTelegramStart: async input => { calls.push(input); return { status }; } },
    MINI_CABINET_URL: CABINET, MINI_SIGN_IN_URL: SIGN_IN } };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let nativeFetch, outbound = 0;
before(() => { nativeFetch = globalThis.fetch; globalThis.fetch = () => { outbound++; throw new Error('OUTBOUND_FORBIDDEN'); }; });
after(() => { globalThis.fetch = nativeFetch; assert.equal(outbound, 0); });
async function noAction(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  if (code) assert.deepEqual(await response.json(), { error: { code } });
  else assert.equal(await response.text(), '');
}
for (const [status, label, url, text] of [
  ['linked', 'Kabinet', CABINET, 'Assalomu alaykum! UniverAcademy kabinetiga kirish uchun quyidagi tugmani bosing.'],
  ['needs_clerk', 'Kirish / Ro‘yxatdan o‘tish', SIGN_IN,
    'Assalomu alaykum! UniverAcademy’ga xush kelibsiz.\n\nHisobingiz bo‘lsa kiring, yangi foydalanuvchi bo‘lsangiz ro‘yxatdan o‘ting. Quyidagi tugma kirish oynasini ochadi.'],
]) {
  test(`${status} selects exactly one fixed navigation button, not an authentication/session grant`, async () => {
    const h = fixture(status), response = await worker.fetch(request(), h.env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { method: 'sendMessage', chat_id: 42, text,
      reply_markup: { inline_keyboard: [[{ text: label, web_app: { url } }]] } });
    assert.deepEqual(h.calls, [{ update_id: 7, telegram_user_id: 42 }]);
  });
}
test('disabled is acknowledged without a message/button, URL selection, session or new-user fallback', async () => {
  const h = fixture('disabled');
  for (const key of ['MINI_CABINET_URL', 'MINI_SIGN_IN_URL'])
    Object.defineProperty(h.env, key, { get() { throw new Error('URL_MUST_NOT_BE_READ'); } });
  await noAction(await worker.fetch(request(), h.env), 200);
  assert.equal(h.calls.length, 1);
});
test('lookup is the first application step and resolves before any greeting/destination response', async () => {
  const entered = deferred(), result = deferred(), events = [];
  const h = fixture();
  h.env.TELEGRAM_START_LOOKUP.lookupTelegramStart = input => {
    events.push(['lookup', input]); entered.resolve(); return result.promise;
  };
  for (const [key, value] of [['MINI_CABINET_URL', CABINET], ['MINI_SIGN_IN_URL', SIGN_IN]])
    Object.defineProperty(h.env, key, { get() { events.push(key); return value; } });
  let settled = false;
  const response = worker.fetch(request(), h.env).then(value => { settled = true; events.push('response'); return value; });
  await entered.promise;
  assert.equal(settled, false); assert.deepEqual(events, [['lookup', { update_id: 7, telegram_user_id: 42 }]]);
  result.resolve({ status: 'linked' });
  assert.equal((await response).status, 200);
  assert.deepEqual(events, [['lookup', { update_id: 7, telegram_user_id: 42 }], 'MINI_CABINET_URL', 'MINI_SIGN_IN_URL', 'response']);
});
for (const text of ['/start@univeracademybot', '/start@UniverAcademyBot', '/start inert_payload']) {
  test(`recognized ${text} uses only exact private numeric lookup fields`, async () => {
    const h = fixture(), update = start(); update.message.text = text;
    update.telegram_user_id = 99; update.person_id = 'forged'; update.url = 'https://evil.example.org/';
    update.message.from.first_name = 'not authoritative';
    const response = await worker.fetch(request(update), h.env); const body = await response.json();
    assert.deepEqual(h.calls, [{ update_id: 7, telegram_user_id: 42 }]);
    assert.equal(body.chat_id, 42); assert.equal(body.reply_markup.inline_keyboard[0][0].web_app.url, CABINET);
    assert(!JSON.stringify(body).includes('forged')); assert(!JSON.stringify(body).includes('inert_payload'));
  });
}
for (const [name, mutate] of [
  ['private identity mismatch', u => { u.message.from.id = 43; }],
  ['bot sender', u => { u.message.from.is_bot = true; }],
  ['unknown human', u => { delete u.message.from.is_bot; }],
  ['missing sender', u => { delete u.message.from; }],
  ['group', u => { u.message.chat.type = 'group'; }],
  ['forward', u => { u.message.forward_origin = {}; }],
  ['business', u => { u.message.business_connection_id = 'synthetic'; }],
  ['guest', u => { u.guest_query_id = 'synthetic'; }],
  ['sender chat', u => { u.message.sender_chat = {}; }],
  ['other command', u => { u.message.text = '/help'; }],
  ['other bot', u => { u.message.text = '/start@anotherbot'; }],
  ['unknown event', u => { delete u.message; u.callback_query = {}; }],
]) {
  test(`${name} makes zero private lookups and reads no destinations`, async () => {
    const h = fixture(), update = start(); mutate(update);
    for (const key of ['TELEGRAM_START_LOOKUP', 'MINI_CABINET_URL', 'MINI_SIGN_IN_URL'])
      Object.defineProperty(h.env, key, { get() { throw new Error('APPLICATION_STEP_FORBIDDEN'); } });
    await noAction(await worker.fetch(request(update), h.env), 200);
    assert.equal(h.calls.length, 0);
  });
}
for (const [name, make, status, code] of [
  ['wrong secret', () => request(start(), { headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' } }), 401, 'UNAUTHORIZED'],
  ['GET', () => request(start(), { method: 'GET' }), 405, 'METHOD_NOT_ALLOWED'],
  ['wrong path', () => request(start(), { url: WEBHOOK + '/' }), 404, 'NOT_FOUND'],
  ['public raw-ID lookup', () => request(start(), { url: WEBHOOK + '?telegram_id=42' }), 404, 'NOT_FOUND'],
  ['HTTP', () => request(start(), { url: WEBHOOK.replace('https:', 'http:') }), 400, 'HTTPS_REQUIRED'],
  ['wrong content type', () => request(start(), { headers: { 'Content-Type': 'text/plain' } }), 415, 'UNSUPPORTED_CONTENT_TYPE'],
  ['malformed JSON', () => request(start(), { raw: '{' }), 400, 'MALFORMED_JSON'],
  ['large declared body', () => request(start(), { headers: { 'Content-Length': '65537' } }), 413, 'BODY_TOO_LARGE'],
  ['unsafe update ID', () => request({ ...start(), update_id: Number.MAX_SAFE_INTEGER + 1 }), 422, 'INVALID_UPDATE'],
  ['invalid sender ID', () => { const u = start(); u.message.from.id = '42'; return request(u); }, 422, 'INVALID_UPDATE'],
]) {
  test(`${name} rejects before any lookup or URL read`, async () => {
    const h = fixture();
    for (const key of ['TELEGRAM_START_LOOKUP', 'MINI_CABINET_URL', 'MINI_SIGN_IN_URL'])
      Object.defineProperty(h.env, key, { get() { throw new Error('APPLICATION_STEP_FORBIDDEN'); } });
    const response = await worker.fetch(make(), h.env);
    if (status === 405) assert.equal(response.headers.get('Allow'), 'POST');
    await noAction(response, status, code); assert.equal(h.calls.length, 0);
  });
}
for (const value of ['linked', 'needs_clerk', 'disabled', null, undefined, true, [],
  { status: 'unknown' }, { state: 'linked' }, { status: 'linked', url: CABINET },
  { status: 'linked', person: 'forged' }, { status: 'linked', [Symbol('extra')]: 1 },
  new Response(null, { status: 503 }), { get status() { throw new Error(SECRET); } }]) {
  test(`malformed/503 lookup ${typeof value === 'string' ? value : 'shape'} cannot become a greeting/new user`, async () => {
    const h = fixture(); let calls = 0;
    h.env.TELEGRAM_START_LOOKUP.lookupTelegramStart = async () => { calls++; return value; };
    Object.defineProperty(h.env, 'MINI_SIGN_IN_URL', { get() { throw new Error('NO_URL_ON_FAILURE'); } });
    await noAction(await worker.fetch(request(), h.env), 503, 'NAVIGATION_LOOKUP_UNAVAILABLE');
    assert.equal(calls, 1);
  });
}
for (const binding of [undefined, null, {}, { lookupTelegramStart: true }]) {
  test('missing/noncallable binding returns503 with no stateless greeting fallback', async () => {
    const h = fixture(); h.env.TELEGRAM_START_LOOKUP = binding;
    await noAction(await worker.fetch(request(), h.env), 503, 'NAVIGATION_LOOKUP_UNAVAILABLE');
  });
}
test('RPC exception is redacted with no automatic retry or destination read', async () => {
  const h = fixture(); let calls = 0;
  h.env.TELEGRAM_START_LOOKUP.lookupTelegramStart = () => { calls++; throw new Error(SECRET + ' PRIVATE_SERVER_DETAIL'); };
  await noAction(await worker.fetch(request(), h.env), 503, 'NAVIGATION_LOOKUP_UNAVAILABLE');
  assert.equal(calls, 1);
});
test('throwing environment binding getter is redacted without using the legacy greeting', async () => {
  const h = fixture(); Object.defineProperty(h.env, 'TELEGRAM_START_LOOKUP', { get() { throw new Error(SECRET); } });
  await noAction(await worker.fetch(request(), h.env), 503, 'DEPENDENCY_UNAVAILABLE');
});
test('a changing thrown error-code getter is read once and cannot echo a secret', async () => {
  const h = fixture(); let reads = 0;
  const error = { get code() { return ++reads === 1 ? 'DEPENDENCY_UNAVAILABLE' : SECRET; }, status: 503 };
  Object.defineProperty(h.env, 'TELEGRAM_START_LOOKUP', { get() { throw error; } });
  await noAction(await worker.fetch(request(), h.env), 503, 'DEPENDENCY_UNAVAILABLE');
  assert.equal(reads, 1);
});
test('timeout returns503; late read-only result is ignored, with no fallback or retry', { timeout: 15000 }, async () => {
  const h = fixture(), late = deferred(); let calls = 0;
  h.env.TELEGRAM_START_LOOKUP.lookupTelegramStart = () => { calls++; return late.promise; };
  const response = await worker.fetch(request(), h.env);
  await noAction(response, 503, 'NAVIGATION_LOOKUP_UNAVAILABLE');
  late.resolve({ status: 'linked' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});
for (const [cabinet, signIn] of [
  [undefined, SIGN_IN], [CABINET, undefined], [CABINET, 'http://mini.example.org/sign-in'],
  [CABINET, SIGN_IN + '?init_data=forged'], [CABINET, SIGN_IN + '#token'],
  [CABINET, 'https://user:pass@mini.example.org/sign-in'], [CABINET, SIGN_IN + '/'],
  [CABINET, 'https://localhost/sign-in'], [CABINET, 'https://127.0.0.1/sign-in'],
  [CABINET, 'https://mini.example.org:8443/sign-in'], ['https://other.example.org/', SIGN_IN],
  [CABINET + 'cabinet', SIGN_IN], [SIGN_IN, SIGN_IN],
  ['https://quick-zebra-3590.accounts.dev/', 'https://quick-zebra-3590.accounts.dev/sign-in'],
]) {
  test(`invalid or Clerk-only destination ${cabinet ?? 'missing'} | ${signIn ?? 'missing'} fails closed AFTER lookup`, async () => {
    const h = fixture(); h.env.MINI_CABINET_URL = cabinet; h.env.MINI_SIGN_IN_URL = signIn;
    await noAction(await worker.fetch(request(), h.env), 503, 'BOT_NOT_CONFIGURED');
    assert.equal(h.calls.length, 1);
  });
}
test('fixed same-origin Mini routes are validated but not treated as deployed/authenticated proof', () => {
  assert.deepEqual(readMiniDestinations(CABINET, SIGN_IN), { cabinet: CABINET, signIn: SIGN_IN });
});
test('sequential duplicate updates repeat lookup/message, without a dedupe or delivery claim', async () => {
  const h = fixture(); const a = await worker.fetch(request(), h.env), b = await worker.fetch(request(), h.env);
  assert.deepEqual(await a.json(), await b.json()); assert.equal(h.calls.length, 2);
});
test('concurrent duplicate deliveries remain independent read-only lookups', async () => {
  const h = fixture('needs_clerk');
  const responses = await Promise.all([worker.fetch(request(), h.env), worker.fetch(request(), h.env)]);
  assert.deepEqual(await responses[0].json(), await responses[1].json()); assert.equal(h.calls.length, 2);
});
test('parallel private users cannot exchange chat destinations through shared request state', async () => {
  const h = fixture(), first = deferred(), entered = deferred();
  h.env.TELEGRAM_START_LOOKUP.lookupTelegramStart = input => {
    h.calls.push(input); if (input.telegram_user_id === 42) { entered.resolve(); return first.promise; }
    return { status: 'needs_clerk' };
  };
  const a = worker.fetch(request(start(42, 7)), h.env); await entered.promise;
  const b = await worker.fetch(request(start(43, 8)), h.env); first.resolve({ status: 'linked' });
  const [bodyA, bodyB] = await Promise.all([(await a).json(), b.json()]);
  assert.equal(bodyA.chat_id, 42); assert.equal(bodyA.reply_markup.inline_keyboard[0][0].web_app.url, CABINET);
  assert.equal(bodyB.chat_id, 43); assert.equal(bodyB.reply_markup.inline_keyboard[0][0].web_app.url, SIGN_IN);
  assert.deepEqual(h.calls, [{ update_id: 7, telegram_user_id: 42 }, { update_id: 8, telegram_user_id: 43 }]);
});
test('production dispatcher reads no token/storage/legacy AUTH_SIGN_IN_URL and performs no outbound fetch', async () => {
  const h = fixture(); const allowed = new Set(['TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_START_LOOKUP', 'MINI_CABINET_URL', 'MINI_SIGN_IN_URL']);
  const env = new Proxy(h.env, { get(target, key) { assert(allowed.has(key)); return target[key]; } });
  assert.equal((await createReturningBotWorker().fetch(request(), env)).status, 200);
  assert.equal(outbound, 0);
});
for (const context of [null, {}, { update_id: 7, telegram_user_id: -1 },
  { update_id: -1, telegram_user_id: 42 }, { update_id: 7, telegram_user_id: 42, person: 'forged' }]) {
  test('invalid internal context cannot reach the private binding', async () => {
    let calls = 0;
    await assert.rejects(lookupValidatedStart(context, { lookupTelegramStart: () => { calls++; } }),
      e => e.code === 'NAVIGATION_LOOKUP_UNAVAILABLE');
    assert.equal(calls, 0);
  });
}
test('internal numeric lookup fields are snapshotted once before the asynchronous RPC call', async () => {
  let reads = 0; const calls = [];
  const context = { update_id: 7, get telegram_user_id() { return ++reads === 1 ? 42 : 99; } };
  const result = await lookupValidatedStart(context, { lookupTelegramStart: async input => { calls.push(input); return { status: 'linked' }; } });
  assert.deepEqual(result, { status: 'linked' });
  assert.deepEqual(calls, [{ update_id: 7, telegram_user_id: 42 }]); assert.equal(reads, 1);
});
test('new Wrangler entry is explicitly dynamic, with no invented URLs/binding target or implicit deployment', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url), 'utf8'));
  assert.deepEqual(config, { name: 'univeracademy-bot', main: 'src/returning-worker.mjs',
    compatibility_date: '2026-11-11', keep_vars: true });
  assert(!('vars' in config)); assert(!('services' in config));
});

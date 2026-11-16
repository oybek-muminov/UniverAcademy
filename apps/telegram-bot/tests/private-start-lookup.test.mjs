import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import { lookupPrivateStartNavigation, lookupValidatedStart } from '../src/private-start-lookup.mjs';

const SECRET = 'synthetic_private_webhook_secret';
const env = { TELEGRAM_WEBHOOK_SECRET: SECRET, AUTH_SIGN_IN_URL: 'https://quick-zebra-3590.accounts.dev/sign-in' };
const update = (extra = {}) => ({ update_id: 1, message: { message_id: 2, from: { id: 42, is_bot: false },
  chat: { id: 42, type: 'private' }, text: '/start' }, ...extra });
const request = (u = update(), secret = SECRET, url = 'https://bot.example.org/telegram/webhook') => new Request(url,
  { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(u) });
let nativeFetch, outbound = 0;
before(() => { nativeFetch = globalThis.fetch; globalThis.fetch = () => { outbound++; throw new Error('OUTBOUND_FORBIDDEN'); }; });
after(() => { globalThis.fetch = nativeFetch; assert.equal(outbound, 0); });

for (const state of ['linked', 'needs_clerk', 'disabled']) {
  test(`private lookup normalizes ${state} as navigation only`, async () => {
    const calls = [];
    const result = await lookupPrivateStartNavigation(request(), env, { lookupTelegramStart: async (...args) => { calls.push(args); return {status: state}; } });
    assert.deepEqual(result, {status: state}); assert.equal(calls.length, 1); assert.equal(calls[0].length, 1);
    assert.deepEqual(calls[0][0], {update_id: 1, telegram_user_id: 42});
    assert(Object.isFrozen(result));
  });
}
test('forged person/name fields do not change the private lookup input', async () => {
  const u = update({ person_id: 'forged', telegram_id: 999, username: 'forged' });
  u.message.from.username = 'forged'; u.message.from.first_name = 'forged';
  const seen = [];
  await lookupPrivateStartNavigation(request(u), env, {lookupTelegramStart: async input => { seen.push(input); return {status: 'linked'}; }});
  assert.deepEqual(seen, [{update_id: 1, telegram_user_id: 42}]);
});
for (const [label, mutate] of [
  ['group', u => { u.message.chat.type = 'group'; }],
  ['bot', u => { u.message.from.is_bot = true; }],
  ['unknown human', u => { delete u.message.from.is_bot; }],
  ['peer mismatch', u => { u.message.chat.id = 43; }],
  ['forwarded', u => { u.message.forward_origin = {}; }],
  ['business', u => { u.message.business_connection_id = 'synthetic'; }],
  ['guest', u => { u.guest_query_id = 'synthetic'; }],
  ['sender_chat', u => { u.message.sender_chat = {}; }],
  ['unsupported command', u => { u.message.text = '/help'; }],
  ['unknown event', u => { delete u.message; u.callback_query = {}; }],
]) {
  test(`${label} never reaches the private lookup`, async () => {
    const u = update(); mutate(u); let calls = 0;
    assert.equal(await lookupPrivateStartNavigation(request(u), env, {lookupTelegramStart: () => { calls++; }}), null);
    assert.equal(calls, 0);
  });
}
test('wrong webhook secret is rejected before lookup', async () => {
  let calls = 0;
  await assert.rejects(lookupPrivateStartNavigation(request(update(), 'wrong'), env, {lookupTelegramStart: () => { calls++; }}), e => e.status === 401);
  assert.equal(calls, 0);
});
test('raw-ID query route cannot bypass webhook validation', async () => {
  let calls = 0;
  await assert.rejects(lookupPrivateStartNavigation(request(update(), SECRET, 'https://bot.example.org/telegram/webhook?telegram_id=42'), env,
    {lookupTelegramStart: () => { calls++; }}), e => e.status === 404);
  assert.equal(calls, 0);
});
test('unavailable private adapter fails closed instead of asserting needs_clerk/linked', async () => {
  await assert.rejects(lookupPrivateStartNavigation(request(), env), e => e.status === 503 && e.code === 'NAVIGATION_LOOKUP_UNAVAILABLE');
});
for (const value of [null, undefined, true, 'linked', {status: 'unknown'}, { state: 'linked' }, { status: 'linked', session: 'synthetic-proof' },
  ['linked'], new String('linked')]) {
  test(`non-normalized result ${JSON.stringify(value)} cannot become navigation/auth`, async () => {
    await assert.rejects(lookupPrivateStartNavigation(request(), env, {lookupTelegramStart: async () => value}),
      e => e.status === 503 && e.code === 'NAVIGATION_LOOKUP_UNAVAILABLE');
  });
}
test('private exceptions are redacted and never retried', async () => {
  let calls = 0;
  await assert.rejects(lookupPrivateStartNavigation(request(), env, {lookupTelegramStart: () => { calls++; throw new Error(SECRET + ' PRIVATE_RESULT'); }}),
    e => e.message === 'NAVIGATION_LOOKUP_UNAVAILABLE');
  assert.equal(calls, 1);
});
test('an unavailable binding getter cannot expose a private exception', async () => {
  const binding = { get lookupTelegramStart() { throw new Error(SECRET); } };
  await assert.rejects(lookupPrivateStartNavigation(request(), env, binding),
    e => e.status === 503 && e.message === 'NAVIGATION_LOOKUP_UNAVAILABLE');
});
for (const value of [
  { status: 'linked', [Symbol('unexpected')]: true },
  { get status() { throw new Error(SECRET); } },
]) {
  test('symbol properties or throwing status access are unavailable, never a new user', async () => {
    await assert.rejects(lookupPrivateStartNavigation(request(), env, {lookupTelegramStart: async () => value}),
      e => e.status === 503 && e.code === 'NAVIGATION_LOOKUP_UNAVAILABLE');
  });
}
for (const [label, mutate] of [
  ['negative update id', u => { u.update_id = -1; }],
  ['unsafe update id', u => { u.update_id = Number.MAX_SAFE_INTEGER + 1; }],
  ['fractional update id', u => { u.update_id = 0.5; }],
  ['string user id', u => { u.message.from.id = '42'; }],
  ['zero user id', u => { u.message.from.id = 0; }],
  ['unsafe user id', u => { u.message.from.id = Number.MAX_SAFE_INTEGER + 1; }],
]) {
  test(`${label} is rejected before the private lookup`, async () => {
    const u = update(); mutate(u); let calls = 0;
    await assert.rejects(lookupPrivateStartNavigation(request(u), env, {lookupTelegramStart: () => { calls++; }}),
      e => e.status === 422);
    assert.equal(calls, 0);
  });
}
for (const [label, init, code] of [
  ['wrong method', { method: 'GET' }, 405],
  ['wrong content type', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }, 415],
  ['malformed JSON', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }, 400],
  ['oversize body', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '65537' }, body: '{}' }, 413],
]) {
  test(`${label} cannot trigger a lookup`, async () => {
    const headers = new Headers(init.headers); headers.set('X-Telegram-Bot-Api-Secret-Token', SECRET);
    let calls = 0;
    await assert.rejects(lookupPrivateStartNavigation(new Request('https://bot.example.org/telegram/webhook', { ...init, headers }),
      env, {lookupTelegramStart: () => { calls++; }}), e => e.status === code);
    assert.equal(calls, 0);
  });
}
test('duplicate read-only lookups are not misrepresented as deduped or authenticated', async () => {
  let calls = 0;
  const lookup = {lookupTelegramStart: async () => { calls++; return {status:'linked'}; }};
  assert.deepEqual(await Promise.all([lookupPrivateStartNavigation(request(), env, lookup), lookupPrivateStartNavigation(request(), env, lookup)]), [{status:'linked'}, {status:'linked'}]);
  assert.equal(calls, 2);
});
test('hanging private lookup times out without claiming RPC cancellation or authentication', { timeout: 15000 }, async () => {
  let calls = 0;
  await assert.rejects(lookupPrivateStartNavigation(request(), env, {lookupTelegramStart: () => { calls++; return new Promise(() => {}); }}),
    e => e.code === 'NAVIGATION_LOOKUP_UNAVAILABLE');
  assert.equal(calls, 1);
});
test('production entry remains the accepted static greeting and cannot acquire an unconfigured lookup/session', async () => {
  const reads = [];
  const config = new Proxy(env, { get(target, key) {
    reads.push(key); assert(['TELEGRAM_WEBHOOK_SECRET', 'AUTH_SIGN_IN_URL'].includes(key)); return target[key];
  } });
  const r = await worker.fetch(request(), config); const body = await r.json();
  assert.equal(r.status, 200); assert.equal(body.method, 'sendMessage');
  assert.equal(body.reply_markup.inline_keyboard[0][0].web_app.url, env.AUTH_SIGN_IN_URL);
  assert.equal('session' in body, false); assert.equal('linked' in body, false);
  assert.deepEqual(reads, ['TELEGRAM_WEBHOOK_SECRET', 'AUTH_SIGN_IN_URL']);
});

// Ordinary function doubles inherit Function.prototype.call; Workers RPC
// properties are callable remote paths. This double detects nested method
// access without claiming to reproduce the actual Workers transport/lifecycle.
function rpcStyleBinding(respond) {
  const calls = [], nestedReads = [];
  const binding = { lookupTelegramStart: new Proxy(function () {}, {
    get(target, key, receiver) {
      if (['call', 'apply', 'bind'].includes(key)) {
        nestedReads.push(key);
        throw new Error('NESTED_RPC_METHOD_FORBIDDEN');
      }
      return Reflect.get(target, key, receiver);
    },
    apply(_target, receiver, args) {
      assert.equal(receiver, binding);
      calls.push(args);
      return respond(...args);
    },
  }) };
  return { binding, calls, nestedReads };
}
for (const status of ['linked', 'needs_clerk', 'disabled']) {
  test(`RPC-style ${status} invokes the method directly with one exact argument`, async () => {
    const h = rpcStyleBinding(async () => ({ status }));
    assert.deepEqual(await lookupPrivateStartNavigation(request(), env, h.binding), { status });
    assert.deepEqual(h.calls, [[{ update_id: 1, telegram_user_id: 42 }]]);
    assert.deepEqual(h.nestedReads, []);
  });
}
test('RPC-style rejection is sanitized after one direct call with no retry or fallback', async () => {
  const h = rpcStyleBinding(async () => { throw new Error(SECRET); });
  await assert.rejects(lookupPrivateStartNavigation(request(), env, h.binding),
    e => e.code === 'NAVIGATION_LOOKUP_UNAVAILABLE' && e.status === 503 && !e.message.includes(SECRET));
  assert.deepEqual(h.calls, [[{ update_id: 1, telegram_user_id: 42 }]]);
  assert.deepEqual(h.nestedReads, []);
});
test('parallel RPC-style calls retain each validated input and result', async () => {
  const h = rpcStyleBinding(async input => ({ status: input.update_id === 1 ? 'linked' : 'needs_clerk' }));
  const second = update({ update_id: 2 });
  second.message.from.id = 43; second.message.chat.id = 43;
  assert.deepEqual(await Promise.all([
    lookupPrivateStartNavigation(request(), env, h.binding),
    lookupPrivateStartNavigation(request(second), env, h.binding),
  ]), [{ status: 'linked' }, { status: 'needs_clerk' }]);
  assert.equal(h.calls.length, 2);
  assert.deepEqual([...h.calls].sort((a, b) => a[0].update_id - b[0].update_id), [
    [{ update_id: 1, telegram_user_id: 42 }],
    [{ update_id: 2, telegram_user_id: 43 }],
  ]);
  assert.deepEqual(h.nestedReads, []);
});

for (const status of ['linked', 'needs_clerk', 'disabled']) {
  test(`RPC transport disposer permits ${status} and is invoked once`, async () => {
    let disposed = 0;
    const reply = { status, [Symbol.dispose]() { assert.equal(this, reply); disposed++; } };
    const h = rpcStyleBinding(async () => reply);
    const result = await lookupPrivateStartNavigation(request(), env, h.binding);
    assert.deepEqual(result, { status });
    assert.deepEqual(Reflect.ownKeys(result), ['status']);
    assert.equal(disposed, 1); assert.equal(h.calls.length, 1);
    assert.deepEqual(h.nestedReads, []);
  });
}
for (const reply of [
  { status: 'linked', [Symbol.dispose]() {}, extra: true },
  { status: 'linked', [Symbol.dispose]() {}, [Symbol('extra')]: true },
  { status: 'linked', [Symbol.dispose]: true },
  { status: 'linked', get [Symbol.dispose]() { throw new Error(SECRET); } },
  { status: 'unknown', [Symbol.dispose]() {} },
]) {
  test('RPC transport disposer does not permit malformed results or arbitrary keys', async () => {
    const h = rpcStyleBinding(async () => reply);
    await assert.rejects(lookupPrivateStartNavigation(request(), env, h.binding),
      e => e.status === 503 && e.code === 'NAVIGATION_LOOKUP_UNAVAILABLE' && !e.message.includes(SECRET));
    assert.equal(h.calls.length, 1); assert.deepEqual(h.nestedReads, []);
  });
}
test('RPC disposer failure is sanitized without a second lookup or navigation fallback', async () => {
  let disposed = 0;
  const h = rpcStyleBinding(async () => ({ status: 'linked', [Symbol.dispose]() { disposed++; throw new Error(SECRET); } }));
  await assert.rejects(lookupPrivateStartNavigation(request(), env, h.binding),
    e => e.status === 503 && e.code === 'NAVIGATION_LOOKUP_UNAVAILABLE' && !e.message.includes(SECRET));
  assert.equal(disposed, 1); assert.equal(h.calls.length, 1);
});
test('RPC cancellation rejection is sanitized and never retried', async () => {
  const h = rpcStyleBinding(async () => { throw new DOMException(SECRET, 'AbortError'); });
  await assert.rejects(lookupPrivateStartNavigation(request(), env, h.binding),
    e => e.status === 503 && e.code === 'NAVIGATION_LOOKUP_UNAVAILABLE' && !e.message.includes(SECRET));
  assert.equal(h.calls.length, 1); assert.deepEqual(h.nestedReads, []);
});
test('RPC deadline clears the timer and ignores a late result without retry', async () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  let fire, resolveLate, entered, lateReads = 0, disposed = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const timer = Symbol('lookup timer'), cleared = [];
  globalThis.setTimeout = (callback, milliseconds) => { assert.equal(milliseconds, 5000); fire = callback; return timer; };
  globalThis.clearTimeout = value => { cleared.push(value); };
  try {
    const h = rpcStyleBinding(() => { entered(); return new Promise(resolve => { resolveLate = resolve; }); });
    const pending = lookupValidatedStart({ update_id: 1, telegram_user_id: 42 }, h.binding);
    await started; fire();
    await assert.rejects(pending, e => e.status === 503 && e.code === 'NAVIGATION_LOOKUP_UNAVAILABLE');
    assert.deepEqual(cleared, [timer]); assert.equal(h.calls.length, 1);
    resolveLate({ get status() { lateReads++; return 'linked'; }, [Symbol.dispose]() { disposed++; } });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(lateReads, 0); assert.equal(disposed, 1); assert.equal(h.calls.length, 1);
  } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});

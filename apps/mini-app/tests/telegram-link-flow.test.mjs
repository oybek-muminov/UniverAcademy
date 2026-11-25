import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pkceChallenge, beginTelegramConfirmation, readTelegramCallback, readTelegramLoginConfig, rememberInvite, forgetInvite, telegramReturnUrl,
  PENDING_MAX_AGE_MS, TELEGRAM_AUTH_URL } from '../src/telegram-link-flow.ts';

// Brauzerdagi "Log In With Telegram" (PKCE) mantiqi. Telegram va saqlash soxta.
const memory = () => { const map = new Map(); return { map, getItem: k => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: k => { map.delete(k); } }; };
const config = { clientId: '9108664350', redirectUri: 'https://mini.example.org/telegram-link' };
const sha = async data => createHash('sha256').update(data).digest().buffer;
const counter = () => { let n = 0; return bytes => { for (let i = 0; i < bytes.length; i++) bytes[i] = (n++ * 7 + 13) % 256; return bytes; }; };
const T0 = 1_700_000_000_000;

test('PKCE challenge matches the RFC 7636 test vector', async () => {
  assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', sha), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});
test('the confirmation request carries exactly the required parameters and stores state and verifier only in this tab', async () => {
  const store = memory(), url = new URL(await beginTelegramConfirmation({ config, store, now: () => T0, random: counter(), digest: sha }));
  assert.equal(url.origin + url.pathname, TELEGRAM_AUTH_URL);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['client_id', 'code_challenge', 'code_challenge_method', 'redirect_uri', 'response_type', 'scope', 'state']);
  assert.equal(url.searchParams.get('client_id'), '9108664350'); assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(url.searchParams.get('response_type'), 'code'); assert.equal(url.searchParams.get('scope'), 'openid profile');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const pending = JSON.parse(store.map.get('ua.telegram-link.pending'));
  assert.equal(pending.state, url.searchParams.get('state')); assert.equal(pending.at, T0);
  assert.match(pending.verifier, /^[A-Za-z0-9_-]{64}$/); assert.match(pending.state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(url.searchParams.get('code_challenge'), await pkceChallenge(pending.verifier, sha));
  assert(!url.href.includes(pending.verifier), 'the verifier never leaves the browser in the request');
});
test('every confirmation uses a fresh state and verifier', async () => {
  const a = memory(), b = memory();
  await beginTelegramConfirmation({ config, store: a }); await beginTelegramConfirmation({ config, store: b });
  const [x, y] = [a, b].map(s => JSON.parse(s.map.get('ua.telegram-link.pending')));
  assert.notEqual(x.state, y.state); assert.notEqual(x.verifier, y.verifier);
});
async function pendingStore(at = T0) {
  const store = memory(); await beginTelegramConfirmation({ config, store, now: () => at, random: counter(), digest: sha });
  return { store, pending: JSON.parse(store.map.get('ua.telegram-link.pending')) };
}
test('a matching state returns the code and the verifier, once', async () => {
  const { store, pending } = await pendingStore();
  assert.deepEqual(readTelegramCallback('?code=abcdefgh12345&state=' + pending.state, store, () => T0 + 1000), { kind: 'code', code: 'abcdefgh12345', verifier: pending.verifier });
  assert.equal(store.map.has('ua.telegram-link.pending'), false);
  assert.deepEqual(readTelegramCallback('?code=abcdefgh12345&state=' + pending.state, store, () => T0 + 2000), { kind: 'invalid' });
});
test('a page without a code or error is left alone and keeps the pending request', async () => {
  const { store } = await pendingStore();
  for (const search of ['', '?invite=grp_abc', '?state=x']) assert.deepEqual(readTelegramCallback(search, store, () => T0), { kind: 'none' });
  assert.equal(store.map.has('ua.telegram-link.pending'), true);
});
test('a wrong, missing or foreign state is invalid and consumes the pending request', async () => {
  for (const search of ['?code=abcdefgh12345', '?code=abcdefgh12345&state=wrong', '?code=abcdefgh12345&state=', '?error=access_denied&state=nope']) {
    const { store } = await pendingStore();
    assert.deepEqual(readTelegramCallback(search, store, () => T0 + 1000), { kind: 'invalid' }, search); assert.equal(store.map.has('ua.telegram-link.pending'), false);
  }
  assert.deepEqual(readTelegramCallback('?code=abcdefgh12345&state=x', memory(), () => T0), { kind: 'invalid' });
});
test('a refusal in Telegram is "denied", never a code', async () => {
  const { store, pending } = await pendingStore();
  assert.deepEqual(readTelegramCallback('?error=access_denied&state=' + pending.state, store, () => T0 + 1000), { kind: 'denied' });
});
test('an old request, a clock that went backwards and damaged storage are invalid', async () => {
  for (const at of [T0 + PENDING_MAX_AGE_MS + 1, T0 - 1]) {
    const { store, pending } = await pendingStore();
    assert.deepEqual(readTelegramCallback('?code=abcdefgh12345&state=' + pending.state, store, () => at), { kind: 'invalid' });
  }
  const { store, pending } = await pendingStore(); await assert.doesNotReject(async () => readTelegramCallback('?code=abcdefgh12345&state=' + pending.state, store, () => T0 + PENDING_MAX_AGE_MS));
  const broken = memory(); broken.map.set('ua.telegram-link.pending', '{nope');
  assert.deepEqual(readTelegramCallback('?code=abcdefgh12345&state=x', broken, () => T0), { kind: 'invalid' });
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() {}, removeItem() { throw new Error('blocked'); } };
  assert.deepEqual(readTelegramCallback('?code=abcdefgh12345&state=x', throwing, () => T0), { kind: 'invalid' });
});
test('a code outside the accepted shape is invalid', async () => {
  for (const code of ['short', 'has space in it', 'x'.repeat(2049)]) {
    const { store, pending } = await pendingStore();
    assert.deepEqual(readTelegramCallback('?code=' + encodeURIComponent(code) + '&state=' + pending.state, store, () => T0 + 1000), { kind: 'invalid' });
  }
});
test('the sign-in configuration needs the explicit flag and a numeric client id; the redirect is fixed to this origin', () => {
  const base = { VITE_TELEGRAM_BROWSER_LINK_ENABLED: 'true', VITE_TELEGRAM_LOGIN_CLIENT_ID: '9108664350' };
  assert.deepEqual({ ...readTelegramLoginConfig(base, 'https://mini.example.org') }, { clientId: '9108664350', redirectUri: 'https://mini.example.org/telegram-link' });
  for (const patch of [{ VITE_TELEGRAM_BROWSER_LINK_ENABLED: 'false' }, { VITE_TELEGRAM_BROWSER_LINK_ENABLED: undefined }, { VITE_TELEGRAM_LOGIN_CLIENT_ID: 'abc' },
    { VITE_TELEGRAM_LOGIN_CLIENT_ID: '12' }, { VITE_TELEGRAM_LOGIN_CLIENT_ID: undefined }, { VITE_TELEGRAM_LOGIN_CLIENT_ID: '1234 5678' }])
    assert.equal(readTelegramLoginConfig({ ...base, ...patch }, 'https://mini.example.org'), null);
  assert.equal(readTelegramLoginConfig({}, 'https://mini.example.org'), null);
});
test('a group invitation survives the sign-in round trip in this tab and goes back to the bot', () => {
  const store = memory(), token = 'grp_' + 'a'.repeat(32);
  assert.equal(rememberInvite('?invite=' + token, store), token);
  assert.equal(rememberInvite('', store), token, 'the next page of the round trip has no query');
  assert.equal(telegramReturnUrl(token), 'https://t.me/univeracademybot?start=' + token);
  forgetInvite(store); assert.equal(rememberInvite('', store), null);
  assert.equal(telegramReturnUrl(null), 'https://t.me/univeracademybot');
});
test('only well-formed invitations are remembered or put into the return link', () => {
  for (const bad of ['?invite=evil', '?invite=grp_', '?invite=grp_a&invite=grp_b', '?invite=' + 'grp_' + 'x'.repeat(61), '?invite=grp_a b', '?invite=grp_a%0Ab']) {
    const store = memory(); assert.equal(rememberInvite(bad, store), null, bad); assert.equal(store.map.size, 0);
  }
  for (const bad of ['evil', 'grp_', 'grp_a?x=1&y', 'https://evil.example', '']) assert.equal(telegramReturnUrl(bad), 'https://t.me/univeracademybot');
  assert.equal(rememberInvite('?invite=grp_ok', { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() {} }), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSignInController } from '../src/sign-in-controller.ts';
import { StudentFailure } from '../src/transport.ts';

test('production prebuilt uses same-window OAuth and no alternate Telegram sign-in link', () => {
  // The sign-in form lives in sign-in-card.tsx; the entry only mounts it with the configured callback.
  const entry = readFileSync(new URL('../src/clerk-prebuilt-entry.tsx', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../src/sign-in-card.tsx', import.meta.url), 'utf8');
  assert.match(entry, /<SignInCard inTelegram=\{webview\} callbackUrl=\{config.callbackUrl\} \/>/);
  assert.match(source, /oauthFlow="redirect"/);
  for (const text of [entry, source]) assert.doesNotMatch(text, /window\.open|oauthFlow="popup"|Telegram orqali kirish — ixtiyoriy|https:\/\/t\.me/);
  assert.match(source, /forceRedirectUrl=\{callbackUrl\}/);
  assert.match(source, /signUpForceRedirectUrl=\{callbackUrl\}/);
  const callback = readFileSync(new URL('../src/common-production-entry.tsx', import.meta.url), 'utf8').split('// Exported content')[0];
  assert.match(callback, /\/start orqali yangidan oching/);
  assert.doesNotMatch(callback, /href=\{config.signInUrl\}|localStorage|sessionStorage|\.authorize\(|\.continueSession\(/);
});

test('known auth failures show only allowlisted static diagnostics; arbitrary errors stay private', async () => {
  for (const [error, expected] of [
    [new StudentFailure('auth', 'SESSION_REVOKED'), 'SESSION_REVOKED'],
    [new StudentFailure('auth', 'CLERK_TOKEN_INVALID'), 'CLERK_TOKEN_INVALID'],
    [new StudentFailure('temporary', 'SERVICE_UNAVAILABLE'), 'SERVICE_UNAVAILABLE'],
    [new StudentFailure('auth', 'private-arbitrary-value'), 'Tasdiq kelmadi'],
    [new Error('private-raw-exception'), 'Tasdiq kelmadi'],
  ]) {
    const runtime = createSignInController({ context: 'browser',
      provider: { current: async () => { throw error; }, google: async () => { throw error; },
        sendCode: async () => { throw error; }, verifyCode: async () => { throw error; } },
      authorize: async () => { assert.fail('No proof may be authorized'); },
    });
    await runtime.continueSession();
    assert.ok(runtime.snapshot().notice.includes(expected));
    assert.ok(!runtime.snapshot().notice.includes('private-'));
    assert.equal(runtime.snapshot().flow, null);
    runtime.dispose();
  }
});

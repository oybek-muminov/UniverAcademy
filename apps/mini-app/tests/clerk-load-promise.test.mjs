import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { clerkLoadPromiseFix, patchClerkLoadPromises, CLERK_LOADER_INPUT_SHA256 } from '../tools/clerk-load-promise-fix.mjs';
const path = import.meta.resolve('@clerk/shared/loadClerkJsScript');
const raw = readFileSync(new URL(path), 'utf8');
test('OBS loader patch requires exact pinned upstream bytes and joins JS and UI loads', () => {
  assert.equal(createHash('sha256').update(raw).digest('hex'), CLERK_LOADER_INPUT_SHA256);
  const fixed = patchClerkLoadPromises(raw);
  assert.equal(fixed.split('const scriptPromise = loadScript(scriptUrl, {').length, 3);
  assert.equal(fixed.split('return Promise.all([loadPromise, scriptPromise]).then(() => null);').length, 3);
  // Exactly four line edits; no auth, provider configuration or error-code change.
  assert.equal(fixed.replaceAll('const scriptPromise = loadScript(scriptUrl, {', 'loadScript(scriptUrl, {')
    .replaceAll('return Promise.all([loadPromise, scriptPromise]).then(() => null);', 'return loadPromise;'), raw);
});
test('OBS loader patch rejects same-size upstream corruption', () => {
  assert.throws(() => patchClerkLoadPromises('X' + raw.slice(1)), /CLERK_LOADER_UPSTREAM_HASH_MISMATCH/);
});
test('OBS loader patch rejects changed SDK versions and double application', () => {
  assert.throws(() => patchClerkLoadPromises(raw + '\n'), /CLERK_LOADER_UPSTREAM_HASH_MISMATCH/);
  assert.throws(() => patchClerkLoadPromises(patchClerkLoadPromises(raw)), /CLERK_LOADER_UPSTREAM_HASH_MISMATCH/);
});
test('OBS loader plugin only transforms the exact SDK helper and is usable in build and dev optimizer', () => {
  const plugin = clerkLoadPromiseFix();
  assert.equal(plugin.transform('unrelated source', '/src/application.ts'), undefined);
  assert.equal(plugin.transform('unrelated source', '/src/loadClerkJsScript.mjs'), undefined);
  assert.equal(plugin.transform(raw, new URL(path).pathname).code, patchClerkLoadPromises(raw));
});

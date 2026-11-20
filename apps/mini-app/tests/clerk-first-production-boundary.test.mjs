import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Source-only release boundary: no provider, server, user or fixture is created.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('production selection fails closed instead of importing Telegram-only auth', () => {
  const source = read('../src/main.tsx');
  assert.match(source, /VITE_AUTH_ENTRY === 'common'/);
  assert.match(source, /mountCommonProductionEntry/);
  assert.doesNotMatch(source, /mountTelegramEntry|import\('\.\/production-entry\.tsx'\)/);
  assert.match(source, /Kabinetga ulanish hali tayyor emas/);
});

test('Clerk entry has no legacy Telegram dispatch and admits only its three routes', () => {
  const source = read('../src/common-production-entry.tsx');
  assert.doesNotMatch(source, /mountTelegramEntry|createProductionConnection/);
  assert.match(source, /\['\/', '\/sign-in', '\/auth\/callback'\]\.includes\(location\.pathname\)/);
  assert.match(source, /VITE_CLERK_SDK_ENABLED !== 'true'/);
  assert.match(source, /publishableKey=\{config\.publishableKey\}/);
});

test('production settings document closed missing auth selection', () => {
  assert.match(read('../production.env.example'), /blank\/unknown stays closed/);
});


test('main deploy preserves reviewed vars and explicit API/bot resource bindings', () => {
  const api = JSON.parse(read('../../../wrangler.api.registration-only.jsonc').replace(/^\s*\/\/.*$/gm, ''));
  const bot = JSON.parse(read('../../telegram-bot/wrangler.json'));
  assert.equal(api.keep_vars, true);
  assert.equal(api.name, 'univeracademy-api');
  assert.deepEqual(api.hyperdrive, [
    { binding: 'HYPERDRIVE', id: '075d873d9cdd4ad48a027b5e5a6f7acf' },
    { binding: 'CABINET_HYPERDRIVE', id: '3b8bc95acda546bf804d36678a1b37a3' },
    { binding: 'TEACHER_PILOT_HYPERDRIVE', id: 'ac6d5e78608a4004b67e5c6bdc6a2936' }
  ]);
  assert.deepEqual(Object.keys(api.vars).sort(), ['UA_ALLOWED_ORIGINS', 'UA_API_ORIGIN', 'UA_CLERK_PROVIDER_SETTINGS', 'UA_SESSION_POLICY', 'UA_TELEGRAM_LOOKUP_TIMEOUT_MS', 'UA_TELEGRAM_MENU_SYNC_ENABLED']);
  assert.equal(api.vars.UA_TELEGRAM_MENU_SYNC_ENABLED, 'true');
  assert.deepEqual(api.services, [{binding:'TELEGRAM_MENU_SYNC',service:'univeracademy-bot',entrypoint:'TelegramMenuSync'}]);
  assert.equal(api.vars.UA_TELEGRAM_LOOKUP_TIMEOUT_MS, '3000');
  assert.equal(api.workers_dev, false);
  assert.equal(api.preview_urls, false);
  assert.deepEqual(api.routes, [{ pattern: 'api.univeracademy.uz', custom_domain: true }]);
  const mini = JSON.parse(read('../wrangler.jsonc'));
  assert.deepEqual(mini.routes, [{ pattern: 'mini.univeracademy.uz', custom_domain: true }]);
  assert.equal(mini.workers_dev, true);
  assert.equal(mini.preview_urls, false);
  assert.equal(bot.keep_vars, true);
  assert.deepEqual(bot.services, [{ binding: 'TELEGRAM_START_LOOKUP', service: 'univeracademy-api', entrypoint: 'TelegramAccountDirectory' },
      { binding: 'TELEGRAM_PILOT_DIRECTORY', service: 'univeracademy-api', entrypoint: 'TelegramPilotDirectory' }]);
});

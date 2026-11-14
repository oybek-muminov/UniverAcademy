import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Static, no-I/O-to-providers checks. Passing these tests is not deployment
// permission and cannot verify live Hyperdrive TLS, caching, DB grants or secrets.
const read = path => readFileSync(new URL('../../' + path, import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const parseConfig = bytes => JSON.parse(bytes.toString('utf8').split('\n')
  .filter(line => !line.trimStart().startsWith('//')).join('\n'));
const candidateBytes = read('wrangler.api.deploy.jsonc');
const candidate = parseConfig(candidateBytes);
const apiOrigin = 'https://univeracademy-api.oybekmominov227.workers.dev';
const miniOrigin = 'https://univeracademy-mini.oybekmominov227.workers.dev';
const expectedSettings = {
  $schema: 'tooling/node_modules/wrangler/config-schema.json',
  name: 'univeracademy-api',
  account_id: '78634501073c56e90dfd1662b729885a',
  main: 'runtime/cloudflare-worker.mjs',
  compatibility_date: '2026-11-11',
  compatibility_flags: ['nodejs_compat'],
  workers_dev: true,
  preview_urls: false,
  keep_vars: true,
  hyperdrive: [{ binding: 'HYPERDRIVE', id: '075d873d9cdd4ad48a027b5e5a6f7acf' }],
};
const expectedSessionPolicy = {
  initDataMaxAgeSeconds: 300,
  futureSkewSeconds: 0,
  accessTtlMs: 900000,
  familyTtlMs: 86400000,
  logoutTombstoneMs: 86400000,
  identityCollisionAttempts: 4,
  newLogin: 'revoke_previous',
};
const expectedClerkSettings = {
  issuer: 'https://quick-zebra-3590.clerk.accounts.dev',
  authorizedParties: [miniOrigin],
  audience: { kind: 'clerk_default_no_audience' },
  jwksCacheMs: 60000,
  jwksCooldownMs: 5000,
  timeoutMs: 3000,
  maxJwksBytes: 65536,
};
const expectedVarKeys = [
  'UA_API_ORIGIN', 'UA_ALLOWED_ORIGINS', 'UA_SESSION_POLICY',
  'UA_CLERK_PROVIDER_SETTINGS', 'UA_TELEGRAM_LOOKUP_TIMEOUT_MS',
].sort();

function assertDeploymentConfig(config) {
  assert(config && typeof config === 'object' && !Array.isArray(config));
  const { vars, ...settings } = config;
  // Exact keys and values reject bot/default-entry swaps, routes, custom builds,
  // extra resources, local DB URLs, unexpected account IDs and binding IDs.
  assert.deepEqual(settings, expectedSettings);
  assert(vars && typeof vars === 'object' && !Array.isArray(vars));
  assert.deepEqual(Object.keys(vars).sort(), expectedVarKeys);
  for (const value of Object.values(vars)) assert.equal(typeof value, 'string');
  assert.equal(vars.UA_API_ORIGIN, apiOrigin);
  assert.deepEqual(JSON.parse(vars.UA_ALLOWED_ORIGINS), [miniOrigin]);
  assert.deepEqual(JSON.parse(vars.UA_SESSION_POLICY), expectedSessionPolicy);
  assert.deepEqual(JSON.parse(vars.UA_CLERK_PROVIDER_SETTINGS), expectedClerkSettings);
  assert.equal(vars.UA_TELEGRAM_LOOKUP_TIMEOUT_MS, '3000');
}

test('inert API proposal remains the exact 658-byte account-free source', () => {
  const bytes = read('wrangler.api.jsonc');
  assert.equal(bytes.length, 658);
  assert.equal(sha256(bytes), 'd8c45f39aa743118db0d76b6a79f5161009ac27b71e08b9ecd6e89bcff315273');
  const inert = parseConfig(bytes);
  assert.equal(inert.workers_dev, false);
  assert.equal(inert.preview_urls, false);
  for (const key of ['account_id', 'hyperdrive', 'vars', 'routes', 'route', 'build'])
    assert.equal(Object.hasOwn(inert, key), false);
});

test('explicit deployment candidate is unchanged and separate from the inert proposal', () => {
  assert.equal(candidateBytes.length, 1634);
  assert.equal(sha256(candidateBytes), '880bb207b68f15bffa4ad309f38e446dac349930b702f6c825588d3bf2714fbd');
  assertDeploymentConfig(candidate);
  assert.doesNotMatch(candidateBytes.toString('utf8'),
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|postgres(?:ql)?:\/\/|UA_CLERK_SECRET_KEY|UA_TELEGRAM_BOT_TOKEN/);
});

const invalidConfigurations = [
  ['root dependency schema path', config => { config.$schema = 'node_modules/wrangler/config-schema.json'; }],
  ['bot Worker name', config => { config.name = 'univeracademy-bot'; }],
  ['different entrypoint', config => { config.main = 'apps/telegram-bot/worker.mjs'; }],
  ['different account', config => { config.account_id = '0'.repeat(32); }],
  ['missing account', config => { delete config.account_id; }],
  ['different Hyperdrive ID', config => { config.hyperdrive[0].id = '0'.repeat(32); }],
  ['different binding name', config => { config.hyperdrive[0].binding = 'OTHER_DB'; }],
  ['additional binding', config => { config.hyperdrive.push({ ...config.hyperdrive[0] }); }],
  ['local database URL', config => { config.hyperdrive[0].localConnectionString = 'postgres://fixture:fixture@db.invalid:5432/fixture'; }],
  ['route addition', config => { config.routes = ['example.invalid/*']; }],
  ['custom build', config => { config.build = { command: 'unexpected-command' }; }],
  ['preview exposure', config => { config.preview_urls = true; }],
  ['unreviewed public exposure change', config => { config.workers_dev = false; }],
  ['unknown top-level key', config => { config.unreviewed = true; }],
  ['inline Clerk secret', config => { config.vars.UA_CLERK_SECRET_KEY = 'synthetic-only'; }],
  ['inline Telegram secret', config => { config.vars.UA_TELEGRAM_BOT_TOKEN = 'synthetic-only'; }],
  ['different API origin', config => { config.vars.UA_API_ORIGIN = 'https://other.invalid'; }],
  ['wildcard allowed origin', config => { config.vars.UA_ALLOWED_ORIGINS = '["*"]'; }],
  ['malformed session JSON', config => { config.vars.UA_SESSION_POLICY = '{'; }],
  ['extended access lifetime', config => {
    config.vars.UA_SESSION_POLICY = JSON.stringify({ ...expectedSessionPolicy, accessTtlMs: 900001 });
  }],
  ['session reuse policy', config => {
    config.vars.UA_SESSION_POLICY = JSON.stringify({ ...expectedSessionPolicy, newLogin: 'reuse' });
  }],
  ['different Clerk issuer', config => {
    config.vars.UA_CLERK_PROVIDER_SETTINGS = JSON.stringify({ ...expectedClerkSettings, issuer: 'https://other.invalid' });
  }],
  ['extra Clerk authorized party', config => {
    config.vars.UA_CLERK_PROVIDER_SETTINGS = JSON.stringify({ ...expectedClerkSettings, authorizedParties: [miniOrigin, 'https://other.invalid'] });
  }],
  ['different audience policy', config => {
    config.vars.UA_CLERK_PROVIDER_SETTINGS = JSON.stringify({ ...expectedClerkSettings, audience: { kind: 'unreviewed' } });
  }],
  ['nonstring timeout', config => { config.vars.UA_TELEGRAM_LOOKUP_TIMEOUT_MS = 3000; }],
];
for (const [label, mutate] of invalidConfigurations) {
  test('deployment configuration rejects ' + label, () => {
    const changed = structuredClone(candidate);
    mutate(changed);
    assert.throws(() => assertDeploymentConfig(changed));
  });
}

test('separate build tooling retains the reviewed lock and has no project scripts', () => {
  // Dependencies in this unchanged lock may have install hooks. This check only
  // excludes project-level scripts; install commands still need --ignore-scripts.
  const manifestBytes = read('tooling/package.json');
  const lockBytes = read('tooling/package-lock.json');
  assert.equal(sha256(manifestBytes), 'b7b9592e66edd093efe9a6436532121622e845e6032981b8eb1cfb2d60446b5c');
  assert.equal(sha256(lockBytes), 'faf79cad8ca70d92a9378160c8d2b2f2883fae1c4b67c991f74f1532853cd701');
  const manifest = JSON.parse(manifestBytes);
  const lock = JSON.parse(lockBytes);
  assert.deepEqual(manifest.devDependencies, { wrangler: '4.160.1' });
  assert.equal(Object.hasOwn(manifest, 'scripts'), false);
  assert.equal(lock.packages['node_modules/wrangler'].version, '4.160.1');
  for (const entry of Object.values(lock.packages)) {
    if (entry.resolved) {
      assert.equal(new URL(entry.resolved).origin, 'https://registry.npmjs.org');
      assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    }
  }
});

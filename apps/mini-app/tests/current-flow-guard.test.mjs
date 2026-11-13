import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, existsSync, lstatSync, symlinkSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const guard = 'apps/mini-app/tests/verify-backend-targets.mjs';
const current = 'apps/mini-app/tests/fixtures/backend-final-content-9bca9654-manifest.json';
const previousContentBase = 'apps/mini-app/tests/fixtures/backend-accepted-fixtures-14f0b074-manifest.json';
const previousAssembly = 'apps/mini-app/tests/fixtures/backend-telegram-return-assembly-manifest.json';
const previousClean = 'apps/mini-app/tests/fixtures/backend-d54d19c-clean-manifest.json';
const lab208 = 'apps/mini-app/tests/fixtures/backend-d54d19c-manifest.json';
const historicalAttempts = 'apps/mini-app/tests/fixtures/attempts-8a750ee.ts.txt';
const copies = ['student-client.ts', 'student-types.d.ts'].map(name => 'apps/mini-app/src/owner-client/' + name);
const attempts = 'supabase/functions/univeracademy-api/attempts.ts';
const sha = value => createHash('sha256').update(value).digest('hex');
const previousContentBaseRaw = readFileSync(join(source, previousContentBase));
assert.equal(previousContentBaseRaw.length, 30195);
assert.equal(sha(previousContentBaseRaw), '41bfcbdf18e321185648dd43def4ae4f72a6fe27d5d1f544b3c4f191d5985dfc');
const previousAssemblyRaw = readFileSync(join(source, previousAssembly));
assert.equal(previousAssemblyRaw.length, 25929);
assert.equal(sha(previousAssemblyRaw), '6bba769c22d8fbe2463957542f66b17f6b879586c614a13fdd93b92fb40ec882');

const manifest = JSON.parse(readFileSync(join(source, current), 'utf8'));
const previousCleanRaw = readFileSync(join(source, previousClean));
assert.equal(previousCleanRaw.length, 19964);
assert.equal(sha(previousCleanRaw), 'e3a6e0c368b957cd243fe9b2dedc7786d34d451d76737cd8542fbb6b198d0fd4');
const lab208Raw = readFileSync(join(source, lab208));
assert.equal(lab208Raw.length, 42473);
assert.equal(sha(lab208Raw), '5372551a2ca45bb2505a4f198445e9867273411b74ce998c4611851c1cb2005e');
// Opaque historical byte fixture: its JSON target rows are never traversed.
const manifestErrors = new Map([['RUNTIME_MANIFEST_MISMATCH', current], ['HISTORICAL_ATTEMPTS_FIXTURE_MISMATCH', historicalAttempts]]);
let pristinePassed = false;

function check(mutate, expected, { rebindDigest = false } = {}) {
  assert(!rebindDigest || expected, "TEST_DIGEST_REBIND_REQUIRES_NEGATIVE");
  if (expected) assert(pristinePassed, 'PRISTINE_GUARD_CONTROL_REQUIRED');
  const root = mkdtempSync(join(tmpdir(), 'ua-current-guard-'));
  try {
    const inputs = [...new Set([guard, current, previousContentBase, previousAssembly, previousClean, lab208, historicalAttempts, ...copies, ...manifest.files.map(file => file.path)])];
    const before = new Map();
    for (const name of inputs) {
      const path = join(root, name); mkdirSync(dirname(path), { recursive: true });
      const bytes = readFileSync(join(source, name));
      before.set(name, sha(bytes)); writeFileSync(path, bytes);
    }
    mutate?.(root);
    if (rebindDigest) {
      const original = readFileSync(join(root, guard), 'utf8'), literal = /const ACTIVE_MANIFEST_SHA256 = '[a-f0-9]{64}';/g;
      assert.equal([...original.matchAll(literal)].length, 1, 'ONE_TEST_COPY_DIGEST_LITERAL_REQUIRED');
      writeFileSync(join(root, guard), original.replace(literal, "const ACTIVE_MANIFEST_SHA256 = '" + sha(readFileSync(join(root, current))) + "';"));
    }
    const changed = inputs.filter(name => !existsSync(join(root, name)) || lstatSync(join(root, name)).isSymbolicLink() ||
      sha(readFileSync(join(root, name))) !== before.get(name));
    assert.equal(changed.length, rebindDigest ? 2 : expected ? 1 : 0, 'CONTROL_MUST_CHANGE_ONLY_ITS_DELIBERATE_TARGET');
    const result = spawnSync(process.execPath, [guard], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, expected ? 1 : 0, result.stderr);
    if (expected) {
      assert(result.stderr.includes(expected), result.stderr);
      const suffix = expected.split(': ')[1];
      const target = rebindDigest ? current : expected === 'ENOENT' ? changed[0] :
        expected.startsWith('OWNER_CLIENT_') ? 'apps/mini-app/src/owner-client/' + suffix :
        expected.startsWith('BACKEND_TARGET_') ? suffix : manifestErrors.get(expected);
      assert.deepEqual(changed.slice().sort(), rebindDigest ? [guard, target].sort() : [target], 'DIAGNOSTIC_MUST_IDENTIFY_THE_DELIBERATE_TARGET');
      if (rebindDigest) assert(!result.stderr.includes('AssertionError [ERR_ASSERTION]: RUNTIME_MANIFEST_MISMATCH'), 'METADATA_PROBE_MUST_REACH_VALIDATION');
      if (expected === 'ENOENT') assert(result.stderr.includes(target), result.stderr);
    } else pristinePassed = true;
    if (process.env.UA_MINI_PIN_GUARD_TRACE_PATH) appendFileSync(process.env.UA_MINI_PIN_GUARD_TRACE_PATH,
      JSON.stringify({ control: expected ? 'negative' : 'pristine_positive', target: changed[0] ?? null,
        expected: expected ?? null, status: result.status, deliberate_target_verified: true,
        test_only_digest_rebound: rebindDigest, metadata_validation_reached: rebindDigest, stderr_sha256: sha(Buffer.from(result.stderr)) }) + '\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function oldAttempts(root) {
  const raw = readFileSync(join(root, historicalAttempts), 'utf8');
  assert.equal(Buffer.byteLength(raw), 9616, 'HISTORICAL_ATTEMPTS_FIXTURE_MISMATCH');
  const added = '// Internal maintenance transition. HTTP callers still require current staff auth,\n'
    + '// target visibility and transaction locks before loading/passing this record.\n'
    + 'export function expireForMembershipGuard(record: AttemptRecord, now: number): AttemptRecord {\n'
    + '  return expire(record, now);\n}\n\n';
  assert.equal(sha(Buffer.from(raw)), 'b4bc54e39fef6799b6ff83a4be3c474471afd2e4c76e888767e999064a4d9e20', 'HISTORICAL_ATTEMPTS_FIXTURE_MISMATCH');
  const old = Buffer.from(raw.replace(added, ''));
  assert.equal(old.length, 9327);
  assert.equal(sha(old), 'acf2906760018be9eafa7b9a7b0d57bcc1e0486d4142a6acadc62a6515a01060');
  if (process.env.UA_MINI_PIN_GUARD_TRACE_PATH) appendFileSync(process.env.UA_MINI_PIN_GUARD_TRACE_PATH,
    JSON.stringify({ control: 'historical_fixture_preparation', source: historicalAttempts,
      source_bytes: Buffer.byteLength(raw), source_sha256: sha(Buffer.from(raw)),
      derived_bytes: old.length, derived_sha256: sha(old), status: 'PASS' }) + '\n');
  return old; // Exact historical bytes; never executed or written over owner source.
}

test('current guard accepts exact corrected types base plus two Backend corrections and both owner copies', () => check());
test('stale source claim for historical 194-target checkpoint is rejected', () => check(root => {
  mutateCurrentManifest(root, value => { value.source_commit = '8a750ee01eed794bda1942bc1bd0e89829c3a704'; });
}, 'RUNTIME_MANIFEST_MISMATCH'));
test('historical attempts byte-fixture tampering is rejected before fixture preparation', () => check(root => {
  const path = join(root, historicalAttempts), bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
}, 'HISTORICAL_ATTEMPTS_FIXTURE_MISMATCH'));
test('exact historical accepted 8a attempts source is rejected as current d54 source', () => check(root => {
  writeFileSync(join(root, attempts), readFileSync(join(root, historicalAttempts)));
}, 'BACKEND_TARGET_SIZE_MISMATCH: ' + attempts));
function mutateCurrentManifest(root, mutate) {
  const path = join(root, current), value = JSON.parse(readFileSync(path, 'utf8'));
  mutate(value); writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}
const requiredAuthority = 'supabase/functions/univeracademy-api/removal-authority.ts';
test('omitted required authority row is rejected by the immutable manifest boundary', () => check(root => {
  mutateCurrentManifest(root, value => { value.files = value.files.filter(file => file.path !== requiredAuthority); });
}, 'RUNTIME_MANIFEST_MISMATCH'));
test('extra non-base target row is rejected by the immutable manifest boundary', () => check(root => {
  mutateCurrentManifest(root, value => value.files.push({ path: 'runtime/not-a-d54-target.mjs', bytes: 0, sha256: sha(Buffer.alloc(0)) }));
}, 'RUNTIME_MANIFEST_MISMATCH'));
test('duplicate target row is rejected by the immutable manifest boundary', () => check(root => {
  mutateCurrentManifest(root, value => value.files.push({ ...value.files[0] }));
}, 'RUNTIME_MANIFEST_MISMATCH'));
test('required authority path substitution is rejected by the immutable manifest boundary', () => check(root => {
  mutateCurrentManifest(root, value => { value.files.find(file => file.path === requiredAuthority).path = 'runtime/not-a-d54-target.mjs'; });
}, 'RUNTIME_MANIFEST_MISMATCH'));
for (const target of [
  'supabase/functions/univeracademy-api/attempts.ts',
  'supabase/functions/univeracademy-api/membership-activity.ts',
  'supabase/functions/univeracademy-api/membership-effects.ts',
  'supabase/functions/univeracademy-api/staff-state.ts',
  'supabase/functions/univeracademy-api/storage/postgres-transaction.ts',
  'runtime/production-options.mjs',
  'supabase/functions/univeracademy-api/membership-preflight.ts',
  'supabase/functions/univeracademy-api/membership-removal-http.ts',
  'supabase/functions/univeracademy-api/membership-removal.ts',
  requiredAuthority,
  'supabase/functions/univeracademy-api/storage/membership-preflight-port.ts',
  'supabase/functions/univeracademy-api/storage/membership-protection-contract.ts',
]) {
  test('missing changed/new d54 runtime source is rejected: ' + target, () => check(root => {
    rmSync(join(root, target));
  }, 'ENOENT'));
  test('changed/new d54 runtime source wrong size is rejected: ' + target, () => check(root => {
    const path = join(root, target); writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('\n')]));
  }, 'BACKEND_TARGET_SIZE_MISMATCH: ' + target));
  test('changed/new d54 runtime source same-size corruption is rejected: ' + target, () => check(root => {
    const path = join(root, target), bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
  }, 'BACKEND_TARGET_HASH_MISMATCH: ' + target));
}
test('stale source claim for historical 191-target checkpoint is rejected', () => check(root => {
  mutateCurrentManifest(root, value => { value.source_commit = 'fa82166a5eaaa05a8ae254913039771e03e20bfb'; });
}, 'RUNTIME_MANIFEST_MISMATCH'));
for (const target of [
  'supabase/functions/univeracademy-api/membership-activity.ts',
  'tests/membership/removal-active.test.mjs',
]) {
  test('missing newly pinned target is rejected: ' + target, () => check(root => {
    rmSync(join(root, target));
  }, 'ENOENT'));
  test('newly pinned target wrong size is rejected: ' + target, () => check(root => {
    const path = join(root, target); writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('\n')]));
  }, 'BACKEND_TARGET_SIZE_MISMATCH: ' + target));
  test('newly pinned target same-size corruption is rejected: ' + target, () => check(root => {
    const path = join(root, target), bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
  }, 'BACKEND_TARGET_HASH_MISMATCH: ' + target));
}
test('same-size corruption of new attempts bytes is rejected', () => check(root => {
  const path = join(root, attempts), bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
}, 'BACKEND_TARGET_HASH_MISMATCH: ' + attempts));
test('exact historical 9327-byte attempts is rejected', () => check(root => {
  writeFileSync(join(root, attempts), oldAttempts(root));
}, 'BACKEND_TARGET_SIZE_MISMATCH: ' + attempts));
test('historical attempts padded to new length is rejected', () => check(root => {
  const old = oldAttempts(root), currentBytes = manifest.files.find(file => file.path === attempts).bytes;
  writeFileSync(join(root, attempts), Buffer.concat([old, Buffer.alloc(currentBytes - old.length, 32)]));
}, 'BACKEND_TARGET_HASH_MISMATCH: ' + attempts));
test('another dependency same-size corruption is rejected', () => check(root => {
  const path = join(root, 'package.json'), raw = readFileSync(path, 'utf8');
  const changed = raw.replace('"name"', '"namo"'); assert.notEqual(changed, raw); writeFileSync(path, changed);
}, 'BACKEND_TARGET_HASH_MISMATCH: package.json'));
test('another dependency wrong size is rejected', () => check(root => {
  const path = join(root, 'package.json'); writeFileSync(path, readFileSync(path, 'utf8') + '\n');
}, 'BACKEND_TARGET_SIZE_MISMATCH: package.json'));
test('current manifest tampering is rejected', () => check(root => {
  const path = join(root, current); writeFileSync(path, readFileSync(path, 'utf8') + '\n');
}, 'RUNTIME_MANIFEST_MISMATCH'));

test('browser production client same-size corruption is rejected', () => check(root => {
  const path = join(root, copies[0]), bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
}, 'OWNER_CLIENT_HASH_MISMATCH: student-client.ts'));
test('browser stale-size local-only client is rejected', () => check(root => {
  const path = join(root, copies[0]); writeFileSync(path, readFileSync(path).subarray(0, 6968));
}, 'OWNER_CLIENT_SIZE_MISMATCH: student-client.ts'));
test('browser types same-size corruption is rejected', () => check(root => {
  const path = join(root, copies[1]), bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
}, 'OWNER_CLIENT_HASH_MISMATCH: student-types.d.ts'));

test('new local CORS target same-size corruption is rejected', () => check(root => {
  const path = join(root, 'runtime/local-cors.mjs'), bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
}, 'BACKEND_TARGET_HASH_MISMATCH: runtime/local-cors.mjs'));
test('updated configured HTTP target same-size corruption is rejected', () => check(root => {
  const path = join(root, 'supabase/functions/univeracademy-api/configured-http.ts'), bytes = readFileSync(path);
  bytes[0] ^= 1; writeFileSync(path, bytes);
}, 'BACKEND_TARGET_HASH_MISMATCH: supabase/functions/univeracademy-api/configured-http.ts'));
test('missing new local CORS dependency fails closed', () => check(root => {
  rmSync(join(root, 'runtime/local-cors.mjs'));
}, 'ENOENT'));

test('new Vercel API entry same-size corruption is rejected', () => check(root => {
  const path = join(root, 'api/index.mjs'), bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
}, 'BACKEND_TARGET_HASH_MISMATCH: api/index.mjs'));
test('new Vercel transport same-size corruption is rejected', () => check(root => {
  const path = join(root, 'runtime/vercel-node.mjs'), bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
}, 'BACKEND_TARGET_HASH_MISMATCH: runtime/vercel-node.mjs'));
test('new Vercel configuration wrong size is rejected', () => check(root => {
  const path = join(root, 'vercel.json'); writeFileSync(path, readFileSync(path, 'utf8') + '\n');
}, 'BACKEND_TARGET_SIZE_MISMATCH: vercel.json'));
test('missing new transaction-pool dependency fails closed', () => check(root => {
  rmSync(join(root, 'supabase/functions/univeracademy-api/storage/transaction-pool-port.ts'));
}, 'ENOENT'));

test('new Clerk HTTP target same-size corruption is rejected', () => check(root => {
  const path = join(root, 'supabase/functions/univeracademy-api/clerk-http.ts'), bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
}, 'BACKEND_TARGET_HASH_MISMATCH: supabase/functions/univeracademy-api/clerk-http.ts'));
test('new Clerk verifier target same-size corruption is rejected', () => check(root => {
  const path = join(root, 'supabase/functions/univeracademy-api/clerk-auth.ts'), bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
}, 'BACKEND_TARGET_HASH_MISMATCH: supabase/functions/univeracademy-api/clerk-auth.ts'));
test('Clerk proposal wrong size is rejected', () => check(root => {
  const path = join(root, 'contracts/clerk-auth.proposal.patch.json'); writeFileSync(path, readFileSync(path, 'utf8') + '\n');
}, 'BACKEND_TARGET_SIZE_MISMATCH: contracts/clerk-auth.proposal.patch.json'));
test('missing Clerk fixture dependency fails closed', () => check(root => {
  rmSync(join(root, 'tests/clerk-auth/fixture.mjs'));
}, 'ENOENT'));

const studentState = 'supabase/functions/univeracademy-api/student-state.ts';
function oldStudentState(root) {
  const raw = readFileSync(join(root, studentState), 'utf8');
  assert.equal(sha(Buffer.from(raw)), '208f220a3b72a572a37ab0ffba6763193b67beb3732aebe521f2295039333f72');
  const provenance = '  // Existing standalone handlers may omit it. The Clerk candidate requires\n'
    + '  // explicit provenance for every active family; missing is never "telegram".\n'
    + '  authProvider?: "clerk" | "telegram";\n';
  const old = Buffer.from(raw.replace(provenance, ''));
  assert.equal(old.length, 7338);
  assert.equal(sha(old), '9f8404d4caf65744d781eebd2931e27f2407fc3669a53b7afbfb522ad13183a1');
  return old; // Exact pre-F1 bytes, used only in the temporary negative control.
}

test('F1 student state same-size corruption is rejected', () => check(root => {
  const path = join(root, studentState), bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
}, 'BACKEND_TARGET_HASH_MISMATCH: ' + studentState));
test('exact pre-F1 unmarked student state is rejected', () => check(root => {
  writeFileSync(join(root, studentState), oldStudentState(root));
}, 'BACKEND_TARGET_SIZE_MISMATCH: ' + studentState));
test('pre-F1 student state padded to the current length is rejected', () => check(root => {
  const old = oldStudentState(root); writeFileSync(join(root, studentState), Buffer.concat([old, Buffer.alloc(7532 - old.length, 32)]));
}, 'BACKEND_TARGET_HASH_MISMATCH: ' + studentState));
test('missing F1 family-context regression dependency fails closed', () => check(root => {
  rmSync(join(root, 'tests/clerk-auth/family-context.test.mjs'));
}, 'ENOENT'));

test('Clerk review schema same-size corruption is rejected', () => check(root => {
  const path = join(root, 'contracts/clerk-review.openapi.json'), bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
}, 'BACKEND_TARGET_HASH_MISMATCH: contracts/clerk-review.openapi.json'));
test('missing Clerk review TCP listener fails closed', () => check(root => {
  rmSync(join(root, 'runtime/clerk-review-server.mjs'));
}, 'ENOENT'));

test('stale source claim for historical 133-target checkpoint is rejected', () => check(root => {
  mutateCurrentManifest(root, value => { value.source_commit = 'b9efa5978498d9150db43531da89820e80dc51ee'; });
}, 'RUNTIME_MANIFEST_MISMATCH'));
test('new Clerk provider same-size corruption is rejected', () => check(root => {
  const path = join(root, 'supabase/functions/univeracademy-api/clerk-provider.ts'), bytes = readFileSync(path);
  bytes[0] ^= 1; writeFileSync(path, bytes);
}, 'BACKEND_TARGET_HASH_MISMATCH: supabase/functions/univeracademy-api/clerk-provider.ts'));
test('missing new Clerk provider dependency fails closed', () => check(root => {
  rmSync(join(root, 'supabase/functions/univeracademy-api/clerk-provider.ts'));
}, 'ENOENT'));

test('stale source claim for historical 149-target checkpoint is rejected', () => check(root => {
  mutateCurrentManifest(root, value => { value.source_commit = 'a36d41ac52c2b12eda4f191020d7420edb5dd23f'; });
}, 'RUNTIME_MANIFEST_MISMATCH'));
test('new scoped Clerk storage same-size corruption is rejected', () => check(root => {
  const path = join(root, 'supabase/functions/univeracademy-api/storage/clerk-auth-rows.ts'), bytes = readFileSync(path);
  bytes[0] ^= 1; writeFileSync(path, bytes);
}, 'BACKEND_TARGET_HASH_MISMATCH: supabase/functions/univeracademy-api/storage/clerk-auth-rows.ts'));
test('missing new Clerk SDK worker dependency fails closed', () => check(root => {
  rmSync(join(root, 'runtime/clerk-sdk-worker.mjs'));
}, 'ENOENT'));

test('stale source claim for historical 163-target checkpoint is rejected', () => check(root => {
  mutateCurrentManifest(root, value => { value.source_commit = '6f2dbee78ba5545bd07ce759a9f0a6dde5514e60'; });
}, 'RUNTIME_MANIFEST_MISMATCH'));
test('SDK-CANCEL-1 fixed bindings same-size corruption is rejected', () => check(root => {
  const path = join(root, 'runtime/clerk-sdk-bindings.mjs'), bytes = readFileSync(path);
  bytes[0] ^= 1; writeFileSync(path, bytes);
}, 'BACKEND_TARGET_HASH_MISMATCH: runtime/clerk-sdk-bindings.mjs'));
test('SDK-CANCEL-1 fixed worker same-size corruption is rejected', () => check(root => {
  const path = join(root, 'runtime/clerk-sdk-worker.mjs'), bytes = readFileSync(path);
  bytes[0] ^= 1; writeFileSync(path, bytes);
}, 'BACKEND_TARGET_HASH_MISMATCH: runtime/clerk-sdk-worker.mjs'));
test('missing SDK-CANCEL-1 regression dependency fails closed', () => check(root => {
  rmSync(join(root, 'tests/clerk-auth/sdk-cancel.test.mjs'));
}, 'ENOENT'));


test('stale source claim for historical 172-target checkpoint is rejected', () => check(root => {
  mutateCurrentManifest(root, value => { value.source_commit = 'c78c293acdf9162080c2da796bd0a5d34e4b8c90'; });
}, 'RUNTIME_MANIFEST_MISMATCH'));
test('new TCP abort bridge same-size corruption is rejected', () => check(root => {
  const path = join(root, 'runtime/node-request-abort.mjs'), bytes = readFileSync(path);
  bytes[0] ^= 1; writeFileSync(path, bytes);
}, 'BACKEND_TARGET_HASH_MISMATCH: runtime/node-request-abort.mjs'));
test('new Clerk domain writer same-size corruption is rejected', () => check(root => {
  const path = join(root, 'supabase/functions/univeracademy-api/storage/clerk-domain.ts'), bytes = readFileSync(path);
  bytes[0] ^= 1; writeFileSync(path, bytes);
}, 'BACKEND_TARGET_HASH_MISMATCH: supabase/functions/univeracademy-api/storage/clerk-domain.ts'));
test('missing new domain regression target fails closed', () => check(root => {
  rmSync(join(root, 'tests/clerk-auth/domain-http.test.mjs'));
}, 'ENOENT'));

test('exact same-provenance lab208 manifest cannot replace clean manifest', () => check(root => {
  writeFileSync(join(root, current), lab208Raw);
}, 'RUNTIME_MANIFEST_MISMATCH'));

// Mutations below are rejected at the raw digest boundary. No structural-branch claim.
test('target symlink escaping the clean layout is rejected', () => check(root => {
  const path = join(root, attempts); rmSync(path); symlinkSync(join(source, attempts), path);
}, 'BACKEND_TARGET_PATH_ESCAPE: ' + attempts));

for (const [label, mutate] of [
  ['absolute path', value => { value.files[0].path = '/etc/passwd'; }],
  ['parent traversal', value => { value.files[0].path = '../outside.ts'; }],
  ['backslash path', value => { value.files[0].path = 'runtime\\outside.mjs'; }],
  ['URL path', value => { value.files[0].path = 'https://example.invalid/source.ts'; }],
  ['normalized duplicate', value => { value.files[1].path = './' + value.files[0].path; }],
  ['empty path', value => { value.files[0].path = ''; }],
  ['double separator', value => { value.files[0].path = 'api//index.mjs'; }],
  ['fractional size', value => { value.files[0].bytes += 0.5; }],
  ['negative size', value => { value.files[0].bytes = -1; }],
  ['uppercase hash', value => { value.files[0].sha256 = value.files[0].sha256.toUpperCase(); }],
  ['unsorted rows', value => { value.files.reverse(); }],
  ['wrong repository', value => { value.source_repository = 'other/repository'; }],
  ['wrong tree', value => { value.source_tree = '0'.repeat(40); }],
  ['wrong layout', value => { value.layout = 'lab-workspace'; }],
  ['wrong target count', value => { value.target_count--; }],
  ['wrong target bytes', value => { value.target_bytes--; }],
  ['extra row property', value => { value.files[0].fallback = true; }],
  ['non-array rows', value => { value.files = {}; }],
]) {
  test('manifest digest rejects ' + label, () => check(root => mutateCurrentManifest(root, mutate),
    'RUNTIME_MANIFEST_MISMATCH'));
}

test('exact previous clean111 inventory is historical, never an active fallback', () => check(root => {
  writeFileSync(join(root, current), previousCleanRaw);
}, 'RUNTIME_MANIFEST_MISMATCH'));
// Every selected input has its own isolated deliberate target diagnostics.
for (const { path: target } of manifest.files) {
  test('selected target missing: ' + target, () => check(root => rmSync(join(root, target)), 'ENOENT'));
  test('selected target wrong size: ' + target, () => check(root => {
    const path = join(root, target); writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('\n')]));
  }, 'BACKEND_TARGET_SIZE_MISMATCH: ' + target));
  test('selected target same-size corruption: ' + target, () => check(root => {
    const path = join(root, target), b = readFileSync(path); b[0] ^= 1; writeFileSync(path, b);
  }, 'BACKEND_TARGET_HASH_MISMATCH: ' + target));
}
const metadataCases = [];
function metadataCase(label, mutate, diagnostic) { metadataCases.push([label, mutate, diagnostic]); }
for (const key of ['format_version','source_repository','source_commit','source_tree','layout','selection_policy','target_count','target_bytes'])
  metadataCase('wrong ' + key, value => { value[key] = typeof value[key] === 'number' ? value[key] - 1 : 'wrong'; }, 'ASSEMBLY_METADATA_MISMATCH: ' + key);
for (const key of ['repository','commit','tree','parent'])
  metadataCase('wrong corrected type base ' + key, value => { value.application_base[key] = 'wrong'; }, 'ASSEMBLY_METADATA_MISMATCH: application_base');
metadataCase('missing correction layer', value => { value.backend_overlays.pop(); }, 'ASSEMBLY_METADATA_MISMATCH: backend_overlays');
metadataCase('extra correction layer', value => { value.backend_overlays.push(structuredClone(value.backend_overlays[0])); }, 'ASSEMBLY_METADATA_MISMATCH: backend_overlays');
for (const key of ['repository','commit','tree','parent','prefix'])
  metadataCase('wrong correction ' + key, value => { value.backend_overlays[0][key] = 'wrong'; }, 'ASSEMBLY_METADATA_MISMATCH: backend_overlays[0].' + key);
for (const [label, mutate, code] of [
  ['omitted correction', l => l.files.pop(), 'ASSEMBLY_MAPPING_COUNT_MISMATCH'],
  ['extra correction', l => l.files.push(structuredClone(l.files[0])), 'ASSEMBLY_MAPPING_COUNT_MISMATCH'],
  ['duplicate correction', l => { l.files[1] = structuredClone(l.files[0]); }, 'ASSEMBLY_MAPPING_DUPLICATE'],
  ['wrong source prefix', l => { l.files[0].source_path = 'wrong/source.ts'; }, 'ASSEMBLY_MAPPING_PATH_MISMATCH'],
  ['path escape', l => { l.files[0].source_path = l.files[0].application_path = '../escape.ts'; }, 'ASSEMBLY_MAPPING_PATH_MISMATCH'],
  ['unsupported mode', l => { l.files[0].mode = '100755'; }, 'ASSEMBLY_MAPPING_MODE_MISMATCH'],
  ['unexpected collision', l => { l.files[0].source_path = l.files[0].application_path = 'package.json'; }, 'ASSEMBLY_UNEXPECTED_COLLISION'],
  ['wrong preimage', l => { l.files[0].preimage.sha256 = '0'.repeat(64); }, 'ASSEMBLY_PREIMAGE_MISMATCH'],
  ['missing preimage', l => { l.files[0].preimage = null; }, 'ASSEMBLY_PREIMAGE_MISMATCH'],
  ['wrong final correction hash', l => { l.files[0].sha256 = '0'.repeat(64); }, 'ASSEMBLY_MAPPING_MISMATCH'],
  ['reordered corrections', l => { l.files.reverse(); }, 'ASSEMBLY_MAPPING_MISMATCH'],
]) metadataCase(label, value => mutate(value.backend_overlays[0]), code + ': backend_overlays[0]');
for (const [label, mutate, diagnostic] of metadataCases)
  test('test-only rebound metadata validator: ' + label, () => check(root => mutateCurrentManifest(root, mutate), diagnostic, { rebindDigest: true }));
for (const [label, mutate, diagnostic] of [
  ['absolute path', v => { v.files[0].path = '/outside'; }, 'RUNTIME_TARGET_PATH_MISMATCH'],
  ['traversal', v => { v.files[0].path = '../outside'; }, 'RUNTIME_TARGET_PATH_MISMATCH'],
  ['URL', v => { v.files[0].path = 'https://outside.test/file'; }, 'RUNTIME_TARGET_PATH_MISMATCH'],
  ['duplicate', v => { v.files[1] = { ...v.files[0] }; }, 'RUNTIME_TARGET_DUPLICATE'],
  ['omitted input', v => { v.files.pop(); }, 'RUNTIME_TARGET_COUNT_MISMATCH'],
  ['extra input', v => { v.files.push({ ...v.files[0] }); }, 'RUNTIME_TARGET_COUNT_MISMATCH'],
  ['substitution', v => { v.files[0].path = 'api/unknown.mjs'; }, 'RUNTIME_TARGET_SET_MISMATCH'],
  ['fractional bytes', v => { v.files[0].bytes += 0.5; }, 'RUNTIME_TARGET_SIZE_SHAPE_MISMATCH'],
  ['upper hash', v => { v.files[0].sha256 = v.files[0].sha256.toUpperCase(); }, 'RUNTIME_TARGET_HASH_SHAPE_MISMATCH'],
  ['row order', v => { v.files.reverse(); }, 'RUNTIME_TARGET_ORDER_MISMATCH'],
  ['total bytes', v => { v.files[0].bytes++; }, 'RUNTIME_TARGET_BYTES_MISMATCH'],
]) test('test-only rebound target validator: ' + label, () => check(root => mutateCurrentManifest(root, mutate), diagnostic, { rebindDigest: true }));

test('previous accepted133 manifest is historical and cannot replace fixture-aligned authority', () => check(root => {
  writeFileSync(join(root, current), previousAssemblyRaw);
}, 'RUNTIME_MANIFEST_MISMATCH'));
for (const index of [1, 2]) {
  const label = 'backend_overlays[' + index + ']';
  for (const key of ['repository','commit','tree','parent','prefix'])
    test('fixture layer metadata rejects '+label+'.'+key, () => check(root => mutateCurrentManifest(root, value => {
      value.backend_overlays[index][key] = 'wrong';
    }), 'ASSEMBLY_METADATA_MISMATCH: '+label+'.'+key, { rebindDigest: true }));
  for (const [name, mutate, diagnostic] of [
    ['missing fixture', layer => layer.files.pop(), 'ASSEMBLY_MAPPING_COUNT_MISMATCH'],
    ['extra fixture', layer => layer.files.push(structuredClone(layer.files[0])), 'ASSEMBLY_MAPPING_COUNT_MISMATCH'],
    ['duplicate fixture', layer => { layer.files[1] = structuredClone(layer.files[0]); }, 'ASSEMBLY_MAPPING_DUPLICATE'],
    ['wrong fixture preimage', layer => { layer.files.find(f => f.preimage).preimage.sha256 = '0'.repeat(64); }, 'ASSEMBLY_PREIMAGE_MISMATCH'],
    ['fixture path escape', layer => { layer.files[0].source_path = layer.files[0].application_path = '../outside.mjs'; }, 'ASSEMBLY_MAPPING_PATH_MISMATCH'],
    ['fixture unsupported mode', layer => { layer.files[0].mode = '100755'; }, 'ASSEMBLY_MAPPING_MODE_MISMATCH'],
    ['fixture stale digest', layer => { layer.files[0].sha256 = '0'.repeat(64); }, 'ASSEMBLY_MAPPING_MISMATCH'],
  ]) test('fixture layer rejects '+label+' '+name, () => check(root => mutateCurrentManifest(root, value => mutate(value.backend_overlays[index])), diagnostic+': '+label, { rebindDigest: true }));
}
test('final fixture layer cannot pretend to precede the first accepted fixture layer', () => check(root => {
  mutateCurrentManifest(root, value => { [value.backend_overlays[1], value.backend_overlays[2]] = [value.backend_overlays[2], value.backend_overlays[1]]; });
}, 'ASSEMBLY_METADATA_MISMATCH: backend_overlays[1].commit', { rebindDigest: true }));

const protectedContentPath = "tests/membership/protection-postgres-transaction.test.mjs";
const reverseContentEdits = [
  [
    "  assert.deepEqual(h.ledger.filter(e=>['query.entry','prepare.entry','work.entry','gate.entry'].includes(e.event)).map(e=>e.name??e.event),\n    ['ua_begin','ua_context_reset','ua_context_phase','prepare.entry','trusted_authorization_anchor','ua_people_context','ua_people_lock','ua_clock','work.entry','ua_test_flush','gate.entry','ua_commit']);\n  const reset=h.ledger.find(e=>e.event==='query.entry'&&e.name==='ua_context_reset'),auth=h.ledger.find(e=>e.event==='query.entry'&&e.name==='ua_context_phase');\n  assert.equal(reset.text,\"SELECT set_config('ua.phase',$1,true),set_config('ua.person_id',$2,true),set_config('ua.person_ids',$3,true),set_config('ua.clerk_issuer',$4,true),set_config('ua.clerk_subject',$5,true),set_config('ua.telegram_id',$6,true)\");\n  assert.deepEqual(reset.values,['deny','','[]','','','']);\n  assert.equal(auth.text,\"SELECT set_config('ua.phase',$1,true)\");assert.deepEqual(auth.values,['auth']);\n  const gateReturn=h.ledger.findIndex(e=>e.event==='gate.return');assert.equal(h.ledger[gateReturn+1].name,'ua_commit');\n",
    "  assert.deepEqual(h.ledger.filter(e=>['query.entry','prepare.entry','work.entry','gate.entry'].includes(e.event)).map(e=>e.name??e.event),\n    ['ua_begin','prepare.entry','trusted_authorization_anchor','ua_people_context','ua_people_lock','ua_clock','work.entry','ua_test_flush','gate.entry','ua_commit']);\n  const gateReturn=h.ledger.findIndex(e=>e.event==='gate.return');assert.equal(h.ledger[gateReturn+1].name,'ua_commit');\n"
  ],
  [
    "});\nfor(const name of ['ua_context_reset','ua_context_phase','ua_people_context','ua_people_lock','ua_clock'])checked('B09-query-fault-'+name,'rollback',async()=>{\n  const error=Error(name),h=harness({queryFailure:name,error,model:false});await assert.rejects(h.run(),e=>e===error);rolledBack(h);assert.equal(h.gateCalls,0);\n  if(name==='ua_context_reset'||name==='ua_context_phase'){\n    assert.equal(h.prepareCalls,0);assert.equal(h.workCalls,0);assert.equal(entries(h,'ua_people_context'),0);assert.equal(entries(h,'ua_people_lock'),0);\n    assert.equal(entries(h,'ua_context_reset'),1);assert.equal(entries(h,'ua_context_phase'),name==='ua_context_phase'?1:0);assert.equal(h.writes.length,0);\n  }\n});\n",
    "});\nfor(const name of ['ua_people_context','ua_people_lock','ua_clock'])checked('B09-query-fault-'+name,'rollback',async()=>{\n  const error=Error(name),h=harness({queryFailure:name,error,model:false});await assert.rejects(h.run(),e=>e===error);rolledBack(h);assert.equal(h.gateCalls,0);\n});\n"
  ],
  [
    "  assert.equal(value,'legacy');assert.equal(h.prepareCalls,0);assert.equal(h.gateCalls,0);assert.equal(h.observerCalls,0);\n  assert.deepEqual(h.ledger.filter(e=>e.event==='query.entry').map(e=>e.name),['ua_begin','ua_context_reset','ua_context_phase','ua_people_context','ua_people_lock','ua_clock','legacy_work','ua_commit']);\n});\n",
    "  assert.equal(value,'legacy');assert.equal(h.prepareCalls,0);assert.equal(h.gateCalls,0);assert.equal(h.observerCalls,0);\n  assert.deepEqual(h.ledger.filter(e=>e.event==='query.entry').map(e=>e.name),['ua_begin','ua_people_context','ua_people_lock','ua_clock','legacy_work','ua_commit']);\n});\n"
  ],
  [
    "  },async tx=>{own(tx,P);assert.throws(()=>own(tx,Q),isFault('NOT_FOUND',404));return 'identity';}),'identity');\n  assert.deepEqual(h.ledger.filter(e=>e.event==='query.entry').map(e=>e.name),['ua_begin','ua_context_reset','ua_context_phase','ua_telegram_identity_lock','ua_telegram_identity_context','ua_clock','ua_people_context','ua_people_lock','ua_clock','ua_commit']);\n  assert.equal(h.gateCalls,0);assert.equal(h.observerCalls,0);\n",
    "  },async tx=>{own(tx,P);assert.throws(()=>own(tx,Q),isFault('NOT_FOUND',404));return 'identity';}),'identity');\n  assert.deepEqual(h.ledger.filter(e=>e.event==='query.entry').map(e=>e.name),['ua_begin','ua_telegram_identity_lock','ua_telegram_identity_context','ua_clock','ua_people_context','ua_people_lock','ua_clock','ua_commit']);\n  assert.equal(h.gateCalls,0);assert.equal(h.observerCalls,0);\n"
  ],
  [
    "  assert.deepEqual(workIds,[P]);assert.equal(h.workCalls,1);assert.equal(entries(h,'ua_commit'),1);assert.equal(entries(h,'ua_rollback'),0);\n  assert.deepEqual(h.ledger.find(e=>e.name==='ua_people_context').values,[P,JSON.stringify([P])]);\n  assert.deepEqual(h.ledger.find(e=>e.name==='ua_people_lock').values,[[P]]);\n",
    "  assert.deepEqual(workIds,[P]);assert.equal(h.workCalls,1);assert.equal(entries(h,'ua_commit'),1);assert.equal(entries(h,'ua_rollback'),0);\n  assert.deepEqual(h.ledger.find(e=>e.name==='ua_people_context').values,[JSON.stringify([P])]);\n  assert.deepEqual(h.ledger.find(e=>e.name==='ua_people_lock').values,[[P]]);\n"
  ]
];
function staleProtectedContent(root) {
  let text = readFileSync(join(root, protectedContentPath), 'utf8');
  assert.equal(Buffer.byteLength(text), 34385, 'CONTENT_FIXTURE_PREPARATION_MISMATCH');
  assert.equal(sha(Buffer.from(text)), "1d7205d9f0ce90e7f75030a7fa8049b314e3c951cec970f27dafcaffb60ac4a8", 'CONTENT_FIXTURE_PREPARATION_MISMATCH');
  for (const [from, to] of reverseContentEdits) {
    assert.equal(text.split(from).length, 2, 'CONTENT_FIXTURE_PREPARATION_MISMATCH');
    text = text.replace(from, to);
  }
  const raw = Buffer.from(text);
  assert.equal(raw.length, 33274, 'CONTENT_FIXTURE_PREPARATION_MISMATCH');
  assert.equal(sha(raw), "49db7421e71cd71966bbf1bd24e952539b8f5062f0621fd349db38f22eca6beb", 'CONTENT_FIXTURE_PREPARATION_MISMATCH');
  if (process.env.UA_MINI_PIN_GUARD_TRACE_PATH) appendFileSync(process.env.UA_MINI_PIN_GUARD_TRACE_PATH,
    JSON.stringify({control:'content_fixture_preparation',source_bytes:34385,result_bytes:raw.length,result_sha256:sha(raw),status:'PASS'})+'\n');
  return raw;
}
test('format3 content-base manifest cannot replace format4 authority', () => check(root => {
  writeFileSync(join(root,current),previousContentBaseRaw);
}, 'RUNTIME_MANIFEST_MISMATCH'));
for (const padded of [false,true]) test('actual stale protected content is rejected; padded='+padded, () => check(root => {
  const raw=staleProtectedContent(root);
  writeFileSync(join(root,protectedContentPath),padded?Buffer.concat([raw,Buffer.alloc(1111,32)]):raw);
}, (padded?'BACKEND_TARGET_HASH_MISMATCH: ':'BACKEND_TARGET_SIZE_MISMATCH: ')+protectedContentPath));
const contentCases=[
 ['missing',v=>{v.content_overlays=[];},'COUNT'],
 ['extra',v=>{v.content_overlays.push({...v.content_overlays[0],path:'extra.mjs'});},'COUNT'],
 ['duplicate',v=>{v.content_overlays.push(structuredClone(v.content_overlays[0]));},'COUNT'],
 ['wrong path',v=>{v.content_overlays[0].path='runtime/local-cors.mjs';},'PATH'],
 ['wrong base',v=>{v.content_overlays[0].base_commit='0'.repeat(40);},'BASE'],
 ['wrong patch',v=>{v.content_overlays[0].patch_sha256='0'.repeat(64);},'PATCH'],
 ['extra entry field',v=>{v.content_overlays[0].fallback=true;},'SHAPE'],
 ['null entry',v=>{v.content_overlays[0]=null;},'SHAPE'],
 ['wrong target binding',v=>{v.files.find(f=>f.path===protectedContentPath).sha256='0'.repeat(64);},'TARGET'],
];
for(const part of ['preimage','result'])for(const key of ['mode','bytes','sha256'])
 contentCases.push([part+' '+key,v=>{const x=v.content_overlays[0][part];x[key]=key==='mode'?'100755':key==='bytes'?x.bytes-1:'0'.repeat(64);},key==='mode'?'MODE':part.toUpperCase()]);
for(const [label,mutate,code] of contentCases)test('content overlay metadata rejects '+label,()=>check(root=>mutateCurrentManifest(root,mutate),'CONTENT_OVERLAY_'+code+'_MISMATCH',{rebindDigest:true}));

const listenerContentPath = "tests/clerk-auth/review-listener.test.mjs";
const reverseListenerEdit = [
  "  const base = JSON.parse(readFileSync(new URL(\"../../contracts/review-only.openapi.json\", import.meta.url)));\n  const canonicalRaw = readFileSync(new URL(\"../../contracts/telegram-return.openapi.json\", import.meta.url));\n  const canonical = JSON.parse(canonicalRaw);\n  assert.equal(createHash(\"sha256\").update(canonicalRaw).digest(\"hex\"), STUDENT_CONTRACT_SHA256);\n  assert.equal(canonical.info.version, STUDENT_CONTRACT_VERSION);\n  assert.equal(canonical['x-status'], STUDENT_CONTRACT_REVIEW_STATUS);\n  assert.equal(canonical['x-telegram-return-review'].base_file, \"contracts/clerk-review.openapi.json\");\n  assert.equal(createHash(\"sha256\").update(raw).digest(\"hex\"), canonical['x-telegram-return-review'].base_sha256);\n  assert.equal(review.info.version, \"0.3.0-clerk-exchange-review.1\");\n  assert.equal(review['x-status'], \"PROVISIONAL / NOT ACCEPTED\");\n",
  "  const base = JSON.parse(readFileSync(new URL(\"../../contracts/review-only.openapi.json\", import.meta.url)));\n  assert.equal(createHash(\"sha256\").update(raw).digest(\"hex\"), STUDENT_CONTRACT_SHA256);\n  assert.equal(review.info.version, STUDENT_CONTRACT_VERSION);\n  assert.equal(review['x-status'], STUDENT_CONTRACT_REVIEW_STATUS);\n  assert.equal(review['x-status'], \"PROVISIONAL / NOT ACCEPTED\");\n"
];
function staleListenerContent(root) {
  let text = readFileSync(join(root, listenerContentPath), 'utf8');
  assert.equal(Buffer.byteLength(text), 11661, 'LISTENER_FIXTURE_PREPARATION_MISMATCH');
  assert.equal(sha(Buffer.from(text)), "095432668b0a0cac2b6e31df574e9da0ddb490a79f9ebbc3dc1bbff8e2a44c78", 'LISTENER_FIXTURE_PREPARATION_MISMATCH');
  const [from,to]=reverseListenerEdit;
  assert.equal(text.split(from).length, 2, 'LISTENER_FIXTURE_PREPARATION_MISMATCH');
  const raw=Buffer.from(text.replace(from,to));
  assert.equal(raw.length,11200,'LISTENER_FIXTURE_PREPARATION_MISMATCH');
  assert.equal(sha(raw),"f78c5b7f2994369043757366cb3a0218174ed7fa52f632dc0c89e7e8a53a6cdb",'LISTENER_FIXTURE_PREPARATION_MISMATCH');
  if(process.env.UA_MINI_PIN_GUARD_TRACE_PATH)appendFileSync(process.env.UA_MINI_PIN_GUARD_TRACE_PATH,
    JSON.stringify({control:'listener_fixture_preparation',source_bytes:11661,result_bytes:raw.length,result_sha256:sha(raw),status:'PASS'})+'\n');
  return raw;
}
for(const padded of [false,true])test('actual stale listener content rejected; padded='+padded,()=>check(root=>{
 const raw=staleListenerContent(root);
 writeFileSync(join(root,listenerContentPath),padded?Buffer.concat([raw,Buffer.alloc(461,32)]):raw);
},(padded?'BACKEND_TARGET_HASH_MISMATCH: ':'BACKEND_TARGET_SIZE_MISMATCH: ')+listenerContentPath));
const listenerCases=[
 ['missing second',v=>{v.content_overlays.pop();},'COUNT'],
 ['missing first',v=>{v.content_overlays.shift();},'COUNT'],
 ['duplicate within fixed count',v=>{v.content_overlays[1]=structuredClone(v.content_overlays[0]);},'PATH'],
 ['reordered',v=>{v.content_overlays.reverse();},'PATH'],
 ['wrong path',v=>{v.content_overlays[1].path='runtime/local-cors.mjs';},'PATH'],
 ['wrong base',v=>{v.content_overlays[1].base_commit='0'.repeat(40);},'BASE'],
 ['wrong patch',v=>{v.content_overlays[1].patch_sha256='0'.repeat(64);},'PATCH'],
 ['extra field',v=>{v.content_overlays[1].fallback=true;},'SHAPE'],
 ['null entry',v=>{v.content_overlays[1]=null;},'SHAPE'],
 ['wrong target',v=>{v.files.find(f=>f.path===listenerContentPath).sha256='0'.repeat(64);},'TARGET'],
];
for(const part of ['preimage','result'])for(const key of ['mode','bytes','sha256'])
 listenerCases.push([part+' '+key,v=>{const x=v.content_overlays[1][part];x[key]=key==='mode'?'100755':key==='bytes'?x.bytes-1:'0'.repeat(64);},key==='mode'?'MODE':part.toUpperCase()]);
for(const [label,mutate,code] of listenerCases)test('listener content metadata rejects '+label,()=>check(root=>mutateCurrentManifest(root,mutate),'CONTENT_OVERLAY_'+code+'_MISMATCH',{rebindDigest:true}));

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
const current = 'apps/mini-app/tests/fixtures/backend-d54d19c-clean-manifest.json';
const lab208 = 'apps/mini-app/tests/fixtures/backend-d54d19c-manifest.json';
const historicalAttempts = 'apps/mini-app/tests/fixtures/attempts-8a750ee.ts.txt';
const copies = ['student-client.ts', 'student-types.d.ts'].map(name => 'apps/mini-app/src/owner-client/' + name);
const attempts = 'supabase/functions/univeracademy-api/attempts.ts';
const sha = value => createHash('sha256').update(value).digest('hex');
const manifest = JSON.parse(readFileSync(join(source, current), 'utf8'));
const lab208Raw = readFileSync(join(source, lab208));
assert.equal(lab208Raw.length, 42473);
assert.equal(sha(lab208Raw), '5372551a2ca45bb2505a4f198445e9867273411b74ce998c4611851c1cb2005e');
// Opaque historical byte fixture: its JSON target rows are never traversed.
const manifestErrors = new Map([['RUNTIME_MANIFEST_MISMATCH', current], ['HISTORICAL_ATTEMPTS_FIXTURE_MISMATCH', historicalAttempts]]);
let pristinePassed = false;

function check(mutate, expected) {
  if (expected) assert(pristinePassed, 'PRISTINE_GUARD_CONTROL_REQUIRED');
  const root = mkdtempSync(join(tmpdir(), 'ua-current-guard-'));
  try {
    const inputs = [...new Set([guard, current, lab208, historicalAttempts, ...copies, ...manifest.files.map(file => file.path)])];
    const before = new Map();
    for (const name of inputs) {
      const path = join(root, name); mkdirSync(dirname(path), { recursive: true });
      const bytes = readFileSync(join(source, name));
      before.set(name, sha(bytes)); writeFileSync(path, bytes);
    }
    mutate?.(root);
    const changed = inputs.filter(name => !existsSync(join(root, name)) || lstatSync(join(root, name)).isSymbolicLink() ||
      sha(readFileSync(join(root, name))) !== before.get(name));
    assert.equal(changed.length, expected ? 1 : 0, 'CONTROL_MUST_CHANGE_ONLY_ITS_DELIBERATE_TARGET');
    const result = spawnSync(process.execPath, [guard], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, expected ? 1 : 0, result.stderr);
    if (expected) {
      assert(result.stderr.includes(expected), result.stderr);
      const suffix = expected.split(': ')[1];
      const target = expected === 'ENOENT' ? changed[0] :
        expected.startsWith('OWNER_CLIENT_') ? 'apps/mini-app/src/owner-client/' + suffix :
        expected.startsWith('BACKEND_TARGET_') ? suffix : manifestErrors.get(expected);
      assert.equal(changed[0], target, 'DIAGNOSTIC_MUST_IDENTIFY_THE_DELIBERATE_TARGET');
      if (expected === 'ENOENT') assert(result.stderr.includes(target), result.stderr);
    } else pristinePassed = true;
    if (process.env.UA_MINI_PIN_GUARD_TRACE_PATH) appendFileSync(process.env.UA_MINI_PIN_GUARD_TRACE_PATH,
      JSON.stringify({ control: expected ? 'negative' : 'pristine_positive', target: changed[0] ?? null,
        expected: expected ?? null, status: result.status, deliberate_target_verified: true,
        stderr_sha256: sha(Buffer.from(result.stderr)) }) + '\n');
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

test('current guard accepts all 111 clean exact d54 Backend files and both browser owner copies', () => check());
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

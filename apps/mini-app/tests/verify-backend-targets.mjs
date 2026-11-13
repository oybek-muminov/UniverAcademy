import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fixed synchronous selected-file authority; no network, override or fallback.
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedPaths = [
  "api/index.mjs",
  "contracts/clerk-auth.proposal.patch.json",
  "contracts/clerk-review.openapi.json",
  "contracts/review-only.openapi.json",
  "contracts/telegram-return.openapi.json",
  "package-lock.json",
  "package.json",
  "packages/api-client/staff-openapi.json",
  "packages/api-client/staff-types.d.ts",
  "packages/api-client/student-client.ts",
  "packages/api-client/student-openapi.json",
  "packages/api-client/student-types.d.ts",
  "runtime/clerk-review-server.mjs",
  "runtime/clerk-sdk-bindings.mjs",
  "runtime/clerk-sdk-worker.mjs",
  "runtime/clerk-worker-bindings.mjs",
  "runtime/cloudflare-api.mjs",
  "runtime/cloudflare-entry.mjs",
  "runtime/cloudflare-postgres.mjs",
  "runtime/cloudflare-telegram-directory.mjs",
  "runtime/cloudflare-worker.mjs",
  "runtime/configured-server.mjs",
  "runtime/content-pilot-driver.mjs",
  "runtime/content-pilot-lab.mjs",
  "runtime/content-pilot-server.mjs",
  "runtime/local-cors.mjs",
  "runtime/local-lab.mjs",
  "runtime/local-server.mjs",
  "runtime/node-request-abort.mjs",
  "runtime/production-options.mjs",
  "runtime/ungrouped-driver.mjs",
  "runtime/ungrouped-fixture.mjs",
  "runtime/ungrouped-lab.mjs",
  "runtime/ungrouped-server.mjs",
  "runtime/vercel-node.mjs",
  "supabase/functions/univeracademy-api/attempts.ts",
  "supabase/functions/univeracademy-api/clerk-auth.ts",
  "supabase/functions/univeracademy-api/clerk-http.ts",
  "supabase/functions/univeracademy-api/clerk-provider.ts",
  "supabase/functions/univeracademy-api/configured-http.ts",
  "supabase/functions/univeracademy-api/fault.ts",
  "supabase/functions/univeracademy-api/individual-points.ts",
  "supabase/functions/univeracademy-api/membership-activity.ts",
  "supabase/functions/univeracademy-api/membership-effects.ts",
  "supabase/functions/univeracademy-api/membership-preflight.ts",
  "supabase/functions/univeracademy-api/membership-removal-http.ts",
  "supabase/functions/univeracademy-api/membership-removal.ts",
  "supabase/functions/univeracademy-api/ordinary.ts",
  "supabase/functions/univeracademy-api/pilot-provisioning.ts",
  "supabase/functions/univeracademy-api/removal-authority.ts",
  "supabase/functions/univeracademy-api/staff-content.ts",
  "supabase/functions/univeracademy-api/staff-http.ts",
  "supabase/functions/univeracademy-api/staff-json.ts",
  "supabase/functions/univeracademy-api/staff-jwt.ts",
  "supabase/functions/univeracademy-api/staff-state.ts",
  "supabase/functions/univeracademy-api/storage/attempt-rows.ts",
  "supabase/functions/univeracademy-api/storage/clerk-auth-rows.ts",
  "supabase/functions/univeracademy-api/storage/clerk-domain.ts",
  "supabase/functions/univeracademy-api/storage/membership-preflight-port.ts",
  "supabase/functions/univeracademy-api/storage/membership-protection-contract.ts",
  "supabase/functions/univeracademy-api/storage/postgres-transaction.ts",
  "supabase/functions/univeracademy-api/storage/prepared-student.ts",
  "supabase/functions/univeracademy-api/storage/session-rows.ts",
  "supabase/functions/univeracademy-api/storage/staff-access-rows.ts",
  "supabase/functions/univeracademy-api/storage/staff-first-test-rows.ts",
  "supabase/functions/univeracademy-api/storage/student-http-rows.ts",
  "supabase/functions/univeracademy-api/storage/student-identity-rows.ts",
  "supabase/functions/univeracademy-api/storage/student-scope.ts",
  "supabase/functions/univeracademy-api/storage/telegram-return-rows.ts",
  "supabase/functions/univeracademy-api/storage/transaction-pool-port.ts",
  "supabase/functions/univeracademy-api/storage/trusted-server-context.ts",
  "supabase/functions/univeracademy-api/student-http.ts",
  "supabase/functions/univeracademy-api/student-state.ts",
  "supabase/functions/univeracademy-api/student-wire.ts",
  "supabase/functions/univeracademy-api/telegram-return.ts",
  "supabase/functions/univeracademy-api/telegram.ts",
  "supabase/proposals/telegram-identity-permissions.review.sql",
  "tests/backend/http-fixture.ts",
  "tests/backend/staff-fixture.ts",
  "tests/backend/student-prepared/memory-pool.mjs",
  "tests/backend/student-prepared/profile-context.test.mjs",
  "tests/backend/student-prepared/telegram-return.test.mjs",
  "tests/backend/student-prepared/telegram-rows.test.mjs",
  "tests/backend/validator/ajv-config.cjs",
  "tests/backend/validator/base-ajv-config.cjs",
  "tests/backend/validator/tooling/package-lock.json",
  "tests/backend/validator/tooling/package.json",
  "tests/backend/validator/view-builder.cjs",
  "tests/clerk-auth/contract.test.mjs",
  "tests/clerk-auth/domain-executor-shapes.test.mjs",
  "tests/clerk-auth/domain-executor.mjs",
  "tests/clerk-auth/domain-http.test.mjs",
  "tests/clerk-auth/domain-session-rows.test.mjs",
  "tests/clerk-auth/family-context.test.mjs",
  "tests/clerk-auth/fixture.mjs",
  "tests/clerk-auth/http.test.mjs",
  "tests/clerk-auth/provider-adapter.test.mjs",
  "tests/clerk-auth/review-listener.test.mjs",
  "tests/clerk-auth/review-types.test.ts",
  "tests/clerk-auth/scoped-store.test.mjs",
  "tests/clerk-auth/sdk-binding.test.mjs",
  "tests/clerk-auth/sdk-cancel.test.mjs",
  "tests/clerk-auth/staff-parallel.test.mjs",
  "tests/clerk-auth/tcp-cancel.test.mjs",
  "tests/clerk-auth/verifier.test.mjs",
  "tests/cloudflare/api-postgres.test.mjs",
  "tests/cloudflare/clerk-worker-bindings.test.mjs",
  "tests/cloudflare/entry.test.mjs",
  "tests/cloudflare/telegram-wiring.test.mjs",
  "tests/enrollment/identity-staff.test.mjs",
  "tests/enrollment/production-client.test.mjs",
  "tests/enrollment/telegram-client.test.mjs",
  "tests/first-test/cors.test.mjs",
  "tests/first-test/executor.mjs",
  "tests/first-test/fixture.mjs",
  "tests/first-test/http.test.mjs",
  "tests/local-content-pilot.test.mjs",
  "tests/membership/preflight-adapter.test.mjs",
  "tests/membership/protection-contract.test.mjs",
  "tests/membership/protection-postgres-transaction.test.mjs",
  "tests/membership/removal-active.test.mjs",
  "tests/membership/removal-command.test.mjs",
  "tests/membership/removal-http.test.mjs",
  "tests/membership/shared-expiry-invariant.test.mjs",
  "tests/persistent-http/executor.mjs",
  "tests/persistent-http/http.test.mjs",
  "tests/storage-auth/context-protocol.test.mjs",
  "tests/storage-auth/disk-executor.mjs",
  "tests/storage-auth/staff-jwt.test.mjs",
  "tests/storage-auth/storage.test.mjs",
  "tests/vercel-node/adapter.test.mjs",
  "tests/vercel-node/pool-port.test.mjs",
  "tests/vercel-node/production-options.test.mjs",
  "tools/generate-staff-contract.py",
  "vercel.json",
  "wrangler.api.jsonc"
];
const ACTIVE_MANIFEST_SHA256 = '3fa06b7fdd5dcd8b129776a2679ccea98c3aa84807c73902eecb3e1356dc2ce8';
const expectedAssembly = {
  "format_version": 4,
  "source_repository": "oybek-muminov/UniverAcademy",
  "source_commit": "14f0b07441a80aea42d2af7877ad898cd452f50e",
  "source_tree": "1429493eceb35c0448376bb797eba768d8f8a10c",
  "application_base": {
    "repository": "oybek-muminov/UniverAcademy",
    "commit": "2443889cca3d0c496ccd4e85008bbaaacec6fe6a",
    "tree": "4d334618ff06ddd6ff89655767563c819e46d3ad",
    "parent": "3271106b24f9d61568ba1c4ea8ad53740e008411"
  },
  "backend_overlays": [
    {
      "repository": "oybek-muminov/UniverAcademy",
      "commit": "32fd4559e54f0dcbe950ad2a2f56bf5140a45798",
      "tree": "d719c1ab08bafd748113d6648da9c077c8c292b2",
      "parent": "fadf18fc9485f866d4d6cf6cdbd4440870582a68",
      "prefix": "",
      "files": [
        {
          "source_path": "supabase/functions/univeracademy-api/storage/telegram-return-rows.ts",
          "application_path": "supabase/functions/univeracademy-api/storage/telegram-return-rows.ts",
          "mode": "100644",
          "bytes": 16821,
          "sha256": "ca9e1d5c8e418cda1ff4938f969f200a66eac9fb6c1eba4188bee0e33601d5b4",
          "preimage": {
            "mode": "100644",
            "bytes": 16822,
            "sha256": "ea4ea2b69307bb9ad516aefa1cc79fda6a29ccd5afab61fef1155b5f41399897"
          }
        },
        {
          "source_path": "supabase/functions/univeracademy-api/telegram-return.ts",
          "application_path": "supabase/functions/univeracademy-api/telegram-return.ts",
          "mode": "100644",
          "bytes": 4237,
          "sha256": "91ccc1a4b1ab92ea2e116670a4b3849958f4d40994ec654efd91f47c5da492d9",
          "preimage": {
            "mode": "100644",
            "bytes": 4228,
            "sha256": "1da320be30e11ab48bc126660e76213233dfcc2adcfbe28c82eee2533fcaaa94"
          }
        }
      ]
    },
    {
      "repository": "oybek-muminov/UniverAcademy",
      "commit": "e6a930625b92c219bb38e6f9b99440474de577bd",
      "tree": "f73b108dde661ea0114a7a58c6745263e20dbe3c",
      "parent": "e960f1b2dbcb46147898c429bda17e28776dddc4",
      "prefix": "",
      "files": [
        {
          "source_path": "tests/clerk-auth/domain-executor-shapes.test.mjs",
          "application_path": "tests/clerk-auth/domain-executor-shapes.test.mjs",
          "mode": "100644",
          "bytes": 7785,
          "sha256": "26f0b443e7f32a93592477adff667614f5cf79b03d2a98252531425fbfcf7d5f",
          "preimage": null
        },
        {
          "source_path": "tests/clerk-auth/domain-executor.mjs",
          "application_path": "tests/clerk-auth/domain-executor.mjs",
          "mode": "100644",
          "bytes": 10215,
          "sha256": "770b520d4492bd947abb1a526de8658f558f9a2b072c8f1c7dd15edd6eece280",
          "preimage": {
            "mode": "100644",
            "bytes": 4815,
            "sha256": "78bf1357f8876a1d8dc59caca9ca235761d552f9f9ddacc9794bba9d5a55a757"
          }
        },
        {
          "source_path": "tests/clerk-auth/domain-session-rows.test.mjs",
          "application_path": "tests/clerk-auth/domain-session-rows.test.mjs",
          "mode": "100644",
          "bytes": 8632,
          "sha256": "b11ec668cf4fbce9407c4de77fce806a9ba93d68ce873cb780f12d4a78b8fc6f",
          "preimage": null
        },
        {
          "source_path": "tests/storage-auth/context-protocol.test.mjs",
          "application_path": "tests/storage-auth/context-protocol.test.mjs",
          "mode": "100644",
          "bytes": 12262,
          "sha256": "153ca400372cb3b8998c843ac2c2818d1700305593247a18c80d06fee6149308",
          "preimage": null
        },
        {
          "source_path": "tests/storage-auth/disk-executor.mjs",
          "application_path": "tests/storage-auth/disk-executor.mjs",
          "mode": "100644",
          "bytes": 13769,
          "sha256": "41819bd47eb04b68d4a141f7c1d07f01b190b9aab02114bf26dadb7053120c56",
          "preimage": {
            "mode": "100644",
            "bytes": 7084,
            "sha256": "4103509484ffcbd1f04b4924e9e99380ce60e206ae60de6c955f49657e8f8690"
          }
        }
      ]
    },
    {
      "repository": "oybek-muminov/UniverAcademy",
      "commit": "14f0b07441a80aea42d2af7877ad898cd452f50e",
      "tree": "1429493eceb35c0448376bb797eba768d8f8a10c",
      "parent": "e6a930625b92c219bb38e6f9b99440474de577bd",
      "prefix": "",
      "files": [
        {
          "source_path": "tests/storage-auth/context-protocol.test.mjs",
          "application_path": "tests/storage-auth/context-protocol.test.mjs",
          "mode": "100644",
          "bytes": 21954,
          "sha256": "aa8dddf8459f5b15a7f15bac4f94e03449692e58365811ef59c0f79b38550c31",
          "preimage": {
            "mode": "100644",
            "bytes": 12262,
            "sha256": "153ca400372cb3b8998c843ac2c2818d1700305593247a18c80d06fee6149308"
          }
        },
        {
          "source_path": "tests/storage-auth/disk-executor.mjs",
          "application_path": "tests/storage-auth/disk-executor.mjs",
          "mode": "100644",
          "bytes": 14861,
          "sha256": "d875277371372ac7e7de39f1857bbe44c9822cabdc3a5f063011c2ff9663d519",
          "preimage": {
            "mode": "100644",
            "bytes": 13769,
            "sha256": "41819bd47eb04b68d4a141f7c1d07f01b190b9aab02114bf26dadb7053120c56"
          }
        }
      ]
    }
  ],
  "content_overlays": [
    {
      "path": "tests/membership/protection-postgres-transaction.test.mjs",
      "base_commit": "9bca9654134b37004b5b4693176c7d3df86ec10d",
      "preimage": {
        "mode": "100644",
        "bytes": 33274,
        "sha256": "49db7421e71cd71966bbf1bd24e952539b8f5062f0621fd349db38f22eca6beb"
      },
      "result": {
        "mode": "100644",
        "bytes": 34385,
        "sha256": "1d7205d9f0ce90e7f75030a7fa8049b314e3c951cec970f27dafcaffb60ac4a8"
      },
      "patch_sha256": "ca7307938648e18064802b416bf014f2c65a2991ff6567b03540cd9c2bed06ca"
    },
    {
      "path": "tests/clerk-auth/review-listener.test.mjs",
      "base_commit": "9bca9654134b37004b5b4693176c7d3df86ec10d",
      "preimage": {
        "mode": "100644",
        "bytes": 11200,
        "sha256": "f78c5b7f2994369043757366cb3a0218174ed7fa52f632dc0c89e7e8a53a6cdb"
      },
      "result": {
        "mode": "100644",
        "bytes": 11661,
        "sha256": "095432668b0a0cac2b6e31df574e9da0ddb490a79f9ebbc3dc1bbff8e2a44c78"
      },
      "patch_sha256": "fb391668230d4f32f57806ee6f7d6273e4cb0d5864a1d7eb6da6223347a9d6de"
    }
  ],
  "layout": "main-root",
  "selection_policy": "Selected Backend/client inputs only: clean111 retained plus exact Backend37 and canonical client inputs; owner copies checked by parity. Inactive review SQL is provenance only. Mini source/guard integrity is proved by a separate exact whole-tree delta, not an invented assembled Git identity. Older manifests remain opaque historical fixtures, never fallback authorities. Ordered accepted fixture-only publications e6a930 then14f0b074 replace two executors and add three strict tests; final two replacements are explicit, never runtime-policy changes. Reviewed content delta over9bca965: one test-only patch; preimage/patch replay is proven independently, while this guard checks exact metadata and final bytes. No result commit/tree is claimed. Second reviewed test-only delta: listener asserts the canonical contract while preserving the historical exchange snapshot checks.",
  "target_count": 136,
  "target_bytes": 2857629
};
const runtimeRaw = readFileSync(new URL('./fixtures/backend-final-content-9bca9654-manifest.json', import.meta.url));
assert.equal(sha256(runtimeRaw), ACTIVE_MANIFEST_SHA256, 'RUNTIME_MANIFEST_MISMATCH');
const runtime = JSON.parse(runtimeRaw);
assert(runtime && typeof runtime === 'object' && !Array.isArray(runtime), 'RUNTIME_MANIFEST_SHAPE_MISMATCH');
assert.deepEqual(Object.keys(runtime), [...Object.keys(expectedAssembly), 'files'], 'RUNTIME_MANIFEST_SHAPE_MISMATCH');
for (const key of Object.keys(expectedAssembly).filter(key => !['backend_overlays', 'content_overlays'].includes(key)))
  assert.deepEqual(runtime[key], expectedAssembly[key], 'ASSEMBLY_METADATA_MISMATCH: ' + key);
function canonicalPath(path) {
  return typeof path === 'string' && /^[A-Za-z0-9_./-]+$/.test(path) && !posix.isAbsolute(path)
    && posix.normalize(path) === path && path !== '.'
    && !path.split('/').some(part => part === '.' || part === '..' || part === '');
}
const mapped = new Map();
// Only these two accepted final-layer replacements may overlap prior layers.
const expectedReplacements = new Set(['backend_overlays[2]:tests/storage-auth/context-protocol.test.mjs', 'backend_overlays[2]:tests/storage-auth/disk-executor.mjs']);
const replacements = new Set();
assert(Array.isArray(runtime.backend_overlays) && runtime.backend_overlays.length === expectedAssembly.backend_overlays.length,
  'ASSEMBLY_METADATA_MISMATCH: backend_overlays');
for (const [index, layer] of runtime.backend_overlays.entries()) {
  const expected = expectedAssembly.backend_overlays[index], label = 'backend_overlays[' + index + ']';
  assert(layer && typeof layer === 'object' && !Array.isArray(layer), 'ASSEMBLY_LAYER_SHAPE_MISMATCH: ' + label);
  assert.deepEqual(Object.keys(layer), Object.keys(expected), 'ASSEMBLY_LAYER_SHAPE_MISMATCH: ' + label);
  for (const key of ['repository', 'commit', 'tree', 'parent', 'prefix'])
    assert.equal(layer[key], expected[key], 'ASSEMBLY_METADATA_MISMATCH: ' + label + '.' + key);
  assert(Array.isArray(layer.files) && layer.files.length === expected.files.length, 'ASSEMBLY_MAPPING_COUNT_MISMATCH: ' + label);
  const sources = new Set(), destinations = new Set();
  for (const file of layer.files) {
    assert(file && typeof file === 'object' && !Array.isArray(file), 'ASSEMBLY_MAPPING_SHAPE_MISMATCH: ' + label);
    assert.deepEqual(Object.keys(file), ['source_path', 'application_path', 'mode', 'bytes', 'sha256', 'preimage'],
      'ASSEMBLY_MAPPING_SHAPE_MISMATCH: ' + label);
    assert(canonicalPath(file.source_path) && canonicalPath(file.application_path)
      && file.source_path === layer.prefix + file.application_path, 'ASSEMBLY_MAPPING_PATH_MISMATCH: ' + label);
    assert(!sources.has(file.source_path) && !destinations.has(file.application_path), 'ASSEMBLY_MAPPING_DUPLICATE: ' + label);
    sources.add(file.source_path); destinations.add(file.application_path);
    assert.equal(file.mode, '100644', 'ASSEMBLY_MAPPING_MODE_MISMATCH: ' + label);
    assert(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && typeof file.sha256 === 'string'
      && /^[a-f0-9]{64}$/.test(file.sha256), 'ASSEMBLY_MAPPING_DIGEST_SHAPE_MISMATCH: ' + label);
    const approved = expected.files.find(row => row.application_path === file.application_path);
    assert(approved, 'ASSEMBLY_UNEXPECTED_COLLISION: ' + label);
    assert.deepEqual(file.preimage, approved.preimage, 'ASSEMBLY_PREIMAGE_MISMATCH: ' + label);
    const previous = mapped.get(file.application_path);
    if (previous) {
      const key = label + ':' + file.application_path;
      assert(expectedReplacements.has(key), 'ASSEMBLY_UNEXPECTED_COLLISION: ' + label);
      assert.deepEqual(file.preimage, { mode: previous.mode, bytes: previous.bytes, sha256: previous.sha256 }, 'ASSEMBLY_PREIMAGE_MISMATCH: ' + label);
      replacements.add(key);
    }
    mapped.set(file.application_path, file);
  }
  assert.deepEqual(layer.files, expected.files, 'ASSEMBLY_MAPPING_MISMATCH: ' + label);
}
assert.deepEqual([...replacements].sort(), [...expectedReplacements].sort(), 'ASSEMBLY_REPLACEMENT_SET_MISMATCH');
assert(Array.isArray(runtime.files) && runtime.files.length === expectedPaths.length, 'RUNTIME_TARGET_COUNT_MISMATCH');
for (const file of runtime.files) {
  assert(file && typeof file === 'object' && !Array.isArray(file), 'RUNTIME_TARGET_SHAPE_MISMATCH');
  assert.deepEqual(Object.keys(file), ['path', 'bytes', 'sha256'], 'RUNTIME_TARGET_SHAPE_MISMATCH');
  assert(canonicalPath(file.path), 'RUNTIME_TARGET_PATH_MISMATCH');
  assert(Number.isSafeInteger(file.bytes) && file.bytes >= 0, 'RUNTIME_TARGET_SIZE_SHAPE_MISMATCH');
  assert(typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256), 'RUNTIME_TARGET_HASH_SHAPE_MISMATCH');
}
const paths = runtime.files.map(file => file.path);
assert.equal(new Set(paths).size, expectedPaths.length, 'RUNTIME_TARGET_DUPLICATE');
assert.deepEqual(paths, [...paths].sort(), 'RUNTIME_TARGET_ORDER_MISMATCH');
assert.deepEqual(paths, expectedPaths, 'RUNTIME_TARGET_SET_MISMATCH');
assert.equal(runtime.files.reduce((sum, file) => sum + file.bytes, 0), expectedAssembly.target_bytes, 'RUNTIME_TARGET_BYTES_MISMATCH');
for (const [path, mapping] of mapped) {
  const target = runtime.files.find(file => file.path === path);
  assert(target && target.bytes === mapping.bytes && target.sha256 === mapping.sha256, 'ASSEMBLY_FINAL_TARGET_MISMATCH: ' + path);
}
// This validates fixed content metadata/final bytes, never fetches or applies a patch.
// Preimage and zero-fuzz patch replay are independent reconstruction evidence.
assert(Array.isArray(runtime.content_overlays) && runtime.content_overlays.length === 2, 'CONTENT_OVERLAY_COUNT_MISMATCH');
for (let index = 0; index < 2; index++) {
const content = runtime.content_overlays[index], expectedContent = expectedAssembly.content_overlays[index];
assert(content && typeof content === 'object' && !Array.isArray(content), 'CONTENT_OVERLAY_SHAPE_MISMATCH');
assert.deepEqual(Object.keys(content), Object.keys(expectedContent), 'CONTENT_OVERLAY_SHAPE_MISMATCH');
assert(canonicalPath(content.path) && content.path === expectedContent.path, 'CONTENT_OVERLAY_PATH_MISMATCH');
assert.equal(content.base_commit, expectedContent.base_commit, 'CONTENT_OVERLAY_BASE_MISMATCH');
for (const part of ['preimage', 'result']) {
  const item = content[part], pin = expectedContent[part];
  assert(item && typeof item === 'object' && !Array.isArray(item), 'CONTENT_OVERLAY_SHAPE_MISMATCH');
  assert.deepEqual(Object.keys(item), ['mode', 'bytes', 'sha256'], 'CONTENT_OVERLAY_SHAPE_MISMATCH');
  assert.equal(item.mode, pin.mode, 'CONTENT_OVERLAY_MODE_MISMATCH');
  assert.deepEqual(item, pin, 'CONTENT_OVERLAY_' + part.toUpperCase() + '_MISMATCH');
}
assert.equal(content.patch_sha256, expectedContent.patch_sha256, 'CONTENT_OVERLAY_PATCH_MISMATCH');
const contentTarget = runtime.files.find(file => file.path === content.path);
assert(contentTarget && contentTarget.bytes === content.result.bytes && contentTarget.sha256 === content.result.sha256,
  'CONTENT_OVERLAY_TARGET_MISMATCH');
}
// Exact Backend correction provenance, not a claim about an assembled Git tree.
export const BACKEND_SOURCE_COMMIT = runtime.source_commit;
const repo = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
function readTarget(path) {
  const target = resolve(repo, path);
  const within = relative(repo, realpathSync(target));
  assert(within !== '..' && !within.startsWith('../') && !posix.isAbsolute(within),
    `BACKEND_TARGET_PATH_ESCAPE: ${path}`);
  assert(statSync(target).isFile(), `BACKEND_TARGET_NOT_FILE: ${path}`);
  return readFileSync(target);
}
const historicalAttemptsRaw = readTarget('apps/mini-app/tests/fixtures/attempts-8a750ee.ts.txt');
assert.equal(historicalAttemptsRaw.length, 9616, 'HISTORICAL_ATTEMPTS_FIXTURE_MISMATCH');
assert.equal(sha256(historicalAttemptsRaw), 'b4bc54e39fef6799b6ff83a4be3c474471afd2e4c76e888767e999064a4d9e20',
  'HISTORICAL_ATTEMPTS_FIXTURE_MISMATCH');
for (const file of runtime.files) {
  const bytes = readTarget(file.path);
  assert.equal(bytes.length, file.bytes, `BACKEND_TARGET_SIZE_MISMATCH: ${file.path}`);
  assert.equal(sha256(bytes), file.sha256, `BACKEND_TARGET_HASH_MISMATCH: ${file.path}`);
}
for (const name of ['student-client.ts', 'student-types.d.ts']) {
  const target = runtime.files.find(file => file.path === 'packages/api-client/' + name);
  assert(target, 'OWNER_CLIENT_TARGET_MISSING');
  const bytes = readTarget('apps/mini-app/src/owner-client/' + name);
  assert.equal(bytes.length, target.bytes, `OWNER_CLIENT_SIZE_MISMATCH: ${name}`);
  assert.equal(sha256(bytes), target.sha256, `OWNER_CLIENT_HASH_MISMATCH: ${name}`);
}

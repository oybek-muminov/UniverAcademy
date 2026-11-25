import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, lstatSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { isStrictlyWithin } from './path-containment.mjs';
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
  assert(isStrictlyWithin(repo, realpathSync(target)),
    `BACKEND_TARGET_PATH_ESCAPE: ${path}`);
  assert(statSync(target).isFile(), `BACKEND_TARGET_NOT_FILE: ${path}`);
  return readFileSync(target);
}
const historicalAttemptsRaw = readTarget('apps/mini-app/tests/fixtures/attempts-8a750ee.ts.txt');
assert.equal(historicalAttemptsRaw.length, 9616, 'HISTORICAL_ATTEMPTS_FIXTURE_MISMATCH');
assert.equal(sha256(historicalAttemptsRaw), 'b4bc54e39fef6799b6ff83a4be3c474471afd2e4c76e888767e999064a4d9e20',
  'HISTORICAL_ATTEMPTS_FIXTURE_MISMATCH');
// Preserve the historical authority. This reviewed extension records both its
// old pin and the actual main preimage; it never applies a historical patch.
const CURRENT_RUNTIME_OVERLAY_SHA256 = 'b74bc8cd91daf50660d41b748e605a3e538c746662986bf747072e1151026f92';
const currentRuntimeRaw = readTarget('apps/mini-app/tests/fixtures/backend-clerk-runtime-overlay-20261116.json');
assert.equal(sha256(currentRuntimeRaw), CURRENT_RUNTIME_OVERLAY_SHA256, 'CURRENT_RUNTIME_OVERLAY_MISMATCH');
const currentRuntime = JSON.parse(currentRuntimeRaw);
assert.deepEqual(Object.keys(currentRuntime), ['format_version', 'base_manifest_sha256', 'application_base_commit', 'source_commit', 'files'], 'CURRENT_RUNTIME_OVERLAY_SHAPE_MISMATCH');
assert.equal(currentRuntime.format_version, 1, 'CURRENT_RUNTIME_OVERLAY_VERSION_MISMATCH');
assert.equal(currentRuntime.base_manifest_sha256, ACTIVE_MANIFEST_SHA256, 'CURRENT_RUNTIME_OVERLAY_BASE_MISMATCH');
assert.equal(currentRuntime.application_base_commit, 'e2d310b6a640c858f6f3432c8fad7db8fee3a719', 'CURRENT_RUNTIME_OVERLAY_MAIN_MISMATCH');
assert.equal(currentRuntime.source_commit, 'b1a0481b73864ee6fca5f28cb82cb08d39d0f628', 'CURRENT_RUNTIME_OVERLAY_SOURCE_MISMATCH');
const currentRuntimePaths = [
  'runtime/clerk-worker-bindings.mjs',
  'runtime/cloudflare-api.mjs',
  'runtime/cloudflare-entry.mjs',
  'runtime/cloudflare-postgres.mjs',
  'runtime/cloudflare-telegram-directory.mjs',
  'runtime/hyperdrive-connection-string.mjs',
  'tests/cloudflare/api-postgres.test.mjs',
  'tests/cloudflare/clerk-worker-bindings.test.mjs',
  'tests/cloudflare/entry.test.mjs',
  'tests/cloudflare/telegram-wiring.test.mjs'
];
assert(Array.isArray(currentRuntime.files), 'CURRENT_RUNTIME_OVERLAY_SHAPE_MISMATCH');
assert.deepEqual(currentRuntime.files.map(file => file.path), currentRuntimePaths, 'CURRENT_RUNTIME_OVERLAY_PATH_SET_MISMATCH');
const selected = new Map(runtime.files.map(file => [file.path, file]));
for (const file of currentRuntime.files) {
  assert.deepEqual(Object.keys(file), ['path', 'mode', 'historical_preimage', 'preimage', 'result'], 'CURRENT_RUNTIME_OVERLAY_SHAPE_MISMATCH');
  assert(canonicalPath(file.path), 'CURRENT_RUNTIME_OVERLAY_PATH_MISMATCH');
  assert.equal(file.mode, '100644', 'CURRENT_RUNTIME_OVERLAY_MODE_MISMATCH');
  assert.deepEqual(file.historical_preimage, selected.get(file.path) ?? null, 'CURRENT_RUNTIME_OVERLAY_HISTORY_MISMATCH: ' + file.path);
  const mainPreimage = file.path === 'runtime/cloudflare-telegram-directory.mjs'
    ? { path: file.path, bytes: 5689, sha256: '4541bf6ab3b185defd8042c4cac620b52ae83172f8f64710fac7bc08ddd6df5e' }
    : file.historical_preimage;
  assert.deepEqual(file.preimage, mainPreimage, 'CURRENT_RUNTIME_OVERLAY_PREIMAGE_MISMATCH: ' + file.path);
  assert.deepEqual(Object.keys(file.result), ['path', 'bytes', 'sha256'], 'CURRENT_RUNTIME_OVERLAY_RESULT_SHAPE_MISMATCH');
  assert.equal(file.result.path, file.path, 'CURRENT_RUNTIME_OVERLAY_RESULT_PATH_MISMATCH');
  assert(Number.isSafeInteger(file.result.bytes) && file.result.bytes >= 0, 'CURRENT_RUNTIME_OVERLAY_RESULT_SIZE_MISMATCH');
  assert(typeof file.result.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.result.sha256), 'CURRENT_RUNTIME_OVERLAY_RESULT_HASH_MISMATCH');
  selected.set(file.path, file.result);
}
assert.equal(selected.size, runtime.files.length + 1, 'CURRENT_RUNTIME_TARGET_COUNT_MISMATCH');
// Reviewed production Workers compatibility correction, source commit
// 47ffc1f34c5c965be3c23d188f900a2c78a2ba8c. Historical manifests stay immutable.
const requestCompatibility = [
  {
    "path": "runtime/vercel-node.mjs",
    "preimage": {
      "path": "runtime/vercel-node.mjs",
      "bytes": 4161,
      "sha256": "eb95ef50e999b44403f20fa2bdd51923443f1ef6038f60c7588bda1820537171"
    },
    "result": {
      "path": "runtime/vercel-node.mjs",
      "bytes": 4325,
      "sha256": "102eee2fa25f2e8ae76b3c106325bbbcfb2a17c9132aae56cad3eb8c8e8f09e5"
    }
  },
  {
    "path": "supabase/functions/univeracademy-api/clerk-provider.ts",
    "preimage": {
      "path": "supabase/functions/univeracademy-api/clerk-provider.ts",
      "bytes": 10205,
      "sha256": "e14fd79fa83a5a874ef2d6c338cb210bbd44e9ca1b5bc8024f40933c4a8ee20a"
    },
    "result": {
      "path": "supabase/functions/univeracademy-api/clerk-provider.ts",
      "bytes": 10364,
      "sha256": "3fdf646c74429f75f40c20c66805055227860643ba09d5501f9825b8eb769bd4"
    }
  },
  {
    "path": "tests/clerk-auth/provider-adapter.test.mjs",
    "preimage": {
      "path": "tests/clerk-auth/provider-adapter.test.mjs",
      "bytes": 22068,
      "sha256": "4d65fc4d972aa82ed85f86dcf6392eba3e67243399e792e538a53f54cf4a30ea"
    },
    "result": {
      "path": "tests/clerk-auth/provider-adapter.test.mjs",
      "bytes": 22379,
      "sha256": "3877fa15c70e5288c22477f443492e3c099ecfc840e1fbfa5222650e0138a11b"
    }
  }
];
for (const file of requestCompatibility) {
  assert.deepEqual(selected.get(file.path), file.preimage, 'REQUEST_COMPATIBILITY_PREIMAGE_MISMATCH');
  selected.set(file.path, file.result);
}
// Static verifier diagnostics only; base adfd4ab, public authorization results unchanged.
const verifierDiagnostic = {"path": "supabase/functions/univeracademy-api/clerk-auth.ts", "preimage": {"path": "supabase/functions/univeracademy-api/clerk-auth.ts", "bytes": 6833, "sha256": "092ba3179c74b6c96d96d28bc215dc44bca2f5e11026b22598bd82819b4bc527"}, "result": {"path": "supabase/functions/univeracademy-api/clerk-auth.ts", "bytes": 9223, "sha256": "32d302c953ea183b7327c10c2d172ca04c775f33179def1f8917e13741db3469"}};
assert.deepEqual(selected.get(verifierDiagnostic.path), verifierDiagnostic.preimage, "VERIFIER_DIAGNOSTIC_PREIMAGE_MISMATCH");
selected.set(verifierDiagnostic.path, verifierDiagnostic.result);
// Missing-jti v2 replay compatibility; exact preimages from d769d89.
const signedInputReplayCompatibility = [
  {
    "path": "supabase/functions/univeracademy-api/clerk-auth.ts",
    "preimage": {
      "path": "supabase/functions/univeracademy-api/clerk-auth.ts",
      "bytes": 9223,
      "sha256": "32d302c953ea183b7327c10c2d172ca04c775f33179def1f8917e13741db3469"
    },
    "result": {
      "path": "supabase/functions/univeracademy-api/clerk-auth.ts",
      "bytes": 10429,
      "sha256": "d4094c6ac1081ee6054a630419b412ebc8c042946a56bf816ad5b8fb34df7815"
    }
  },
  {
    "path": "supabase/functions/univeracademy-api/clerk-http.ts",
    "preimage": {
      "path": "supabase/functions/univeracademy-api/clerk-http.ts",
      "bytes": 17702,
      "sha256": "bb8aff00ce0b6967351c3f6c41245add4db7215d970699d4c983db1dc0185024"
    },
    "result": {
      "path": "supabase/functions/univeracademy-api/clerk-http.ts",
      "bytes": 17675,
      "sha256": "51b9949081969232ece555fbdf225ad51e83673aa0e658e0af708965954b2238"
    }
  },
  {
    "path": "supabase/functions/univeracademy-api/storage/clerk-auth-rows.ts",
    "preimage": {
      "path": "supabase/functions/univeracademy-api/storage/clerk-auth-rows.ts",
      "bytes": 27800,
      "sha256": "3c7e160bf776791d294e2aa7a639cff6817d2f9a094d401b8f66679fddbf4a98"
    },
    "result": {
      "path": "supabase/functions/univeracademy-api/storage/clerk-auth-rows.ts",
      "bytes": 27773,
      "sha256": "1ac8f769434f35b792f84c674c7635f551b660aa427b79152d6a8f733261b95e"
    }
  },
  {
    "path": "tests/backend/student-prepared/telegram-rows.test.mjs",
    "preimage": {
      "path": "tests/backend/student-prepared/telegram-rows.test.mjs",
      "bytes": 40057,
      "sha256": "7e026a22434fa559dcd6801bb4507f844f99cfb4658c6c7f89e4513b7bdfe09a"
    },
    "result": {
      "path": "tests/backend/student-prepared/telegram-rows.test.mjs",
      "bytes": 41749,
      "sha256": "1f1fe2a04ef2607a571537237ed887247bc35af0194222ddc86058c5a0723848"
    }
  },
  {
    "path": "tests/clerk-auth/domain-http.test.mjs",
    "preimage": {
      "path": "tests/clerk-auth/domain-http.test.mjs",
      "bytes": 13849,
      "sha256": "24b8aef28ab138f65fecde222945ad8769635555c64925aeac16bf8886a18678"
    },
    "result": {
      "path": "tests/clerk-auth/domain-http.test.mjs",
      "bytes": 14391,
      "sha256": "039d06bebc6642148bf83cc699a9e832fbbe6b613c20a6ead8832afbee870411"
    }
  }
];
for (const file of signedInputReplayCompatibility) {
  assert.deepEqual(selected.get(file.path), file.preimage, "SIGNED_INPUT_REPLAY_PREIMAGE_MISMATCH");
  selected.set(file.path, file.result);
}
// Bounded database failure diagnostics; historical source metadata remains immutable.
const databaseDiagnostic = {
  "path": "runtime/cloudflare-postgres.mjs",
  "preimage": {
    "path": "runtime/cloudflare-postgres.mjs",
    "bytes": 4215,
    "sha256": "da9626dd8ee00270b7861205b0f2dc15e9656b7c2b2aafe44491f5f6991506be"
  },
  "result": {
    "path": "runtime/cloudflare-postgres.mjs",
    "bytes": 5149,
    "sha256": "2fb78b3e9640b8be40db99b8a27ec5f4c06f14962dc52c99feb19529b71ee75c"
  }
};
assert.deepEqual(selected.get(databaseDiagnostic.path), databaseDiagnostic.preimage, "DATABASE_DIAGNOSTIC_PREIMAGE_MISMATCH");
selected.set(databaseDiagnostic.path, databaseDiagnostic.result);
// Reviewed unknown-route classification; no known operation is activated.
const routeClassification = [
  {
    "path": "tests/cloudflare/telegram-wiring.test.mjs",
    "preimage": {
      "path": "tests/cloudflare/telegram-wiring.test.mjs",
      "bytes": 20847,
      "sha256": "cefd57f5fc61bf1ae07cc3db8c956caa45c2aad01dc15752d6f3a8d043ec32a8"
    },
    "result": {
      "path": "tests/cloudflare/telegram-wiring.test.mjs",
      "bytes": 20875,
      "sha256": "7b7a6c100d71a0b0ecf73134945e9678483fe9249a581d99b61f0f430b22d63f"
    }
  },
  {
    "path": "runtime/cloudflare-entry.mjs",
    "preimage": {
      "path": "runtime/cloudflare-entry.mjs",
      "bytes": 6961,
      "sha256": "67fc2e604657951880224bac6a93f412fd2d4bec56c69ba7055c2dacf7be873d"
    },
    "result": {
      "path": "runtime/cloudflare-entry.mjs",
      "bytes": 7092,
      "sha256": "ad26bb5441020ff2ee599d56bf10d687f63538c5ee4171174f650c8c608f3ea7"
    }
  },
  {
    "path": "tests/cloudflare/entry.test.mjs",
    "preimage": {
      "path": "tests/cloudflare/entry.test.mjs",
      "bytes": 21068,
      "sha256": "211c5757f0ec2c9e1d7ea5f31b91061e93ca4573518cec9bdf687ddb6889ca85"
    },
    "result": {
      "path": "tests/cloudflare/entry.test.mjs",
      "bytes": 21187,
      "sha256": "438bf18423705e206886249b9d3190ba085c4c0456e1452ef2ab73666d8818d7"
    }
  }
];
for (const file of routeClassification) {
  assert.deepEqual(selected.get(file.path),file.preimage,"ROUTE_CLASSIFICATION_PREIMAGE_MISMATCH");
  selected.set(file.path,file.result);
}
const routeInventory = {"path": "runtime/contract-paths.mjs", "bytes": 951, "sha256": "d962f6460b39529e2ff2b8b4a630e51d5e747a43811284fa581e6038ddfb0582"};
assert(!selected.has(routeInventory.path),"ROUTE_INVENTORY_COLLISION");
selected.set(routeInventory.path,routeInventory);
// Liveness-only health; no private dependency readiness claim.
const livenessOnly = [
  {
    "path": "runtime/cloudflare-entry.mjs",
    "preimage": {
      "path": "runtime/cloudflare-entry.mjs",
      "bytes": 7092,
      "sha256": "ad26bb5441020ff2ee599d56bf10d687f63538c5ee4171174f650c8c608f3ea7"
    },
    "result": {
      "path": "runtime/cloudflare-entry.mjs",
      "bytes": 7403,
      "sha256": "86fc848067651db8a0ef2aa73a63202b6e61692aad44b3e78efa73681d720a1d"
    }
  },
  {
    "path": "tests/cloudflare/entry.test.mjs",
    "preimage": {
      "path": "tests/cloudflare/entry.test.mjs",
      "bytes": 21187,
      "sha256": "438bf18423705e206886249b9d3190ba085c4c0456e1452ef2ab73666d8818d7"
    },
    "result": {
      "path": "tests/cloudflare/entry.test.mjs",
      "bytes": 22092,
      "sha256": "4d1f2b21c48b83e1aa66ff17b5ce63229a058026618348a13f87c2799cc4d499"
    }
  }
];
for (const file of livenessOnly) {
  assert.deepEqual(selected.get(file.path),file.preimage,"LIVENESS_PREIMAGE_MISMATCH");
  selected.set(file.path,file.result);
}
// New local deletion review overlay; historic manifests stay byte-identical.
const ACCOUNT_DELETION_OVERLAY_SHA256 = 'fd76eb95530eecf37568c804cd37614e7bf08cafd9de8578b6b7bd1d614a0c8a';
const deletionRaw=readTarget('apps/mini-app/tests/fixtures/backend-account-deletion-review-manifest.json');
assert.equal(sha256(deletionRaw),ACCOUNT_DELETION_OVERLAY_SHA256,'ACCOUNT_DELETION_OVERLAY_MISMATCH');
const deletion=JSON.parse(deletionRaw);
assert.deepEqual(Object.keys(deletion),['format_version','base_commit','status','files'],'ACCOUNT_DELETION_OVERLAY_SHAPE');
assert.equal(deletion.format_version,1);assert.equal(deletion.base_commit,'3d4afd1a55918775eb3cbd2da7a004e19d37a6b8');
assert.equal(deletion.status,'local-review-only-not-deployed');
// UI/package files were outside historical backend selection. Explicit main-base
// preimages prevent mislabelling existing source as new files.
const deletionUnselectedBase=new Map([["apps/mini-app/src/main.tsx",{"path":"apps/mini-app/src/main.tsx","bytes":1389,"sha256":"89ac1460094946e542b3180d284de0171897b88736df452fabae44d06169ecd7"}],["apps/mini-app/package.json",{"path":"apps/mini-app/package.json","bytes":2157,"sha256":"f0b7bcb55d77cf18e7c4dfbc8ba0a21e5fe3d730ec22e6aa8fdcbcaf78c459d4"}],["apps/mini-app/package-lock.json",{"path":"apps/mini-app/package-lock.json","bytes":42432,"sha256":"e0d11ceeccc2325066fa02d61e7b6ecffde79f7e675b0080facc4675f87bf059"}],["apps/mini-app/src/clerk-prebuilt-entry.tsx",{"path":"apps/mini-app/src/clerk-prebuilt-entry.tsx","bytes":4585,"sha256":"ceefb5b9cb50510c59e412c845d3d41cc9e075a74d411df9b8e248353937747b"}],["apps/mini-app/src/common-production-runtime.ts",{"path":"apps/mini-app/src/common-production-runtime.ts","bytes":4845,"sha256":"18c63a91f65eda34f7ac0542af5b852a1fb4c1f80dd69f7fb55fdb3c0b97c48b"}],["apps/mini-app/src/owner-port.ts",{"path":"apps/mini-app/src/owner-port.ts","bytes":9765,"sha256":"886b331e0a4602d2a4fb1589556e879cc6a0d7e3f87a6650fb7e321e080f5d1a"}],["apps/mini-app/src/production-connection.ts",{"path":"apps/mini-app/src/production-connection.ts","bytes":2459,"sha256":"fae2470b79995be98e4ed96ac5457a2dd141466127d559bf8a96e0780f378265"}],["apps/mini-app/src/student-app.tsx",{"path":"apps/mini-app/src/student-app.tsx","bytes":16118,"sha256":"25b833df7e1ac277ff5a712e20dc61b731d0e4c21f637da403daf7c534dbdd08"}],["apps/mini-app/src/clerk-app-session.ts",{"path":"apps/mini-app/src/clerk-app-session.ts","bytes":3375,"sha256":"60cd7c19c8f78730d42554d1bb1ac13259e6a1b73abb54d7a509b56ddb92fcce"}]]);
const deletionSeen=new Set();
for(const file of deletion.files){
 assert.deepEqual(Object.keys(file),['path','preimage','result']);
 assert(canonicalPath(file.path)&&!deletionSeen.has(file.path),'ACCOUNT_DELETION_PATH_INVALID');deletionSeen.add(file.path);
 assert.deepEqual(file.preimage,selected.get(file.path)??deletionUnselectedBase.get(file.path)??null,'ACCOUNT_DELETION_PREIMAGE_MISMATCH: '+file.path);
 assert.deepEqual(Object.keys(file.result),['path','bytes','sha256']);assert.equal(file.result.path,file.path);
 assert(Number.isSafeInteger(file.result.bytes)&&file.result.bytes>=0&&/^[a-f0-9]{64}$/.test(file.result.sha256));
 selected.set(file.path,file.result);
}
// Pin the renamed profile contract without rewriting any earlier release manifest.
// A null previous hash means this path was outside the earlier guard's scope.
const BRAND_OVERLAY_SHA256 = '7e0a77d9b17aa9effcda013bd1692d99b251669bde82c0231eda91dd208a7944';
const brandRaw = readTarget('apps/mini-app/tests/fixtures/univeracademy-id-overlay.json');
assert.equal(sha256(brandRaw), BRAND_OVERLAY_SHA256, 'BRAND_OVERLAY_MISMATCH');
const brand = JSON.parse(brandRaw);
assert.equal(brand.base_commit, 'd62adb0f090b3e964450163d6607387c248d56bc');
for (const file of brand.files) {
  assert(canonicalPath(file.path), 'BRAND_TARGET_PATH_INVALID');
  assert.equal(selected.get(file.path)?.sha256 ?? null, file.previous_sha256,
    'BRAND_PREIMAGE_MISMATCH: ' + file.path);
  selected.set(file.path, { path: file.path, bytes: file.bytes, sha256: file.sha256 });
}
// Preserve each historical selected digest, then verify the staging candidate bytes.
const STAGING_OVERLAY_SHA256 = '68b0bd4a828aeede2f211ed45fb2fafeb645197ae2ba9278280b583b4cdbf7a6';
const REGISTRATION_OVERLAY_SHA256 = '4a71790fcf1f584065ccadcee06452edc2ca67ad3179f02f6a541ac93d34ef09';
const PROFILE_RELEASE_OVERLAY_SHA256 = '8b875d66e42c0705192d6836c9e52570bf27143f941e7a7aa01d3efd0de9a249';
const LIVE_OVERLAY_SHA256 = '876c8c64421b09ad35f0ffefbc79bbca24184029fd499a922836997e5783e514';
const WORKER_CABINET_OVERLAY_SHA256 = '93a1026783863c936bbead931882058c0bf38bce6eead570169e777c38fa3721';
const TEACHER_ENTRY_OVERLAY_SHA256 = '0b09b9dd830c42e2e367565c9b4056b726719af54c879e1ccb91917c61fb36bc';
const TEACHER_GROUP_CREATION_SHA256 = '0bf8010354596c2a3dd9417c5c467ee00dd028f8fee8dcf1f12e178dcb6ff736';
const TEACHER_DRAFT_EDIT_SHA256 = '269c2c358d1fed1736bd479635e7c6693c7fd2b0c18b29325bee91216479f27b';
const TEACHER_TEST_SCHEDULE_SHA256 = 'd40126f2dd01e308b85080e9b14fb03d88bc6d43d6dc18f5dccde8c1dd3d29d8';
const PLATFORM_PERFORMANCE_SHA256 = '1621fe2f014a76c57d014f64c1ddfbc2393491ea3a33ddc2ff18ad9b1f378f55';
const STAFF_BROWSER_ENTRY_SHA256 = '45e17d9796bab5e88bcc42aa417ed01a51ead9129049694f78d8e1875afe619f';
const STAFF_BROWSER_AUTO_OPEN_SHA256 = '172d8f61bb86e74a8f60371dbd160157840b67d4fe614b0ca11f9fdb3fae4d80';
function applySourceTransition(filename, expectedHash, baseCommit, diagnostic) {
  const raw = readTarget('apps/mini-app/tests/fixtures/' + filename);
  assert.equal(sha256(raw), expectedHash, diagnostic + '_OVERLAY_MISMATCH');
  const transition = JSON.parse(raw);
  assert.equal(transition.format_version, 1);
  assert.equal(transition.base_commit, baseCommit);
  const paths = new Set();
  for (const file of transition.files) {
    assert(canonicalPath(file.path) && !paths.has(file.path), diagnostic + '_TARGET_PATH_INVALID');
    paths.add(file.path);
    assert.equal(selected.get(file.path)?.sha256 ?? null, file.previous_sha256, diagnostic + '_PREIMAGE_MISMATCH: ' + file.path);
    assert(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && /^[0-9a-f]{64}$/.test(file.sha256));
    selected.set(file.path, {path:file.path, bytes:file.bytes, sha256:file.sha256});
  }
}
applySourceTransition('teacher-staging-overlay.json', STAGING_OVERLAY_SHA256, 'ce9bade40533020117cdc111b20b7763ef6d0e59', 'STAGING');
applySourceTransition('registration-storage-overlay.json', REGISTRATION_OVERLAY_SHA256, 'deb3636755c2f5b222dc3460e8e410aaa37c1fc5', 'REGISTRATION');
applySourceTransition('profile-release-order-overlay.json', PROFILE_RELEASE_OVERLAY_SHA256, 'd19fe4f9483586fe29f1ab54b34a9377f743ce7a', 'PROFILE_RELEASE');
applySourceTransition('teacher-live-overlay.json', LIVE_OVERLAY_SHA256, 'aecead4fda3c4e518a5e3eb47b0536d8f4619a52', 'LIVE');
applySourceTransition('teacher-worker-overlay.json', WORKER_CABINET_OVERLAY_SHA256, '210033f666e19ef20d7bd7a174777e3427ce765f', 'WORKER_CABINET');
applySourceTransition('teacher-default-cabinet-overlay.json', TEACHER_ENTRY_OVERLAY_SHA256, 'b65335ed34f6db1ad4b302323e167d2b2c081544', 'TEACHER_ENTRY');
applySourceTransition('teacher-group-creation-overlay.json', TEACHER_GROUP_CREATION_SHA256, 'fe424a68a222fc27a30053087813a38af309d218', 'TEACHER_GROUP_CREATION');
applySourceTransition('teacher-draft-edit-overlay.json', TEACHER_DRAFT_EDIT_SHA256, 'c3bda2b5f9de82276820d17e2e02b389468d2410', 'TEACHER_DRAFT_EDIT');
applySourceTransition('teacher-test-schedule-overlay.json', TEACHER_TEST_SCHEDULE_SHA256, 'a2a10e6c8786d1b74d5ac80560d504d2039e73a0', 'TEACHER_TEST_SCHEDULE');
applySourceTransition('platform-performance-overlay.json', PLATFORM_PERFORMANCE_SHA256, '1f2eeeaaca8a718991f2151538cc0773e9122609', 'PLATFORM_PERFORMANCE');
applySourceTransition('staff-browser-entry-overlay.json', STAFF_BROWSER_ENTRY_SHA256, 'ff76a3e641bba28f6cf773239ea1850b38d5c87a', 'STAFF_BROWSER_ENTRY');
applySourceTransition('staff-browser-auto-open-overlay.json', STAFF_BROWSER_AUTO_OPEN_SHA256, 'e52c54b20139fe857c8a5ead4e2ad7e699683dad', 'STAFF_BROWSER_AUTO_OPEN');
for (const file of selected.values()) {
  const bytes = readTarget(file.path);
  if (currentRuntimePaths.includes(file.path)) {
    const info = lstatSync(resolve(repo, file.path));
    assert(info.isFile() && (info.mode & 0o111) === 0, 'CURRENT_RUNTIME_MODE_MISMATCH: ' + file.path);
  }
  assert.equal(bytes.length, file.bytes, `BACKEND_TARGET_SIZE_MISMATCH: ${file.path}`);
  assert.equal(sha256(bytes), file.sha256, `BACKEND_TARGET_HASH_MISMATCH: ${file.path}`);
}
for (const name of ['student-client.ts', 'student-types.d.ts']) {
  const target = selected.get('packages/api-client/' + name);
  assert(target, 'OWNER_CLIENT_TARGET_MISSING');
  const bytes = readTarget('apps/mini-app/src/owner-client/' + name);
  assert.equal(bytes.length, target.bytes, `OWNER_CLIENT_SIZE_MISMATCH: ${name}`);
  assert.equal(sha256(bytes), target.sha256, `OWNER_CLIENT_HASH_MISMATCH: ${name}`);
}

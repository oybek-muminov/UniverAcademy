// Reproduce the immutable account-deletion release from its reviewed inputs.
// Later releases can replace files only through an exact, root-pinned transition.
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const base='3d4afd1a55918775eb3cbd2da7a004e19d37a6b8';
const manifest='apps/mini-app/tests/fixtures/backend-account-deletion-review-manifest.json';
const guard='apps/mini-app/tests/verify-backend-targets.mjs';
const manifests='apps/mini-app/tests/fixtures/';
const guardSource=readFileSync(guard,'utf8');
const hash=b=>createHash('sha256').update(b).digest('hex');
function walk(p){return readdirSync(p,{withFileTypes:true}).flatMap(e=>e.name==='node_modules'?[]:e.isDirectory()?walk(p+'/'+e.name):[p+'/'+e.name]);}
const paths=[
'apps/mini-app/src/student-app.tsx','apps/mini-app/src/clerk-app-session.ts','apps/mini-app/src/account-dashboard.tsx','apps/mini-app/src/dashboard-profile.ts','apps/mini-app/src/dashboard.css',
...walk('apps/mini-app/tests').filter(p=>p.includes('/dashboard-')), 
'runtime/cloudflare-entry.mjs','runtime/cloudflare-worker.mjs','runtime/telegram-menu-completion.mjs','contracts/account-deletion.review.openapi.json','apps/mini-app/src/main.tsx','apps/mini-app/package.json','apps/mini-app/package-lock.json','apps/mini-app/src/clerk-prebuilt-entry.tsx','apps/mini-app/src/common-production-runtime.ts','apps/mini-app/src/owner-port.ts','apps/mini-app/src/production-connection.ts',
...walk('runtime').filter(p=>p.startsWith('runtime/telegram-clerk-entry-')),'contracts/telegram-atomic-entry.review.openapi.json','supabase/functions/univeracademy-api/storage/telegram-clerk-entry-rows.ts',
...walk('tests/telegram-entry').filter(p=>!p.endsWith('.md')),
...walk('runtime').filter(p=>p.startsWith('runtime/account-deletion-')),
'supabase/functions/univeracademy-api/account-deletion.ts','supabase/functions/univeracademy-api/storage/account-deletion-rows.ts',
'supabase/proposals/account-deletion-rebuild.review.sql',
...walk('tests/account-deletion').filter(p=>!p.endsWith('.md')),
'packages/api-client/telegram-atomic-client.ts','apps/mini-app/src/owner-client/telegram-atomic-client.ts',
...walk('apps/mini-app/src').filter(p=>p.startsWith('apps/mini-app/src/telegram-atomic-')&&!p.endsWith('.md')),
...walk('apps/mini-app/tests').filter(p=>p.startsWith('apps/mini-app/tests/telegram-atomic-')),
...walk('apps/mini-app/src/account-deletion-candidate').filter(p=>!p.endsWith('.md')),
...walk('apps/mini-app/tests').filter(p=>p.startsWith('apps/mini-app/tests/account-deletion-'))].sort();

function readPinned(path, pattern) {
  const raw = readFileSync(path);
  const match = guardSource.match(pattern);
  assert(match, 'Missing release pin for ' + path);
  assert.equal(hash(raw), match[1], 'Unreviewed release manifest: ' + path);
  return JSON.parse(raw);
}
const previous = readPinned(manifest, /const ACCOUNT_DELETION_OVERLAY_SHA256 = '([a-f0-9]{64})';/);
const transitions = [
  readPinned(manifests+'univeracademy-id-overlay.json', /const BRAND_OVERLAY_SHA256 = '([a-f0-9]{64})';/),
  readPinned(manifests+'teacher-staging-overlay.json', /const STAGING_OVERLAY_SHA256 = '([a-f0-9]{64})';/),
  readPinned(manifests+'registration-storage-overlay.json', /const REGISTRATION_OVERLAY_SHA256 = '([a-f0-9]{64})';/),
  readPinned(manifests+'profile-release-order-overlay.json', /const PROFILE_RELEASE_OVERLAY_SHA256 = '([a-f0-9]{64})';/),
  readPinned(manifests+'teacher-live-overlay.json', /const LIVE_OVERLAY_SHA256 = '([a-f0-9]{64})';/),
  readPinned(manifests+'teacher-worker-overlay.json', /const WORKER_CABINET_OVERLAY_SHA256 = '([a-f0-9]{64})';/),
  readPinned(manifests+'teacher-default-cabinet-overlay.json', /const TEACHER_ENTRY_OVERLAY_SHA256 = '([a-f0-9]{64})';/),
  readPinned(manifests+'platform-performance-overlay.json', /const PLATFORM_PERFORMANCE_SHA256 = '([a-f0-9]{64})';/),
  readPinned(manifests+'staff-browser-entry-overlay.json', /const STAFF_BROWSER_ENTRY_SHA256 = '([a-f0-9]{64})';/),
  readPinned(manifests+'staff-browser-auto-open-overlay.json', /const STAFF_BROWSER_AUTO_OPEN_SHA256 = '([a-f0-9]{64})';/),
  readPinned(manifests+'staff-direct-links-overlay.json', /const STAFF_DIRECT_LINKS_SHA256 = '([a-f0-9]{64})';/),
  readPinned(manifests+'teacher-channel-gate-overlay.json', /const TEACHER_CHANNEL_GATE_SHA256 = '([a-f0-9]{64})';/),
  readPinned(manifests+'student-cabinet-fixes-overlay.json', /const TEACHER_CABINET_FIXES_SHA256 = '([a-f0-9]{64})';/),
  readPinned(manifests+'single-role-overlay.json', /const TEACHER_SINGLE_ROLE_SHA256 = '([a-f0-9]{64})';/),
  readPinned(manifests+'telegram-sign-in-overlay.json', /const TEACHER_TELEGRAM_SIGN_IN_SHA256 = '([a-f0-9]{64})';/),
].map(release => new Map(release.files.map(file => [file.path,file])));
const previousFiles = new Map(previous.files.map(file => [file.path, file]));
const rows = [];
for (const path of paths) {
  assert(lstatSync(path).isFile(), 'Regular source required: ' + path);
  const old = previousFiles.get(path);
  let selected = old?.result;
  for (const layer of transitions) {
    const next = layer.get(path);
    if (!next) continue;
    assert.equal(next.previous_sha256, selected?.sha256 ?? null, 'Account deletion predecessor mismatch: ' + path);
    selected = next;
  }
  assert(selected, 'Unreviewed account-deletion input: ' + path);
  const bytes = readFileSync(path);
  assert.equal(bytes.length, selected.bytes, 'ACCOUNT_DELETION_PINS_STALE: ' + path);
  assert.equal(hash(bytes), selected.sha256, 'ACCOUNT_DELETION_PINS_STALE: ' + path);
  if (old) rows.push(old);
}
const output = JSON.stringify({format_version:1,base_commit:base,status:'local-review-only-not-deployed',files:rows},null,2)+'\n';
assert.equal(hash(output), hash(readFileSync(manifest)), 'ACCOUNT_DELETION_PINS_STALE: keep historical pins and review a new overlay');
// With no arguments this also verifies reproducibility. Generate to stdout on
// explicit request so reproducing an old release cannot repin any newer source.
if (process.argv.includes('--print')) process.stdout.write(output);

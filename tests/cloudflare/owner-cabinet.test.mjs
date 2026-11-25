import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createWorkerCabinetHandler } from '../../runtime/cloudflare-cabinet.mjs';
import { fetchNativeCabinet } from '../../runtime/cloudflare-cabinet-route.mjs';
import { forwardTeacherStaging, teacherStagingPath } from '../../runtime/teacher-staging-proxy.mjs';

// The Owner cabinet has its own origin and gateway; the Ustoz surface never carries it.
const ustoz = 'https://ustoz.example.com', ega = 'https://ega.example.com', student = 'https://mini.example.com', api = 'https://api.example.com';
const env = { UA_CABINET_STAGING_ENABLED:'true', UA_CABINET_RUNTIME:'worker', UA_CABINET_TEACHER_ORIGIN:ustoz, UA_CABINET_OWNER_ORIGIN:ega,
  UA_CABINET_STUDENT_ORIGIN:student, UA_API_ORIGIN:api, UA_CLERK_SECRET_KEY:'unit-test-only',
  UA_CLERK_PROVIDER_SETTINGS:JSON.stringify({authorizedParties:[student],timeoutMs:100}),
  CABINET_HYPERDRIVE:{connectionString:'postgresql://mock:fixture@localhost:5432/cabinet'} };
const path = role => '/api/v1/' + role + '/pilot/dashboard';
const req = (origin, role, init) => new Request(origin + path(role), init);
const status = async response => response.status;

test('the Worker route admits the Owner only through its own entry point and only on the Owner origin', async () => {
  // Owner entry point: refuses everything but the Owner read on the Owner origin (before any private resource is touched).
  for (const [request, expected] of [
    [req(ustoz,'owner'),404], [req(ega,'teacher'),404], [req(ega,'admin'),404], [req(api,'student'),404],
    [req(ega,'owner',{method:'POST'}),404], [new Request(ega + path('owner') + '?person_id=x'),404], [new Request(ega + path('owner') + '#x'),404],
    [new Request('http://ega.example.com' + path('owner')),404], [req(ega,'owner',{method:'PUT'}),404], [req(ega,'owner',{method:'DELETE'}),404],
    [new Request(ega + '/api/v1/owner/pilot/commands/approveGroup',{method:'POST'}),404],
  ]) assert.equal(await status(await fetchNativeCabinet(request, env, 'owner')), expected, request.method + ' ' + request.url);
  // Staff (Ustoz) entry point: never carries the Owner, not even on its own origin or the Owner origin.
  for (const request of [req(ustoz,'owner'), req(ega,'owner')]) assert.equal(await status(await fetchNativeCabinet(request, env, 'staff')), 404);
  // Without an Owner origin, or with the cabinet off, the Owner entry point does not exist.
  for (const patch of [{UA_CABINET_OWNER_ORIGIN:undefined},{UA_CABINET_STAGING_ENABLED:'false'},{UA_CABINET_RUNTIME:'node'},{UA_CABINET_OWNER_ORIGIN:'http://ega.example.com'}])
    assert.equal(await status(await fetchNativeCabinet(req(ega,'owner'), {...env,...patch}, 'owner')), 404);
});

test('the cabinet handler gives the Owner its own origin and its own audience, and rejects the Owner elsewhere', async () => {
  const seen = [];
  const handler = createWorkerCabinetHandler({ makeClerk: async config => { seen.push(config.authorizedParties); return {verifier:{},liveness:async()=>{},close(){}}; },
    loadClient: async () => class {}, createApi: options => ({ fetch: async request => { seen.push(options); return Response.json({role:new URL(request.url).pathname.split('/')[3]}); } }) });
  const ok = await handler.fetch(req(ega,'owner',{headers:{origin:ega}}), env);
  assert.equal(ok.status,200); assert.equal(ok.headers.get('access-control-allow-origin') ?? '', ''); // CORS headers are the API's job
  const [parties, options] = seen;
  assert.deepEqual(parties, [student, ustoz, ega]);
  assert.equal(options.ownerOrigin, ega); assert.equal(options.teacherOrigin, ustoz);
  // The Owner on the Ustoz origin, a teacher on the Owner origin, and a mismatched Origin header are all refused.
  assert.equal((await handler.fetch(req(ustoz,'owner'), env)).status, 404);
  assert.equal((await handler.fetch(req(ega,'teacher'), env)).status, 404);
  assert.equal((await handler.fetch(req(ega,'owner',{headers:{origin:ustoz}}), env)).status, 403);
  assert.equal((await handler.fetch(req(ustoz,'teacher',{headers:{origin:ega}}), env)).status, 403);
  // Without an Owner origin the Owner is unreachable and the others keep working with no Owner audience.
  const {UA_CABINET_OWNER_ORIGIN, ...withoutOwner} = env;
  assert.equal((await handler.fetch(req(ega,'owner'), withoutOwner)).status, 404);
  seen.length = 0;
  assert.equal((await handler.fetch(req(ustoz,'teacher'), withoutOwner)).status, 200);
  assert.deepEqual(seen[0], [student, ustoz]); assert.equal('ownerOrigin' in seen[1], false);
  // A malformed Owner origin is an unavailable service, never a guess.
  assert.equal((await handler.fetch(req(ega,'owner'), {...env,UA_CABINET_OWNER_ORIGIN:'http://ega.example.com'})).status, 503);
});

test('the Pages proxy: the Ustoz surface never forwards the Owner and the Owner surface forwards nothing else', async () => {
  const forwarded = [];
  const gateway = { fetch: async request => { forwarded.push(request.url); return Response.json({data:{}},{headers:{'cache-control':'no-store'}}); } };
  const pages = { ...env, UA_CABINET_API: gateway };
  const via = (surface, request, patch = {}) => forwardTeacherStaging(request, {...pages,...patch}, {surface});
  assert.equal((await via('owner', req(ega,'owner',{headers:{origin:ega}}))).status, 200);
  assert.deepEqual(forwarded, [ega + path('owner')]);
  for (const [surface, request, expected] of [
    ['teacher', req(ustoz,'owner'), 404], ['teacher', req(ega,'owner'), 404], ['owner', req(ega,'teacher'), 404], ['owner', req(ega,'admin'), 404],
    ['owner', req(ustoz,'owner'), 404], ['owner', req(ega,'owner',{method:'POST'}), 404], ['owner', req(ega,'owner',{headers:{origin:ustoz}}), 403],
    ['student', req(api,'owner'), 404],
  ]) assert.equal((await via(surface, request)).status, expected, surface + ' ' + request.url);
  assert.equal((await via('owner', req(ega,'owner'), {UA_CABINET_OWNER_ORIGIN:undefined})).status, 503);
  assert.equal((await via('owner', req(ega,'owner'), {UA_CABINET_API:undefined})).status, 503);
  assert.equal((await via('owner', req(ega,'owner'), {UA_CABINET_RUNTIME:'node'})).status, 404); // Owner exists only on the Worker runtime
  assert.equal(forwarded.length, 1);
  assert.equal(teacherStagingPath(path('owner'),'GET'), false); // the legacy host never carries the Owner
  for (const role of ['teacher','admin','student']) assert.equal(teacherStagingPath(path(role),'GET'), true);
});

test('the Worker exports one Owner gateway entry point bound only to the Owner surface', () => {
  const source = readFileSync(new URL('../../runtime/cloudflare-worker.mjs', import.meta.url), 'utf8');
  assert.match(source, /export class OwnerCabinetGateway extends WorkerEntrypoint \{\s*async fetch\(request\) \{ return fetchNativeCabinet\(request,this\.env,'owner'\); \}\s*\}/);
  assert.match(source, /export class TeacherCabinetGateway extends WorkerEntrypoint \{\s*async fetch\(request\) \{ return fetchNativeCabinet\(request,this\.env,'staff'\); \}\s*\}/);
});

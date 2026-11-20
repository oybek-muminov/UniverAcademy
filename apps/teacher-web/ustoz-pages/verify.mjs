// Exercise the compiled Wrangler bundle locally. Neither entry ever talks to a real provider.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';
const output = new URL('../../mini-app/dist-teacher-entrance/', import.meta.url);
const {default:worker} = await import(new URL('_worker.js/index.js', output));
const rules = JSON.parse(await readFile(new URL('_routes.json', output), 'utf8'));
assert.equal(rules.version, 1);
assert.deepEqual([...rules.include].sort(), ['/api/v1/admin/pilot/*','/api/v1/teacher/pilot/*']);
assert.deepEqual(rules.exclude, []);
const origin = 'https://staff.example', upstream = 'https://scoped-node.example';
const env = {
  UA_CABINET_STAGING_ENABLED:'true', UA_CABINET_TEACHER_ORIGIN:origin,
  UA_CABINET_STAGING_NODE_ORIGIN:upstream, UA_CABINET_STAGING_PROXY_SECRET:'private-example-that-only-works-in-this-local-test',
  ASSETS:{fetch:async () => new Response('static asset')},
};
const context = {waitUntil() {}, passThroughOnException() {}};
const original = globalThis.fetch;
const forwarded = [];
globalThis.fetch = async request => {
  const url = new URL(request.url);
  assert.equal(url.origin,upstream);
  assert.equal(request.headers.get('x-univeracademy-pilot-proxy'),env.UA_CABINET_STAGING_PROXY_SECRET);
  assert.equal(request.headers.get('authorization'),'Bearer fixture');
  forwarded.push(url.pathname);
  return Response.json({data:[]}, {headers:{'cache-control':'no-store'}});
};
try {
  for (const role of ['teacher','admin']) {
    const path = '/api/v1/'+role+'/pilot/dashboard';
    const response = await worker.fetch(new Request(origin+path,{headers:{authorization:'Bearer fixture'}}),env,context);
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{data:[]});
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(forwarded.at(-1),path);
  }
  for (const path of ['/','/assets/example.js','/api/v1/teacher/cabinet','/api/v1/student/pilot/dashboard']) {
    const response = await worker.fetch(new Request(origin+path),env,context);
    assert.equal(await response.text(),'static asset');
  }
  const disabled = await worker.fetch(new Request(origin+'/api/v1/teacher/pilot/dashboard'),
    {...env,UA_CABINET_STAGING_ENABLED:'false'},context);
  assert.equal(disabled.status,404);
  assert.equal(forwarded.length,2);
  writeSync(1, 'Compiled Pages worker verified. Teacher and Admin pass through the gateway. Other paths use ASSETS.\n');
} finally { globalThis.fetch=original; }

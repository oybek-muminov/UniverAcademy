// Exercise the compiled Ega Pages bundle locally. It never talks to a real provider.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';
const output = new URL('../../mini-app/dist-owner-entrance/', import.meta.url);
const {default:worker} = await import(new URL('_worker.js/index.js', output));
const rules = JSON.parse(await readFile(new URL('_routes.json', output), 'utf8'));
assert.equal(rules.version, 1);
// The only route family this site forwards: the Owner's own surface. The shared route table then admits just the dashboard
// read and the two Owner commands; every other path under it is refused before the gateway.
assert.deepEqual([...rules.include], ['/api/v1/owner/pilot/*']);
assert.deepEqual(rules.exclude, []);
const origin = 'https://owner.example', ustoz = 'https://staff.example';
const received = [];
const gateway = { fetch: async request => { received.push(request); return Response.json({data:{role:'owner'}}, {headers:{'cache-control':'no-store'}}); } };
const env = { UA_CABINET_STAGING_ENABLED:'true', UA_CABINET_OWNER_ORIGIN:origin, UA_CABINET_TEACHER_ORIGIN:ustoz,
  UA_CABINET_RUNTIME:'worker', UA_CABINET_API:gateway, ASSETS:{fetch:async () => new Response('static asset')} };
const context = {waitUntil() {}, passThroughOnException() {}};
const path = '/api/v1/owner/pilot/dashboard', commandPath = name => '/api/v1/owner/pilot/commands/' + name;
const ok = await worker.fetch(new Request(origin+path,{headers:{authorization:'Bearer fixture',origin}}),env,context);
assert.equal(ok.status,200); assert.deepEqual(await ok.json(),{data:{role:'owner'}}); assert.equal(ok.headers.get('cache-control'),'no-store');
assert.equal(received.length,1); assert.equal(received[0].url,origin+path); assert.equal(received[0].headers.get('authorization'),'Bearer fixture');
// The two Owner commands cross the same binding, with their method, body and key intact.
for (const name of ['findStudent','assignTeacher']) {
  const before = received.length;
  const posted = await worker.fetch(new Request(origin+commandPath(name),{method:'POST',headers:{authorization:'Bearer fixture',origin,'content-type':'application/json','idempotency-key':'k-'+name},body:'{"univeracademy_id":"0101000041"}'}),env,context);
  assert.equal(posted.status,200); assert.equal(received.length,before+1);
  const sent = received.at(-1); assert.equal(sent.method,'POST'); assert.equal(sent.url,origin+commandPath(name));
  assert.equal(sent.headers.get('idempotency-key'),'k-'+name); assert.equal(await sent.text(),'{"univeracademy_id":"0101000041"}');
}
const accepted = received.length;
// Anything but the Owner's own surface on the Owner origin is refused, and never reaches the service.
const refused = [
  [new Request(ustoz+path,{headers:{authorization:'Bearer fixture'}}),404],
  [new Request(origin+path,{method:'POST'}),404],
  [new Request(origin+path+'?person_id=x'),404],
  [new Request(origin+path,{headers:{origin:'https://untrusted.example'}}),403],
  [new Request(origin+commandPath('findStudent')),404],
  [new Request(origin+commandPath('approveGroup'),{method:'POST',headers:{authorization:'Bearer fixture',origin}}),404],
  [new Request(origin+commandPath('assignTeacher')+'?x=1',{method:'POST',headers:{authorization:'Bearer fixture',origin}}),404],
  [new Request(origin+'/api/v1/owner/pilot/teachers',{headers:{authorization:'Bearer fixture',origin}}),404],
  [new Request(ustoz+commandPath('assignTeacher'),{method:'POST',headers:{authorization:'Bearer fixture'}}),404],
];
for (const [request,status] of refused) assert.equal((await worker.fetch(request,env,context)).status,status);
for (const other of ['/api/v1/teacher/pilot/dashboard','/api/v1/admin/pilot/dashboard','/api/v1/student/pilot/dashboard','/','/assets/example.js'])
  assert.equal(await (await worker.fetch(new Request(origin+other),env,context)).text(),'static asset');
assert.equal((await worker.fetch(new Request(origin+path),{...env,UA_CABINET_STAGING_ENABLED:'false'},context)).status,404);
assert.equal((await worker.fetch(new Request(origin+path),{...env,UA_CABINET_RUNTIME:'node'},context)).status,404);
assert.equal((await worker.fetch(new Request(origin+path),{...env,UA_CABINET_OWNER_ORIGIN:undefined},context)).status,503);
assert.equal((await worker.fetch(new Request(origin+path),{...env,UA_CABINET_API:undefined},context)).status,503);
assert.equal(received.length,accepted);
writeSync(1, 'Compiled Ega Pages worker verified. Only the Owner dashboard and its two commands reach the Owner gateway; every other path is refused or uses ASSETS.\n');

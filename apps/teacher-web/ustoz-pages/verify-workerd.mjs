// Run the compiled Pages bundle with a real service binding to a named Worker entrypoint.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const origin='https://staff.example', path='/api/v1/teacher/pilot/commands/createGroup';
const code=await readFile(new URL('../../mini-app/dist-teacher-entrance/_worker.js/index.js',import.meta.url),'utf8');
const api=`
import {WorkerEntrypoint} from 'cloudflare:workers';
export class TeacherCabinetGateway extends WorkerEntrypoint {
  async fetch(req) {
    if (req.headers.get('idempotency-key')==='redirect') return Response.redirect('https://untrusted.example',307);
    return Response.json({url:req.url,method:req.method,body:await req.text(),headers:Object.fromEntries(req.headers)},{
      headers:{'set-cookie':'upstream-only=1','cache-control':'public','x-univeracademy-pilot-proxy':'upstream-only'}
    });
  }
}
export default {fetch(){return new Response('Incorrect public target',{status:404});}};
`;
const pinned={UA_CABINET_STAGING_ENABLED:'true',UA_CABINET_TEACHER_ORIGIN:origin,UA_CABINET_RUNTIME:'worker'};
const pages=(name,bindings,nativeBinding=true)=>({name,modules:true,script:code,compatibilityDate:'2026-11-13',bindings,
  serviceBindings:{ASSETS:()=>new Response('static'),...(nativeBinding?{UA_CABINET_API:{name:'api',entrypoint:'TeacherCabinetGateway'}}:{})},
  outboundService:()=>new Response('Unexpected network access',{status:502})
});
const mf=new Miniflare(convertV4MiniflareOptions({workers:[
  {...pages('staff',pinned),routes:['staff.example/*']},pages('off',{...pinned,UA_CABINET_STAGING_ENABLED:'false'}),
  pages('invalid',{...pinned,UA_CABINET_RUNTIME:'unknown'}),pages('missing',pinned,false),
  {name:'api',modules:true,script:api,compatibilityDate:'2026-11-13'}
]}));
try {
  const staff=await mf.getWorker('staff');
  for (const role of ['teacher','admin']) {
    const p=path.replace('teacher',role);
    const resp=await staff.fetch(origin+p,{method:'POST',body:'{"name":"Fizika"}',headers:{
      origin,authorization:'Bearer fake','idempotency-key':'command','content-type':'application/json',
      cookie:'not-forwarded=1','x-univeracademy-pilot-proxy':'injected',forwarded:'host=spoof.invalid',
      'x-forwarded-host':'spoof.invalid','x-univeracademy-actor':'other'
    }});
    assert.equal(resp.status,200,resp.ok ? undefined : await resp.text());
    assert.equal(resp.headers.get('cache-control'),'no-store');
    assert.equal(resp.headers.get('set-cookie'),null);
    assert.equal(resp.headers.get('x-univeracademy-pilot-proxy'),null);
    const relay=await resp.json();
    assert.equal(relay.url,origin+p);assert.equal(relay.method,'POST');
    assert.deepEqual(JSON.parse(relay.body),{name:'Fizika'});
    for(const [name,value] of Object.entries({origin,authorization:'Bearer fake','idempotency-key':'command','content-type':'application/json'}))
      assert.equal(relay.headers[name],value);
    for(const name of ['cookie','forwarded','x-forwarded-host','x-univeracademy-actor','x-univeracademy-pilot-proxy']) assert.equal(relay.headers[name],undefined);
  }
  const ownerPath='/api/v1/owner/pilot/dashboard';
  const ownerResponse=await staff.fetch(origin+ownerPath,{headers:{origin,authorization:'Bearer fixture'}});
  assert.equal(ownerResponse.status,200);
  assert.equal((await ownerResponse.json()).url,origin+ownerPath);
  assert.equal((await staff.fetch(origin+ownerPath,{method:'POST'})).status,404);
  assert.equal((await staff.fetch(origin+ownerPath+'?role=owner')).status,404);
  assert.equal((await staff.fetch(origin+ownerPath,{headers:{origin:'https://untrusted.example'}})).status,403);
  assert.equal((await staff.fetch(origin+path,{headers:{origin:'https://untrusted.example'}})).status,403);
  assert.equal((await staff.fetch('https://wrong.example'+path)).status,404);
  assert.equal((await staff.fetch(origin+path+'?actor=other')).status,404);
  assert.equal((await staff.fetch(origin+path,{headers:{'idempotency-key':'redirect'},redirect:'manual'})).status,503);
  assert.equal(await (await staff.fetch(origin+'/api/v1/student/pilot/dashboard')).text(),'static');
  for(const [worker,status] of [['off',404],['invalid',503],['missing',503]]) {
    assert.equal((await (await mf.getWorker(worker)).fetch(origin+path)).status,status);
  }
  console.log('PASS workerd. The compiled Ustoz gateway reaches only the named staff service, including read-only Owner access, and respects the origin, binding and activation gates.');
} finally {await mf.dispose();}

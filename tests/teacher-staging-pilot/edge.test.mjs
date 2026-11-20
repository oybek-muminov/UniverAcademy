import assert from 'node:assert/strict';
import test from 'node:test';
import { forwardTeacherStaging } from '../../runtime/teacher-staging-proxy.mjs';
import { createTeacherStageNode } from '../../runtime/teacher-staging-node.mjs';

const teacherOrigin = 'https://ustoz.example.test';
const apiOrigin = 'https://api.example.test';
const nodeOrigin = 'https://node.example.test';
const proxyHeader = 'x-univeracademy-pilot-proxy';
const bindings = {
  UA_CABINET_STAGING_ENABLED: 'true',
  UA_CABINET_STAGING_PROXY_SECRET: 'fixture-local-edge-key-with-32-or-more-characters',
  UA_CABINET_TEACHER_ORIGIN: teacherOrigin,
  UA_CABINET_STAGING_NODE_ORIGIN: nodeOrigin,
  UA_API_ORIGIN: apiOrigin
};
const path='/api/v1/teacher/pilot/dashboard';

test('a configured edge forwards only the selected browser credentials and rejects redirects', async () => {
  let count=0;
  const req=new Request(teacherOrigin+path, {headers:{
    authorization:'Bearer fixture',origin:teacherOrigin,cookie:'private=fixture',
    [proxyHeader]:'client-supplied',forwarded:'host=somewhere.example.test'
  }});
  const transport=async request=>{
    count++;
    assert.equal(request.url,nodeOrigin+path);
    assert.equal(request.redirect,'manual');
    assert.equal(request.headers.get(proxyHeader),bindings.UA_CABINET_STAGING_PROXY_SECRET);
    assert.equal(request.headers.get('authorization'),'Bearer fixture');
    assert.equal(request.headers.get('origin'),teacherOrigin);
    assert.equal(request.headers.get('cookie'),null);
    assert.equal(request.headers.get('forwarded'),null);
    return new Response('sensitive',{headers:{'content-type':'image/png','set-cookie':'upstream=fixture',
      'cache-control':'public',[proxyHeader]:'private'}});
  };
  const forwarded=await forwardTeacherStaging(req,bindings,{surface:'teacher',transport});
  assert.equal(await forwarded.text(),'sensitive');
  assert.equal(forwarded.headers.get('cache-control'),'no-store');
  assert.equal(forwarded.headers.get('set-cookie'),null);
  assert.equal(forwarded.headers.get(proxyHeader),null);
  const redirect=await forwardTeacherStaging(req,bindings,{surface:'teacher',transport:()=>Response.redirect('https://other.example.test',307)});
  assert.equal(redirect.status,503);
  assert.equal(redirect.headers.get('location'),null);
  assert.equal((await forwardTeacherStaging(req,bindings,{surface:'student',transport})).status,404);
  assert.equal((await forwardTeacherStaging(new Request(apiOrigin+path),bindings,{surface:'teacher',transport})).status,404);
  assert.equal((await forwardTeacherStaging(new Request(teacherOrigin+path+'?actor=other'),bindings,{surface:'teacher',transport})).status,404);
  assert.equal(count,1);
});

test('the Node entry pins its origin and removes the gateway secret before calling the cabinet',async()=>{
  const state={...bindings};
  const seen=[];
  const entry=createTeacherStageNode(()=>state,async()=>({fetch:async request=>{
    seen.push(request);
    return new Response(null,{status:204});
  }}));
  const get=(url,auth)=>entry.fetch(new Request(url,{headers:{authorization:'Bearer fixture',
    ...(auth?{[proxyHeader]:auth}:{}),cookie:'test=1','x-forwarded-host':teacherOrigin}}));
  assert.equal((await get(nodeOrigin+path)).status,403);
  assert.equal((await get(teacherOrigin+path,state.UA_CABINET_STAGING_PROXY_SECRET)).status,403);
  assert.equal((await get(nodeOrigin+path,state.UA_CABINET_STAGING_PROXY_SECRET)).status,204);
  assert.equal(seen.length,1);
  assert.equal(seen[0].url,teacherOrigin+path);
  assert.equal(seen[0].headers.get(proxyHeader),null);
  assert.equal(seen[0].headers.get('cookie'),null);
  assert.equal(seen[0].headers.get('x-forwarded-host'),null);
  assert.equal(seen[0].headers.get('authorization'),'Bearer fixture');
});

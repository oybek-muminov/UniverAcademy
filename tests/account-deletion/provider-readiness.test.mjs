import test from 'node:test';import assert from 'node:assert/strict';
import {createClerkDeletionTransport} from '../../runtime/account-deletion-provider.mjs';
const issuer='https://clerk.example.com';
const settings={secretKey:'sk_private',expectedIssuer:issuer,expectedInstanceId:'ins_expected'};
function fixture(overrides={}){
 const calls=[];const payloads={'/v1/instance':{id:'ins_expected',environment_type:'production'},'/v1/domains':{data:[{is_satellite:false,frontend_api_url:issuer}]},'/v1/users/user_a':{id:'user_a',object:'user',deleted:true},...overrides};
 const remove=createClerkDeletionTransport({...settings,transport:async r=>{calls.push(r);const p=payloads[new URL(r.url).pathname];return p instanceof Response?p:Response.json(p);}});
 return {calls,remove};
}
test('authenticated instance and exact primary issuer checked before DELETE',async()=>{const {remove,calls}=fixture();assert.equal(await remove('user_a',issuer),'deleted');assert.deepEqual(calls.map(r=>r.method),['GET','GET','DELETE']);for(const r of calls){assert.equal(new URL(r.url).origin,'https://api.clerk.com');assert.equal(r.headers.get('authorization'),'Bearer sk_private');assert.equal(r.redirect,'manual');assert.equal(r.credentials,'omit');}});
for(const [name,override]of [
 ['wrong instance',{'/v1/instance':{id:'ins_wrong',environment_type:'production'}}],
 ['development instance',{'/v1/instance':{id:'ins_expected',environment_type:'development'}}],
 ['wrong issuer',{'/v1/domains':{data:[{is_satellite:false,frontend_api_url:'https://other.example.com'}]}}],
 ['satellite only',{'/v1/domains':{data:[{is_satellite:true,frontend_api_url:issuer}]}}],
 ['malformed domains',{'/v1/domains':{data:{frontend_api_url:issuer}}}],
 ['readiness404',{'/v1/instance':new Response('',{status:404})}],
 ['readiness redirect',{'/v1/domains':new Response('',{status:302,headers:{location:'https://evil.example.com'}})}],
])test(name+' refuses DELETE, including hypothetical user404',async()=>{const {remove,calls}=fixture({...override,'/v1/users/user_a':new Response('',{status:404})});await assert.rejects(remove('user_a',issuer));assert.equal(calls.some(r=>r.method==='DELETE'),false);});
test('only readiness-bound user404 is absent',async()=>{const {remove,calls}=fixture({'/v1/users/user_a':new Response('',{status:404})});assert.equal(await remove('user_a',issuer),'absent');assert.equal(calls.length,3);});
test('wrong recovery issuer sends nothing',async()=>{const {remove,calls}=fixture();await assert.rejects(remove('user_a','https://other.example.com'));assert.equal(calls.length,0);});
test('readiness repeats each attempt rather than trusting stale boolean',async()=>{const {remove,calls}=fixture();await remove('user_a',issuer);await remove('user_a',issuer);assert.equal(calls.filter(r=>r.url.endsWith('/instance')).length,2);});
test('readiness stalled body expires before DELETE',async()=>{let calls=0;const remove=createClerkDeletionTransport({...settings,timeoutMs:10,transport:async()=>{calls++;return new Response(new ReadableStream({start(){}}),{headers:{'content-type':'application/json'}});}});await assert.rejects(remove('user_a',issuer));assert.equal(calls,1);});
test('readiness body budget failure never DELETEs',async()=>{let calls=0;const remove=createClerkDeletionTransport({...settings,maxResponseBytes:4,transport:async()=>{calls++;return Response.json({id:'ins_expected',environment_type:'production'});}});await assert.rejects(remove('user_a',issuer));assert.equal(calls,1);});

test('readiness success cannot excuse malformed delete response',async()=>{const {remove}=fixture({'/v1/users/user_a':{id:'user_b',object:'user',deleted:true}});await assert.rejects(remove('user_a',issuer));});
test('unconfigured instance or issuer is rejected',()=>{assert.throws(()=>createClerkDeletionTransport({...settings,expectedInstanceId:undefined,transport:fetch}));assert.throws(()=>createClerkDeletionTransport({...settings,expectedIssuer:'http://clerk.example.com',transport:fetch}));});

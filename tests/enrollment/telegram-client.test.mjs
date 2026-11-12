import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createProductionStudentClient,createLocalStudentClient,STUDENT_CONTRACT_SHA256,StudentApiError,StudentClientProtocolError} from '../../packages/api-client/student-client.ts';
import {createProductionStudentClient as ownerClient,STUDENT_CONTRACT_SHA256 as ownerPin} from '../../apps/mini-app/src/owner-client/student-client.ts';

const jwt='eyJ0ZXN0Ijp0cnVlfQ.eyJzdWIiOiJ1c2VyX09mZmxpbmUifQ.c3ludGhldGlj';
const proof='query_id=opaque%2Flaunch&user=%7B%22id%22%3A42%7D&hash=synthetic';
const ack={data:{ok:true}},session={data:{access_token:'opaque-access',refresh_token:'opaque-refresh',expires_at:'2030-01-01T00:00:00.000Z',refresh_expires_at:'2030-01-02T00:00:00.000Z',token_type:'Bearer',profile:{}}};
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const options=transport=>({mode:'production',baseUrl:'https://api.univeracademy.uz/api/v1',contractSha256:STUDENT_CONTRACT_SHA256,transport});
const hash=value=>createHash('sha256').update(value).digest('hex');

test('canonical and owner copies expose both exact operations and pinned constructor parity',async()=>{
 assert.equal(ownerPin,STUDENT_CONTRACT_SHA256);
 for(const name of ['student-client.ts','student-types.d.ts'])assert.deepEqual(await readFile(new URL('../../packages/api-client/'+name,import.meta.url)),await readFile(new URL('../../apps/mini-app/src/owner-client/'+name,import.meta.url)));
 const transport=async()=>reply(ack),a=createProductionStudentClient(options(transport)),b=ownerClient(options(transport));
 const local=createLocalStudentClient({...options(transport),mode:'local_fixture',baseUrl:'http://127.0.0.1:8793/api/v1'});
 assert.deepEqual(Object.keys(a),Object.keys(b));assert.deepEqual(Object.keys(a),Object.keys(local));
 for(const c of [a,b,local]){assert.equal(typeof c.linkTelegramIdentity,'function');assert.equal(typeof c.resumeTelegramSession,'function');}
 let calls=0;assert.throws(()=>createProductionStudentClient({...options(async()=>{calls++;return reply(ack);}),contractSha256:'f6226aa1cea63ae1fbc603b80aed9232bc4dd5213c4cc081cc13300ee0179b28'}),/CONTRACT_HASH_MISMATCH/);assert.equal(calls,0);
});
test('link sends only fresh caller JWT bearer and exact signed launch body; no opaque session or URL identity',async()=>{
 const requests=[],client=createProductionStudentClient(options(async r=>{requests.push(r);return reply(ack);}));
 assert.deepEqual(await client.linkTelegramIdentity(jwt,{init_data:proof}),ack);
 const r=requests[0];assert.equal(r.url,'https://api.univeracademy.uz/api/v1/auth/telegram/link');assert.equal(r.method,'POST');
 assert.equal(r.headers.get('authorization'),'Bearer '+jwt);assert.deepEqual(await r.json(),{init_data:proof});assert.equal(r.headers.get('idempotency-key'),null);
 assert.equal(r.credentials,'omit');assert.equal(r.redirect,'error');assert.equal(r.cache,'no-store');
});
test('resume never inherits Authorization after another operation and preserves opaque launch bytes',async()=>{
 const requests=[],client=createProductionStudentClient(options(async r=>{requests.push(r);return reply(r.url.endsWith('/resume')?session:ack);}));
 await client.linkTelegramIdentity(jwt,{init_data:proof});assert.deepEqual(await client.resumeTelegramSession({init_data:proof}),session);
 const r=requests[1];assert.equal(r.url,'https://api.univeracademy.uz/api/v1/auth/telegram/resume');assert.equal(r.method,'POST');assert.equal(r.headers.get('authorization'),null);assert.deepEqual(await r.json(),{init_data:proof});assert.equal(r.headers.get('idempotency-key'),null);
});
for(const op of ['linkTelegramIdentity','resumeTelegramSession'])test(op+' rejects malformed/extra/hostile request fields before HTTP',async()=>{
 let calls=0,gets=0;const client=createProductionStudentClient(options(async()=>{calls++;return reply(ack);}));
 const getter={};Object.defineProperty(getter,'init_data',{enumerable:true,get(){gets++;throw new Error('must-not-read');}});
 const inherited=Object.create({init_data:proof}),symbol={init_data:proof,[Symbol('extra')]:1};
 for(const input of [undefined,null,[],{},'',{init_data:''},{init_data:7},{init_data:'x'.repeat(16385)},{init_data:proof,person_id:'forged'},{init_data:proof,roles:['owner']},{init_data:proof,Authorization:'forged'},getter,inherited,symbol]){
  await assert.rejects(op==='linkTelegramIdentity'?client[op](jwt,input):client[op](input),e=>e instanceof StudentClientProtocolError&&e.message==='INVALID_TELEGRAM_REQUEST');
 }
 assert.equal(calls,0);assert.equal(gets,0);
});
test('link rejects opaque project proofs and malformed bearer syntax before HTTP',async()=>{
 let calls=0;const client=createProductionStudentClient(options(async()=>{calls++;return reply(ack);}));
 for(const token of [undefined,null,'','opaque-project-proof','Bearer '+jwt,jwt+'\r\nforged: value',' '+jwt])await assert.rejects(client.linkTelegramIdentity(token,{init_data:proof}),/INVALID_CLERK_TOKEN/);
 assert.equal(calls,0);
});
test('new operations never retry conflict/revocation/unavailable outcomes or mask errors with server text',async()=>{
 for(const [op,status,code]of [['linkTelegramIdentity',409,'IDENTITY_LINK_CONFLICT'],['resumeTelegramSession',409,'TELEGRAM_LINK_REQUIRED'],['resumeTelegramSession',409,'INIT_DATA_REPLAY'],['resumeTelegramSession',401,'CLERK_SESSION_REVOKED'],['resumeTelegramSession',503,'SERVICE_UNAVAILABLE']]){
  let calls=0;const client=createProductionStudentClient(options(async()=>{calls++;return reply({error:{code,message:'private-untrusted-detail',request_id:'offline-request'}},status);}));
  await assert.rejects(op==='linkTelegramIdentity'?client[op](jwt,{init_data:proof}):client[op]({init_data:proof}),e=>e instanceof StudentApiError&&e.code===code&&e.status===status&&e.message===code);assert.equal(calls,1);
 }
});
test('link is independent of the client exchange ledger and does not manufacture a project session',async()=>{
 const seen=[],client=createProductionStudentClient(options(async r=>{seen.push(r);return reply(r.url.endsWith('/clerk')?session:ack);}));
 await client.exchangeClerkSession(jwt,{});const result=await client.linkTelegramIdentity(jwt,{init_data:proof});assert.deepEqual(result,ack);assert.equal(seen.length,2);
 assert.equal(seen[1].headers.get('authorization'),'Bearer '+jwt);
});
test('schemas bind exact method/security/request/response shapes without changing frozen Clerk source',async()=>{
 const fullRaw=await readFile(new URL('../../contracts/telegram-return.openapi.json',import.meta.url)),full=JSON.parse(fullRaw),view=JSON.parse(await readFile(new URL('../../packages/api-client/student-openapi.json',import.meta.url)));
 assert.equal(hash(fullRaw),STUDENT_CONTRACT_SHA256);assert.equal(view['x-source'].full_openapi_sha256,STUDENT_CONTRACT_SHA256);
 const frozenRaw=await readFile(new URL('../../contracts/clerk-review.openapi.json',import.meta.url)),frozen=JSON.parse(frozenRaw);assert.equal(hash(frozenRaw),'f6226aa1cea63ae1fbc603b80aed9232bc4dd5213c4cc081cc13300ee0179b28');
 for(const [path,value]of Object.entries(frozen.paths))assert.deepEqual(full.paths[path],value,path);
 assert.deepEqual(full.paths['/auth/telegram/link'].post.security,[{ClerkSessionBearer:[]}]);assert.deepEqual(full.paths['/auth/telegram/resume'].post.security,[]);assert.equal(full.paths['/auth/telegram/resume'].post['x-authorization-header'],'MUST_BE_ABSENT');
 for(const [path,name,result]of [['/auth/telegram/link','TelegramLinkRequest','SuccessAck'],['/auth/telegram/resume','TelegramResumeRequest','SuccessSession']]){
  const op=full.paths[path].post;assert.deepEqual(view.paths[path],full.paths[path]);assert.equal(op.requestBody.content['application/json'].schema.$ref,'#/components/schemas/'+name);assert.equal(op.responses['200'].content['application/json'].schema.$ref,'#/components/schemas/'+result);
  assert.deepEqual(full.components.schemas[name],{type:'object',additionalProperties:false,properties:{init_data:{type:'string',minLength:1,maxLength:16384}},required:['init_data']});assert.deepEqual(view.components.schemas[name],full.components.schemas[name]);
 }
 for(const name of ['SuccessAck','SuccessSession','Session','Profile'])assert.deepEqual(full.components.schemas[name],frozen.components.schemas[name]);
});

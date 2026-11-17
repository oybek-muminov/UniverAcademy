import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createProductionOwnerConnection} from '../src/production-connection.ts';
import {STUDENT_CONTRACT_SHA256} from '../src/owner-client/student-client.ts';
import {DefiniteDeletionRejection} from '../src/account-deletion-candidate/controller.ts';
const packet=JSON.parse(readFileSync(new URL('./fixtures/wire.json',import.meta.url),'utf8'));
const profile=packet.cases.profileRegistered.data;
const request={requestId:'ad348ca1-57fc-48c8-9387-d1a7e7557684',receipt:'A'.repeat(43),confirmation:'delete-account-v1',clerkToken:'clerk-jwt'};
async function harness(reply){
 const calls=[];const c=createProductionOwnerConnection({mode:'production',baseUrl:'https://api.example.test/api/v1',contractSha256:STUDENT_CONTRACT_SHA256},async r=>{
  calls.push(r);if(r.url.endsWith('/auth/clerk'))return Response.json({data:{token_type:'Bearer',access_token:'opaque-app',refresh_token:'refresh',expires_at:new Date(Date.now()+60000).toISOString(),refresh_expires_at:new Date(Date.now()+120000).toISOString(),profile}});
  return reply(r);
 },{loginMethod:'clerk'});await c.auth.login('clerk-proof');return{c,calls};
}
test('owner deletion preserves definite rejection class and app session, no automatic retry',async()=>{
 const{c,calls}=await harness(()=>Response.json({error:{code:'REVERIFICATION_REQUIRED'}},{status:403}));const person=c.auth.person();
 const port=c.auth.createDeletionPort(person);await assert.rejects(port.submit(request),DefiniteDeletionRejection);
 assert.equal(c.auth.person(),person);assert.equal(calls.length,2);const sent=calls[1];assert.equal(sent.headers.get('authorization'),'Bearer opaque-app');assert.equal(sent.headers.get('x-clerk-token'),'clerk-jwt');
});
test('owner deletion status works after app session cleared without bearer or refresh',async()=>{
 const{c,calls}=await harness(()=>Response.json({status:'completed'}));const port=c.auth.createDeletionPort(c.auth.person());c.auth.clear();
 assert.deepEqual(await port.status(request.receipt),{status:'completed'});assert.equal(calls[1].headers.get('authorization'),null);assert.equal(calls[1].headers.get('x-clerk-token'),null);
 await assert.rejects(port.submit(request));assert.equal(calls.length,2);
});
test('owner deletion wrong cabinet and mid-request clear fail closed',async()=>{
 let release;const{c}=await harness(()=>new Promise(r=>{release=r}));assert.throws(()=>c.auth.createDeletionPort('other'));
 const port=c.auth.createDeletionPort(c.auth.person());const result=port.submit(request);const rejected=assert.rejects(result);await new Promise(r=>setImmediate(r));c.auth.clear();release(Response.json({status:'pending'}));await rejected;
});
test('owner clearMatching never clears another cabinet',async()=>{const{c}=await harness(()=>Response.json({status:'pending'}));const person=c.auth.person();c.auth.clearMatching('other');assert.equal(c.auth.person(),person);c.auth.clearMatching(person);assert.equal(c.auth.person(),null)});
test('real host proof hook is separate from deletion submit and missing Clerk path cannot call controller',()=>{
 const source=readFileSync(new URL('../src/account-deletion-candidate/host.tsx',import.meta.url),'utf8');
 assert.match(source,/useReverification\(async/);assert.match(source,/getToken\(\{skipCache:true\}\)/);assert.match(source,/afterMinutes:4/);assert.match(source,/if\(!enabled\|\|!binding\|\|!scope\)/);assert.doesNotMatch(source,/signOut|appBearer/);assert.match(source,/href="\/account-deletion-status"/);
});

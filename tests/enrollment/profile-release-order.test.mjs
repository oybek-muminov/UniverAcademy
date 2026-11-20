// Offline release-pair check. The old source comes from this exact Git object, never from a network checkout.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import pg from 'pg';
import * as studentCurrent from '../../packages/api-client/student-client.ts';
import * as atomicCurrent from '../../packages/api-client/telegram-atomic-client.ts';
import * as miniStudent from '../../apps/mini-app/src/owner-client/student-client.ts';
import * as miniAtomic from '../../apps/mini-app/src/owner-client/telegram-atomic-client.ts';
import { createCloudflareEntrypoint } from '../../runtime/cloudflare-entry.mjs';
import { botKey,signedInitData,testPolicy } from '../backend/http-fixture.ts';
import { readProductionConfig } from '../../apps/mini-app/src/production-runtime.ts';

const previousHash='2eab3a7848b8fc439ca73e3e4d768b8706ec80f3063dbd3eeaf6d4966249918c';
const previousCommit='d62adb0f090b3e964450163d6607387c248d56bc';
const root=fileURLToPath(new URL('../../',import.meta.url));
const run=promisify(execFile);
const api='https://api.classroom.example.com/api/v1',mini='https://mini.classroom.example.com',site='https://web.classroom.example.com';
const canonical='univeracademy_id',legacy='qadam_id';
const current={student:studentCurrent,atomic:atomicCurrent,worker:createCloudflareEntrypoint};
const miniClient={student:miniStudent,atomic:miniAtomic};

async function oldRelease(t) {
  const dir=await mkdtemp(join(tmpdir(),'ua-old-profile-release-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const archive=join(dir,'sources.tar');
  await run('git',['archive','--format=tar','--output',archive,previousCommit,'runtime','supabase/functions','packages/api-client','contracts','package.json'],{cwd:root,env:{...process.env,GIT_NO_LAZY_FETCH:'1'}});
  await run('tar',['-xf',archive,'-C',dir]);
  // Both releases pin the same server driver and JOSE. Only installed dependencies are shared.
  await symlink(join(root,'node_modules'),join(dir,'node_modules'),'dir');
  const load=path=>import(pathToFileURL(join(dir,path)));
  const [student,atomic,{createCloudflareEntrypoint:worker}]=await Promise.all([
    load('packages/api-client/student-client.ts'),load('packages/api-client/telegram-atomic-client.ts'),load('runtime/cloudflare-entry.mjs')
  ]);
  assert.equal(student.STUDENT_CONTRACT_SHA256,'2eab3a7848b8fc439ca73e3e4d768b8706ec80f3063dbd3eeaf6d4966249918c');
  assert.equal(atomic.TELEGRAM_ATOMIC_CONTRACT_SHA256,'092bd6f1d2ff2aa9f16e4c79251545556a065d1ca89a6b871ed6bb23c2d78553');
  assert.notEqual(student.STUDENT_CONTRACT_SHA256,studentCurrent.STUDENT_CONTRACT_SHA256);
  return {student,atomic,worker};
}

function productionClients(version,transport,buildHash=version.student.STUDENT_CONTRACT_SHA256) {
  const options={mode:'production',baseUrl:api,transport};
  return {
    student:version.student.createProductionStudentClient({...options,contractSha256:buildHash}),
    atomic:version.atomic.createProductionTelegramAtomicClient({...options,contractSha256:version.atomic.TELEGRAM_ATOMIC_CONTRACT_SHA256})
  };
}

async function returningAccount(db,number,telegramId,issuer) {
  const person=randomUUID(),subject='user_Release'+number;
  await db.query('BEGIN');
  try {
    await db.query(`INSERT INTO ua_private.people(id,telegram_id,qadam_id,enabled,roles,profile)
      VALUES ($1,$2,$3,true,ARRAY['student'],$4)`,[person,telegramId,number,{
        person_id:person,first_name:'Ali',last_name:'Sinov',roles:['student'],registration_complete:true,
        active_group_id:null,qadam_id:number
      }]);
    await db.query('INSERT INTO ua_private.memberships(person_id,active,epoch,revision) VALUES($1,false,0,0)',[person]);
    await db.query('INSERT INTO ua_private.clerk_identities(issuer,subject,person_id,enabled) VALUES($1,$2,$3,true)',[issuer,subject,person]);
    await db.query('COMMIT');
  } catch(e) {await db.query('ROLLBACK');throw e;}
  return {subject,person,number,telegramId};
}

function exactProfile(profile,key,account) {
  assert.deepEqual(Object.keys(profile).sort(),
    ['person_id','first_name','last_name','roles','registration_complete','active_group_id',key].sort());
  assert.equal(profile.person_id,account.person);
  assert.equal(profile[key],account.number);
}

test('released and current student clients interoperate in each deployment order with the actual registration Worker and PostgreSQL',async t=>{
  // The default GitHub checkout is shallow. The offline protocol checks below also
  // run without old Git objects. Set UA_REQUIRE_PROFILE_RELEASE_HISTORY=1 on a
  // full checkout to require the actual pinned Worker/client matrix.
  try {
    await run('git',['cat-file','-e',previousCommit+'^{commit}'],{cwd:root,env:{...process.env,GIT_NO_LAZY_FETCH:'1'}});
  } catch(error) {
    if(process.env.UA_REQUIRE_PROFILE_RELEASE_HISTORY==='1') throw error;
    t.skip('Full release matrix needs local Git object '+previousCommit);return;
  }
  const [{createCluster,createServiceLogin},{testClerk,issuer}]=await Promise.all([
    import('../teacher-staging-pilot/cluster.mjs'),import('../teacher-staging-pilot/credentials.mjs')
  ]);
  const old=await oldRelease(t);
  const cluster=await createCluster({expandCabinetId:false});t.after(()=>cluster.close());
  const url=await createServiceLogin(cluster,'qa_profile_release',[{role:'ua_api_login',inherit:true,set:false}]);
  const clerk=await testClerk();
  const settings={issuer,authorizedParties:[mini,site],audience:{kind:'clerk_default_no_audience'}};
  const env={
    UA_API_ORIGIN:new URL(api).origin,UA_ALLOWED_ORIGINS:JSON.stringify([mini,site]),
    UA_SESSION_POLICY:JSON.stringify({...testPolicy,accessTtlMs:300000,familyTtlMs:600000}),
    UA_CLERK_PROVIDER_SETTINGS:JSON.stringify(settings),UA_CLERK_SECRET_KEY:'offline-provider-fixture',
    UA_TELEGRAM_BOT_TOKEN:botKey,UA_TELEGRAM_ATOMIC_ENTRY_ENABLED:'true',
    UA_TELEGRAM_ATOMIC_AUTHORIZED_PARTIES:JSON.stringify([mini]),HYPERDRIVE:{connectionString:url}
  };
  const deployedConfig=readProductionConfig({VITE_MINI_APP_ORIGIN:mini,VITE_API_ORIGIN:new URL(api).origin,VITE_STUDENT_CONTRACT_SHA256:previousHash},mini);
  const cases=[
    {label:'new Mini with previous build pin / actual old Worker',client:miniClient,buildHash:deployedConfig.contractSha256,server:old,wire:legacy,internal:canonical},
    {label:'actual old client / new Worker',client:old,server:current,wire:legacy,internal:legacy},
    {label:'new client / new Worker',client:current,server:current,wire:canonical,internal:canonical}
  ];
  for(const [i,c] of cases.entries()) await t.test(c.label,async()=>{
    const account=await returningAccount(cluster.admin,'00000007'+String(i+10),710300030+i,issuer);
    const worker=c.server.worker({
      loadClient:async()=>pg.Client,
      makeClerk:async allowed=>({verifier:{...clerk.verifier,authorizedParties:allowed.authorizedParties},liveness:clerk.liveness,close:async()=>{}}),
      transport:async()=>assert.fail('Unexpected provider call.')
    });
    const seen=[];
    async function transport(request) {
      const path=new URL(request.url).pathname.replace('/api/v1','');
      const origin=path==='/auth/telegram/entry'?mini:site;
      const headers=new Headers(request.headers);headers.set('origin',origin);
      const response=await worker.fetch(new Request(request,{headers}),env);
      const packet=await response.clone().json();
      assert.equal(response.status,200,request.method+' '+path+': '+JSON.stringify(packet));
      const profile=packet.data.profile??packet.data;
      exactProfile(profile,c.wire,account);
      if(c.wire===canonical) assert.match(response.headers.get('content-type'),/profile=univeracademy-id-v2/);
      const accept=request.headers.get('accept')??'';
      assert.equal(accept.includes('univeracademy-id-v2'),c.client!==old);
      seen.push([request.method,path]);
      return response;
    }
    const {student,atomic}=productionClients(c.client,transport,c.buildHash);
    const login=await student.exchangeClerkSession(await clerk.sign(account.subject,{azp:site}));
    exactProfile(login.data.profile,c.internal,account);
    const edit=await student.updateProfile(login.data.access_token,{first_name:'Dilnoza',last_name:'Karimova'});
    exactProfile(edit.data,c.internal,account);
    assert.equal(edit.data.first_name,'Dilnoza');
    const me=await student.me(login.data.access_token);
    exactProfile(me.data,c.internal,account);assert.equal(me.data.last_name,'Karimova');
    const refresh=await student.refresh({refresh_token:login.data.refresh_token});
    exactProfile(refresh.data.profile,c.internal,account);
    assert.notEqual(refresh.data.access_token,login.data.access_token);
    const atom=await atomic.enter(await clerk.sign(account.subject,{azp:mini,fva:[0,-1]}),{
      init_data:signedInitData(account.telegramId,randomUUID(),Date.now()),confirmation:'link-telegram-account-v1'
    });
    exactProfile(atom.data.profile,c.internal,account);
    assert.deepEqual(seen,[['POST','/auth/clerk'],['PATCH','/me'],['GET','/me'],['POST','/auth/refresh'],['POST','/auth/telegram/entry']]);
    const consumed=await cluster.admin.query('SELECT count(*)::int n FROM ua_private.init_data_replays WHERE person_id=$1',[account.person]);
    assert.equal(consumed.rows[0].n,1);
  });
});

const fixtureAccount={person:'015e385d-7019-4230-bdb6-a0aee7d0070d',number:'0000000007'};
function exampleProfile(key) {
  return {person_id:fixtureAccount.person,first_name:'Ali',last_name:'Sinov',roles:['student'],
    registration_complete:true,active_group_id:null,[key]:fixtureAccount.number};
}
function exampleSession(profile) {
  return {access_token:'fixture-opaque-one',refresh_token:'fixture-opaque-two',token_type:'Bearer',
    expires_at:'2026-11-20T13:00:00.000Z',refresh_expires_at:'2026-11-20T15:00:00.000Z',profile};
}
const operations=[
  {name:'GET /me',nested:false,run:c=>c.student.me('profile-read')},
  {name:'PATCH /me',nested:false,run:c=>c.student.updateProfile('profile-edit',{first_name:'Ali',last_name:'Sinov'})},
  {name:'Clerk exchange',nested:true,run:c=>c.student.exchangeClerkSession('header.payload.signature')},
  {name:'refresh',nested:true,run:c=>c.student.refresh({refresh_token:'new-refresh-use'})},
  {name:'atomic entry',nested:true,run:c=>c.atomic.enter('header.payload.signature',{init_data:'fixture-signed-launch',confirmation:'link-telegram-account-v1'})}
];
function singleResponse(packet,contentType) {
  let calls=0;
  return {
    clients:productionClients(current,async()=>{
      ++calls;
      return new Response(JSON.stringify(packet),{headers:{'content-type':contentType}});
    }),
    requests:()=>calls
  };
}

test('a shallow checkout can still exercise every profile-bearing endpoint on either valid release format',async()=>{
  for(const [field,type] of [[legacy,'application/json'],[canonical,'application/json'],[canonical,studentCurrent.STUDENT_PROFILE_ACCEPT]]) {
    const profile=exampleProfile(field);
    for(const op of operations) {
      const service=singleResponse({data:op.nested?exampleSession(profile):profile},type);
      const reply=await op.run(service.clients);
      exactProfile(op.nested?reply.data.profile:reply.data,canonical,fixtureAccount);
      assert.equal(service.requests(),1,op.name);
    }
  }
});

test('every profile-bearing endpoint rejects ambiguous, missing or malformed identities and fields after just one request',async()=>{
  const prior=exampleProfile(legacy);
  const missing={...prior};delete missing[legacy];
  const invalid=[
    {name:'neither ID',profile:missing},
    {name:'both IDs same',profile:{...prior,[canonical]:fixtureAccount.number}},
    {name:'both IDs differ',profile:{...prior,[canonical]:'0000000012'}},
    {name:'ID is a number',profile:{...prior,[legacy]:7}},
    {name:'null student ID',profile:{...prior,[legacy]:null}},
    {name:'trailing newline',profile:{...prior,[legacy]:fixtureAccount.number+'\n'}},
    {name:'unknown field',profile:{...prior,unlisted:true}},
    {name:'invalid role',profile:{...prior,roles:['Student']}},
    {name:'invalid person ID',profile:{...prior,person_id:'not-a-uuid'}},
    {name:'wrong completion field type',profile:{...prior,registration_complete:'true'}},
    {name:'unexpected student number for staff',profile:{...prior,roles:['teacher']}},
    {name:'declared canonical media with old field',profile:prior,type:studentCurrent.STUDENT_PROFILE_ACCEPT}
  ];
  for(const variant of invalid) {
    for(const op of operations) {
      const service=singleResponse({data:op.nested?exampleSession(variant.profile):variant.profile},variant.type??'application/json');
      await assert.rejects(()=>op.run(service.clients),{message:'CLIENT_INVALID_RESPONSE'},op.name+' / '+variant.name);
      assert.equal(service.requests(),1,op.name+' / '+variant.name);
    }
  }
  for(const op of operations.filter(op=>op.nested)) {
    for(const patch of [{token_type:'bearer'},{refresh_token:'fixture-opaque-one'},{expires_at:'invalid'},{extraSessionField:1}]) {
      const service=singleResponse({data:{...exampleSession(prior),...patch}},'application/json');
      await assert.rejects(()=>op.run(service.clients),{message:'CLIENT_INVALID_RESPONSE'},op.name);
      assert.equal(service.requests(),1);
    }
  }
});

test('the production Mini recognizes both shipped public build hashes and rejects unknown or omitted values',async()=>{
  const base={VITE_MINI_APP_ORIGIN:mini,VITE_API_ORIGIN:new URL(api).origin};
  for(const pin of [previousHash,studentCurrent.STUDENT_CONTRACT_SHA256]){
    const config=readProductionConfig({...base,VITE_STUDENT_CONTRACT_SHA256:pin},mini);
    assert.equal(config.contractSha256,studentCurrent.STUDENT_CONTRACT_SHA256);
    const profile=exampleProfile(legacy);
    const client=studentCurrent.createProductionStudentClient({mode:'production',baseUrl:config.apiBaseUrl,contractSha256:config.contractSha256,
      transport:async()=>Response.json({data:profile})});
    exactProfile((await client.me('fixture-build')).data,canonical,fixtureAccount);
  }
  for(const pin of ['unknown','f'.repeat(64),null,undefined]) {
    assert.throws(()=>readProductionConfig({...base,...(pin===undefined?{}:{VITE_STUDENT_CONTRACT_SHA256:pin})},mini),{code:'CONTRACT_HASH_MISMATCH'});
  }
});

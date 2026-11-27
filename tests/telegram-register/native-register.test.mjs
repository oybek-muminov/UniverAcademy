import {test} from 'node:test';import assert from 'node:assert/strict';
import pg from '../account-deletion/tooling/node_modules/pg/lib/index.js';
import {expand} from '../../supabase/migrations/cabinet-id/migrate.mjs';
import {TelegramClerkEntryRows} from '../../supabase/functions/univeracademy-api/storage/telegram-clerk-entry-rows.ts';
import {TelegramRegisterRows} from '../../supabase/functions/univeracademy-api/storage/telegram-register-rows.ts';
import {testPolicy,testNumbers,botKey} from '../backend/http-fixture.ts';
const url=process.env.UA_SCHEMA_NATIVE_URL;
const issuer='https://clerk.native.example',tg=4000000222;
async function signed(id=tg,query=crypto.randomUUID()){
 const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id,first_name:'Native'}),query_id:query});
 const enc=new TextEncoder(),data=[...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
 const seed=await crypto.subtle.importKey('raw',enc.encode('WebAppData'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const key=await crypto.subtle.importKey('raw',await crypto.subtle.sign('HMAC',seed,enc.encode(botKey)),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 p.set('hash',Buffer.from(await crypto.subtle.sign('HMAC',key,enc.encode(data))).toString('hex'));return p.toString();
}
const fresh=(userId,sessionId)=>{const now=Date.now();return {firstFactorVerifiedAfter:now-60000,proof:{kind:'clerk_verified',issuer,userId,sessionId,notBefore:now-1000,expiresAt:now+120000,authorizedParty:'https://mini.native.example',tokenId:crypto.randomUUID()}};};
test('quick-register checks run under the restricted API login and write nothing',{skip:!url},async()=>{
 if(!['127.0.0.1','localhost'].includes(new URL(url).hostname))throw Error('Disposable loopback database only');
 const {nativeFixture}=await import('../telegram-entry/native-fixture.mjs');const fixture=await nativeFixture({url});const admin=fixture.admin;
 try{
  await expand(admin);
  const clients=[];
  // Statement names are dropped: node-pg refuses one name with two SQL spellings ("ua_clock"), which the
  // production driver accepts. Only the HTTP reads below are affected; the SQL itself is unchanged.
  const pool={connect:async()=>{const c=new pg.Client({connectionString:url});await c.connect();await c.query('SET SESSION AUTHORIZATION ua_api_login');clients.push(c);return {query:(a,v)=>typeof a==='object'&&a?c.query({text:a.text,values:a.values}):c.query(a,v),release:()=>{void c.end();}};}};
  const rows=new TelegramRegisterRows({pool,issuer});
  const count=async()=>Number((await admin.query('SELECT (SELECT count(*) FROM ua_private.people)+(SELECT count(*) FROM ua_private.clerk_identities)+(SELECT count(*) FROM ua_private.init_data_replays) n')).rows[0].n);
  const before=await count();
  assert.equal(await rows.telegramLinked(tg),false);
  assert.equal(await rows.clerkMapped('user_Fresh'),false);
  assert.equal(await count(),before,'checks must not write');
  // The real atomic entry then creates the cabinet for the same Telegram + Clerk user.
  const deps={mode:'local_candidate',sessionPolicy:testPolicy,numericPresentation:testNumbers,verifier:{issuer,now:Date.now},
   liveness:async who=>({...who,status:'active',accountEnabled:true,expiresAt:Date.now()+3600000,firstName:'Aziz',lastName:'Karimov'})};
  const session=await new TelegramClerkEntryRows({pool,botToken:botKey,deps}).enter(fresh('user_Fresh','sess_Fresh'),await signed());
  // Live failure 2026-11-27: entry 200, then GET /me 401 CLERK_SESSION_REVOKED after one Clerk check,
  // because the database clock ran a few ms ahead of the API clock. The cabinet must open regardless.
  {const {createConfiguredHttpHandler}=await import('../../supabase/functions/univeracademy-api/configured-http.ts');
   let calls=0;const live=async(...a)=>{calls++;await new Promise(r=>setTimeout(r,50));return deps.liveness(...a);};
   for(const skew of [0,-5,-50,-500,40]){
    const verifier={issuer,authorizedParties:['https://mini.native.example'],audience:{kind:'clerk_default_no_audience'},trustedKeys:()=>{throw Error('no signature path');},now:()=>Date.now()+skew};
    const h=createConfiguredHttpHandler({mode:'production',storage:{kind:'postgres',pool},sessionPolicy:testPolicy,numericPresentation:testNumbers,now:Date.now,clerk:{verifier,liveness:live}});
    const auth={authorization:'Bearer '+session.access_token,accept:'application/json'};
    const me=await h(new Request('https://api.native.example/api/v1/me',{headers:auth}));
    assert.equal(me.status,200,`GET /me with API clock ${skew}ms: `+await me.clone().text());
    const exams=await h(new Request('https://api.native.example/api/v1/exams',{headers:auth}));
    assert.equal(exams.status,200,`GET /exams with API clock ${skew}ms: `+await exams.clone().text());
   }
   assert.ok(calls>=10,'every cabinet read still checks the Clerk session');}
  assert.equal(session.profile.first_name,'Aziz');assert.equal(session.profile.last_name,'Karimov');
  assert.equal(await rows.telegramLinked(tg),true,'second tap now sees an existing cabinet');
  assert.equal(await rows.clerkMapped('user_Fresh'),true);
  assert.equal(await rows.telegramLinked(tg+1),false);
  const after=await count();assert.equal(await rows.clerkMapped('user_Other'),false);assert.equal(await count(),after);
 }finally{await fixture.close();}
});

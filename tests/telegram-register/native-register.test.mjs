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
  const pool={connect:async()=>{const c=new pg.Client({connectionString:url});await c.connect();await c.query('SET SESSION AUTHORIZATION ua_api_login');clients.push(c);return {query:a=>c.query(a),release:()=>{void c.end();}};}};
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
  assert.equal(session.profile.first_name,'Aziz');assert.equal(session.profile.last_name,'Karimov');
  assert.equal(await rows.telegramLinked(tg),true,'second tap now sees an existing cabinet');
  assert.equal(await rows.clerkMapped('user_Fresh'),true);
  assert.equal(await rows.telegramLinked(tg+1),false);
  const after=await count();assert.equal(await rows.clerkMapped('user_Other'),false);assert.equal(await count(),after);
 }finally{await fixture.close();}
});

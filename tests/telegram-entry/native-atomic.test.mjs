import {test} from 'node:test';import assert from 'node:assert/strict';
import pg from '../account-deletion/tooling/node_modules/pg/lib/index.js';
import {TelegramClerkEntryRows} from '../../supabase/functions/univeracademy-api/storage/telegram-clerk-entry-rows.ts';
import {testPolicy,testNumbers,botKey} from '../backend/http-fixture.ts';
import {proofHash} from '../../supabase/functions/univeracademy-api/student-state.ts';
const url=process.env.UA_SCHEMA_NATIVE_URL;
const issuer='https://clerk.native.example',tg=4000000111;
async function signed(id=tg,query=crypto.randomUUID()){
 const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id,first_name:'Native'}),query_id:query});
 const enc=new TextEncoder(),data=[...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
 const seed=await crypto.subtle.importKey('raw',enc.encode('WebAppData'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const key=await crypto.subtle.importKey('raw',await crypto.subtle.sign('HMAC',seed,enc.encode(botKey)),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 p.set('hash',Buffer.from(await crypto.subtle.sign('HMAC',key,enc.encode(data))).toString('hex'));return p.toString();
}
const fresh=(userId='user_Native',sessionId='sess_Native')=>{const now=Date.now();return {firstFactorVerifiedAfter:now-60000,proof:{kind:'clerk_verified',issuer,userId,sessionId,notBefore:now-1000,expiresAt:now+120000,authorizedParty:'https://mini.native.example',tokenId:crypto.randomUUID()}};};
test('native atomic Telegram entry with actual catalog RLS/helpers',{skip:!url},async t=>{
 if(!['127.0.0.1','localhost'].includes(new URL(url).hostname))throw Error('Disposable loopback database only');
 const {nativeFixture}=await import('./native-fixture.mjs');const fixture=await nativeFixture({url});const admin=fixture.admin;t.after(()=>fixture.close());
 const connections=[];
 const pool={connect:async()=>{
  const c=new pg.Client({connectionString:url,application_name:'ua-atomic-runtime'});await c.connect();
  await c.query('SET SESSION AUTHORIZATION ua_api_login');connections.push(c);
  return {query:arg=>c.query(arg),release:()=>{void c.end();}};
 }};
 const deps={mode:'local_candidate',sessionPolicy:testPolicy,numericPresentation:testNumbers,verifier:{issuer,now:Date.now},
  liveness:async who=>({...who,status:'active',accountEnabled:true,expiresAt:Date.now()+3600000,firstName:'Native',lastName:'Student'})};
 const entry=new TelegramClerkEntryRows({pool,botToken:botKey,deps});
 const count=async table=>Number((await admin.query('SELECT count(*) n FROM ua_private.'+table)).rows[0].n);
 const graph=async()=>{const r={};for(const table of ['people','memberships','clerk_identities','student_families','clerk_family_bindings','clerk_student_sessions','student_access','student_refresh','clerk_exchange_replays','init_data_replays'])r[table]=await count(table);return r;};
 let first,raw,deleteJob;
 await t.test('successful provisioning link and both replay records commit under restricted login',async()=>{
  raw=await signed();first=await entry.enter(fresh(),raw);assert.equal(first.token_type,'Bearer');
  const p=(await admin.query('SELECT telegram_id FROM ua_private.people WHERE id=$1',[first.profile.person_id])).rows[0];assert.equal(Number(p.telegram_id),tg);
  assert.deepEqual(await graph(),{people:1,memberships:1,clerk_identities:1,student_families:1,clerk_family_bindings:1,clerk_student_sessions:1,student_access:1,student_refresh:1,clerk_exchange_replays:1,init_data_replays:1});
 });
 await t.test('other cached Clerk cannot claim existing Telegram or create partial profile',async()=>{
  const before=await graph();await assert.rejects(entry.enter(fresh('user_Other','sess_Other'),await signed()),e=>e.code==='IDENTITY_LINK_CONFLICT');assert.deepEqual(await graph(),before);
 });
 await t.test('new Telegram cannot silently use profile linked to original Telegram',async()=>{
  const before=await graph();await assert.rejects(entry.enter(fresh(),await signed(tg+1)),e=>e.code==='IDENTITY_LINK_CONFLICT');assert.deepEqual(await graph(),before);
 });
 await t.test('replayed Telegram rolls back rotated session and newly consumed Clerk token',async()=>{
  const before=await graph();await assert.rejects(entry.enter(fresh(),raw),e=>e.code==='INIT_DATA_REPLAY');assert.deepEqual(await graph(),before);
  assert.equal(Number((await admin.query('SELECT count(*) n FROM ua_private.student_families WHERE revoked_at_ms IS NULL')).rows[0].n),1);
 });
 await t.test('runtime cannot directly update Telegram column or bypass RLS',async()=>{
  const c=await pool.connect();try{await assert.rejects(c.query({text:'UPDATE ua_private.people SET telegram_id=$1 WHERE id=$2',values:[tg+2,first.profile.person_id]}),e=>e.code==='42501');}finally{c.release();}
 });
 await t.test('deletion freeze holds identity lock and concurrent entry denies after commit',async()=>{
  await fixture.installDeletion();
  await admin.query('UPDATE ua_private.account_deletion_control SET accepting=true');
  const job=crypto.randomUUID(),receipt='b'.repeat(64),access=await proofHash(first.access_token);deleteJob=job;
  await admin.query('BEGIN');
  await admin.query('SELECT * FROM ua_private.prepare_account_deletion($1,$2,$3,$4,$5,$6,$7,$8)',[job,first.profile.person_id,access,issuer,'user_Native','sess_Native',receipt,Date.now()]);
  const competing=entry.enter(fresh(),await signed()).then(()=>({ok:true}),e=>({error:e}));
  let waited=false;try{for(let n=0;n<100;n++){await admin.query('SELECT pg_stat_clear_snapshot()');const r=await admin.query("SELECT count(*) n FROM pg_stat_activity WHERE application_name='ua-atomic-runtime' AND wait_event_type='Lock'");if(Number(r.rows[0].n)>0){waited=true;break;}await new Promise(r=>setTimeout(r,20));}}finally{await admin.query('COMMIT');}
  assert.equal(waited,true);const denied=await competing;assert.equal(denied.error?.code,'CLERK_IDENTITY_REVOKED');
  assert.equal(await count('people'),1);assert.equal(await count('init_data_replays'),1);
 });
 await t.test('finished deletion blocks old Clerk resurrection and permits fresh Clerk same Telegram',async()=>{
  const lease=crypto.randomUUID();
  await admin.query('SELECT * FROM ua_private.claim_account_deletion($1,$2)',[deleteJob,lease]);
  assert.equal((await admin.query('SELECT ua_private.mark_account_provider_deleted($1,$2) ok',[deleteJob,lease])).rows[0].ok,true);
  assert.equal((await admin.query('SELECT ua_private.finish_account_deletion($1,$2) ok',[deleteJob,lease])).rows[0].ok,true);
  assert.equal(await count('people'),0);
  await assert.rejects(entry.enter(fresh(),await signed()),e=>e.code==='42501'&&/DELETED_CLERK_SUBJECT/.test(e.message));
  assert.equal(await count('people'),0);assert.equal(await count('student_families'),0);
  await assert.rejects(entry.enter(fresh('user_NewAfterDelete','sess_NewAfterDelete'),raw),e=>e.code==='42501'&&/DELETED_PROOF_REPLAY/.test(e.message));
  assert.equal(await count('people'),0);assert.equal(await count('student_families'),0);
  const created=await entry.enter(fresh('user_NewAfterDelete','sess_NewAfterDelete'),await signed());
  assert.notEqual(created.profile.person_id,first.profile.person_id);assert.equal(await count('people'),1);
  const p=(await admin.query('SELECT telegram_id FROM ua_private.people WHERE id=$1',[created.profile.person_id])).rows[0];assert.equal(Number(p.telegram_id),tg);
 });
 await t.test('concurrent different Clerk claims for one new Telegram yield exactly one owner',async()=>{
  const before=await graph(),rawA=await signed(tg+10),rawB=await signed(tg+10);
  const results=await Promise.allSettled([entry.enter(fresh('user_ConcurrentA','sess_ConcurrentA'),rawA),entry.enter(fresh('user_ConcurrentB','sess_ConcurrentB'),rawB)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected'&&x.reason.code==='IDENTITY_LINK_CONFLICT').length,1);
  const after=await graph();for(const key of Object.keys(before))assert.equal(after[key],before[key]+1,key);
 });

});

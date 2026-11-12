import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTelegramStartLookup,telegramStartInput,telegramRequestBody,verifyTelegramLaunch,checkTelegramLaunch} from '../../../supabase/functions/univeracademy-api/telegram-return.ts';
import {proofHash} from '../../../supabase/functions/univeracademy-api/student-state.ts';
import {clock,testPolicy,botKey} from '../http-fixture.ts';
const encoded=new TextEncoder(),id=4000000101;
async function signed({user=id,at=Math.floor(clock/1000),key=botKey,extra='synthetic'}={}){
 const fields=new URLSearchParams({auth_date:String(at),query_id:extra,user:JSON.stringify({id:user,first_name:'Ignored',last_name:'NotProfile'})});
 const data=[...fields].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>k+'='+v).join('\n');
 const seed=await crypto.subtle.importKey('raw',encoded.encode('WebAppData'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const secret=await crypto.subtle.sign('HMAC',seed,encoded.encode(key));const mac=await crypto.subtle.importKey('raw',secret,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const hash=Buffer.from(await crypto.subtle.sign('HMAC',mac,encoded.encode(data))).toString('hex');fields.set('hash',hash);return fields.toString();
}
for(const state of ['linked','needs_clerk','disabled'])test('private lookup returns only '+state+' and does not change input',async()=>{
 const calls=[],source=Object.freeze({update_id:0,telegram_user_id:id}),lookup=createTelegramStartLookup(async value=>{calls.push(value);return state;});
 assert.equal(await lookup.lookupTelegramStart(source),state);assert.deepEqual(calls,[id]);assert.deepEqual(source,{update_id:0,telegram_user_id:id});
});
for(const bad of [null,[],{},Object.create({update_id:1,telegram_user_id:id}),{update_id:-1,telegram_user_id:id},{update_id:1.5,telegram_user_id:id},{update_id:'1',telegram_user_id:id},{update_id:1,telegram_user_id:0},{update_id:1,telegram_user_id:Number.MAX_SAFE_INTEGER+1},{update_id:Infinity,telegram_user_id:id},{update_id:1,telegram_user_id:id,person_id:'forged'}])test('invalid private lookup input denies before reading '+JSON.stringify(bad),async()=>{
 let reads=0;await assert.rejects(createTelegramStartLookup(async()=>{reads++;return 'needs_clerk';}).lookupTelegramStart(bad),e=>e.status===422);assert.equal(reads,0);
});
test('lookup rejects accessors without reading them or leaking fallback',async()=>{
 let gets=0,reads=0;const input={update_id:1,get telegram_user_id(){gets++;throw Error('private getter');}};
 await assert.rejects(createTelegramStartLookup(async()=>{reads++;return 'linked';}).lookupTelegramStart(input),e=>e.status===422);assert.equal(gets,0);assert.equal(reads,0);
});
for(const value of [undefined,null,true,'unknown',{state:'linked'},{state:'linked',token:'forbidden'},['disabled']])test('malformed reader result fails closed '+JSON.stringify(value),async()=>{
 await assert.rejects(createTelegramStartLookup(async()=>value).lookupTelegramStart({update_id:1,telegram_user_id:id}),e=>e.status===503&&!e.message.includes('token'));
});
test('reader failure never becomes needs_clerk and hides its cause',async()=>{
 await assert.rejects(createTelegramStartLookup(async()=>{throw Error('private DB connection detail');}).lookupTelegramStart({update_id:1,telegram_user_id:id}),e=>e.code==='SERVICE_UNAVAILABLE'&&!e.message.includes('private'));
});
test('signed launch reuses exact HMAC verifier and double hash replay identity, discarding names',async()=>{
 const raw=await signed(),v=await verifyTelegramLaunch(raw,botKey,testPolicy,clock);assert.equal(v.telegramUserId,id);assert.ok(Object.isFrozen(v));assert.deepEqual(Object.keys(v).sort(),['authDate','replayDigest','telegramUserId']);
 assert.equal(v.replayDigest,await proofHash(new URLSearchParams(raw).get('hash')));checkTelegramLaunch(v,clock,testPolicy);
 assert.throws(()=>checkTelegramLaunch({...v},clock,testPolicy),e=>e.code==='INIT_DATA_INVALID');
});
test('bad signature, stale/future data and forged Telegram IDs never become authority',async()=>{
 for(const raw of [await signed({key:'wrong'}),await signed({at:Math.floor(clock/1000)-testPolicy.initDataMaxAgeSeconds-1}),await signed({at:Math.floor(clock/1000)+testPolicy.futureSkewSeconds+1}),(await signed()).replace(String(id),'4000000999')])await assert.rejects(verifyTelegramLaunch(raw,botKey,testPolicy,clock),e=>e.status===401);
});
test('final freshness uses original configured second boundary, no invented TTL',async()=>{
 const v=await verifyTelegramLaunch(await signed(),botKey,testPolicy,clock);const last=(v.authDate+testPolicy.initDataMaxAgeSeconds+1)*1000-1;
 checkTelegramLaunch(v,last,testPolicy);assert.throws(()=>checkTelegramLaunch(v,last+1,testPolicy),e=>e.code==='INIT_DATA_EXPIRED');
});
for(const body of [{},null,[],{init_data:''},{init_data:'raw',person_id:'forged'},{telegram_user_id:id},{init_data:12}])test('strict link/resume body rejects client identity/profile '+JSON.stringify(body),async()=>{
 const request=new Request('https://api.invalid/api/v1/auth/telegram/link',{method:'POST',body:JSON.stringify(body)});await assert.rejects(telegramRequestBody(request),e=>e.status===422);
});
test('strict body retains raw signed bytes exactly',async()=>{
 const raw=await signed();assert.equal(await telegramRequestBody(new Request('https://api.invalid/api/v1/auth/telegram/resume',{method:'POST',body:JSON.stringify({init_data:raw})})),raw);
});
test('inactive SQL keeps lookup bounded, disabled visible and null-only linking with closed authority',async()=>{
 const {readFile}=await import('node:fs/promises');const sql=await readFile(new URL('../../../supabase/proposals/telegram-identity-permissions.review.sql',import.meta.url),'utf8');
 assert.match(sql,/^-- INACTIVE REVIEW DERIVATIVE ONLY/);assert.match(sql,/\nBEGIN;/);assert.match(sql,/\nROLLBACK;\s*$/);assert.doesNotMatch(sql,/\nCOMMIT;/);
 for(const name of ['lookup_telegram_start','locate_telegram_return','link_telegram_identity'])assert.ok(sql.includes('CREATE FUNCTION ua_private.'+name));
 assert.match(sql,/LEFT JOIN ua_private.clerk_identities i ON i.person_id=p.id AND i.issuer=p_issuer/);assert.match(sql,/ORDER BY p.id,i.subject LIMIT 2/);
 assert.doesNotMatch(sql,/CREATE ROLE|ALTER ROLE|CREATE TABLE/);assert.match(sql,/GRANT UPDATE\(telegram_id\) ON ua_private.people TO ua_clerk_lock_owner/);
 assert.doesNotMatch(sql,/GRANT UPDATE[^;]*TO ua_runtime/);assert.match(sql,/UPDATE ua_private.people SET telegram_id=p_telegram_id WHERE id=p_person_id AND telegram_id IS NULL/);
 assert.match(sql,/EXCEPTION WHEN unique_violation THEN/);assert.match(sql,/REVOKE ALL ON FUNCTION [^;]+ FROM PUBLIC,anon,authenticated,service_role,ua_owner/);
 assert.match(sql,/GRANT INSERT\(digest,person_id,consumed_at_ms\) ON ua_private.init_data_replays TO ua_runtime/);
 assert.match(sql,/i.person_id=init_data_replays.person_id AND i.enabled/);assert.doesNotMatch(sql,/i.person_id=person_id AND i.enabled/);
 assert.match(sql,/REVOKE CREATE ON SCHEMA ua_private FROM ua_access_locator_owner,ua_clerk_lock_owner/);
 assert.match(sql,/REVOKE ua_access_locator_owner,ua_clerk_lock_owner FROM CURRENT_USER GRANTED BY CURRENT_USER/);
 assert.match(sql,/admin_option AND NOT inherit_option AND NOT set_option/);assert.match(sql,/UNEXPECTED_TELEGRAM_HELPER_EXECUTE/);
 for(const body of sql.split('AS $fn$').slice(1).map(x=>x.split('END $fn$;')[0]))assert.doesNotMatch(body,/set_config|SET LOCAL|COMMIT;|ROLLBACK;/);
});

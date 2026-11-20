import {test} from 'node:test';import assert from 'node:assert/strict';
import {Pool,id,at,proof,who} from './statement-fixture.mjs';
import {TelegramClerkEntryRows} from '../../supabase/functions/univeracademy-api/storage/telegram-clerk-entry-rows.ts';
import {testPolicy,testNumbers,botKey} from '../backend/http-fixture.ts';
async function signed(telegramId=10001,query=crypto.randomUUID()){
 const p=new URLSearchParams({auth_date:String(at/1000),user:JSON.stringify({id:telegramId,first_name:"Synthetic"}),query_id:query});
 const enc=new TextEncoder(),data=[...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
 const seed=await crypto.subtle.importKey('raw',enc.encode('WebAppData'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const key=await crypto.subtle.importKey('raw',await crypto.subtle.sign('HMAC',seed,enc.encode(botKey)),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 p.set('hash',Buffer.from(await crypto.subtle.sign('HMAC',key,enc.encode(data))).toString('hex'));return p.toString();
}
function fixture(workerNow){
 const pool=new Pool();let count=0,failLive=false;
 const deps={mode:'local_candidate',sessionPolicy:testPolicy,numericPresentation:testNumbers,verifier:{issuer:who.issuer,now:workerNow??(()=>pool.time)},
  liveness:async identity=>{if(failLive)throw Error('provider down');return {...identity,status:'active',accountEnabled:true,expiresAt:at+60000,firstName:'First',lastName:'Last'};}};
 const entry=new TelegramClerkEntryRows({pool,botToken:botKey,deps,newPersonId:()=>id(++count)});
 const fresh=(p=proof())=>({proof:p,firstFactorVerifiedAfter:at-60000});
 return {pool,entry,fresh,setFailLive:()=>{failLive=true;}};
}
test('new Telegram+Clerk creates one profile, link, family and replays in same commit',async()=>{
 const f=fixture(),result=await f.entry.enter(f.fresh(),await signed());
 assert.equal(result.profile.person_id,id(1));assert.equal(f.pool.state.people[id(1)].telegramId,10001);
 assert.equal(Object.keys(f.pool.state.families).length,1);assert.equal(Object.keys(f.pool.state.replays).length,1);assert.equal(Object.keys(f.pool.state.telegramReplays).length,1);
 assert.equal(f.pool.events.at(-2).name,'ua_clerk_commit');assert.equal(f.pool.state.history.foreign,'unchanged synthetic history');
});
test('atomic entry tolerates independent database and Worker clocks inside both signed validity windows',async()=>{
 for(const offset of [-100,-1,0,1,100]){
  const f=fixture(()=>at+500+offset);f.pool.time=at+500;
  const result=await f.entry.enter(f.fresh(),await signed());
  assert.equal(result.profile.person_id,id(1));
  assert.equal(f.pool.events.filter(e=>e.name==='ua_clerk_commit').length,1);
 }
});
for(const source of ['database','worker'])test('atomic entry rolls back if the '+source+' clock regresses before commit',async()=>{
 let worker=at+500;
 const f=fixture(()=>worker),before=structuredClone(f.pool.state);f.pool.time=worker;
 f.pool.hook=(name,p)=>{if(name==='ua_clerk_clock'&&p.events.some(e=>e.name==='ua_atomic_replay')){
  if(source==='database')p.time=at+499;else worker=at+499;
 }};
 await assert.rejects(f.entry.enter(f.fresh(),await signed()),e=>e.status===503&&e.outcome==='not_committed');
 assert.deepEqual(f.pool.state,before);assert.equal(f.pool.events.filter(e=>e.name==='ua_clerk_rollback').length,1);
});
test('atomic entry requires the Clerk proof to be valid on both clocks',async()=>{
 for(const [worker,db] of [[at+499,at+500],[at+500,at+499],[at+500,at+501],[at+501,at+500]]){
  const f=fixture(()=>worker),before=structuredClone(f.pool.state);f.pool.time=db;
  const verified=f.fresh({...proof(),notBefore:at+500,expiresAt:at+501});
  await assert.rejects(f.entry.enter(verified,await signed()),e=>e.code==='CLERK_TOKEN_INVALID');
  assert.deepEqual(f.pool.state,before);
 }
});
test('new Telegram cannot silently reuse Clerk profile already linked to another Telegram',async()=>{
 const f=fixture();await f.entry.enter(f.fresh(),await signed());const before=structuredClone(f.pool.state);
 await assert.rejects(f.entry.enter(f.fresh(),await signed(20002)),e=>e.code==='IDENTITY_LINK_CONFLICT');assert.deepEqual(f.pool.state,before);
});
test('existing Telegram with other cached Clerk fails before new profile or family',async()=>{
 const f=fixture();await f.entry.enter(f.fresh(),await signed());const before=structuredClone(f.pool.state),calls=f.pool.events.length;
 await assert.rejects(f.entry.enter(f.fresh(proof({...who,userId:'user_Foreign',sessionId:'sess_Foreign'})),await signed()),e=>e.code==='IDENTITY_LINK_CONFLICT');
 assert.deepEqual(f.pool.state,before);assert.ok(!f.pool.events.slice(calls).some(e=>e.name==='ua_clerk_person_insert'));
});
test('exact linked pair new fresh launch returns same profile',async()=>{
 const f=fixture();await f.entry.enter(f.fresh(),await signed());const r=await f.entry.enter(f.fresh(),await signed());assert.equal(r.profile.person_id,id(1));assert.equal(Object.keys(f.pool.state.people).length,1);
});
for(const stage of ['ua_clerk_person_insert','ua_clerk_access_write','ua_atomic_link','ua_atomic_replay','ua_clerk_commit'])test('failure '+stage+' rolls back all uncommitted graph',async()=>{
 const f=fixture(),before=structuredClone(f.pool.state);f.pool.fail=stage;
 await assert.rejects(f.entry.enter(f.fresh(),await signed()));assert.deepEqual(f.pool.state,before);
});
test('lost commit acknowledgment does not return token but committed graph remains for recovery',async()=>{
 const f=fixture();f.pool.fail='commit_after';await assert.rejects(f.entry.enter(f.fresh(),await signed()),e=>e.outcome==='commit_unknown'||e.code==='SERVICE_UNAVAILABLE');assert.equal(f.pool.state.people[id(1)].telegramId,10001);
});
test('Telegram replay cannot rotate session or mutate existing pair',async()=>{
 const f=fixture(),raw=await signed();await f.entry.enter(f.fresh(),raw);const before=structuredClone(f.pool.state);
 await assert.rejects(f.entry.enter(f.fresh(),raw),e=>e.code==='INIT_DATA_REPLAY');assert.deepEqual(f.pool.state,before);
});
test('expired reverify and bad Telegram proof deny before DB checkout',async()=>{
 const f=fixture();await assert.rejects(f.entry.enter({...f.fresh(),firstFactorVerifiedAfter:at-300000},await signed()),e=>e.code==='REVERIFICATION_REQUIRED');
 await assert.rejects(f.entry.enter(f.fresh(),'forged'),e=>e.status===401);assert.equal(f.pool.events.length,0);
});
test('provider failure does not provision or link',async()=>{
 const f=fixture(),before=structuredClone(f.pool.state);f.setFailLive();await assert.rejects(f.entry.enter(f.fresh(),await signed()));assert.deepEqual(f.pool.state,before);
});

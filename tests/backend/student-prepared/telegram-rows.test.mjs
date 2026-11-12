import {test} from 'node:test';
import {TelegramReturnRows} from '../../../supabase/functions/univeracademy-api/storage/telegram-return-rows.ts';
import {botKey} from '../http-fixture.ts';
import assert from 'node:assert/strict';
import {createConfiguredHttpHandler} from '../../../supabase/functions/univeracademy-api/configured-http.ts';
import {ClerkDomainTransactions} from '../../../supabase/functions/univeracademy-api/storage/clerk-domain.ts';
import {ClerkScopedAuthStore} from '../../../supabase/functions/univeracademy-api/storage/clerk-auth-rows.ts';
import {proofHash} from '../../../supabase/functions/univeracademy-api/student-state.ts';
import {clock,ids,testPolicy,testNumbers,initialState} from '../http-fixture.ts';

const who={issuer:'https://clerk.profile.invalid',userId:'user_ProfileA',sessionId:'sess_ProfileA'};
const other='00000000-0000-4000-8000-000000000099';
const key=id=>JSON.stringify([id.issuer,id.userId]);
const fence=id=>JSON.stringify([id.issuer,id.userId,id.sessionId]);
const reset="SELECT set_config('ua.phase',$1,true),set_config('ua.person_id',$2,true),set_config('ua.person_ids',$3,true),set_config('ua.clerk_issuer',$4,true),set_config('ua.clerk_subject',$5,true),set_config('ua.telegram_id',$6,true)";
const privateRead=e=>['ua_http_grants','ua_http_assignments','ua_http_series','ua_http_attempt_ids','ua_answers_load'].includes(e.name);

// Exact statement/control-flow double only. No SQL parser, RLS evaluator, DB,
// JWT bypass, network or credential; server-authority inputs below are synthetic.
class Pool{
  data={people:{},members:{},identities:{},families:{},bindings:{},fences:{},access:{},refresh:{},replays:{}};
  now=clock;events=[];local={phase:'domain',person_id:other};draft;active=false;client;checkouts=0;
  fail;commitFailure;hook;locatorPerson;
  async connect(){
    assert.equal(this.active,false);this.active=true;this.checkouts++;
    return this.client??= {query:q=>this.query(q),release:discard=>{
      assert.equal(this.active,true);this.active=false;this.events.push({name:'release',discard:!!discard});
      if(discard){this.client=undefined;this.draft=undefined;this.local={};}
    }};
  }
  async query(q){
    const {name,text,values:v}=q;this.events.push({name,text,values:structuredClone(v),phase:this.local.phase,context:structuredClone(this.local)});
    await this.hook?.(name,this);if(this.fail===name)throw Error('synthetic statement failure');
    const rows=value=>({rows:structuredClone(value),rowCount:value.length}),ack=()=>rows([{}]);
    if(['ua_begin','ua_clerk_begin','ua_locator_begin'].includes(name)){assert.equal(text,'BEGIN');this.draft=structuredClone(this.data);return rows([]);}
    if(['ua_commit','ua_clerk_commit'].includes(name)){
      assert.equal(text,'COMMIT');if(this.commitFailure==='before')throw Error('synthetic commit uncertainty');
      this.data=this.draft;this.draft=undefined;this.local={};
      if(this.commitFailure==='after')throw Error('synthetic commit uncertainty');return rows([]);
    }
    if(['ua_rollback','ua_clerk_rollback','ua_locator_rollback'].includes(name)){assert.equal(text,'ROLLBACK');this.draft=undefined;this.local={};return rows([]);}
    assert.ok(this.draft,'SQL requires BEGIN');const d=this.draft;
    if(name==='ua_context_reset'){
      assert.equal(text,reset);assert.deepEqual(v,['deny','','[]','','','']);
      this.local=Object.fromEntries(['phase','person_id','person_ids','clerk_issuer','clerk_subject','telegram_id'].map((k,i)=>[k,v[i]]));return rows([]);
    }
    if(name==='ua_context_phase'){
      assert.equal(text,"SELECT set_config('ua.phase',$1,true)");assert.equal(v.length,1);
      if(v[0]==='domain')assert.equal(this.local.phase,'auth');this.local.phase=v[0];return rows([]);
    }
    if(name==='ua_people_context'){
      assert.equal(text,"SELECT set_config('ua.person_id',$1,true),set_config('ua.person_ids',$2,true)");
      assert.equal(this.local.phase,'auth');[this.local.person_id,this.local.person_ids]=v;return rows([]);
    }
    if(name==='ua_clerk_person_context'){this.local.person_id=v[0];return rows([]);}
    if(name==='ua_clerk_identity_context'){
      assert.equal(text,"SELECT set_config('ua.clerk_issuer',$1,true),set_config('ua.clerk_subject',$2,true)");
      assert.equal(this.local.phase,'auth');[this.local.clerk_issuer,this.local.clerk_subject]=v;return rows([]);
    }
    if(['ua_clock','ua_clerk_clock'].includes(name)){
      assert.ok(['SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms','SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms'].includes(text));
      return rows([{now_ms:String(this.now)}]);
    }
    if(name==='ua_locate_access'){
      assert.equal(text,'SELECT person_id::text FROM ua_private.locate_student_access($1::text)');assert.equal(this.local.phase,'auth');
      const a=d.access[v[0]],f=a&&d.families[a.familyId];return rows(f?[{person_id:this.locatorPerson??f.personId}]:[]);
    }
    if(name==='ua_locate_refresh'){
      assert.equal(text,'SELECT person_id::text FROM ua_private.locate_student_refresh($1::text)');
      const refresh=d.refresh[v[0]],family=refresh&&d.families[refresh.familyId];return rows(family?[{person_id:family.personId}]:[]);
    }
    if(name==='ua_clerk_session_family'){
      const table=text.includes('ua_private.student_access')?'student_access':'student_refresh';
      assert.equal(text,`SELECT p.family_id::text FROM ua_private.${table} p JOIN ua_private.student_families f ON f.id=p.family_id WHERE p.digest=$1 AND f.person_id=$2`);
      assert.equal(this.local.phase,'auth');assert.equal(this.local.person_id,v[1]);
      const p=(table==='student_access'?d.access:d.refresh)[v[0]],f=p&&d.families[p.familyId];
      return rows(f?.personId===v[1]?[{family_id:p.familyId}]:[]);
    }
    if(name==='ua_people_lock'||name==='ua_clerk_person_lock'){
      assert.equal(text,name==='ua_people_lock'?'SELECT id::text AS id FROM ua_private.lock_people($1::uuid[]) ORDER BY id':'SELECT id::text FROM ua_private.lock_people($1::uuid[]) ORDER BY id');
      assert.equal(this.local.phase,'auth');assert.deepEqual(JSON.parse(this.local.person_ids),v[0]);return rows(v[0].filter(id=>d.people[id]).map(id=>({id})));
    }
    if(name==='ua_clerk_identity_gate'){assert.equal(text,'SELECT pg_advisory_xact_lock(1430348620,hashtext($1))');return rows([]);}
    if(name==='ua_clerk_locate'){
      assert.equal(text,'SELECT person_id::text,enabled FROM ua_private.lock_clerk_identity($1::text,$2::text)');
      const i=d.identities[JSON.stringify(v)];return rows(i?[{person_id:i.personId,enabled:i.enabled}]:[]);
    }
    const own=map=>Object.entries(map).filter(([,a])=>a.personId===v[0]);
    if(name==='ua_clerk_person'||name==='ua_http_person'){
      const p=d.people[v[0]];return rows(p?[{telegram_id:p.telegramId===null?null:String(p.telegramId),enabled:p.enabled,roles:p.profile.roles,profile:p.profile}]:[]);
    }
    if(name==='ua_clerk_membership'){const m=d.members[v[0]];return rows(m?[{active:m.active,epoch:String(m.epoch),revision:String(m.revision),affinity_group_id:m.affinityGroupId}]:[]);}
    if(name==='ua_clerk_identities')return rows(own(d.identities).map(([k,a])=>{const [issuer,subject]=JSON.parse(k);return {issuer,subject,person_id:a.personId,enabled:a.enabled};}));
    if(name==='ua_clerk_families'||name==='ua_http_families')return rows(own(d.families).filter(([id])=>!v[1]||id===v[1]).map(([id,f])=>({id,person_id:f.personId,expires_at_ms:String(f.expiresAt),revoked_at_ms:f.revokedAt===null?null:String(f.revokedAt),logout_retain_until_ms:f.logoutRetainUntil===null?null:String(f.logoutRetainUntil),auth_provider:f.authProvider??null})));
    if(name==='ua_clerk_bindings')return rows(Object.entries(d.bindings).filter(([id])=>d.families[id]?.personId===v[0]&&(!v[1]||id===v[1])).map(([family_id,b])=>({family_id,person_id:b.personId,issuer:b.issuer,subject:b.userId,sid:b.sessionId})));
    if(name==='ua_clerk_fences')return rows(own(d.fences).map(([k,a])=>{const [issuer,subject,sid]=JSON.parse(k);return {issuer,subject,sid,person_id:a.personId,retired_at_ms:a.retiredAt===null?null:String(a.retiredAt)};}));
    if(name==='ua_clerk_replays')return rows(own(d.replays).map(([digest,a])=>({digest,person_id:a.personId})));
    if(name==='ua_clerk_access'||name==='ua_http_access')return rows(Object.entries(d.access).filter(([,a])=>d.families[a.familyId]?.personId===v[0]&&(!v[1]||a.familyId===v[1])).map(([digest,a])=>({digest,family_id:a.familyId,expires_at_ms:String(a.expiresAt),superseded:a.superseded})));
    if(name==='ua_clerk_refresh'||name==='ua_http_refresh')return rows(Object.entries(d.refresh).filter(([,a])=>d.families[a.familyId]?.personId===v[0]&&(!v[1]||a.familyId===v[1])).map(([digest,a])=>({digest,family_id:a.familyId,consumed:a.consumed})));
    if(['ua_http_replays','ua_http_grants','ua_http_assignments','ua_http_series','ua_http_attempt_ids','ua_http_receipts','ua_http_bonuses','ua_http_cancellations'].includes(name))return rows([]);
    if(name==='ua_clerk_profile_update'){
      assert.equal(text,'UPDATE ua_private.people SET profile=$1::jsonb WHERE id=$2 RETURNING id');
      assert.equal(this.local.phase,'domain');assert.equal(this.local.person_id,v[1]);assert.deepEqual(JSON.parse(this.local.person_ids),[v[1]]);
      assert.equal(this.local.clerk_issuer,who.issuer);assert.equal(this.local.clerk_subject,who.userId);assert.equal(this.local.telegram_id,'');
      d.people[v[1]].profile=JSON.parse(v[0]);return ack();
    }
    assert.equal(this.local.phase,'exchange','Session writes require exchange');
    if(name==='ua_clerk_replay_insert'){if(d.replays[v[0]])return rows([]);d.replays[v[0]]={personId:v[1],at:v[2]};}
    else if(name==='ua_clerk_family_revoke')Object.assign(d.families[v[2]],{revokedAt:v[0],logoutRetainUntil:v[1]});
    else if(name==='ua_clerk_fence_write')d.fences[JSON.stringify(v.slice(0,3))]={personId:v[3],retiredAt:v[4]};
    else if(name==='ua_clerk_family_insert')d.families[v[0]]={personId:v[1],expiresAt:v[2],revokedAt:v[3],logoutRetainUntil:v[4],authProvider:v[5]};
    else if(name==='ua_clerk_binding_insert')d.bindings[v[0]]={issuer:v[1],userId:v[2],sessionId:v[3],personId:v[4]};
    else if(name==='ua_clerk_access_write')d.access[v[0]]={familyId:v[1],expiresAt:v[2],superseded:v[3]};
    else if(name==='ua_clerk_refresh_write')d.refresh[v[0]]={familyId:v[1],consumed:v[2]};
    else throw Error('UNEXPECTED_SYNTHETIC_SQL:'+name);
    return ack();
  }
}

async function fixture(){
  const pool=new TelegramPool(),person=structuredClone(initialState().people[ids.person]);person.telegramId=null;
  person.profile.first_name='';person.profile.last_name='';person.profile.registration_complete=false;
  pool.data.people[ids.person]=person;pool.data.people[other]=structuredClone(person);
  pool.data.people[other].profile.person_id=other;pool.data.people[other].profile.qadam_id='9999999999';
  for(const [id,p]of Object.entries(pool.data.people))pool.data.members[id]={active:p.profile.active_group_id!==null,epoch:0,revision:0,affinityGroupId:p.profile.active_group_id};
  const token='synthetic-profile-opaque-session',digest=await proofHash(token),family=crypto.randomUUID();
  pool.data.families[family]={personId:ids.person,expiresAt:clock+60000,revokedAt:null,logoutRetainUntil:null,authProvider:'clerk'};
  pool.data.access[digest]={familyId:family,expiresAt:clock+30000,superseded:false};
  pool.data.identities[key(who)]={personId:ids.person,enabled:true};pool.data.bindings[family]={...who,personId:ids.person};pool.data.fences[fence(who)]={personId:ids.person,retiredAt:null};
  const f={pool,token,digest,family,expires:clock+20000,live:true,accountEnabled:true,providerCalls:0};
  f.liveness=async identity=>{pool.events.push({name:'provider_check',phase:pool.local.phase,identity:structuredClone(identity)});f.providerCalls++;if(f.providerFailure)throw Error('private provider outage');await f.afterProvider?.();
    return {...identity,...(f.providerMismatch?{userId:'user_Mismatched'}:{}),status:f.live?'active':'revoked',accountEnabled:f.accountEnabled,expiresAt:f.expiry?.(f.providerCalls)??f.expires,...f.names};};
  f.verifier={issuer:who.issuer,authorizedParties:['https://mini.profile.invalid'],audience:{kind:'clerk_default_no_audience'},trustedKeys:()=>{throw Error('No JWT verifier substitute');},now:()=>f.serverNow?.()??pool.now};
  f.options=request=>({pool,request,sessionPolicy:testPolicy,now:()=>pool.now,liveness:f.liveness,verifier:f.verifier});
  f.request=(method='PATCH',body={first_name:'Ada',last_name:'Student'},candidate=f.token,headers={})=>new Request('https://api.profile.invalid/api/v1/me',{
    method,headers:{authorization:'Bearer '+candidate,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const handler=createConfiguredHttpHandler({mode:'local_contract',storage:{kind:'postgres_contract_double',pool},sessionPolicy:testPolicy,numericPresentation:testNumbers,now:()=>pool.now,clerk:{verifier:f.verifier,liveness:f.liveness}});
  f.send=async(body,token,headers)=>{const response=await handler(f.request('PATCH',body,token,headers));return {status:response.status,...await response.json()};};
  f.call=async(method,path,body,token)=>{const response=await handler(new Request('https://api.profile.invalid/api/v1'+path,{method,headers:{authorization:'Bearer '+token},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:response.status,...await response.json()};};
  return f;
}
const wrote=f=>f.pool.events.some(e=>e.name==='ua_clerk_profile_update');
const entered=f=>f.pool.events.some(e=>e.name==='ua_context_phase'&&e.values[0]==='domain');
const tg=4000000101,secondTg=4000000102;
const sqlHint='SELECT person_id::text,person_enabled,issuer,subject,identity_enabled FROM ua_private.locate_telegram_return($1::bigint,$2::text)';
const sqlResume="SELECT f.id::text,f.expires_at_ms::text,b.issuer,b.subject,b.sid,s.person_id::text AS fence_person_id,s.retired_at_ms::text FROM ua_private.student_families f LEFT JOIN ua_private.clerk_family_bindings b ON b.family_id=f.id LEFT JOIN ua_private.clerk_student_sessions s ON s.issuer=b.issuer AND s.subject=b.subject AND s.sid=b.sid WHERE f.person_id=$1 AND f.auth_provider='clerk' AND f.revoked_at_ms IS NULL AND f.expires_at_ms>$2 ORDER BY f.id";
class TelegramPool extends Pool{
 tail=Promise.resolve();readonlyTx=false;
 async connect(){
  // A deliberately single-checkout inert pool queues competing requests. This
  // tests transaction serialization/outcomes, NOT real PostgreSQL row locks.
  const prior=this.tail;let unlock;this.tail=new Promise(resolve=>unlock=resolve);await prior;
  const c=await super.connect();return {query:q=>c.query(q),release:discard=>{try{c.release(discard);}finally{unlock();}}};
 }
 async query(q){
  const {name,text,values:v}=q;
  const aliases={ua_telegram_begin:'ua_begin',ua_telegram_lookup_begin:'ua_begin',ua_telegram_commit:'ua_commit',ua_telegram_rollback:'ua_rollback',ua_telegram_clock:'ua_clock',ua_telegram_mapping_lock:'ua_clerk_locate',ua_telegram_people_lock:'ua_clerk_person_lock',ua_telegram_clerk_gate:'ua_clerk_identity_gate'};
  if(aliases[name]){
   this.events.push({...q,context:structuredClone(this.local),phase:this.local.phase});await this.hook?.(name,this);if(this.fail===name)throw Error('synthetic new statement failure');
   if(name==='ua_telegram_lookup_begin'){assert.equal(text,'BEGIN READ ONLY');this.readonlyTx=true;return super.query({...q,name:'ua_begin',text:'BEGIN'});}
   if(name==='ua_telegram_begin')this.readonlyTx=false;
   return super.query({...q,name:aliases[name]});
  }
  if(!['ua_telegram_hint','ua_telegram_start','ua_telegram_gate','ua_telegram_link','ua_telegram_consume','ua_telegram_resume_family','ua_telegram_link_fence'].includes(name))return super.query(q);
  this.events.push({...q,context:structuredClone(this.local),phase:this.local.phase});await this.hook?.(name,this);if(this.fail===name)throw Error('private driver synthetic secret');
  assert.ok(this.draft);const d=this.draft,rows=value=>({rows:structuredClone(value),rowCount:value.length});
  if(name==='ua_telegram_gate'){assert.equal(text,'SELECT pg_advisory_xact_lock($1::bigint)');assert.match(v[0],/^-[1-9][0-9]*$/);assert.equal(this.local.phase,'auth');return rows([]);}
  if(name==='ua_telegram_start'){
   assert.equal(text,'SELECT state FROM ua_private.lookup_telegram_start($1::bigint)');assert.equal(this.readonlyTx,true);assert.equal(this.local.phase,'auth');assert.equal(this.local.person_ids,'[]');
   if(this.startRows)return rows(this.startRows);
   const pair=Object.entries(d.people).find(([,p])=>p.telegramId===v[0]);if(!pair)return rows([{state:'needs_clerk'}]);
   const mappings=Object.values(d.identities).filter(i=>i.personId===pair[0]);return rows([{state:!pair[1].enabled||mappings.length&&!mappings.some(i=>i.enabled)?'disabled':mappings.length?'linked':'needs_clerk'}]);
  }
  if(name==='ua_telegram_hint'){
   assert.equal(text,sqlHint);assert.equal(this.local.phase,'auth');assert.equal(this.local.person_ids,'[]');assert.equal(this.local.telegram_id,'');
   if(this.hintRows)return rows(this.hintRows);
   const pair=Object.entries(d.people).find(([,p])=>p.telegramId===v[0]);if(!pair)return rows([]);
   const mappings=Object.entries(d.identities).filter(([k,i])=>JSON.parse(k)[0]===v[1]&&i.personId===pair[0]);
   return rows(mappings.length?mappings.slice(0,2).map(([k,i])=>({person_id:pair[0],person_enabled:pair[1].enabled,issuer:JSON.parse(k)[0],subject:JSON.parse(k)[1],identity_enabled:i.enabled})):[{person_id:pair[0],person_enabled:pair[1].enabled,issuer:null,subject:null,identity_enabled:null}]);
  }
  if(name==='ua_telegram_link_fence'){
   assert.equal(text,'SELECT person_id::text,retired_at_ms::text FROM ua_private.clerk_student_sessions WHERE issuer=$1 AND subject=$2 AND sid=$3');const f=d.fences[JSON.stringify(v)];return rows(f?[{person_id:f.personId,retired_at_ms:f.retiredAt===null?null:String(f.retiredAt)}]:[]);
  }
  if(name==='ua_telegram_resume_family'){
   assert.equal(text,sqlResume);assert.equal(this.local.phase,'auth');assert.equal(this.local.person_id,v[0]);
   return rows(Object.entries(d.families).filter(([,f])=>f.personId===v[0]&&f.authProvider==='clerk'&&f.revokedAt===null&&f.expiresAt>v[1]).map(([id,f])=>{
    const b=d.bindings[id],s=b&&d.fences[fence(b)];return {id,expires_at_ms:String(f.expiresAt),issuer:b?.issuer??null,subject:b?.userId??null,sid:b?.sessionId??null,fence_person_id:s?.personId??null,retired_at_ms:s?s.retiredAt===null?null:String(s.retiredAt):null};
   }));
  }
  assert.equal(this.readonlyTx,false);assert.equal(this.local.phase,'exchange');assert.equal(this.local.clerk_issuer,who.issuer);assert.equal(this.local.clerk_subject,who.userId);assert.equal(this.local.telegram_id,'');assert.deepEqual(JSON.parse(this.local.person_ids),[ids.person]);
  if(name==='ua_telegram_link'){
   assert.equal(text,'SELECT state FROM ua_private.link_telegram_identity($1::uuid,$2::bigint)');assert.equal(this.local.person_id,v[0]);
   const p=d.people[v[0]],conflict=p.telegramId!==null&&p.telegramId!==v[1]||Object.entries(d.people).some(([pid,p])=>pid!==v[0]&&p.telegramId===v[1]);
   if(conflict)return rows([{state:'conflict'}]);p.telegramId=v[1];return rows([{state:'linked'}]);
  }
  assert.equal(text,'INSERT INTO ua_private.init_data_replays(digest,person_id,consumed_at_ms) VALUES($1,$2,$3) ON CONFLICT(digest) DO NOTHING RETURNING digest');assert.equal(v[1],this.local.person_id);
  if(d.initReplays[v[0]])return rows([]);d.initReplays[v[0]]={personId:v[1],at:v[2]};return rows([{digest:v[0]}]);
 }
}
async function launch({id=tg,at=Math.floor(clock/1000),salt='default',secret=botKey}={}){
 const enc=new TextEncoder(),fields=new URLSearchParams({auth_date:String(at),query_id:salt,user:JSON.stringify({id,first_name:'UntrustedTelegramName'})});
 const data=[...fields].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>k+'='+v).join('\n');
 const seed=await crypto.subtle.importKey('raw',enc.encode('WebAppData'),{name:'HMAC',hash:'SHA-256'},false,['sign']);const root=await crypto.subtle.sign('HMAC',seed,enc.encode(secret));
 const key=await crypto.subtle.importKey('raw',root,{name:'HMAC',hash:'SHA-256'},false,['sign']);fields.set('hash',Buffer.from(await crypto.subtle.sign('HMAC',key,enc.encode(data))).toString('hex'));return fields.toString();
}
async function returnFixture({linked=false}={}){
 const f=await fixture();f.pool.data.initReplays={};f.pool.data.people[ids.person].telegramId=linked?tg:null;
 f.proof={...who,kind:'clerk_verified',notBefore:clock-1,expiresAt:clock+20000,authorizedParty:'https://mini.profile.invalid',tokenId:'SyntheticAlreadyExchanged'};
 f.service=()=>new TelegramReturnRows({pool:f.pool,botToken:botKey,sessionPolicy:testPolicy,now:()=>f.serverNow?.()??f.pool.now,verifier:f.verifier,liveness:f.liveness});
 f.handler=createConfiguredHttpHandler({mode:'local_contract',storage:{kind:'postgres_contract_double',pool:f.pool},botToken:botKey,sessionPolicy:testPolicy,numericPresentation:testNumbers,now:()=>f.pool.now,clerk:{verifier:f.verifier,liveness:f.liveness}});
 f.resume=async raw=>{const response=await f.handler(new Request('https://api.profile.invalid/api/v1/auth/telegram/resume',{method:'POST',body:JSON.stringify({init_data:raw})}));return {status:response.status,...await response.json()};};return f;
}
const failCode=code=>e=>e.code===code;
const tgWrites=e=>['ua_telegram_link','ua_telegram_consume','ua_clerk_access_write','ua_clerk_refresh_write'].includes(e.name);
const forbidden=e=>['ua_clerk_person_insert','ua_clerk_member_insert','ua_clerk_identity_insert','ua_clerk_profile_update','ua_clerk_family_insert','ua_clerk_binding_insert','ua_clerk_fence_write','ua_clerk_replay_insert'].includes(e.name);
function order(f){const n=f.pool.events.map(e=>e.name);for(const [a,b]of [['ua_telegram_clerk_gate','ua_telegram_gate'],['ua_telegram_gate','ua_telegram_mapping_lock'],['ua_telegram_mapping_lock','ua_telegram_people_lock'],['ua_telegram_people_lock','ua_clerk_person']])assert.ok(n.indexOf(a)>=0&&n.indexOf(a)<n.indexOf(b),a+' before '+b);}
test('private lookup is read-only, no profile/token/URL and disabled never new',async()=>{
 const f=await returnFixture();for(const expected of ['needs_clerk','linked','disabled']){
  if(expected==='linked')f.pool.data.people[ids.person].telegramId=tg;if(expected==='disabled')f.pool.data.people[ids.person].enabled=false;
  const before=structuredClone(f.pool.data),result=await f.service().start.lookupTelegramStart({update_id:10,telegram_user_id:tg});assert.equal(result,expected);assert.deepEqual(f.pool.data,before);
 }
 assert.equal(f.pool.events.some(tgWrites),false);assert.equal(f.pool.events.some(e=>e.name==='ua_telegram_commit'),false);
});
test('new link binds verified pair once, unchanged profile/roles and no session issuance',async()=>{
 const f=await returnFixture(),before=structuredClone(f.pool.data);const result=await f.service().link(f.proof,await launch());assert.deepEqual(result,{ok:true});
 assert.equal(f.pool.data.people[ids.person].telegramId,tg);assert.deepEqual(f.pool.data.people[ids.person].profile,before.people[ids.person].profile);
 for(const map of ['families','access','refresh','identities','members','fences','bindings','replays'])assert.deepEqual(f.pool.data[map],before[map]);
 assert.equal(Object.keys(f.pool.data.initReplays).length,1);assert.equal(f.pool.events.some(forbidden),false);order(f);assert.deepEqual(f.pool.local,{});
});
test('same pair and same exchanged JWT/launch ACK without any further effects',async()=>{
 const f=await returnFixture(),raw=await launch();const jti=await proofHash(JSON.stringify([f.proof.issuer,f.proof.userId,f.proof.sessionId,f.proof.tokenId]));f.pool.data.replays[jti]={personId:ids.person,at:clock};
 await f.service().link(f.proof,raw);const before=structuredClone(f.pool.data);f.pool.events=[];
 assert.deepEqual(await f.service().link(f.proof,raw),{ok:true});assert.deepEqual(f.pool.data,before);assert.equal(f.pool.events.some(tgWrites),false);assert.equal(f.pool.events.some(forbidden),false);
});
test('link consumption prevents immediate resume with same launch',async()=>{
 const f=await returnFixture(),raw=await launch();await f.service().link(f.proof,raw);const before=structuredClone(f.pool.data),r=await f.resume(raw);
 assert.equal(r.status,409,JSON.stringify(r));assert.equal(r.error.code,'INIT_DATA_REPLAY');assert.deepEqual(f.pool.data,before);
});
test('successful resume preserves family/expiry and rotates only access/refresh proofs',async()=>{
 const f=await returnFixture({linked:true}),before=structuredClone(f.pool.data),r=await f.resume(await launch());assert.equal(r.status,200,JSON.stringify(r));
 assert.deepEqual(f.pool.data.families,before.families);assert.equal(f.pool.data.access[f.digest].superseded,true);assert.equal(r.data.refresh_expires_at,new Date(before.families[f.family].expiresAt).toISOString());
 assert.equal(r.data.profile.person_id,ids.person);assert.deepEqual(f.pool.data.people,before.people);assert.equal(f.pool.events.some(forbidden),false);order(f);assert.equal(f.pool.checkouts,1);
});
test('missing link reports409 and consumes/creates nothing',async()=>{
 const f=await returnFixture(),before=structuredClone(f.pool.data),r=await f.resume(await launch());assert.equal(r.status,409);assert.equal(r.error.code,'TELEGRAM_LINK_REQUIRED');assert.deepEqual(f.pool.data,before);assert.equal(f.pool.events.some(tgWrites),false);
});
for(const which of ['telegram side','person side'])test('either-side existing association conflicts without mutation: '+which,async()=>{
 const f=await returnFixture();if(which==='telegram side')f.pool.data.people[other].telegramId=tg;else f.pool.data.people[ids.person].telegramId=secondTg;
 const before=structuredClone(f.pool.data);await assert.rejects(f.service().link(f.proof,await launch()),failCode('IDENTITY_LINK_CONFLICT'));assert.deepEqual(f.pool.data,before);assert.equal(f.pool.events.some(tgWrites),false);if(which==='person side')order(f);else assert.ok(f.pool.events.some(e=>e.name==='ua_telegram_people_lock'));
});
for(const scenario of ['same pair','same person different Telegram','same Telegram different person'])test('simultaneous links serialize safely: '+scenario,async()=>{
 const f=await returnFixture();let secondProof=f.proof;
 if(scenario==='same Telegram different person'){
  secondProof={...f.proof,userId:'user_Other',sessionId:'sess_Other'};f.pool.data.identities[key(secondProof)]={personId:other,enabled:true};
 }
 const one=await launch({salt:'first'}),two=await launch({id:scenario==='same person different Telegram'?secondTg:tg,salt:'second'});
 const outcomes=await Promise.allSettled([f.service().link(f.proof,one),f.service().link(secondProof,two)]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,scenario==='same pair'?2:1);
 if(scenario!=='same pair')assert.equal(outcomes.find(x=>x.status==='rejected').reason.code,'IDENTITY_LINK_CONFLICT');
 assert.equal(Object.keys(f.pool.data.initReplays).length,1);assert.equal(Object.values(f.pool.data.people).filter(p=>p.telegramId!==null).length,1);assert.equal(f.pool.events.some(forbidden),false);
});
test('concurrent same resume launch produces one session and one replay denial',async()=>{
 const f=await returnFixture({linked:true}),raw=await launch();const outcomes=await Promise.all([f.resume(raw),f.resume(raw)]);assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,409]);
 assert.equal(Object.keys(f.pool.data.initReplays).length,1);assert.equal(Object.keys(f.pool.data.families).length,1);assert.equal(Object.values(f.pool.data.access).filter(p=>!p.superseded).length,1);
});
test('same-pair duplicate with a new signed launch also has no extra effects',async()=>{
 const f=await returnFixture(),one=await launch({salt:'one'}),two=await launch({salt:'two'});await f.service().link(f.proof,one);const before=structuredClone(f.pool.data);f.pool.events=[];
 await f.service().link(f.proof,two);assert.deepEqual(f.pool.data,before);assert.equal(f.pool.events.some(tgWrites),false);
});
for(const [name,change,code]of [
 ['disabled person',f=>f.pool.data.people[ids.person].enabled=false,'ACCOUNT_DISABLED'],
 ['disabled mapping',f=>f.pool.data.identities[key(who)].enabled=false,'CLERK_IDENTITY_REVOKED'],
 ['missing mapping',f=>delete f.pool.data.identities[key(who)],'CLERK_IDENTITY_REVOKED'],
 ['retired signed Clerk session',f=>f.pool.data.fences[fence(who)].retiredAt=clock,'CLERK_SESSION_SUPERSEDED'],
 ['revoked provider',f=>f.live=false,'CLERK_SESSION_REVOKED'],
 ['disabled provider',f=>f.accountEnabled=false,'CLERK_SESSION_REVOKED'],
 ['provider unavailable',f=>f.providerFailure=true,'SERVICE_UNAVAILABLE'],
 ['provider expiry equality',f=>f.expires=clock,'CLERK_SESSION_REVOKED'],
 ['JWT expiry equality',f=>f.proof.expiresAt=clock,'CLERK_TOKEN_INVALID'],
])test('link rejects '+name+' without partial changes',async()=>{
 const f=await returnFixture();change(f);const before=structuredClone(f.pool.data);await assert.rejects(f.service().link(f.proof,await launch()),failCode(code));assert.deepEqual(f.pool.data,before);assert.equal(f.pool.events.some(tgWrites),false);
});
for(const [name,change,code]of [
 ['disabled person',f=>f.pool.data.people[ids.person].enabled=false,'ACCOUNT_DISABLED'],
 ['disabled mapping',f=>f.pool.data.identities[key(who)].enabled=false,'CLERK_IDENTITY_REVOKED'],
 ['missing Clerk mapping',f=>delete f.pool.data.identities[key(who)],'CLERK_SESSION_REVOKED'],
 ['revoked family',f=>f.pool.data.families[f.family].revokedAt=clock,'CLERK_SESSION_REVOKED'],
 ['expired family equality',f=>f.pool.data.families[f.family].expiresAt=clock,'CLERK_SESSION_REVOKED'],
 ['retired fence',f=>f.pool.data.fences[fence(who)].retiredAt=clock,'CLERK_SESSION_REVOKED'],
 ['missing fence',f=>delete f.pool.data.fences[fence(who)],'SERVICE_UNAVAILABLE'],
 ['missing binding',f=>delete f.pool.data.bindings[f.family],'SERVICE_UNAVAILABLE'],
 ['wrong binding person',f=>f.pool.data.bindings[f.family].personId=other,'SERVICE_UNAVAILABLE'],
 ['malformed SID',f=>f.pool.data.bindings[f.family].sessionId='invented','SERVICE_UNAVAILABLE'],
 ['wrong binding issuer',f=>{f.pool.data.bindings[f.family].issuer='https://foreign.invalid';f.pool.data.fences[fence(f.pool.data.bindings[f.family])]={personId:ids.person,retiredAt:null};},'CLERK_SESSION_REVOKED'],
 ['provider revoked',f=>f.live=false,'CLERK_SESSION_REVOKED'],
 ['provider outage',f=>f.providerFailure=true,'SERVICE_UNAVAILABLE'],
 ['provider expiry equality',f=>f.expires=clock,'CLERK_SESSION_REVOKED'],
])test('resume rejects '+name+' and consumes nothing',async()=>{
 const f=await returnFixture({linked:true});change(f);const before=structuredClone(f.pool.data),r=await f.resume(await launch());assert.equal(r.status,code==='ACCOUNT_DISABLED'?403:code==='SERVICE_UNAVAILABLE'?503:401,JSON.stringify(r));assert.equal(r.error.code,code);assert.deepEqual(f.pool.data,before);assert.equal(f.pool.events.some(tgWrites),false);
});
test('ambiguous eligible family never guesses SID or creates a replacement',async()=>{
 const f=await returnFixture({linked:true}),second=crypto.randomUUID();f.pool.data.families[second]={...f.pool.data.families[f.family]};f.pool.data.bindings[second]={...who,personId:ids.person};
 const before=structuredClone(f.pool.data),r=await f.resume(await launch());assert.equal(r.status,503,JSON.stringify(r));assert.deepEqual(f.pool.data,before);assert.equal(f.pool.events.some(tgWrites),false);
});
test('ambiguous or malformed preliminary identities never become a new user',async()=>{
 for(const kind of ['multiple','extra','invalid UUID']){
  const f=await returnFixture({linked:true});const base={person_id:ids.person,person_enabled:true,issuer:who.issuer,subject:who.userId,identity_enabled:true};
  f.pool.hintRows=kind==='multiple'?[base,{...base,subject:'user_Other'}]:kind==='extra'?[{...base,secret:'forbidden'}]:[{...base,person_id:'invalid'}];
  const before=structuredClone(f.pool.data),r=await f.resume(await launch());assert.equal(r.status,503);assert.deepEqual(f.pool.data,before);assert.equal(f.pool.events.some(tgWrites),false);
 }
});
for(const route of ['link','resume'])test(route+' rechecks expiry after provider await and rolls back',async()=>{
 const f=await returnFixture({linked:route==='resume'}),before=structuredClone(f.pool.data);f.afterProvider=async()=>{f.pool.now=f.expires;};
 if(route==='link')await assert.rejects(f.service().link(f.proof,await launch()),e=>e.status===401);else assert.equal((await f.resume(await launch())).status,401);
 assert.deepEqual(f.pool.data,before);assert.equal(f.pool.events.some(tgWrites),false);
});
for(const route of ['link','resume'])test(route+' shortened lease cannot extend at final commit',async()=>{
 const f=await returnFixture({linked:route==='resume'}),before=structuredClone(f.pool.data);f.expiry=n=>n===1?clock+100:clock+10000;
 f.pool.hook=(name,p)=>{if(name==='ua_telegram_clock'&&p.events.some(tgWrites))p.now=clock+100;};
 if(route==='link')await assert.rejects(f.service().link(f.proof,await launch()),failCode('CLERK_SESSION_REVOKED'));else assert.equal((await f.resume(await launch())).status,401);
 assert.deepEqual(f.pool.data,before);assert.equal(f.pool.events.some(e=>e.name==='ua_telegram_commit'),false);
});
for(const route of ['link','resume'])for(const stage of ['before','after'])test(route+' commit uncertainty '+stage+' returns503/discard once with no retry',async()=>{
 const f=await returnFixture({linked:route==='resume'});f.pool.commitFailure=stage;
 if(route==='link')await assert.rejects(f.service().link(f.proof,await launch()),e=>e.status===503&&e.outcome==='commit_unknown');else{const r=await f.resume(await launch());assert.equal(r.status,503);assert.equal(r.error.code,'SERVICE_UNAVAILABLE');}
 assert.equal(f.pool.events.filter(e=>e.name==='ua_telegram_commit').length,1);assert.equal(f.pool.events.filter(e=>e.name==='ua_telegram_rollback').length,0);assert.deepEqual(f.pool.events.filter(e=>e.name==='release').map(e=>e.discard),[true]);assert.equal(f.pool.checkouts,1);
});
for(const failure of ['ua_telegram_link','ua_telegram_consume','ua_clerk_access_write','ua_clerk_refresh_write','ua_clerk_identity_context'])test('statement failure '+failure+' rolls back and hides cause',async()=>{
 const f=await returnFixture({linked:failure!=='ua_telegram_link'}),before=structuredClone(f.pool.data);f.pool.fail=failure;
 if(failure==='ua_telegram_link')await assert.rejects(f.service().link(f.proof,await launch()),e=>e.status===503&&!e.message.includes('private'));
 else {const r=await f.resume(await launch());assert.equal(r.status,503,JSON.stringify(r));assert.equal(JSON.stringify(r).includes('private driver'),false);}
 assert.deepEqual(f.pool.data,before);assert.equal(f.pool.events.some(e=>e.name==='ua_telegram_commit'),false);assert.deepEqual(f.pool.local,{});
});
test('lookup malformed rows and driver failures remain unavailable, not needs_clerk',async()=>{
 for(const override of [[{state:'linked',person_id:ids.person}],[{state:'disabled'},{state:'linked'}],[{state:'unknown'}]]){
  const f=await returnFixture();f.pool.startRows=override;await assert.rejects(f.service().start.lookupTelegramStart({update_id:1,telegram_user_id:tg}),e=>e.status===503);
 }
 const f=await returnFixture();f.pool.fail='ua_telegram_start';await assert.rejects(f.service().start.lookupTelegramStart({update_id:1,telegram_user_id:tg}),e=>e.status===503&&!e.message.includes('private'));
});
test('resume disallows Authorization and public lookup/trusted-header attempts have no private read',async()=>{
 const f=await returnFixture({linked:true}),raw=await launch();
 for(const authorization of ['', 'Bearer '+f.token]){const r=await f.handler(new Request('https://api.profile.invalid/api/v1/auth/telegram/resume',{method:'POST',headers:{authorization},body:JSON.stringify({init_data:raw})}));assert.equal(r.status,422);}
 const lookup=await f.handler(new Request('https://api.profile.invalid/api/v1/lookupTelegramStart',{method:'POST',headers:{'x-trusted':'true'},body:JSON.stringify({telegram_user_id:tg,update_id:1})}));assert.equal(lookup.status,404);assert.equal(f.pool.checkouts,0);
});
test('sequential private lookup/link/resume reset all six GUCs with no inherited authority',async()=>{
 const f=await returnFixture();await f.service().start.lookupTelegramStart({update_id:1,telegram_user_id:tg});await f.service().link(f.proof,await launch({salt:'link'}));
 const r=await f.resume(await launch({salt:'resume'}));assert.equal(r.status,200);const resets=f.pool.events.filter(e=>e.name==='ua_context_reset');assert.equal(resets.length,3);assert.ok(resets.every(e=>JSON.stringify(e.values)===JSON.stringify(['deny','','[]','','',''])));assert.deepEqual(f.pool.local,{});
});
let jose;try{jose=await import('jose');}catch{}
test('actual JOSE JWT verification protects public linking, keeping Clerk empty-body exchange separate',{skip:!jose&&'jose6.2.15 absent; no installation approved'},async()=>{
 const f=await returnFixture(),pair=await jose.generateKeyPair('RS256',{modulusLength:2048});f.verifier.trustedKeys=()=>pair.publicKey;
 const token=await new jose.SignJWT({sid:who.sessionId,azp:'https://mini.profile.invalid',jti:'same-exchanged-jti',v:2}).setProtectedHeader({alg:'RS256',kid:'synthetic'}).setIssuer(who.issuer).setSubject(who.userId).setIssuedAt(Math.floor(clock/1000)).setNotBefore(Math.floor(clock/1000)).setExpirationTime(Math.floor(clock/1000)+20).sign(pair.privateKey);
 const raw=await launch();const send=async bearer=>f.handler(new Request('https://api.profile.invalid/api/v1/auth/telegram/link',{method:'POST',headers:{authorization:'Bearer '+bearer},body:JSON.stringify({init_data:raw})}));
 assert.equal((await send('forged')).status,401);assert.equal(f.pool.checkouts,0);const r=await send(token);assert.equal(r.status,200);assert.deepEqual((await r.json()).data,{ok:true});
 assert.equal(Object.keys(f.pool.data.families).length,1);assert.equal(f.pool.events.some(forbidden),false);
});
test('newly linked account keeps its already-issued project session/profile, without immediate resume',async()=>{
 const f=await returnFixture();await f.service().link(f.proof,await launch());
 const get=await f.handler(new Request('https://api.profile.invalid/api/v1/me',{headers:{authorization:'Bearer '+f.token}}));assert.equal(get.status,200);assert.equal((await get.json()).data.person_id,ids.person);
 const update=await f.handler(new Request('https://api.profile.invalid/api/v1/me',{method:'PATCH',headers:{authorization:'Bearer '+f.token},body:JSON.stringify({first_name:'Platform',last_name:'Edited'})}));assert.equal(update.status,200);assert.equal(f.pool.data.people[ids.person].profile.first_name,'Platform');assert.equal(f.pool.data.people[ids.person].telegramId,tg);
});
for(const route of ['link','resume'])test(route+' denies mismatched provider identity before effects',async()=>{
 const f=await returnFixture({linked:route==='resume'});f.providerMismatch=true;const before=structuredClone(f.pool.data);
 if(route==='link')await assert.rejects(f.service().link(f.proof,await launch()),failCode('CLERK_SESSION_REVOKED'));else assert.equal((await f.resume(await launch())).status,401);
 assert.deepEqual(f.pool.data,before);assert.equal(f.pool.events.some(tgWrites),false);
});
test('forged public resume signature cannot perform DB reads or select a person',async()=>{
 const f=await returnFixture({linked:true}),r=await f.resume(await launch({secret:'wrong-bot'}));assert.equal(r.status,401);assert.equal(r.error.code,'INIT_DATA_INVALID');assert.equal(f.pool.checkouts,0);
});
test('disabled mapping lookup stays disabled with no auth/session data returned',async()=>{
 const f=await returnFixture({linked:true});f.pool.data.identities[key(who)].enabled=false;const before=structuredClone(f.pool.data);
 assert.equal(await f.service().start.lookupTelegramStart({update_id:9007199254740991,telegram_user_id:tg}),'disabled');assert.deepEqual(f.pool.data,before);assert.equal(f.pool.events.some(tgWrites),false);
});

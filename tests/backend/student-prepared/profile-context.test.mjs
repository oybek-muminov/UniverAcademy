import {test} from 'node:test';
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
  const pool=new Pool(),person=structuredClone(initialState().people[ids.person]);person.telegramId=null;
  person.profile.first_name='';person.profile.last_name='';person.profile.registration_complete=false;
  pool.data.people[ids.person]=person;pool.data.people[other]=structuredClone(person);
  pool.data.people[other].profile.person_id=other;pool.data.people[other].profile.qadam_id='9999999999';
  for(const [id,p]of Object.entries(pool.data.people))pool.data.members[id]={active:p.profile.active_group_id!==null,epoch:0,revision:0,affinityGroupId:p.profile.active_group_id};
  const token='synthetic-profile-opaque-session',digest=await proofHash(token),family=crypto.randomUUID();
  pool.data.families[family]={personId:ids.person,expiresAt:clock+60000,revokedAt:null,logoutRetainUntil:null,authProvider:'clerk'};
  pool.data.access[digest]={familyId:family,expiresAt:clock+30000,superseded:false};
  pool.data.identities[key(who)]={personId:ids.person,enabled:true};pool.data.bindings[family]={...who,personId:ids.person};pool.data.fences[fence(who)]={personId:ids.person,retiredAt:null};
  const f={pool,token,digest,family,expires:clock+20000,live:true,accountEnabled:true,providerCalls:0};
  f.liveness=async identity=>{pool.events.push({name:'provider_check',phase:pool.local.phase,identity:structuredClone(identity)});f.providerCalls++;
    return {...identity,status:f.live?'active':'revoked',accountEnabled:f.accountEnabled,expiresAt:f.expiry?.(f.providerCalls)??f.expires,...f.names};};
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
test('P2-NAMES-01 existing opaque-session profile and GET remain authorized despite invalid provider display names',async()=>{
  for(const firstName of ['x'.repeat(101),'😀'.repeat(101),42,{},[],false,'\ud800','\udc00','bad\u0000name']){
    const f=await fixture();f.names={firstName,lastName:{malformed:'display only'}};
    const result=await f.send({first_name:'Platform',last_name:'Edited'});assert.equal(result.status,200,JSON.stringify(result));
    assert.equal(f.pool.data.people[ids.person].profile.first_name,'Platform');assert.equal(f.pool.data.people[ids.person].profile.last_name,'Edited');
    const me=await f.call('GET','/me',undefined,f.token);assert.equal(me.status,200);assert.equal(me.data.first_name,'Platform');
    assert.equal(f.pool.events.some(privateRead),false);
  }
});
test('opaque profile saves with exact derived Clerk context and no exam reads',async()=>{
  const f=await fixture(),foreign=structuredClone(f.pool.data.people[other]);
  const result=await f.send({first_name:'Ada',last_name:'Student'},undefined,{'x-person-id':other,'x-clerk-subject':'user_Forged'});
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.pool.checkouts,1);
  assert.equal(f.pool.events.some(privateRead),false);assert.equal(f.pool.data.people[ids.person].profile.registration_complete,true);
  assert.equal(f.pool.data.people[ids.person].profile.first_name,'Ada');assert.deepEqual(f.pool.data.people[other],foreign);
  const identity=f.pool.events.find(e=>e.name==='ua_clerk_identity_context');assert.deepEqual(identity.values,[who.issuer,who.userId]);
  assert.ok(f.pool.events.findIndex(e=>e.name==='ua_people_lock')<f.pool.events.findIndex(e=>e.name==='provider_check'));
  assert.ok(f.pool.events.findIndex(e=>e.name==='ua_context_phase'&&e.values[0]==='domain')<f.pool.events.findIndex(e=>e.name==='ua_clerk_profile_update'));
  assert.equal(f.pool.events.filter(e=>e.name==='ua_commit').length,1);assert.deepEqual(f.pool.local,{});
});
test('core callback stays auth and succeeds before the Clerk/domain setters',async()=>{
  const f=await fixture();const value=await new ClerkDomainTransactions(f.options(f.request())).transaction(async tx=>{
    assert.equal(f.pool.local.phase,'auth');assert.equal(f.pool.local.clerk_issuer,'');
    tx.state.domain.student.people[ids.person].profile={...tx.state.domain.student.people[ids.person].profile,first_name:'A',last_name:'B',registration_complete:true};
    f.pool.events.push({name:'core_success'});return 'ok';
  });
  assert.equal(value,'ok');assert.ok(f.pool.events.findIndex(e=>e.name==='core_success')<f.pool.events.findIndex(e=>e.name==='ua_clerk_identity_context'));
});
test('failed core callback and post-callback revocation cannot advance context',async()=>{
  for(const revoked of [false,true]){
    const f=await fixture();
    await assert.rejects(new ClerkDomainTransactions(f.options(f.request())).transaction(async()=>{
      assert.equal(f.pool.local.phase,'auth');if(revoked)f.live=false;else throw Error('synthetic core rejection');
    }));
    assert.equal(entered(f),false);assert.equal(wrote(f),false);assert.equal(f.pool.events.some(e=>e.name==='ua_clerk_identity_context'),false);
  }
});
for(const [field,value]of [['person_id',other],['roles',['student','owner']],['qadam_id','1234567890'],['active_group_id',other]])
test('profile mutation cannot change immutable '+field,async()=>{
  const f=await fixture(),before=structuredClone(f.pool.data);
  await assert.rejects(new ClerkDomainTransactions(f.options(f.request())).transaction(async tx=>{
    tx.state.domain.student.people[ids.person].profile[field]=value;
  }));
  assert.equal(wrote(f),false);assert.equal(f.pool.events.some(e=>e.name==='ua_commit'),false);assert.deepEqual(f.pool.data,before);
});
for(const [name,change]of [
  ['unknown proof',async f=>{f.token='missing';}],
  ['superseded access',async f=>{f.pool.data.access[f.digest].superseded=true;}],
  ['expired access equality',async f=>{f.pool.data.access[f.digest].expiresAt=clock;}],
  ['revoked family',async f=>{f.pool.data.families[f.family].revokedAt=clock;}],
  ['expired family equality',async f=>{f.pool.data.families[f.family].expiresAt=clock;}],
  ['disabled person',async f=>{f.pool.data.people[ids.person].enabled=false;}],
  ['disabled identity',async f=>{f.pool.data.identities[key(who)].enabled=false;}],
  ['provider revoked',async f=>{f.live=false;}],
  ['provider disabled account',async f=>{f.accountEnabled=false;}],
  ['provider expiry equality',async f=>{f.expires=clock;}],
  ['missing binding',async f=>{delete f.pool.data.bindings[f.family];}],
  ['wrong binding issuer',async f=>{f.pool.data.bindings[f.family].issuer='https://wrong.profile.invalid';}],
  ['wrong binding subject',async f=>{f.pool.data.bindings[f.family].userId='user_Wrong';}],
  ['wrong binding person',async f=>{f.pool.data.bindings[f.family].personId=other;}],
  ['retired session fence',async f=>{f.pool.data.fences[fence(who)].retiredAt=clock;}],
  ['missing session fence',async f=>{delete f.pool.data.fences[fence(who)];}],
  ['cross-person locator hint',async f=>{f.pool.locatorPerson=other;}],
])test(name+' cannot enter domain or write profile',async()=>{
  const f=await fixture();await change(f);const before=structuredClone(f.pool.data);const result=await f.send();
  assert.ok(result.status>=400,JSON.stringify(result));assert.equal(entered(f),false);assert.equal(wrote(f),false);
  assert.equal(f.pool.events.some(privateRead),false);assert.deepEqual(f.pool.data,before);
});
test('forged identity/roles in body are rejected in auth with no setters or writes',async()=>{
  const f=await fixture();const result=await f.send({first_name:'A',last_name:'B',person_id:other,roles:['owner']});
  assert.equal(result.status,422);assert.equal(entered(f),false);assert.equal(wrote(f),false);assert.equal(f.pool.events.some(e=>e.name==='ua_clerk_identity_context'),false);
});
for(const name of ['ua_clerk_identity_context','ua_context_phase','ua_clerk_profile_update'])test(name+' failure rolls back before acknowledgment',async()=>{
  const f=await fixture(),before=structuredClone(f.pool.data);
  if(name==='ua_context_phase')f.pool.hook=(n,p)=>{if(n===name&&p.events.at(-1).values[0]==='domain')throw Error('synthetic setter failure');};else f.pool.fail=name;
  const r=await f.send();assert.ok(r.status>=400);assert.deepEqual(f.pool.data,before);assert.equal(f.pool.events.some(e=>e.name==='ua_commit'),false);
  assert.equal(f.pool.events.filter(e=>e.name==='ua_rollback').length,1);assert.equal(f.pool.events.filter(e=>e.name==='release').length,1);assert.deepEqual(f.pool.local,{});
});
test('provider lease can shorten and never extend across the core callback and flush',async()=>{
  const f=await fixture(),before=structuredClone(f.pool.data);f.expiry=n=>n===2?clock+100:clock+20000;
  f.pool.hook=(n,p)=>{if(n==='ua_clerk_profile_update')p.now=clock+100;};
  const r=await f.send();assert.equal(r.status,401);assert.deepEqual(f.pool.data,before);assert.equal(f.pool.events.some(e=>e.name==='ua_commit'),false);
});
test('application expiry at the profile write boundary rolls back',async()=>{
  const f=await fixture(),before=structuredClone(f.pool.data);
  f.pool.hook=(n,p)=>{if(n==='ua_clerk_profile_update')p.now=p.data.access[f.digest].expiresAt;};
  const r=await f.send();assert.equal(r.status,401);assert.equal(r.error.code,'APP_SESSION_EXPIRED');assert.deepEqual(f.pool.data,before);
});
test('synchronous final commit hook rejects provider expiry equality after the final DB clock',async()=>{
  const f=await fixture(),before=structuredClone(f.pool.data);let written=false,clocks=0,checks=0,finalClock=false;
  f.pool.hook=name=>{if(name==='ua_clerk_profile_update')written=true;if(name==='ua_clock'&&written&&++clocks===2)finalClock=true;};
  f.serverNow=()=>finalClock&&++checks===2?f.expires:f.pool.now;
  const r=await f.send();assert.equal(r.status,401);assert.ok(wrote(f));assert.equal(checks,2);
  assert.equal(f.pool.events.some(e=>e.name==='ua_commit'),false);assert.deepEqual(f.pool.data,before);
});
for(const outcome of ['before','after'])test('COMMIT '+outcome+' uncertainty remains503, discard once and no retry',async()=>{
  const f=await fixture();f.pool.commitFailure=outcome;const r=await f.send();assert.equal(r.status,503);
  assert.equal(f.pool.events.filter(e=>e.name==='ua_commit').length,1);assert.equal(f.pool.events.filter(e=>e.name==='ua_rollback').length,0);
  assert.deepEqual(f.pool.events.filter(e=>e.name==='release').map(e=>e.discard),[true]);
  assert.equal(f.pool.data.people[ids.person].profile.registration_complete,outcome==='after');
});
test('rollback failure discards once and pooled reuse starts with all six deny-safe keys',async()=>{
  const f=await fixture();assert.equal((await f.send()).status,200);
  f.pool.local={phase:'domain',person_id:other,person_ids:JSON.stringify([other]),clerk_issuer:'https://forged.invalid',clerk_subject:'user_Forged',telegram_id:'99'};
  assert.equal((await f.send({first_name:'Second',last_name:'Save'})).status,200);
  assert.equal(f.pool.events.filter(e=>e.name==='ua_context_reset').length,2);
  f.pool.hook=(n,p)=>{if(n==='ua_clerk_profile_update'||n==='ua_rollback')throw Error('synthetic failure');};
  assert.ok((await f.send()).status>=400);assert.equal(f.pool.events.at(-1).discard,true);
});
test('existing auth-store relogin stays exchange; old proof fails and new proof saves profile',async()=>{
  const f=await fixture(),newIdentity={...who,sessionId:'sess_ProfileNew'},newToken='synthetic-new-profile-session',newDigest=await proofHash(newToken),newFamily=crypto.randomUUID();
  const store=new ClerkScopedAuthStore({pool:f.pool,liveness:f.liveness});
  await store.run({...newIdentity,kind:'clerk_verified',notBefore:clock-1,expiresAt:clock+20000,authorizedParty:'https://mini.profile.invalid',tokenId:'synthetic-relogin-jti'},async({personId,state,now})=>{
    for(const family of Object.values(state.families))if(family.revokedAt===null){family.revokedAt=now;family.logoutRetainUntil=now+1000;}
    for(const session of Object.values(state.studentSessions))session.retiredAt=now;
    state.studentSessions[fence(newIdentity)]={personId,retiredAt:null};
    state.families[newFamily]={personId,expiresAt:now+30000,revokedAt:null,logoutRetainUntil:null,authProvider:'clerk'};
    state.familyBindings[newFamily]=newIdentity;state.access[newDigest]={familyId:newFamily,expiresAt:now+10000,superseded:false};
  });
  assert.ok(f.pool.events.filter(e=>e.name==='ua_clerk_family_insert').every(e=>e.phase==='exchange'));
  assert.equal((await f.send()).status,401);
  assert.equal((await f.send({first_name:'After',last_name:'Relogin'},newToken)).status,200);
});
test('existing opaque GET refresh and logout keep their original source behavior',async()=>{
  const f=await fixture();const refresh='synthetic-profile-refresh';
  f.pool.data.refresh[await proofHash(refresh)]={familyId:f.family,consumed:false};
  assert.equal((await f.call('GET','/me',undefined,f.token)).status,200);
  const renewed=await f.call('POST','/auth/refresh',{refresh_token:refresh},f.token);assert.equal(renewed.status,200,JSON.stringify(renewed));
  assert.equal((await f.call('GET','/me',undefined,renewed.data.access_token)).status,200);
  assert.equal((await f.call('GET','/me',undefined,f.token)).status,401);
  const logout=await f.call('POST','/auth/logout',undefined,renewed.data.access_token);assert.equal(logout.status,200,JSON.stringify(logout));
  assert.equal((await f.call('GET','/me',undefined,renewed.data.access_token)).status,401);
});

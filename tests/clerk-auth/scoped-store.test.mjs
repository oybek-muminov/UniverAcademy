import {test} from "node:test";
import assert from "node:assert/strict";
import {ClerkScopedAuthStore} from "../../supabase/functions/univeracademy-api/storage/clerk-auth-rows.ts";
import {clerkIdentityKey,clerkSessionKey} from "../../supabase/functions/univeracademy-api/clerk-auth.ts";
import {proofHash} from "../../supabase/functions/univeracademy-api/student-state.ts";
import {exchangeClerkSession} from "../../supabase/functions/univeracademy-api/clerk-http.ts";
import {testPolicy,testNumbers} from "../backend/http-fixture.ts";

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const at=Date.UTC(2026,10,7),who={issuer:"https://clerk.example.invalid",userId:"user_StoreA1",sessionId:"sess_StoreA1"};
const proof=(identity=who)=>({...identity,kind:"clerk_verified",notBefore:at-1,expiresAt:at+10000,authorizedParty:"https://student.example.invalid",tokenId:crypto.randomUUID()});
const hex=n=>n.toString(16).padStart(64,"0");
const empty=()=>({people:{},members:{},identities:{},families:{},bindings:{},fences:{},access:{},refresh:{},replays:{},history:{foreign:"unchanged synthetic history"}});

// Statement-protocol double only. Its global queue is NOT Postgres locking/RLS.
class Pool{
  state=empty();time=at;events=[];tail=Promise.resolve();fail;hook;inject;
  async connect(){
    const previous=this.tail;let release;this.tail=new Promise(r=>{release=r;});await previous;
    let draft;
    const result=rows=>({rows,rowCount:rows.length});
    return{query:async statement=>{
      const {name,text,values:v}=statement;this.events.push({name,text,values:structuredClone(v)});if(this.hook)this.hook(name,this);
      if(this.fail===name)throw Error("synthetic query failure");
      if(name==="ua_clerk_begin"){draft=structuredClone(this.state);return result([]);}
      if(name==="ua_clerk_commit"){this.state=draft;if(this.fail==="commit_after")throw Error("unknown commit");return result([]);}
      if(name==="ua_clerk_rollback")return result([]);
      if(name==="ua_clerk_clock")return result([{now_ms:String(this.time)}]);
      if(name==="ua_context_reset"){assert.deepEqual(v,["deny","","[]","","",""]);assert.ok(text.endsWith("set_config('ua.telegram_id',$6,true)"));return result([]);}
      if(name==="ua_context_phase"){assert.equal(text,"SELECT set_config('ua.phase',$1,true)");assert.ok(["deny","auth","domain","exchange"].includes(v[0]));return result([]);}
      if(["ua_clerk_identity_gate","ua_clerk_identity_context","ua_people_context"].includes(name))return result([]);
      const owner=v[0],own=(map)=>Object.entries(map).filter(([,r])=>r.personId===owner);
      let rows;
      if(name==="ua_clerk_locate"){assert.equal(text,"SELECT person_id::text,enabled FROM ua_private.lock_clerk_identity($1::text,$2::text)");const r=draft.identities[JSON.stringify(v)];rows=r?[{person_id:r.personId,enabled:r.enabled}]:[];}
      else if(name==="ua_clerk_person_lock"){assert.equal(text,"SELECT id::text FROM ua_private.lock_people($1::uuid[]) ORDER BY id");assert.equal(v[0].length,1);rows=draft.people[v[0][0]]?[{id:v[0][0]}]:[];}
      else if(name==="ua_clerk_person"){const p=draft.people[owner];rows=p?[{telegram_id:p.telegramId===null?null:String(p.telegramId),enabled:p.enabled,roles:p.profile.roles,profile:p.profile}]:[];}
      else if(name==="ua_clerk_membership"){const m=draft.members[owner];rows=m?[{active:m.active,epoch:String(m.epoch),revision:String(m.revision),affinity_group_id:m.affinityGroupId}]:[];}
      else if(name==="ua_clerk_identities")rows=own(draft.identities).map(([k,r])=>{const [issuer,subject]=JSON.parse(k);return{issuer,subject,person_id:r.personId,enabled:r.enabled};});
      else if(name==="ua_clerk_families")rows=own(draft.families).map(([key,r])=>({id:key,person_id:r.personId,expires_at_ms:String(r.expiresAt),revoked_at_ms:r.revokedAt===null?null:String(r.revokedAt),logout_retain_until_ms:r.logoutRetainUntil===null?null:String(r.logoutRetainUntil),auth_provider:r.authProvider??null}));
      else if(name==="ua_clerk_bindings")rows=Object.entries(draft.bindings).filter(([key])=>draft.families[key]?.personId===owner).map(([key,r])=>({family_id:key,person_id:r.personId,issuer:r.issuer,subject:r.userId,sid:r.sessionId}));
      else if(name==="ua_clerk_fences")rows=own(draft.fences).map(([key,r])=>{const [issuer,subject,sid]=JSON.parse(key);return{issuer,subject,sid,person_id:r.personId,retired_at_ms:r.retiredAt===null?null:String(r.retiredAt)};});
      else if(name==="ua_clerk_replays")rows=own(draft.replays).map(([key,r])=>({digest:key,person_id:r.personId}));
      else if(name==="ua_clerk_access")rows=Object.entries(draft.access).filter(([,r])=>draft.families[r.familyId]?.personId===owner).map(([key,r])=>({digest:key,family_id:r.familyId,expires_at_ms:String(r.expiresAt),superseded:r.superseded}));
      else if(name==="ua_clerk_refresh")rows=Object.entries(draft.refresh).filter(([,r])=>draft.families[r.familyId]?.personId===owner).map(([key,r])=>({digest:key,family_id:r.familyId,consumed:r.consumed}));
      if(rows)return result(this.inject?this.inject(name,rows):structuredClone(rows));
      if(name==="ua_clerk_person_insert"){
        if(draft.people[v[0]]||Object.values(draft.people).some(p=>p.profile.qadam_id===v[1]))return result([]);
        draft.people[v[0]]={telegramId:null,enabled:v[2],profile:JSON.parse(v[4])};
      }else if(name==="ua_clerk_member_insert")draft.members[v[0]]={active:false,epoch:0,revision:0,affinityGroupId:null};
      else if(name==="ua_clerk_identity_insert"){
        const key=JSON.stringify(v.slice(0,2));if(draft.identities[key])throw Error("identity unique conflict");draft.identities[key]={personId:v[2],enabled:true};
      }else if(name==="ua_clerk_profile_update")draft.people[v[1]].profile=JSON.parse(v[0]);
      else if(name==="ua_clerk_replay_insert"){
        if(draft.replays[v[0]])return result([]);draft.replays[v[0]]={personId:v[1],at:v[2]};
      }else if(name==="ua_clerk_fence_write")draft.fences[JSON.stringify(v.slice(0,3))]={personId:v[3],retiredAt:v[4]};
      else if(name==="ua_clerk_family_revoke")Object.assign(draft.families[v[2]],{revokedAt:v[0],logoutRetainUntil:v[1]});
      else if(name==="ua_clerk_family_insert"){
        if(Object.values(draft.families).some(f=>f.personId===v[1]&&f.revokedAt===null))throw Error("one current family");
        draft.families[v[0]]={personId:v[1],expiresAt:v[2],revokedAt:v[3],logoutRetainUntil:v[4],authProvider:v[5]};
      }else if(name==="ua_clerk_binding_insert")draft.bindings[v[0]]={issuer:v[1],userId:v[2],sessionId:v[3],personId:v[4]};
      else if(name==="ua_clerk_access_write")draft.access[v[0]]={familyId:v[1],expiresAt:v[2],superseded:v[3]};
      else if(name==="ua_clerk_refresh_write")draft.refresh[v[0]]={familyId:v[1],consumed:v[2]};
      else throw Error("Unexpected statement: "+name);
      return result([{ok:true}]);
    },release:discard=>{this.events.push({name:"release",discard});release();}};
  }
}
function fixture(){
  const pool=new Pool();let generated=0;
  const liveness=async(identity,now)=>({...identity,status:"active",accountEnabled:true,expiresAt:at+60000});
  const store=new ClerkScopedAuthStore({pool,liveness,newPersonId:()=>id(++generated)});
  return{pool,store,generated:()=>generated};
}
function login(identity=who,n=1,qadam="0100000001"){
  return async({personId,state,now})=>{
    if(!state.person){state.person={telegramId:null,enabled:true,profile:{person_id:personId,first_name:"",last_name:"",roles:["student"],registration_complete:false,active_group_id:null,qadam_id:qadam}};
      state.membership={active:false,epoch:0,revision:0,affinityGroupId:null};state.identities[clerkIdentityKey(identity)]={personId,enabled:true};}
    const key=clerkSessionKey(identity);
    for(const [k,v]of Object.entries(state.studentSessions))if(k!==key&&v.retiredAt===null)v.retiredAt=now;
    state.studentSessions[key]={personId,retiredAt:null};
    for(const f of Object.values(state.families))if(f.revokedAt===null){f.revokedAt=now;f.logoutRetainUntil=now+30000;}
    const family=id(100+n);state.families[family]={personId,expiresAt:now+20000,revokedAt:null,logoutRetainUntil:null,authProvider:"clerk"};
    state.familyBindings[family]=identity;state.access[hex(10+n)]={familyId:family,expiresAt:now+10000,superseded:false};state.refresh[hex(20+n)]={familyId:family,consumed:false};
    return{personId};
  };
}

test("scoped auth create/reload preserves nullable Telegram, exact identity, F1 binding and proof digests; ACK follows commit",async()=>{
  const f=fixture(),created=await f.store.run(proof(),login());assert.equal(created.personId,id(1));
  assert.equal(f.pool.state.people[id(1)].telegramId,null);assert.equal(f.pool.state.members[id(1)].active,false);
  const fresh=new ClerkScopedAuthStore({pool:f.pool,liveness:async(identity)=>({...identity,status:"active",accountEnabled:true,expiresAt:at+60000})});
  await fresh.run(proof(),async({state,personId})=>{assert.equal(personId,id(1));assert.equal(state.person.telegramId,null);assert.deepEqual(state.familyBindings[id(101)],who);assert.ok(Object.keys(state.consumedTokens).length>=1);});
  assert.equal(f.pool.events.at(-2).name,"ua_clerk_commit");assert.equal(f.pool.events.at(-1).name,"release");
  assert.equal(f.pool.state.history.foreign,"unchanged synthetic history");
});

test("same identity first-login race resolves one canonical person; case-distinct identity remains separate and existing readers are person scoped",async()=>{
  const f=fixture(),results=await Promise.all([f.store.run(proof(),login()),f.store.run(proof(),async input=>({personId:input.personId}))]);
  assert.equal(results[0].personId,results[1].personId);assert.equal(Object.keys(f.pool.state.people).length,1);
  const other={...who,userId:"user_storeA1",sessionId:"sess_StoreB2"};await f.store.run(proof(other),login(other,2,"0100000002"));
  assert.equal(Object.keys(f.pool.state.people).length,2);
  const before=structuredClone(f.pool.state.people[id(2)]);
  await f.store.run(proof(),async({state})=>{assert.deepEqual(Object.keys(state.identities),[clerkIdentityKey(who)]);assert.equal(state.families[id(102)],undefined);});
  assert.deepEqual(f.pool.state.people[id(2)],before);
  for(const e of f.pool.events.filter(e=>["ua_clerk_person","ua_clerk_identities","ua_clerk_families","ua_clerk_replays"].includes(e.name)))assert.ok(e.text.includes("WHERE")&&e.values.length===1);
});

test("missing active F1 provenance/binding and malformed security data deny without repair or cross-person reads",async()=>{
  for(const change of [p=>{delete p.state.bindings[id(101)];},p=>{delete p.state.families[id(101)].authProvider;},p=>{p.state.people[id(1)].enabled=false;}]){
    const f=fixture();await f.store.run(proof(),login());change(f.pool);const before=structuredClone(f.pool.state);let worked=false;
    await assert.rejects(f.store.run(proof(),async()=>{worked=true;}),e=>[403,503].includes(e.status));assert.equal(worked,false);assert.deepEqual(f.pool.state,before);
  }
  const f=fixture();await f.store.run(proof(),login());f.pool.inject=(name,rows)=>name==="ua_clerk_bindings"?rows.map(r=>({...r,person_id:id(999)})):rows;
  await assert.rejects(f.store.run(proof(),async()=>{}),e=>e.status===500);
});

test("replay collision, scope/role escalation, binding reassignment and retired-sid revival all roll back",async()=>{
  const f=fixture(),used=proof();await f.store.run(used,login());const before=structuredClone(f.pool.state);
  const next={...who,sessionId:"sess_StoreNextB2"};
  await assert.rejects(f.store.run({...used},async()=>{}),e=>e.code==="CLERK_TOKEN_REPLAY");assert.deepEqual(f.pool.state,before);
  // A DB-wide conflicting digest is not visible through a person's scoped read.
  const nextProof=proof(next),collision=await proofHash(JSON.stringify([nextProof.issuer,nextProof.userId,nextProof.sessionId,nextProof.tokenId]));
  f.pool.state.replays[collision]={personId:id(999),at};const conflict=structuredClone(f.pool.state);
  await assert.rejects(f.store.run(nextProof,login(next,2)),e=>e.status===409);assert.deepEqual(f.pool.state,conflict);delete f.pool.state.replays[collision];
  for(const change of [s=>{s.person.profile.roles=["owner"];},s=>{s.familyBindings[id(101)]={...who,userId:"user_Foreign"};},s=>{s.person.profile.person_id=id(999);},
    s=>{s.person.enabled="true";},s=>{s.person.profile.registration_complete="false";},s=>{s.person.profile.qadam_id=null;}]){
    await assert.rejects(f.store.run(proof(),async({state})=>change(state)));assert.deepEqual(f.pool.state,before);
  }
  await f.store.run(proof(next),login(next,2));await assert.rejects(f.store.run(proof(),async()=>{}),e=>e.code==="CLERK_SESSION_SUPERSEDED");
});

test("failure during write and final-clock expiry roll back; commit uncertainty is503 without ACK or automatic retry",async()=>{
  for(const fail of ["ua_clerk_binding_insert","ua_clerk_refresh_write","ua_clerk_commit","commit_after"]){
    const f=fixture(),before=structuredClone(f.pool.state);f.pool.fail=fail;
    await assert.rejects(f.store.run(proof(),login()),e=>fail.includes("commit")?e.status===503:true);
    if(fail!=="commit_after")assert.deepEqual(f.pool.state,before);else assert.equal(Object.keys(f.pool.state.people).length,1);
    if(fail.includes("commit"))assert.equal(f.pool.events.at(-1).discard,true);
  }
  for(const delta of [-1,0,1]){
    const f=fixture(),p={...proof(),expiresAt:at+1000};f.pool.hook=(name,pool)=>{if(name==="ua_clerk_refresh_write")pool.time=at+1000+delta;};
    if(delta<0)await f.store.run(p,login());else{await assert.rejects(f.store.run(p,login()),e=>e.status===401);assert.equal(Object.keys(f.pool.state.people).length,0);}
  }
});

test("fresh DB clock after a delayed provider reply denies at/equal expiry before auth rows are written",async()=>{
  for(const offset of [-1,0,1]){
    const f=fixture();const store=new ClerkScopedAuthStore({pool:f.pool,newPersonId:()=>id(1),liveness:async identity=>{f.pool.time=at+1000+offset;return{...identity,status:"active",accountEnabled:true,expiresAt:at+1000};}});
    if(offset<0)await store.run(proof(),login());else await assert.rejects(store.run(proof(),login()),e=>e.status===401);
    assert.equal(Object.keys(f.pool.state.people).length,offset<0?1:0);
  }
});

test("expiry during scoped row loading denies before work; a regressing precommit clock503 rolls back",async()=>{
  const f=fixture();await f.store.run(proof(),login());const before=structuredClone(f.pool.state);let worked=false;
  f.pool.hook=(name,pool)=>{if(name==="ua_clerk_refresh")pool.time=at+1000;};
  await assert.rejects(f.store.run({...proof(),expiresAt:at+1000},async()=>{worked=true;}),e=>e.status===401);
  assert.equal(worked,false);assert.deepEqual(f.pool.state,before);
  const g=fixture();g.pool.hook=(name,pool)=>{if(name==="ua_clerk_refresh_write")pool.time=at-1;};
  await assert.rejects(g.store.run(proof(),login()),e=>e.status===503);assert.deepEqual(g.pool.state,empty());
});

// Actual exchange/domain/auth-store code after the verifier boundary. Proofs and
// provider responses are explicitly synthetic trusted-port inputs, not a JWT
// verifier substitute. Real JOSE endpoint integration is a separate guarded test.
function namesFixture(names={firstName:'Aziz',lastName:'Karimov'}){
  const pool=new Pool();let serial=0;
  const f={pool,names,enabled:true,status:'active',expires:at+60000,calls:0};
  f.live=async identity=>{f.calls++;await f.readHook?.(identity);return{...identity,status:f.status,accountEnabled:f.enabled,expiresAt:f.expiry?.(f.calls)??f.expires,...f.names,...f.identityPatch};};
  const store=new ClerkScopedAuthStore({pool,liveness:f.live,newPersonId:()=>id(++serial)});
  const deps={mode:'local_candidate',verifier:{issuer:who.issuer,authorizedParties:['https://student.example.invalid'],audience:{kind:'clerk_default_no_audience'},trustedKeys:()=>{throw Error('No JWT verifier substitute');},now:()=>pool.time},
    liveness:f.live,sessionPolicy:testPolicy,numericPresentation:testNumbers};
  f.exchange=async(p=proof())=>store.runDomain(p,async input=>{
    const s=input.state,student={people:s.person?{[input.personId]:s.person}:{},families:s.families,access:s.access,refresh:s.refresh,consumedInitData:{},grants:{},assignments:{},series:{},attempts:{},receipts:{},bonuses:{},cancellations:{}};
    const state={domain:{student,memberships:s.membership?{[input.personId]:s.membership}:{}},identities:s.identities,familyBindings:s.familyBindings,studentSessions:s.studentSessions,consumedTokens:s.consumedTokens};
    const value=await exchangeClerkSession({state,now:()=>pool.time,newPersonId:()=>input.personId},p,deps);
    Object.assign(s,{person:student.people[input.personId],membership:state.domain.memberships[input.personId],identities:state.identities,
      familyBindings:state.familyBindings,studentSessions:state.studentSessions,consumedTokens:state.consumedTokens,families:student.families,access:student.access,refresh:student.refresh});
    return value;
  });
  return f;
}
test('new verified-provider names seed only a new UUID student and remain incomplete',async()=>{
  const f=namesFixture(),result=await f.exchange({...proof(),first_name:'Forged',last_name:'Claims',roles:['owner'],email:'auto-link@invalid'});
  assert.equal(result.profile.first_name,'Aziz');assert.equal(result.profile.last_name,'Karimov');assert.equal(result.profile.registration_complete,false);
  assert.deepEqual(result.profile.roles,['student']);assert.equal(result.profile.active_group_id,null);assert.equal(result.profile.person_id,id(1));
  assert.equal(f.pool.state.people[id(1)].telegramId,null);assert.match(result.profile.qadam_id,/^\d{10}$/);
  assert.deepEqual(f.pool.state.members[id(1)],{active:false,epoch:0,revision:0,affinityGroupId:null});
  assert.equal(f.pool.events.filter(e=>e.name==='ua_clerk_person_insert').length,1);
});
test('repeat login preserves edited platform names and all existing identity/role/qadam/group fields',async()=>{
  const f=namesFixture();await f.exchange();const person=f.pool.state.people[id(1)];
  Object.assign(person.profile,{first_name:'Edited',last_name:'Platform',registration_complete:true});const before=structuredClone(person);
  f.names={firstName:'Changed provider',lastName:'Must not overwrite'};
  const result=await f.exchange(proof({...who,sessionId:'sess_StoreNameSecond'}));
  assert.deepEqual(f.pool.state.people[id(1)],before);assert.equal(result.profile.first_name,'Edited');assert.equal(result.profile.last_name,'Platform');
  assert.equal(Object.keys(f.pool.state.people).length,1);assert.equal(f.pool.events.some(e=>e.name==='ua_clerk_profile_update'),false);
});
test('P2-NAMES-01 existing mapped login ignores malformed/overlong provider names without overwriting platform edits',async()=>{
  for(const firstName of ['x'.repeat(101),'😀'.repeat(101),42,{},[],false,'\ud800','\udc00','bad\u0000name']){
    const f=namesFixture();await f.exchange();const person=f.pool.state.people[id(1)];
    Object.assign(person.profile,{first_name:'Edited',last_name:'Platform',registration_complete:true});const pinned=structuredClone(person);
    f.names={firstName,lastName:{invalid:'must not become authority'}};
    const result=await f.exchange(proof({...who,sessionId:'sess_StoreNamesLater'}));
    assert.deepEqual(f.pool.state.people[id(1)],pinned);assert.equal(result.profile.first_name,'Edited');assert.equal(result.profile.last_name,'Platform');
    assert.equal(Object.keys(f.pool.state.people).length,1);assert.equal(f.pool.events.some(e=>e.name==='ua_clerk_profile_update'),false);
  }
});
for(const [label,names,expected]of [
  ['null',{firstName:null,lastName:null},['','']],['missing',{},['','']],
  ['partial',{firstName:'Aziz',lastName:null},['Aziz','']],['blank',{firstName:' ',lastName:''},['','']],
  ['Unicode100',{firstName:'😀'.repeat(100),lastName:'O‘quvchi'},['😀'.repeat(100),'O‘quvchi']],
])test('new-person '+label+' names are bounded display data without invented defaults',async()=>{
  const f=namesFixture(names),r=await f.exchange();assert.deepEqual([r.profile.first_name,r.profile.last_name],expected);assert.equal(r.profile.registration_complete,false);
});
for(const value of [42,{},[],true,'x'.repeat(101),'😀'.repeat(101),'\ud800','\udc00','bad\u0000name'])
test('malformed new-provider name rolls back without partial registration '+JSON.stringify(value).slice(0,20),async()=>{
  const f=namesFixture({firstName:value,lastName:'Valid'}),before=structuredClone(f.pool.state);
  await assert.rejects(f.exchange(),e=>e.status===503);assert.deepEqual(f.pool.state,before);assert.equal(f.pool.events.some(e=>e.name==='ua_clerk_person_insert'),false);
});
for(const change of [f=>{f.status='revoked';},f=>{f.enabled=false;},f=>{f.identityPatch={userId:'user_Foreign'};},f=>{f.identityPatch={issuer:'https://foreign.invalid'};},f=>{f.readHook=()=>{throw Error('synthetic provider outage');};}])
test('provider failure/mismatch denies name provisioning with no partial graph',async()=>{
  const f=namesFixture();change(f);const before=structuredClone(f.pool.state);await assert.rejects(f.exchange());assert.deepEqual(f.pool.state,before);
});
test('disabled mapping rejects before provider name read and cannot become a new person',async()=>{
  const f=namesFixture();await f.exchange();f.pool.state.identities[clerkIdentityKey(who)].enabled=false;const before=structuredClone(f.pool.state),calls=f.calls;
  await assert.rejects(f.exchange(),e=>e.code==='CLERK_IDENTITY_REVOKED');assert.deepEqual(f.pool.state,before);assert.equal(f.calls,calls);
});
test('name read and final flush expiry equality deny atomically; later expiry cannot extend the earlier lease',async()=>{
  for(const phase of ['first read','exchange read','write','shortened exchange lease']){
    const f=namesFixture(),before=structuredClone(f.pool.state);
    if(phase==='first read')f.readHook=()=>{f.pool.time=at+60000;};
    if(phase==='exchange read')f.readHook=()=>{if(f.calls===2)f.pool.time=at+60000;};
    if(phase==='write')f.pool.hook=(name,pool)=>{if(name==='ua_clerk_person_insert')pool.time=at+60000;};
    if(phase==='shortened exchange lease'){
      f.expiry=n=>n===1?at+60000:at+100;
      f.pool.hook=(name,pool)=>{if(name==='ua_clerk_refresh_write')pool.time=at+100;};
    }
    await assert.rejects(f.exchange(),e=>e.status===401,phase);assert.deepEqual(f.pool.state,before,phase);
    assert.equal(f.pool.events.some(e=>e.name==='ua_clerk_commit'),false,phase);
  }
});

import {fail} from "../fault.ts";
import {checkClerkProof,requireLiveClerk,clerkIdentityKey,clerkSessionKey} from "../clerk-auth.ts";
import type {ClerkIdentity,ClerkProof,ClerkLiveness} from "../clerk-auth.ts";
import type {ClerkCandidateState} from "../clerk-http.ts";
import type {Person,StudentState} from "../student-state.ts";
import {proofHash} from "../student-state.ts";
import {integer,StorageUnavailable} from "./postgres-transaction.ts";
import type {PgPool,PgClient} from "./postgres-transaction.ts";

export type ClerkAuthSnapshot={person:Person|null;membership:{active:boolean;epoch:number;revision:number;affinityGroupId:string|null}|null;
  identities:ClerkCandidateState["identities"];familyBindings:ClerkCandidateState["familyBindings"];
  studentSessions:ClerkCandidateState["studentSessions"];consumedTokens:ClerkCandidateState["consumedTokens"];
  families:StudentState["families"];access:StudentState["access"];refresh:StudentState["refresh"]};
export type ClerkAuthScope={client:PgClient;personId:string;identity?:ClerkIdentity;existing:boolean;now:number;exchangeDigest?:string;allowTelegramLogin?:boolean};
type Scope=ClerkAuthScope;
const uuid=(v:unknown):v is string=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const digest=(v:string)=>/^[0-9a-f]{64}$/.test(v);
const canonical=(v:unknown):string=>JSON.stringify(v,(_,x)=>x&&typeof x==="object"&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const ms=(v:unknown)=>{if(!Number.isSafeInteger(v)||Number(v)<0)fail("RESPONSE_INVARIANT_FAILED",500);return v as number;};
const bool=(v:unknown)=>{if(typeof v!=="boolean")fail("RESPONSE_INVARIANT_FAILED",500);return v;};
const nullable=(v:unknown)=>v===null?null:integer(v);
const query=(client:PgClient,name:string,text:string,values:readonly unknown[]=[])=>client.query({name,text,values});
async function clock(client:PgClient){
  const r=await query(client,"ua_clerk_clock","SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms");
  if(r.rows.length!==1)fail("RESPONSE_INVARIANT_FAILED",500);return integer(r.rows[0].now_ms);
}
function identity(value:ClerkIdentity){
  if(typeof value.issuer!=="string"||new URL(value.issuer).origin!==value.issuer||!value.issuer.startsWith("https://")||
    !/^user_[A-Za-z0-9]+(?![\s\S])/.test(value.userId)||!/^sess_[A-Za-z0-9]+(?![\s\S])/.test(value.sessionId))fail("RESPONSE_INVARIANT_FAILED",500);
}
function checkSnapshot(scope:Scope,s:ClerkAuthSnapshot){
  if(!s.person||s.person.profile.person_id!==scope.personId)fail("FORBIDDEN",403);
  const p=s.person.profile,m=s.membership;
  if(!Array.isArray(p.roles)||!p.roles.every(r=>["student","teacher","admin","owner"].includes(r))||typeof p.first_name!=="string"||typeof p.last_name!=="string"||
    typeof p.registration_complete!=="boolean"||!(p.active_group_id===null||uuid(p.active_group_id))||typeof p.qadam_id!=="string"||!/^\d{10}$/.test(p.qadam_id)||
    p.registration_complete&&(!p.first_name.trim()||!p.last_name.trim())||Object.keys(p).some(k=>!["person_id","first_name","last_name","roles","registration_complete","active_group_id","qadam_id"].includes(k)))fail("RESPONSE_INVARIANT_FAILED",500);
  if(!p.roles.includes("student"))fail("FORBIDDEN",403);
  if(!bool(s.person.enabled))fail("ACCOUNT_DISABLED",403);
  if(!m||typeof m.active!=="boolean"||!Number.isSafeInteger(m.epoch)||m.epoch<0||!Number.isSafeInteger(m.revision)||m.revision<0||
    !(m.affinityGroupId===null||uuid(m.affinityGroupId))||m.active&&m.affinityGroupId===null||p.active_group_id!==(m.active?m.affinityGroupId:null))fail("RESPONSE_INVARIANT_FAILED",500);
  if(s.person.telegramId!==null&&(!Number.isSafeInteger(s.person.telegramId)||s.person.telegramId<=0))fail("RESPONSE_INVARIANT_FAILED",500);
  for(const v of Object.values(s.identities))if(v.personId!==scope.personId||typeof v.enabled!=="boolean")fail("RESPONSE_INVARIANT_FAILED",500);
  if(scope.identity&&!s.identities[clerkIdentityKey(scope.identity)]?.enabled)fail("CLERK_IDENTITY_REVOKED",401);
  let live=0;
  for(const [key,f]of Object.entries(s.families)){
    if(!uuid(key)||f.personId!==scope.personId)fail("RESPONSE_INVARIANT_FAILED",500);ms(f.expiresAt);if(f.revokedAt!==null)ms(f.revokedAt);
    if(f.logoutRetainUntil!==null)ms(f.logoutRetainUntil);
    if(f.revokedAt===null)live++;
    if(f.authProvider!=="clerk"&&f.authProvider!=="telegram"){
      if(f.revokedAt===null&&scope.now<f.expiresAt)fail("SERVICE_UNAVAILABLE",503);
    }else if(f.authProvider==="clerk"){
      const binding=s.familyBindings[key];
      if(!binding){if(f.revokedAt===null&&scope.now<f.expiresAt)fail("SERVICE_UNAVAILABLE",503);}
      else{identity(binding);const fence=s.studentSessions[clerkSessionKey(binding)];if(f.revokedAt===null&&scope.now<f.expiresAt&&(!s.identities[clerkIdentityKey(binding)]?.enabled||!fence||fence.retiredAt!==null))fail("SERVICE_UNAVAILABLE",503);}
    }else if(Object.hasOwn(s.familyBindings,key))fail("SERVICE_UNAVAILABLE",503);
  }
  if(live>1)fail("RESPONSE_INVARIANT_FAILED",500);
  for(const key of Object.keys(s.familyBindings))if(!s.families[key])fail("RESPONSE_INVARIANT_FAILED",500);
  for(const [key,v]of Object.entries(s.studentSessions)){
    let parts;try{parts=JSON.parse(key);}catch{fail("RESPONSE_INVARIANT_FAILED",500);}
    if(!Array.isArray(parts)||parts.length!==3)fail("RESPONSE_INVARIANT_FAILED",500);identity({issuer:parts[0],userId:parts[1],sessionId:parts[2]});
    if(v.personId!==scope.personId)fail("RESPONSE_INVARIANT_FAILED",500);if(v.retiredAt!==null)ms(v.retiredAt);
  }
  for(const [key,v]of Object.entries(s.access)){if(!digest(key)||!s.families[v.familyId]||typeof v.superseded!=="boolean")fail("RESPONSE_INVARIANT_FAILED",500);ms(v.expiresAt);}
  for(const [key,v]of Object.entries(s.refresh))if(!digest(key)||!s.families[v.familyId]||typeof v.consumed!=="boolean")fail("RESPONSE_INVARIANT_FAILED",500);
  for(const [key,v]of Object.entries(s.consumedTokens))if(!digest(key)||v!==true)fail("RESPONSE_INVARIANT_FAILED",500);
}

// Auth-only exchange scope. Accept only a proof from the trusted signature
// verifier, never a proof-shaped public JSON body. No domain/attempt/grant/staff
// load, API bootstrap or raw-JWT verification is implemented by this row port.
export class ClerkScopedAuthStore{
  private readonly pool:PgPool;private readonly liveness:ClerkLiveness;private readonly newPersonId:()=>string;private readonly signal?:AbortSignal;
  constructor(options:{pool:PgPool;liveness:ClerkLiveness;newPersonId?:()=>string;signal?:AbortSignal}){
    if(typeof options.pool?.connect!=="function"||typeof options.liveness!=="function")throw new StorageUnavailable("not_committed");
    this.pool=options.pool;this.liveness=options.liveness;this.newPersonId=options.newPersonId??(()=>crypto.randomUUID());this.signal=options.signal;
  }
  async run<T>(proof:ClerkProof,work:(input:{personId:string;state:ClerkAuthSnapshot;now:number})=>Promise<T>):Promise<T>{
    return this.execute(proof,work,true);
  }
  // The existing HTTP exchange owns replay consumption and family issuance.
  // Keep its work in the same identity/person transaction as these auth rows.
  async runDomain<T>(proof:ClerkProof,work:(input:{personId:string;state:ClerkAuthSnapshot;now:number})=>Promise<T>):Promise<T>{
    return this.execute(proof,work,false);
  }
  private async execute<T>(proof:ClerkProof,work:(input:{personId:string;state:ClerkAuthSnapshot;now:number})=>Promise<T>,consumeBeforeWork:boolean):Promise<T>{
    let client:PgClient;try{client=await this.pool.connect();}catch{throw new StorageUnavailable("not_committed");}
    if(typeof client?.query!=="function"||typeof client.release!=="function"){
      if(typeof client?.release==="function")client.release(true);throw new StorageUnavailable("not_committed");
    }
    let began=false,committing=false,discard=false;
    try{
      if(this.signal?.aborted)throw new StorageUnavailable("not_committed");
      await query(client,"ua_clerk_begin","BEGIN");began=true;
      checkClerkProof(proof,await clock(client));
      const who={issuer:proof.issuer,userId:proof.userId,sessionId:proof.sessionId};identity(who);
      await query(client,"ua_clerk_identity_gate","SELECT pg_advisory_xact_lock(1430348620,hashtext($1))",[clerkIdentityKey(who)]);
      await query(client,"ua_clerk_identity_context","SELECT set_config('ua.clerk_issuer',$1,true),set_config('ua.clerk_subject',$2,true)",[who.issuer,who.userId]);
      const mapped=await query(client,"ua_clerk_locate","SELECT person_id::text FROM ua_private.clerk_identities WHERE issuer=$1 AND subject=$2 FOR UPDATE",[who.issuer,who.userId]);
      if(mapped.rows.length>1)fail("RESPONSE_INVARIANT_FAILED",500);
      const personId=mapped.rows.length?mapped.rows[0].person_id:this.newPersonId();if(!uuid(personId))fail("RESPONSE_INVARIANT_FAILED",500);
      await query(client,"ua_clerk_person_context","SELECT set_config('ua.person_id',$1,true)",[personId]);
      if(mapped.rows.length){const locked=await query(client,"ua_clerk_person_lock","SELECT id::text FROM ua_private.people WHERE id=$1 FOR UPDATE",[personId]);if(locked.rows.length!==1||locked.rows[0].id!==personId)fail("CLERK_IDENTITY_REVOKED",401);}
      let now=await clock(client);checkClerkProof(proof,now);
      const providerExpires=await requireLiveClerk(who,now,this.liveness),afterRead=await clock(client);
      if(afterRead<now)throw new StorageUnavailable("not_committed");now=afterRead;checkClerkProof(proof,now);if(now>=providerExpires)fail("CLERK_SESSION_REVOKED",401);
      const rows=new ClerkAuthRows(),scope:Scope={client,personId,identity:who,existing:mapped.rows.length===1,now},state=await rows.load(scope),before=structuredClone(state);
      const replay=await proofHash(JSON.stringify([proof.issuer,proof.userId,proof.sessionId,proof.tokenId]));
      const readyAt=await clock(client);if(readyAt<now)throw new StorageUnavailable("not_committed");now=readyAt;scope.now=now;
      checkClerkProof(proof,now);if(now>=providerExpires)fail("CLERK_SESSION_REVOKED",401);
      if(state.consumedTokens[replay])fail("CLERK_TOKEN_REPLAY",409);if(consumeBeforeWork)state.consumedTokens[replay]=true;scope.exchangeDigest=replay;
      const value=await work({personId,state,now});scope.now=await clock(client);if(scope.now<now)throw new StorageUnavailable("not_committed");checkClerkProof(proof,scope.now);if(scope.now>=providerExpires)fail("CLERK_SESSION_REVOKED",401);
      if(state.consumedTokens[replay]!==true)fail("RESPONSE_INVARIANT_FAILED",500);
      await rows.flush(scope,before,state);
      const finalTime=await clock(client);if(finalTime<scope.now)throw new StorageUnavailable("not_committed");checkClerkProof(proof,finalTime);if(finalTime>=providerExpires)fail("CLERK_SESSION_REVOKED",401);
      for(const [key,f]of Object.entries(state.families))if(!before.families[key]&&f.revokedAt===null&&finalTime>=f.expiresAt)fail("CLERK_SESSION_REVOKED",401);
      for(const [key,p]of Object.entries(state.access))if(!before.access[key]&&finalTime>=p.expiresAt)fail("APP_SESSION_EXPIRED",401);
      if(this.signal?.aborted)throw new StorageUnavailable("not_committed");
      committing=true;await query(client,"ua_clerk_commit","COMMIT");began=false;return value;
    }catch(error){
      if(committing){discard=true;throw new StorageUnavailable("commit_unknown");}
      if(began){try{await query(client,"ua_clerk_rollback","ROLLBACK");}catch{discard=true;}}else discard=true;
      throw error;
    }finally{client.release(discard);}
  }
}

// Shared person-scoped auth rows. No transaction, HTTP or provider defaults.
export class ClerkAuthRows{
  async load(s:Scope):Promise<ClerkAuthSnapshot>{
    const result:ClerkAuthSnapshot={person:null,membership:null,identities:{},families:{},access:{},refresh:{},familyBindings:{},studentSessions:{},consumedTokens:{}};
    if(!s.existing)return result;
    const read=(name:string,text:string)=>query(s.client,name,text,[s.personId]);
    const p=(await read("ua_clerk_person","SELECT telegram_id::text,enabled,roles,profile FROM ua_private.people WHERE id=$1")).rows;
    if(p.length!==1)fail("CLERK_IDENTITY_REVOKED",401);
    const profile=p[0].profile as Person["profile"];
    if(profile.person_id!==s.personId||!same(profile.roles,p[0].roles))fail("RESPONSE_INVARIANT_FAILED",500);
    result.person={telegramId:p[0].telegram_id===null?null:integer(p[0].telegram_id),enabled:bool(p[0].enabled),profile};
    const member=(await read("ua_clerk_membership","SELECT active,epoch::text,revision::text,affinity_group_id::text FROM ua_private.memberships WHERE person_id=$1")).rows;
    if(member.length!==1)fail("RESPONSE_INVARIANT_FAILED",500);
    result.membership={active:bool(member[0].active),epoch:integer(member[0].epoch),revision:integer(member[0].revision),affinityGroupId:member[0].affinity_group_id as string|null};
    for(const r of (await read("ua_clerk_identities","SELECT issuer,subject,person_id::text,enabled FROM ua_private.clerk_identities WHERE person_id=$1")).rows){
      identity({issuer:r.issuer as string,userId:r.subject as string,sessionId:s.identity?.sessionId??"sess_ShapeCheck"});
      if(r.person_id!==s.personId)fail("RESPONSE_INVARIANT_FAILED",500);result.identities[JSON.stringify([r.issuer,r.subject])]={personId:s.personId,enabled:bool(r.enabled)};
    }
    for(const r of (await read("ua_clerk_families","SELECT id::text,person_id::text,expires_at_ms::text,revoked_at_ms::text,logout_retain_until_ms::text,auth_provider FROM ua_private.student_families WHERE person_id=$1")).rows){
      if(r.person_id!==s.personId)fail("RESPONSE_INVARIANT_FAILED",500);
      result.families[r.id as string]={personId:s.personId,expiresAt:integer(r.expires_at_ms),revokedAt:nullable(r.revoked_at_ms),logoutRetainUntil:nullable(r.logout_retain_until_ms),...(r.auth_provider===null?{}:{authProvider:r.auth_provider as "clerk"|"telegram"})};
    }
    for(const r of (await read("ua_clerk_bindings","SELECT b.family_id::text,b.person_id::text,b.issuer,b.subject,b.sid FROM ua_private.clerk_family_bindings b JOIN ua_private.student_families f ON f.id=b.family_id WHERE f.person_id=$1")).rows){
      if(r.person_id!==s.personId)fail("RESPONSE_INVARIANT_FAILED",500);result.familyBindings[r.family_id as string]={issuer:r.issuer as string,userId:r.subject as string,sessionId:r.sid as string};
    }
    for(const r of (await read("ua_clerk_fences","SELECT issuer,subject,sid,person_id::text,retired_at_ms::text FROM ua_private.clerk_student_sessions WHERE person_id=$1")).rows){
      if(r.person_id!==s.personId)fail("RESPONSE_INVARIANT_FAILED",500);result.studentSessions[JSON.stringify([r.issuer,r.subject,r.sid])]={personId:s.personId,retiredAt:nullable(r.retired_at_ms)};
    }
    for(const r of (await read("ua_clerk_replays","SELECT digest,person_id::text FROM ua_private.clerk_exchange_replays WHERE person_id=$1")).rows){if(r.person_id!==s.personId)fail("RESPONSE_INVARIANT_FAILED",500);result.consumedTokens[r.digest as string]=true;}
    for(const r of (await read("ua_clerk_access","SELECT a.digest,a.family_id::text,a.expires_at_ms::text,a.superseded FROM ua_private.student_access a JOIN ua_private.student_families f ON f.id=a.family_id WHERE f.person_id=$1")).rows)
      result.access[r.digest as string]={familyId:r.family_id as string,expiresAt:integer(r.expires_at_ms),superseded:bool(r.superseded)};
    for(const r of (await read("ua_clerk_refresh","SELECT r.digest,r.family_id::text,r.consumed FROM ua_private.student_refresh r JOIN ua_private.student_families f ON f.id=r.family_id WHERE f.person_id=$1")).rows)
      result.refresh[r.digest as string]={familyId:r.family_id as string,consumed:bool(r.consumed)};
    checkSnapshot(s,result);
    if(s.identity&&result.studentSessions[clerkSessionKey(s.identity)]?.retiredAt!==null&&result.studentSessions[clerkSessionKey(s.identity)]!==undefined)fail("CLERK_SESSION_SUPERSEDED",401);
    return result;
  }
  async flush(s:Scope,before:ClerkAuthSnapshot,after:ClerkAuthSnapshot){
    checkSnapshot(s,after);
    const person=after.person!;
    const write=async(name:string,text:string,values:readonly unknown[])=>{const r=await query(s.client,name,text,values);if(r.rowCount!==1)fail("RESPONSE_INVARIANT_FAILED",500);};
    for(const map of ["identities","families","familyBindings","access","refresh","studentSessions","consumedTokens"] as const)
      if(Object.keys(before[map]).some(key=>!Object.hasOwn(after[map],key)))fail("RESPONSE_INVARIANT_FAILED",500);
    if(!before.person){
      if(!s.identity)fail("SERVICE_UNAVAILABLE",503);
      if(person.telegramId!==null||!same(person.profile.roles,["student"])||person.profile.registration_complete||person.profile.active_group_id!==null||
        !same(Object.keys(after.identities),[clerkIdentityKey(s.identity)])||!same(after.membership,{active:false,epoch:0,revision:0,affinityGroupId:null}))fail("RESPONSE_INVARIANT_FAILED",500);
      await write("ua_clerk_person_insert","INSERT INTO ua_private.people(id,telegram_id,qadam_id,enabled,roles,profile) VALUES($1,NULL,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING RETURNING id",[s.personId,person.profile.qadam_id,person.enabled,person.profile.roles,JSON.stringify(person.profile)]);
      await write("ua_clerk_member_insert","INSERT INTO ua_private.memberships(person_id,active,epoch,revision,affinity_group_id) VALUES($1,false,0,0,NULL) RETURNING person_id",[s.personId]);
      await write("ua_clerk_identity_insert","INSERT INTO ua_private.clerk_identities(issuer,subject,person_id,enabled) VALUES($1,$2,$3,true) RETURNING person_id",[s.identity.issuer,s.identity.userId,s.personId]);
    }else{
      const invariant=(p:Person)=>({telegramId:p.telegramId,enabled:p.enabled,roles:p.profile.roles,qadam:p.profile.qadam_id,group:p.profile.active_group_id});
      if(!same(invariant(before.person),invariant(person))||!same(before.membership,after.membership)||!same(before.identities,after.identities))fail("RESPONSE_INVARIANT_FAILED",500);
      if(!same(before.person.profile,person.profile))await write("ua_clerk_profile_update","UPDATE ua_private.people SET profile=$1::jsonb WHERE id=$2 RETURNING id",[JSON.stringify(person.profile),s.personId]);
    }
    for(const key of Object.keys(after.consumedTokens))if(!before.consumedTokens[key]){
      if(key!==s.exchangeDigest)fail("RESPONSE_INVARIANT_FAILED",500);
      const r=await query(s.client,"ua_clerk_replay_insert","INSERT INTO ua_private.clerk_exchange_replays(digest,person_id,consumed_at_ms) VALUES($1,$2,$3) ON CONFLICT(digest) DO NOTHING RETURNING digest",[key,s.personId,s.now]);
      if(r.rowCount!==1)fail("CLERK_TOKEN_REPLAY",409);
    }
    for(const [key,v]of Object.entries(after.studentSessions))if(!same(before.studentSessions[key],v)){
      const old=before.studentSessions[key];if(old&&old.retiredAt!==null)fail("RESPONSE_INVARIANT_FAILED",500);const [issuer,subject,sid]=JSON.parse(key);
      if(!old&&(!s.identity||key!==clerkSessionKey(s.identity)))fail("RESPONSE_INVARIANT_FAILED",500);
      await write("ua_clerk_fence_write","INSERT INTO ua_private.clerk_student_sessions(issuer,subject,sid,person_id,retired_at_ms) VALUES($1,$2,$3,$4,$5) ON CONFLICT(issuer,subject,sid) DO UPDATE SET retired_at_ms=COALESCE(ua_private.clerk_student_sessions.retired_at_ms,EXCLUDED.retired_at_ms) WHERE ua_private.clerk_student_sessions.person_id=EXCLUDED.person_id RETURNING person_id",[issuer,subject,sid,s.personId,v.retiredAt]);
    }
    for(const [key,old]of Object.entries(before.families))if(!same(old,after.families[key])){
      const v=after.families[key];if(old.revokedAt!==null||old.expiresAt!==v.expiresAt||old.authProvider!==v.authProvider||v.revokedAt===null)fail("RESPONSE_INVARIANT_FAILED",500);
      await write("ua_clerk_family_revoke","UPDATE ua_private.student_families SET revoked_at_ms=$1,logout_retain_until_ms=$2 WHERE id=$3 AND person_id=$4 AND revoked_at_ms IS NULL RETURNING id",[v.revokedAt,v.logoutRetainUntil,key,s.personId]);
    }
    for(const [key,v]of Object.entries(after.families))if(!before.families[key]){
      if(s.identity){
        if(v.authProvider!=="clerk"||!after.familyBindings[key])fail("SERVICE_UNAVAILABLE",503);
        if(!same(after.familyBindings[key],s.identity))fail("RESPONSE_INVARIANT_FAILED",500);
      }else if(!s.allowTelegramLogin||person.telegramId===null||v.authProvider!=="telegram"||after.familyBindings[key])fail("SERVICE_UNAVAILABLE",503);
      await write("ua_clerk_family_insert","INSERT INTO ua_private.student_families(id,person_id,expires_at_ms,revoked_at_ms,logout_retain_until_ms,auth_provider) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[key,s.personId,v.expiresAt,v.revokedAt,v.logoutRetainUntil,v.authProvider]);
    }
    for(const [key,v]of Object.entries(after.familyBindings)){
      if(before.familyBindings[key]){if(!same(before.familyBindings[key],v))fail("RESPONSE_INVARIANT_FAILED",500);continue;}
      if(before.families[key])fail("SERVICE_UNAVAILABLE",503); // No guessed repair of missing provenance.
      await write("ua_clerk_binding_insert","INSERT INTO ua_private.clerk_family_bindings(family_id,issuer,subject,sid,person_id) VALUES($1,$2,$3,$4,$5) RETURNING family_id",[key,v.issuer,v.userId,v.sessionId,s.personId]);
    }
    for(const [key,v]of Object.entries(after.access))if(!same(before.access[key],v)){
      const old=before.access[key];if(old&&(old.familyId!==v.familyId||old.expiresAt!==v.expiresAt||old.superseded&&!v.superseded))fail("RESPONSE_INVARIANT_FAILED",500);
      await write("ua_clerk_access_write","INSERT INTO ua_private.student_access(digest,family_id,expires_at_ms,superseded) VALUES($1,$2,$3,$4) ON CONFLICT(digest) DO UPDATE SET superseded=ua_private.student_access.superseded OR EXCLUDED.superseded WHERE ua_private.student_access.family_id=EXCLUDED.family_id AND ua_private.student_access.expires_at_ms=EXCLUDED.expires_at_ms RETURNING digest",[key,v.familyId,v.expiresAt,v.superseded]);
    }
    for(const [key,v]of Object.entries(after.refresh))if(!same(before.refresh[key],v)){
      const old=before.refresh[key];if(old&&(old.familyId!==v.familyId||old.consumed&&!v.consumed))fail("RESPONSE_INVARIANT_FAILED",500);
      await write("ua_clerk_refresh_write","INSERT INTO ua_private.student_refresh(digest,family_id,consumed) VALUES($1,$2,$3) ON CONFLICT(digest) DO UPDATE SET consumed=ua_private.student_refresh.consumed OR EXCLUDED.consumed WHERE ua_private.student_refresh.family_id=EXCLUDED.family_id RETURNING digest",[key,v.familyId,v.consumed]);
    }
  }
}

import {TelegramReturnRows} from "./telegram-return-rows.ts";
import {fail} from "../fault.ts";
import {guardBoundFamily} from "../clerk-http.ts";
import type {ClerkVerifierConfiguration} from "../clerk-auth.ts";
import {PreparedStudentTransactions,isFirstStudentRequest,isLegacyStudentRequest} from "./prepared-student.ts";
import {checkClerkProof,clerkIdentityKey} from "../clerk-auth.ts";
import type {ClerkLiveness} from "../clerk-auth.ts";
import type {ClerkCandidateState,ClerkTransaction,ClerkTransactionIntent,ClerkTransactions} from "../clerk-http.ts";
import type {SessionPolicy,StudentState} from "../student-state.ts";
import {authenticate,bearer,proofHash} from "../student-state.ts";
import type {StaffState} from "../staff-state.ts";
import {ClerkAuthRows,ClerkScopedAuthStore} from "./clerk-auth-rows.ts";
import type {ClerkAuthSnapshot,ClerkAuthScope} from "./clerk-auth-rows.ts";
import {PostgresTransactions,integer,query,StorageUnavailable} from "./postgres-transaction.ts";
import type {PgPool,LockedTransaction} from "./postgres-transaction.ts";
import {StudentHttpRows} from "./student-http-rows.ts";
import {StudentIdentityRows} from "./student-identity-rows.ts";
import {locateStudent,locateStudentAccessOnClient,locateStudentRefreshOnClient,studentSessionProofs,studentLogoutRefreshDigest} from "./student-scope.ts";
import {StaffAccessRows} from "./staff-access-rows.ts";
import {StaffFirstTestRows} from "./staff-first-test-rows.ts";
import {resetTrustedServerContext,setTrustedPhase,setTrustedClerk,closeTrustedServerContext} from "./trusted-server-context.ts";

function emptyStudent():StudentState{return{people:{},families:{},access:{},refresh:{},consumedInitData:{},grants:{},assignments:{},series:{},attempts:{},receipts:{},bonuses:{},cancellations:{}};}
function emptyDomain(student=emptyStudent()):StaffState{return{student,staff:{},groups:{},memberships:{},versions:{},recoveryAssignments:{},notifications:{},approvals:{},receipts:{},audit:[]};}
const same=(a:unknown,b:unknown)=>JSON.stringify(a,(_,v)=>typeof v==="bigint"?v.toString():v)===JSON.stringify(b,(_,v)=>typeof v==="bigint"?v.toString():v);
function combined(auth:ClerkAuthSnapshot,domain=emptyDomain()):ClerkCandidateState{
  if(auth.person)domain.student.people[auth.person.profile.person_id]=auth.person;
  if(auth.person&&auth.membership)domain.memberships[auth.person.profile.person_id]=auth.membership;
  Object.assign(domain.student,{families:auth.families,access:auth.access,refresh:auth.refresh});
  return{domain,identities:auth.identities,familyBindings:auth.familyBindings,studentSessions:auth.studentSessions,consumedTokens:auth.consumedTokens};
}
function snapshot(state:ClerkCandidateState,personId:string):ClerkAuthSnapshot{
  return{person:state.domain.student.people[personId]??null,membership:state.domain.memberships[personId]??null,
    identities:state.identities,familyBindings:state.familyBindings,studentSessions:state.studentSessions,consumedTokens:state.consumedTokens,
    families:state.domain.student.families,access:state.domain.student.access,refresh:state.domain.student.refresh};
}
async function fresh(tx:LockedTransaction){
  const r=await query(tx,"ua_clock","SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms");
  if(r.rows.length!==1)fail("SERVICE_UNAVAILABLE",503);const now=integer(r.rows[0].now_ms);
  if(now<tx.now)fail("SERVICE_UNAVAILABLE",503);tx.now=now;return now;
}
type Options={pool:PgPool;request:Request;botToken?:string;sessionPolicy:SessionPolicy;now:()=>number;liveness:ClerkLiveness;verifier?:ClerkVerifierConfiguration;
  staff?:{validate:(name:string,value:unknown)=>boolean;newAssignmentId:()=>string}};

// Request-scoped bridge for the existing handlers and relational row ports.
// No whole-database snapshot, RAM fallback, provider constructor or SQL execution
// outside the explicitly injected transaction client.
export class ClerkDomainTransactions implements ClerkTransactions{
  private readonly options:Options;
  readonly telegramReturn:TelegramReturnRows;
  constructor(options:Options){if(typeof options.pool?.connect!=="function"||typeof options.liveness!=="function")throw new StorageUnavailable("not_committed");this.options={...options,request:options.request.clone()};this.telegramReturn=new TelegramReturnRows({...options,signal:options.request.signal});}
  async transaction<T>(work:(tx:ClerkTransaction)=>Promise<T>,intent?:ClerkTransactionIntent):Promise<T>{
    const o=this.options;
    if(intent?.kind==="exchange")return new ClerkScopedAuthStore({pool:o.pool,liveness:(id,now)=>o.liveness(id,now,{signal:o.request.signal}),signal:o.request.signal}).runDomain(intent.proof,async input=>{
      const state=combined(input.state),domainBefore=structuredClone(state.domain);
      const value=await work({state,now:()=>input.now,newPersonId:()=>input.personId});
      // Login cannot load/alter assignments, attempts, answers, deadlines or history.
      const invariant=(s:StaffState)=>({...s,student:{...s.student,people:{},families:{},access:{},refresh:{}},memberships:{}});
      if(!same(invariant(domainBefore),invariant(state.domain)))fail("RESPONSE_INVARIANT_FAILED",500);
      Object.assign(input.state,snapshot(state,input.personId));return value;
    });
    if(intent)return this.staffOrLink(work,intent);
    if(o.request.method==="PATCH"&&new URL(o.request.url).pathname.replace(/\/$/,"")==="/api/v1/me")return this.profile(work);
    if(o.request.method==="POST"&&["/api/v1/auth/refresh","/api/v1/auth/logout"].includes(new URL(o.request.url).pathname.replace(/\/$/,"")))return this.session(work);
    if(isFirstStudentRequest(o.request)){
      if(!o.verifier)fail("SERVICE_UNAVAILABLE",503);
      let metadata:ClerkAuthSnapshot|undefined,expiresAt:number|undefined;
      const restrictProviderExpiry=(value:number)=>{
        if(!Number.isSafeInteger(value)||value<0)fail("SERVICE_UNAVAILABLE",503);
        expiresAt=expiresAt===undefined?value:Math.min(expiresAt,value);
      };
      const prepared=new PreparedStudentTransactions(o.pool,o.request,async(tx,auth)=>{
        const personId=tx.personIds[0];
        await query(tx,"ua_clerk_person_context","SELECT set_config('ua.person_id',$1,true)",[personId]);
        metadata=await new ClerkAuthRows().load({client:tx.client,personId,existing:true,now:tx.now});
        if(!same(auth.people[personId],metadata.person)||!same(auth.families,metadata.families)||!same(auth.access,metadata.access)||!same(auth.refresh,metadata.refresh))fail("RESPONSE_INVARIANT_FAILED",500);
        const checked=await guardBoundFamily({state:combined(metadata,emptyDomain(auth)),now:()=>tx.now,restrictProviderExpiry},o.request,await o.request.clone().text(),{
          verifier:o.verifier!,liveness:(id,now)=>o.liveness(id,now,{signal:o.request.signal}),
          ...(o.botToken?{legacyTelegram:{botToken:o.botToken}}:{})});
        return ()=>{
          const now=o.verifier!.now();
          if(o.request.signal.aborted||!Number.isSafeInteger(now)||now<checked||now<tx.now||
            (expiresAt!==undefined&&now>=expiresAt))fail("CLERK_SESSION_REVOKED",401);
        };
      });
      return prepared.transaction(async({state,now})=>{
        if(!metadata)fail("SERVICE_UNAVAILABLE",503);
        const combinedState=combined(structuredClone(metadata),emptyDomain(state)),before=snapshot(combinedState,Object.keys(state.people)[0]);
        const value=await work({state:combinedState,now,restrictProviderExpiry});
        if(!same(before,snapshot(combinedState,Object.keys(state.people)[0])))fail("RESPONSE_INVARIANT_FAILED",500);
        return value;
      });
    }
    if(!isLegacyStudentRequest(o.request))fail("NOT_FOUND",404);
    const scope=await locateStudent(o.pool,o.request.clone(),{botToken:o.botToken??"",sessionPolicy:o.sessionPolicy,now:o.now});
    const runner=new PostgresTransactions(o.pool);
    const perform=async(tx:LockedTransaction)=>{
      const personId=tx.personIds[0];await query(tx,"ua_clerk_person_context","SELECT set_config('ua.person_id',$1,true)",[personId]);
      const authRows=new ClerkAuthRows(),authScope:ClerkAuthScope={client:tx.client,personId,existing:true,now:tx.now,allowTelegramLogin:scope.kind==="telegram"};
      const auth=await authRows.load(authScope),beforeAuth=structuredClone(auth);
      const rows=new StudentHttpRows({boundClerk:true,externalAuthWriter:true}),student=await rows.load(tx,personId),beforeStudent=structuredClone(student);
      if(!same(student.people[personId],auth.person)||!same(student.families,auth.families)||!same(student.access,auth.access)||!same(student.refresh,auth.refresh))fail("RESPONSE_INVARIANT_FAILED",500);
      const state=combined(auth,emptyDomain(student));await fresh(tx);
      const value=await work({state,now:()=>tx.now});authScope.now=await fresh(tx);if(o.request.signal.aborted)fail("SERVICE_UNAVAILABLE",503);
      await authRows.flush(authScope,beforeAuth,snapshot(state,personId));
      await rows.flush(tx,personId,beforeStudent,state.domain.student);await fresh(tx);if(o.request.signal.aborted)fail("SERVICE_UNAVAILABLE",503);return value;
    };
    return scope.kind==="telegram"?runner.runIdentity(scope.telegramId,gate=>new StudentIdentityRows().ensure(gate,scope.initData,{botToken:o.botToken??"",sessionPolicy:o.sessionPolicy}),perform):runner.run([scope.personId],perform);
  }
  private async session<T>(work:(tx:ClerkTransaction)=>Promise<T>):Promise<T>{
    const o=this.options;if(!o.verifier)fail("SERVICE_UNAVAILABLE",503);
    const kind=/\/refresh\/?$/.test(new URL(o.request.url).pathname)?"refresh":"logout";
    const proofs=await studentSessionProofs(o.request),raw=await o.request.clone().text();
    let tx:LockedTransaction|undefined,checkedAt=0,lease:number|undefined,deadline:number|undefined,issuedDeadline:number|undefined,finished=false;
    const restrictProviderExpiry=(value:number)=>{
      if(!Number.isSafeInteger(value)||value<0)fail("SERVICE_UNAVAILABLE",503);
      lease=lease===undefined?value:Math.min(lease,value);
    };
    const checkTime=()=>{
      const now=o.verifier!.now();
      if(o.request.signal.aborted||!tx||!Number.isSafeInteger(now)||now<checkedAt||now<tx.now)fail("SERVICE_UNAVAILABLE",503);
      if(lease!==undefined&&now>=lease)fail("CLERK_SESSION_REVOKED",401);
      if((deadline!==undefined&&now>=deadline)||(issuedDeadline!==undefined&&now>=issuedDeadline))fail(proofs.kind==="access"?"APP_SESSION_EXPIRED":"REFRESH_EXPIRED",401);
      checkedAt=now;return now;
    };
    return new PostgresTransactions(o.pool).runPrepared({
      prepare:async client=>{
        const hint=await (proofs.kind==="access"?locateStudentAccessOnClient:locateStudentRefreshOnClient)(client,proofs.digest);
        if(hint.kind!=="person")fail("SESSION_REVOKED",401);return [hint.personId];
      },
      beforeCommit:()=>{if(!finished)fail("SERVICE_UNAVAILABLE",503);checkTime();},
    },async locked=>{
      tx=locked;const personId=locked.personIds[0],rows=new ClerkAuthRows();
      const scope:ClerkAuthScope={client:locked.client,personId,existing:true,now:locked.now};
      const loaded=await rows.loadSession(scope,proofs,kind==="logout"&&proofs.kind==="refresh"),familyId=loaded.familyId;
      const before=snapshot(combined(structuredClone(loaded.state)),personId),authority=combined(structuredClone(before)),state=combined(loaded.state);
      const family=before.families[familyId],binding=before.familyBindings[familyId];
      // Provenance is captured before callback mutation. A helper answer is only
      // a hint; every binding and proof is rechecked under the person lock.
      const tombstone=kind==="logout"&&proofs.kind==="refresh"&&family.revokedAt!==null;
      if(family.personId!==personId)fail("RESPONSE_INVARIANT_FAILED",500);
      if(!tombstone){
        if(family.authProvider!=="clerk"||!binding)fail("SERVICE_UNAVAILABLE",503);
        if(binding.issuer!==o.verifier!.issuer||before.identities[clerkIdentityKey(binding)]?.personId!==personId)fail("CLERK_IDENTITY_REVOKED",401);
      }
      if(proofs.accessToken)await authenticate(authority.domain.student,proofs.accessToken,await fresh(locked));
      const bodyDigest=proofs.kind==="access"?await studentLogoutRefreshDigest(o.request):proofs.refreshDigest;
      if(proofs.kind==="access"&&bodyDigest){
        const other=await rows.loadSession(scope,{kind:"refresh",digest:bodyDigest},true);
        if(other.familyId!==familyId)fail("LOGOUT_PROOF_MISMATCH",401);
      }
      const authorize=async()=>{
        await fresh(locked);
        if(kind==="refresh"){
          const providerCheckedAt=await guardBoundFamily({state:authority,now:()=>locked.now,restrictProviderExpiry},o.request,raw,{
            verifier:o.verifier!,liveness:(id,now)=>o.liveness(id,now,{signal:o.request.signal})});
          checkedAt=Math.max(checkedAt,providerCheckedAt);deadline=family.expiresAt;
        }else{
          if(proofs.accessToken)await authenticate(authority.domain.student,proofs.accessToken,locked.now);
          if(family.revokedAt!==null){
            if(proofs.kind!=="refresh"||family.logoutRetainUntil===null)fail("REFRESH_EXPIRED",401);
            deadline=family.logoutRetainUntil;
          }else deadline=proofs.kind==="access"?Math.min(family.expiresAt,before.access[proofs.digest].expiresAt):family.expiresAt;
        }
        await fresh(locked);checkedAt=Math.max(checkedAt,locked.now);checkTime();
      };
      await authorize();
      const shell=(s:ClerkCandidateState)=>({...s.domain,student:{...s.domain.student,people:{},families:{},access:{},refresh:{}},memberships:{}});
      const invariant=structuredClone(shell(state));
      const callbackStart=checkTime();
      const value=await work({state,now:()=>{checkTime();return locked.now;},restrictProviderExpiry});
      if(!same(invariant,shell(state)))fail("RESPONSE_INVARIANT_FAILED",500);
      await authorize();
      if(tombstone){
        // Retained proof acknowledgement grants no authority and performs no DML.
        if(!same(before,snapshot(state,personId)))fail("RESPONSE_INVARIANT_FAILED",500);
        finished=true;return value;
      }
      if(!binding)fail("SERVICE_UNAVAILABLE",503);
      // REFRESH_REUSED and logout intentionally revoke the resulting state. Use
      // immutable pre-mutation authority, never reauthenticate that result.
      await setTrustedClerk(locked.client,binding.issuer,binding.userId);
      await setTrustedPhase(locked.client,"exchange");
      await authorize();scope.now=locked.now;
      const after=snapshot(state,personId);
      const resultFamily=after.families[familyId];
      if(family.revokedAt===null&&resultFamily?.revokedAt!==null){
        const revoked=resultFamily?.revokedAt;
        if(revoked===undefined||revoked===null||revoked<callbackStart||revoked>locked.now||
          resultFamily.logoutRetainUntil!==revoked+o.sessionPolicy.logoutTombstoneMs)fail("RESPONSE_INVARIANT_FAILED",500);
      }
      await rows.flushSession(scope,before,after,familyId,kind);
      if(kind==="refresh")for(const [digest,p]of Object.entries(after.access))if(!before.access[digest])issuedDeadline=issuedDeadline===undefined?p.expiresAt:Math.min(issuedDeadline,p.expiresAt);
      await authorize();finished=true;return value;
    });
  }
  private async profile<T>(work:(tx:ClerkTransaction)=>Promise<T>):Promise<T>{
    const o=this.options;if(!o.verifier)fail("SERVICE_UNAVAILABLE",503);
    const token=bearer(o.request)!,digest=await proofHash(token),raw=await o.request.clone().text();
    let tx:LockedTransaction|undefined,checkedAt=0,lease:number|undefined,appExpires:number|undefined,flushed=false;
    const restrictProviderExpiry=(value:number)=>{
      if(!Number.isSafeInteger(value)||value<0)fail("SERVICE_UNAVAILABLE",503);
      lease=lease===undefined?value:Math.min(lease,value);
    };
    const checkLease=()=>{
      const now=o.verifier!.now();
      if(o.request.signal.aborted||!tx||!Number.isSafeInteger(now)||now<checkedAt||now<tx.now||
        (lease!==undefined&&now>=lease))fail("CLERK_SESSION_REVOKED",401);
      if(appExpires!==undefined&&now>=appExpires)fail("APP_SESSION_EXPIRED",401);
    };
    return new PostgresTransactions(o.pool).runPrepared({
      prepare:async client=>{
        const hint=await locateStudentAccessOnClient(client,digest);
        if(hint.kind!=="person")fail("SESSION_REVOKED",401);return [hint.personId];
      },
      beforeCommit:()=>{if(!flushed)fail("SERVICE_UNAVAILABLE",503);checkLease();},
    },async locked=>{
      tx=locked;const personId=tx.personIds[0],rows=new ClerkAuthRows();
      const scope:ClerkAuthScope={client:tx.client,personId,existing:true,now:tx.now};
      const auth=await rows.load(scope),before=snapshot(combined(structuredClone(auth)),personId),state=combined(auth);
      const authority=combined(structuredClone(auth));
      const authorize=async()=>{
        const current=await authenticate(authority.domain.student,token,await fresh(locked));
        if(current.personId!==personId)fail("SESSION_REVOKED",401);
        const family=authority.domain.student.families[current.familyId];
        appExpires=Math.min(family.expiresAt,authority.domain.student.access[digest].expiresAt);
        checkedAt=await guardBoundFamily({state:authority,now:()=>locked.now,restrictProviderExpiry},o.request,raw,{
          verifier:o.verifier!,liveness:(id,now)=>o.liveness(id,now,{signal:o.request.signal}),
          ...(o.botToken?{legacyTelegram:{botToken:o.botToken}}:{})});
        await fresh(locked);checkLease();
        if(family.authProvider!=="clerk"||!authority.familyBindings[current.familyId])fail("SERVICE_UNAVAILABLE",503);
        return authority.familyBindings[current.familyId];
      };
      // The locator is only a hint. Lock/current proof/person/mapping/fence and
      // uncached provider checks precede the core callback. It remains in auth;
      // the profile transition follows only a successful authorized callback.
      await authorize();
      const value=await work({state,now:()=>{checkLease();return locked.now;},restrictProviderExpiry});
      const identity=await authorize();
      await setTrustedClerk(locked.client,identity.issuer,identity.userId);
      await setTrustedPhase(locked.client,"domain");await authorize();
      const after=snapshot(state,personId),profileOnly={...before,person:after.person?{...before.person!,profile:after.person.profile}:null};
      if(!same(profileOnly,after))fail("RESPONSE_INVARIANT_FAILED",500);
      scope.now=locked.now;await rows.flush(scope,before,after);
      await authorize();flushed=true;return value;
    });
  }
  private async locate(intent:ClerkTransactionIntent):Promise<string>{
    const o=this.options;checkClerkProof(intent.proof,o.now());let client;try{client=await o.pool.connect();}catch{throw new StorageUnavailable("not_committed");}
    if(typeof client?.query!=="function"||typeof client.release!=="function"){if(typeof client?.release==="function")client.release(true);throw new StorageUnavailable("not_committed");}
    let discard=false;
    try{
      await client.query({name:"ua_clerk_locator_begin",text:"BEGIN",values:[]});
      await resetTrustedServerContext(client);await setTrustedPhase(client,"auth");
      await setTrustedClerk(client,intent.proof.issuer,intent.proof.userId);
      const r=await client.query({name:"ua_clerk_locator",text:"SELECT person_id::text FROM ua_private.clerk_identities WHERE issuer=$1 AND subject=$2 AND enabled=true",values:[intent.proof.issuer,intent.proof.userId]});
      if(r.rows.length!==1)fail("CLERK_IDENTITY_REVOKED",401);
      await client.query({name:"ua_clerk_locator_rollback",text:"ROLLBACK",values:[]});return r.rows[0].person_id as string;
    }catch(error){discard=true;throw error;}finally{closeTrustedServerContext(client);client.release(discard);}
  }
  private async staffOrLink<T>(work:(tx:ClerkTransaction)=>Promise<T>,intent:ClerkTransactionIntent):Promise<T>{
    const o=this.options,actorId=await this.locate(intent),targets:string[]=[];
    if(intent.kind==="staff"){
      try{const b=await o.request.clone().json();if(typeof b.student_id==="string")targets.push(b.student_id.toLowerCase());if(Array.isArray(b.student_ids))targets.push(...b.student_ids.map((v:unknown)=>typeof v==="string"?v.toLowerCase():""));}catch{}
    }
    const valid=targets.filter(id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id));
    return new PostgresTransactions(o.pool).run([actorId,...valid],async tx=>{
      await query(tx,"ua_clerk_identity_context","SELECT set_config('ua.clerk_issuer',$1,true),set_config('ua.clerk_subject',$2,true)",[intent.proof.issuer,intent.proof.userId]);
      await query(tx,"ua_clerk_person_context","SELECT set_config('ua.person_id',$1,true)",[actorId]);
      const mapping=await query(tx,"ua_clerk_current_mapping","SELECT person_id::text FROM ua_private.clerk_identities WHERE issuer=$1 AND subject=$2 AND enabled=true AND person_id=$3",[intent.proof.issuer,intent.proof.userId,actorId]);
      if(mapping.rows.length!==1)fail("CLERK_IDENTITY_REVOKED",401);
      const p=(await query(tx,"ua_http_person","SELECT telegram_id::text,enabled,roles,profile FROM ua_private.people WHERE id=$1",[actorId])).rows[0];
      if(!p||typeof p.enabled!=="boolean"||!same(p.roles,(p.profile as {roles:unknown})?.roles))fail("RESPONSE_INVARIANT_FAILED",500);
      const domain=emptyDomain();let rows:StaffFirstTestRows|undefined;
      if(intent.kind==="staff"){
        if(!o.staff)fail("SERVICE_UNAVAILABLE",503);
        rows=new StaffFirstTestRows(o.request.clone(),o.staff.validate);await rows.lock(tx,actorId);
        const current=await new StaffAccessRows().load(tx,{issuer:intent.proof.issuer,subject:intent.proof.userId},actorId,"clerk");
        Object.assign(domain,await rows.load(tx,current));domain.staff={[intent.proof.userId]:current};
      }
      domain.student.people[actorId]={telegramId:p.telegram_id===null?null:integer(p.telegram_id),enabled:p.enabled,profile:p.profile as StudentState["people"][string]["profile"]};
      const state:ClerkCandidateState={domain,identities:{[clerkIdentityKey(intent.proof)]:{personId:actorId,enabled:true}},familyBindings:{},studentSessions:{},consumedTokens:{}};
      const before=structuredClone(domain);await fresh(tx);checkClerkProof(intent.proof,tx.now);
      const value=await work({state,now:()=>tx.now});await fresh(tx);checkClerkProof(intent.proof,tx.now);
      if(!same(state.identities,{[clerkIdentityKey(intent.proof)]:{personId:actorId,enabled:true}})||!same([state.familyBindings,state.studentSessions,state.consumedTokens],[{},{},{}]))fail("RESPONSE_INVARIANT_FAILED",500);
      if(rows)await rows.flush(tx,actorId,before,state.domain);await fresh(tx);checkClerkProof(intent.proof,tx.now);if(o.request.signal.aborted)fail("SERVICE_UNAVAILABLE",503);return value;
    });
  }
}

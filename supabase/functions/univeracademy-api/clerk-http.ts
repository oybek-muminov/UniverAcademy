import {ApiFault,fail} from "./fault.ts";
import {createClerkVerifier,checkClerkProof,requireLiveClerk,clerkIdentityKey,clerkSessionKey} from "./clerk-auth.ts";
import type {ClerkIdentity,ClerkProof,ClerkVerifierConfiguration,ClerkLiveness} from "./clerk-auth.ts";
import {createStudentHttpHandler} from "./student-http.ts";
import {createStaffHttpHandler} from "./staff-http.ts";
import {currentStaff,STAFF_CONTRACT_SHA} from "./staff-state.ts";
import type {StaffAccessRecord,StaffState,VerifiedStaffProof} from "./staff-state.ts";
import {reconcileMembershipEffects} from "./membership-effects.ts";
import {checkSessionPolicy,issueProofs,newQadamId,proofHash,revokeFamily} from "./student-state.ts";
import type {SessionPolicy,NumericPresentation,Person} from "./student-state.ts";
import {profileWire,utc} from "./student-wire.ts";

export type ClerkCandidateState={
  domain:StaffState;
  identities:Record<string,{personId:string;enabled:boolean}>;
  familyBindings:Record<string,ClerkIdentity>;
  studentSessions:Record<string,{personId:string;retiredAt:number|null}>;
  consumedTokens:Record<string,true>;
};
export type ClerkTransaction={state:ClerkCandidateState;now:()=>number;newPersonId?:()=>string};
export type ClerkTransactionIntent={kind:"exchange"|"staff"|"link";proof:ClerkProof};
export type ClerkTransactions={transaction<T>(work:(tx:ClerkTransaction)=>Promise<T>,intent?:ClerkTransactionIntent):Promise<T>};
export type ClerkCandidateDependencies={mode:"local_candidate";transactions:ClerkTransactions;
  verifier:ClerkVerifierConfiguration;liveness:ClerkLiveness;sessionPolicy:SessionPolicy;numericPresentation:NumericPresentation;
  legacyTelegram?:{botToken:string};staff?:{validate:(schema:string,value:unknown)=>boolean;newAssignmentId:()=>string}};

const identity=(p:ClerkProof):ClerkIdentity=>({issuer:p.issuer,userId:p.userId,sessionId:p.sessionId});
function bearer(request:Request):string{
  const token=request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if(!token)fail("CLERK_TOKEN_INVALID",401);return token;
}
function errorResponse(error:unknown):Response{
  const fault=error instanceof ApiFault?error:new ApiFault("INTERNAL_ERROR",500);
  return new Response(JSON.stringify({error:{code:fault.code,message:fault.code,request_id:crypto.randomUUID()}}),
    {status:fault.status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
}
function mapped(state:ClerkCandidateState,id:ClerkIdentity):Person{
  const link=state.identities[clerkIdentityKey(id)],person=link&&state.domain.student.people[link.personId];
  if(!link?.enabled||!person)fail("CLERK_IDENTITY_REVOKED",401);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(link.personId))fail("RESPONSE_INVARIANT_FAILED",500);
  if(person.profile.person_id!==link.personId)fail("RESPONSE_INVARIANT_FAILED",500);
  if(!person.enabled)fail("ACCOUNT_DISABLED",403);
  return person;
}
function retireOtherSessions(state:ClerkCandidateState,personId:string,now:number,except?:string):void{
  for(const [key,s]of Object.entries(state.studentSessions))if(s.personId===personId&&key!==except&&s.retiredAt===null)s.retiredAt=now;
}
function currentStudentSession(state:ClerkCandidateState,id:ClerkIdentity,personId:string):void{
  const record=state.studentSessions[clerkSessionKey(id)];
  if(record&&(record.personId!==personId||record.retiredAt!==null))fail("CLERK_SESSION_SUPERSEDED",401);
}
function ensureStudent(state:ClerkCandidateState,id:ClerkIdentity,policy:SessionPolicy,newPersonId:()=>string=()=>crypto.randomUUID()):Person{
  const key=clerkIdentityKey(id);
  if(Object.hasOwn(state.identities,key)){
    const person=mapped(state,id);if(!person.profile.roles.includes("student"))fail("FORBIDDEN",403);return person;
  }
  for(let n=0;n<policy.identityCollisionAttempts;n++){
    const personId=newPersonId(),qadam=newQadamId();
    if(state.domain.student.people[personId]||Object.values(state.domain.student.people).some(p=>p.profile.qadam_id===qadam))continue;
    const person:Person={telegramId:null,enabled:true,profile:{person_id:personId,first_name:"",last_name:"",roles:["student"],
      registration_complete:false,active_group_id:null,qadam_id:qadam}};
    state.domain.student.people[personId]=person;state.domain.memberships[personId]={affinityGroupId:null,active:false,revision:0,epoch:0};
    state.identities[key]={personId,enabled:true};return person;
  }
  fail("SERVICE_UNAVAILABLE",503);
}
function serverTime(tx:ClerkTransaction,deps:ClerkCandidateDependencies&{signal?:AbortSignal},floor=0):number{
  if(deps.signal?.aborted)fail("SERVICE_UNAVAILABLE",503);
  const lockedAt=tx.now(),now=deps.verifier.now();
  if(!Number.isSafeInteger(lockedAt)||lockedAt<0||!Number.isSafeInteger(now)||now<lockedAt||now<floor)
    fail("SERVICE_UNAVAILABLE",503);
  return now;
}
function checkCurrentTime(tx:ClerkTransaction,proof:ClerkProof,deps:ClerkCandidateDependencies,providerExpires:number,floor:number):number{
  const now=serverTime(tx,deps,floor);checkClerkProof(proof,now);
  if(now>=providerExpires)fail("CLERK_SESSION_REVOKED",401);
  return now;
}
async function verifyCurrentClerk(tx:ClerkTransaction,proof:ClerkProof,deps:ClerkCandidateDependencies){
  const before=serverTime(tx,deps);checkClerkProof(proof,before);
  const providerExpires=await requireLiveClerk(identity(proof),before,deps.liveness);
  const now=checkCurrentTime(tx,proof,deps,providerExpires,before);
  return {now,providerExpires};
}
async function exchange(tx:ClerkTransaction,proof:ClerkProof,deps:ClerkCandidateDependencies){
  const {state}=tx,policy=checkSessionPolicy(deps.sessionPolicy);
  const checked=await verifyCurrentClerk(tx,proof,deps),{providerExpires}=checked,id=identity(proof);
  const digest=await proofHash(JSON.stringify([proof.issuer,proof.userId,proof.sessionId,proof.tokenId]));
  // All provider/clock/digest awaits precede account creation and supersession.
  const now=checkCurrentTime(tx,proof,deps,providerExpires,checked.now);
  const person=ensureStudent(state,id,policy,tx.newPersonId),personId=person.profile.person_id,key=clerkSessionKey(id);
  currentStudentSession(state,id,personId);
  if(state.consumedTokens[digest])fail("CLERK_TOKEN_REPLAY",409);
  const expiresAt=Math.min(now+policy.familyTtlMs,providerExpires);utc(expiresAt);
  if(expiresAt<=now)fail("CLERK_SESSION_REVOKED",401);
  const familyId=crypto.randomUUID();if(state.domain.student.families[familyId])fail("SERVICE_UNAVAILABLE",503);
  // Retired Clerk sessions cannot reclaim the account by refreshing their JWT.
  // Re-entry UX/interactive sign-in protocol is still a separate review item.
  retireOtherSessions(state,personId,now,key);
  state.studentSessions[key]??={personId,retiredAt:null};
  for(const family of Object.values(state.domain.student.families))if(family.personId===personId&&family.revokedAt===null)revokeFamily(family,now,policy);
  state.domain.student.families[familyId]={personId,expiresAt,revokedAt:null,logoutRetainUntil:null,authProvider:"clerk"};
  state.familyBindings[familyId]=id;state.consumedTokens[digest]=true;
  const proofs=await issueProofs(state.domain.student,familyId,now,policy);
  const finishedAt=checkCurrentTime(tx,proof,deps,providerExpires,now);
  if(finishedAt>=proofs.expiresAt)fail("APP_SESSION_EXPIRED",401);
  return {access_token:proofs.accessToken,refresh_token:proofs.refreshToken,expires_at:utc(proofs.expiresAt),
    refresh_expires_at:utc(proofs.refreshExpiresAt),token_type:"Bearer",profile:profileWire(person)};
}
async function familyHint(state:ClerkCandidateState,request:Request,raw:string):Promise<string|undefined>{
  const path=new URL(request.url).pathname;
  const bodyFamily=async()=>{
    try{const body=JSON.parse(raw);return typeof body?.refresh_token==="string"?state.domain.student.refresh[await proofHash(body.refresh_token)]?.familyId:undefined;}catch{return undefined;}
  };
  // Refresh is body-proof only in the core handler. An unrelated Authorization
  // header must never cause its family/provider checks to be skipped or misbound.
  if(request.method==="POST"&&/\/auth\/refresh\/?$/.test(path))return bodyFamily();
  const authorization=request.headers.get("authorization");
  if(authorization!==null){
    const token=authorization.match(/^Bearer ([^\s]+)$/i)?.[1];
    return token?state.domain.student.access[await proofHash(token)]?.familyId:undefined;
  }
  if(request.method!=="POST"||!/\/auth\/logout\/?$/.test(path))return undefined;
  return bodyFamily(); // Logout's bearer-first/no-fallback branch remains above.
}
async function guardBoundFamily(tx:ClerkTransaction,request:Request,raw:string,deps:ClerkCandidateDependencies):Promise<number>{
  const id=await familyHint(tx.state,request,raw),now=serverTime(tx,deps);if(!id)return now;
  const family=tx.state.domain.student.families[id],binding=tx.state.familyBindings[id];
  // Core handler retains its expired/revoked proof and logout tombstone branches.
  if(!family||family.revokedAt!==null||now>=family.expiresAt)return now;
  // Missing Clerk metadata must not be interpreted as a legacy Telegram login.
  // Only a successful server-verified HMAC login below stamps that provenance.
  if(family.authProvider==="telegram"){
    if(Object.hasOwn(tx.state.familyBindings,id)||!deps.legacyTelegram?.botToken)fail("SERVICE_UNAVAILABLE",503);
    return now;
  }
  if(family.authProvider!=="clerk"||!binding)fail("SERVICE_UNAVAILABLE",503);
  if(binding.issuer!==deps.verifier.issuer)fail("CLERK_IDENTITY_REVOKED",401);
  const person=mapped(tx.state,binding);
  if(person.profile.person_id!==family.personId)fail("RESPONSE_INVARIANT_FAILED",500);
  currentStudentSession(tx.state,binding,family.personId);
  if(!tx.state.studentSessions[clerkSessionKey(binding)])fail("RESPONSE_INVARIANT_FAILED",500);
  const providerExpires=await requireLiveClerk(binding,now,deps.liveness),checkedAt=serverTime(tx,deps,now);
  if(checkedAt>=providerExpires)fail("CLERK_SESSION_REVOKED",401);
  return checkedAt;
}
function staffRecord(state:ClerkCandidateState,proof:ClerkProof,now:number):StaffAccessRecord{
  const person=mapped(state,proof),record=state.domain.staff[proof.userId];
  if(!record)fail("FORBIDDEN",403);
  if(record.personId!==person.profile.person_id)fail("RESPONSE_INVARIANT_FAILED",500);
  const current={...record,enabled:person.enabled&&record.enabled,roles:person.profile.roles.filter((r):r is "teacher"|"admin"|"owner"=>r==="teacher"||r==="admin"||r==="owner")};
  return currentStaff({staff:{[proof.userId]:current}},{kind:"staff_verified",subject:proof.userId,notBefore:proof.notBefore,expiresAt:proof.expiresAt},now);
}

// Local contract adapter only. No default store, SDK network client, secret loader,
// provider mutation, SQL bootstrap or change to the existing Supabase JWT verifier.
export function createClerkCandidateHandler(configuration:ClerkCandidateDependencies){
  return async(request:Request):Promise<Response>=>{
    const deps={...configuration,signal:request.signal,liveness:(id:ClerkIdentity,now:number)=>configuration.liveness(id,now,{signal:request.signal})};
    try{
      if(deps?.mode!=="local_candidate"||typeof deps.transactions?.transaction!=="function"||typeof deps.liveness!=="function")fail("SERVICE_UNAVAILABLE",503);
      const path=new URL(request.url).pathname.replace(/\/$/,"");
      if(path==="/api/v1/auth/clerk"&&request.method==="POST"){
        const token=bearer(request),proof=await createClerkVerifier(deps.verifier)(token),raw=await request.text();
        let parsed;try{parsed=JSON.parse(raw);}catch{fail("MALFORMED_JSON",400);}
        if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||Object.keys(parsed).length)fail("VALIDATION_ERROR",422);
        const result=await deps.transactions.transaction(tx=>exchange(tx,proof,deps),{kind:"exchange",proof});
        return new Response(JSON.stringify({data:result}),{status:200,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
      }
      if(path==="/api/v1/auth/telegram/link"&&request.method==="POST"){
        const proof=await createClerkVerifier(deps.verifier)(bearer(request));
        await deps.transactions.transaction(async tx=>{
          await verifyCurrentClerk(tx,proof,deps);mapped(tx.state,proof);
          fail("IDENTITY_LINK_POLICY_UNRESOLVED",409); // No auto merge/email match/link mutation.
        },{kind:"link",proof});
        fail("RESPONSE_INVARIANT_FAILED",500);
      }
      if(path.startsWith("/api/v1/admin/")){
        const token=bearer(request),proof=await createClerkVerifier(deps.verifier)(token),p=deps.staff;
        if(!p||typeof p.validate!=="function"||typeof p.newAssignmentId!=="function")fail("SERVICE_UNAVAILABLE",503);
        const adapted:VerifiedStaffProof={kind:"staff_verified",subject:proof.userId,notBefore:proof.notBefore,expiresAt:proof.expiresAt};
        return await createStaffHttpHandler({contractSha:STAFF_CONTRACT_SHA,validate:p.validate,newAssignmentId:p.newAssignmentId,
          verifyStaffToken:async candidate=>{if(candidate!==token)fail("CLERK_TOKEN_INVALID",401);return adapted;},reconcileMembershipDependencies:reconcileMembershipEffects,
          transactions:{transaction:work=>deps.transactions.transaction(async tx=>{
            const checked=await verifyCurrentClerk(tx,proof,deps);
            const now=checkCurrentTime(tx,proof,deps,checked.providerExpires,checked.now);
            // Approved policy: staff sessions may run in parallel. Student
            // family/sid retirement is never applied to staff authentication.
            const current=staffRecord(tx.state,proof,now);
            const view={...tx.state.domain,staff:{[proof.userId]:current}},before=JSON.stringify(view.staff);
            const outcome=await work({state:view,now:()=>checkCurrentTime(tx,proof,deps,checked.providerExpires,now)});
            checkCurrentTime(tx,proof,deps,checked.providerExpires,now);
            if(JSON.stringify(view.staff)!==before)fail("RESPONSE_INVARIANT_FAILED",500);
            const {staff:_,...domain}=view;Object.assign(tx.state.domain,domain);return outcome;
          },{kind:"staff",proof})}})(request);
      }
      const raw=await request.clone().text();
      return await createStudentHttpHandler({sessionPolicy:deps.sessionPolicy,numericPresentation:deps.numericPresentation,botToken:deps.legacyTelegram?.botToken,
        transactions:{transaction:work=>deps.transactions.transaction(async tx=>{
          const checkedAt=await guardBoundFamily(tx,request,raw,deps);
          const oldIds=new Set(Object.keys(tx.state.domain.student.families));
          const outcome=await work({state:tx.state.domain.student,now:()=>serverTime(tx,deps,checkedAt)});
          if(path==="/api/v1/auth/telegram"&&request.method==="POST")for(const [id,family]of Object.entries(tx.state.domain.student.families))
            if(!oldIds.has(id)&&family.revokedAt===null){
              family.authProvider="telegram";
              retireOtherSessions(tx.state,family.personId,serverTime(tx,deps,checkedAt));
            }
          return outcome;
        })}})(request);
    }catch(error){return errorResponse(error);}
  };
}

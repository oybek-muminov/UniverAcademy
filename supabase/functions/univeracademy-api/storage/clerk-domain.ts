import {fail} from "../fault.ts";
import {checkClerkProof,clerkIdentityKey} from "../clerk-auth.ts";
import type {ClerkLiveness} from "../clerk-auth.ts";
import type {ClerkCandidateState,ClerkTransaction,ClerkTransactionIntent,ClerkTransactions} from "../clerk-http.ts";
import type {SessionPolicy,StudentState} from "../student-state.ts";
import type {StaffState} from "../staff-state.ts";
import {ClerkAuthRows,ClerkScopedAuthStore} from "./clerk-auth-rows.ts";
import type {ClerkAuthSnapshot,ClerkAuthScope} from "./clerk-auth-rows.ts";
import {PostgresTransactions,integer,query,StorageUnavailable} from "./postgres-transaction.ts";
import type {PgPool,LockedTransaction} from "./postgres-transaction.ts";
import {StudentHttpRows} from "./student-http-rows.ts";
import {StudentIdentityRows} from "./student-identity-rows.ts";
import {locateStudent} from "./student-scope.ts";
import {StaffAccessRows} from "./staff-access-rows.ts";
import {StaffFirstTestRows} from "./staff-first-test-rows.ts";

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
type Options={pool:PgPool;request:Request;botToken?:string;sessionPolicy:SessionPolicy;now:()=>number;liveness:ClerkLiveness;
  staff?:{validate:(name:string,value:unknown)=>boolean;newAssignmentId:()=>string}};

// Request-scoped bridge for the existing handlers and relational row ports.
// No whole-database snapshot, RAM fallback, provider constructor or SQL execution
// outside the explicitly injected transaction client.
export class ClerkDomainTransactions implements ClerkTransactions{
  private readonly options:Options;
  constructor(options:Options){if(typeof options.pool?.connect!=="function"||typeof options.liveness!=="function")throw new StorageUnavailable("not_committed");this.options={...options,request:options.request.clone()};}
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
  private async locate(intent:ClerkTransactionIntent):Promise<string>{
    const o=this.options;checkClerkProof(intent.proof,o.now());let client;try{client=await o.pool.connect();}catch{throw new StorageUnavailable("not_committed");}
    if(typeof client?.query!=="function"||typeof client.release!=="function"){if(typeof client?.release==="function")client.release(true);throw new StorageUnavailable("not_committed");}
    let discard=false;
    try{
      await client.query({name:"ua_clerk_locator_begin",text:"BEGIN",values:[]});
      await client.query({name:"ua_clerk_identity_context",text:"SELECT set_config('ua.clerk_issuer',$1,true),set_config('ua.clerk_subject',$2,true)",values:[intent.proof.issuer,intent.proof.userId]});
      const r=await client.query({name:"ua_clerk_locator",text:"SELECT person_id::text FROM ua_private.clerk_identities WHERE issuer=$1 AND subject=$2 AND enabled=true",values:[intent.proof.issuer,intent.proof.userId]});
      if(r.rows.length!==1)fail("CLERK_IDENTITY_REVOKED",401);
      await client.query({name:"ua_clerk_locator_rollback",text:"ROLLBACK",values:[]});return r.rows[0].person_id as string;
    }catch(error){discard=true;throw error;}finally{client.release(discard);}
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

import { ApiFault,fail } from "./fault.ts";
import { createStudentHttpHandler } from "./student-http.ts";
import { createStaffHttpHandler } from "./staff-http.ts";
import { checkSessionPolicy } from "./student-state.ts";
import type { NumericPresentation,SessionPolicy } from "./student-state.ts";
import type { StaffState } from "./staff-state.ts";
import { PostgresTransactions } from "./storage/postgres-transaction.ts";
import type { LockedTransaction,PgPool } from "./storage/postgres-transaction.ts";
import { StudentHttpRows } from "./storage/student-http-rows.ts";
import { locateStudent } from "./storage/student-scope.ts";
import { StudentIdentityRows } from "./storage/student-identity-rows.ts";
import { StaffAccessRows } from "./storage/staff-access-rows.ts";
import { StaffFirstTestRows } from "./storage/staff-first-test-rows.ts";
import { reconcileMembershipEffects } from "./membership-effects.ts";
import { STAFF_CONTRACT_SHA } from "./staff-state.ts";
import type { StaffJwtProof } from "./staff-jwt.ts";
import type {ClerkCandidateDependencies} from "./clerk-http.ts";
import {PreparedStudentTransactions,isFirstStudentRequest,isLegacyStudentRequest} from "./storage/prepared-student.ts";

type StaffPorts={jwt:Parameters<typeof import("./staff-jwt.ts").createStaffJwtVerifier>[0];
  resolvePersons?:(request:Request,proof:StaffJwtProof)=>Promise<readonly string[]>;
  liveness:Parameters<typeof import("./staff-jwt.ts").requireLiveStaff>[3];
  validate:(schema:string,value:unknown)=>boolean;newAssignmentId:()=>string} &
  ({domain:"first_test_relational";load?:never;flush?:never} |
   {domain?:undefined;load:(tx:LockedTransaction,proof:StaffJwtProof)=>Promise<StaffState>;
    flush:(tx:LockedTransaction,before:StaffState,after:StaffState)=>Promise<void>});
export type HttpConfiguration={mode:"production"|"local_contract";
  storage:{kind:"postgres"|"postgres_contract_double";pool:PgPool};botToken?:string;
  clerk?:Pick<ClerkCandidateDependencies,"verifier"|"liveness"|"staff">;
  sessionPolicy:SessionPolicy;numericPresentation:NumericPresentation;now:()=>number;staff?:StaffPorts};
function ready(config:HttpConfiguration):void{
  if(!config||!["production","local_contract"].includes(config.mode)||
    !config.storage||typeof config.storage.pool?.connect!=="function"||
    (config.mode==="production"&&config.storage.kind!=="postgres")||
    (config.mode==="local_contract"&&!["postgres","postgres_contract_double"].includes(config.storage.kind))||
    ((!config.clerk)&&(typeof config.botToken!=="string"||!config.botToken))||typeof config.now!=="function") fail("SERVICE_UNAVAILABLE",503);
  checkSessionPolicy(config.sessionPolicy);
  const n=config.numericPresentation;
  if(!n?.policyId||typeof n.toFiniteNumber!=="function"||typeof n.toDisplayString!=="function"||
    typeof n.toStudentPointsDisplayString!=="function") fail("SERVICE_UNAVAILABLE",503);
}
async function affectedPeople(request:Request):Promise<string[]>{
  const path=new URL(request.url).pathname,transfer=path.match(/^\/api\/v1\/admin\/students\/([^/]+)\/transfer\/?$/);
  const hints:unknown[]=transfer?[transfer[1]]:[];
  if((/\/admin\/groups\/[^/]+\/members\/?$/.test(path)&&request.method==="PUT")||(/\/admin\/assignments\/?$/.test(path)&&request.method==="POST")){
    // Hints only. Malformed/schema-invalid input is rejected by the existing
    // handler; it cannot become a mutation by omitting a locator hint.
    try{const body=await request.json();if(path.includes("/members"))hints.push(body?.student_id);else if(Array.isArray(body?.student_ids))hints.push(...body.student_ids);}catch{}
  }
  return [...new Set(hints.filter((id):id is string=>typeof id==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)).map(id=>id.toLowerCase()))];
}
// No fixture imports, default store, synthesized account or storage fallback.
export function createConfiguredHttpHandler(config:HttpConfiguration){
  return async(request:Request):Promise<Response>=>{
    try{
      ready(config);
      if(!new URL(request.url).pathname.startsWith("/api/v1/"))fail("NOT_FOUND",404);
      if(config.clerk){
        const [{createClerkCandidateHandler},{ClerkDomainTransactions}]=await Promise.all([import("./clerk-http.ts"),import("./storage/clerk-domain.ts")]);
        if(typeof config.clerk.liveness!=="function"||!config.clerk.verifier)fail("SERVICE_UNAVAILABLE",503);
        return await createClerkCandidateHandler({mode:"local_candidate",...config.clerk,
          sessionPolicy:config.sessionPolicy,numericPresentation:config.numericPresentation,
          ...(config.botToken?{legacyTelegram:{botToken:config.botToken}}:{}),
          transactions:new ClerkDomainTransactions({pool:config.storage.pool,request,botToken:config.botToken,
            sessionPolicy:config.sessionPolicy,now:config.now,liveness:config.clerk.liveness,verifier:config.clerk.verifier,staff:config.clerk.staff})})(request);
      }
      const runner=new PostgresTransactions(config.storage.pool);
      if(new URL(request.url).pathname.startsWith("/api/v1/admin/")){
        const {createStaffJwtVerifier,requireLiveStaff}=await import("./staff-jwt.ts");
        const p=config.staff;
        if(!p||(p.resolvePersons!==undefined&&typeof p.resolvePersons!=="function")||
          !(p.domain==="first_test_relational"||(p.domain===undefined&&typeof p.load==="function"&&typeof p.flush==="function"))||
          typeof p.liveness!=="function"||typeof p.validate!=="function"||typeof p.newAssignmentId!=="function") fail("SERVICE_UNAVAILABLE",503);
        const raw=request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
        if(!raw)fail("STAFF_TOKEN_INVALID",401);
        const proof=await createStaffJwtVerifier(p.jwt)(raw);
        const accessRows=new StaffAccessRows(),actorId=await accessRows.locate(config.storage.pool,proof);
        const persons=[actorId,...await affectedPeople(request.clone()),...(p.resolvePersons?await p.resolvePersons(request.clone(),proof):[])];
        const relational=p.domain==="first_test_relational"?new StaffFirstTestRows(request.clone(),p.validate):null;
        const handler=createStaffHttpHandler({contractSha:STAFF_CONTRACT_SHA,validate:p.validate,newAssignmentId:p.newAssignmentId,
          verifyStaffToken:async(candidate)=>{if(candidate!==raw)fail("STAFF_TOKEN_INVALID",401);return proof;},reconcileMembershipDependencies:reconcileMembershipEffects,
          transactions:{transaction:work=>runner.run(persons,async tx=>{
            let current=await accessRows.load(tx,proof,actorId);
            await requireLiveStaff(tx,proof,{staff:{[proof.subject]:current}},p.liveness);
            if(relational){
              await relational.lock(tx,actorId);
              // Group/version locks can wait: times and current permissions are
              // checked again against a fresh DB clock before private reads.
              current=await accessRows.load(tx,proof,actorId);
              await requireLiveStaff(tx,proof,{staff:{[proof.subject]:current}},p.liveness);
            }
            const state=relational?await relational.load(tx,current):await p.load!(tx,proof);
            state.staff={[proof.subject]:current}; // Never trust a cached projection or token role.
            const before=structuredClone(state);
            const outcome=await work({state,now:()=>tx.now});
            if(JSON.stringify(before.staff)!==JSON.stringify(state.staff))fail("RESPONSE_INVARIANT_FAILED",500);
            if(relational)await relational.flush(tx,actorId,before,state);else await p.flush!(tx,before,state);
            return outcome;
          })}});
        return await handler(request);
      }
      if(isFirstStudentRequest(request)){
        const captured=request.clone();
        return await createStudentHttpHandler({botToken:config.botToken,sessionPolicy:config.sessionPolicy,
          numericPresentation:config.numericPresentation,
          transactions:new PreparedStudentTransactions(config.storage.pool,captured)})(captured);
      }
      if(!isLegacyStudentRequest(request))fail("NOT_FOUND",404);
      const legacy={...config,botToken:config.botToken!};
      const scope=await locateStudent(config.storage.pool,request.clone(),legacy);
      const rows=new StudentHttpRows();
      return await createStudentHttpHandler({botToken:config.botToken,sessionPolicy:config.sessionPolicy,
        numericPresentation:config.numericPresentation,transactions:{transaction:work=>{
          const perform=async(tx:LockedTransaction)=>{
            const personId=tx.personIds[0],state=await rows.load(tx,personId),before=structuredClone(state);
            const outcome=await work({state,now:()=>tx.now});await rows.flush(tx,personId,before,state);return outcome;
          };
          return scope.kind==="telegram"?runner.runIdentity(scope.telegramId,gate=>new StudentIdentityRows().ensure(gate,scope.initData,legacy),perform):runner.run([scope.personId],perform);
        }}})(request);
    }catch(error){
      const fault=error instanceof ApiFault?error:new ApiFault("INTERNAL_ERROR",500);
      return new Response(JSON.stringify({error:{code:fault.code,message:fault.code,request_id:crypto.randomUUID()}}),
        {status:fault.status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
    }
  };
}

import {ApiFault,fail} from "../fault.ts";
import {checkClerkProof,clerkIdentityKey,clerkSessionKey,requireLiveClerk} from "../clerk-auth.ts";
import type {ClerkIdentity,ClerkProof,ClerkLiveness,ClerkVerifierConfiguration} from "../clerk-auth.ts";
import {checkSessionPolicy,issueProofs} from "../student-state.ts";
import type {SessionPolicy,StudentState} from "../student-state.ts";
import {profileWire,utc} from "../student-wire.ts";
import {checkTelegramLaunch,createTelegramStartLookup,verifyTelegramLaunch} from "../telegram-return.ts";
import type {TelegramLaunch,TelegramReturnPort,TelegramSession} from "../telegram-return.ts";
import {ClerkAuthRows} from "./clerk-auth-rows.ts";
import type {ClerkAuthSnapshot,ClerkAuthScope} from "./clerk-auth-rows.ts";
import {integer,StorageUnavailable} from "./postgres-transaction.ts";
import type {PgClient,PgPool} from "./postgres-transaction.ts";
import {canonicalPersonId,resetTrustedServerContext,setTrustedPhase,setTrustedPeople,setTrustedClerk,closeTrustedServerContext} from "./trusted-server-context.ts";

type Options={pool:PgPool;botToken?:string;sessionPolicy:SessionPolicy;now:()=>number;verifier?:ClerkVerifierConfiguration;liveness:ClerkLiveness;signal?:AbortSignal};
type Hint={personId:string;enabled:boolean;identity:Pick<ClerkIdentity,"issuer"|"userId">|null;identityEnabled:boolean|null};
function unavailable():never{throw new StorageUnavailable("not_committed");}
const validSubject=(v:unknown):v is string=>typeof v==="string"&&/^user_[A-Za-z0-9]+(?![\s\S])/.test(v);
const validSid=(v:unknown):v is string=>typeof v==="string"&&/^sess_[A-Za-z0-9]+(?![\s\S])/.test(v);
function origin(v:unknown):v is string{try{return typeof v==="string"&&v.startsWith("https://")&&new URL(v).origin===v;}catch{return false;}}
function storageError(error:unknown):never{
  if(error instanceof ApiFault){if(error.code==="RESPONSE_INVARIANT_FAILED")unavailable();throw error;}
  unavailable();
}
const stmt=(c:PgClient,name:string,text:string,values:readonly unknown[]=[])=>c.query({name,text,values});
async function clock(c:PgClient):Promise<number>{const r=await stmt(c,"ua_telegram_clock","SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms");if(r.rows.length!==1)unavailable();return integer(r.rows[0].now_ms);}
async function checkout(pool:PgPool):Promise<PgClient>{
  let c:PgClient;try{c=await pool.connect();}catch{unavailable();}
  if(typeof c?.query!=="function"||typeof c.release!=="function"){
    if(typeof c?.release==="function")try{c.release(true);}catch{}unavailable();
  }return c;
}
function release(c:PgClient,discard:boolean){try{c.release(discard);}catch{/* One attempt only; never turn uncertainty into retry. */}}
async function hints(c:PgClient,telegramUserId:number,issuer:string):Promise<Hint[]>{
  const r=await stmt(c,"ua_telegram_hint","SELECT person_id::text,person_enabled,issuer,subject,identity_enabled FROM ua_private.locate_telegram_return($1::bigint,$2::text)",[telegramUserId,issuer]);
  if(r.rows.length>2)unavailable();const ids=new Set<string>();
  return r.rows.map(row=>{
    if(Object.keys(row).sort().join(",")!=="identity_enabled,issuer,person_enabled,person_id,subject"||!canonicalPersonId(row.person_id)||typeof row.person_enabled!=="boolean")unavailable();
    ids.add(row.person_id);if(ids.size>1)unavailable();
    const empty=row.issuer===null&&row.subject===null&&row.identity_enabled===null;
    if(!empty&&(row.issuer!==issuer||!origin(row.issuer)||!validSubject(row.subject)||typeof row.identity_enabled!=="boolean"))unavailable();
    // SID is not guessed by this preliminary hint. It is selected only from a
    // current persisted family/fence after both identity gates and person locks.
    return {personId:row.person_id,enabled:row.person_enabled,identity:empty?null:{issuer:row.issuer as string,userId:row.subject as string},identityEnabled:row.identity_enabled as boolean|null};
  });
}
function uniqueIdentity(rows:Hint[]):Pick<ClerkIdentity,"issuer"|"userId">{
  if(!rows.length)fail("TELEGRAM_LINK_REQUIRED",409);
  if(rows.some(r=>!r.enabled))fail("ACCOUNT_DISABLED",403);
  const candidates=rows.filter(r=>r.identity!==null);
  if(candidates.length===0)fail("CLERK_SESSION_REVOKED",401);
  if(candidates.length!==1)unavailable();
  if(!candidates[0].identityEnabled)fail("CLERK_IDENTITY_REVOKED",401);
  return candidates[0].identity!;
}
function student(auth:ClerkAuthSnapshot):StudentState{
  return {people:auth.person?{[auth.person.profile.person_id]:auth.person}:{},families:auth.families,access:auth.access,refresh:auth.refresh,consumedInitData:{},grants:{},assignments:{},series:{},attempts:{},receipts:{},bonuses:{},cancellations:{}};
}
function familyAuthority(auth:ClerkAuthSnapshot,personId:string,identity:Pick<ClerkIdentity,"issuer"|"userId">,now:number):{familyId:string;identity:ClerkIdentity}{
  const matches=[];
  for(const [familyId,f]of Object.entries(auth.families)){
    if(f.personId!==personId)unavailable();
    if(f.authProvider!=="clerk"||f.revokedAt!==null||now>=f.expiresAt)continue;
    const binding=auth.familyBindings[familyId];
    if(!binding||binding.issuer!==identity.issuer||binding.userId!==identity.userId||!validSid(binding.sessionId))unavailable();
    const map=auth.identities[clerkIdentityKey(binding)],fence=auth.studentSessions[clerkSessionKey(binding)];
    if(!map?.enabled||map.personId!==personId)fail("CLERK_IDENTITY_REVOKED",401);
    if(!fence||fence.personId!==personId)unavailable();
    if(fence.retiredAt!==null)continue;matches.push({familyId,identity:binding});
  }
  if(!matches.length)fail("CLERK_SESSION_REVOKED",401);
  if(matches.length!==1)unavailable();return matches[0];
}

// Trusted, request-owned adapter. No provider/driver constructor, configuration
// discovery, provisioning path, retry or public lookup endpoint is present.
export class TelegramReturnRows implements TelegramReturnPort{
  private readonly o:Options;
  constructor(options:Options){this.o=options;}
  readonly start=createTelegramStartLookup(id=>this.lookup(id));
  private async lookup(id:number):Promise<unknown>{
    const c=await checkout(this.o.pool);let began=false,discard=false;
    try{
      await stmt(c,"ua_telegram_lookup_begin","BEGIN READ ONLY");began=true;
      await resetTrustedServerContext(c);await setTrustedPhase(c,"auth");
      const r=await stmt(c,"ua_telegram_start","SELECT state FROM ua_private.lookup_telegram_start($1::bigint)",[id]);
      if(r.rows.length!==1||Object.keys(r.rows[0]).join(",")!=="state")unavailable();
      began=false;await stmt(c,"ua_telegram_rollback","ROLLBACK");return r.rows[0].state;
    }catch(error){if(began){try{await stmt(c,"ua_telegram_rollback","ROLLBACK");}catch{discard=true;}}else discard=true;storageError(error);}
    finally{closeTrustedServerContext(c);release(c,discard);}
  }
  async link(proof:ClerkProof,raw:string):Promise<{ok:true}>{return this.run("link",raw,proof) as Promise<{ok:true}>;}
  async resume(raw:string):Promise<TelegramSession>{return this.run("resume",raw) as Promise<TelegramSession>;}
  private async run(kind:"link"|"resume",raw:string,proof?:ClerkProof):Promise<{ok:true}|TelegramSession>{
    const o=this.o,policy=checkSessionPolicy(o.sessionPolicy);if(!o.botToken||!o.verifier||typeof o.liveness!=="function")unavailable();
    const launch=await verifyTelegramLaunch(raw,o.botToken,policy,o.now());
    if(kind==="link"){
      if(!proof||proof.issuer!==o.verifier.issuer)fail("CLERK_TOKEN_INVALID",401);
      checkClerkProof(proof,o.now());
    }
    const c=await checkout(o.pool);let began=false,committing=false,discard=false,time=0,lease:number|undefined,familyDeadline:number|undefined,accessDeadline:number|undefined;
    const check=()=>{
      const now=o.now();if(o.signal?.aborted||!Number.isSafeInteger(now)||now<time)unavailable();
      checkTelegramLaunch(launch,now,policy);if(proof)checkClerkProof(proof,now);
      if(lease!==undefined&&now>=lease)fail("CLERK_SESSION_REVOKED",401);
      if(familyDeadline!==undefined&&now>=familyDeadline)fail("CLERK_SESSION_REVOKED",401);
      if(accessDeadline!==undefined&&now>=accessDeadline)fail("APP_SESSION_EXPIRED",401);time=now;
    };
    const fresh=async()=>{const now=await clock(c);if(now<time)unavailable();time=now;check();};
    const live=async(id:ClerkIdentity)=>{
      await fresh();const expires=await requireLiveClerk(id,time,(who,at)=>o.liveness(who,at,{signal:o.signal}));
      lease=lease===undefined?expires:Math.min(lease,expires);await fresh();
    };
    try{
      await stmt(c,"ua_telegram_begin","BEGIN");began=true;
      await resetTrustedServerContext(c);await setTrustedPhase(c,"auth");await fresh();
      const preliminary=kind==="resume"?await hints(c,launch.telegramUserId,o.verifier.issuer):[];
      const identity=proof??uniqueIdentity(preliminary);
      // EXACT cross-flow ordering: Clerk advisory -> Telegram advisory -> Clerk
      // mapping row lock -> ordered people locks -> authoritative scoped reload.
      await stmt(c,"ua_telegram_clerk_gate","SELECT pg_advisory_xact_lock(1430348620,hashtext($1))",[clerkIdentityKey(identity)]);
      await stmt(c,"ua_telegram_gate","SELECT pg_advisory_xact_lock($1::bigint)",[(-BigInt(launch.telegramUserId)).toString()]);
      const currentHints=await hints(c,launch.telegramUserId,o.verifier.issuer);
      if(kind==="resume"){
        const current=uniqueIdentity(currentHints);if(current.issuer!==identity.issuer||current.userId!==identity.userId||currentHints[0].personId!==preliminary[0].personId)unavailable();
      }
      await setTrustedClerk(c,identity.issuer,identity.userId);
      const mapping=await stmt(c,"ua_telegram_mapping_lock","SELECT person_id::text,enabled FROM ua_private.lock_clerk_identity($1::text,$2::text)",[identity.issuer,identity.userId]);
      if(!mapping.rows.length)fail("CLERK_IDENTITY_REVOKED",401);
      if(mapping.rows.length!==1||Object.keys(mapping.rows[0]).sort().join(",")!=="enabled,person_id"||!canonicalPersonId(mapping.rows[0].person_id)||typeof mapping.rows[0].enabled!=="boolean")unavailable();
      if(!mapping.rows[0].enabled)fail("CLERK_IDENTITY_REVOKED",401);const personId=mapping.rows[0].person_id;
      const ids=[...new Set([personId,...currentHints.map(h=>h.personId)])].sort();await setTrustedPeople(c,ids);
      const locked=await stmt(c,"ua_telegram_people_lock","SELECT id::text FROM ua_private.lock_people($1::uuid[]) ORDER BY id",[ids]);
      if(locked.rows.length!==ids.length||locked.rows.some((r,i)=>r.id!==ids[i]||Object.keys(r).join(",")!=="id"))unavailable();
      await fresh();if(currentHints.some(h=>h.personId!==personId))fail("IDENTITY_LINK_CONFLICT",409);
      const rows=new ClerkAuthRows(),scope:ClerkAuthScope={client:c,personId,existing:true,now:time};
      if(kind==="link"){
        scope.identity=proof;
        const fence=await stmt(c,"ua_telegram_link_fence","SELECT person_id::text,retired_at_ms::text FROM ua_private.clerk_student_sessions WHERE issuer=$1 AND subject=$2 AND sid=$3",[proof!.issuer,proof!.userId,proof!.sessionId]);
        if(fence.rows.length>1)unavailable();if(fence.rows.length){const r=fence.rows[0];if(Object.keys(r).sort().join(",")!=="person_id,retired_at_ms"||r.person_id!==personId)unavailable();if(r.retired_at_ms!==null){integer(r.retired_at_ms);fail("CLERK_SESSION_SUPERSEDED",401);}}
      }
      const selectedFamily=kind==="resume"?await this.resumeFamily(c,personId,identity,time):undefined;
      const auth=await rows.load(scope,selectedFamily?{familyId:selectedFamily,revocationOnly:false}:undefined),before=structuredClone(auth),person=auth.person!;
      if(!auth.identities[clerkIdentityKey(identity)]?.enabled||auth.identities[clerkIdentityKey(identity)].personId!==personId)fail("CLERK_IDENTITY_REVOKED",401);
      let result:{ok:true}|TelegramSession;
      if(kind==="link"){
        if(person.telegramId!==null&&person.telegramId!==launch.telegramUserId)fail("IDENTITY_LINK_CONFLICT",409);
        await live(proof!);
        if(person.telegramId===launch.telegramUserId){
          // Exact pair is idempotent, including a launch/JTI used at exchange or
          // a previous link. No replay write, session issuance or identity DML.
          result={ok:true};
        }else{
          await setTrustedPhase(c,"exchange");await fresh();
          const linked=await stmt(c,"ua_telegram_link","SELECT state FROM ua_private.link_telegram_identity($1::uuid,$2::bigint)",[personId,launch.telegramUserId]);
          if(linked.rows.length!==1||Object.keys(linked.rows[0]).join(",")!=="state")unavailable();
          if(linked.rows[0].state==="conflict")fail("IDENTITY_LINK_CONFLICT",409);
          if(linked.rows[0].state!=="linked")unavailable();
          await this.consume(c,launch,personId,time);result={ok:true};
        }
        await live(proof!);
      }else{
        if(person.telegramId!==launch.telegramUserId)unavailable();
        const eligible=familyAuthority(auth,personId,identity,time);familyDeadline=auth.families[eligible.familyId].expiresAt;
        await live(eligible.identity);await setTrustedPhase(c,"exchange");await fresh();
        await this.consume(c,launch,personId,time);
        for(const p of Object.values(auth.access))if(p.familyId===eligible.familyId)p.superseded=true;
        for(const p of Object.values(auth.refresh))if(p.familyId===eligible.familyId)p.consumed=true;
        // All other families/rows stay byte-exact. Existing row port checks the
        // session-only write allowlist; no profile/member/fence/JTI flush occurs.
        const view=student(auth),issued=await issueProofs(view,eligible.familyId,time,policy);accessDeadline=issued.expiresAt;
        await live(eligible.identity);scope.now=time;
        // flushSession expects only the selected family; retained other families
        // are excluded equally from before/after, never written or repaired.
        const narrow=(s:ClerkAuthSnapshot):ClerkAuthSnapshot=>({...s,families:{[eligible.familyId]:s.families[eligible.familyId]},
          familyBindings:{[eligible.familyId]:s.familyBindings[eligible.familyId]},
          access:Object.fromEntries(Object.entries(s.access).filter(([,p])=>p.familyId===eligible.familyId)),
          refresh:Object.fromEntries(Object.entries(s.refresh).filter(([,p])=>p.familyId===eligible.familyId))});
        await rows.flushSession(scope,narrow(before),narrow(auth),eligible.familyId,"refresh");
        await live(eligible.identity);
        result={access_token:issued.accessToken,refresh_token:issued.refreshToken,expires_at:utc(issued.expiresAt),refresh_expires_at:utc(issued.refreshExpiresAt),token_type:"Bearer",profile:profileWire(person)};
      }
      await fresh();check();committing=true;await stmt(c,"ua_telegram_commit","COMMIT");began=false;return result;
    }catch(error){
      if(committing){discard=true;throw new StorageUnavailable("commit_unknown");}
      if(began){try{await stmt(c,"ua_telegram_rollback","ROLLBACK");}catch{discard=true;}}else discard=true;storageError(error);
    }finally{closeTrustedServerContext(c);release(c,discard);}
  }
  private async resumeFamily(c:PgClient,personId:string,identity:Pick<ClerkIdentity,"issuer"|"userId">,now:number):Promise<string>{
    const r=await stmt(c,"ua_telegram_resume_family","SELECT f.id::text,f.expires_at_ms::text,b.issuer,b.subject,b.sid,s.person_id::text AS fence_person_id,s.retired_at_ms::text FROM ua_private.student_families f LEFT JOIN ua_private.clerk_family_bindings b ON b.family_id=f.id LEFT JOIN ua_private.clerk_student_sessions s ON s.issuer=b.issuer AND s.subject=b.subject AND s.sid=b.sid WHERE f.person_id=$1 AND f.auth_provider='clerk' AND f.revoked_at_ms IS NULL AND f.expires_at_ms>$2 ORDER BY f.id",[personId,now]);
    if(!r.rows.length)fail("CLERK_SESSION_REVOKED",401);if(r.rows.length!==1)unavailable();const row=r.rows[0];
    if(Object.keys(row).sort().join(",")!=="expires_at_ms,fence_person_id,id,issuer,retired_at_ms,sid,subject"||!canonicalPersonId(row.id)||!origin(row.issuer)||!validSubject(row.subject)||!validSid(row.sid)||row.fence_person_id!==personId)unavailable();
    if(row.retired_at_ms!==null)integer(row.retired_at_ms);
    if(integer(row.expires_at_ms)<=now||row.issuer!==identity.issuer||row.subject!==identity.userId||row.retired_at_ms!==null)fail("CLERK_SESSION_REVOKED",401);
    return row.id;
  }
  private async consume(c:PgClient,launch:TelegramLaunch,personId:string,now:number){
    const r=await stmt(c,"ua_telegram_consume","INSERT INTO ua_private.init_data_replays(digest,person_id,consumed_at_ms) VALUES($1,$2,$3) ON CONFLICT(digest) DO NOTHING RETURNING digest",[launch.replayDigest,personId,now]);
    if(r.rowCount!==1)fail("INIT_DATA_REPLAY",409);
    if(r.rows.length!==1||r.rows[0].digest!==launch.replayDigest)unavailable();
  }
}

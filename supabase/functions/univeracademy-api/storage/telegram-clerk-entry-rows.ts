import {fail} from '../fault.ts';
import {exchangeClerkSession} from '../clerk-http.ts';
import type {ClerkCandidateState,ClerkCandidateDependencies} from '../clerk-http.ts';
import {clerkIdentityKey,clerkReplayIdentity} from '../clerk-auth.ts';
import type {FreshDeletionProof} from '../account-deletion.ts';
import {requireFreshDeletionProof} from '../account-deletion.ts';
import {verifyTelegramLaunch,checkTelegramLaunch} from '../telegram-return.ts';
import type {TelegramSession} from '../telegram-return.ts';
import {proofHash} from '../student-state.ts';
import type {PgPool,PgClient} from './postgres-transaction.ts';
import {integer,StorageUnavailable} from './postgres-transaction.ts';
import {ClerkAuthRows} from './clerk-auth-rows.ts';
import type {ClerkAuthSnapshot,ClerkAuthScope} from './clerk-auth-rows.ts';
import {canonicalPersonId,resetTrustedServerContext,setTrustedPhase,setTrustedPeople,setTrustedClerk,closeTrustedServerContext} from './trusted-server-context.ts';
const q=(c:PgClient,name:string,text:string,values:readonly unknown[]=[])=>c.query({name,text,values});
const unavailable=():never=>{throw new StorageUnavailable('not_committed');};
const combine=(s:ClerkAuthSnapshot):ClerkCandidateState=>({
 domain:{student:{people:s.person?{[s.person.profile.person_id]:s.person}:{},families:s.families,access:s.access,refresh:s.refresh,consumedInitData:{},grants:{},assignments:{},series:{},attempts:{},receipts:{},bonuses:{},cancellations:{}},
  staff:{},groups:{},memberships:s.person&&s.membership?{[s.person.profile.person_id]:s.membership}:{},versions:{},recoveryAssignments:{},notifications:{},approvals:{},receipts:{},audit:[]},
 identities:s.identities,familyBindings:s.familyBindings,studentSessions:s.studentSessions,consumedTokens:s.consumedTokens});
const snapshot=(s:ClerkCandidateState,id:string):ClerkAuthSnapshot=>({person:s.domain.student.people[id],membership:s.domain.memberships[id],identities:s.identities,familyBindings:s.familyBindings,studentSessions:s.studentSessions,consumedTokens:s.consumedTokens,families:s.domain.student.families,access:s.domain.student.access,refresh:s.domain.student.refresh});
type Options={pool:PgPool;botToken:string;deps:ClerkCandidateDependencies;signal?:AbortSignal;newPersonId?:()=>string};
/** Review-only atomic Telegram entry. Neither app token nor cabinet is returned
 * until Clerk provisioning, Telegram link and both replay records commit. The
 * old web exchange and old Telegram link are not invoked by this operation. */
export class TelegramClerkEntryRows{
 private readonly o:Options;
 constructor(o:Options){this.o=o;}
 async enter(verified:FreshDeletionProof,raw:string):Promise<TelegramSession>{
  const o=this.o,{proof}=verified,policy=o.deps.sessionPolicy;
  if(proof.issuer!==o.deps.verifier.issuer)fail('CLERK_TOKEN_INVALID',401);
  requireFreshDeletionProof(verified,o.deps.verifier.now());
  const launch=await verifyTelegramLaunch(raw,o.botToken,policy,o.deps.verifier.now());
  const c:PgClient=await o.pool.connect().catch(()=>{throw new StorageUnavailable('not_committed');});
  let began=false,committing=false,discard=false,time=0;
  const fresh=async()=>{
   if(o.signal?.aborted)unavailable();
   const result=await q(c,'ua_atomic_clock','SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms');
   if(result.rows.length!==1)unavailable();const db=integer(result.rows[0].now_ms),now=o.deps.verifier.now();
   if(db<time||now<db)unavailable();time=now;requireFreshDeletionProof(verified,time);checkTelegramLaunch(launch,time,policy);
  };
  try{
   await q(c,'ua_atomic_begin','BEGIN');began=true;
   await resetTrustedServerContext(c);await setTrustedPhase(c,'auth');await fresh();
   // Same cross-flow lock order as TelegramReturnRows and ClerkScopedAuthStore.
   await q(c,'ua_atomic_identity_gate','SELECT pg_advisory_xact_lock(1430348620,hashtext($1))',[clerkIdentityKey(proof)]);
   await q(c,'ua_atomic_telegram_gate','SELECT pg_advisory_xact_lock($1::bigint)',[(-BigInt(launch.telegramUserId)).toString()]);
   const hints=await q(c,'ua_atomic_telegram_owner','SELECT person_id::text,person_enabled,issuer,subject,identity_enabled FROM ua_private.locate_telegram_return($1::bigint,$2::text)',[launch.telegramUserId,proof.issuer]);
   await setTrustedClerk(c,proof.issuer,proof.userId);
   const mapped=await q(c,'ua_atomic_mapping','SELECT person_id::text,enabled FROM ua_private.lock_clerk_identity($1::text,$2::text)',[proof.issuer,proof.userId]);
   if(mapped.rows.length>1)unavailable();
   const mapping=mapped.rows[0];
   if(mapping&&(!canonicalPersonId(mapping.person_id)||typeof mapping.enabled!=='boolean'))unavailable();
   if(mapping?.enabled===false)fail('CLERK_IDENTITY_REVOKED',401);
   if(hints.rows.length>1)fail('IDENTITY_LINK_CONFLICT',409);
   const hint=hints.rows[0];
   if(hint&&(!canonicalPersonId(hint.person_id)||typeof hint.person_enabled!=='boolean'))unavailable();
   // A Telegram identity already owned by another profile cannot provision or
   // exchange this cached Clerk account, even transiently in the transaction.
   if(hint&&(!mapping||hint.person_id!==mapping.person_id||hint.issuer!==proof.issuer||hint.subject!==proof.userId))fail('IDENTITY_LINK_CONFLICT',409);
   if(hint&&(!hint.person_enabled||hint.identity_enabled!==true))fail('ACCOUNT_DISABLED',403);
   const candidate=mapping?mapping.person_id:(o.newPersonId??(()=>crypto.randomUUID()))();
   if(typeof candidate!=='string')throw new StorageUnavailable('not_committed');
   const personId=candidate;
   if(!canonicalPersonId(personId))unavailable();
   await setTrustedPeople(c,[personId]);
   if(mapping){const locked=await q(c,'ua_atomic_person_lock','SELECT id::text FROM ua_private.lock_people($1::uuid[]) ORDER BY id',[[personId]]);if(locked.rows.length!==1||locked.rows[0].id!==personId)unavailable();}
   await fresh();
   const rows=new ClerkAuthRows(),scope:ClerkAuthScope={client:c,personId,identity:{issuer:proof.issuer,userId:proof.userId,sessionId:proof.sessionId},existing:!!mapping,now:time},before=await rows.load(scope);
   if(before.person?.telegramId!==null&&before.person?.telegramId!==undefined&&before.person.telegramId!==launch.telegramUserId)fail('IDENTITY_LINK_CONFLICT',409);
   const state=combine(structuredClone(before));
   const digest=await proofHash(clerkReplayIdentity(proof));scope.exchangeDigest=digest;
   await fresh();await setTrustedPhase(c,'exchange');
   const result=await exchangeClerkSession({state,now:()=>time,newPersonId:()=>personId},proof,o.deps);
   await fresh();scope.now=time;
   const after=snapshot(state,personId);
   await rows.flush(scope,before,after);
   // Row adapter intentionally keeps Telegram null/unchanged; the existing
   // narrow DB link function performs exactly this mutation under both gates.
   const linked=await q(c,'ua_atomic_link','SELECT state FROM ua_private.link_telegram_identity($1::uuid,$2::bigint)',[personId,launch.telegramUserId]);
   if(linked.rows.length!==1||linked.rows[0].state!=='linked')fail('IDENTITY_LINK_CONFLICT',409);
   const replay=await q(c,'ua_atomic_replay','INSERT INTO ua_private.init_data_replays(digest,person_id,consumed_at_ms) VALUES($1,$2,$3) ON CONFLICT(digest) DO NOTHING RETURNING digest',[launch.replayDigest,personId,time]);
   if(replay.rowCount!==1)fail('INIT_DATA_REPLAY',409);
   if(replay.rows.length!==1||replay.rows[0].digest!==launch.replayDigest)unavailable();
   await fresh();
   if(time>=Date.parse(result.expires_at)||time>=Date.parse(result.refresh_expires_at))fail('APP_SESSION_EXPIRED',401);
   committing=true;await q(c,'ua_atomic_commit','COMMIT');began=false;
   return {...result,token_type:'Bearer' as const};
  }catch(e){
   discard=true;if(committing)throw new StorageUnavailable('commit_unknown');
   if(began)try{await q(c,'ua_atomic_rollback','ROLLBACK');}catch{throw new StorageUnavailable('commit_unknown');}
   throw e;
  }finally{closeTrustedServerContext(c);try{c.release(discard);}catch{}}
 }
}

// Local composition only. No default pool, Worker registration, or live grants.
import { checkClerkProof, clerkIdentityKey } from "./clerk-auth.ts";
import { fail } from "./fault.ts";
import { handleTeacherBrowserPilot } from "./teacher-browser-pilot.ts";
import { integer, PostgresTransactions, query } from "./storage/postgres-transaction.ts";
import { createTeacherNamedCatalog } from "./storage/teacher-named-catalog.ts";
import type { PgPool } from "./storage/postgres-transaction.ts";
import { canonicalPersonId, setTrustedClerk, setTrustedPhase } from "./storage/trusted-server-context.ts";

type HttpDeps=NonNullable<Parameters<typeof handleTeacherBrowserPilot>[1]>;
type Runner=HttpDeps["runner"];

type Options=Readonly<Pick<HttpDeps,"browserOrigin"|"verifier"|"liveness">&{
  // Must be a separately approved Teacher-capable storage connection, not
  // inferred from Student ua_runtime or the account-deletion credential.
  pool:PgPool;
  // Real independently authorized, complete metadata provider only.
  catalog: Parameters<typeof createTeacherNamedCatalog>[0];
}>;

export function composeTeacherBrowserPilotPostgres(options:Options):(request:Request)=>Promise<Response>{
  if(typeof options?.pool?.connect!=="function"||typeof options?.verifier?.now!=="function"||
     typeof options?.liveness!=="function")
    fail("SERVICE_UNAVAILABLE",503);
  const {pool,verifier,liveness,browserOrigin}=options;
  const readMetadata=createTeacherNamedCatalog(options.catalog);
  const runner:Runner={
    async run(proof,signal,read){
      signal.throwIfAborted();
      const hostNow=()=>{const now=verifier.now();if(!Number.isSafeInteger(now)||now<0)fail("SERVICE_UNAVAILABLE",503);return now;};
      checkClerkProof(proof,hostNow());
      let lease=proof.expiresAt, lastDb=-1, completed=false;
      return new PostgresTransactions(pool).runPrepared({
        async prepare(client) {
          const {issuer, userId} = proof;
          await setTrustedClerk(client, issuer, userId);
          await client.query({name:"ua_clerk_identity_gate",
            text:"SELECT pg_advisory_xact_lock(1430348620,hashtext($1))", values:[clerkIdentityKey(proof)]});
          const mapping = await client.query({name:"ua_clerk_locate",
            text:"SELECT person_id::text,enabled FROM ua_private.lock_clerk_identity($1::text,$2::text)", values:[issuer,userId]});
          if (mapping.rows.length !== 1 || mapping.rows[0].enabled !== true) fail("CLERK_IDENTITY_REVOKED",401);
          const id = mapping.rows[0].person_id;
          if (!canonicalPersonId(id)) fail("RESPONSE_INVARIANT_FAILED",500);
          return [id];
        },
        beforeCommit:()=>{
          signal.throwIfAborted();
          const now=hostNow();
          if(!completed||now<lastDb) fail("SERVICE_UNAVAILABLE",503);
          checkClerkProof(proof,now);
          if(now>=lease) fail("CLERK_SESSION_REVOKED",401);
        },
      }, async tx=>{
        signal.throwIfAborted();
        lastDb=tx.now;
        checkClerkProof(proof,lastDb);
        const personId=tx.personIds[0];
        // Recheck the verified issuer/subject against the locked person.
        const still=await query(tx,"ua_teacher_browser_identity_v1",
          "SELECT person_id::text FROM ua_private.clerk_identities WHERE issuer=$1 AND subject=$2 AND person_id=$3 AND enabled=true",
          [proof.issuer,proof.userId,personId]);
        signal.throwIfAborted();
        if(still.rows.length!==1||still.rows[0].person_id!==personId) fail("CLERK_IDENTITY_REVOKED",401);
        await setTrustedPhase(tx.client,"domain");
        const clock=async()=>{
          signal.throwIfAborted();
          const result=await query(tx,"ua_clock","SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms");
          signal.throwIfAborted();
          if(result.rows.length!==1) fail("RESPONSE_INVARIANT_FAILED",500);
          const at=integer(result.rows[0].now_ms);
          if(at<lastDb||at>8_640_000_000_000_000) fail("SERVICE_UNAVAILABLE",503);
          lastDb=at;
          return at;
        };
        const restrictLease=(value:number)=>{
          if(!Number.isSafeInteger(value)||value<=lastDb) fail("CLERK_SESSION_REVOKED",401);
          lease=Math.min(lease,value);
        };
        const result=await read({tx,clock,restrictLease,readMetadata:(scope,signalForRead)=>{
          if(scope.personId!==personId||signalForRead!==signal) fail("FORBIDDEN",403);
          signal.throwIfAborted();
          return readMetadata(tx,scope,signal);
        }});
        const after=await clock();
        checkClerkProof(proof,after);
        if(after>=lease) fail("CLERK_SESSION_REVOKED",401);
        completed=true;
        return result;
      });
    },
  };
  return request=>handleTeacherBrowserPilot(request,{browserOrigin,verifier,liveness,runner});
}

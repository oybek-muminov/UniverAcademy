import { fail } from "../fault.ts";
import { bearer, checkSessionPolicy, proofHash } from "../student-state.ts";
import type { SessionPolicy } from "../student-state.ts";
import { verifyTelegramInitData } from "../telegram.ts";
import { StorageUnavailable } from "./postgres-transaction.ts";
import type { PgPool } from "./postgres-transaction.ts";

async function input(request: Request, key: string): Promise<string> {
  let parsed: unknown;
  try { parsed=JSON.parse(await request.text()); } catch { fail("MALFORMED_JSON",400); }
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||Object.keys(parsed).length!==1||
    !Object.hasOwn(parsed,key)||typeof (parsed as Record<string,unknown>)[key]!=="string"||
    !(parsed as Record<string,string>)[key].length) fail("VALIDATION_ERROR",422);
  return (parsed as Record<string,string>)[key];
}
export type StudentScope={kind:"person";personId:string}|{kind:"telegram";telegramId:number;initData:string};
export async function locateStudent(pool: PgPool, request: Request, config: { botToken:string;sessionPolicy:SessionPolicy;now:()=>number }): Promise<StudentScope> {
  const path=new URL(request.url).pathname.replace(/\/$/,""),method=request.method;
  let name:string,text:string,value:unknown;
  if(path==="/api/v1/auth/telegram"&&method==="POST") {
    const raw=await input(request,"init_data"),policy=checkSessionPolicy(config.sessionPolicy);
    if(Array.from(raw).length>16384) fail("VALIDATION_ERROR",422);
    const now=config.now();if(!Number.isSafeInteger(now)||now<0) fail("SERVICE_UNAVAILABLE",503);
    const seconds=Math.floor(now/1000);
    const verified=await verifyTelegramInitData(raw,config.botToken,{notBeforeSeconds:Math.max(0,seconds-policy.initDataMaxAgeSeconds),notAfterSeconds:seconds+policy.futureSkewSeconds});
    return {kind:"telegram",telegramId:verified.telegramUserId,initData:raw};
  } else if(path==="/api/v1/auth/refresh"&&method==="POST") {
    const raw=await input(request,"refresh_token");if(Array.from(raw).length>1024) fail("VALIDATION_ERROR",422);
    name="ua_locate_refresh";text="SELECT f.person_id::text FROM ua_private.student_refresh r JOIN ua_private.student_families f ON f.id=r.family_id WHERE r.digest=$1";value=await proofHash(raw);
  } else {
    const access=bearer(request,false);
    if(access) {name="ua_locate_access";text="SELECT f.person_id::text FROM ua_private.student_access a JOIN ua_private.student_families f ON f.id=a.family_id WHERE a.digest=$1";value=await proofHash(access);}
    else if(path==="/api/v1/auth/logout"&&method==="POST") {
      if(!(await request.clone().text())) fail("LOGOUT_PROOF_REQUIRED",401);
      const raw=await input(request,"refresh_token");name="ua_locate_refresh";text="SELECT f.person_id::text FROM ua_private.student_refresh r JOIN ua_private.student_families f ON f.id=r.family_id WHERE r.digest=$1";value=await proofHash(raw);
    } else fail("SESSION_REVOKED",401);
  }
  let client;
  try {client=await pool.connect();}catch{throw new StorageUnavailable("not_committed");}
  if(typeof client?.query!=="function"||typeof client.release!=="function") {
    if(typeof client?.release==="function")client.release(true);
    throw new StorageUnavailable("not_committed");
  }
  try {
    const r=await client.query({name,text,values:[value]});
    if(r.rows.length!==1) {
      fail(name==="ua_locate_refresh"?"REFRESH_INVALID":"SESSION_REVOKED",401);
    }
    return {kind:"person",personId:r.rows[0].person_id as string}; // Locator hint only; authorize again after locks.
  } finally {client.release();}
}

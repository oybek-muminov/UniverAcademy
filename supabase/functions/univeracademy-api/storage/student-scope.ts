import { fail } from "../fault.ts";
import { bearer, checkSessionPolicy, proofHash } from "../student-state.ts";
import type { SessionPolicy } from "../student-state.ts";
import { verifyTelegramInitData } from "../telegram.ts";
import { StorageUnavailable } from "./postgres-transaction.ts";
import type { PgClient, PgPool } from "./postgres-transaction.ts";
import {canonicalPersonId,requireTrustedAuth,resetTrustedServerContext,setTrustedPhase,closeTrustedServerContext} from "./trusted-server-context.ts";

async function input(request: Request, key: string): Promise<string> {
  let parsed: unknown;
  try { parsed=JSON.parse(await request.text()); } catch { fail("MALFORMED_JSON",400); }
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||Object.keys(parsed).length!==1||
    !Object.hasOwn(parsed,key)||typeof (parsed as Record<string,unknown>)[key]!=="string"||
    !(parsed as Record<string,string>)[key].length) fail("VALIDATION_ERROR",422);
  return (parsed as Record<string,string>)[key];
}
const refreshLookup="SELECT person_id::text FROM ua_private.locate_student_refresh($1::text)";
const accessLookup="SELECT person_id::text FROM ua_private.locate_student_access($1::text)";
export type StudentScope={kind:"person";personId:string}|{kind:"telegram";telegramId:number;initData:string};
async function lookup(request: Request, config: { botToken:string;sessionPolicy:SessionPolicy;now:()=>number }): Promise<StudentScope|{kind:"lookup";name:string;text:string;value:unknown}> {
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
    name="ua_locate_refresh";text=refreshLookup;value=await proofHash(raw);
  } else {
    const access=bearer(request,false);
    if(access) {name="ua_locate_access";text=accessLookup;value=await proofHash(access);}
    else if(path==="/api/v1/auth/logout"&&method==="POST") {
      if(!(await request.clone().text())) fail("LOGOUT_PROOF_REQUIRED",401);
      const raw=await input(request,"refresh_token");name="ua_locate_refresh";text=refreshLookup;value=await proofHash(raw);
    } else fail("SESSION_REVOKED",401);
  }
  return {kind:"lookup",name,text,value};
}
async function resolve(client:PgClient,hint:Awaited<ReturnType<typeof lookup>>):Promise<StudentScope>{
  if(hint.kind!=="lookup")return hint;
  const r=await client.query({name:hint.name,text:hint.text,values:[hint.value]});
  if(r.rows.length===0)fail(hint.name==="ua_locate_refresh"?"REFRESH_INVALID":"SESSION_REVOKED",401);
  if(r.rows.length!==1||Object.keys(r.rows[0]).join(",")!=="person_id"||!canonicalPersonId(r.rows[0].person_id))fail("RESPONSE_INVARIANT_FAILED",500);
  return {kind:"person",personId:r.rows[0].person_id}; // Hint only; reauthorize after locks.
}
export async function locateStudentAccessOnClient(client:PgClient,proofDigest:string):Promise<StudentScope>{
  if(!/^[0-9a-f]{64}$/.test(proofDigest))fail("SESSION_REVOKED",401);
  requireTrustedAuth(client);
  return resolve(client,{kind:"lookup",name:"ua_locate_access",text:accessLookup,value:proofDigest});
}

// Validated proof selection only. Identity is subsequently located under reset
// context, locked and reauthorized from persisted rows on that same client.
export async function studentSessionProofs(request:Request):Promise<{kind:"access"|"refresh";digest:string;accessToken:string|null;refreshDigest:string|null}>{
  const refresh=/\/auth\/refresh\/?$/.test(new URL(request.url).pathname);
  const accessToken=refresh||!request.headers.has("authorization")?null:bearer(request);
  // A bearer selects the locator first. Body validation follows successful
  // local access authentication, preserving invalid-bearer error precedence.
  if(accessToken)return {kind:"access",digest:await proofHash(accessToken),accessToken,refreshDigest:null};
  const raw=await request.clone().text();
  const token=raw?await input(request.clone(),"refresh_token"):null;
  if(refresh&&token===null)fail("MALFORMED_JSON",400);
  if(refresh&&token!==null&&Array.from(token).length>1024)fail("VALIDATION_ERROR",422);
  if(!accessToken&&!token)fail("LOGOUT_PROOF_REQUIRED",401);
  const refreshDigest=token===null?null:await proofHash(token);
  return {kind:accessToken?"access":"refresh",digest:accessToken?await proofHash(accessToken):refreshDigest!,accessToken,refreshDigest};
}
export async function studentLogoutRefreshDigest(request:Request):Promise<string|null>{
  if(!(await request.clone().text()))return null;
  return proofHash(await input(request.clone(),"refresh_token"));
}
export async function locateStudentRefreshOnClient(client:PgClient,proofDigest:string):Promise<StudentScope>{
  if(!/^[0-9a-f]{64}$/.test(proofDigest))fail("REFRESH_INVALID",401);
  requireTrustedAuth(client);
  return resolve(client,{kind:"lookup",name:"ua_locate_refresh",text:refreshLookup,value:proofDigest});
}

// Compatibility wrapper for the existing login/refresh/logout adapters. The
// prepared student path calls locateStudentAccessOnClient after BEGIN, with no second
// checkout and no authority inferred from the locator's answer.
export async function locateStudent(pool: PgPool, request: Request, config: {
  botToken:string;sessionPolicy:SessionPolicy;now:()=>number
}): Promise<StudentScope> {
  const hint=await lookup(request,config);if(hint.kind!=="lookup")return hint;
  let client;
  try {client=await pool.connect();}catch{throw new StorageUnavailable("not_committed");}
  if(typeof client?.query!=="function"||typeof client.release!=="function") {
    if(typeof client?.release==="function")client.release(true);
    throw new StorageUnavailable("not_committed");
  }
  let began=false,discard=false;
  try {
    await client.query({name:"ua_locator_begin",text:"BEGIN",values:[]});began=true;
    await resetTrustedServerContext(client);await setTrustedPhase(client,"auth");
    const scope=await resolve(client,hint);
    began=false; // An uncertain rollback is discarded, never retried.
    await client.query({name:"ua_locator_rollback",text:"ROLLBACK",values:[]});
    return scope;
  }catch(error){
    if(began){try{await client.query({name:"ua_locator_rollback",text:"ROLLBACK",values:[]});}catch{discard=true;}}else discard=true;
    throw error;
  }finally{closeTrustedServerContext(client);client.release(discard);}
}

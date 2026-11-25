import {fail} from "./fault.ts";
import {verifyTelegramInitData} from "./telegram.ts";
import {checkSessionPolicy,proofHash} from "./student-state.ts";
import type {SessionPolicy} from "./student-state.ts";
import type {ClerkProof} from "./clerk-auth.ts";
import type {profileWire} from "./student-wire.ts";
import type {JWTVerifyGetKey} from "jose";

export type TelegramStartState="linked"|"needs_clerk"|"disabled";
export type TelegramStartInput=Readonly<{update_id:number;telegram_user_id:number}>;
export type TelegramSession={access_token:string;refresh_token:string;expires_at:string;refresh_expires_at:string;token_type:"Bearer";profile:ReturnType<typeof profileWire>};
export type TelegramLoginInput=Readonly<{code:string;code_verifier:string}>;
export type TelegramReturnPort={link(proof:ClerkProof,raw:string):Promise<{ok:true}>;resume(raw:string):Promise<TelegramSession>;linkLogin?(proof:ClerkProof,login:TelegramLoginInput):Promise<{ok:true}>};
export type TelegramLaunch=Readonly<{telegramUserId:number;authDate:number;replayDigest:string}>;
const verifiedLaunches=new WeakSet<object>();
function unavailable():never{return fail("SERVICE_UNAVAILABLE",503);}
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&[null,Object.prototype].includes(Object.getPrototypeOf(value));
const ownValue=(value:Record<string,unknown>,key:string)=>{
  const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,"value"))fail("VALIDATION_ERROR",422);return d.value;
};
export function telegramStartInput(input:unknown):TelegramStartInput{
  if(!plain(input)||Reflect.ownKeys(input).length!==2||!Object.hasOwn(input,"update_id")||!Object.hasOwn(input,"telegram_user_id"))fail("VALIDATION_ERROR",422);
  const update=ownValue(input,"update_id"),user=ownValue(input,"telegram_user_id");
  if(!Number.isSafeInteger(update)||Number(update)<0||!Number.isSafeInteger(user)||Number(user)<=0)fail("VALIDATION_ERROR",422);
  return Object.freeze({update_id:update as number,telegram_user_id:user as number});
}
// PRIVATE trusted export factory only. The later Service Binding must expose this
// method exclusively; there is no HTTP route, public header or authentication
// claim. The injected reader is server-owned and must be strictly read-only.
export function createTelegramStartLookup(readStatus:(telegramUserId:number)=>Promise<unknown>){
  if(typeof readStatus!=="function")unavailable();
  return Object.freeze({async lookupTelegramStart(input:unknown):Promise<TelegramStartState>{
    const value=telegramStartInput(input);let state:unknown;
    try{state=await readStatus(value.telegram_user_id);}catch{unavailable();}
    if(state!=="linked"&&state!=="needs_clerk"&&state!=="disabled")unavailable();
    return state;
  }});
}
export async function telegramRequestBody(request:Request):Promise<string>{
  let value:unknown;try{value=JSON.parse(await request.text());}catch{fail("MALFORMED_JSON",400);}
  if(!plain(value)||Reflect.ownKeys(value).length!==1||!Object.hasOwn(value,"init_data"))fail("VALIDATION_ERROR",422);
  const raw=ownValue(value,"init_data");if(typeof raw!=="string"||!raw||raw.length>16384)fail("VALIDATION_ERROR",422);return raw;
}
export function checkTelegramLaunch(launch:TelegramLaunch,now:number,policy:SessionPolicy):void{
  if(!launch||!verifiedLaunches.has(launch))fail("INIT_DATA_INVALID",401);
  checkSessionPolicy(policy);if(!Number.isSafeInteger(now)||now<0)unavailable();
  const seconds=Math.floor(now/1000);
  if(launch.authDate>seconds+policy.futureSkewSeconds)fail("INIT_DATA_INVALID",401);
  if(launch.authDate<Math.max(0,seconds-policy.initDataMaxAgeSeconds))fail("INIT_DATA_EXPIRED",401);
}
export async function verifyTelegramLaunch(raw:string,botToken:string,policy:SessionPolicy,now:number):Promise<TelegramLaunch>{
  checkSessionPolicy(policy);if(!Number.isSafeInteger(now)||now<0)unavailable();
  const seconds=Math.floor(now/1000),verified=await verifyTelegramInitData(raw,botToken,{
    notBeforeSeconds:Math.max(0,seconds-policy.initDataMaxAgeSeconds),notAfterSeconds:seconds+policy.futureSkewSeconds});
  // Names and arbitrary Telegram/client metadata are deliberately not retained.
  const launch=Object.freeze({telegramUserId:verified.telegramUserId,authDate:verified.authDate,replayDigest:await proofHash(verified.replayKey)});
  verifiedLaunches.add(launch);checkTelegramLaunch(launch,now,policy);return launch;
}

// "Log In With Telegram" (OpenID Connect, authorization code + PKCE): https://core.telegram.org/bots/telegram-login
// The browser only carries a one-time code. This server exchanges it with the client secret, then verifies the
// signed id_token (issuer, audience, signature, expiry). Verification is NOT login: it only proves which
// Telegram account this browser confirmed; linking still needs a fresh Clerk proof and a replay record.
export type TelegramLoginConfig=Readonly<{clientId:string;clientSecret:string;redirectUri:string;
  transport:(request:Request)=>Promise<Response>;trustedKeys:JWTVerifyGetKey}>;
export const TELEGRAM_LOGIN_ISSUER="https://oauth.telegram.org";
export const TELEGRAM_LOGIN_TOKEN_URL="https://oauth.telegram.org/token";
const MAX_TOKEN_RESPONSE=65_536;
export async function telegramLoginBody(request:Request):Promise<TelegramLoginInput>{
  let value:unknown;try{value=JSON.parse(await request.text());}catch{fail("MALFORMED_JSON",400);}
  if(!plain(value)||Reflect.ownKeys(value).length!==2||!Object.hasOwn(value,"code")||!Object.hasOwn(value,"code_verifier"))fail("VALIDATION_ERROR",422);
  const code=ownValue(value,"code"),verifier=ownValue(value,"code_verifier");
  if(typeof code!=="string"||!/^[\x21-\x7e]{8,2048}$/.test(code)||typeof verifier!=="string"||!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier))fail("VALIDATION_ERROR",422);
  return Object.freeze({code,code_verifier:verifier});
}
export async function verifyTelegramLoginLaunch(input:TelegramLoginInput,config:TelegramLoginConfig,policy:SessionPolicy,now:number):Promise<TelegramLaunch>{
  checkSessionPolicy(policy);if(!Number.isSafeInteger(now)||now<0)unavailable();
  if(!config||!/^[0-9]{5,20}$/.test(config.clientId)||typeof config.clientSecret!=="string"||!config.clientSecret||/[\r\n\0]/.test(config.clientSecret)||
    typeof config.transport!=="function"||typeof config.trustedKeys!=="function")unavailable();
  try{const u=new URL(config.redirectUri);if(u.protocol!=="https:"||u.search||u.hash||u.username||u.password||u.href!==config.redirectUri)unavailable();}catch{unavailable();}
  let response:Response;
  try{
    response=await config.transport(new Request(TELEGRAM_LOGIN_TOKEN_URL,{method:"POST",redirect:"manual",credentials:"omit",cache:"no-store",
      headers:{authorization:"Basic "+btoa(config.clientId+":"+config.clientSecret),"content-type":"application/x-www-form-urlencoded",accept:"application/json"},
      body:new URLSearchParams({grant_type:"authorization_code",code:input.code,redirect_uri:config.redirectUri,client_id:config.clientId,code_verifier:input.code_verifier}).toString(),
      signal:AbortSignal.timeout(5000)}));
  }catch{return unavailable();}
  // A refused code (wrong, used, expired, verifier mismatch) is a client problem; anything else is ours or Telegram's.
  if(response.status>=400&&response.status<500){void response.body?.cancel().catch(()=>{});fail("INIT_DATA_INVALID",401);}
  if(response.status!==200)unavailable();
  let idToken:unknown;
  try{
    const text=await response.text();if(text.length>MAX_TOKEN_RESPONSE)unavailable();
    const body=JSON.parse(text);
    if(!plain(body)||String(body.token_type??"").toLowerCase()!=="bearer")unavailable();
    idToken=body.id_token;
  }catch{return unavailable();}
  if(typeof idToken!=="string"||!idToken||idToken.length>8192)unavailable();
  const {jwtVerify,errors}=await import("jose");
  let claims;
  try{
    claims=(await jwtVerify(idToken,config.trustedKeys,{issuer:TELEGRAM_LOGIN_ISSUER,audience:config.clientId,algorithms:["RS256","ES256"],
      requiredClaims:["iss","aud","sub","iat","exp"],clockTolerance:0,currentDate:new Date(now)})).payload;
  }catch(error){
    if(error instanceof errors.JWKSTimeout||error instanceof errors.JWKSInvalid||error instanceof errors.JWKInvalid||error instanceof errors.JWKSNoMatchingKey)unavailable();
    if(error instanceof errors.JOSEError)fail("INIT_DATA_INVALID",401);
    return unavailable();
  }
  const id=claims.id,iat=claims.iat;
  if(typeof id!=="number"||!Number.isSafeInteger(id)||id<=0||typeof iat!=="number"||!Number.isSafeInteger(iat)||iat<0)fail("INIT_DATA_INVALID",401);
  const launch=Object.freeze({telegramUserId:id,authDate:iat,replayDigest:await proofHash("telegram-login:"+input.code)});
  verifiedLaunches.add(launch);checkTelegramLaunch(launch,now,policy);return launch;
}

import {fail} from "./fault.ts";
import {verifyTelegramInitData} from "./telegram.ts";
import {checkSessionPolicy,proofHash} from "./student-state.ts";
import type {SessionPolicy} from "./student-state.ts";
import type {ClerkProof} from "./clerk-auth.ts";
import type {profileWire} from "./student-wire.ts";

export type TelegramStartState="linked"|"needs_clerk"|"disabled";
export type TelegramStartInput=Readonly<{update_id:number;telegram_user_id:number}>;
export type TelegramSession={access_token:string;refresh_token:string;expires_at:string;refresh_expires_at:string;token_type:"Bearer";profile:ReturnType<typeof profileWire>};
export type TelegramReturnPort={link(proof:ClerkProof,raw:string):Promise<{ok:true}>;resume(raw:string):Promise<TelegramSession>};
export type TelegramLaunch=Readonly<{telegramUserId:number;authDate:number;replayDigest:string}>;
const verifiedLaunches=new WeakSet<object>();
const unavailable=():never=>fail("SERVICE_UNAVAILABLE",503);
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

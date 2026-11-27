import {fail} from "./fault.ts";

/** Quick Telegram registration (default-off). The server, never the client,
 * creates the student's Clerk account from a signed Telegram launch and hands
 * back only a short-lived one-time Clerk sign-in ticket. The cabinet itself is
 * still created by the existing atomic entry (/auth/telegram/entry), which
 * consumes the same init_data. This operation therefore never records a
 * Telegram replay and never creates, links or reads a cabinet session. */
export type TelegramRegisterInput={init_data:string;first_name:string;last_name:string};
export type TelegramRegisterResult={status:"already_registered"}|{status:"ticket";ticket:string};
export type ClerkRegisterUser={id:string};
export type TelegramRegisterPorts={
  /** Verifies HMAC and freshness only. Must not consume the replay digest. */
  verifyLaunch(raw:string):Promise<{telegramUserId:number}>;
  /** true when this Telegram ID already belongs to a cabinet. */
  telegramLinked(telegramUserId:number):Promise<boolean>;
  /** true when this Clerk user is already mapped to any cabinet. */
  clerkMapped(userId:string):Promise<boolean>;
  clerk:{
    findByExternalId(externalId:string):Promise<ClerkRegisterUser[]>;
    createUser(input:{externalId:string;firstName:string;lastName:string}):Promise<ClerkRegisterUser|"exists">;
    createSignInToken(userId:string,expiresInSeconds:number):Promise<string>;
  };
  /** Returns false when the caller exceeded its budget. */
  allow(telegramUserId:number):boolean|Promise<boolean>;
};
export const REGISTER_TICKET_SECONDS=180;
const NAME_MAX=64;
const APOSTROPHES="'‘’ʻʼ";
// Letters (any script, including combining marks), single inner spaces,
// hyphens and the apostrophes used in Uzbek Latin: ' ‘ ’ ʻ ʼ.
const NAME=new RegExp("^[\\p{L}\\p{M}]+(?:[ \\-"+APOSTROPHES+"]+[\\p{L}\\p{M}]+)*["+APOSTROPHES+"]?$","u");

/** Trims, collapses inner whitespace and validates one display name. */
export function registerName(value:unknown):string{
  if(typeof value!=="string")fail("VALIDATION_ERROR",422);
  if(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/u.test(value))fail("VALIDATION_ERROR",422);
  const name=value.normalize("NFC").trim().replace(/\s+/gu," ");
  const length=Array.from(name).length;
  if(length<1||length>NAME_MAX||!NAME.test(name))fail("VALIDATION_ERROR",422);
  return name;
}
export function registerInput(body:unknown):TelegramRegisterInput{
  if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).sort().join(",")!=="first_name,init_data,last_name")fail("VALIDATION_ERROR",422);
  const b=body as Record<string,unknown>;
  if(typeof b.init_data!=="string"||!b.init_data||b.init_data.length>16384)fail("VALIDATION_ERROR",422);
  return {init_data:b.init_data,first_name:registerName(b.first_name),last_name:registerName(b.last_name)};
}
export const telegramExternalId=(telegramUserId:number)=>"tg:"+telegramUserId;
const validUser=(v:unknown):v is ClerkRegisterUser=>!!v&&typeof v==="object"&&typeof (v as {id?:unknown}).id==="string"&&/^user_[A-Za-z0-9]+$/.test((v as {id:string}).id);

export function createTelegramRegister(ports:TelegramRegisterPorts,options:{ticketSeconds?:number}={}){
  const ticketSeconds=options.ticketSeconds??REGISTER_TICKET_SECONDS;
  if(!Number.isSafeInteger(ticketSeconds)||ticketSeconds<120||ticketSeconds>300)fail("SERVICE_UNAVAILABLE",503);
  async function single(externalId:string):Promise<ClerkRegisterUser|null>{
    const found=await ports.clerk.findByExternalId(externalId);
    if(!Array.isArray(found)||!found.every(validUser))fail("SERVICE_UNAVAILABLE",503);
    // Two Clerk accounts for one Telegram must never be silently chosen between.
    if(found.length>1)fail("IDENTITY_LINK_CONFLICT",409);
    return found[0]??null;
  }
  return Object.freeze({async register(input:TelegramRegisterInput):Promise<TelegramRegisterResult>{
    const launch=await ports.verifyLaunch(input.init_data);
    const telegramUserId=launch?.telegramUserId;
    if(!Number.isSafeInteger(telegramUserId)||telegramUserId<=0)fail("SERVICE_UNAVAILABLE",503);
    if(!await ports.allow(telegramUserId))fail("RATE_LIMITED",429);
    if(await ports.telegramLinked(telegramUserId))return {status:"already_registered"};
    const externalId=telegramExternalId(telegramUserId);
    let user=await single(externalId);
    if(!user){
      const created=await ports.clerk.createUser({externalId,firstName:input.first_name,lastName:input.last_name});
      // A concurrent request (double tap) created it first: Clerk keeps
      // external_id unique, so re-read and continue with that same account.
      if(created==="exists")user=await single(externalId);
      else if(validUser(created))user=created;
      if(!user)fail("SERVICE_UNAVAILABLE",503);
    }
    if(await ports.clerkMapped(user.id))fail("IDENTITY_LINK_CONFLICT",409);
    const ticket=await ports.clerk.createSignInToken(user.id,ticketSeconds);
    if(typeof ticket!=="string"||!ticket||ticket.length>4096||/[\s\x00-\x1f\x7f]/.test(ticket))fail("SERVICE_UNAVAILABLE",503);
    return {status:"ticket",ticket};
  }});
}

/** Simple fixed-window limiter (default: 5 requests per 10 minutes per
 * Telegram ID). In a Worker it is per isolate: a soft guard for the Clerk
 * quota, not a security boundary — signed init_data is the real gate. */
export function createRegisterLimiter({limit=5,windowMs=600000,now=Date.now,maxKeys=10000}:{limit?:number;windowMs?:number;now?:()=>number;maxKeys?:number}={}){
  const hits=new Map<number,number[]>();
  return (key:number):boolean=>{
    const at=now(),recent=(hits.get(key)??[]).filter(t=>at-t<windowMs);
    if(recent.length>=limit){hits.set(key,recent);return false;}
    recent.push(at);hits.delete(key);hits.set(key,recent);
    while(hits.size>maxKeys){const oldest=hits.keys().next().value;if(oldest===undefined)break;hits.delete(oldest);}
    return true;
  };
}

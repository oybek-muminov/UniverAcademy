import {fail} from "../fault.ts";
import type {PgClient} from "./postgres-transaction.ts";

// These are assertions made by trusted server composition, not authentication
// against a holder of the DB credential. Never derive them from identity headers
// or caller flags. The WeakMap only guards this adapter's transaction lifetime.
type Phase="deny"|"auth"|"domain"|"exchange";
type Context={phase:Phase;ids:readonly string[];clerk:boolean};
const contexts=new WeakMap<PgClient,Context>();
export const canonicalPersonId=(id:unknown):id is string=>typeof id==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/.test(id);
const unavailable=():never=>fail("SERVICE_UNAVAILABLE",503);
const current=(client:PgClient)=>contexts.get(client)??unavailable();
export function closeTrustedServerContext(client:PgClient):void {contexts.delete(client);}
export async function resetTrustedServerContext(client:PgClient):Promise<void>{
  contexts.delete(client); // A failed reset cannot retain an earlier JS scope.
  await client.query({name:"ua_context_reset",text:"SELECT set_config('ua.phase',$1,true),set_config('ua.person_id',$2,true),set_config('ua.person_ids',$3,true),set_config('ua.clerk_issuer',$4,true),set_config('ua.clerk_subject',$5,true),set_config('ua.telegram_id',$6,true)",values:["deny","","[]","","",""]});
  contexts.set(client,{phase:"deny",ids:[],clerk:false});
}
export function requireTrustedAuth(client:PgClient):void {if(current(client).phase!=="auth")unavailable();}
export async function setTrustedPhase(client:PgClient,phase:Phase):Promise<void>{
  const c=current(client);
  if(!["deny","auth","domain","exchange"].includes(phase)||
    (phase==="auth"&&c.phase!=="deny"&&c.phase!=="auth")||
    ((phase==="domain"||phase==="exchange")&&(c.phase!=="auth"||c.ids.length!==1))||
    (phase==="exchange"&&!c.clerk))unavailable();
  await client.query({name:"ua_context_phase",text:"SELECT set_config('ua.phase',$1,true)",values:[phase]});c.phase=phase;
}
export async function setTrustedPeople(client:PgClient,ids:readonly string[]):Promise<void>{
  requireTrustedAuth(client);
  if(!Array.isArray(ids)||!ids.length)unavailable();
  for(let i=0;i<ids.length;i++)if(!Object.hasOwn(ids,i)||!canonicalPersonId(ids[i])||(i>0&&ids[i-1]>=ids[i]))unavailable();
  const copied=Object.freeze([...ids]);
  await client.query({name:"ua_people_context",text:"SELECT set_config('ua.person_id',$1,true),set_config('ua.person_ids',$2,true)",values:[copied.length===1?copied[0]:"",JSON.stringify(copied)]});
  current(client).ids=copied;
}
export async function setTrustedClerk(client:PgClient,issuer:string,subject:string):Promise<void>{
  requireTrustedAuth(client);
  let valid=false;try{valid=typeof issuer==="string"&&issuer.startsWith("https://")&&new URL(issuer).origin===issuer;}catch{}
  if(!valid||typeof subject!=="string"||!/^user_[A-Za-z0-9]+(?![\s\S])/.test(subject))unavailable();
  await client.query({name:"ua_clerk_identity_context",text:"SELECT set_config('ua.clerk_issuer',$1,true),set_config('ua.clerk_subject',$2,true)",values:[issuer,subject]});
  current(client).clerk=true;
}
export async function setTrustedTelegram(client:PgClient,id:number):Promise<void>{
  requireTrustedAuth(client);if(!Number.isSafeInteger(id)||id<=0)unavailable();
  await client.query({name:"ua_telegram_identity_context",text:"SELECT set_config('ua.telegram_id',$1,true)",values:[String(id)]});
}

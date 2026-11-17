import {ApiFault} from '../supabase/functions/univeracademy-api/fault.ts';
import {TelegramClerkEntryRows} from '../supabase/functions/univeracademy-api/storage/telegram-clerk-entry-rows.ts';
import {createCloudflarePostgres} from './cloudflare-postgres.mjs';
import {createTelegramClerkEntryHttp} from './telegram-clerk-entry-http.mjs';
import {publicHttpsOrigin} from './local-cors.mjs';
const unavailable=()=>new ApiFault('SERVICE_UNAVAILABLE',503);
export const atomicEntryEnvironmentKeys=Object.freeze(['UA_TELEGRAM_ATOMIC_ENTRY_ENABLED','UA_TELEGRAM_ATOMIC_AUTHORIZED_PARTIES']);
export function atomicEntryEnabled(env){
 const d=env&&Object.getOwnPropertyDescriptor(env,'UA_TELEGRAM_ATOMIC_ENTRY_ENABLED');
 if(!d)return false;
 if(!Object.hasOwn(d,'value')||!['true','false'].includes(d.value))throw unavailable();
 return d.value==='true';
}
/** Server-owned exact subset, not inferred from request Origin or body. */
export function atomicAuthorizedParties(env,settings){
 const d=env&&Object.getOwnPropertyDescriptor(env,'UA_TELEGRAM_ATOMIC_AUTHORIZED_PARTIES');
 if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='string'||d.value.length>8192)throw unavailable();
 let values;try{values=JSON.parse(d.value);}catch{throw unavailable();}
 if(!Array.isArray(values)||!values.length||values.length>32||new Set(values).size!==values.length||!Array.isArray(settings?.authorizedParties))throw unavailable();
 try{for(const value of values){publicHttpsOrigin(value);if(!settings.authorizedParties.includes(value))throw unavailable();}}catch{throw unavailable();}
 return Object.freeze([...values]);
}
/** Atomic endpoint only. Uses existing auth pool, never deletion request role.
 * No enablement or configuration changes are performed by constructing this. */
export function createTelegramClerkEntryApi({allowedOrigins,getBindings,loadClient,makeClerk,transport,now=Date.now,numericPresentation,
 makePostgres=createCloudflarePostgres,makeEntry=options=>new TelegramClerkEntryRows(options),timeoutMs=15000,closeTimeoutMs=2000}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isSafeInteger(closeTimeoutMs)||closeTimeoutMs<1||closeTimeoutMs>5000)throw unavailable();
 return {async fetch(request,env){
  const origin=request.headers.get('origin');const reply=(status,code)=>new Response(JSON.stringify({error:{code,message:code}}),{status,headers:{'content-type':'application/json','cache-control':'no-store','cdn-cache-control':'no-store','cloudflare-cdn-cache-control':'no-store','vary':'Origin',...(allowedOrigins.includes(origin)?{'access-control-allow-origin':origin}:{})}});
  // All public gates precede private binding/provider/DB access.
  if(!origin||!allowedOrigins.includes(origin))return reply(403,'FORBIDDEN');
  try{if(!atomicEntryEnabled(env))return reply(404,'NOT_FOUND');}catch{return reply(503,'SERVICE_UNAVAILABLE');}
  const url=new URL(request.url);
  if(url.pathname!=='/api/v1/auth/telegram/entry'||url.search)return reply(404,'NOT_FOUND');
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'access-control-allow-origin':origin,'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'authorization, content-type','cache-control':'no-store','vary':'Origin'}});
  if(request.method!=='POST')return reply(405,'METHOD_NOT_ALLOWED');
  const token=request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if(!token||token.length>16384)return reply(401,'CLERK_TOKEN_INVALID');
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return reply(422,'VALIDATION_ERROR');
  const controller=new AbortController();const abort=()=>controller.abort();request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();
  const timer=setTimeout(abort,timeoutMs);let clerk,postgres,stop,response;
  const check=()=>{if(controller.signal.aborted)throw unavailable();};
  const bounded=async(work,ms)=>{let timer;try{return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>reject(unavailable()),ms);})]);}finally{clearTimeout(timer);}};
  const work=async()=>{
   check();const bindings=getBindings(env),parties=atomicAuthorizedParties(env,bindings.settings);
   const created=await makeClerk({...bindings.settings,authorizedParties:parties},{secretKey:bindings.secretKey,transport,now,timeoutMs:bindings.settings?.timeoutMs,maxResponseBytes:65536,signal:controller.signal});
   if(controller.signal.aborted){void bounded(()=>created?.close(),closeTimeoutMs).catch(()=>{});throw unavailable();}
   clerk=created;if(typeof clerk?.close!=='function'||!clerk.verifier||typeof clerk.liveness!=='function')throw unavailable();
   // Defense in depth: an injected factory cannot broaden atomic azp policy.
   const verifier={...clerk.verifier,authorizedParties:parties};
   const enter=async(fresh,raw)=>{
    check();if(!parties.includes(fresh.proof.authorizedParty))throw unavailable();
    const Client=await loadClient();check();postgres=makePostgres(Client,bindings.postgres,{signal:controller.signal});
    const deps={mode:'local_candidate',transactions:{transaction:()=>{throw unavailable();}},verifier,
     liveness:async(identity,time)=>{check();const result=await clerk.liveness(identity,time,{signal:controller.signal});check();return result;},
     sessionPolicy:bindings.sessionPolicy,numericPresentation};
    const entry=makeEntry({pool:postgres.pool,botToken:bindings.botToken,deps,signal:controller.signal});
    check();return entry.enter(fresh,raw);
   };
   return createTelegramClerkEntryHttp({enabled:true,verifier,entry:{enter},allowedOrigins,timeoutMs})(new Request(request,{signal:controller.signal}));
  };
  try{
   const cancelled=new Promise((_,reject)=>{stop=()=>reject(unavailable());controller.signal.addEventListener('abort',stop,{once:true});});check();response=await Promise.race([work(),cancelled]);
  }catch{response=reply(503,'SERVICE_UNAVAILABLE');}
  finally{
   try{await bounded(async()=>{const results=await Promise.allSettled([Promise.resolve().then(()=>postgres?.close()),Promise.resolve().then(()=>clerk?.close())]);if(results.some(x=>x.status==='rejected'))throw unavailable();},closeTimeoutMs);}catch{response=reply(503,'SERVICE_UNAVAILABLE');}
   clearTimeout(timer);request.signal.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',stop);
  }
  const headers=new Headers(response.headers);headers.set('cdn-cache-control','no-store');headers.set('cloudflare-cdn-cache-control','no-store');return new Response(response.body,{status:response.status,headers});
 }};
}

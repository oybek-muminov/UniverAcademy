import {ApiFault} from '../supabase/functions/univeracademy-api/fault.ts';
import {verifyTelegramLaunch} from '../supabase/functions/univeracademy-api/telegram-return.ts';
import {createTelegramRegister,createRegisterLimiter,registerInput} from '../supabase/functions/univeracademy-api/telegram-register.ts';
import {TelegramRegisterRows} from '../supabase/functions/univeracademy-api/storage/telegram-register-rows.ts';
import {createCloudflarePostgres} from './cloudflare-postgres.mjs';
import {createClerkRegisterTransport} from './telegram-register-clerk.mjs';

export const REGISTER_PATH='/api/v1/auth/telegram/register';
export const telegramRegisterEnvironmentKeys=Object.freeze(['UA_TELEGRAM_REGISTER_ENABLED']);
const unavailable=()=>new ApiFault('SERVICE_UNAVAILABLE',503);
/** Default off. Only the exact string "true" enables; any other present value fails closed. */
export function telegramRegisterEnabled(env){
  const d=env&&Object.getOwnPropertyDescriptor(env,'UA_TELEGRAM_REGISTER_ENABLED');
  if(!d)return false;
  if(!Object.hasOwn(d,'value')||!['true','false'].includes(d.value))throw unavailable();
  return d.value==='true';
}
// Per-isolate soft limit (5 per 10 minutes per Telegram ID).
const sharedLimiter=createRegisterLimiter();

/** POST /api/v1/auth/telegram/register — see telegram-register.ts. */
export function createTelegramRegisterApi({allowedOrigins,getBindings,loadClient,transport,now=Date.now,
  makePostgres=createCloudflarePostgres,makeClerk=createClerkRegisterTransport,makeRows=options=>new TelegramRegisterRows(options),
  allow=sharedLimiter,timeoutMs=15000}={}){
  if(!Array.isArray(allowedOrigins)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw unavailable();
  return {async fetch(request,env){
    const origin=request.headers.get('origin');
    const cors=allowedOrigins.includes(origin)?{'access-control-allow-origin':origin}:{};
    const headers={'content-type':'application/json','cache-control':'no-store','cdn-cache-control':'no-store','cloudflare-cdn-cache-control':'no-store','vary':'Origin',...cors};
    const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers});
    const error=(status,code)=>reply(status,{error:{code,message:code,request_id:crypto.randomUUID()}});
    // Every public gate precedes any private binding, provider or database access.
    if(!origin||!allowedOrigins.includes(origin))return error(403,'FORBIDDEN');
    try{if(!telegramRegisterEnabled(env))return error(404,'NOT_FOUND');}catch{return error(503,'SERVICE_UNAVAILABLE');}
    const url=new URL(request.url);
    if(url.pathname.replace(/\/$/,'')!==REGISTER_PATH||url.search)return error(404,'NOT_FOUND');
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'access-control-allow-origin':origin,'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type','access-control-max-age':'600','cache-control':'no-store','vary':'Origin'}});
    if(request.method!=='POST')return error(405,'METHOD_NOT_ALLOWED');
    if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return error(422,'VALIDATION_ERROR');
    const controller=new AbortController(),abort=()=>controller.abort();
    request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();
    const timer=setTimeout(abort,timeoutMs);let postgres;
    const cancelled=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(unavailable()),{once:true}));
    cancelled.catch(()=>{});
    try{
      let text;
      try{
        const length=request.headers.get('content-length');
        if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)>20000))return error(422,'VALIDATION_ERROR');
        const reading=request.text();reading.catch(()=>{});
        text=await Promise.race([reading,cancelled]);
      }catch{return error(503,'SERVICE_UNAVAILABLE');}
      if(text.length>20000)return error(422,'VALIDATION_ERROR');
      let body;try{body=JSON.parse(text);}catch{return error(400,'MALFORMED_JSON');}
      const input=registerInput(body);
      const bindings=getBindings(env);
      const issuer=bindings.settings?.issuer;
      if(typeof issuer!=='string'||!bindings.botToken)throw unavailable();
      const clerk=makeClerk({secretKey:bindings.secretKey,transport,timeoutMs:Math.min(5000,timeoutMs),signal:controller.signal});
      let rows;
      const db=async()=>{
        if(rows)return rows;
        const Client=await loadClient();if(typeof Client!=='function'||controller.signal.aborted)throw unavailable();
        postgres=makePostgres(Client,bindings.postgres,{signal:controller.signal});
        rows=makeRows({pool:postgres.pool,issuer,signal:controller.signal});return rows;
      };
      const service=createTelegramRegister({
        verifyLaunch:raw=>verifyTelegramLaunch(raw,bindings.botToken,bindings.sessionPolicy,now()),
        telegramLinked:async id=>(await db()).telegramLinked(id),
        clerkMapped:async id=>(await db()).clerkMapped(id),
        clerk,allow,
      });
      if(controller.signal.aborted)throw unavailable();
      const result=await Promise.race([service.register(input),cancelled]);
      return reply(200,result);
    }catch(e){
      return e instanceof ApiFault&&e.status<500?error(e.status,e.code):error(503,'SERVICE_UNAVAILABLE');
    }finally{
      clearTimeout(timer);request.signal.removeEventListener('abort',abort);
      try{await postgres?.close();}catch{}
    }
  }};
}

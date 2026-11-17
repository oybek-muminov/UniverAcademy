import {ApiFault} from '../supabase/functions/univeracademy-api/fault.ts';
import {createDeletionVerifier} from './account-deletion-verifier.mjs';
import {requireFreshDeletionProof} from '../supabase/functions/univeracademy-api/account-deletion.ts';
/** Review-only Telegram route. The fresh verifier is shared with sensitive
 * account actions. Cached Clerk session presence alone does not authorize link.
 * Client must present account selection/confirmation and reverify first. */
export function createTelegramClerkEntryHttp({enabled=false,verifier,entry,allowedOrigins,timeoutMs=10000}={}){
 if(!Array.isArray(allowedOrigins)||!allowedOrigins.length||allowedOrigins.some(x=>{try{return new URL(x).origin!==x||!x.startsWith('https://');}catch{return true;}})||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('Invalid entry configuration');
 const verify=createDeletionVerifier(verifier);
 const response=(status,code,origin,data)=>new Response(JSON.stringify(data?{data}:{error:{code,message:code}}),{status,headers:{'content-type':'application/json','cache-control':'no-store','vary':'Origin',...(origin?{'access-control-allow-origin':origin}:{})}});
 return async request=>{
  const origin=request.headers.get('origin');
  if(!origin||!allowedOrigins.includes(origin))return response(403,'FORBIDDEN');
  if(!enabled)return response(404,'NOT_FOUND',origin);
  try{
   const url=new URL(request.url);
   if(url.pathname!=='/api/v1/auth/telegram/entry'||url.search)throw new ApiFault('NOT_FOUND',404);
   if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'access-control-allow-origin':origin,'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'authorization, content-type','cache-control':'no-store','vary':'Origin'}});
   if(request.method!=='POST')throw new ApiFault('METHOD_NOT_ALLOWED',405);
   const token=request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
   if(!token)throw new ApiFault('CLERK_TOKEN_INVALID',401);
   if(token.length>16384||!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))throw new ApiFault('VALIDATION_ERROR',422);
   const reader=request.body?.getReader();if(!reader)throw new ApiFault('MALFORMED_JSON',400);
   const abort=()=>{void reader.cancel().catch(()=>{});};request.signal.addEventListener('abort',abort,{once:true});
   let timer,bytes=0;const chunks=[];
   const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{void reader.cancel().catch(()=>{});reject(new ApiFault('SERVICE_UNAVAILABLE',503));},timeoutMs);});
   let raw;
   try{raw=await Promise.race([(async()=>{for(;;){const p=await reader.read();if(p.done)break;bytes+=p.value.length;if(bytes>20000)throw new ApiFault('VALIDATION_ERROR',422);chunks.push(p.value);}const b=new Uint8Array(bytes);let offset=0;for(const c of chunks){b.set(c,offset);offset+=c.length;}return new TextDecoder('utf-8',{fatal:true}).decode(b);})(),timeout]);}
   finally{request.signal.removeEventListener('abort',abort);clearTimeout(timer);void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
   if(request.signal.aborted)throw new ApiFault('SERVICE_UNAVAILABLE',503);
   let body;try{body=JSON.parse(raw);}catch{throw new ApiFault('MALFORMED_JSON',400);}
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='confirmation,init_data'||body.confirmation!=='link-telegram-account-v1'||typeof body.init_data!=='string'||!body.init_data||body.init_data.length>16384)throw new ApiFault('VALIDATION_ERROR',422);
   const fresh=await verify(token);requireFreshDeletionProof(fresh,verifier.now());
   if(request.signal.aborted)throw new ApiFault('SERVICE_UNAVAILABLE',503);
   const result=await entry.enter(fresh,body.init_data);
   return response(200,null,origin,result);
  }catch(e){return response(e instanceof ApiFault?e.status:503,e instanceof ApiFault?e.code:'SERVICE_UNAVAILABLE',origin);}
 };
}

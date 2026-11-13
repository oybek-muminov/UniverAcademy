import {createCloudflarePostgres} from './cloudflare-postgres.mjs';
import {createTelegramStartLookup,telegramStartInput} from '../supabase/functions/univeracademy-api/telegram-return.ts';
import {resetTrustedServerContext,setTrustedPhase,closeTrustedServerContext} from '../supabase/functions/univeracademy-api/storage/trusted-server-context.ts';

const unavailable=()=>new Error('SERVICE_UNAVAILABLE');
const own=(object,key)=>{
 const d=object&&Object.getOwnPropertyDescriptor(object,key);
 if(!d||!Object.hasOwn(d,'value'))throw unavailable();return d.value;
};
function bindings(env){
 if(!env||typeof env!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(env)))throw unavailable();
 const milliseconds=own(env,'UA_TELEGRAM_LOOKUP_TIMEOUT_MS'),drive=own(env,'HYPERDRIVE');
 // Explicit private configuration only; no lookup TTL or caller deadline.
 // Existing Client connection bound is5000ms. A missing deadline stays closed.
 if(typeof milliseconds!=='string'||! /^[1-9][0-9]*$/.test(milliseconds)||Number(milliseconds)>5000||!drive||typeof drive!=='object'||Array.isArray(drive))throw unavailable();
 const connectionString=drive.connectionString; // Trusted platform accessor only.
 if(typeof connectionString!=='string')throw unavailable();
 let url;try{url=new URL(connectionString);}catch{throw unavailable();}
 if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.port||!url.username||!url.password||url.pathname.length<2||url.search||url.hash||/\s|\0/.test(connectionString))throw unavailable();
 return {milliseconds:Number(milliseconds),postgres:{connectionString}};
}
async function untilAborted(work,signal){
 let abort;
 try{
  if(signal.aborted)throw unavailable();
  const cancelled=new Promise((_,reject)=>{abort=()=>reject(unavailable());signal.addEventListener('abort',abort,{once:true});});
  return await Promise.race([Promise.resolve().then(()=>{if(signal.aborted)throw unavailable();return work();}),cancelled]);
 }finally{signal.removeEventListener('abort',abort);}
}
async function read(pool,id){
 let client,began=false,discard=false;
 const query=(name,text,values=[])=>client.query({name,text,values});
 try{
  client=await pool.connect();
  await query('ua_telegram_lookup_begin','BEGIN READ ONLY');began=true;
  await resetTrustedServerContext(client);await setTrustedPhase(client,'auth');
  const r=await query('ua_telegram_start','SELECT state FROM ua_private.lookup_telegram_start($1::bigint)',[id]);
  if(r.rows.length!==1||Object.keys(r.rows[0]).join(',')!=='state')throw unavailable();
  began=false; // Unknown ROLLBACK is discarded once, never retried.
  await query('ua_telegram_rollback','ROLLBACK');return r.rows[0].state;
 }catch{
  if(began){try{await query('ua_telegram_rollback','ROLLBACK');}catch{discard=true;}}else discard=true;
  throw unavailable();
 }finally{
  if(client){closeTrustedServerContext(client);try{client.release(discard);}catch{}}
 }
}
/** Server composition seams only. Each invocation owns its controller, Client
 * resource and read-only transaction. No Worker singleton client, HTTP route,
 * provider adapter, authentication assertion or navigation fallback is supplied.
 */
export function createTelegramDirectory({loadClient=async()=>(await import('pg')).Client,
 setTimer=setTimeout,clearTimer=clearTimeout}={}){
 if([loadClient,setTimer,clearTimer].some(x=>typeof x!=='function'))throw unavailable();
 return Object.freeze({async lookupTelegramStart(input,env,{signal}={}){
  let resource,timer,controller;
  try{
   const value=telegramStartInput(input),config=bindings(env);
   if(signal!==undefined&&!(signal instanceof AbortSignal))throw unavailable();
   controller=new AbortController();const scoped=signal?AbortSignal.any([controller.signal,signal]):controller.signal;
   if(scoped.aborted)throw unavailable();timer=setTimer(()=>controller.abort(),config.milliseconds);
   const Client=await untilAborted(()=>loadClient(),scoped);if(typeof Client!=='function'||scoped.aborted)throw unavailable();
   resource=createCloudflarePostgres(Client,config.postgres,{signal:scoped});
   const internal=createTelegramStartLookup(id=>read(resource.pool,id));
   const status=await untilAborted(()=>internal.lookupTelegramStart(value),scoped);
   // Await actual Client end BEFORE releasing even a routing-only response.
   await resource.close();if(scoped.aborted)throw unavailable();
   return Object.freeze({status}); // Exact external contract; no enum/extra data.
  }catch{throw unavailable();}
  finally{
   if(timer!==undefined)clearTimer(timer);
   // A failed, pending or interrupted close is never classified as success.
   try{await resource?.close();}catch{throw unavailable();}
  }
 }});
}

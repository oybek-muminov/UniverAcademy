import {ApiFault} from "../supabase/functions/univeracademy-api/fault.ts";
// This existing module uses only Web Request/Response/CORS/body bounds. It does
// not import Node HTTP or start a listener; its historic filename is retained.
import {createVercelNodeFunction} from "./vercel-node.mjs";
import {createCloudflarePostgres} from "./cloudflare-postgres.mjs";
import {publicHttpsOrigin,withPublicCors} from "./local-cors.mjs";

const unavailable=()=>new ApiFault("SERVICE_UNAVAILABLE",503);
const fault=(code="SERVICE_UNAVAILABLE",status=503)=>new Response(JSON.stringify({error:{code,message:code,request_id:crypto.randomUUID()}}),
  {status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","cdn-cache-control":"no-store"}});
async function fallback(request,apiOrigin,allowedOrigins){
  try{
    if(new URL(request.url).origin!==publicHttpsOrigin(apiOrigin))return fault("MALFORMED_REQUEST",400);
    return await withPublicCors(async()=>fault(),allowedOrigins)(request);
  }catch{return fault();} // Invalid public settings cannot authorize an origin.
}
function ownBody(request){
  if(!request.body)return {request,close(){}};
  let reader,controller,finished=false;
  const release=()=>{if(reader){try{reader.releaseLock();}catch{}}};
  const stop=()=>{
    if(finished)return false;finished=true;request.signal.removeEventListener("abort",close);
    // cancel settles pending reader.read() before invoking an asynchronous
    // underlying cancel hook. Release our lock without waiting on that hook.
    try{if(reader)void reader.cancel().catch(()=>{});}catch{}finally{release();}
    return true;
  };
  const close=()=>{if(stop())try{controller.error(unavailable());}catch{}};
  const body=new ReadableStream({start(value){controller=value;},async pull(value){
    if(finished)return;
    try{
      reader??=request.body.getReader();const next=await reader.read();
      if(finished)return;
      if(next.done){finished=true;request.signal.removeEventListener("abort",close);release();value.close();}
      else value.enqueue(next.value);
    }catch(error){if(stop())try{value.error(error);}catch{}}
  },cancel:close},{highWaterMark:0}); // No read ahead of shared CORS/body checks.
  request.signal.addEventListener("abort",close,{once:true});if(request.signal.aborted)close();
  try{
    return {request:new Request(request.url,{method:request.method,headers:request.headers,body,signal:request.signal,
      redirect:"error",credentials:"omit",cache:"no-store",duplex:"half"}),close};
  }catch(error){close();throw error;}
}
async function untilAborted(work,signal){
  let abort;
  try{
    if(signal.aborted)throw unavailable();
    const cancelled=new Promise((_,reject)=>{abort=()=>reject(unavailable());signal.addEventListener("abort",abort,{once:true});});
    return await Promise.race([Promise.resolve().then(()=>{if(signal.aborted)throw unavailable();return work();}),cancelled]);
  }finally{signal.removeEventListener("abort",abort);}
}

/** Pure Web composition, not a default Worker deployment. All options are
 * private server references supplied by composition, never request/env headers.
 * configuration is the existing production HttpConfiguration WITHOUT storage;
 * its Clerk adapter is prepared by createClerkWorkerAdapter. No credentials,
 * provider/DB probe, JWT bypass or browser-trusted flag is provided here.
 */
export function createCloudflareApi({apiOrigin,allowedOrigins,Client,postgres,configuration}={}){
  return Object.freeze({async fetch(request){
    let resource,response,body;
    try{
      let scoped;
      if(configuration!==undefined){
        if(configuration?.mode!=="production"||configuration.storage!==undefined)throw unavailable();
        resource=createCloudflarePostgres(Client,postgres,{signal:request.signal});
        scoped={...configuration,storage:{kind:"postgres",pool:resource.pool}};
        if(configuration.clerk){
          const read=configuration.clerk.liveness;
          if(typeof read!=="function")throw unavailable();
          scoped.clerk={...configuration.clerk,liveness:(identity,now,options)=>read(identity,now,
            {signal:options?.signal?AbortSignal.any([request.signal,options.signal]):request.signal})};
        }
      }
      const api=createVercelNodeFunction({apiOrigin,allowedOrigins,configuration:scoped});
      body=ownBody(request);
      response=await untilAborted(()=>api.fetch(body.request),request.signal);
    }catch{response=await fallback(request,apiOrigin,allowedOrigins);}
    finally{body?.close();}
    // No ACK before owned client disposal; no retry on close/commit uncertainty.
    try{await resource?.close();}catch{response=await fallback(request,apiOrigin,allowedOrigins);}
    const headers=new Headers(response.headers);headers.set("cloudflare-cdn-cache-control","no-store");
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  }});
}

import {ApiFault} from "../supabase/functions/univeracademy-api/fault.ts";
import {createConfiguredHttpHandler} from "../supabase/functions/univeracademy-api/configured-http.ts";
import {publicHttpsOrigin,withPublicCors} from "./local-cors.mjs";

const unavailable=()=>new ApiFault("SERVICE_UNAVAILABLE",503);
function faultResponse(error) {
  const fault=error instanceof ApiFault?error:new ApiFault("INTERNAL_ERROR",500);
  return new Response(JSON.stringify({error:{code:fault.code,message:fault.code,request_id:crypto.randomUUID()}}),
    {status:fault.status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
}
async function boundedRequest(request) {
  const length=request.headers.get("content-length");
  if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>65536))throw new ApiFault("MALFORMED_REQUEST",400);
  if(!request.body){
    if(length!==null&&Number(length)!==0)throw new ApiFault("MALFORMED_REQUEST",400);
    return request;
  }
  const reader=request.body.getReader(),chunks=[];let size=0;
  try {
    for(;;){
      const {value,done}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>65536){await reader.cancel();throw new ApiFault("MALFORMED_REQUEST",400);}
      chunks.push(value);
    }
    if(length!==null&&Number(length)!==size)throw new ApiFault("MALFORMED_REQUEST",400);
  }catch(error){
    if(error instanceof ApiFault)throw error;
    throw new ApiFault("MALFORMED_REQUEST",400);
  }finally{reader.releaseLock();}
  const body=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
  // Keep raw bytes for the existing strict JSON/auth boundary. No req.body helper,
  // numeric coercion, URL/route remapping or proof reconstruction in this adapter.
  return new Request(request.url,{method:request.method,headers:request.headers,body,
    signal:request.signal,redirect:"error",credentials:"omit",cache:"no-store"});
}

/** configuration is the existing HttpConfiguration, supplied by reviewed server bindings. */
export function createVercelNodeFunction({apiOrigin,allowedOrigins,configuration}={}) {
  let origin,handler;
  try {
    origin=publicHttpsOrigin(apiOrigin);
    if(configuration!==undefined&&configuration.mode!=="production")throw unavailable();
    const configured=createConfiguredHttpHandler(configuration);
    handler=withPublicCors(async request=>{
      const url=new URL(request.url);
      if(!url.pathname.startsWith("/api/v1/"))return faultResponse(new ApiFault("NOT_FOUND",404));
      let bounded;try{bounded=await boundedRequest(request);}catch(error){return faultResponse(error);}
      return configured(bounded);
    },allowedOrigins);
  }catch{throw unavailable();} // Configuration values are never echoed or logged.
  return {async fetch(request) {
    let response;
    try{
      // Applies to OPTIONS too; forwarded headers never supply the public origin.
      response=new URL(request.url).origin===origin?await handler(request):faultResponse(new ApiFault("MALFORMED_REQUEST",400));
    }catch(error){response=faultResponse(error);}
    const headers=new Headers(response.headers);
    for(const name of ["cache-control","cdn-cache-control","vercel-cdn-cache-control"])headers.set(name,"no-store");
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  }};
}

// One handler per warm module; no DB connect/query or session state cached here.
export function createVercelNodeEntrypoint(readOptions) {
  let entry;
  return {async fetch(request) {
    try{entry??=createVercelNodeFunction(readOptions());return await entry.fetch(request);}
    catch(error){return faultResponse(error);}
  }};
}
export function publicEnvironmentOptions(environment) {
  try {
    const apiOrigin=publicHttpsOrigin(environment.UA_API_ORIGIN);
    const allowedOrigins=JSON.parse(environment.UA_ALLOWED_ORIGINS);
    if(!Array.isArray(allowedOrigins))throw unavailable();
    for(const origin of allowedOrigins)publicHttpsOrigin(origin);
    return {apiOrigin,allowedOrigins};
  }catch{throw unavailable();}
}

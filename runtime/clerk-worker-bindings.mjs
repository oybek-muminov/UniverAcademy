import {ApiFault} from "../supabase/functions/univeracademy-api/fault.ts";
import {publicHttpsOrigin} from "./local-cors.mjs";

const unavailable=()=>new ApiFault("SERVICE_UNAVAILABLE",503);
const object=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const stamp=v=>Number.isSafeInteger(v)&&v>=0;
const validId=(v,p)=>typeof v==="string"&&new RegExp("^"+p+"_[A-Za-z0-9]+(?![\\s\\S])").test(v);

/** Web-only uncached Clerk BAPI binding. No SDK, worker_threads, filesystem,
 * global-fetch replacement or ambient transport. Only fixed session/user reads
 * and issuer-pinned JWKS; authorization/liveness semantics stay in the accepted
 * createClerkProviderAdapter and JOSE verifier, not in this transport seam.
 */
export function createClerkWorkerBindings({issuer,secretKey,transport,now,timeoutMs,maxResponseBytes,signal}={}){
  try{publicHttpsOrigin(issuer);}catch{throw unavailable();}
  if(typeof secretKey!=="string"||!secretKey||/[\r\n\0]/.test(secretKey)||typeof transport!=="function"||typeof now!=="function"||
    !stamp(timeoutMs)||!timeoutMs||timeoutMs>2_147_483_647||!stamp(maxResponseBytes)||!maxResponseBytes||maxResponseBytes>1_048_576||
    (signal!==undefined&&!(signal instanceof AbortSignal)))throw unavailable();
  const inflight=new Set();let closed=false;
  function close(){closed=true;signal?.removeEventListener("abort",close);for(const c of inflight)c.abort();}
  signal?.addEventListener("abort",close,{once:true});if(signal?.aborted)close();
  async function read(url,parent,authenticated){
    if(parent!==undefined&&!(parent instanceof AbortSignal))throw unavailable();
    if(closed||signal?.aborted||parent?.aborted)throw unavailable();
    const controller=new AbortController(),abort=()=>controller.abort();inflight.add(controller);
    signal?.addEventListener("abort",abort,{once:true});parent?.addEventListener("abort",abort,{once:true});
    const timer=setTimeout(abort,timeoutMs);let cancel,reader,bodyStopped=false;
    const stopBody=()=>{if(reader&&!bodyStopped){bodyStopped=true;void reader.cancel().catch(()=>{});}};controller.signal.addEventListener("abort",stopBody,{once:true});
    try{
      const aborted=new Promise((_,reject)=>{cancel=()=>reject(unavailable());controller.signal.addEventListener("abort",cancel,{once:true});});
      const work=async()=>{
        if(controller.signal.aborted)throw unavailable();
        const request=new Request(url,{method:"GET",headers:{accept:"application/json","cache-control":"no-store",...(authenticated?{authorization:"Bearer "+secretKey}:{})},
          redirect:"error",credentials:"omit",cache:"no-store",signal:controller.signal});
        const response=await transport(request);
        if(controller.signal.aborted){void response.body?.cancel().catch(()=>{});throw unavailable();}
        try{
          if(!(response instanceof Response)||(response.url&&response.url!==url)||response.redirected)throw unavailable();
          if(response.status!==200){if(response.status===404&&authenticated)throw new ApiFault("NOT_FOUND",404);throw unavailable();}
          if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type")??""))throw unavailable();
          const length=response.headers.get("content-length");
          if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>maxResponseBytes))throw unavailable();
          reader=response.body?.getReader();if(!reader)throw unavailable();
          const chunks=[];let size=0;
          for(;;){
            if(controller.signal.aborted)throw unavailable();
            const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
            if(size>maxResponseBytes){stopBody();throw unavailable();}chunks.push(value);
          }
          if(controller.signal.aborted||(length!==null&&Number(length)!==size))throw unavailable();
          const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
          return new TextDecoder("utf-8",{fatal:true}).decode(bytes);
        }finally{
          if(reader){stopBody();try{reader.releaseLock();}catch{}}
          else void response?.body?.cancel().catch(()=>{});
        }
      };
      return await Promise.race([work(),aborted]);
    }catch(error){if(error instanceof ApiFault&&error.status===404)throw error;throw unavailable();}
    finally{
      clearTimeout(timer);controller.signal.removeEventListener("abort",cancel);controller.signal.removeEventListener("abort",stopBody);
      signal?.removeEventListener("abort",abort);parent?.removeEventListener("abort",abort);inflight.delete(controller);
      // A cancelled body's asynchronous continuation owns releaseLock.
      stopBody();
    }
  }
  async function model(kind,target,options){
    if(!validId(target,kind==="sessions"?"sess":"user"))throw unavailable();
    const raw=await read("https://api.clerk.com/v1/"+kind+"/"+target,options?.signal,true);
    let v;try{v=JSON.parse(raw);}catch{throw unavailable();}
    if(!object(v))throw unavailable();
    if(kind==="sessions"){
      if(!validId(v.id,"sess")||!validId(v.user_id,"user")||typeof v.status!=="string"||!stamp(v.expire_at)||!stamp(v.abandon_at)||
        !Object.hasOwn(v,"actor")||!(v.actor===null||object(v.actor)))throw unavailable();
      return Object.freeze({id:v.id,userId:v.user_id,status:v.status,expireAt:v.expire_at,abandonAt:v.abandon_at,actor:v.actor});
    }
    if(!validId(v.id,"user")||!["banned","locked","deprovisioned"].every(k=>Object.hasOwn(v,k)&&typeof v[k]==="boolean"))throw unavailable();
    // These two raw display fields are not authentication evidence. The locked
    // new-person branch alone validates them; existing users ignore changes.
    return Object.freeze({id:v.id,banned:v.banned,locked:v.locked,deprovisioned:v.deprovisioned,
      firstName:v.first_name??null,lastName:v.last_name??null});
  }
  return Object.freeze({now,close,getSession:(id,options)=>model("sessions",id,options),getUser:(id,options)=>model("users",id,options),
    async fetchJwks(request){
      const url=issuer+"/.well-known/jwks.json";
      if(!(request instanceof Request)||request.method!=="GET"||request.url!==url||request.headers.has("authorization")||request.headers.has("cookie"))throw unavailable();
      return new Response(await read(url,request.signal,false),{headers:{"content-type":"application/json"}});
    }});
}

export async function createClerkWorkerAdapter(settings,options){
  let bindings;
  try{
    if(options?.issuer!==undefined&&options.issuer!==settings?.issuer)throw unavailable();
    bindings=createClerkWorkerBindings({...options,issuer:settings?.issuer});
    const {createClerkProviderAdapter}=await import("../supabase/functions/univeracademy-api/clerk-provider.ts");
    return Object.freeze({...createClerkProviderAdapter(settings,bindings),close:bindings.close});
  }catch{bindings?.close();throw unavailable();}
}

import {Worker} from "node:worker_threads";
import {createRequire} from "node:module";
import {readFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {ApiFault} from "../supabase/functions/univeracademy-api/fault.ts";

export const CLERK_BACKEND_VERSION="3.27.0";
const unavailable=()=>new ApiFault("SERVICE_UNAVAILABLE",503);
const object=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const stamp=value=>Number.isSafeInteger(value)&&value>=0;
const user=value=>typeof value==="string"&&/^user_[A-Za-z0-9]+(?![\s\S])/.test(value);
const sid=value=>typeof value==="string"&&/^sess_[A-Za-z0-9]+(?![\s\S])/.test(value);
function rawSecurity(path,value){
  if(!object(value))throw unavailable();
  if(path.startsWith("/v1/sessions/")){
    if(!sid(value.id)||!user(value.user_id)||typeof value.status!=="string"||!stamp(value.expire_at)||!stamp(value.abandon_at)||
      !Object.hasOwn(value,"actor")||!(value.actor===null||object(value.actor)))throw unavailable();
  }else if(!user(value.id)||!["banned","locked","deprovisioned"].every(key=>Object.hasOwn(value,key)&&typeof value[key]==="boolean"))throw unavailable();
}
async function boundedBody(response,maxBytes,signal){
  const reader=response.body?.getReader();if(!reader)throw unavailable();
  let size=0;const chunks=[];
  const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener("abort",abort,{once:true});
  try{for(;;){if(signal.aborted)throw unavailable();const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){abort();throw unavailable();}chunks.push(value);}}
  finally{signal.removeEventListener("abort",abort);reader.releaseLock();}
  const out=new Uint8Array(size);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder("utf-8",{fatal:true}).decode(out);
}

/** Exact SDK candidate. Only injected transports; no actual provider access by default. */
export async function createClerkSdkBindings({secretKey,transport,now,timeoutMs,maxResponseBytes}={}){
  const require=createRequire(import.meta.url),entry=require.resolve("@clerk/backend");
  if(JSON.parse(readFileSync(join(dirname(entry),"../package.json"))).version!==CLERK_BACKEND_VERSION||
    typeof secretKey!=="string"||!secretKey||typeof transport!=="function"||typeof now!=="function"||
    !stamp(timeoutMs)||timeoutMs===0||timeoutMs>2_147_483_647||!stamp(maxResponseBytes)||!maxResponseBytes||maxResponseBytes>1_048_576)throw unavailable();
  const worker=new Worker(new URL("./clerk-sdk-worker.mjs",import.meta.url),{workerData:{secretKey}});
  const pending=new Map(),inflight=new Set();let sequence=0,closed=false,readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const stopPending=()=>{readyReject(unavailable());for(const p of pending.values())p.finish(unavailable());pending.clear();for(const controller of inflight)controller.abort();};
  worker.on("error",stopPending);worker.on("exit",()=>{closed=true;stopPending();});
  worker.on("message",async message=>{
    if(message.type==="ready"){readyResolve();return;}
    if(message.type==="result"){
      const p=pending.get(message.id);if(!p)return;
      p.finish(message.error?new ApiFault(message.status===404?"NOT_FOUND":"SERVICE_UNAVAILABLE",message.status===404?404:503):null,message.data);return;
    }
    if(message.type!=="fetch")return;
    const p=pending.get(message.callId);
    if(closed||!p){if(!closed)worker.postMessage({type:"response",id:message.id,error:true});return;}
    const controller=new AbortController();inflight.add(controller);p.controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),timeoutMs);let abort;
    try{
      const url=new URL(message.url),headers=new Headers(message.headers);
      if(closed||message.method!=="GET"||url.origin!=="https://api.clerk.com"||url.search||url.hash||
        !/^\/v1\/(sessions\/sess_[A-Za-z0-9]+|users\/user_[A-Za-z0-9]+)(?![\s\S])/.test(url.pathname)||
        headers.get("authorization")!=="Bearer "+secretKey)throw unavailable();
      const aborted=new Promise((_,reject)=>{abort=()=>reject(unavailable());controller.signal.addEventListener("abort",abort,{once:true});});
      const response=await Promise.race([Promise.resolve().then(()=>{
        if(controller.signal.aborted)throw unavailable();
        return transport(new Request(url,{method:"GET",headers,redirect:"error",credentials:"omit",cache:"no-store",signal:controller.signal}));
      }).then(response=>{
        if(controller.signal.aborted){void response.body?.cancel().catch(()=>{});throw unavailable();}return response;
      }),aborted]);
      if(controller.signal.aborted)throw unavailable();
      if(response.url&&response.url!==url.href)throw unavailable();
      if(response.status!==200){worker.postMessage({type:"response",id:message.id,status:response.status===404?404:503,body:'{"errors":[{"code":"provider_unavailable","message":"SERVICE_UNAVAILABLE"}]}',headers:{"content-type":"application/json"}});return;}
      if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type")??""))throw unavailable();
      const raw=await boundedBody(response,maxResponseBytes,controller.signal),value=JSON.parse(raw);rawSecurity(url.pathname,value);
      if(controller.signal.aborted)throw unavailable();
      worker.postMessage({type:"response",id:message.id,status:200,body:raw,headers:{"content-type":"application/json"}});
    }catch{if(!closed)worker.postMessage({type:"response",id:message.id,error:true});}
    finally{clearTimeout(timer);if(abort)controller.signal.removeEventListener("abort",abort);inflight.delete(controller);p.controllers.delete(controller);}
  });
  const readyTimer=setTimeout(()=>readyReject(unavailable()),timeoutMs);
  try{await ready;}catch(error){await worker.terminate();throw error;}finally{clearTimeout(readyTimer);}
  const call=(method,target,{signal}={})=>new Promise((resolve,reject)=>{
    if(closed||(method==="getSession"?!sid(target):!user(target))||signal?.aborted){reject(unavailable());return;}
    const id=++sequence;
    const controllers=new Set();
    const finish=(error,value)=>{if(!pending.delete(id))return;clearTimeout(timer);signal?.removeEventListener("abort",abort);
      for(const controller of controllers)controller.abort();error?reject(error):resolve(value);};
    const abort=()=>finish(unavailable());
    const timer=setTimeout(abort,timeoutMs);pending.set(id,{finish,controllers});signal?.addEventListener("abort",abort,{once:true});
    try{worker.postMessage({type:"call",id,method,target});}catch{abort();}
  });
  return{sdkVersion:CLERK_BACKEND_VERSION,now,
    fetchJwks:request=>transport(request),
    getSession:(id,options)=>call("getSession",id,options),getUser:(id,options)=>call("getUser",id,options),
    async close(){if(closed)return;closed=true;stopPending();await worker.terminate();}};
}

import {parentPort,workerData} from "node:worker_threads";
import {AsyncLocalStorage} from "node:async_hooks";
// Private worker: no global-fetch mutation in the application process. Pin the
// transport before SDK import, because 3.27.0 captures native fetch at import.
// Correlate each fetch with its caller, including concurrent reads of one ID.
const reads=new Map(),calls=new AsyncLocalStorage();let sequence=0;
globalThis.fetch=(url,init={})=>new Promise((resolve,reject)=>{
  const callId=calls.getStore();if(!Number.isSafeInteger(callId)){reject(Error("SDK_TRANSPORT_UNAVAILABLE"));return;}
  const id=++sequence;reads.set(id,{resolve,reject});
  parentPort.postMessage({type:"fetch",id,callId,url:String(url),method:init.method,headers:[...new Headers(init.headers)]});
});
parentPort.on("message",async message=>{
  if(message.type==="response"){
    const pending=reads.get(message.id);if(!pending)return;reads.delete(message.id);
    if(message.error)pending.reject(Error("SDK_TRANSPORT_UNAVAILABLE"));
    else pending.resolve(new Response(message.body,{status:message.status,headers:message.headers}));
    return;
  }
  if(message.type!=="call")return;
  await calls.run(message.id,async()=>{try{
    const value=message.method==="getSession"?await client.sessions.getSession(message.target):await client.users.getUser(message.target);
    const data=message.method==="getSession"?{id:value.id,userId:value.userId,status:value.status,expireAt:value.expireAt,abandonAt:value.abandonAt,actor:value.actor}:
      {id:value.id,banned:value.banned,locked:value.locked,deprovisioned:value.deprovisioned};
    parentPort.postMessage({type:"result",id:message.id,data});
  }catch(error){parentPort.postMessage({type:"result",id:message.id,error:true,status:Number.isInteger(error?.status)?error.status:503});}});
});
const {createClerkClient}=await import("@clerk/backend");
const client=createClerkClient({secretKey:workerData.secretKey,apiUrl:"https://api.clerk.com",apiVersion:"v1",telemetry:{disabled:true}});
parentPort.postMessage({type:"ready"});

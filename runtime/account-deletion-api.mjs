import {ApiFault} from '../supabase/functions/univeracademy-api/fault.ts';
import {createDeletionRequests} from '../supabase/functions/univeracademy-api/account-deletion.ts';
import {AccountDeletionRequests} from '../supabase/functions/univeracademy-api/storage/account-deletion-rows.ts';
import {createDeletionHttp} from './account-deletion-http.mjs';
import {createDeletionVerifier} from './account-deletion-verifier.mjs';
import {createCloudflarePostgres} from './cloudflare-postgres.mjs';
import {isHyperdriveConnectionString} from './hyperdrive-connection-string.mjs';
const unavailable=()=>new ApiFault('SERVICE_UNAVAILABLE',503);
export const deletionRequestEnvironmentKeys=Object.freeze(['UA_DELETION_REQUEST_ENABLED','HYPERDRIVE_DELETION_REQUEST']);
export const isDeletionRequestPath=path=>['/api/v1/me/deletion','/api/v1/me/deletion/status'].includes(path);
const own=(obj,key)=>{const d=obj&&Object.getOwnPropertyDescriptor(obj,key);if(!d||!Object.hasOwn(d,'value'))throw unavailable();return d.value;};
const json=v=>{if(typeof v!=='string'||!v||v.length>65536)throw unavailable();try{return JSON.parse(v);}catch{throw unavailable();}};
/** Request-scoped, default disabled. No recovery role or provider DELETE here.
 * Preflight, origin rejection, invalid body and disabled submit never open DB or
 * read a secret. Status uses only the separate request binding, never Clerk. */
export function createDeletionApi({allowedOrigins,loadClient,makeClerk,transport,now=Date.now,
  makePostgres=createCloudflarePostgres,makeStore=(pool)=>new AccountDeletionRequests(pool,'ua_deletion_request_login'),
  timeoutMs=15000,closeTimeoutMs=2000}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isSafeInteger(closeTimeoutMs)||closeTimeoutMs<1||closeTimeoutMs>5000)throw unavailable();
  return {async fetch(request,env){
    const controller=new AbortController();const abort=()=>controller.abort();
    request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();
    const timer=setTimeout(abort,timeoutMs);let postgres,clerk;
    const check=()=>{if(controller.signal.aborted)throw unavailable();};
    const bounded=async(work,limit)=>{let timer;try{return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>reject(unavailable()),limit);})]);}finally{clearTimeout(timer);}};
    const closeClerk=async(value)=>{if(value)await value.close();};
    const openStore=async()=>{
      check();
      const drive=own(env,'HYPERDRIVE_DELETION_REQUEST');
      if(!drive||typeof drive!=='object'||Array.isArray(drive))throw unavailable();
      const connectionString=drive.connectionString;if(!isHyperdriveConnectionString(connectionString))throw unavailable();
      const Client=await loadClient();check();
      postgres=makePostgres(Client,{connectionString},{signal:controller.signal});
      return makeStore(postgres.pool);
    };
    const mode=()=>{
      const d=env&&Object.getOwnPropertyDescriptor(env,'UA_DELETION_REQUEST_ENABLED');
      if(!d)return null;
      if(!Object.hasOwn(d,'value')||!['true','false'].includes(d.value))throw unavailable();
      return d.value==='true';
    };
    const requests={
      async submit(input){
        if(mode()!==true)throw new ApiFault('NOT_FOUND',404);
        check();
        const settings=json(own(env,'UA_CLERK_PROVIDER_SETTINGS')),secretKey=own(env,'UA_CLERK_SECRET_KEY');
        if(typeof secretKey!=='string'||!secretKey||/[\r\n\0]/.test(secretKey))throw unavailable();
        const created=await makeClerk(settings,{secretKey,transport,now,timeoutMs:settings?.timeoutMs,maxResponseBytes:65536,signal:controller.signal});
        // A factory that resolves after the deadline still owns its cleanup.
        if(controller.signal.aborted){void bounded(()=>closeClerk(created),closeTimeoutMs).catch(()=>{});throw unavailable();}
        clerk=created;
        if(typeof clerk?.close!=='function'||(!clerk.verifier||typeof clerk.verifier!=='object')||typeof clerk.liveness!=='function')throw unavailable();
        const store=await openStore();check();
        const verify=createDeletionVerifier(clerk.verifier);
        const coordinator=createDeletionRequests({enabled:true,store:{prepare:input=>{check();return store.prepare(input);},status:hash=>{check();return store.status(hash);}},
          verify:async token=>{check();const proof=await verify(token);check();return proof;},
          liveness:async(identity,time)=>{check();const value=await clerk.liveness(identity,time,{signal:controller.signal});check();return value;},now});
        return coordinator.submit(input);
      },
      async status(receipt){
        if(mode()===null)throw new ApiFault('NOT_FOUND',404);
        const store=await openStore();check();
        return createDeletionRequests({enabled:false,store,verify:()=>{throw unavailable();},liveness:()=>{throw unavailable();},now}).status(receipt);
      }
    };
    const origin=request.headers.get('origin');
    const fallback=()=>new Response(JSON.stringify({error:{code:'SERVICE_UNAVAILABLE'}}),{status:503,headers:{'content-type':'application/json','cache-control':'no-store','cdn-cache-control':'no-store','cloudflare-cdn-cache-control':'no-store','vary':'Origin',...(allowedOrigins.includes(origin)?{'access-control-allow-origin':origin}:{})}});
    let stop,response;
    try{
      const scoped=new Request(request,{signal:controller.signal});
      const cancelled=new Promise((_,reject)=>{stop=()=>reject(unavailable());controller.signal.addEventListener('abort',stop,{once:true});});
      check();response=await Promise.race([createDeletionHttp({requests,allowedOrigins})(scoped),cancelled]);
    }catch{response=fallback();}
    finally{
      // No success acknowledgment until both resources have closed. A failed or
      // hung close is uncertain, not a completed/rejected deletion.
      try{await bounded(async()=>{const results=await Promise.allSettled([Promise.resolve().then(()=>postgres?.close()),Promise.resolve().then(()=>closeClerk(clerk))]);if(results.some(r=>r.status==='rejected'))throw unavailable();},closeTimeoutMs);}catch{response=fallback();}
      clearTimeout(timer);request.signal.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',stop);
    }
    const headers=new Headers(response.headers);headers.set('cdn-cache-control','no-store');headers.set('cloudflare-cdn-cache-control','no-store');
    return new Response(response.body,{status:response.status,headers});
  }};
}

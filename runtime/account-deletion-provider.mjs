import {ApiFault} from '../supabase/functions/univeracademy-api/fault.ts';
const unavailable=()=>new ApiFault('SERVICE_UNAVAILABLE',503);
const validOrigin=value=>{try{const u=new URL(value);return u.protocol==='https:'&&u.origin===value&&!u.username&&!u.password;}catch{return false;}};
/** Recovery-only transport. Readiness is fetched under the SAME key on every
 * attempt, not a cached boolean. Pinned instance ID comes from reviewed server
 * configuration; issuer must also match Clerk's authenticated domain response.
 * All requests (including readiness) use one bounded deadline and a per-response body budget.
 * Never log tokens, bodies or identities. */
export function createClerkDeletionTransport({secretKey,expectedIssuer,expectedInstanceId,transport,timeoutMs=5000,maxResponseBytes=8192}={}){
  if(typeof secretKey!=='string'||!secretKey||/[\r\n\0]/.test(secretKey)||typeof transport!=='function'||
    !validOrigin(expectedIssuer)||!/^ins_[A-Za-z0-9]+$/.test(expectedInstanceId??'')||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||
    !Number.isSafeInteger(maxResponseBytes)||maxResponseBytes<1||maxResponseBytes>65536)throw unavailable();
  return async(userId,issuer)=>{
    if(!/^user_[A-Za-z0-9]+$/.test(userId)||issuer!==expectedIssuer)throw unavailable();
    const controller=new AbortController();let reader;const timer=setTimeout(()=>controller.abort(),timeoutMs);
    const abort=()=>{void reader?.cancel().catch(()=>{});};controller.signal.addEventListener('abort',abort);
    let rejectAbort;
    const aborted=new Promise((_,reject)=>{rejectAbort=()=>reject(unavailable());controller.signal.addEventListener('abort',rejectAbort,{once:true});});
    const json=async(path,method='GET',allowAbsent=false)=>{
      const url='https://api.clerk.com/v1'+path;
      const response=await transport(new Request(url,{method,headers:{authorization:'Bearer '+secretKey,accept:'application/json'},
        redirect:'manual',credentials:'omit',cache:'no-store',signal:controller.signal}));
      if(controller.signal.aborted){void response?.body?.cancel().catch(()=>{});throw unavailable();}
      if(!(response instanceof Response))throw unavailable();
      if(response.redirected||(response.url&&response.url!==url)){void response.body?.cancel().catch(()=>{});throw unavailable();}
      if(allowAbsent&&response.status===404){void response.body?.cancel().catch(()=>{});return null;}
      if(response.status!==200||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')){
        void response.body?.cancel().catch(()=>{});throw unavailable();
      }
      reader=response.body?.getReader();if(!reader)throw unavailable();
      let size=0;const chunks=[];
      try{
        for(;;){const part=await reader.read();if(controller.signal.aborted)throw unavailable();if(part.done)break;
          size+=part.value.byteLength;if(size>maxResponseBytes)throw unavailable();chunks.push(part.value);}
        const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
        try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw unavailable();}
      }finally{void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}reader=undefined;}
    };
    const work=async()=>{
      const instance=await json('/instance');
      if(instance?.id!==expectedInstanceId||instance.environment_type!=='production')throw unavailable();
      const domains=await json('/domains');
      if(!Array.isArray(domains?.data)||!domains.data.some(d=>d?.is_satellite===false&&d.frontend_api_url===expectedIssuer))throw unavailable();
      // A 404 can mean absence only AFTER the same key is bound to this exact
      // production instance and expected issuer. Readiness failure never DELETEs.
      const deleted=await json('/users/'+userId,'DELETE',true);
      if(deleted===null)return 'absent';
      if(deleted?.id!==userId||deleted.deleted!==true||deleted.object!=='user')throw unavailable();
      return 'deleted';
    };
    try{return await Promise.race([work(),aborted]);}catch{throw unavailable();}
    finally{clearTimeout(timer);controller.signal.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',rejectAbort);}
  };
}

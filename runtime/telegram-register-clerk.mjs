import {ApiFault} from '../supabase/functions/univeracademy-api/fault.ts';
const unavailable=()=>new ApiFault('SERVICE_UNAVAILABLE',503);
const userId=v=>typeof v==='string'&&/^user_[A-Za-z0-9]+$/.test(v);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);

/** Quick-registration Clerk Backend API calls only: find by external_id,
 * create a password-less user, and mint a one-time sign-in token. Uses the
 * API Worker's existing secret key. Never logs or returns bodies, tokens or
 * identities; never follows redirects. Every call shares one deadline. */
export function createClerkRegisterTransport({secretKey,transport,timeoutMs=5000,maxResponseBytes=65536,signal}={}){
  if(typeof secretKey!=='string'||!secretKey||/[\r\n\0]/.test(secretKey)||typeof transport!=='function'||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isSafeInteger(maxResponseBytes)||maxResponseBytes<1||maxResponseBytes>1048576||
    (signal!==undefined&&!(signal instanceof AbortSignal)))throw unavailable();
  async function call(path,method,body){
    const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const url='https://api.clerk.com/v1'+path;let reader;
    try{
      const response=await transport(new Request(url,{method,headers:{authorization:'Bearer '+secretKey,accept:'application/json',
        ...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,
        redirect:'manual',credentials:'omit',cache:'no-store',signal:controller.signal}));
      if(!(response instanceof Response)||response.redirected||(response.url&&response.url!==url)){void response?.body?.cancel().catch(()=>{});throw unavailable();}
      if(controller.signal.aborted){void response.body?.cancel().catch(()=>{});throw unavailable();}
      const status=response.status;
      if(status!==200){void response.body?.cancel().catch(()=>{});return {status,value:null};}
      if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))throw unavailable();
      reader=response.body?.getReader();if(!reader)throw unavailable();
      let size=0;const chunks=[];
      for(;;){const part=await reader.read();if(controller.signal.aborted)throw unavailable();if(part.done)break;
        size+=part.value.byteLength;if(size>maxResponseBytes)throw unavailable();chunks.push(part.value);}
      const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
      try{return {status,value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))};}catch{throw unavailable();}
    }catch(error){if(error instanceof ApiFault)throw error;throw unavailable();}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}}
  }
  return Object.freeze({
    async findByExternalId(externalId){
      if(!/^tg:[1-9][0-9]{0,15}$/.test(externalId))throw unavailable();
      const r=await call('/users?external_id='+encodeURIComponent(externalId)+'&limit=10','GET');
      if(r.status!==200||!Array.isArray(r.value))throw unavailable();
      // Defense in depth: keep only exact external_id matches.
      return r.value.filter(u=>object(u)&&u.external_id===externalId).map(u=>{if(!userId(u.id))throw unavailable();return Object.freeze({id:u.id});});
    },
    async createUser({externalId,firstName,lastName}){
      if(!/^tg:[1-9][0-9]{0,15}$/.test(externalId))throw unavailable();
      const r=await call('/users','POST',{external_id:externalId,first_name:firstName,last_name:lastName,skip_password_requirement:true});
      // 422: Clerk rejected the form — most commonly a concurrent request already
      // took this external_id. The caller re-reads; nothing else is assumed.
      if(r.status===422)return 'exists';
      if(r.status!==200||!object(r.value)||!userId(r.value.id)||r.value.external_id!==externalId)throw unavailable();
      return Object.freeze({id:r.value.id});
    },
    async createSignInToken(id,expiresInSeconds){
      if(!userId(id)||!Number.isSafeInteger(expiresInSeconds)||expiresInSeconds<120||expiresInSeconds>300)throw unavailable();
      const r=await call('/sign_in_tokens','POST',{user_id:id,expires_in_seconds:expiresInSeconds});
      if(r.status!==200||!object(r.value)||r.value.user_id!==id||typeof r.value.token!=='string'||!r.value.token)throw unavailable();
      return r.value.token;
    },
  });
}

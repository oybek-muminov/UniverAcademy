// Private, read-only production-key readiness. No DB/job/delete imports or writes.
// No caller-selectable URL, method, key, identity, transport or environment.
const INSTANCE='ins_3MCOWSoxSn5iEznhJMU0F1QKJtB';
const ISSUER='https://clerk.univeracademy.uz';
const ORIGIN='https://api.clerk.com';
export async function checkDeletionProviderReadiness(env){
 const controller=new AbortController();let timer,reader;
 const stop=()=>{controller.abort();if(reader)void reader.cancel().catch(()=>{});};
 try{
  if(env?.UA_DELETION_RECOVERY_ENABLED!=='false'||env.UA_CLERK_INSTANCE_ID!==INSTANCE||env.UA_CLERK_ISSUER!==ISSUER)return{ready:false};
  const secret=env.UA_CLERK_SECRET_KEY;
  if(typeof secret!=='string'||!secret.startsWith('sk_live_')||secret.length>4096||/[\r\n\0]/.test(secret))return{ready:false};
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{stop();reject(Error('UNCONFIRMED'));},5000);});
  const get=async path=>{
   if(controller.signal.aborted)throw Error('UNCONFIRMED');
   const url=ORIGIN+path;
   const response=await fetch(url,{method:'GET',headers:{authorization:'Bearer '+secret,accept:'application/json'},redirect:'manual',credentials:'omit',cache:'no-store',signal:controller.signal});
   if(controller.signal.aborted||response.status!==200||response.redirected||response.url!==url||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')){
    void response.body?.cancel().catch(()=>{});throw Error('UNCONFIRMED');
   }
   reader=response.body?.getReader();if(!reader)throw Error('UNCONFIRMED');
   let length=0;const chunks=[];const active=reader;
   try{
    for(;;){const part=await active.read();if(controller.signal.aborted)throw Error('UNCONFIRMED');if(part.done)break;
     length+=part.value.byteLength;if(length>8192)throw Error('UNCONFIRMED');chunks.push(part.value);}
    const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   }finally{void active.cancel().catch(()=>{});try{active.releaseLock();}catch{}if(reader===active)reader=undefined;}
  };
  const work=async()=>{
   const instance=await get('/v1/instance');
   if(instance?.id!==INSTANCE||instance.environment_type!=='production')return{ready:false};
   const domains=await get('/v1/domains');
   return{ready:Array.isArray(domains?.data)&&domains.data.some(d=>d?.is_satellite===false&&d.frontend_api_url===ISSUER)};
  };
  return await Promise.race([work(),deadline]);
 }catch{return{ready:false};}
 finally{clearTimeout(timer);stop();}
}

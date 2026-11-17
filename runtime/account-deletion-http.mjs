import {ApiFault} from '../supabase/functions/univeracademy-api/fault.ts';
/** Unmounted route candidate. Explicit origin check applies even to bearer
 * requests; receipt bearer only in header, never URL/referrer/history/logs. */
export function createDeletionHttp({requests,allowedOrigins,maxBodyBytes=2048}){
  if(!Array.isArray(allowedOrigins)||!allowedOrigins.length||allowedOrigins.some(x=>new URL(x).origin!==x||!x.startsWith('https://')))throw Error('configuration required');
  const reply=(status,data,origin)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','cache-control':'no-store','vary':'Origin',...(origin?{'access-control-allow-origin':origin}:{})}});
  return async(request)=>{
    const origin=request.headers.get('origin');
    if(!origin||!allowedOrigins.includes(origin))return reply(403,{error:{code:'FORBIDDEN'}},null);
    try{
      const url=new URL(request.url);
      if(url.search||!['/api/v1/me/deletion','/api/v1/me/deletion/status'].includes(url.pathname))throw new ApiFault('NOT_FOUND',404);
      if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'access-control-allow-origin':origin,'access-control-allow-methods':'POST, GET, OPTIONS','access-control-allow-headers':'authorization, content-type, x-clerk-token, x-deletion-receipt','cache-control':'no-store','vary':'Origin'}});
      if(url.pathname.endsWith('/status')){
        if(request.method!=='GET')throw new ApiFault('METHOD_NOT_ALLOWED',405);
        return reply(200,await requests.status(request.headers.get('x-deletion-receipt')??''),origin);
      }
      if(request.method!=='POST')throw new ApiFault('METHOD_NOT_ALLOWED',405);
      if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))throw new ApiFault('INVALID_REQUEST',400);
      const auth=request.headers.get('authorization')??'';
      if(!auth.startsWith('Bearer ')||!auth.slice(7)||/\s/.test(auth.slice(7)))throw new ApiFault('UNAUTHORIZED',401);
      const reader=request.body?.getReader();if(!reader)throw new ApiFault('INVALID_REQUEST',400);
      const abort=()=>{void reader.cancel().catch(()=>{});};
      request.signal.addEventListener('abort',abort,{once:true});
      let bytes=0,chunks=[];
      try{for(;;){if(request.signal.aborted)throw new ApiFault('SERVICE_UNAVAILABLE',503);const part=await reader.read();if(request.signal.aborted)throw new ApiFault('SERVICE_UNAVAILABLE',503);if(part.done)break;bytes+=part.value.byteLength;if(bytes>maxBodyBytes)throw new ApiFault('INVALID_REQUEST',400);chunks.push(part.value);}}
      finally{request.signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});reader.releaseLock();}
      const data=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
      let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{throw new ApiFault('INVALID_REQUEST',400);}
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='confirmation,receipt,requestId'||
        !Object.values(body).every(v=>typeof v==='string'))throw new ApiFault('INVALID_REQUEST',400);
      return reply(202,await requests.submit({...body,accessToken:auth.slice(7),clerkToken:request.headers.get('x-clerk-token')??''}),origin);
    }catch(error){
      // Do not return driver/provider messages, request data, or account IDs.
      const known=error instanceof ApiFault;
      return reply(known?error.status:503,{error:{code:known?error.code:'SERVICE_UNAVAILABLE'}},origin);
    }
  };
}

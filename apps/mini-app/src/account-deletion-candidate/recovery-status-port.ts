/** Public, status-only adapter. No app token, Clerk session or /me lookup needed. */
import {DeletionStatusMissing} from './controller.ts';
export function createPublicRecoveryStatus(config:{apiOrigin:string;fetch?:typeof fetch;timeoutMs?:number}) {
  const url=new URL(config.apiOrigin);
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Invalid API origin');
  const timeoutMs=config.timeoutMs??10000;
  if(!Number.isFinite(timeoutMs)||timeoutMs<5000||timeoutMs>15000)throw new Error('Invalid recovery timeout');
  return async(receipt:string):Promise<{status:'pending'|'completed'}>=>{
    const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(new Error('Status deadline exceeded'));abort.abort()},timeoutMs)});
    const run=async():Promise<{status:'pending'|'completed'}>=>{
      const response=await(config.fetch??globalThis.fetch)(url.origin+'/api/v1/me/deletion/status',{method:'GET',headers:{'x-deletion-receipt':receipt,Accept:'application/json'},credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:abort.signal});
      if(response.status===404)throw new DeletionStatusMissing();
      if(!response.ok)throw new Error('Status unavailable');
      const body:unknown=await response.json();
      if(!body||typeof body!=='object'||!('status'in body)||(body.status!=='pending'&&body.status!=='completed'))throw new Error('Status unavailable');
      return{status:body.status};
    };
    try{return await Promise.race([run(),timeout])}finally{clearTimeout(timer)}
  };
}

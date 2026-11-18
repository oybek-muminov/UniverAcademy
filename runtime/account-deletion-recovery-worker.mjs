import {WorkflowEntrypoint} from 'cloudflare:workers';
import {checkDeletionProviderReadiness} from './account-deletion-readiness.mjs';
// REST-triggered private operational check. No public endpoint or cron required.
// Registry points to this class; no Workflow env binding is added to recovery.
export class DeletionProviderReadinessWorkflow extends WorkflowEntrypoint{
 async run(_event,step){
  return step.do('verify-clerk-production-key',{retries:{limit:0,delay:'1 second'},timeout:'10 seconds'},()=>checkDeletionProviderReadiness(this.env));
 }
}
import {createCloudflarePostgres} from './cloudflare-postgres.mjs';
import {isHyperdriveConnectionString} from './hyperdrive-connection-string.mjs';
import {AccountDeletionRecovery} from '../supabase/functions/univeracademy-api/storage/account-deletion-rows.ts';
import {createDeletionRecovery} from '../supabase/functions/univeracademy-api/account-deletion.ts';
import {createClerkDeletionTransport} from './account-deletion-provider.mjs';
const failure=()=>new Error('ACCOUNT_DELETION_RECOVERY_UNCONFIRMED');
const keys=['UA_DELETION_RECOVERY_ENABLED','HYPERDRIVE_DELETION_RECOVERY','UA_CLERK_ISSUER','UA_CLERK_INSTANCE_ID','UA_CLERK_SECRET_KEY'];
const own=(o,k)=>{const d=o&&Object.getOwnPropertyDescriptor(o,k);if(!d||!Object.hasOwn(d,'value'))throw failure();return d.value;};
const warn=(log,code)=>{try{log('UA_ACCOUNT_DELETION_RECOVERY',code);}catch{}};
function configuration(env){
 if(!env||typeof env!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(env))||Reflect.ownKeys(env).some(k=>!keys.includes(k)))throw failure();
 const enabled=Object.getOwnPropertyDescriptor(env,'UA_DELETION_RECOVERY_ENABLED');
 if(!enabled)return null;
 if(!Object.hasOwn(enabled,'value'))throw failure();
 if(enabled.value==='false')return null;
 if(enabled.value!=='true')throw failure();
 const drive=own(env,'HYPERDRIVE_DELETION_RECOVERY');
 if(!drive||typeof drive!=='object'||Array.isArray(drive))throw failure();
 const connectionString=drive.connectionString; // trusted platform binding accessor only
 if(!isHyperdriveConnectionString(connectionString))throw failure();
 return {postgres:{connectionString},issuer:own(env,'UA_CLERK_ISSUER'),instance:own(env,'UA_CLERK_INSTANCE_ID'),secret:own(env,'UA_CLERK_SECRET_KEY')};
}
/** Scheduled-only LOCAL CANDIDATE. No live binding, cron or ACL is installed.
 * Role must have only due/claim/mark/finish EXECUTE plus schema access, never
 * request permission or executor membership. Hyperdrive cache OFF/verify-full
 * origin TLS are deployment gates. No warm client/global state or HTTP trigger.
 * Factory seams are trusted code only; not selectable by environment/caller. */
export function createAccountDeletionRecoveryWorker({loadClient=async()=>(await import('pg')).Client,
 transport=request=>globalThis.fetch(request),log=(...args)=>console.warn(...args),runTimeoutMs=20000,closeTimeoutMs=3000}={}){
 if([loadClient,transport,log].some(f=>typeof f!=='function')||!Number.isSafeInteger(runTimeoutMs)||runTimeoutMs<1||runTimeoutMs>20000||!Number.isSafeInteger(closeTimeoutMs)||closeTimeoutMs<1||closeTimeoutMs>3000)throw failure();
 return Object.freeze({
  async fetch(){return new Response(null,{status:404,headers:{'cache-control':'no-store'}});},
  async scheduled(_event,env){
   let db,timer,closeTimer,processed=0,failed=false;
   const controller=new AbortController();
   try{
    const cfg=configuration(env);if(!cfg)return {processed:0,disabled:true};
    // Validate provider identity configuration before acquiring any DB resource.
    const removeProvider=createClerkDeletionTransport({secretKey:cfg.secret,expectedIssuer:cfg.issuer,expectedInstanceId:cfg.instance,transport,timeoutMs:5000});
    const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(failure());},runTimeoutMs);});
    const work=async()=>{
     const Client=await loadClient();if(controller.signal.aborted||typeof Client!=='function')throw failure();
     db=createCloudflarePostgres(Client,cfg.postgres,{signal:controller.signal});
     const store=new AccountDeletionRecovery(db.pool,'ua_deletion_recovery_login');
     const run=createDeletionRecovery({enabled:true,issuer:cfg.issuer,store,removeProvider});
     for(let n=0;n<3;n++){
      if(controller.signal.aborted)throw failure();
      const result=await run();if(!result.processed)break;processed++;
     }
    };
    await Promise.race([work(),expired]);
   }catch{failed=true;warn(log,'RUN_UNCONFIRMED');}
   finally{
    clearTimeout(timer);controller.abort();
    if(db){
     try{await Promise.race([db.close(),new Promise((_,reject)=>{closeTimer=setTimeout(()=>reject(failure()),closeTimeoutMs);})]);}
     catch{failed=true;warn(log,'CLOSE_UNCONFIRMED');}
     finally{clearTimeout(closeTimer);}
    }
   }
   if(failed)throw failure();
   return {processed,disabled:false};
  },
 });
}
export default createAccountDeletionRecoveryWorker();

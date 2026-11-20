import { cabinetQueryAllowed } from './teacher-student-directory.mjs';
import { ApiFault } from '../supabase/functions/univeracademy-api/fault.ts';
import { createClerkWorkerAdapter } from './clerk-worker-bindings.mjs';
import { ownBody,untilAborted } from './cloudflare-api.mjs';
import { createCloudflarePostgres } from './cloudflare-postgres.mjs';
import { isHyperdriveConnectionString } from './hyperdrive-connection-string.mjs';
import { publicHttpsOrigin } from './local-cors.mjs';

const unavailable=()=>new ApiFault('SERVICE_UNAVAILABLE',503);
const noStore={'Cache-Control':'no-store','Cloudflare-CDN-Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
function failure(code,status,origin){
  const headers=new Headers(noStore);
  if(origin){headers.set('access-control-allow-origin',origin);headers.set('vary','Origin');}
  return Response.json({error:{code,message:code}},{status,headers});
}
function value(env,key){
  const d=env&&Object.getOwnPropertyDescriptor(env,key);
  if(!d||!Object.hasOwn(d,'value'))throw unavailable();
  return d.value;
}
// A dedicated binding must actually authenticate as the restricted cabinet login.
// Run the probe after BEGIN on the transaction's physical PostgreSQL connection.
// Nothing from an HTTP header, JWT role claim or Hyperdrive hostname substitutes
// for the current login and grants; canonical transactions still SET LOCAL ROLE.
const capabilitySql=`SELECT r.rolcanlogin AND NOT r.rolinherit AND NOT r.rolsuper AND NOT r.rolcreaterole
  AND NOT r.rolcreatedb AND NOT r.rolbypassrls AND NOT r.rolreplication AND current_user=session_user
  AND (SELECT count(*) FROM pg_auth_members WHERE member=r.oid)=2
  AND EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid AND roleid='ua_api_login'::regrole
    AND inherit_option AND NOT set_option AND NOT admin_option)
  AND EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid AND roleid='ua_cabinet_stage'::regrole
    AND set_option AND NOT inherit_option AND NOT admin_option) AS authorized
  FROM pg_roles r WHERE r.rolname=current_user`;

function cabinetPool(pool){
  return {async connect(){
    const lease=await pool.connect();
    let began=false,verified=false;
    return {async query(statement){
      if(!began){
        if(statement.text!=='BEGIN')throw unavailable();
        const result=await lease.query(statement);
        began=true;
        return result;
      }
      if(!verified && statement.text!=='ROLLBACK'){
        const {rows}=await lease.query({text:capabilitySql,values:[]});
        if(rows.length!==1||rows[0].authorized!==true)throw unavailable();
        verified=true;
      }
      return lease.query(statement);
    },release:discard=>lease.release(discard)};
  }};
}
function clerkConfiguration(env,teacherOrigin){
  const json=value(env,'UA_CLERK_PROVIDER_SETTINGS');
  if(typeof json!=='string'||json.length>65536)throw unavailable();
  const settings=JSON.parse(json);
  if(!Array.isArray(settings?.authorizedParties)||!settings.authorizedParties.length ||
      new Set(settings.authorizedParties).size!==settings.authorizedParties.length)throw unavailable();
  // The registration service keeps its original parties. This request's staff
  // verifier is also narrowed to the configured teacher origin by the shared API.
  return {...settings,authorizedParties:[...new Set([...settings.authorizedParties,teacherOrigin])]};
}
async function closeOwned(clerk,db,ms){
  let timer;
  const released=Promise.allSettled([clerk,db].map(resource=>Promise.resolve().then(()=>resource?.close())));
  try{
    const results=await Promise.race([released,new Promise((_,reject)=>{timer=setTimeout(()=>reject(unavailable()),ms);})]);
    if(results.some(r=>r.status==='rejected'))throw unavailable();
  }finally{clearTimeout(timer);}
}

export function createWorkerCabinetHandler({createApi,loadClient=async()=>(await import('pg')).Client,
  makeClerk=createClerkWorkerAdapter,transport=request=>globalThis.fetch(request),now=Date.now,
  timeoutMs=15000,closeTimeoutMs=2000}={}){
  if([createApi,loadClient,makeClerk,transport,now].some(v=>typeof v!=='function') ||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>30000 ||
    !Number.isSafeInteger(closeTimeoutMs)||closeTimeoutMs<=0||closeTimeoutMs>5000)throw unavailable();
  return {async fetch(request,env){
    if(!(request instanceof Request))return failure('SERVICE_UNAVAILABLE',503);
    let clerk,db,body,timer,origin;
    const controller=new AbortController(),abort=()=>controller.abort();
    try{
      if(env?.UA_CABINET_RUNTIME!=='worker'||env?.UA_CABINET_STAGING_ENABLED!=='true')return failure('NOT_FOUND',404);
      const teacherOrigin=publicHttpsOrigin(value(env,'UA_CABINET_TEACHER_ORIGIN'));
      const studentOrigin=publicHttpsOrigin(value(env,'UA_CABINET_STUDENT_ORIGIN'));
      const apiOrigin=publicHttpsOrigin(value(env,'UA_API_ORIGIN'));
      const url=new URL(request.url),role=/^\/api\/v1\/(teacher|admin|student)\/pilot\//.exec(url.pathname)?.[1];
      if(!role||!cabinetQueryAllowed(url,request.method)||url.hash||url.username||url.password||
        (role==='student'?url.origin!==studentOrigin&&url.origin!==apiOrigin:url.origin!==teacherOrigin))return failure('NOT_FOUND',404);
      const expected=role==='student'?studentOrigin:teacherOrigin;
      if(request.headers.has('origin')&&request.headers.get('origin')!==expected)return failure('FORBIDDEN',403);
      if(request.headers.get('origin')===expected)origin=expected;
      if(request.signal.aborted)throw unavailable();
      request.signal.addEventListener('abort',abort,{once:true});
      timer=setTimeout(abort,timeoutMs);
      const binding=value(env,'CABINET_HYPERDRIVE'),connectionString=binding?.connectionString;
      if(!isHyperdriveConnectionString(connectionString))throw unavailable();
      const settings=clerkConfiguration(env,teacherOrigin);
      const secretKey=value(env,'UA_CLERK_SECRET_KEY');
      if(typeof secretKey!=='string'||!secretKey||/[\r\n\0]/.test(secretKey))throw unavailable();
      const mode=env.UA_CABINET_ALLOW_LEGACY_TELEGRAM;
      if(mode!==undefined&&mode!=='true'&&mode!=='false')throw unavailable();
      const scoped=new Request(request,{signal:controller.signal});
      body=ownBody(scoped);
      // Provider creation is a local operation. The transport receives the same
      // cancellation signal as the body, liveness checks and physical DB client.
      await untilAborted(async()=>{
        const created=await makeClerk(settings,{secretKey,transport,now,timeoutMs:settings.timeoutMs,maxResponseBytes:65536,signal:controller.signal});
        if(controller.signal.aborted){
          await closeOwned(created,null,closeTimeoutMs);
          throw unavailable();
        }
        clerk=created;
      },controller.signal);
      if(typeof clerk?.close!=='function'||typeof clerk.liveness!=='function')throw unavailable();
      const Client=await untilAborted(loadClient,controller.signal);
      if(controller.signal.aborted)throw unavailable();
      db=createCloudflarePostgres(Client,{connectionString},{signal:controller.signal});
      const options={enabled:true,teacherOrigin,studentOrigin,apiOrigin,pool:cabinetPool(db.pool),
        verifier:clerk.verifier,liveness:clerk.liveness,allowLegacyTelegram:mode==='true'};
      const result=await untilAborted(()=>createApi(options).fetch(body.request),controller.signal);
      if(!(result instanceof Response))throw unavailable();
      const headers=new Headers(result.headers);
      for(const [name,val] of Object.entries(noStore))headers.set(name,val);
      return new Response(result.body,{status:result.status,headers});
    }catch{return failure('SERVICE_UNAVAILABLE',503,origin);}
    finally{
      clearTimeout(timer);
      request.signal.removeEventListener('abort',abort);
      body?.close();
      try{await closeOwned(clerk,db,closeTimeoutMs);}
      catch{return failure('SERVICE_UNAVAILABLE',503,origin);}
    }
  }};
}

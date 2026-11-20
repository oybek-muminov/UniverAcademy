import { cabinetQueryAllowed } from './teacher-student-directory.mjs';
// Node-only stage host. No browser code, real credentials or database connection exists at import time.
import { createHash,timingSafeEqual } from 'node:crypto';
import { teacherStagingPath } from './teacher-staging-proxy.mjs';

const deny=(code,status)=>Response.json({error:{code,message:code}},{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
function validOrigin(value) {
  try {const url=new URL(value);return url.origin===value&&url.protocol==='https:';} catch{return false;}
}
function sameSecret(secret,input) {
  if(typeof secret!=='string'||secret.length<32||typeof input!=='string'||input.length>2048)return false;
  const digest=value=>createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(secret),digest(input));
}
async function createFromEnvironment(env) {
  const teacherOrigin=env.UA_CABINET_TEACHER_ORIGIN,studentOrigin=env.UA_CABINET_STUDENT_ORIGIN,apiOrigin=env.UA_API_ORIGIN;
  if(![teacherOrigin,studentOrigin,apiOrigin].every(validOrigin)) throw Error('STAGING_ORIGINS_REQUIRED');
  const db=new URL(env.UA_CABINET_STAGING_DATABASE_URL);
  if (!['postgres:','postgresql:'].includes(db.protocol)||!db.username||!db.hostname||
    (!['localhost','127.0.0.1','[::1]'].includes(db.hostname)&&db.searchParams.get('sslmode')!=='verify-full')) throw Error('STAGING_DATABASE_REQUIRED');
  const settings=JSON.parse(env.UA_CABINET_CLERK_SETTINGS);
  if(!settings.authorizedParties.includes(teacherOrigin))throw Error('STAFF_ORIGIN_REQUIRED');
  const [{default:pg},{createClerkWorkerAdapter},{createTeacherStagingApi}]=await Promise.all([
    import('pg'),import('./clerk-worker-bindings.mjs'),import('./teacher-staging-api.mjs')]);
  const clerk=await createClerkWorkerAdapter(settings,{secretKey:env.UA_CABINET_CLERK_SECRET,
    timeoutMs:settings.timeoutMs,maxResponseBytes:settings.maxJwksBytes,transport:request=>fetch(request),now:Date.now});
  const pool=new pg.Pool({connectionString:db.href,max:4,connectionTimeoutMillis:3000,idleTimeoutMillis:15000,allowExitOnIdle:true});
  return createTeacherStagingApi({enabled:true,pool,teacherOrigin,studentOrigin,apiOrigin,verifier:clerk.verifier,liveness:clerk.liveness,
    allowLegacyTelegram:env.UA_CABINET_ALLOW_LEGACY_TELEGRAM==='true'});
}
export function createTeacherStageNode(readEnv,createApi=createFromEnvironment) {
  let warm;
  return {async fetch(request){
    const url=new URL(request.url),env=readEnv();
    if(env.UA_CABINET_STAGING_ENABLED!=='true'||!teacherStagingPath(url.pathname))return deny('NOT_FOUND',404);
    if(!validOrigin(env.UA_CABINET_STAGING_NODE_ORIGIN)||url.origin!==env.UA_CABINET_STAGING_NODE_ORIGIN||
      !sameSecret(env.UA_CABINET_STAGING_PROXY_SECRET,request.headers.get('x-univeracademy-pilot-proxy'))) return deny('FORBIDDEN',403);
    if(!cabinetQueryAllowed(url,request.method)||url.hash)return deny('NOT_FOUND',404);
    const publicOrigin=url.pathname.startsWith('/api/v1/student/')?env.UA_API_ORIGIN:env.UA_CABINET_TEACHER_ORIGIN;
    if(!validOrigin(publicOrigin))return deny('SERVICE_UNAVAILABLE',503);
    try {
      warm??=createApi(env).catch(error=>{warm=undefined;throw error;});
      const service=await warm,headers=new Headers(request.headers);
      headers.delete('x-univeracademy-pilot-proxy');for (const name of ['host','cookie','forwarded','x-forwarded-host','x-forwarded-proto'])headers.delete(name);
      return await service.fetch(new Request(publicOrigin+url.pathname+url.search,{method:request.method,headers,signal:request.signal,
        ...(request.body?{body:request.body,duplex:'half'}:{})}));
    }catch{return deny('SERVICE_UNAVAILABLE',503);}
  }};
}

import { cabinetRole } from './cabinet-role.mjs';
import { cabinetQueryAllowed } from './teacher-student-directory.mjs';
// Pages sends staff requests to a named Worker service or the configured legacy Node upstream.
const noStore={'cache-control':'no-store','cdn-cache-control':'no-store','x-content-type-options':'nosniff'};
const error=(code,status)=>Response.json({error:{code,message:code}},{status,headers:noStore});
// The Owner cabinet has its own origin and gateway; the Ustoz surface never carries it.
export const teacherStagingPath=(path,method='GET')=>{const role=cabinetRole(path,method);return Boolean(role)&&role!=='owner';};
function origin(value) {
  try {const u=new URL(value);if(u.protocol==='https:'&&u.origin===value)return u.origin;}catch{}
  return null;
}
export async function forwardTeacherStaging(request,env,{surface,transport=fetch}={}) {
  const url=new URL(request.url);
  const role=cabinetRole(url.pathname,request.method);
  if (env?.UA_CABINET_STAGING_ENABLED!=='true'||!role||
      (surface==='teacher'?(role==='student'||role==='owner'):surface==='owner'?role!=='owner':surface!=='student'||role!=='student')||
      !cabinetQueryAllowed(url,request.method)||url.hash) return error('NOT_FOUND',404);
  const external=origin(surface==='teacher'?env.UA_CABINET_TEACHER_ORIGIN:surface==='owner'?env.UA_CABINET_OWNER_ORIGIN:env.UA_API_ORIGIN);
  if (!external) return error('SERVICE_UNAVAILABLE',503);
  if (url.origin!==external || !['GET','POST','OPTIONS'].includes(request.method))return error('NOT_FOUND',404);
  const runtime=env.UA_CABINET_RUNTIME;
  let destination,secret,send;
  if (runtime==='worker') {
    if (surface==='student') return error('NOT_FOUND',404);
    const callerOrigin=request.headers.get('origin');
    if (callerOrigin!==null && callerOrigin!==external) return error('FORBIDDEN',403);
    const api=env.UA_CABINET_API;
    if (typeof api?.fetch!=='function') return error('SERVICE_UNAVAILABLE',503);
    destination=external;
    send=req=>api.fetch(req);
  } else if (runtime===undefined || runtime==='node') {
    if (surface==='owner') return error('NOT_FOUND',404); // Owner exists only on the Cloudflare Worker runtime.
    destination=origin(env.UA_CABINET_STAGING_NODE_ORIGIN);
    secret=env.UA_CABINET_STAGING_PROXY_SECRET;
    if (!destination || external===destination || typeof secret!=='string' || secret.length<32 || /[\r\n]/u.test(secret))
      return error('SERVICE_UNAVAILABLE',503);
    send=transport;
  } else return error('SERVICE_UNAVAILABLE',503);
  try {
    const headers=new Headers();
    for (const k of ['authorization','content-type','content-length','accept','idempotency-key','origin','access-control-request-method','access-control-request-headers']) {
      const value=request.headers.get(k);if(value!==null)headers.set(k,value);
    }
    if (secret!==undefined) headers.set('x-univeracademy-pilot-proxy',secret);
    const r=await send(new Request(destination+url.pathname+url.search,{method:request.method,headers,
      ...(request.body?{body:request.body,duplex:'half'}:{}),signal:request.signal,redirect:'manual'}));
    if (r.status>=300&&r.status<400)return error('SERVICE_UNAVAILABLE',503);
    const output=new Headers(noStore);
    for (const k of ['content-type','access-control-allow-origin','access-control-allow-methods','access-control-allow-headers','vary','referrer-policy']) {
      const value=r.headers.get(k);if(value)output.set(k,value);
    }
    return new Response(r.body,{status:r.status,headers:output});
  }catch{return error('SERVICE_UNAVAILABLE',503);}
}

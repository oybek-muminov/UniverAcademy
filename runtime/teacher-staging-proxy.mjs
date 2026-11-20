// Public edge adapter. Only the original reviewed origin and a fixed Node upstream may exchange this credential.
const noStore={'cache-control':'no-store','cdn-cache-control':'no-store','x-content-type-options':'nosniff'};
const error=(code,status)=>Response.json({error:{code,message:code}},{status,headers:noStore});
export const teacherStagingPath=path=>/^\/api\/v1\/(?:teacher|admin|student)\/pilot\//.test(path);
function origin(value) {
  try {const u=new URL(value);if(u.protocol==='https:'&&u.origin===value)return u.origin;}catch{}
  return null;
}
export async function forwardTeacherStaging(request,env,{surface,transport=fetch}={}) {
  const url=new URL(request.url);
  const role=/^\/api\/v1\/(teacher|admin|student)\/pilot\//.exec(url.pathname)?.[1];
  if (env?.UA_CABINET_STAGING_ENABLED!=='true'||!role||
      (surface==='teacher'?!['teacher','admin'].includes(role):surface!=='student'||role!=='student')||url.search||url.hash) return error('NOT_FOUND',404);
  const external=origin(surface==='teacher'?env.UA_CABINET_TEACHER_ORIGIN:env.UA_API_ORIGIN);
  const upstream=origin(env.UA_CABINET_STAGING_NODE_ORIGIN);
  const secret=env.UA_CABINET_STAGING_PROXY_SECRET;
  if (!external||!upstream||external===upstream||typeof secret!=='string'||secret.length<32||/[\r\n]/u.test(secret))
    return error('SERVICE_UNAVAILABLE',503);
  if (url.origin!==external || !['GET','POST','OPTIONS'].includes(request.method))return error('NOT_FOUND',404);
  try {
    const headers=new Headers();
    for (const k of ['authorization','content-type','content-length','accept','idempotency-key','origin','access-control-request-method','access-control-request-headers']) {
      const value=request.headers.get(k);if(value!==null)headers.set(k,value);
    }
    headers.set('x-univeracademy-pilot-proxy',secret);
    const r=await transport(new Request(upstream+url.pathname,{method:request.method,headers,
      ...(request.body?{body:request.body,duplex:'half'}:{}),signal:request.signal,redirect:'manual'}));
    if (r.status>=300&&r.status<400)return error('SERVICE_UNAVAILABLE',503);
    const output=new Headers(noStore);
    for (const k of ['content-type','access-control-allow-origin','access-control-allow-methods','access-control-allow-headers','vary','referrer-policy']) {
      const value=r.headers.get(k);if(value)output.set(k,value);
    }
    return new Response(r.body,{status:r.status,headers:output});
  }catch{return error('SERVICE_UNAVAILABLE',503);}
}

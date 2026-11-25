import { cabinetRole } from './cabinet-role.mjs';
import { cabinetQueryAllowed } from './teacher-student-directory.mjs';
const headers = {'cache-control':'no-store','x-content-type-options':'nosniff'};
const deny = (code,status) => Response.json({error:{code,message:code}}, {status,headers});

// The staff entry point is reachable only over a service binding. The public
// entry point admits only student routes on the configured API origin.
export async function fetchNativeCabinet(request, env, surface) {
  if (env?.UA_CABINET_RUNTIME !== 'worker' || env.UA_CABINET_STAGING_ENABLED !== 'true')
    return deny('NOT_FOUND',404);
  const url = new URL(request.url);
  const staff = surface === 'staff', owner = surface === 'owner';
  const role = cabinetRole(url.pathname,request.method);
  const origin = owner ? env.UA_CABINET_OWNER_ORIGIN : staff ? env.UA_CABINET_TEACHER_ORIGIN : env.UA_API_ORIGIN;
  // The Owner cabinet has its own origin and entry point: staff (Ustoz) never carries it, owner carries nothing else.
  if ((!staff && !owner && surface !== 'student') || typeof origin !== 'string' || url.protocol !== 'https:' || url.origin !== origin ||
      !cabinetQueryAllowed(url,request.method) || url.hash || !role ||
      (owner ? role !== 'owner' : staff ? (role==='student' || role==='owner') : role!=='student') || !['GET','POST','OPTIONS'].includes(request.method))
    return deny('NOT_FOUND',404);
  try {
    const { cabinet } = await import('./cloudflare-cabinet-composition.mjs');
    return await cabinet.fetch(request,env);
  } catch { return deny('SERVICE_UNAVAILABLE',503); }
}

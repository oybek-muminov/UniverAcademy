import {createVercelNodeEntrypoint,publicEnvironmentOptions} from "../runtime/vercel-node.mjs";
import {teacherStagingPath} from "../runtime/teacher-staging-proxy.mjs";

// Registration keeps its existing entry; the new cabinet has a separate opt-in Node composition.
const registration=createVercelNodeEntrypoint(()=>({
  ...publicEnvironmentOptions(process.env),
  configuration:undefined,
}));
let stage;
export default {async fetch(request) {
  if (!teacherStagingPath(new URL(request.url).pathname)) return registration.fetch(request);
  if (process.env.UA_CABINET_STAGING_ENABLED!=='true')
    return Response.json({error:{code:'NOT_FOUND',message:'NOT_FOUND'}},{status:404,headers:{'cache-control':'no-store'}});
  const {createTeacherStageNode}=await import('../runtime/teacher-staging-node.mjs');
  stage??=createTeacherStageNode(()=>process.env);
  return stage.fetch(request);
}};

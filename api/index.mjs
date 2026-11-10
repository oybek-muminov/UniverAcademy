import {createVercelNodeEntrypoint,publicEnvironmentOptions} from "../runtime/vercel-node.mjs";

// Vercel Node Web Standard entry, not Edge and not a standalone listener.
// This local candidate has no approved production HttpConfiguration bootstrap.
// Public transport settings alone permit preflight, while API work stays503.
// Wire the reviewed real configuration into these options before any deployment;
// never import fixture/RAM state, guess a DB URL or reuse test policies here.
export default createVercelNodeEntrypoint(()=>({
  ...publicEnvironmentOptions(process.env),
  configuration:undefined,
}));

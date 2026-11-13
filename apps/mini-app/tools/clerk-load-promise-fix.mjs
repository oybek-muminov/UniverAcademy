import { createHash } from 'node:crypto';

// OBS-LOAD-1: @clerk/shared@4.44.1 detaches a rethrowing loadScript promise
// from its returned readiness poller. Join BOTH results; never suppress a
// browser-wide rejection or grant app access after a download error.
export const CLERK_LOADER_INPUT_SHA256 = '00e19858bb6e9d58214cfe4f0df618163bead0d1b0a7308212dd94c3d333a528';
export function patchClerkLoadPromises(source) {
  const sha = createHash('sha256').update(source).digest('hex');
  if (sha !== CLERK_LOADER_INPUT_SHA256) throw new Error('CLERK_LOADER_UPSTREAM_HASH_MISMATCH');
  const start = '\n\tloadScript(scriptUrl, {', end = '\n\treturn loadPromise;';
  if (source.split(start).length !== 3 || source.split(end).length !== 3)
    throw new Error('CLERK_LOADER_PATCH_PRECONDITION_FAILED');
  return source.replaceAll(start, '\n\tconst scriptPromise = loadScript(scriptUrl, {')
    .replaceAll(end, '\n\treturn Promise.all([loadPromise, scriptPromise]).then(() => null);');
}
export function clerkLoadPromiseFix() {
  return {
    name: 'clerk-observed-script-promises', enforce: 'pre',
    transform(source, id) {
      if (!id.replaceAll('\\', '/').split('?')[0].endsWith('/@clerk/shared/dist/loadClerkJsScript.mjs')) return;
      return { code: patchClerkLoadPromises(source), map: null };
    },
  };
}

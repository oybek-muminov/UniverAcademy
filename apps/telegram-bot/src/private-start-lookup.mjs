import { readPrivateStartContext } from './worker.mjs';

// Proposed private Service Binding contract ONLY; not a public HTTP endpoint.
// The Backend implementation and binding configuration are not available here.
// The separate returning-worker entry calls this after validated ingress.
const states = new Set(['linked', 'needs_clerk', 'disabled']);
class LookupUnavailable extends Error {
  constructor() { super('NAVIGATION_LOOKUP_UNAVAILABLE'); this.code = this.message; this.status = 503; }
}

export async function lookupPrivateStartNavigation(request, env, binding) {
  const context = await readPrivateStartContext(request, env);
  if (context === null) return null; // Unsupported authenticated update: no lookup/action.
  return lookupValidatedStart(context, binding);
}

// Internal composition only: this is not a public endpoint or authentication.
// returning-worker always obtains context from readPrivateStartContext first.
export async function lookupValidatedStart(context, binding) {
  let timer;
  try {
    if (!context || typeof context !== 'object' || Reflect.ownKeys(context).length !== 2
        || !Object.hasOwn(context, 'update_id') || !Object.hasOwn(context, 'telegram_user_id'))
      throw new LookupUnavailable();
    const update_id = context.update_id, telegram_user_id = context.telegram_user_id;
    if (!Number.isSafeInteger(update_id) || update_id < 0
        || !Number.isSafeInteger(telegram_user_id) || telegram_user_id <= 0)
      throw new LookupUnavailable();
    const lookup = binding?.lookupTelegramStart;
    if (typeof lookup !== 'function') throw new LookupUnavailable();
    const result = await Promise.race([
      // Exact proposed RPC input. Never send raw update, names, proof or secret.
      Promise.resolve().then(() => lookup.call(binding, { update_id, telegram_user_id })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new LookupUnavailable()), 5000); }),
    ]);
    if (!result || typeof result !== 'object' || Array.isArray(result)
        || Reflect.ownKeys(result).length !== 1 || !Object.hasOwn(result, 'status')) throw new LookupUnavailable();
    const status = result.status;
    if (!states.has(status)) throw new LookupUnavailable();
    return Object.freeze({ status }); // Never an authentication grant.
  } catch { throw new LookupUnavailable(); }
  // RPC timeout bounds this caller's wait, not the server's work. The proposed
  // lookup is read-only; a late result is ignored and never triggers a retry.
  finally { clearTimeout(timer); }
}

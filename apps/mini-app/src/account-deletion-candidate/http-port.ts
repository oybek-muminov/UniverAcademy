import {DefiniteDeletionRejection, DeletionStatusMissing} from './controller.ts';
import type {DeletionPort} from './controller.ts';

/** Configure only from trusted deployment configuration, never a query/return URL.
 * appBearer is captured for this controller's identity, not read from global state. */
export function createDeletionHttpPort(config: {
  apiOrigin: string;
  appBearer: string;
  fetch?: typeof fetch;
  timeoutMs?: number; // Whole request including body read; constrained to5–15 seconds.
}): DeletionPort {
  const origin = new URL(config.apiOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid API origin');
  if (!config.appBearer) throw new Error('Missing app bearer');
  const timeoutMs = config.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 15_000) throw new Error('Invalid deletion timeout');
  async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Deletion request deadline exceeded'));
        controller.abort();
      }, timeoutMs);
    });
    try { return await Promise.race([operation(controller.signal), timeout]); }
    finally { clearTimeout(timer); }
  }
  const request = config.fetch ?? globalThis.fetch;
  const base = origin.origin + '/api/v1/me/deletion';
  const defaults = {credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer'} as const;
  return {
    async submit({requestId, receipt, confirmation, clerkToken}) {
      return bounded(async signal => {
      const response = await request(base, {...defaults, signal, method:'POST', headers:{
        Authorization: 'Bearer ' + config.appBearer, 'x-clerk-token':clerkToken, 'Content-Type':'application/json', Accept:'application/json',
      }, body: JSON.stringify({requestId, receipt, confirmation})});
      // Backend guarantees these are authentication failures before accepting work.
      // Other statuses, malformed bodies and transport failures are ambiguous.
      if (response.status === 401 || response.status === 403) throw new DefiniteDeletionRejection(response.status);
      if (!response.ok) throw new Error('Deletion submission unconfirmed');
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || !('status' in body) || body.status !== 'pending') throw new Error('Deletion submission unconfirmed');
      return {status:'pending' as const};
      });
    },
    async status(receipt) {
      return bounded(async signal => {
      const response = await request(base + '/status', {...defaults, signal, method:'GET', headers:{'x-deletion-receipt':receipt, Accept:'application/json'}});
      if (response.status === 404) throw new DeletionStatusMissing();
      if (!response.ok) throw new Error('Deletion status unconfirmed');
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || !('status' in body) || (body.status !== 'pending' && body.status !== 'completed')) throw new Error('Deletion status unconfirmed');
      return {status:body.status};
      });
    },
  };
}

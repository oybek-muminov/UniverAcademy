import { createOwnerPort } from './owner-port.ts';
import type { OwnerPortOptions } from './owner-port.ts';
import { createProductionApiTransport } from './production-runtime.ts';
import type { ProductionConnectionFactory } from './production-runtime.ts';
import type { StudentSchema } from './owner-client/student-client.ts';
import { StudentFailure } from './transport.ts';

// UI affordance from server metadata only. The HTTP server still owns admission.
function offerStart(meta: StudentSchema['Meta']): boolean {
  if (meta.series.current_status === 'ready') {
    const recovery = meta.series.recovery;
    const now = Date.parse(meta.server_now);
    return meta.series.recovery_state === 'ready' && !!recovery && Number.isFinite(now)
      && now >= Date.parse(recovery.opens_at) && now < Date.parse(recovery.closes_at);
  }
  return meta.admission_status === 'open' && !meta.series.normal_attempt_used;
}

export const createProductionConnection: ProductionConnectionFactory = config =>
  createProductionOwnerConnection(config, fetch);

// Explicit transport seam for local synthetic tests; production main passes fetch.
// No URLs/proofs are read from window slots and no local client fallback exists.
export function createProductionOwnerConnection(config: Parameters<ProductionConnectionFactory>[0], fetcher: typeof fetch,
  auth: Pick<OwnerPortOptions, 'loginMethod' | 'loginSignal'> = {}) {
  if (config.mode !== 'production') throw new StudentFailure('protocol', 'PRODUCTION_CLIENT_MODE_REQUIRED');
  const apiOrigin = new URL(config.baseUrl).origin;
  const views = new Map<string, { title: string; groupLabel: string; startAllowed: boolean }>();
  return createOwnerPort({ ...config, ...auth,
    fetcher: createProductionApiTransport({ apiOrigin }, fetcher),
    view: (assignmentId, meta) => {
      if (meta) views.set(assignmentId, { title: meta.title, groupLabel: '', startAllowed: offerStart(meta) });
      // Meta exposes no group label. Never fabricate a group or start permission.
      return views.get(assignmentId) ?? { title: '', groupLabel: '', startAllowed: false };
    },
    assetUrl: value => {
      const url = new URL(value);
      // Additional media origins require an explicit reviewed policy/handoff.
      if (url.protocol !== 'https:' || url.origin !== apiOrigin || url.username || url.password)
        throw new StudentFailure('protocol', 'MEDIA_ORIGIN_NOT_CONFIGURED');
      return url.href;
    },
  });
}

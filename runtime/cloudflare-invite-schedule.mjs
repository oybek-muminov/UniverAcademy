import { dispatchStagingInvite } from '../apps/telegram-bot/src/staging-invite-dispatch.mjs';
import { createTelegramDelivery } from '../apps/telegram-bot/src/telegram-delivery.mjs';
import { createCloudflarePostgres } from './cloudflare-postgres.mjs';
import { isHyperdriveConnectionString } from './hyperdrive-connection-string.mjs';
import { createStagingInviteDeliveryStore } from './teacher-staging-delivery.mjs';

export function createInviteSchedule({ fetcher } = {}) {
  return async function scheduled(_event, env) {
    if (env?.UA_TELEGRAM_PILOT_DISPATCH_ENABLED !== 'true') return;

    const origin = env.UA_CABINET_STUDENT_ORIGIN;
    const allowed = JSON.parse(env.UA_ALLOWED_ORIGINS);
    const connectionString = env.TEACHER_PILOT_HYPERDRIVE?.connectionString;
    if (typeof origin !== 'string' || !Array.isArray(allowed) || !allowed.includes(origin) ||
        !isHyperdriveConnectionString(connectionString)) throw Error('INVITE_DISPATCH_CONFIG_INVALID');
    const deliver = createTelegramDelivery(env.UA_TELEGRAM_BOT_TOKEN, fetcher);
    const { Client } = await import('pg');
    const db = createCloudflarePostgres(Client, { connectionString }, { signal: AbortSignal.timeout(20000) });
    try {
      // The dispatcher validates the Mini destination before claiming one eligible row.
      await dispatchStagingInvite(createStagingInviteDeliveryStore({ pool: db.pool }), deliver,
        { cabinet: origin + '/', signIn: origin + '/sign-in' });
    } finally {
      await db.close();
    }
  };
}

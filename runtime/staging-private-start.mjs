import { createCloudflarePostgres } from './cloudflare-postgres.mjs';
import { isHyperdriveConnectionString } from './hyperdrive-connection-string.mjs';

export async function recordStagingPrivateStart(input, env) {
  if (env.UA_TELEGRAM_PILOT_DIRECTORY_ENABLED !== 'true' || !input ||
      Object.keys(input).join(',') !== 'telegramUserId' || !Number.isSafeInteger(input.telegramUserId) || input.telegramUserId <= 0)
    throw Error('SERVICE_UNAVAILABLE');
  const connectionString = env.TEACHER_PILOT_HYPERDRIVE?.connectionString;
  if (!isHyperdriveConnectionString(connectionString)) throw Error('SERVICE_UNAVAILABLE');
  const { Client } = await import('pg');
  const { createStagingInviteDeliveryStore } = await import('./teacher-staging-delivery.mjs');
  const db = createCloudflarePostgres(Client, {connectionString}, {signal:AbortSignal.timeout(5000)});
  try {
    await createStagingInviteDeliveryStore({pool:db.pool}).recordPrivateStart(input);
  } finally {
    await db.close();
  }
}

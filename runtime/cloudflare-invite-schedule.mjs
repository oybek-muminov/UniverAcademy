import { dispatchStagingInvite } from '../apps/telegram-bot/src/staging-invite-dispatch.mjs';
import { dispatchTeacherNotices } from '../apps/telegram-bot/src/teacher-notice.mjs';
import { createTelegramDelivery } from '../apps/telegram-bot/src/telegram-delivery.mjs';
import { createCloudflarePostgres } from './cloudflare-postgres.mjs';
import { isHyperdriveConnectionString } from './hyperdrive-connection-string.mjs';
import { createStagingInviteDeliveryStore } from './teacher-staging-delivery.mjs';

async function withDeliveryStore(env, fetcher, run) {
  const connectionString = env.TEACHER_PILOT_HYPERDRIVE?.connectionString;
  if (!isHyperdriveConnectionString(connectionString)) throw Error('INVITE_DISPATCH_CONFIG_INVALID');
  const deliver = createTelegramDelivery(env.UA_TELEGRAM_BOT_TOKEN, fetcher);
  const { Client } = await import('pg');
  const db = createCloudflarePostgres(Client, { connectionString }, { signal:AbortSignal.timeout(45_000) });
  try {
    return await run(createStagingInviteDeliveryStore({pool:db.pool}),deliver);
  } finally {
    await db.close();
  }
}

async function runInvites(env, fetcher) {
  const origin = env.UA_CABINET_STUDENT_ORIGIN;
  const allowed = JSON.parse(env.UA_ALLOWED_ORIGINS);
  if (typeof origin !== 'string' || !Array.isArray(allowed) || !allowed.includes(origin))
    throw Error('INVITE_DISPATCH_CONFIG_INVALID');
  return withDeliveryStore(env,fetcher,(store,deliver) =>
    dispatchStagingInvite(store,deliver,{cabinet:origin+'/',signIn:origin+'/sign-in'}));
}

export function createInviteSchedule({ fetcher } = {}) {
  return async function scheduled(_event, env) {
    const jobs = [];
    if (env?.UA_TELEGRAM_PILOT_DISPATCH_ENABLED === 'true') jobs.push(runInvites(env,fetcher));
    if (env && Object.hasOwn(env,'UA_TEACHER_NOTICES_ENABLED') && env.UA_TEACHER_NOTICES_ENABLED === 'true') {
      jobs.push(withDeliveryStore(env,fetcher,(store,deliver) => dispatchTeacherNotices(store.teacherNotifications,deliver)));
    }
    // A failure in the invite queue must not interrupt removal of a teacher's message.
    const results = await Promise.allSettled(jobs);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  };
}

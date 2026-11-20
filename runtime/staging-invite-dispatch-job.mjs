import {pathToFileURL} from 'node:url';
import {dispatchStagingInvite} from '../apps/telegram-bot/src/staging-invite-dispatch.mjs';
import {createTelegramDelivery} from '../apps/telegram-bot/src/telegram-delivery.mjs';

export async function dispatchOneStagingNotification(env) {
  if (env.TELEGRAM_TEACHER_PILOT_DELIVERY_ENABLED !== 'true') return 'disabled';
  if (!env.TEACHER_PILOT_DATABASE_URL) throw Error('STAGING_JOB_CONFIG_REQUIRED');
  const db = new URL(env.TEACHER_PILOT_DATABASE_URL);
  if (!['postgresql:', 'postgres:'].includes(db.protocol) || !db.hostname || !db.username ||
      !db.pathname.slice(1) || db.search || db.hash) throw Error('STAGING_JOB_CONFIG_INVALID');
  const deliver = createTelegramDelivery(env.TELEGRAM_BOT_TOKEN);
  const { Pool } = await import('pg');
  const {createStagingInviteDeliveryStore} = await import('./teacher-staging-delivery.mjs');
  const pool = new Pool({connectionString:db.href,ssl:{rejectUnauthorized:true},max:2,
    connectionTimeoutMillis:5000,statement_timeout:10000});
  try { return await dispatchStagingInvite(createStagingInviteDeliveryStore({pool}), deliver,
    {cabinet:env.MINI_CABINET_URL, signIn:env.MINI_SIGN_IN_URL}); }
  finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  dispatchOneStagingNotification(process.env).then(status => console.log(status), () => {
    console.error('STAGING_NOTIFICATION_JOB_FAILED'); process.exitCode = 1;
  });
}

import { readMiniDestinations } from './returning-worker.mjs';
import { isTeacherPilotInviteToken } from './teacher-pilot-invite.mjs';

// claimInviteDelivery marks the durable record before transport. A crashed or
// ambiguous send stays claimed for review. Only an explicit rate limit retries.
export async function dispatchStagingInvite(store, deliver, {cabinet, signIn}) {
  const mini = readMiniDestinations(cabinet, signIn).cabinet;
  const row = await store.claimInviteDelivery();
  if (!row) return 'empty';
  let outcome = {status: 'rejected'};
  if (Number.isSafeInteger(row.telegramUserId) && row.telegramUserId > 0 && isTeacherPilotInviteToken(row.token)) {
    try {
      const response = await deliver('sendMessage', {chat_id: row.telegramUserId,
        text: 'O‘qituvchingiz sizni UniverAcademy guruhiga taklif qildi.',
        reply_markup: {inline_keyboard: [[{text: 'Guruh taklifini ochish', web_app: {url: mini + '?invite=' + row.token}}]]},
      });
      if (response?.kind === 'ok' && response.result?.chat?.id === row.telegramUserId &&
        Number.isSafeInteger(response.result.message_id) && response.result.message_id > 0) outcome = {status: 'sent'};
      else if (response?.kind === 'retry' && Number.isSafeInteger(response.delay) && response.delay >= 1000)
        outcome = {status: 'retry', retryAfterMs: response.delay};
      else if (!['blocked', 'rejected'].includes(response?.kind)) outcome = {status: 'unconfirmed'};
    } catch {
      outcome = {status: 'unconfirmed'};
    }
  }
  await store.finishInviteDelivery(row.id, outcome);
  return outcome.status;
}

const maxPerMinute = 12;
// Opens the staff cabinet in the browser directly, not inside the Mini App.
const cabinetButton = { inline_keyboard: [[{ text: 'Ustoz kabinetini ochish', url: 'https://ustoz.univeracademy.uz/' }]] };
const retryDelay = result => result?.kind === 'retry' && Number.isSafeInteger(result.delay) && result.delay > 0
  ? result.delay : undefined;

export async function sendTeacherNotice(store, deliver) {
  const job = await store.claimSend();
  if (!job) return false;
  let reply;
  try {
    reply = await deliver('sendMessage', { chat_id:job.chatId, text:job.physics
      ? 'UniverAcademy’da sizga fizika o‘qituvchisi huquqi berildi.'
      : 'UniverAcademy’da sizga o‘qituvchi huquqi berildi.', reply_markup:cabinetButton });
  } catch { /* Telegram may have accepted the message; a blind retry can duplicate it. */ }
  const message = reply?.result;
  const delay = retryDelay(reply);
  let outcome = {status:'unconfirmed'};
  if (reply?.kind === 'ok' && message?.chat?.id === job.chatId && message.chat.type === 'private' &&
      Number.isSafeInteger(message.message_id) && message.message_id > 0) {
    outcome = {status:'sent',messageId:message.message_id,
      date:Number.isSafeInteger(message.date) && message.date > 0 ? message.date : null};
  } else if (delay) {
    outcome = {status:'retry',delay};
  } else if (reply?.kind === 'blocked' || (reply?.kind === 'rejected' && reply.chatUnavailable)) {
    outcome = {status:'blocked'};
  } else if (reply?.kind === 'rejected') {
    outcome = {status:'rejected'};
  }
  await store.finishSend(job.claim, outcome);
  return true;
}

export async function deleteTeacherNotice(store, deliver) {
  const job = await store.claimDelete();
  if (!job) return false;
  let reply;
  try {
    reply = await deliver('deleteMessage', {chat_id:job.chatId, message_id:job.messageId});
  } catch { /* Retrying the exact chat/message pair is idempotent. */ }
  const deleted = reply?.kind === 'missing' || (reply?.kind === 'ok' && reply.result === true);
  await store.finishDelete(job.claim, deleted ? {status:'deleted'}
    : {status:'delete_retry',delay:retryDelay(reply) ?? 300_000});
  return true;
}

export async function dispatchTeacherNotices(store, deliver) {
  const deadline = Date.now() + 15_000;
  let sends = true, deletions = true;
  for (let i = 0; i < maxPerMinute && Date.now() < deadline && (sends || deletions); i++) {
    if (deletions) deletions = await deleteTeacherNotice(store,deliver);
    if (sends) sends = await sendTeacherNotice(store,deliver);
  }
}

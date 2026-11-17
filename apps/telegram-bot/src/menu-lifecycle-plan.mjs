// Pure, NOT WIRED deployment candidate. Inputs must come from authenticated
// server state and stored bot send receipts, never from client-supplied IDs.
import { readMiniDestinations } from './returning-worker.mjs';
const positive = value => Number.isSafeInteger(value) && value > 0;
const cleanupEvents = new Set(['entry_opened', 'entry_expired', 'entry_superseded', 'entry_completed']);
export function planMenuLifecycle({ chatId, navigation, cabinetUrl, signInUrl, event, loginReceipt }) {
  if (!positive(chatId) || !['linked', 'needs_clerk', 'disabled'].includes(navigation))
    throw new Error('INVALID_MENU_STATE');
  if (!cleanupEvents.has(event) && event !== 'reconcile') throw new Error('INVALID_MENU_EVENT');
  // Explicit commands rather than default: a default WebApp must not leak into
  // an unregistered user's per-chat menu. Menu visibility is NOT authorization.
  const menu = navigation === 'linked'
    ? { type: 'web_app', text: 'Kabinet', web_app: { url: readMiniDestinations(cabinetUrl, signInUrl).cabinet } }
    : { type: 'commands' };
  const actions = [{ method: 'setChatMenuButton', chat_id: chatId, menu_button: menu }];
  if (cleanupEvents.has(event) && loginReceipt !== undefined) {
    if (loginReceipt.chatId !== chatId || !positive(loginReceipt.messageId))
      throw new Error('INVALID_LOGIN_RECEIPT');
    // Cleanup is independent of cabinet creation. Target the historical receipt,
    // not whichever message happens to be newest when a retry executes.
    actions.push({ method: 'deleteMessage', chat_id: chatId, message_id: loginReceipt.messageId });
  }
  return actions;
}

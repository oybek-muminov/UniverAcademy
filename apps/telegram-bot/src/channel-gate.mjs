import { readChannelGate, checkChannelMembership } from '../../../runtime/channel-membership.mjs';
import { staffCabinetNavigation } from './staff-cabinet-navigation.mjs';
import { CHANNEL_CHECK_DATA } from './worker.mjs';

// Faqat kabineti bor o'quvchiga chaqiriladi (yangi o'quvchiga hech qachon).
// Natija: null = kiritish, aks holda kanal ma'lumoti = to'xtatish.
// Telegram xatosi, sozlama yo'qligi yoki xodim bo'lsa — hamisha null.
export async function channelBlock(env, telegramUserId) {
  try {
    const gate = readChannelGate(env);
    if (!gate) return null;
    const status = await checkChannelMembership({ token: env.TELEGRAM_BOT_TOKEN, channel: gate.channel, userId: telegramUserId });
    if (status !== 'not_member') return null;
    if (await staffCabinetNavigation(env, telegramUserId)) return null;
    return gate;
  } catch { return null; }
}

export const CHANNEL_PROMPT_TEXT = 'Kabinetga kirish uchun avval rasmiy kanalimizga a‘zo bo‘ling, so‘ng “Tekshirish” tugmasini bosing.';
export const channelPromptMarkup = gate => ({ inline_keyboard: [
  [{ text: 'Kanalga o‘tish', url: gate.url }],
  [{ text: 'Tekshirish', callback_data: CHANNEL_CHECK_DATA }],
] });

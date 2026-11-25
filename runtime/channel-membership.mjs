// Rasmiy Telegram kanaliga a'zolikni tekshirish. Bot ham, API ham shu faylni ishlatadi.
// Qoida: faqat "aniq a'zo emas" javobi kirishni to'xtatadi. Telegram xatosi,
// sozlama yo'qligi yoki noaniq javob — hammasi "kiritish" tomonga ketadi.
const MEMBER = new Set(['creator', 'administrator', 'member']);
const NOT_MEMBER = new Set(['left', 'kicked']);
const CHANNEL = /^@[A-Za-z][A-Za-z0-9_]{4,31}$/;
const LINK = /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{4,31}$/;
const MAX_BYTES = 65_536;

function ownValue(env, key) {
  const d = env && typeof env === 'object' ? Object.getOwnPropertyDescriptor(env, key) : undefined;
  return d && Object.hasOwn(d, 'value') ? d.value : undefined;
}

// Sozlama: UA_CHANNEL_GATE_ENABLED='true', UA_REQUIRED_CHANNEL='@PhysicsHubUZ',
// UA_REQUIRED_CHANNEL_URL='https://t.me/PhysicsHubUZ'. Biri yo'q yoki xato bo'lsa — null (tekshiruv o'chiq).
export function readChannelGate(env) {
  if (ownValue(env, 'UA_CHANNEL_GATE_ENABLED') !== 'true') return null;
  const channel = ownValue(env, 'UA_REQUIRED_CHANNEL'), url = ownValue(env, 'UA_REQUIRED_CHANNEL_URL');
  if (typeof channel !== 'string' || !CHANNEL.test(channel)) return null;
  if (typeof url !== 'string' || !LINK.test(url)) return null;
  return Object.freeze({ channel, url });
}

// 'member' | 'not_member' | 'unknown'. Hech qachon xato tashlamaydi.
export async function checkChannelMembership({ token, channel, userId, fetcher = fetch, timeoutMs = 3000 }) {
  try {
    if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)
        || typeof channel !== 'string' || !CHANNEL.test(channel)
        || !Number.isSafeInteger(userId) || userId <= 0) return 'unknown';
    const response = await fetcher(`https://api.telegram.org/bot${token}/getChatMember`, {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: channel, user_id: userId }), signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (text.length > MAX_BYTES) return 'unknown';
    const value = JSON.parse(text);
    if (response.ok && value?.ok === true) {
      const result = value.result;
      if (MEMBER.has(result?.status)) return 'member';
      if (NOT_MEMBER.has(result?.status)) return 'not_member';
      if (result?.status === 'restricted' && typeof result.is_member === 'boolean')
        return result.is_member ? 'member' : 'not_member';
      return 'unknown';
    }
    // Telegram "bu odam topilmadi" desa — kanalda yo'q. Boshqa xatolar (bot admin emas,
    // kanal topilmadi, 429, 5xx) — noaniq, shuning uchun kiritiladi.
    if (value?.error_code === 400 && /user not found|participant_id_invalid/i.test(String(value.description ?? '')))
      return 'not_member';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

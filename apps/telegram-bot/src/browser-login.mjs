// New students sign in in the phone's normal browser (Google refuses Telegram's in-app browser) and come back
// to Telegram. Absent or malformed configuration keeps the existing in-Telegram sign-in button.
const INVITE = /^grp_[A-Za-z0-9_-]{1,60}$/;
export const BROWSER_LOGIN_TEXT = 'Kirish yoki ro‘yxatdan o‘tish uchun tugmani bosing. Brauzer ochiladi; kirgach Telegram’ga qaytasiz. Tugma yo‘qolsa, /start yuboring.';
export const BROWSER_INVITE_TEXT = 'Guruhga taklif keldi. Avval brauzerda kiring, so‘ng Telegram’ga qaytib taklifni tasdiqlaysiz.';
export const BROWSER_LOGIN_BUTTON = 'Brauzerda kirish / Ro‘yxatdan o‘tish';

export function browserLoginUrl(env, invite = null) {
  const value = env?.MINI_BROWSER_LINK_URL, signIn = env?.MINI_SIGN_IN_URL;
  if (typeof value !== 'string' || typeof signIn !== 'string' || value.length > 512) return null;
  let url, origin;
  try { url = new URL(value); origin = new URL(signIn).origin; } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || url.pathname !== '/telegram-link' || url.href !== value || url.origin !== origin
      || /[\s\\%]/.test(value) || url.hostname.endsWith('.accounts.dev')) return null;
  if (invite !== null) {
    if (typeof invite !== 'string' || invite.length > 64 || !INVITE.test(invite)) return null;
    url.searchParams.set('invite', invite);
  }
  return url.href;
}
export const browserLoginKeyboard = url => ({ inline_keyboard: [[{ text: BROWSER_LOGIN_BUTTON, url }]] });

// Quick registration (owner decision 2026-11-27): a new student gets ONE button that opens the Mini App
// cabinet inside Telegram; the Mini App asks only for first and last name. Bot flag, default off, so the
// previous button returns instantly by removing TELEGRAM_QUICK_REGISTER. /telegram-link stays in code.
export const QUICK_REGISTER_TEXT = 'Assalomu alaykum! UniverAcademy’ga xush kelibsiz. Kabinetingizni ochish uchun tugmani bosing.';
export const QUICK_REGISTER_BUTTON = 'Kabinetni ochish';
export const quickRegisterEnabled = env => !!env && Object.hasOwn(env, 'TELEGRAM_QUICK_REGISTER') && env.TELEGRAM_QUICK_REGISTER === 'true';
export const quickRegisterKeyboard = cabinetUrl => ({ inline_keyboard: [[{ text: QUICK_REGISTER_BUTTON, web_app: { url: cabinetUrl } }]] });

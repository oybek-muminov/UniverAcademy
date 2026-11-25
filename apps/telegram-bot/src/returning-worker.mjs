import { readPrivateStartContext, readAuthUrl } from './worker.mjs';
import { teacherPilotStartToken } from './teacher-pilot-invite.mjs';
import { lookupValidatedStart } from './private-start-lookup.mjs';
import { staffCabinetNavigation } from './staff-cabinet-navigation.mjs';
import { channelBlock, CHANNEL_PROMPT_TEXT, channelPromptMarkup } from './channel-gate.mjs';
import { browserLoginUrl, browserLoginKeyboard, BROWSER_INVITE_TEXT } from './browser-login.mjs';
import { createTelegramDelivery } from './telegram-delivery.mjs';
import { readChannelGate } from '../../../runtime/channel-membership.mjs';

// Lookup-first navigation only. Never authenticates, links accounts, mints a
// session or proves the selected frontend can open a cabinet. Deployment is
// blocked until the reviewed RPC, real Mini URLs and Mini proof flow exist.
const errors = Object.freeze({
  NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405, HTTPS_REQUIRED: 400,
  BOT_NOT_CONFIGURED: 503, UNAUTHORIZED: 401, UNSUPPORTED_CONTENT_TYPE: 415,
  BODY_TOO_LARGE: 413, MALFORMED_JSON: 400, INVALID_UPDATE: 422,
  NAVIGATION_LOOKUP_UNAVAILABLE: 503, DEPENDENCY_UNAVAILABLE: 503,
});
const GREETINGS = Object.freeze({
  linked: 'Assalomu alaykum! UniverAcademy kabinetiga kirish uchun quyidagi tugmani bosing.',
  needs_clerk: 'Assalomu alaykum! UniverAcademy’ga xush kelibsiz.\n\nHisobingiz bo‘lsa kiring, yangi foydalanuvchi bo‘lsangiz ro‘yxatdan o‘ting. Quyidagi tugma kirish oynasini ochadi.',
});
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...(status === 405 ? { Allow: 'POST' } : {}),
  } });
}
const ack = () => new Response(null, { headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
} });
function configFailure() {
  const error = new Error('BOT_NOT_CONFIGURED');
  error.code = error.message; error.status = 503; return error;
}
export function readMiniDestinations(cabinet, signIn) {
  const signInUrl = readAuthUrl(signIn), origin = new URL(signInUrl).origin;
  // Fixed same-origin routes already supported by the Mini. No query/hash,
  // identifiers, proof, redirects or URLs from the update/RPC are accepted.
  if (cabinet !== origin + '/' || new URL(signInUrl).hostname.endsWith('.accounts.dev'))
    throw configFailure();
  return Object.freeze({ cabinet, signIn: signInUrl });
}
function failure(error) {
  let code = 'DEPENDENCY_UNAVAILABLE';
  try {
    const candidate = error?.code, status = error?.status;
    if (typeof candidate === 'string' && Object.hasOwn(errors, candidate)
        && errors[candidate] === status) code = candidate;
  } catch { /* A thrown getter never becomes response text. */ }
  return json({ error: { code } }, errors[code]);
}

async function recordPilotPrivateStart(directory, telegramUserId) {
  if (typeof directory?.recordPilotPrivateStart !== 'function') throw configFailure();
  let timer;
  try {
    await Promise.race([
      directory.recordPilotPrivateStart({telegramUserId}),
      new Promise((_,reject) => { timer = setTimeout(() => reject(Error('DEPENDENCY_UNAVAILABLE')),5000); }),
    ]);
  } finally { clearTimeout(timer); }
}

// "Tekshirish" tugmasi. Bir javobda bitta usul qaytadi: a'zo emas -> ogohlantirish oynasi;
// a'zo (yoki Telegram xatosi) -> kabinet tugmasi. Yangi/yopilgan odamga hech narsa ochilmaydi.
async function handleChannelCheck(env, check) {
  const context = { update_id: check.update_id, telegram_user_id: check.telegram_user_id };
  const nav = await lookupValidatedStart(context, env.TELEGRAM_START_LOOKUP);
  if (nav.status === 'disabled') return json({ method: 'answerCallbackQuery', callback_query_id: check.callback_query_id });
  const urls = readMiniDestinations(env.MINI_CABINET_URL, env.MINI_SIGN_IN_URL);
  if (nav.status === 'needs_clerk') return json({ method: 'sendMessage', chat_id: check.telegram_user_id,
    text: GREETINGS.needs_clerk, reply_markup: { inline_keyboard: [[{ text: 'Kirish / Ro‘yxatdan o‘tish', web_app: { url: urls.signIn } }]] } });
  const staff = await staffCabinetNavigation(env, check.telegram_user_id);
  const gate = staff ? null : await channelBlock(env, check.telegram_user_id);
  if (gate) return json({ method: 'answerCallbackQuery', callback_query_id: check.callback_query_id, show_alert: true,
    text: 'Siz hali kanalga a‘zo emassiz. Avval “Kanalga o‘tish” tugmasini bosib a‘zo bo‘ling.' });
  try { // Yuklanish belgisini o'chirish; muvaffaqiyatsiz bo'lsa ham xabar yuboriladi.
    if (typeof env.TELEGRAM_BOT_TOKEN === 'string') await createTelegramDelivery(env.TELEGRAM_BOT_TOKEN)('answerCallbackQuery', { callback_query_id: check.callback_query_id });
  } catch { /* ixtiyoriy */ }
  return json({ method: 'sendMessage', chat_id: check.telegram_user_id,
    text: readChannelGate(env) ? 'Rahmat! Endi kabinetni ochishingiz mumkin.' : GREETINGS.linked,
    reply_markup: { inline_keyboard: [[{ text: staff ? 'Ustoz kabineti' : 'Kabinet',
      ...(staff ? { url: staff.browser } : { web_app: { url: urls.cabinet } }) }]] } });
}

export function createReturningBotWorker() {
  return { async fetch(request, env = {}) {
    try {
      let pilotEnabled = false, invite;
      let channelCheck = null;
      const context = await readPrivateStartContext(request, env, text => {
        pilotEnabled = Object.hasOwn(env,'TELEGRAM_TEACHER_PILOT_ENABLED') && env.TELEGRAM_TEACHER_PILOT_ENABLED === 'true';
        if (pilotEnabled) invite = teacherPilotStartToken(text);
      }, check => { channelCheck = check; });
      if (channelCheck) return await handleChannelCheck(env, channelCheck);
      if (context === null) return ack(); // Unsupported authenticated update.
      if (pilotEnabled) {
        await recordPilotPrivateStart(env.TELEGRAM_PILOT_DIRECTORY, context.telegram_user_id);
        if (invite) {
          const nav = await lookupValidatedStart(context, env.TELEGRAM_START_LOOKUP);
          if (nav.status === 'disabled') return ack();
          const urls = readMiniDestinations(env.MINI_CABINET_URL, env.MINI_SIGN_IN_URL);
          // A new student cannot confirm an invitation before signing in, and Google needs a normal browser.
          const browser = nav.status === 'needs_clerk' ? browserLoginUrl(env, invite) : null;
          if (browser) return json({ method: 'sendMessage', chat_id: context.telegram_user_id, text: BROWSER_INVITE_TEXT, reply_markup: browserLoginKeyboard(browser) });
          const url = new URL(urls.cabinet);
          url.searchParams.set('invite', invite);
          return json({ method: 'sendMessage', chat_id: context.telegram_user_id,
            text: 'Guruhga taklif keldi. Taklifni tasdiqlash uchun o‘quvchi kabinetini oching.',
            reply_markup: { inline_keyboard: [[{text: 'Taklifni ochish', web_app: {url: url.href}}]] },
          });
        }
      }
      // Opt-in only: a missing durable binding must fail closed, never silently
      // fall back to untracked sends after lifecycle activation.
      if (env.TELEGRAM_MESSAGE_LIFECYCLE_ENABLED === 'true') {
        if (!env.LOGIN_MESSAGE_LIFECYCLE?.getByName) throw configFailure();
        await env.LOGIN_MESSAGE_LIFECYCLE.getByName(String(context.telegram_user_id)).start(context);
        return ack();
      }
      // First application action after ingress validation. No static fallback,
      // public lookup URL, trusted header or raw update forwarding exists.
      const navigation = await lookupValidatedStart(context, env.TELEGRAM_START_LOOKUP);
      if (navigation.status === 'disabled') return ack(); // Denied: no message/button.
      const urls = readMiniDestinations(env.MINI_CABINET_URL, env.MINI_SIGN_IN_URL);
      const linked = navigation.status === 'linked';
      const staff = linked ? await staffCabinetNavigation(env, context.telegram_user_id) : null;
      const gate = linked && !staff ? await channelBlock(env, context.telegram_user_id) : null;
      if (gate) return json({ method: 'sendMessage', chat_id: context.telegram_user_id,
        text: CHANNEL_PROMPT_TEXT, reply_markup: channelPromptMarkup(gate) });
      const browser = navigation.status === 'needs_clerk' ? browserLoginUrl(env) : null;
      if (browser) return json({ method: 'sendMessage', chat_id: context.telegram_user_id,
        text: GREETINGS.needs_clerk, reply_markup: browserLoginKeyboard(browser) });
      return json({ method: 'sendMessage', chat_id: context.telegram_user_id,
        text: GREETINGS[navigation.status], reply_markup: { inline_keyboard: [[{
          text: linked ? 'Kabinet' : 'Kirish / Ro‘yxatdan o‘tish',
          ...(staff ? {url:staff.browser} : {web_app:{url:linked ? urls.cabinet : urls.signIn}}),
        }]] } });
    } catch (error) { return failure(error); }
  } };
}

// Repeated deliveries may repeat the navigation message. No storage, business
// mutations, outbound sendMessage or delivery/exactly-once claim.
export default createReturningBotWorker();

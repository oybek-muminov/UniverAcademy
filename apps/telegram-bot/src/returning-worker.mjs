import { readPrivateStartContext, readAuthUrl } from './worker.mjs';
import { lookupValidatedStart } from './private-start-lookup.mjs';

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

export function createReturningBotWorker() {
  return { async fetch(request, env = {}) {
    try {
      const context = await readPrivateStartContext(request, env);
      if (context === null) return ack(); // Unsupported authenticated update.
      // First application action after ingress validation. No static fallback,
      // public lookup URL, trusted header or raw update forwarding exists.
      const navigation = await lookupValidatedStart(context, env.TELEGRAM_START_LOOKUP);
      if (navigation.status === 'disabled') return ack(); // Denied: no message/button.
      const urls = readMiniDestinations(env.MINI_CABINET_URL, env.MINI_SIGN_IN_URL);
      const linked = navigation.status === 'linked';
      return json({ method: 'sendMessage', chat_id: context.telegram_user_id,
        text: GREETINGS[navigation.status], reply_markup: { inline_keyboard: [[{
          text: linked ? 'Kabinet' : 'Kirish / Ro‘yxatdan o‘tish',
          web_app: { url: linked ? urls.cabinet : urls.signIn },
        }]] } });
    } catch (error) { return failure(error); }
  } };
}

// Repeated deliveries may repeat the navigation message. No storage, business
// mutations, outbound sendMessage or delivery/exactly-once claim.
export default createReturningBotWorker();

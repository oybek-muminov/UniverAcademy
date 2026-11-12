// Stateless launcher; duplicate greetings permitted; delivery unconfirmed; no identity or business state changes.
// Telegram executes the webhook-reply method, if accepted. No delivery result is available.
// No token, outbound request, inbox, storage, account binding or application login.
const BOT = 'univeracademybot';
const PATH = '/telegram/webhook';
const MAX_BYTES = 65_536;
const TIMEOUT_MS = 5_000;
const encoder = new TextEncoder();
const GREETING = 'Assalomu alaykum! UniverAcademy’ga xush kelibsiz.\n\nHisobingiz bo‘lsa kiring, yangi foydalanuvchi bo‘lsangiz ro‘yxatdan o‘ting. Quyidagi tugma Clerk kirish oynasini ochadi.';

class Failure extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const own = (value, key) => Object.hasOwn(value, key);

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...(status === 405 ? { Allow: 'POST' } : {}),
  } });
}

// Use Web Crypto verification, not an early-exit comparison of secret strings.
async function authenticate(expected, received) {
  if (typeof expected !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(expected))
    throw new Failure(503, 'BOT_NOT_CONFIGURED');
  if (typeof received !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(received)) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(expected),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(received));
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(expected));
}

export function readAuthUrl(value) {
  if (typeof value !== 'string' || value.length > 2_048 || /[\s\\%]/.test(value))
    throw new Failure(503, 'BOT_NOT_CONFIGURED');
  let url;
  try { url = new URL(value); } catch { throw new Failure(503, 'BOT_NOT_CONFIGURED'); }
  const labels = url.hostname.split('.');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || url.pathname !== '/sign-in' || url.href !== value || labels.length < 2
      || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      || !/^[a-z]{2,63}$/.test(labels.at(-1))
      || /\.(?:localhost|local|internal|invalid|test|example)$/.test(url.hostname))
    throw new Failure(503, 'BOT_NOT_CONFIGURED');
  return value;
}

async function deadline(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Failure(503, 'DEPENDENCY_UNAVAILABLE')), TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

async function readJson(body) {
  if (!body) throw new Failure(400, 'MALFORMED_JSON');
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    // One deadline for the entire stream, not a fresh allowance per chunk.
    return await deadline((async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Failure(413, 'BODY_TOO_LARGE');
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw new Failure(400, 'MALFORMED_JSON'); }
    })());
  } finally {
    // Do not let an uncooperative stream cancel postpone the bounded response.
    void reader.cancel().catch(() => {});
  }
}

function validateUpdate(update) {
  if (!object(update) || !integer(update.update_id)) throw new Failure(422, 'INVALID_UPDATE');
  if (own(update, 'message')) {
    const m = update.message;
    if (!object(m) || !integer(m.message_id) || !object(m.chat)
        || !Number.isSafeInteger(m.chat.id) || typeof m.chat.type !== 'string'
        || (own(m, 'text') && typeof m.text !== 'string')
        || (own(m, 'from') && (!object(m.from) || !integer(m.from.id, 1)
          || (own(m.from, 'is_bot') && typeof m.from.is_bot !== 'boolean'))))
      throw new Failure(422, 'INVALID_UPDATE');
  }
}

function recipient(update) {
  const m = update.message;
  if (!m || m.chat.type !== 'private' || !integer(m.chat.id, 1)
      || !m.from || m.from.is_bot !== false || m.from.id !== m.chat.id) return null;
  const excluded = ['business_connection_id', 'guest_query_id', 'sender_chat', 'forward_origin',
    'forward_from', 'forward_from_chat', 'forward_sender_name', 'forward_date',
    'is_automatic_forward', 'via_bot', 'via_business_bot'];
  if (excluded.some(key => own(update, key) || own(m, key))) return null;
  if (typeof m.text !== 'string') return null;
  const command = m.text.split(' ')[0];
  if (command !== '/start' && !(command.startsWith('/start@') && command.slice(7).toLowerCase() === BOT)) return null;
  // Accept the usual bounded deep-link payload without reading or echoing it.
  const rest = m.text.slice(command.length);
  if (rest && !/^ [A-Za-z0-9_-]{1,64}$/.test(rest)) return null;
  return m.chat.id;
}

function sendBody(chatId, url) {
  return { method: 'sendMessage', chat_id: chatId, text: GREETING, reply_markup: { inline_keyboard: [[{
    text: 'Kirish / Ro‘yxatdan o‘tish', web_app: { url },
  }]] } };
}

// Internal composition seam: authenticates and validates the private-human start
// before returning its two numeric lookup fields. No public endpoint is added.
export async function readPrivateStartContext(request, env = {}) {
  const url = new URL(request.url);
  if (url.pathname !== PATH || url.search || url.hash) throw new Failure(404, 'NOT_FOUND');
  if (request.method !== 'POST') throw new Failure(405, 'METHOD_NOT_ALLOWED');
  if (url.protocol !== 'https:') throw new Failure(400, 'HTTPS_REQUIRED');
  if (!await authenticate(env.TELEGRAM_WEBHOOK_SECRET,
    request.headers.get('X-Telegram-Bot-Api-Secret-Token'))) throw new Failure(401, 'UNAUTHORIZED');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') || '')
      || !['', 'identity'].includes(request.headers.get('Content-Encoding') || ''))
    throw new Failure(415, 'UNSUPPORTED_CONTENT_TYPE');
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
    throw new Failure(413, 'BODY_TOO_LARGE');
  const update = await readJson(request.body);
  validateUpdate(update);
  const id = recipient(update);
  return id === null ? null : Object.freeze({ update_id: update.update_id, telegram_user_id: id });
}

export function createBotWorker() {
  return { async fetch(request, env = {}) {
    try {
      const context = await readPrivateStartContext(request, env);
      const chatId = context?.telegram_user_id ?? null;
      // Unsupported authenticated updates have an empty ACK and no action.
      if (chatId === null) return new Response(null, { headers: {
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      } });
      const authUrl = readAuthUrl(env.AUTH_SIGN_IN_URL);
      // Repeated update_id intentionally yields the same greeting. This launcher
      // has no identity/business effects and makes no exactly-once/delivery claim.
      return json(sendBody(chatId, authUrl));
    } catch (error) {
      // Static codes only; never reflect request content, credentials or thrown errors.
      return json({ error: { code: error instanceof Failure ? error.code : 'DEPENDENCY_UNAVAILABLE' } },
        error instanceof Failure ? error.status : 503);
    }
  } };
}

export default createBotWorker();

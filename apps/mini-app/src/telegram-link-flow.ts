// Browser-side half of "Log In With Telegram" (OpenID Connect, authorization code + PKCE S256).
// https://core.telegram.org/bots/telegram-login  Nothing here is a login or a credential: it only builds the
// Telegram confirmation request and reads back the one-time code. The server exchanges that code with the
// client secret and verifies Telegram's signed answer. The secret never reaches this bundle.
export const TELEGRAM_AUTH_URL = 'https://oauth.telegram.org/auth';
export const TELEGRAM_BOT_URL = 'https://t.me/univeracademybot';
const PENDING_KEY = 'ua.telegram-link.pending', INVITE_KEY = 'ua.telegram-link.invite';
export const PENDING_MAX_AGE_MS = 10 * 60 * 1000;
const INVITE = /^grp_[A-Za-z0-9_-]{1,60}$/;
export type TabStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function pkceChallenge(verifier: string, digest: (data: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>): Promise<string> {
  return base64Url(new Uint8Array(await digest(new TextEncoder().encode(verifier))));
}
export function readTelegramLoginConfig(env: Readonly<Record<string, unknown>>, appOrigin: string) {
  const clientId = env.VITE_TELEGRAM_LOGIN_CLIENT_ID;
  if (env.VITE_TELEGRAM_BROWSER_LINK_ENABLED !== 'true' || typeof clientId !== 'string' || !/^[0-9]{5,20}$/.test(clientId)) return null;
  return Object.freeze({ clientId, redirectUri: appOrigin + '/telegram-link' });
}
export type TelegramLoginConfig = NonNullable<ReturnType<typeof readTelegramLoginConfig>>;

export async function beginTelegramConfirmation(options: { config: TelegramLoginConfig; store: TabStore; now?: () => number;
  random?: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>; digest?: (data: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer> }): Promise<string> {
  const now = options.now ?? Date.now, random = options.random ?? (bytes => crypto.getRandomValues(bytes));
  const digest = options.digest ?? (data => crypto.subtle.digest('SHA-256', data));
  const state = base64Url(random(new Uint8Array(32))), verifier = base64Url(random(new Uint8Array(48)));
  options.store.setItem(PENDING_KEY, JSON.stringify({ state, verifier, at: now() }));
  const url = new URL(TELEGRAM_AUTH_URL);
  url.search = new URLSearchParams({ client_id: options.config.clientId, redirect_uri: options.config.redirectUri, response_type: 'code',
    scope: 'openid profile', state, code_challenge: await pkceChallenge(verifier, digest), code_challenge_method: 'S256' }).toString();
  return url.href;
}

export type TelegramCallback = { kind: 'none' } | { kind: 'denied' } | { kind: 'invalid' } | { kind: 'code'; code: string; verifier: string };
// A page without code/error is left alone. Any redirect back consumes the pending request first, so a code
// can never be read twice, replayed from history or combined with someone else's state.
export function readTelegramCallback(search: string, store: TabStore, now: () => number = Date.now): TelegramCallback {
  const query = new URLSearchParams(search), code = query.get('code'), error = query.get('error'), state = query.get('state');
  if (code === null && error === null) return { kind: 'none' };
  let pending: { state?: unknown; verifier?: unknown; at?: unknown } | null = null;
  try { pending = JSON.parse(store.getItem(PENDING_KEY) ?? 'null'); } catch { pending = null; }
  try { store.removeItem(PENDING_KEY); } catch { /* storage unavailable */ }
  if (!pending || typeof pending.state !== 'string' || typeof pending.verifier !== 'string' || typeof pending.at !== 'number'
      || !state || state.length !== pending.state.length || ![...state].every((c, i) => c === (pending!.state as string)[i])
      || now() - pending.at > PENDING_MAX_AGE_MS || now() < pending.at) return { kind: 'invalid' };
  if (error !== null || code === null) return { kind: 'denied' };
  if (!/^[\x21-\x7e]{8,2048}$/.test(code) || !/^[A-Za-z0-9\-._~]{43,128}$/.test(pending.verifier)) return { kind: 'invalid' };
  return { kind: 'code', code, verifier: pending.verifier };
}

// A group invitation survives the sign-in round trip in this tab only and is handed back to the bot at the end.
export function rememberInvite(search: string, store: TabStore): string | null {
  const value = new URLSearchParams(search).getAll('invite');
  try {
    if (value.length === 1 && INVITE.test(value[0]) && value[0].length <= 64) { store.setItem(INVITE_KEY, value[0]); return value[0]; }
    const stored = store.getItem(INVITE_KEY);
    return stored && INVITE.test(stored) && stored.length <= 64 ? stored : null;
  } catch { return null; }
}
export function forgetInvite(store: TabStore) { try { store.removeItem(INVITE_KEY); } catch { /* storage unavailable */ } }
export const telegramReturnUrl = (invite: string | null) => invite && INVITE.test(invite) && invite.length <= 64 ? TELEGRAM_BOT_URL + '?start=' + invite : TELEGRAM_BOT_URL;

import { StudentApiError, StudentClientProtocolError } from './owner-client/student-client.ts';

// Additive client for POST /api/v1/auth/telegram/browser-link (contracts/telegram-browser-link.review.openapi.json).
// Clerk proof in the Authorization header, the one-time Telegram code and PKCE verifier in the body. It keeps and
// retries nothing: an unconfirmed request is reported as unconfirmed and a fresh Telegram confirmation is required.
export const TELEGRAM_BROWSER_LINK_CONTRACT_SHA256 = '6b4268348f1b579eaf2f40efaab1e0829b0b8d0e6c2813cc9a1c1dc5053e3a7e';
export type TelegramBrowserLinkInput = { code: string; code_verifier: string; existing_only?: true };
function bad(code = 'CLIENT_INVALID_RESPONSE'): never { throw new StudentClientProtocolError(code); }
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function createTelegramBrowserLinkClient(options: { baseUrl: string; transport(request: Request): Promise<Response>; contractSha256: string; timeoutMs?: number }) {
  if (options?.contractSha256 !== TELEGRAM_BROWSER_LINK_CONTRACT_SHA256) bad('CONTRACT_HASH_MISMATCH');
  let base: URL; try { base = new URL(options.baseUrl); } catch { return bad('INVALID_PRODUCTION_BASE_URL'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname.replace(/\/$/, '') !== '/api/v1'
      || typeof options.transport !== 'function') bad('INVALID_PRODUCTION_BASE_URL');
  const endpoint = base.origin + '/api/v1/auth/telegram/browser-link', timeoutMs = options.timeoutMs ?? 15000;
  return Object.freeze({ async link(clerkJwt: string, input: TelegramBrowserLinkInput): Promise<{ ok: true }> {
    if (typeof clerkJwt !== 'string' || clerkJwt.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(clerkJwt)) bad('INVALID_CLERK_TOKEN');
    if (!plain(input) || Object.keys(input).length !== (input.existing_only === true ? 3 : 2) || ('existing_only' in input && input.existing_only !== true) || typeof input.code !== 'string' || !/^[\x21-\x7e]{8,2048}$/.test(input.code)
        || typeof input.code_verifier !== 'string' || !/^[A-Za-z0-9\-._~]{43,128}$/.test(input.code_verifier)) bad('INVALID_TELEGRAM_REQUEST');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await options.transport(new Request(endpoint, { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
        signal: controller.signal, headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + clerkJwt },
        body: JSON.stringify({ code: input.code, code_verifier: input.code_verifier, ...(input.existing_only ? { existing_only: true } : {}) }) }));
      if (!(response instanceof Response) || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) bad();
      const text = await response.text(); if (text.length > 65536) bad();
      let value: unknown; try { value = JSON.parse(text); } catch { return bad(); }
      if (!response.ok) {
        if (!plain(value) || !plain(value.error) || typeof value.error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.error.code)) bad();
        throw new StudentApiError(response.status, value.error.code, typeof value.error.request_id === 'string' ? value.error.request_id : '');
      }
      if (response.status !== 200 || !plain(value) || !plain(value.data) || Object.keys(value.data).length !== 1 || value.data.ok !== true) bad();
      return { ok: true };
    } catch (error) {
      if (error instanceof StudentApiError || error instanceof StudentClientProtocolError) throw error;
      return bad('CLIENT_REQUEST_UNCONFIRMED');
    } finally { clearTimeout(timer); }
  } });
}
export type TelegramBrowserLinkClient = ReturnType<typeof createTelegramBrowserLinkClient>;

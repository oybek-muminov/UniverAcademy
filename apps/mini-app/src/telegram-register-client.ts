import { StudentFailure } from './transport.ts';
import type { FailureKind } from './transport.ts';

// Additive client for POST /api/v1/auth/telegram/register (contracts/telegram-register.review.openapi.json).
// No Clerk token: the signed Telegram launch data is the only proof. Keeps and retries nothing.
export const TELEGRAM_REGISTER_CONTRACT_SHA256 = 'a2e7bd91160501a1b27134d9e659cae1fd6ce32c5d51d6893d9f72f05d9ddd67';
export type TelegramRegisterResult = { status: 'already_registered' } | { status: 'ticket'; ticket: string };
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const kinds: Record<number, FailureKind> = { 400: 'validation', 401: 'auth', 403: 'forbidden', 404: 'missing', 409: 'conflict', 422: 'validation', 429: 'limited' };

export function createTelegramRegisterClient(options: { baseUrl: string; transport(request: Request): Promise<Response>; timeoutMs?: number }) {
  let base: URL; try { base = new URL(options.baseUrl); } catch { throw new StudentFailure('protocol', 'INVALID_PRODUCTION_BASE_URL'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname.replace(/\/$/, '') !== '/api/v1'
      || typeof options.transport !== 'function') throw new StudentFailure('protocol', 'INVALID_PRODUCTION_BASE_URL');
  const endpoint = base.origin + '/api/v1/auth/telegram/register', timeoutMs = options.timeoutMs ?? 15000;
  return Object.freeze({ async register(input: { init_data: string; first_name: string; last_name: string }): Promise<TelegramRegisterResult> {
    if (!input.init_data || input.init_data.length > 16384) throw new StudentFailure('validation', 'INVALID_TELEGRAM_REQUEST');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await options.transport(new Request(endpoint, { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
          referrerPolicy: 'no-referrer', signal: controller.signal, headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ init_data: input.init_data, first_name: input.first_name, last_name: input.last_name }) }));
      } catch { throw new StudentFailure('temporary', 'CLIENT_REQUEST_UNCONFIRMED'); }
      if (!(response instanceof Response) || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
        throw new StudentFailure('protocol', 'CLIENT_INVALID_RESPONSE');
      const text = await response.text(); if (text.length > 16384) throw new StudentFailure('protocol', 'CLIENT_INVALID_RESPONSE');
      let value: unknown; try { value = JSON.parse(text); } catch { throw new StudentFailure('protocol', 'CLIENT_INVALID_RESPONSE'); }
      if (!response.ok) {
        const code = plain(value) && plain(value.error) && typeof value.error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.error.code)
          ? value.error.code : 'UNCONFIRMED';
        throw new StudentFailure(kinds[response.status] ?? 'temporary', code);
      }
      if (plain(value) && value.status === 'already_registered' && Object.keys(value).length === 1) return { status: 'already_registered' };
      if (plain(value) && value.status === 'ticket' && Object.keys(value).length === 2 && typeof value.ticket === 'string'
          && value.ticket.length > 0 && value.ticket.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(value.ticket)) return { status: 'ticket', ticket: value.ticket };
      throw new StudentFailure('protocol', 'CLIENT_INVALID_RESPONSE');
    } finally { clearTimeout(timer); }
  } });
}

// Telegram's unsigned display names are used ONLY to pre-fill the two input
// fields. They are never sent as identity; the server verifies the signed launch.
export function readTelegramNamePrefill(scope: unknown): { firstName: string; lastName: string } {
  const clean = (v: unknown) => typeof v === 'string'
    ? v.normalize('NFC').replace(/[^\p{L}\p{M} \-'‘’ʻʼ]/gu, '').trim().replace(/\s+/g, ' ').slice(0, 64) : '';
  try {
    const user = (scope as { Telegram?: { WebApp?: { initDataUnsafe?: { user?: { first_name?: unknown; last_name?: unknown } } } } })
      ?.Telegram?.WebApp?.initDataUnsafe?.user;
    return { firstName: clean(user?.first_name), lastName: clean(user?.last_name) };
  } catch { return { firstName: '', lastName: '' }; }
}

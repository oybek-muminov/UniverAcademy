import { useEffect, useRef, useState } from 'react';
import { useClerk, useSession } from '@clerk/react';
import { SignInCard } from './sign-in-card.tsx';
import { TelegramLinkView } from './telegram-link-view.tsx';
import type { LinkPhase } from './telegram-link-view.tsx';
import type { CommonEntryConfig } from './common-production-runtime.ts';
import { createProductionOwnerConnection } from './production-connection.ts';
import { createProductionApiTransport } from './production-runtime.ts';
import { createTelegramBrowserLinkClient, TELEGRAM_BROWSER_LINK_CONTRACT_SHA256 } from './telegram-browser-link-client.ts';
import { beginTelegramConfirmation, forgetInvite, readTelegramCallback, rememberInvite, telegramReturnUrl } from './telegram-link-flow.ts';
import type { TabStore } from './telegram-link-flow.ts';
import { StudentFailure } from './transport.ts';
import { StudentApiError } from './owner-client/student-client.ts';

// Marker so a sign-in round trip that lands on /sign-in or /auth/callback is sent back here.
export const BROWSER_LINK_MARKER = 'ua.telegram-link.active';
const MARKER_MAX_AGE_MS = 30 * 60 * 1000;
function tabStore(): TabStore {
  try { const probe = '__ua_probe'; sessionStorage.setItem(probe, '1'); sessionStorage.removeItem(probe); return sessionStorage; }
  catch { const memory = new Map<string, string>(); return { getItem: key => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); }, removeItem: key => { memory.delete(key); } }; }
}
export function browserLinkPending(store: Pick<Storage, 'getItem'> = sessionStorage, now = Date.now()): boolean {
  try { const at = Number(store.getItem(BROWSER_LINK_MARKER)); return Number.isFinite(at) && at > 0 && now >= at && now - at < MARKER_MAX_AGE_MS; } catch { return false; }
}
export function linkFailureMessage(error: unknown): string {
  const code = error instanceof StudentApiError || error instanceof StudentFailure ? error.code : '';
  const status = error instanceof StudentApiError ? error.status : 0;
  if (code === 'IDENTITY_LINK_CONFLICT') return 'Bu Telegram hisobi boshqa kabinetga bog‘langan yoki bu kabinet boshqa Telegram hisobiga bog‘langan. Administratorga murojaat qiling.';
  if (code === 'INIT_DATA_REPLAY') return 'Bu tasdiq allaqachon ishlatilgan. Telegram bilan qaytadan tasdiqlang.';
  if (code === 'INIT_DATA_INVALID' || code === 'INIT_DATA_EXPIRED') return 'Telegram tasdig‘i qabul qilinmadi yoki eskirdi. Qaytadan tasdiqlang.';
  if (code === 'FORBIDDEN') return 'Bu hisob o‘quvchi hisobi emas. Ustoz kabineti uchun botdagi tugmadan foydalaning.';
  if (status === 503 || code === 'SERVICE_UNAVAILABLE') return 'Xizmat vaqtincha ishlamayapti. Birozdan keyin qayta urinib ko‘ring.';
  return 'Tasdiqlash yakunlanmadi. Qaytadan urinib ko‘ring.';
}

export function TelegramLinkEntry({ config }: { config: CommonEntryConfig }) {
  const clerk = useClerk(), { session } = useSession();
  const [store] = useState(tabStore), [callback] = useState(() => readTelegramCallback(location.search, store));
  const [invite] = useState(() => rememberInvite(location.search, store));
  const [phase, setPhase] = useState<LinkPhase>(config.telegramBrowserLink ? 'signin' : 'disabled'), [message, setMessage] = useState('');
  const started = useRef(false), active = session?.status === 'active' && !session.currentTask;
  const login = config.telegramBrowserLink;
  useEffect(() => { if (callback.kind !== 'none') history.replaceState(null, '', location.pathname); }, [callback]);
  useEffect(() => { if (login) try { store.setItem(BROWSER_LINK_MARKER, String(Date.now())); } catch { /* storage unavailable */ } }, [login, store]);
  const finish = (next: LinkPhase, text = '') => {
    if (next === 'done' || next === 'failed') try { store.removeItem(BROWSER_LINK_MARKER); } catch { /* storage unavailable */ }
    setMessage(text); setPhase(next);
  };
  async function complete(code: string, verifier: string) {
    const current = clerk.session;
    if (!current || current.status !== 'active') return finish('failed', 'Kirish seansi topilmadi. Qaytadan kiring.');
    setPhase('working');
    const connection = createProductionOwnerConnection({ mode: 'production', baseUrl: config.apiBaseUrl, contractSha256: config.contractSha256 }, fetch, { loginMethod: 'clerk' });
    try {
      // The person row exists only after the normal Clerk exchange; the link then needs its own fresh proof.
      const exchange = await current.getToken({ skipCache: true });
      if (!exchange) throw new StudentFailure('auth', 'CLERK_TOKEN_INVALID');
      await connection.auth.login(exchange);
      const proof = await current.getToken({ skipCache: true });
      if (!proof || clerk.session?.id !== current.id) throw new StudentFailure('auth', 'ACCESS_SUPERSEDED');
      await createTelegramBrowserLinkClient({ baseUrl: config.apiBaseUrl, contractSha256: TELEGRAM_BROWSER_LINK_CONTRACT_SHA256,
        transport: createProductionApiTransport(config, fetch) }).link(proof, { code, code_verifier: verifier });
      finish('done');
    } catch (error) { finish('failed', linkFailureMessage(error)); }
    // The app session stays valid on the server so the Mini App can resume it; only this tab's copy is dropped.
    finally { connection.auth.clear(); }
  }
  useEffect(() => {
    if (!login || started.current) return;
    if (!active) { if (callback.kind === 'code') { started.current = true; finish('failed', 'Kirish seansi topilmadi. Qaytadan kiring.'); } else setPhase('signin'); return; }
    started.current = true;
    if (callback.kind === 'code') void complete(callback.code, callback.verifier);
    else if (callback.kind === 'denied') finish('failed', 'Telegram’da ruxsat berilmadi. Qaytadan urinib ko‘ring.');
    else if (callback.kind === 'invalid') finish('failed', 'Tasdiqlash so‘rovi eskirgan yoki boshqa oynadan keldi. Qaytadan boshlang.');
    else setPhase('ready');
  }, [active, login]); // eslint-disable-line react-hooks/exhaustive-deps
  const returnUrl = telegramReturnUrl(invite);
  useEffect(() => {
    if (phase !== 'done') return;
    forgetInvite(store);
    const timer = setTimeout(() => location.assign(returnUrl), 1500);
    return () => clearTimeout(timer);
  }, [phase, returnUrl, store]);
  async function confirm() {
    if (!login) return;
    setPhase('working');
    try { location.assign(await beginTelegramConfirmation({ config: login, store })); }
    catch { finish('failed', 'Telegram oynasini ochib bo‘lmadi. Qaytadan urinib ko‘ring.'); }
  }
  return <TelegramLinkView phase={phase} message={message} returnUrl={returnUrl}
    signIn={<SignInCard inTelegram={false} callbackUrl={config.appOrigin + '/telegram-link'} />}
    onConfirm={() => void confirm()} onRetry={() => { started.current = true; setPhase(active ? 'ready' : 'signin'); }}
    onSwitchAccount={() => { started.current = false; void clerk.signOut().then(() => setPhase('signin')); }} />;
}

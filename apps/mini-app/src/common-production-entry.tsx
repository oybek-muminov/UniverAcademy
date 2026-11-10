import { Component, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider, ClerkLoaded, ClerkLoading, ClerkFailed, HandleSSOCallback, useSession, useSignIn, useSignUp } from '@clerk/react';
import { PrebuiltReadyEntry } from './clerk-prebuilt-entry.tsx';
import { readCommonEntryConfig } from './common-production-runtime.ts';
import type { CommonEntryConfig } from './common-production-runtime.ts';
import { mountTelegramEntry } from './production-entry.tsx';
import { createProductionConnection } from './production-connection.ts';

function Status({ text }: { text: string }) {
  return <main className="shell"><section className="card"><h1>Kabinetga kirish</h1><p role="status">{text}</p></section></main>;
}
class EntryBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <Status text="Kirish xizmati tayyor bo‘lmadi. Sahifani qayta oching." /> : this.props.children; }
}

export function CallbackNotice({ config }: { config: CommonEntryConfig }) {
  const { session } = useSession();
  const [callbackSession, setCallbackSession] = useState<string | null>(null), [callbackNotice, setCallbackNotice] = useState('');
  const [settled, setSettled] = useState(false), cancelled = useRef(false);
  const cleanUrl = () => history.replaceState(null, '', config.callbackUrl);
  useEffect(() => {
    if (cancelled.current || !callbackSession || session?.id !== callbackSession) return;
    if (session.status !== 'active' || session.currentTask) {
      setSettled(true); setCallbackNotice('Qo‘shimcha tasdiqlash kerak.');
      history.replaceState(null, '', config.callbackUrl); return;
    }
    setSettled(true); setCallbackNotice('Google javobi qabul qilindi. Asosiy kirish oynasiga qayting.');
    // This document never opens an app session, even after an SDK callback.
    // Only the initiating main-window operation may exchange its proof. A
    // separate explicit sign-in remains available at the fixed sign-in URL.
    history.replaceState(null, '', config.callbackUrl);
  }, [callbackSession, session, config.callbackUrl]);
  return <main className="shell"><section className="card"><h1>Kabinetga kirish</h1>
    <p role="status">{callbackNotice || 'Google javobi tekshirilmoqda…'}</p>
    <a href={config.signInUrl}>Kirish oynasiga qaytish</a>
      {!settled && <button className="text-button" onClick={() => {
        cancelled.current = true; setSettled(true); setCallbackSession(null);
        setCallbackNotice('Kirish bekor qilindi. Yangidan kirishni boshlashingiz mumkin.'); cleanUrl();
      }}>Bekor qilish</button>}
    {!settled && <HandleSSOCallback navigateToApp={({ session }) => {
      if (cancelled.current) return;
      if (!session || session.currentTask) {
        setSettled(true); setCallbackNotice('Qo‘shimcha tasdiqlash kerak.'); cleanUrl(); return;
      }
      setCallbackSession(session.id);
    }} navigateToSignIn={() => { if (!cancelled.current) {
      setSettled(true); setCallbackNotice('Kirish uchun qo‘shimcha tasdiqlash kerak.'); cleanUrl();
    } }} navigateToSignUp={() => { if (!cancelled.current) {
      setSettled(true); setCallbackNotice('Ro‘yxatdan o‘tishni yakunlash uchun qo‘shimcha tasdiqlash kerak.'); cleanUrl();
    } }} />}
  </section></main>;
}
// Exported content lets a host use the real public ClerkProvider. Tests supply
// their synthetic SDK client only in a separate test entry, never production.
export function CommonClerkEntry({ config, scope }: { config: CommonEntryConfig; scope: unknown }) {
  const { signIn } = useSignIn(), { signUp } = useSignUp();
  if (!signIn || !signUp) return <Status text="Kirish oynasi tayyorlanmoqda…" />;
  if (location.pathname === '/auth/callback') return <CallbackNotice config={config} />;
  return <PrebuiltReadyEntry config={config} scope={scope} signIn={signIn} signUp={signUp} />;
}
export function mountCommonProductionEntry(element: HTMLElement, options: {
  env: Readonly<Record<string, unknown>>; pageOrigin: string; scope: unknown;
}) {
  if (location.pathname === '/telegram' && options.env.VITE_TELEGRAM_SDK_ENABLED === 'true')
    return mountTelegramEntry(element, { ...options, createConnection: createProductionConnection });
  // Configuration is checked before any SDK component or script is loaded.
  let config: CommonEntryConfig;
  try { config = readCommonEntryConfig(options.env, options.pageOrigin); }
  catch {
    const root = createRoot(element); root.render(<Status text="Kabinetga ulanish hali tayyor emas. Keyinroq qayta oching." />);
    return { unmount: () => root.unmount() };
  }
  const root = createRoot(element);
  if (!['/', '/sign-in', '/auth/callback'].includes(location.pathname)) {
    root.render(<Status text="Kirish sahifasini yangidan oching." />); return { unmount: () => root.unmount() };
  }
  // Empty socket until the real Clerk integration is explicitly enabled.
  // Even valid public settings alone do not start SDK downloads or an auth UI.
  if (options.env.VITE_CLERK_SDK_ENABLED !== 'true') {
    root.render(<Status text="Kabinetga ulanish hali tayyor emas. Keyinroq qayta oching." />);
    return { unmount: () => root.unmount() };
  }
  root.render(<EntryBoundary><ClerkProvider publishableKey={config.publishableKey} signInUrl={config.signInUrl}
    signUpUrl={config.signInUrl} signInForceRedirectUrl={config.signInUrl} signUpForceRedirectUrl={config.signInUrl}
    telemetry={{ disabled: true }}>
    <ClerkLoading><Status text="Kirish oynasi tayyorlanmoqda…" /></ClerkLoading>
    <ClerkFailed><Status text="Kirish xizmati javob bermadi. Keyinroq qayta urinib ko‘ring." /></ClerkFailed>
    <ClerkLoaded><CommonClerkEntry config={config} scope={options.scope} /></ClerkLoaded>
  </ClerkProvider></EntryBoundary>);
  return { unmount: () => root.unmount() };
}

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { SignIn, useClerk, useSession } from '@clerk/react';
import type { SignInFutureResource, SignUpFutureResource } from '@clerk/react/types';
import { createCommonProductionRuntime } from './common-production-runtime.ts';
import type { CommonEntryConfig } from './common-production-runtime.ts';
import { createPrebuiltSessionGate } from './clerk-prebuilt-session.ts';
import { readTelegramBridge } from './telegram-bootstrap.ts';
import { StudentApp } from './student-app.tsx';

// Clerk supplies the form/design. No appearance overrides, custom credential
// fields, synthetic provider, roles or identity-linking operation is installed.
export function PrebuiltReadyEntry({ config, scope, signIn, signUp }: {
  config: CommonEntryConfig; scope: unknown; signIn: SignInFutureResource; signUp: SignUpFutureResource;
}) {
  const clerk = useClerk(), { session } = useSession();
  const latest = useRef({ clerk, signIn, signUp }); latest.current = { clerk, signIn, signUp };
  const webview = !!readTelegramBridge(scope);
  const [runtime] = useState(() => createCommonProductionRuntime(config, {
    get signIn() { return latest.current.signIn; }, get signUp() { return latest.current.signUp; },
    session: () => latest.current.clerk.session ?? null,
    signOut: sessionId => latest.current.clerk.signOut({ sessionId }),
    openPopup: () => window.open('about:blank', '_blank', 'popup,width=480,height=700'), callbackUrl: config.callbackUrl,
  }, webview ? 'telegram_webview' : 'browser'));
  const [gate] = useState(() => createPrebuiltSessionGate(runtime, () => latest.current.clerk.session));
  const state = useSyncExternalStore(runtime.subscribe, runtime.snapshot);
  const [authBusy, setAuthBusy] = useState(false), operation = useRef(0);
  async function act(action: () => Promise<void> | void) {
    const current = ++operation.current; setAuthBusy(true);
    try { await action(); } catch { /* runtime already exposes the sanitized failure/receipt */ }
    finally { if (current === operation.current) setAuthBusy(false); }
  }
  useEffect(() => { const cleanup = gate.observe(); if (cleanup) void act(() => cleanup); }, [gate, session?.id, session?.status, session?.currentTask]);
  useEffect(() => () => gate.dispose(), [gate]);
  if (state.step === 'ready' && state.flow && gate.matches())
    return <StudentApp studentFlow={state.flow} mode="telegram" onEnter={() => act(() => gate.reset())}
      onLogout={() => act(() => gate.logout())} />;
  const canContinue = session?.status === 'active' && !session.currentTask;
  return <main className="shell">
    {state.notice && <p className="notice" role="alert">{state.notice}</p>}
    {state.busy || authBusy || (state.flow && !gate.matches()) ? <section className="card"><h1>Kabinetga kirish</h1><p role="status">Kabinetga kirish tekshirilmoqda…</p>
      <button className="text-button" onClick={() => void act(() => gate.reset())}>Bekor qilish</button></section>
      : canContinue ? <section className="card"><h1>Kabinetga kirish</h1>
        <button className="primary" onClick={() => void act(() => gate.enter())}>Tasdiqlangan hisob bilan davom etish</button></section>
      : webview ? <section className="card"><h1>Brauzerda davom etish kerak</h1>
        <p>Bu Telegram oynasida Google bilan kirish va tashqi brauzerdan qaytish hali ulanmagan.</p></section>
      : <SignIn routing="hash" withSignUp oauthFlow="popup" forceRedirectUrl={config.signInUrl}
        signUpForceRedirectUrl={config.signInUrl} fallback={<p role="status">Kirish oynasi tayyorlanmoqda…</p>} />}
    {config.telegramEnabled && <p><a href={webview ? '/telegram' : 'https://t.me/univeracademybot'}>Telegram orqali kirish — ixtiyoriy</a></p>}
  </main>;
}

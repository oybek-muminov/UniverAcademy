import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { SignIn, useClerk, useSession } from '@clerk/react';
import type { SignInFutureResource, SignUpFutureResource } from '@clerk/react/types';
import { createCommonProductionRuntime } from './common-production-runtime.ts';
import type { CommonEntryConfig } from './common-production-runtime.ts';
import { createPrebuiltSessionGate } from './clerk-prebuilt-session.ts';
import { hasTelegramLaunchContext, readTelegramBridge } from './telegram-bootstrap.ts';
import { StudentApp } from './student-app.tsx';
import { createTelegramReturnLaunch } from './telegram-return-launch.ts';

// Clerk supplies the form/design. No appearance overrides, custom credential
// fields, synthetic provider or roles are installed. Telegram links use only
// reviewed server operations; a widget/cookie/lookup never grants a cabinet.
export function PrebuiltReadyEntry({ config, scope, signIn, signUp }: {
  config: CommonEntryConfig; scope: unknown; signIn: SignInFutureResource; signUp: SignUpFutureResource;
}) {
  const clerk = useClerk(), { session } = useSession();
  const latest = useRef({ clerk, signIn, signUp, scope }); latest.current = { clerk, signIn, signUp, scope };
  const webview = hasTelegramLaunchContext(scope);
  const [launch] = useState(() => config.telegramEnabled && webview
    ? createTelegramReturnLaunch(() => readTelegramBridge(latest.current.scope)) : undefined);
  const [navigation] = useState(() => new AbortController());
  const [navigationClosed, setNavigationClosed] = useState(false);
  const lifecycle = useRef(0), automaticSessions = useRef(new Set<string>());
  const [runtime] = useState(() => createCommonProductionRuntime(config, {
    get signIn() { return latest.current.signIn; }, get signUp() { return latest.current.signUp; },
    session: () => latest.current.clerk.session ?? null,
    signOut: sessionId => latest.current.clerk.signOut({ sessionId }),
    openPopup: () => window.open('about:blank', '_blank', 'popup,width=480,height=700'), callbackUrl: config.callbackUrl,
  }, webview ? 'telegram_webview' : 'browser', (input, init) => fetch(input, {
    ...init, signal: init?.signal ? AbortSignal.any([init.signal, navigation.signal]) : navigation.signal,
  }), { launch }));
  const [gate] = useState(() => createPrebuiltSessionGate(runtime, () => latest.current.clerk.session));
  const state = useSyncExternalStore(runtime.subscribe, runtime.snapshot);
  const [authBusy, setAuthBusy] = useState(false), operation = useRef(0);
  const [resumePending, setResumePending] = useState(!!launch && location.pathname === '/');
  async function act(action: () => Promise<void> | void) {
    const current = ++operation.current; setAuthBusy(true);
    try { await action(); } catch { /* runtime already exposes the sanitized failure/receipt */ }
    finally { if (current === operation.current) setAuthBusy(false); }
  }
  useEffect(() => { const cleanup = gate.observe(); if (cleanup) void act(() => cleanup); }, [gate, session?.id, session?.status, session?.currentTask]);
  useEffect(() => {
    let mounted = true;
    if (launch && location.pathname === '/') void runtime.resumeSession()
      .finally(() => { if (mounted) setResumePending(false); }).catch(() => {});
    return () => { mounted = false; };
  }, [runtime, launch]);
  useEffect(() => {
    const generation = ++lifecycle.current;
    const dispose = () => { navigation.abort(); gate.dispose(); };
    const restored = () => { if (navigation.signal.aborted) setNavigationClosed(true); };
    window.addEventListener('pagehide', dispose);
    window.addEventListener('pageshow', restored);
    return () => {
      window.removeEventListener('pagehide', dispose);
      window.removeEventListener('pageshow', restored);
      // Effect replay in development is not a real navigation/unmount.
      queueMicrotask(() => { if (lifecycle.current === generation) dispose(); });
    };
  }, [gate, navigation]);
  useEffect(() => {
    if (resumePending || authBusy || state.busy || state.flow || state.step !== 'choose'
      || session?.status !== 'active' || session.currentTask || navigation.signal.aborted
      || runtime.telegramOutcome() === 'failed' || automaticSessions.current.has(session.id)) return;
    // Never automatically retry a failed exchange. An unlinked Telegram
    // resume is the sole expected handoff into Clerk linking.
    if (state.notice && runtime.telegramOutcome() !== 'needs_clerk') return;
    automaticSessions.current.add(session.id);
    void act(() => gate.enter());
  }, [session?.id, session?.status, session?.currentTask, resumePending, authBusy,
    state.busy, state.flow, state.step, state.notice, runtime, gate, navigation]);
  if (navigationClosed) return <main className="shell"><section className="card"><h1>Yangidan kirish kerak</h1>
    <p>Oldingi kirish amali takror yuborilmadi.</p>
    {webview ? <p>Mini Appni yoping va bot menyusidan yangidan oching.</p>
      : <button className="primary" onClick={() => window.location.reload()}>Sahifani yangidan ochish</button>}
  </section></main>;
  if (state.step === 'ready' && state.flow && (runtime.telegramOutcome() === 'resumed' || gate.matches()))
    return <StudentApp studentFlow={state.flow} mode="telegram" onEnter={() => act(() => gate.reset())}
      onLogout={() => act(() => gate.logout())} />;
  const canContinue = session?.status === 'active' && !session.currentTask;
  const blockedReturn = runtime.telegramOutcome() === 'failed';
  return <main className="shell">
    {state.notice && <p className="notice" role="alert">{state.notice}</p>}
    {state.busy || authBusy || resumePending || blockedReturn || (state.flow && !gate.matches()) ? <section className="card"><h1>Kabinetga kirish</h1>
      <p role="status">{blockedReturn ? state.notice || 'Kirishni yangidan tasdiqlang. Oldingi tasdiq takror yuborilmadi.' : 'Kabinetga kirish tekshirilmoqda…'}</p>
      <button className="text-button" onClick={() => void act(() => gate.reset())}>Bekor qilish</button></section>
      : canContinue ? <section className="card"><h1>Kabinetga kirish</h1>
        <button className="primary" onClick={() => void act(() => gate.enter())}>Tasdiqlangan hisob bilan davom etish</button></section>
      : webview && !launch ? <section className="card"><h1>Brauzerda davom etish kerak</h1>
        <p>Bu Telegram oynasida Google bilan kirish va tashqi brauzerdan qaytish hali ulanmagan.</p></section>
      : <SignIn routing="hash" withSignUp oauthFlow="popup" forceRedirectUrl={config.signInUrl}
        signUpForceRedirectUrl={config.signInUrl} fallback={<p role="status">Kirish oynasi tayyorlanmoqda…</p>} />}
    {config.telegramEnabled && <p><a href="https://t.me/univeracademybot">Telegram orqali kirish — ixtiyoriy</a></p>}
  </main>;
}

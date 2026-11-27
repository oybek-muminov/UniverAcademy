import {StaffBrowserChoices} from './staff-browser-entry.tsx';
import {AccountDeletionHost} from './account-deletion-candidate/host.tsx';
import { AtomicTelegramEntry } from './telegram-atomic-entry.tsx';
import { QuickTelegramEntry } from './telegram-quick-register-entry.tsx';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useClerk, useSession } from '@clerk/react';
import { SignInCard } from './sign-in-card.tsx';
import type { SignInFutureResource, SignUpFutureResource } from '@clerk/react/types';
import { createCommonProductionRuntime } from './common-production-runtime.ts';
import type { CommonEntryConfig } from './common-production-runtime.ts';
import { createPrebuiltSessionGate } from './clerk-prebuilt-session.ts';
import { hasTelegramLaunchContext, readTelegramBridge } from './telegram-bootstrap.ts';
import { StudentApp } from './student-app.tsx';
import { createTelegramReturnLaunch } from './telegram-return-launch.ts';
import { ChannelRequiredCard } from './channel-required.tsx';

// Clerk supplies the form/design. No appearance overrides, custom credential
// fields, synthetic provider or roles are installed. Telegram links use only
// reviewed server operations; a widget/cookie/lookup never grants a cabinet.
export function PrebuiltReadyEntry(props: {config:CommonEntryConfig;scope:unknown;signIn:SignInFutureResource;signUp:SignUpFutureResource}) {
  // New students register inside Telegram with just their name (default off).
  if(props.config.telegramQuickRegister && props.config.telegramEnabled && hasTelegramLaunchContext(props.scope))return <QuickTelegramEntry config={props.config} scope={props.scope}/>;
  if(props.config.telegramAtomicEnabled && hasTelegramLaunchContext(props.scope))return <AtomicTelegramEntry config={props.config} scope={props.scope}/>;
  return <LegacyPrebuiltReadyEntry {...props}/>;
}
function LegacyPrebuiltReadyEntry({ config, scope, signIn, signUp }: {
  config: CommonEntryConfig; scope: unknown; signIn: SignInFutureResource; signUp: SignUpFutureResource;
}) {
  const clerk = useClerk(), { session } = useSession();
  const latest = useRef({ clerk, signIn, signUp, scope }); latest.current = { clerk, signIn, signUp, scope };
  const webview = hasTelegramLaunchContext(scope);
  const [launch] = useState(() => config.telegramEnabled && webview
    ? createTelegramReturnLaunch(() => readTelegramBridge(latest.current.scope)) : undefined);
  const [runtime] = useState(() => createCommonProductionRuntime(config, {
    get signIn() { return latest.current.signIn; }, get signUp() { return latest.current.signUp; },
    session: () => latest.current.clerk.session ?? null,
    signOut: sessionId => latest.current.clerk.signOut({ sessionId }),
    openPopup: () => null, callbackUrl: config.callbackUrl,
  }, webview ? 'telegram_webview' : 'browser', fetch, { launch }));
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
  useEffect(() => () => gate.dispose(), [gate]);
  if (state.step === 'ready' && state.flow && (runtime.telegramOutcome() === 'resumed' || gate.matches()))
    return <AccountDeletionHost binding={runtime.deletionBinding()} enabled={config.deletionEnabled} cabinetDisplayId={state.flow?.snapshot().student?.displayId}>{actions=><StudentApp {...actions} stagingPilot={config.stagingPilotEnabled} studentFlow={state.flow!} mode="telegram" onEnter={() => act(() => gate.reset())}
      onLogout={() => act(() => gate.logout())} />}</AccountDeletionHost>;
  const canContinue = session?.status === 'active' && !session.currentTask;
  const blockedReturn = runtime.telegramOutcome() === 'failed';
  if (runtime.telegramOutcome() === 'channel_required') return <main className="shell"><ChannelRequiredCard /></main>;
  return <main className="shell">
    {state.notice && !blockedReturn && <p className="notice" role="alert">{state.notice}</p>}
    {state.busy || authBusy || resumePending || blockedReturn || (state.flow && !gate.matches()) ? <section className="card"><h1>Kabinetga kirish</h1>
      <p role="status">{blockedReturn ? state.notice || 'Kirishni yangidan tasdiqlang. Oldingi tasdiq takror yuborilmadi.' : 'Kabinetga kirish tekshirilmoqda…'}</p>
      <button className="text-button" onClick={() => void act(() => gate.reset())}>Bekor qilish</button></section>
      : canContinue ? <section className="card"><h1>Kabinetga kirish</h1>
        <button className="primary" onClick={() => void act(() => gate.enter())}>Tasdiqlangan hisob bilan davom etish</button></section>
      : webview && !launch ? <section className="card"><h1>Brauzerda davom etish kerak</h1>
        <p>Bu Telegram oynasida Google bilan kirish va tashqi brauzerdan qaytish hali ulanmagan.</p></section>
      : <SignInCard inTelegram={webview} callbackUrl={config.callbackUrl} />}
    {webview && !state.busy && !authBusy && !resumePending && <StaffBrowserChoices />}
  </main>;
}

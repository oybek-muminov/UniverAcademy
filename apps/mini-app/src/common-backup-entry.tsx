// Test/reserve entry only. Production main never imports this custom form.
import { useEffect, useRef, useState } from 'react';
import { useClerk, useSession, useSignIn, useSignUp } from '@clerk/react';
import type { SignInFutureResource, SignUpFutureResource } from '@clerk/react/types';
import { CommonSignInView } from './common-sign-in-view.tsx';
import { createCommonProductionRuntime } from './common-production-runtime.ts';
import type { CommonEntryConfig } from './common-production-runtime.ts';
import { readTelegramBridge } from './telegram-bootstrap.ts';
import { CallbackNotice } from './common-production-entry.tsx';

function BackupReadyEntry({ config, scope, signIn, signUp }: {
  config: CommonEntryConfig; scope: unknown; signIn: SignInFutureResource; signUp: SignUpFutureResource;
}) {
  const clerk = useClerk(), latest = useRef({ clerk, signIn, signUp });
  const { session } = useSession();
  latest.current = { clerk, signIn, signUp };
  const webview = !!readTelegramBridge(scope);
  const [runtime] = useState(() => createCommonProductionRuntime(config, {
    get signIn() { return latest.current.signIn; }, get signUp() { return latest.current.signUp; },
    session: () => latest.current.clerk.session ?? null,
    signOut: sessionId => latest.current.clerk.signOut({ sessionId }),
    openPopup: () => window.open('about:blank', '_blank', 'popup,width=480,height=700'), callbackUrl: config.callbackUrl,
  }, webview ? 'telegram_webview' : 'browser'));
  useEffect(() => () => runtime.dispose(), [runtime]);
  return <CommonSignInView runtime={runtime} canContinue={session?.status === 'active'}
    telegramUrl={config.telegramEnabled ? webview ? '/telegram' : 'https://t.me/univeracademybot' : undefined} />;
}

export function BackupCommonClerkEntry({ config, scope }: { config: CommonEntryConfig; scope: unknown }) {
  const { signIn } = useSignIn(), { signUp } = useSignUp();
  if (!signIn || !signUp) return <p role="status">Kirish oynasi tayyorlanmoqda…</p>;
  if (location.pathname === '/auth/callback') return <CallbackNotice config={config} />;
  return <BackupReadyEntry config={config} scope={scope} signIn={signIn} signUp={signUp} />;
}

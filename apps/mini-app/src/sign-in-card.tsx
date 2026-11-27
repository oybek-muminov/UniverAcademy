import { SignIn } from '@clerk/react';
import type { ComponentType } from 'react';

// Telegram's in-app browser is refused by Google ("403: disallowed_useragent"), so inside Telegram the
// Google button is hidden and the email-code form stays. Cosmetic only: no sign-in rule or proof changes.
export const telegramSignInAppearance = Object.freeze({
  elements: Object.freeze({
    socialButtonsRoot: Object.freeze({ display: 'none' }),
    socialButtons: Object.freeze({ display: 'none' }),
    dividerRow: Object.freeze({ display: 'none' }),
  }),
});
export const TELEGRAM_SIGN_IN_HINT = 'Telegram ichida Google bilan kirish ishlamaydi. Email manzilingizni kiriting: unga kod yuboramiz.';

type SignInProps = Record<string, unknown>;
export function SignInCard({ inTelegram, callbackUrl, existingOnly = false, Component = SignIn as ComponentType<SignInProps> }: {
  inTelegram: boolean; callbackUrl: string; existingOnly?: boolean; Component?: ComponentType<SignInProps>;
}) {
  return <>
    {inTelegram && <p className="notice" role="note">{TELEGRAM_SIGN_IN_HINT}</p>}
    <Component routing="hash" withSignUp={!existingOnly} oauthFlow="redirect" forceRedirectUrl={callbackUrl} signUpForceRedirectUrl={callbackUrl}
      fallback={<p role="status">Kirish oynasi tayyorlanmoqda…</p>}
      {...(inTelegram ? { appearance: telegramSignInAppearance } : {})} />
  </>;
}

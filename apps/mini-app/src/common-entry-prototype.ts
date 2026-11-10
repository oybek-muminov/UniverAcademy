import { createSignInController, EntryFailure } from './sign-in-controller.ts';
import type { SignInProvider, SignInEvidence, SignInSnapshot } from './sign-in-controller.ts';
export { EntryFailure as EntryDemoFailure };
export type EntryDemoProvider = SignInProvider;
export type EntryEvidence = SignInEvidence;
export type EntryDemoSnapshot = SignInSnapshot;

// DEV/test wrapper only. Production imports the generic controller directly.
export function createCommonEntryPrototype(options: Omit<Parameters<typeof createSignInController>[0], 'validateEmail' | 'invalidEmailMessage'> & { mode: 'synthetic' }) {
  if (options.mode !== 'synthetic') throw new EntryFailure('SYNTHETIC_MODE_REQUIRED');
  return createSignInController({ ...options,
    validateEmail: email => /^[a-z0-9._+-]+@example\.test$/.test(email),
    invalidEmailMessage: 'Namuna uchun faqat example.test emailidan foydalaning.',
  });
}

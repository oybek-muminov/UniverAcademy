import type { SignInFutureResource, SignUpFutureResource, SignedInSessionResource } from '@clerk/react/types';
import { EntryFailure } from './sign-in-controller.ts';
import type { SignInEvidence, SignInProvider } from './sign-in-controller.ts';

type Session = Pick<SignedInSessionResource, 'id' | 'status' | 'currentTask' | 'getToken'>;
export type ClerkSdkBindings = {
  signIn: Pick<SignInFutureResource, 'create' | 'emailCode' | 'status' | 'isTransferable' | 'createdSessionId' | 'finalize' | 'reset' | 'sso'>;
  signUp: Pick<SignUpFutureResource, 'create' | 'status' | 'createdSessionId' | 'finalize'>;
  session(): Session | null;
  signOut(sessionId: string): Promise<void>;
  openPopup(): Window | null;
  callbackUrl: string;
};
function code(error: unknown): string {
  if (error instanceof EntryFailure) return error.code;
  const value = error as { code?: string; errors?: { code?: string }[] } | null;
  return value?.errors?.[0]?.code ?? value?.code ?? 'PROVIDER_UNAVAILABLE';
}
function safeError(error: unknown): EntryFailure {
  if (error instanceof EntryFailure) return error;
  const key = code(error);
  return new EntryFailure(({ form_code_incorrect: 'INVALID_CODE', verification_expired: 'CODE_EXPIRED',
    form_code_expired: 'CODE_EXPIRED', too_many_requests: 'RATE_LIMITED', popup_closed: 'CANCELLED',
    user_cancelled: 'CANCELLED', oauth_access_denied: 'CANCELLED' } as Record<string, string>)[key] ?? 'PROVIDER_UNAVAILABLE');
}
function result(value: { error: unknown }) { if (value.error) throw value.error; }

// Public @clerk/react6 Future APIs only. No legacy/internal SDK API or raw error UI.
// SDK resource operations are single-flight; HTTP student operations stay independent.
export function createClerkSdkAdapter(sdk: ClerkSdkBindings): SignInProvider {
  let epoch = 0, pending: Promise<unknown> | null = null;
  let challenge: { id: string; epoch: number } | null = null;
  let popup: Window | null = null, ownedSessionId: string | null = null;
  let finalizingSessionId: string | null = null;
  function check(generation: number) { if (generation !== epoch) throw new EntryFailure('CANCELLED'); }
  async function evidence(session: Session | null, generation: number): Promise<SignInEvidence> {
    check(generation);
    if (!session || session.status !== 'active' || session.currentTask) throw new EntryFailure('VERIFICATION_REQUIRED');
    ownedSessionId = session.id;
    // A Backend exchange consumes its proof once. Ask Clerk for a fresh default
    // session JWT; never select a custom template or project JWT roles locally.
    const proof = await session.getToken({ skipCache: true }); check(generation);
    const current = sdk.session();
    if (current?.id !== session.id || current.status !== 'active' || current.currentTask || !proof) throw new EntryFailure('VERIFICATION_REQUIRED');
    return { proof };
  }
  function run<T>(work: (generation: number) => Promise<T>): Promise<T> {
    if (pending) return Promise.reject(new EntryFailure('AUTH_CLEANUP_PENDING'));
    const generation = ++epoch, original = sdk.session()?.id;
    finalizingSessionId = null;
    let task: Promise<T>;
    task = Promise.resolve().then(() => work(generation)).catch(async error => {
      if (generation !== epoch) {
        // No newer SDK operation can start until this cleanup settles. A late
        // finalize may have activated an SDK session: revoke only that captured
        // session, never global signOut or a newer operation's session.
        const late = sdk.session();
        if (late && (late.id === finalizingSessionId || (late.id === original && late.id === ownedSessionId))) {
          try { await sdk.signOut(late.id); } catch { /* Still no app proof is emitted. */ }
          if (ownedSessionId === late.id) ownedSessionId = null;
        }
        throw new EntryFailure('CANCELLED');
      }
      throw safeError(error);
    }).finally(() => { if (pending === task) pending = null; });
    pending = task; return task;
  }
  async function finalize(resource: ClerkSdkBindings['signIn'] | ClerkSdkBindings['signUp'], generation: number) {
    check(generation);
    if (resource.status !== 'complete' || !resource.createdSessionId) throw new EntryFailure('VERIFICATION_REQUIRED');
    const id = resource.createdSessionId; finalizingSessionId = id;
    result(await resource.finalize({ navigate: async ({ session }) => {
      check(generation); if (session?.currentTask) throw new EntryFailure('VERIFICATION_REQUIRED');
      // App routing waits for Backend authorization; no SDK-decorated/token URL.
    } }));
    check(generation);
    if (sdk.session()?.id !== id) throw new EntryFailure('VERIFICATION_REQUIRED');
    return evidence(sdk.session(), generation);
  }
  return {
    google() {
      // Popup must be opened inside the user gesture, before the first await.
      if (pending) return Promise.reject(new EntryFailure('AUTH_CLEANUP_PENDING'));
      popup = sdk.openPopup();
      if (!popup) return Promise.reject(new EntryFailure('POPUP_BLOCKED'));
      const target = popup;
      return run(async generation => {
        challenge = null; result(await sdk.signIn.reset()); check(generation);
        result(await sdk.signIn.sso({ strategy: 'oauth_google', popup: target,
          redirectCallbackUrl: sdk.callbackUrl, redirectUrl: sdk.callbackUrl })); check(generation);
        if (sdk.signIn.isTransferable) {
          result(await sdk.signUp.create({ transfer: true })); check(generation);
          return finalize(sdk.signUp, generation);
        }
        return finalize(sdk.signIn, generation);
      }).finally(() => { target.close(); if (popup === target) popup = null; });
    },
    sendCode(email) {
      return run(async generation => {
        challenge = null; result(await sdk.signIn.reset()); check(generation);
        result(await sdk.signIn.create({ identifier: email, signUpIfMissing: true })); check(generation);
        result(await sdk.signIn.emailCode.sendCode()); check(generation);
        challenge = { id: crypto.randomUUID(), epoch: generation }; return { challenge: challenge.id };
      });
    },
    verifyCode(id, value) {
      if (!challenge || challenge.id !== id || challenge.epoch !== epoch)
        return Promise.reject(new EntryFailure('CODE_EXPIRED'));
      return run(async generation => {
        // Keep the current challenge valid for retryable code errors.
        challenge!.epoch = generation;
        const reply = await sdk.signIn.emailCode.verifyCode({ code: value }); check(generation);
        if (reply.error && code(reply.error) === 'sign_up_if_missing_transfer') {
          result(await sdk.signUp.create({ transfer: true })); check(generation);
          return finalize(sdk.signUp, generation);
        }
        result(reply); return finalize(sdk.signIn, generation);
      });
    },
    current() { return run(generation => evidence(sdk.session(), generation)); },
    cancel() { epoch++; challenge = null; popup?.close(); popup = null; },
    signOut(appLogout) {
      const id = ownedSessionId, previous = pending;
      let task: Promise<void>;
      task = Promise.allSettled([previous, appLogout]).then(async () => {
        if (id && ownedSessionId === id) { await sdk.signOut(id); ownedSessionId = null; }
      }).catch(error => { throw safeError(error); }).finally(() => { if (pending === task) pending = null; });
      pending = task; return task;
    },
  };
}

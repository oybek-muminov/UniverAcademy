import { readProductionConfig } from './production-runtime.ts';
import { createProductionOwnerConnection } from './production-connection.ts';
import { createSignInController } from './sign-in-controller.ts';
import { createClerkAppSession } from './clerk-app-session.ts';
import { createClerkSdkAdapter } from './clerk-sdk-adapter.ts';
import type { ClerkSdkBindings } from './clerk-sdk-adapter.ts';
import { StudentFailure } from './transport.ts';
import { EntryFailure } from './sign-in-controller.ts';
import type { TelegramReturnLaunch } from './telegram-return-launch.ts';

export function readCommonEntryConfig(env: Readonly<Record<string, unknown>>, pageOrigin: string) {
  const config = readProductionConfig(env, pageOrigin);
  const key = env.VITE_CLERK_PUBLISHABLE_KEY, frontend = env.VITE_CLERK_FRONTEND_ORIGIN;
  if (typeof key !== 'string' || !/^pk_(?:test|live)_[A-Za-z0-9+/=]+$/.test(key)
      || typeof frontend !== 'string') throw new StudentFailure('protocol', 'CLERK_CONFIG_REQUIRED');
  if (/[\u0000-\u0020\\]/.test(frontend)) throw new StudentFailure('protocol', 'CLERK_CONFIG_INVALID');
  let url: URL, encodedHost: string;
  try { url = new URL(frontend); encodedHost = atob(key.replace(/^pk_(?:test|live)_/, '')); }
  catch { throw new StudentFailure('protocol', 'CLERK_CONFIG_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || encodedHost !== url.hostname + '$' || url.port)
    throw new StudentFailure('protocol', 'CLERK_CONFIG_INVALID');
  return Object.freeze({ ...config, publishableKey: key, clerkFrontendOrigin: url.origin,
    callbackUrl: config.appOrigin + '/auth/callback', signInUrl: config.appOrigin + '/sign-in',
    telegramEnabled: env.VITE_TELEGRAM_SDK_ENABLED === 'true' });
}
export type CommonEntryConfig = ReturnType<typeof readCommonEntryConfig>;

// Injectable SDK/HTTP seams for local tests. The real entry supplies public Clerk
// hooks and fetch; no window slot, synthetic provider or local-client fallback.
export function createCommonProductionRuntime(config: CommonEntryConfig, sdk: ClerkSdkBindings,
  context: 'browser' | 'telegram_webview', fetcher: typeof fetch = fetch,
  options: { launch?: TelegramReturnLaunch } = {}) {
  if (sdk.callbackUrl !== config.callbackUrl) throw new StudentFailure('protocol', 'CALLBACK_CONFIG_MISMATCH');
  const provider = createClerkSdkAdapter(sdk);
  const app = createClerkAppSession((signal, method = 'clerk') => createProductionOwnerConnection({ mode: 'production',
    baseUrl: config.apiBaseUrl, contractSha256: config.contractSha256 }, fetcher,
  { loginMethod: method, loginSignal: signal }));
  const launch = options.launch;
  const runtime = createSignInController({ context, provider, retire: app.retire,
    identityContext: () => { const session = sdk.session(); return session?.status === 'active' && !session.currentTask ? session.id : null; },
    beforeAuthorize: () => {
      try { launch?.beforeAuthorize(); } catch (error) { launch?.fail(); throw error; }
    },
    authorize: async evidence => {
      try {
        const authorization = await app.authorize(evidence, !!launch);
        return { ...authorization, assertCurrent() { authorization.assertCurrent(); launch?.assertCurrent(); } };
      }
      catch (error) { launch?.fail(); throw error; }
    },
    afterAuthorize: launch ? async (authorization, check) => {
      try {
        const raw = launch.beginLink(); check();
        // Ask SDK for another fresh default JWT; never forward stored exchange
        // evidence or substitute the project's opaque access bearer.
        const fresh = await provider.current!(); check(); launch.assertCurrent();
        await app.link(authorization, fresh.proof, raw); check(); launch.linked();
      } catch (error) { launch.fail(); throw error; }
    } : undefined,
    resume: launch ? async () => {
      try {
        const raw = launch.beginResume(), authorization = await app.resumeTelegram(raw);
        launch.resumed();
        return { ...authorization, assertCurrent() { authorization.assertCurrent(); launch.assertCurrent(); } };
      } catch (error) {
        if (error instanceof StudentFailure && ((error.kind === 'conflict' && error.code === 'TELEGRAM_LINK_REQUIRED')
            || (error.kind === 'auth' && error.code === 'CLERK_SESSION_REVOKED'))) {
          try { launch.requireClerk(); } catch (changed) { launch.fail(); throw changed; }
          throw new EntryFailure(error.code);
        }
        launch.fail(); throw error;
      }
    } : undefined,
  });
  return { ...runtime, telegramOutcome: () => launch?.phase() ?? null,
    reset() { launch?.fail(); return runtime.reset(); },
    logout() { launch?.fail(); return runtime.logout(); },
    dispose() { launch?.dispose(); runtime.dispose(); },
  };
}

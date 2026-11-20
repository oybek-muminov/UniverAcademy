export type TelegramBridge = { readonly initData?: string; readonly platform?: string; ready?(): void; openLink?(url: string): void };

// SDK identity/roles/initDataUnsafe are deliberately never inspected or trusted.
// The official SDK must already be provided by an approved host integration.
export function readTelegramBridge(scope: unknown): TelegramBridge | undefined {
  if (!scope || typeof scope !== 'object') return;
  const telegram = (scope as { Telegram?: unknown }).Telegram;
  if (!telegram || typeof telegram !== 'object') return;
  const bridge = (telegram as { WebApp?: unknown }).WebApp;
  return bridge && typeof bridge === 'object' ? bridge as TelegramBridge : undefined;
}

// Loading the official SDK also creates WebApp in an ordinary browser. Only its
// exact empty/unknown default is non-Telegram here; any other present bridge
// retains the return flow's missing/invalid-proof rejection. This selects UI
// context only. Backend alone verifies initData and grants Telegram identity.
export function hasTelegramLaunchContext(scope: unknown): boolean {
  const bridge = readTelegramBridge(scope);
  return !!bridge && !(bridge.platform === 'unknown' && bridge.initData === '');
}

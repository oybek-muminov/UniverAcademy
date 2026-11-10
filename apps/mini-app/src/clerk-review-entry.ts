import { createCommonEntryPrototype, EntryDemoFailure } from './common-entry-prototype.ts';
import type { EntryDemoProvider } from './common-entry-prototype.ts';
import { createOwnerPort } from './owner-port.ts';
import type { OwnerPortOptions } from './owner-port.ts';
import { createClerkAppSession } from './clerk-app-session.ts';

// Explicit local review wrapper. Production uses the shared app session directly.
export function createClerkReviewEntry(options: Omit<OwnerPortOptions, 'mode' | 'loginMethod' | 'loginSignal'> & {
  mode: 'local_fixture'; provider: EntryDemoProvider; context?: 'browser' | 'telegram_webview';
}) {
  if (options.mode !== 'local_fixture') throw new EntryDemoFailure('LOCAL_REVIEW_REQUIRED');
  const { provider, context, ...config } = options;
  const session = createClerkAppSession(signal => createOwnerPort({ ...config, loginMethod: 'clerk', loginSignal: signal }));
  return createCommonEntryPrototype({ mode: 'synthetic', context: context ?? 'browser', provider, ...session });
}

import { EntryFailure } from './sign-in-controller.ts';
import type { TelegramBridge } from './telegram-bootstrap.ts';

// Document-only control state, never server proof validation or replay storage.
// Signature, freshness/skew, bot identity, linking and atomic consumption belong
// to Backend. Keep the exact SDK string in RAM; never inspect initDataUnsafe.
export function createTelegramReturnLaunch(readBridge: () => TelegramBridge | undefined) {
  let captured: { bridge: TelegramBridge; raw: string } | null = null;
  let phase: 'new' | 'resuming' | 'needs_clerk' | 'linking' | 'linked' | 'resumed' | 'failed' = 'new';
  let disposed = false;
  function read() {
    if (disposed) throw new EntryFailure('FRESH_LAUNCH_REQUIRED');
    const bridge = readBridge(), raw = bridge?.initData;
    if (!bridge || typeof raw !== 'string' || !raw.trim()) throw new EntryFailure('FRESH_LAUNCH_REQUIRED');
    if (captured && (captured.bridge !== bridge || captured.raw !== raw)) throw new EntryFailure('FRESH_LAUNCH_REQUIRED');
    captured ??= { bridge, raw };
    return raw;
  }
  function beforeAuthorize() {
    read();
    if (!['new', 'needs_clerk'].includes(phase)) throw new EntryFailure('FRESH_LAUNCH_REQUIRED');
  }
  return {
    phase: () => phase,
    assertCurrent() { read(); },
    beforeAuthorize,
    beginLink() { beforeAuthorize(); const raw = read(); phase = 'linking'; return raw; },
    linked() { read(); phase = 'linked'; },
    beginResume() {
      const raw = read();
      if (phase !== 'new') throw new EntryFailure('FRESH_LAUNCH_REQUIRED');
      phase = 'resuming'; return raw;
    },
    resumed() { read(); phase = 'resumed'; },
    requireClerk() { read(); phase = 'needs_clerk'; },
    fail() { phase = 'failed'; },
    dispose() { disposed = true; captured = null; phase = 'failed'; },
  };
}
export type TelegramReturnLaunch = ReturnType<typeof createTelegramReturnLaunch>;

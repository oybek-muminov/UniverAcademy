import type { createSignInController } from './sign-in-controller.ts';

type Runtime = ReturnType<typeof createSignInController>;
type Session = { id: string; status: string; currentTask?: unknown } | null | undefined;

// A widget/cookie/callback session alone never grants application access. This
// gate binds the explicit existing Continue action to one SDK session context.
export function createPrebuiltSessionGate(runtime: Runtime, session: () => Session) {
  let expected: string | null = null;
  function active() { const value = session(); return value?.status === 'active' && !value.currentTask ? value : null; }
  function matches() { return expected !== null && active()?.id === expected; }
  function reset() { expected = null; return runtime.reset(); }
  return {
    matches,
    async enter() {
      // An SDK update may precede React's observer effect. Never relabel an old
      // ready/pending app flow as the new SDK context in that interval.
      if ((expected || runtime.snapshot().flow) && !matches()) await reset();
      const current = active(); if (!current) return;
      expected = current.id; await runtime.continueSession();
    },
    observe() { return expected && !matches() ? reset() : null; },
    reset,
    // Clear the observer expectation before our own signOut, so its session
    // update cannot supersede the captured app logout receipt/ACK.
    logout() { expected = null; return runtime.logout(); },
    dispose() { expected = null; runtime.dispose(); },
  };
}

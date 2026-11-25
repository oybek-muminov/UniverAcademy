// Pure decisions for the group-test screen. Kept free of React so they can be tested exactly.

// Failures after which the server state is unchanged or can be settled by a retry
// (an answer carries its revision, a submit keeps its key). Answering stays possible.
const TRANSIENT = new Set(['temporary', 'offline', 'limited']);
// The access scope itself was lost: protected content is hidden and the real state is read again.
const SCOPE_LOST = new Set(['forbidden', 'missing']);

export function isTransient(kind) { return TRANSIENT.has(kind); }

// What the screen does after a failed command. 'auth' is handled separately by the caller.
export function failureOutcome(kind, onAttempt) {
  if (SCOPE_LOST.has(kind)) return { scopeLost: true, lockAnswers: false, resync: false };
  if (!onAttempt) return { scopeLost: false, lockAnswers: false, resync: false };
  return { scopeLost: false, lockAnswers: !TRANSIENT.has(kind), resync: true };
}

// Remaining whole seconds. Uses the server clock at receipt plus local monotonic time, never the phone's wall clock.
export function remainingSeconds({ deadlineAt, serverNow, receivedAt, now }) {
  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline) || !Number.isFinite(serverNow) || !Number.isFinite(receivedAt) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.ceil((deadline - serverNow - Math.max(0, now - receivedAt)) / 1000));
}

// Delay before the next automatic re-read; null once the automatic attempts are used up.
export const MAX_RESYNC_ATTEMPTS = 5;
export function resyncDelay(attempts) {
  if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts >= MAX_RESYNC_ATTEMPTS) return null;
  return attempts === 0 ? 1500 : 4000;
}

export function clockText(total) {
  const seconds = Math.max(0, Math.floor(total));
  return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
}

export function isTransient(kind: string): boolean;
export function failureOutcome(kind: string, onAttempt: boolean): { scopeLost: boolean; lockAnswers: boolean; resync: boolean };
export function remainingSeconds(input: { deadlineAt: string; serverNow: number; receivedAt: number; now: number }): number | null;
export const MAX_RESYNC_ATTEMPTS: number;
export function resyncDelay(attempts: number): number | null;
export function clockText(total: number): string;

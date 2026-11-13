import { EntryFailure } from './sign-in-controller.ts';
import type { SignInEvidence } from './sign-in-controller.ts';
import type { createOwnerPort } from './owner-port.ts';
type StudentConnection = ReturnType<typeof createOwnerPort>;

// One pinned owner client per explicit app login. No SDK, fixture or route here.
export function createClerkAppSession(createConnection: (signal: AbortSignal, method?: 'clerk' | 'telegram_resume') => StudentConnection) {
  type Active = { connection: StudentConnection; abort: AbortController };
  let active: Active | null = null, epoch = 0;
  const attempted = new Set<string>(); // Document-only digests, never raw JWTs.
  function retire(): Promise<'confirmed' | 'unconfirmed' | 'none'> {
    epoch++; const old = active; active = null;
    if (!old) return Promise.resolve('none');
    if (!old.connection.auth.person()) {
      old.connection.auth.clear(); old.abort.abort();
      return Promise.resolve('unconfirmed'); // Exchange may have committed remotely.
    }
    // Capture the old refresh proof before abort/clear. Body-only owner logout;
    // a late ACK belongs solely to that retired connection and controller epoch.
    const sent = new Promise<void>(resolve => resolve(old.connection.auth.logout()));
    old.abort.abort(); return sent.then(() => 'confirmed' as const);
  }
  async function open(raw: string, method: 'clerk' | 'telegram_resume', requireReturn = false) {
      const generation = ++epoch;
      const abort = new AbortController();
      const connection = createConnection(abort.signal, method);
      const target = { connection, abort }; active = target;
      const check = () => {
        if (generation !== epoch || active !== target) throw new EntryFailure('SUPERSEDED');
      };
      if (requireReturn) { await connection.auth.requireTelegramReturn(); check(); }
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([method, raw]))); check();
      const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      if (attempted.has(fingerprint)) throw new EntryFailure('FRESH_PROOF_REQUIRED');
      attempted.add(fingerprint); // Before any ambiguous exchange; never auto-replay.
      const person = await connection.auth.login(raw); check();
      if (person !== connection.auth.person()) throw new EntryFailure('PROFILE_MISMATCH');
      return { person, port: connection.port, assertCurrent() {
        check(); if (connection.auth.person() !== person) throw new EntryFailure('PROFILE_MISMATCH');
      } };
  }
  return { retire,
    authorize: (evidence: SignInEvidence, requireReturn = false) => open(evidence.proof, 'clerk', requireReturn),
    resumeTelegram: (raw: string) => open(raw, 'telegram_resume', true),
    async link(authorization: { person: string; port: StudentConnection['port'] }, clerkProof: string, raw: string) {
      const target = active, generation = epoch;
      const check = () => {
        if (!target || target !== active || epoch !== generation || target.connection.port !== authorization.port
            || target.connection.auth.person() !== authorization.person) throw new EntryFailure('PROFILE_MISMATCH');
      };
      check();
      await target!.connection.auth.linkTelegramIdentity(clerkProof, raw, authorization.person); check();
    },
  };
}

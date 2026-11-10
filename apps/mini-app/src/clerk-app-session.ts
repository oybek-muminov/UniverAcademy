import { EntryFailure } from './sign-in-controller.ts';
import type { SignInEvidence } from './sign-in-controller.ts';
import type { createOwnerPort } from './owner-port.ts';
type StudentConnection = ReturnType<typeof createOwnerPort>;

// One pinned owner client per explicit app login. No SDK, fixture or route here.
export function createClerkAppSession(createConnection: (signal: AbortSignal) => StudentConnection) {
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
  return { retire,
    async authorize(evidence: SignInEvidence) {
      const generation = ++epoch;
      const abort = new AbortController();
      const connection = createConnection(abort.signal);
      const target = { connection, abort }; active = target;
      const check = () => {
        if (generation !== epoch || active !== target) throw new EntryFailure('SUPERSEDED');
      };
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(evidence.proof)); check();
      const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      if (attempted.has(fingerprint)) throw new EntryFailure('FRESH_PROOF_REQUIRED');
      attempted.add(fingerprint); // Before any ambiguous exchange; never auto-replay.
      const person = await connection.auth.login(evidence.proof); check();
      if (person !== connection.auth.person()) throw new EntryFailure('PROFILE_MISMATCH');
      return { person, port: connection.port };
    },
  };
}

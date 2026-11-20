/** Internal presentation DTO, NOT an accepted API schema. Map only verified server responses. */
export interface TeacherCabinetPort {
  load(options: { signal: AbortSignal }): Promise<
    { kind: 'signed-out' | 'forbidden' | 'unconfigured' } |
    { kind: 'ready'; personId: string; name: string;
      access: { teacher: boolean; approved: boolean; enabled: boolean };
      subjects: string[];
      /** Server-filtered rows. Frontend does not filter a global list for access control. */
      groups: { id: string; title: string }[]; tests: { id: string; title: string }[] }
  >;
  /** Preserve identity; switch view only, never create a second student account. */
  openStudent(): Promise<void>;
  /** Use the configured Clerk instance; revoke local view immediately. */
  signOut(): Promise<void>;
}

/** Internal review integration. Do not wire to a provisional HTTP API. */
export interface VerifiedBrowserIdentity {
  readonly userId: string;
  /** Opaque local provider-session generation, never a bearer token or URL field. */
  readonly generation: string;
}
export interface TeacherBrowserReviewIntegration {
  identity: {
    /** Null means verified signed out; throw if identity state is unavailable. */
    current(): VerifiedBrowserIdentity | null;
    /** Report account/session changes and available server grant invalidations. */
    subscribe(invalidate: () => void): () => void;
    /** Compare the expected provider generation at dispatch. */
    signOut(expected: VerifiedBrowserIdentity): Promise<void>;
  };
  transport: {
    /** Take auth from verified provider integration, not this browser identity DTO. */
    read(input: {
      expected: VerifiedBrowserIdentity;
      signal: AbortSignal;
    }): Promise<{ status: number; data: unknown }>;
  };
}

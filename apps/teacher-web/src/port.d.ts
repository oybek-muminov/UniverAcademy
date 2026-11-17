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

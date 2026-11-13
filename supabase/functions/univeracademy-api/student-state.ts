import { fail } from "./fault.ts";
import type { Admission, AttemptRecord } from "./attempts.ts";
import type { PublishedTest, Ratio } from "./ordinary.ts";

// Prototype storage contract, not a schema/migration or a production DB implementation.
export type Profile = {
  person_id: string; first_name: string; last_name: string;
  roles: ("student" | "teacher" | "admin" | "owner")[];
  registration_complete: boolean; active_group_id: string | null; qadam_id: string | null;
};
export type Person = { telegramId: number | null; enabled: boolean; profile: Profile };
export type Family = {
  personId: string; expiresAt: number; revokedAt: number | null;
  logoutRetainUntil: number | null;
  // Existing standalone handlers may omit it. The Clerk candidate requires
  // explicit provenance for every active family; missing is never "telegram".
  authProvider?: "clerk" | "telegram";
};
export type AccessProof = { familyId: string; expiresAt: number; superseded: boolean };
export type RefreshProof = { familyId: string; consumed: boolean };
export type Grant = { rostered: boolean; membershipEpoch: number; grantEpoch: number };
export type SeriesRecord = {
  id: string; currentAttemptId: string; generation: number; normalAttemptUsed: boolean;
  officialAttemptId: string | null;
  recoveryState: "none" | "ready" | "active" | "lapsed";
  recovery: { opensAt: number; closesAt: number; durationMs: number } | null;
};
export type AssignmentRecord = {
  admission: Admission; published: PublishedTest; title: string;
  instructions: unknown[];
  contents: Record<string, { prompt: unknown[]; options: Record<string, unknown[]> }>;
  reviewGate: Record<string, unknown>;
  cancelled: boolean;
};
export type StudentState = {
  people: Record<string, Person>;
  families: Record<string, Family>;
  access: Record<string, AccessProof>;
  refresh: Record<string, RefreshProof>;
  consumedInitData: Record<string, true>;
  grants: Record<string, Record<string, Grant>>;
  assignments: Record<string, AssignmentRecord>;
  series: Record<string, SeriesRecord>;
  attempts: Record<string, AttemptRecord>;
  receipts: Record<string, { payload: string; attemptId: string }>;
  // Own aggregate only; no bonus activation or computation in this adapter.
  bonuses: Record<string, { calculationId: string; earned: Ratio; calculatedAt: number }>;
  cancellations: Record<string, { cancelledAt: number; priorStatus: string }>;
};
export type TransactionContext = { state: StudentState; now(): number };
export interface StudentTransactions {
  // Acquire relevant locks BEFORE invoking work/now; resolve only AFTER commit.
  // Returning an error reply still commits. Throwing aborts. No default/fallback store.
  transaction<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}
export type SessionPolicy = {
  initDataMaxAgeSeconds: number; futureSkewSeconds: number;
  accessTtlMs: number; familyTtlMs: number; logoutTombstoneMs: number;
  identityCollisionAttempts: number;
  // User confirmed one active device; mapping it to one family is this local technical variant.
  newLogin: "revoke_previous";
};
export type NumericPresentation = {
  policyId: string;
  toFiniteNumber(value: Ratio): number;
  toDisplayString(value: Ratio): string;
  toStudentPointsDisplayString(value: Ratio): string;
};

export function revokeFamily(family: Family, now: number, policy: SessionPolicy): void {
  if (family.revokedAt === null) {
    family.revokedAt = now;
    family.logoutRetainUntil = now + policy.logoutTombstoneMs;
  }
}

export function checkSessionPolicy(policy: SessionPolicy | undefined): SessionPolicy {
  if (!policy || policy.newLogin !== "revoke_previous") fail("SERVICE_UNAVAILABLE", 503);
  for (const key of ["initDataMaxAgeSeconds", "futureSkewSeconds", "accessTtlMs",
    "familyTtlMs", "logoutTombstoneMs", "identityCollisionAttempts"] as const) {
    const value = policy[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("SERVICE_UNAVAILABLE", 503);
    }
  }
  if (policy.initDataMaxAgeSeconds <= 0 || policy.accessTtlMs <= 0 ||
    policy.familyTtlMs < policy.accessTtlMs || policy.identityCollisionAttempts <= 0) {
    fail("SERVICE_UNAVAILABLE", 503);
  }
  return policy;
}

export const seriesKey = (personId: string, demoId: string) => `${personId}/${demoId}`;
export async function proofHash(proof: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
function newProof(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)),
    (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function issueProofs(state: StudentState, familyId: string, now: number,
  policy: SessionPolicy) {
  const family = state.families[familyId];
  const accessToken = newProof(), refreshToken = newProof();
  const expiresAt = Math.min(now + policy.accessTtlMs, family.expiresAt);
  state.access[await proofHash(accessToken)] = { familyId, expiresAt, superseded: false };
  state.refresh[await proofHash(refreshToken)] = { familyId, consumed: false };
  return { accessToken, refreshToken, expiresAt, refreshExpiresAt: family.expiresAt };
}

export function bearer(request: Request, required = true): string | null {
  const header = request.headers.get("authorization");
  if (!header && !required) return null;
  const match = header?.match(/^Bearer ([^\s]+)$/i);
  if (!match) fail("SESSION_REVOKED", 401);
  return match[1];
}
export async function authenticate(state: StudentState, token: string, now: number) {
  const proof = state.access[await proofHash(token)];
  if (!proof) fail("SESSION_REVOKED", 401); // Staff JWTs are not student ledger proofs.
  const family = state.families[proof.familyId];
  if (!family || family.revokedAt !== null) fail("SESSION_REVOKED", 401);
  if (now >= family.expiresAt || now >= proof.expiresAt) fail("APP_SESSION_EXPIRED", 401);
  if (proof.superseded) fail("ACCESS_SUPERSEDED", 401);
  const person = state.people[family.personId];
  if (!person?.enabled) fail("ACCOUNT_DISABLED", 403);
  if (!person.profile.roles.includes("student")) fail("FORBIDDEN", 403);
  return { personId: family.personId, familyId: proof.familyId, person };
}

export function newQadamId(): string {
  let value = "";
  while (value.length < 10) {
    const digit = crypto.getRandomValues(new Uint8Array(1))[0];
    if (digit < 250) value += String(digit % 10);
  }
  return value;
}

export function studentPerson(state: StudentState, telegramId: number, firstName: string,
  lastName: string | null, policy: SessionPolicy): Person {
  const existing = Object.values(state.people).find((person) => person.telegramId === telegramId);
  if (existing) {
    if (!existing.enabled) fail("ACCOUNT_DISABLED", 403);
    if (!existing.profile.roles.includes("student")) fail("FORBIDDEN", 403);
    return existing;
  }
  for (let attempt = 0; attempt < policy.identityCollisionAttempts; attempt++) {
    const qadamId = newQadamId();
    if (Object.values(state.people).some((p) => p.profile.qadam_id === qadamId)) continue;
    const id = crypto.randomUUID();
    const person: Person = { telegramId, enabled: true, profile: {
      person_id: id, first_name: firstName, last_name: lastName ?? "", roles: ["student"],
      registration_complete: false, active_group_id: null, qadam_id: qadamId,
    } };
    state.people[id] = person;
    return person;
  }
  fail("SERVICE_UNAVAILABLE", 503);
}

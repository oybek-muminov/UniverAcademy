import { fail } from "../fault.ts";
import type { AttemptRecord } from "../attempts.ts";
import type { StaffState, VerifiedStaffProof } from "../staff-state.ts";

export type Enumeration<K> = { enumerationId: string; keys: readonly K[] };
export type CoverageReceipt = {
  version: "r1-local-v1"; transactionId: string; protectionId: string; frameId: string;
  scope: { actorId: string; studentId: string; groupId: string };
  enumerations: {
    targetSeries: Enumeration<string>; affectedAssignments: Enumeration<string>;
    participants: Enumeration<readonly [assignmentId: string, personId: string]>;
    recoveryAnchors: Enumeration<readonly [seriesKey: string, assignmentId: string]>;
  };
  rows: { [collection: string]: { present: readonly string[]; absent: readonly string[] } };
};
export type PreflightCommand = Readonly<{
  credential: string; studentId: string; groupId: string;
  expectedGroupRevision: number; expectedMembershipRevision: number;
}>;
export type PreflightScope = Omit<PreflightCommand, "credential">;
export type VerifiedActor = Readonly<{ actorId: string; proof: VerifiedStaffProof }>;
export type Protection = Readonly<{ transactionId: string; protectionId: string; frameId: string }>;
export type PreparedFrame = Protection & {
  actor: VerifiedActor; now: number; providerExpiresAt: number;
  state: StaffState; coverage: CoverageReceipt;
};
type CompletedAttempt = Pick<AttemptRecord,
  "status" | "completedAt" | "stateRevision" | "seriesStateRevision" | "ordinary">;
export type ExpiryDelta = Readonly<{
  binding: Protection & { actorId: string; studentId: string; groupId: string };
  attempts: readonly {
    attemptId: string;
    expected: { generation: number; stateRevision: number; seriesStateRevision: number; status: "in_progress"; ordinary: null };
    next: CompletedAttempt;
  }[];
  series: readonly {
    seriesKey: string;
    expected: { currentAttemptId: string; generation: number; officialAttemptId: string | null;
      recoveryState: string; recovery: unknown };
    next: { officialAttemptId: string; recoveryState: string; recovery: unknown };
  }[];
  gates: readonly {
    assignmentId: string; expected: { revision: number; barrierRevision: number };
    next: { eligible_unresolved_count: number; active_count: number; recovery_ready_count: number;
      barrier_complete: boolean; barrier_revision: number };
  }[];
}>;
export type LocalPreflightTransaction = Protection & {
  /** One final frame AFTER all waiting load/lock/provider work and a reread of
   * current mapping, liveness, authority and server clock. Denial must throw.
   * Return the same immutable verified actor/proof identity; do not replace or
   * mutate the command scope. The frame's IDs bind to this transaction boundary.
   * Enumeration/protection stays stable through guard, flush and completion.
   * No SQL or peer-lock protocol is implemented or certified by this interface. */
  prepareAndRefresh(actor: VerifiedActor, scope: PreflightScope): Promise<PreparedFrame>;
  /** Apply only this immutable CAS delta, atomically in the SAME transaction.
   * No membership/group/grant/auth/profile/receipt/audit/answer/snapshot writes. */
  flushExpiry(delta: ExpiryDelta): Promise<void>;
};
export type LocalMembershipPreflightPort = {
  /** Existing server verifier + canonical mapping, never request-supplied proof. */
  verifyAndLocate(credential: string): Promise<VerifiedActor>;
  /** Exactly one callback. Resolve ONLY after COMMIT ACK, with its same value.
   * Callback/flush faults roll back. Rollback ACK loss discards connection and
   * cannot certify rollback. COMMIT ACK loss throws StorageUnavailable with
   * outcome commit_unknown, whether the double committed or not. No retry.
   * Authority/revocation, student and peer lifecycle, membership/grant/assignment
   * writers must share this protection boundary. That obligation is UNPROVEN. */
  transaction<T>(actor: VerifiedActor, work: (tx: LocalPreflightTransaction) => Promise<T>):
    Promise<{ transactionId: string; value: T }>;
};

export function invariant(condition: unknown): asserts condition {
  if (!condition) fail("RESPONSE_INVARIANT_FAILED", 500);
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
export const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Reflect.ownKeys(a), bk = Reflect.ownKeys(b);
  return ak.length === bk.length && ak.every(k => Object.hasOwn(b, k) && same(Reflect.get(a, k), Reflect.get(b, k)));
}
export function immutable<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) immutable(Reflect.get(value, key));
    Object.freeze(value);
  }
  return value;
}
function keys(value: unknown): string[] {
  invariant(Array.isArray(value) && value.every(text));
  invariant(new Set(value).size === value.length);
  return value;
}
const equalKeys = (a: readonly string[], b: readonly string[]) => same([...a].sort(), [...b].sort());
function pairs(value: unknown): readonly (readonly [string, string])[] {
  invariant(Array.isArray(value) && value.every(v => Array.isArray(v) && v.length === 2 && v.every(text)));
  invariant(new Set(value.map(v => JSON.stringify(v))).size === value.length);
  return value;
}
const collections = ["staff", "groups", "people", "memberships", "grants", "assignments", "series", "attempts", "recoveryAssignments"] as const;

/** Checks INTERNAL receipt consistency, not the truth of a trusted port's
 * exhaustive enumeration/physical locks. Consistently omitted hidden rows
 * cannot be discovered by a local double. Empty enumeration != missing query. */
export function validateCoverage(frame: PreparedFrame, binding: Protection, actor: VerifiedActor, scope: PreflightScope): void {
  const s = frame.state, st = s.student, r = frame.coverage;
  invariant(record(r) && r.version === "r1-local-v1" && record(r.scope) && record(r.enumerations) && record(r.rows));
  invariant(r.transactionId === binding.transactionId && r.protectionId === binding.protectionId && r.frameId === binding.frameId);
  invariant(same(r.scope, { actorId: actor.actorId, studentId: scope.studentId, groupId: scope.groupId }));
  const enums = r.enumerations;
  const allEnums = [enums.targetSeries, enums.affectedAssignments, enums.participants, enums.recoveryAnchors];
  invariant(allEnums.every(e => record(e) && text(e.enumerationId) && Array.isArray(e.keys)));
  invariant(new Set(allEnums.map(e => e.enumerationId)).size === 4);
  const target = keys(enums.targetSeries.keys), affected = keys(enums.affectedAssignments.keys);
  const participants = pairs(enums.participants.keys), anchors = pairs(enums.recoveryAnchors.keys);
  invariant(record(st) && record(s.staff) && record(s.groups) && record(s.memberships) && record(s.recoveryAssignments));
  for (const k of ["people", "grants", "assignments", "series", "attempts"] as const) invariant(record(st[k]));
  const grantKeys: string[] = [];
  for (const [person, grants] of Object.entries(st.grants)) {
    invariant(record(grants)); for (const id of Object.keys(grants)) grantKeys.push(person + "/" + id);
  }
  const maps: Record<typeof collections[number], string[]> = {
    staff: Object.keys(s.staff), groups: Object.keys(s.groups), people: Object.keys(st.people), memberships: Object.keys(s.memberships),
    grants: grantKeys, assignments: Object.keys(st.assignments), series: Object.keys(st.series), attempts: Object.keys(st.attempts),
    recoveryAssignments: Object.keys(s.recoveryAssignments),
  };
  invariant(equalKeys(Object.keys(r.rows), collections));
  for (const c of collections) {
    const facts = r.rows[c]; invariant(record(facts));
    const present = keys(facts.present), absent = keys(facts.absent);
    invariant(equalKeys(present, maps[c]) && absent.every(k => !present.includes(k)));
  }
  const fact = (c: typeof collections[number], k: string) => invariant(r.rows[c].present.includes(k) || r.rows[c].absent.includes(k));
  const present = (c: typeof collections[number], k: string) => invariant(r.rows[c].present.includes(k));
  present("staff", actor.proof.subject);
  // Explicitly absent target/group/membership is distinguishable from an
  // omitted projection; the existing guard retains its NOT_FOUND oracle.
  fact("groups", scope.groupId); fact("people", scope.studentId); fact("memberships", scope.studentId);
  invariant(equalKeys(target, Object.keys(st.series).filter(k => k.startsWith(scope.studentId + "/"))));
  const current = (key: string) => {
    const series = st.series[key]; invariant(series && text(series.currentAttemptId)); present("attempts", series.currentAttemptId);
    const a = st.attempts[series.currentAttemptId];
    invariant(a && record(a.published) && Array.isArray(a.answers) && Array.isArray(a.questionOrder) && Object.hasOwn(a, "ordinary"));
    present("assignments", a.assignmentId);
    if (!key.startsWith(scope.studentId + "/")) invariant(a.id === series.currentAttemptId &&
      key === a.personId + "/" + a.published.demoId && a.generation === series.generation);
    return a; // C04/R03 target identity/lifecycle validation remains in guard.
  };
  const elapsedAssignments = new Set<string>(), demos = new Set<string>();
  for (const key of target) {
    const a = current(key);
    if (a.status === "in_progress" && frame.now >= a.deadlineAt) { elapsedAssignments.add(a.assignmentId); demos.add(a.published.demoId); }
  }
  for (const [id, a] of Object.entries(st.assignments)) invariant(a.admission.assignmentId === id && record(a.reviewGate));
  const closure = Object.entries(st.assignments).filter(([id, a]) => elapsedAssignments.has(id) || demos.has(a.published.demoId)).map(([id]) => id);
  invariant(equalKeys(affected, closure));
  const participantKeys = new Set(participants.map(p => JSON.stringify(p)));
  const needParticipant = (assignment: string, person: string) => invariant(participantKeys.has(JSON.stringify([assignment, person])));
  for (const [assignment, person] of participants) {
    invariant(affected.includes(assignment)); present("assignments", assignment); present("people", person); present("memberships", person);
    fact("grants", person + "/" + assignment);
    const key = person + "/" + st.assignments[assignment].published.demoId; fact("series", key);
    if (st.series[key]) current(key);
  }
  for (const [person, grants] of Object.entries(st.grants)) for (const assignment of Object.keys(grants))
    if (affected.includes(assignment)) needParticipant(assignment, person);
  const expectedAnchors: (readonly [string, string])[] = [];
  for (const [key, series] of Object.entries(st.series)) {
    const person = key.split("/")[0], a = current(key);
    if (affected.includes(a.assignmentId)) needParticipant(a.assignmentId, person);
    if (series.recoveryState === "ready") {
      fact("recoveryAssignments", key);
      const anchor = s.recoveryAssignments[key] ?? a.assignmentId;
      invariant(text(anchor)); present("assignments", anchor);
      if (person === scope.studentId || affected.includes(anchor)) expectedAnchors.push([key, anchor]);
      if (affected.includes(anchor)) needParticipant(anchor, person);
    }
  }
  invariant(equalKeys(anchors.map(p => JSON.stringify(p)), expectedAnchors.map(p => JSON.stringify(p))));
}

/** A net-delta whitelist, not transient writer instrumentation. The adapter's
 * detached guard state is never exposed to a continuation or a port writer. */
export function expiryDelta(before: StaffState, after: StaffState, now: number,
  binding: ExpiryDelta["binding"]): ExpiryDelta {
  const expected = structuredClone(before), attempts: ExpiryDelta["attempts"][number][] = [];
  const series: ExpiryDelta["series"][number][] = [], gates: ExpiryDelta["gates"][number][] = [];
  invariant(equalKeys(Object.keys(before.student.attempts), Object.keys(after.student.attempts)));
  const affectedIds = new Set<string>(), affectedDemos = new Set<string>();
  for (const [id, next] of Object.entries(after.student.attempts)) {
    const old = before.student.attempts[id]; if (same(old, next)) continue;
    const key = binding.studentId + "/" + old.published.demoId, priorSeries = before.student.series[key];
    invariant(old.personId === binding.studentId && old.id === id && priorSeries?.currentAttemptId === id && priorSeries.generation === old.generation);
    invariant(old.status === "in_progress" && old.ordinary === null && now >= old.deadlineAt);
    invariant([old.generation, old.stateRevision, old.seriesStateRevision, next.stateRevision, next.seriesStateRevision].every(revision));
    invariant(next.status === "expired" && next.completedAt === old.deadlineAt && next.stateRevision === old.stateRevision + 1 &&
      next.seriesStateRevision === old.seriesStateRevision + 1 && next.ordinary !== null && next.ordinary.calculatedAt === now);
    const completion: CompletedAttempt = { status: next.status, completedAt: next.completedAt, stateRevision: next.stateRevision,
      seriesStateRevision: next.seriesStateRevision, ordinary: next.ordinary };
    invariant(same({ ...old, ...completion }, next));
    expected.student.attempts[id] = structuredClone(next);
    attempts.push({ attemptId: id, expected: { generation: old.generation, stateRevision: old.stateRevision, seriesStateRevision: old.seriesStateRevision,
      status: "in_progress", ordinary: null }, next: structuredClone(completion) });
    const desired = { ...priorSeries, officialAttemptId: id, ...(next.generation > 1 ? { recoveryState: "none" as const, recovery: null } : {}) };
    invariant(same(after.student.series[key], desired)); expected.student.series[key] = structuredClone(desired);
    series.push({ seriesKey: key, expected: { currentAttemptId: priorSeries.currentAttemptId, generation: priorSeries.generation,
      officialAttemptId: priorSeries.officialAttemptId, recoveryState: priorSeries.recoveryState, recovery: structuredClone(priorSeries.recovery) },
      next: { officialAttemptId: id, recoveryState: desired.recoveryState, recovery: structuredClone(desired.recovery) } });
    affectedIds.add(old.assignmentId); affectedDemos.add(old.published.demoId);
  }
  for (const [id, a] of Object.entries(after.student.assignments)) {
    const old = before.student.assignments[id]; invariant(old);
    if (same(old, a)) continue;
    invariant(affectedIds.has(id) || affectedDemos.has(a.published.demoId));
    const b = old.reviewGate, g = a.reviewGate;
    invariant(revision(b.revision) && revision(b.barrier_revision) && revision(g.barrier_revision) && g.barrier_revision === b.barrier_revision + 1);
    invariant([g.eligible_unresolved_count, g.active_count, g.recovery_ready_count].every(revision) && typeof g.barrier_complete === "boolean");
    const next = { eligible_unresolved_count: g.eligible_unresolved_count as number, active_count: g.active_count as number,
      recovery_ready_count: g.recovery_ready_count as number, barrier_complete: g.barrier_complete, barrier_revision: g.barrier_revision };
    invariant(same({ ...old, reviewGate: { ...b, ...next } }, a));
    expected.student.assignments[id] = structuredClone(a);
    gates.push({ assignmentId: id, expected: { revision: b.revision, barrierRevision: b.barrier_revision }, next });
  }
  invariant(same(expected, after)); // Includes every forbidden/unloaded collection.
  return immutable({ binding: { ...binding }, attempts, series, gates });
}

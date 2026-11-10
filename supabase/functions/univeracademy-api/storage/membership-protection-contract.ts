import { fail } from "../fault.ts";
import { currentStaff } from "../staff-state.ts";
import type { StaffAccessRecord, VerifiedStaffProof } from "../staff-state.ts";
import { requireRemovalAuthority } from "../removal-authority.ts";

/** SQL-free LOCAL CONTRACT MODEL. Inputs are claims from trusted composition,
 * never request fields or physical-lock certificates. No production binding,
 * writer, guard, gate maintenance, removal or automatic retry is implemented.
 * Consistently omitted peers and nonparticipating writers remain undetectable.
 */
export type ResourceKind = "identity" | "person" | "group" | "version" | "demo" |
  "assignment" | "gate" | "series" | "attempt";
export type Resource = Readonly<{ kind: ResourceKind; key: string }>;
export type Scope = Readonly<{ actorId: string; studentId: string; groupId: string; affinityGroupId: string }>;
export type TargetBindings = {
  currentSeries: readonly { seriesKey: string; demoId: string; assignmentId: string; attemptId: string; generation: number }[];
  grants: readonly { assignmentId: string; demoId: string }[];
  historicalAttempts: readonly { attemptId: string; assignmentId: string; demoId: string }[];
  recoveryAnchors: readonly { seriesKey: string; assignmentId: string; demoId: string; generation: number }[];
};
export type ProtectionInput = {
  mode: "local_contract"; transactionId: string; protectionId: string; scope: Scope;
  identityAnchors: readonly string[]; personIds: readonly string[];
  groupIds: readonly string[]; versionIds: readonly string[]; bindings: TargetBindings;
};
export type StatementRead = Readonly<{
  statementId: string; transactionId: string; protectionId: string;
  kind: "statement_fresh" | "transaction_snapshot"; startedOrdinal: number; snapshotVersion: number;
}>;
export type Enumeration<K> = Readonly<{ enumerationId: string; keys: readonly K[] }>;
export const PROTECTION_COLLECTIONS = Object.freeze([
  "staff", "groups", "people", "memberships", "grants", "assignments", "series", "attempts", "recoveryAssignments",
] as const);
type Collection = typeof PROTECTION_COLLECTIONS[number];
export type Projection = {
  transactionId: string; protectionId: string; read: StatementRead;
  enumerations: {
    targetSeries: Enumeration<string>; protectedAssignments: Enumeration<string>;
    participants: Enumeration<readonly [assignmentId: string, personId: string]>;
    recoveryAnchors: Enumeration<readonly [seriesKey: string, assignmentId: string]>;
  };
  rows: Record<Collection, { present: readonly string[]; absent: readonly string[] }>;
  loaded: Record<Collection, readonly string[]>;
  assignments: readonly { assignmentId: string; demoId: string }[];
  participants: readonly { assignmentId: string; personId: string; seriesKey: string;
    currentAttemptId: string | null; recoveryAssignmentId: string | null }[];
};
export type FreshFrame = {
  transactionId: string; protectionId: string; frameId: string; waitEpoch: number;
  now: number; providerExpiresAt: number; scope: Scope; proof: VerifiedStaffProof;
  staff: Record<string, StaffAccessRecord>;
  issuedOrdinal: number; snapshotVersion: number;
  affectedAssignmentIds: readonly string[];
};
export type ProtectionReceipt = Readonly<{
  version: "r1-protection-local-v1"; transactionId: string; protectionId: string; frameId: string;
  scope: Scope; lockedPersonIds: readonly string[]; demoFenceIds: readonly string[];
  targetBindingDigest: string; bindingRead: StatementRead; projectionRead: StatementRead;
  enumerations: Projection["enumerations"]; rows: Projection["rows"];
  protectedAssignmentIds: readonly string[]; affectedAssignmentIds: readonly string[];
  waitEpoch: number; now: number; resourcePlan: readonly Resource[];
}>;
export type Phase = "locking" | "rereading" | "bindings" | "projection" | "sealed" |
  "guard" | "flush" | "callback_returned" | "commit_pending" | "commit_ack" |
  "rollback_pending" | "rollback_ack" | "commit_unknown" | "rollback_unknown" | "discarded" | "released" | "failed";

const rank: Record<ResourceKind, number> = {
  identity: 0, person: 1, group: 2, version: 2, demo: 3, assignment: 4, gate: 4, series: 5, attempt: 6,
};
const ok = (condition: unknown): void => { if (!condition) fail("RESPONSE_INVARIANT_FAILED", 500); };
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
function strings(v: unknown): asserts v is readonly string[] {
  ok(Array.isArray(v) && v.every(id) && new Set(v).size === v.length);
}
function sorted(v: readonly string[]): string[] { return [...v].sort(); }
function eq(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function setEqual(a: readonly string[], b: readonly string[]): boolean { return eq(sorted(a), sorted(b)); }
function freeze<T>(v: T): T {
  if (v && typeof v === "object") { for (const x of Object.values(v)) freeze(x); Object.freeze(v); }
  return v;
}
function copy<T>(v: T): T { return freeze(structuredClone(v)); }
const resourceKey = (r: Resource) => r.kind + ":" + r.key;
function resources(parts: readonly Resource[]): Resource[] {
  ok(new Set(parts.map(resourceKey)).size === parts.length);
  return [...parts].sort((a, b) => rank[a.kind] - rank[b.kind] ||
    (resourceKey(a) < resourceKey(b) ? -1 : resourceKey(a) > resourceKey(b) ? 1 : 0));
}
function normalizeBindings(b: TargetBindings): TargetBindings {
  ok(b && typeof b === "object");
  const specs = {
    currentSeries: ["seriesKey", "demoId", "assignmentId", "attemptId", "generation"],
    grants: ["assignmentId", "demoId"], historicalAttempts: ["attemptId", "assignmentId", "demoId"],
    recoveryAnchors: ["seriesKey", "assignmentId", "demoId", "generation"],
  } as const;
  ok(setEqual(Object.keys(b), Object.keys(specs)));
  const result: Record<string, unknown> = {};
  for (const [name, fields] of Object.entries(specs)) {
    const entries = b[name as keyof TargetBindings]; ok(Array.isArray(entries));
    const rows = entries.map(entry => {
      ok(entry && setEqual(Object.keys(entry), fields));
      return Object.fromEntries(fields.map(field => {
        const value = (entry as unknown as Record<string, unknown>)[field];
        ok(field === "generation" ? integer(value) : id(value)); return [field, value];
      }));
    });
    const key = name === "currentSeries" || name === "recoveryAnchors" ? "seriesKey" : name === "grants" ? "assignmentId" : "attemptId";
    ok(new Set(rows.map(row => row[key])).size === rows.length);
    result[name] = rows.sort((a, c) => String(a[key]) < String(c[key]) ? -1 : String(a[key]) > String(c[key]) ? 1 : 0);
  }
  return copy(result as TargetBindings);
}
async function digest(b: TargetBindings): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(b));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
}

export type ProtocolEvent = Readonly<{ ordinal: number; transactionId: string; event: string; resource?: Resource }>;
const constructionKey = Symbol("local protection construction");

/** Shared SYNTHETIC ownership/query ledger. Two models must use the same ledger
 * to model contention. Its tokens establish model provenance, never SQL truth.
 * Statement snapshots begin here, rather than being relabelled after waiting. */
export class LocalProtectionLedger {
  #ordinal = 0;
  #version = 0;
  #transactions = new Map<string, { protectionId: string; initialVersion: number }>();
  #owners = new Map<string, string>();
  #lastResource = new Map<string, Resource>();
  #ended = new Set<string>();
  #statements = new WeakSet<object>();
  #frames = new WeakSet<object>();
  #frameIds = new Set<string>();
  #events: ProtocolEvent[] = [];
  get version(): number { return this.#version; }
  lastOrdinal(transactionId: string): number { return this.#events.findLast(e => e.transactionId === transactionId)?.ordinal ?? 0; }
  get events(): readonly ProtocolEvent[] { return copy(this.#events); }
  register(transactionId: string, protectionId: string): void {
    ok(id(transactionId) && id(protectionId) && !this.#transactions.has(transactionId));
    this.#transactions.set(transactionId, { protectionId, initialVersion: this.#version });
    this.note(transactionId, "begin");
  }
  note(transactionId: string, event: string, resource?: Resource): number {
    ok(this.#transactions.has(transactionId) && !this.#ended.has(transactionId));
    this.#events.push(copy({ ordinal: ++this.#ordinal, transactionId, event, ...(resource ? { resource } : {}) }));
    return this.#ordinal;
  }
  acquire(transactionId: string, resource: Resource): boolean {
    ok(this.#transactions.has(transactionId) && !this.#ended.has(transactionId));
    ok(resource && Object.hasOwn(rank, resource.kind) && id(resource.key));
    const key = resourceKey(resource), owner = this.#owners.get(key);
    const last = this.#lastResource.get(transactionId);
    ok(owner === transactionId || !last || rank[resource.kind] > rank[last.kind] ||
      (rank[resource.kind] === rank[last.kind] && key > resourceKey(last)));
    this.note(transactionId, owner && owner !== transactionId ? "lock.blocked" : "lock.acquired", resource);
    if (owner && owner !== transactionId) return false;
    this.#owners.set(key, transactionId);
    // Reacquiring an owned resource must not lower the acquisition watermark.
    if (owner !== transactionId) this.#lastResource.set(transactionId, copy(resource));
    return true;
  }
  owns(transactionId: string, resource: Resource): boolean { return this.#owners.get(resourceKey(resource)) === transactionId; }
  statement(transactionId: string, kind: StatementRead["kind"] = "statement_fresh"): StatementRead {
    const tx = this.#transactions.get(transactionId); ok(tx);
    ok(kind === "statement_fresh" || kind === "transaction_snapshot");
    const ordinal = this.note(transactionId, "statement.start");
    const value = copy({ statementId: transactionId + "/statement/" + ordinal, transactionId,
      protectionId: tx!.protectionId, kind, startedOrdinal: ordinal,
      snapshotVersion: kind === "statement_fresh" ? this.#version : tx!.initialVersion });
    this.#statements.add(value); return value;
  }
  authenticRead(read: StatementRead, transactionId: string, protectionId: string): boolean {
    return !!read && this.#statements.has(read) && read.transactionId === transactionId && read.protectionId === protectionId;
  }
  refreshFrame(transactionId: string, values: Omit<FreshFrame, "transactionId" | "protectionId" | "issuedOrdinal" | "snapshotVersion">): FreshFrame {
    const tx = this.#transactions.get(transactionId); ok(tx); ok(id(values.frameId) && !this.#frameIds.has(values.frameId));
    this.#frameIds.add(values.frameId);
    const value = copy({ ...values, transactionId, protectionId: tx!.protectionId,
      issuedOrdinal: this.note(transactionId, "authority-clock.refresh"), snapshotVersion: this.#version });
    this.#frames.add(value); return value;
  }
  authenticFrame(frame: FreshFrame): boolean { return !!frame && this.#frames.has(frame); }
  /** Participating writer model: fence AND corresponding gate maintenance are
   * both obligations. This records a commit in the simulation, not a DB COMMIT. */
  writerCommitted(transactionId: string, demoIds: readonly string[], gateMaintainedDemoIds: readonly string[], read: StatementRead): void {
    strings(demoIds); strings(gateMaintainedDemoIds);
    ok(setEqual(demoIds, gateMaintainedDemoIds) && demoIds.every(key => this.owns(transactionId, { kind: "demo", key })));
    const tx = this.#transactions.get(transactionId);
    ok(tx && this.authenticRead(read, transactionId, tx.protectionId) && read.kind === "statement_fresh" &&
      read.snapshotVersion === this.#version && read.startedOrdinal === this.lastOrdinal(transactionId));
    const fenceAcquisitions = this.#events.filter(e => e.transactionId === transactionId && e.event === "lock.acquired" && e.resource?.kind === "demo");
    ok(fenceAcquisitions.every(e => e.ordinal < read.startedOrdinal));
    // The fresh statement models a writer's post-wait recheck. It does not
    // implement that writer's authorization, clock, lifecycle or gate algorithm.
    this.#version++; this.note(transactionId, "writer.commit-with-gates");
  }
  end(transactionId: string, event: "commit.ack" | "rollback.ack" | "discard.unknown"): void {
    this.note(transactionId, event);
    for (const [key, owner] of this.#owners) if (owner === transactionId) this.#owners.delete(key);
    this.#ended.add(transactionId);
    // Synthetic ownership is released. Discard is NOT evidence that a physical
    // DB lock was released or that a rollback/commit was acknowledged.
  }
}

/** Construction is explicit and asynchronous ONLY for the binding SHA256.
 * Authoritative reread also precedes the final synchronous freshness seal. */
export async function createMembershipProtectionContract(input: ProtectionInput, ledger: LocalProtectionLedger): Promise<MembershipProtectionContract> {
  if (!input || input.mode !== "local_contract" || !(ledger instanceof LocalProtectionLedger)) fail("SERVICE_UNAVAILABLE", 503);
  ok(id(input.transactionId) && id(input.protectionId));
  ok(input.scope && Object.values(input.scope).every(id) &&
    setEqual(Object.keys(input.scope), ["actorId", "studentId", "groupId", "affinityGroupId"]));
  for (const a of [input.identityAnchors, input.personIds, input.groupIds, input.versionIds]) strings(a);
  ok(input.identityAnchors.includes(input.scope.actorId) && input.personIds.includes(input.scope.studentId));
  ok(input.groupIds.includes(input.scope.groupId) && input.groupIds.includes(input.scope.affinityGroupId));
  const bindings = normalizeBindings(input.bindings);
  for (const b of [...bindings.currentSeries, ...bindings.recoveryAnchors]) ok(b.seriesKey === input.scope.studentId + "/" + b.demoId);
  const assignmentDemos = new Map<string, string>();
  for (const b of Object.values(bindings).flat()) {
    ok(!assignmentDemos.has(b.assignmentId) || assignmentDemos.get(b.assignmentId) === b.demoId);
    assignmentDemos.set(b.assignmentId, b.demoId);
  }
  const safe = copy({ ...input, bindings });
  const hash = await digest(bindings);
  ledger.register(input.transactionId, input.protectionId);
  return new MembershipProtectionContract(constructionKey, safe, hash, ledger);
}

export class MembershipProtectionContract {
  #phase: Phase = "locking";
  #plan: readonly Resource[];
  #acquired = 0;
  #waitEpoch = 0;
  #minimumVersion = 0;
  #fenceOrdinal = 0;
  #bindingRead?: StatementRead;
  #projection?: Projection;
  #receipt?: ProtectionReceipt;
  #held = true;
  #originalError: unknown;
  #input: ProtectionInput;
  #targetBindingDigest: string;
  #ledger: LocalProtectionLedger;
  #lastOrdinal = 0;
  get input(): ProtectionInput { return this.#input; }
  get targetBindingDigest(): string { return this.#targetBindingDigest; }

  /** Use createMembershipProtectionContract; the constructor requires the exact
   * digest, and seal rechecks its binding. It does not acquire physical locks. */
  constructor(key: symbol, input: ProtectionInput, targetBindingDigest: string, ledger: LocalProtectionLedger) {
    ok(key === constructionKey);
    this.#input = copy(input); this.#targetBindingDigest = targetBindingDigest; this.#ledger = ledger;
    const demoIds = sorted([...new Set(Object.values(input.bindings).flatMap(rows => rows.map(row => row.demoId)))]);
    this.#plan = copy(resources([
      ...input.identityAnchors.map(key => ({ kind: "identity" as const, key })),
      ...input.personIds.map(key => ({ kind: "person" as const, key })),
      ...input.groupIds.map(key => ({ kind: "group" as const, key })),
      ...input.versionIds.map(key => ({ kind: "version" as const, key })),
      ...demoIds.map(key => ({ kind: "demo" as const, key })),
    ]));
  }
  get phase(): Phase { return this.#phase; }
  get leaseHeld(): boolean { return this.#held; }
  get plan(): readonly Resource[] { return this.#plan; }
  get waitEpoch(): number { return this.#waitEpoch; }
  get fenceOrdinal(): number { return this.#fenceOrdinal; }
  #check(condition: unknown): void {
    if (!condition) { this.#phase = "failed"; fail("RESPONSE_INVARIANT_FAILED", 500); }
  }
  #binding(v: { transactionId: string; protectionId: string }): void {
    this.#check(v && v.transactionId === this.input.transactionId && v.protectionId === this.input.protectionId);
  }
  /** Every waiting load/lock/provider operation must be reported BEFORE seal.
   * observedVersion is a trusted model fact, not evidence of SQL freshness. */
  noteWait(observedVersion: number): void {
    this.#check(["locking", "bindings", "projection"].includes(this.#phase) && integer(observedVersion) && observedVersion >= this.#minimumVersion);
    this.#check(observedVersion === this.#ledger.version);
    this.#minimumVersion = observedVersion; this.#waitEpoch++;
    this.#lastOrdinal = this.#ledger.note(this.input.transactionId, "external.wait");
  }
  acquire(resource: Resource): boolean {
    this.#check(this.#held && ["locking", "projection"].includes(this.#phase));
    const next = this.#plan[this.#acquired];
    this.#check(next && resource && resource.kind === next.kind && resource.key === next.key);
    this.#waitEpoch++;
    if (!this.#ledger.acquire(this.input.transactionId, resource)) return false;
    this.#acquired++;
    this.#lastOrdinal = this.#ledger.events.at(-1)!.ordinal;
    if (this.#phase === "locking" && this.#acquired === this.#plan.length) this.#fenceOrdinal = this.#lastOrdinal;
    return true;
  }
  #read(read: StatementRead): void {
    this.#check(read && id(read.statementId) && read.kind === "statement_fresh" &&
      this.#ledger.authenticRead(read, this.input.transactionId, this.input.protectionId) &&
      read.startedOrdinal > this.#fenceOrdinal && integer(read.snapshotVersion) &&
      read.snapshotVersion >= this.#minimumVersion && read.snapshotVersion === this.#ledger.version);
  }
  async rereadTargetBindings(read: StatementRead, bindings: TargetBindings): Promise<void> {
    this.#check(this.#phase === "locking" && this.#held && this.#acquired === this.#plan.length);
    this.#read(read); this.#phase = "rereading";
    const normalized = normalizeBindings(bindings), hash = await digest(normalized);
    this.#check(this.#phase === "rereading" && hash === this.targetBindingDigest && eq(normalized, this.input.bindings));
    this.#bindingRead = copy(read); this.#minimumVersion = read.snapshotVersion;
    this.#waitEpoch++; this.#lastOrdinal = this.#ledger.note(this.input.transactionId, "bindings.reread"); this.#phase = "bindings";
  }
  loadProjection(projection: Projection): void {
    this.#check(this.#phase === "bindings" && this.#held); this.#binding(projection); this.#read(projection.read);
    this.#check(projection.read.statementId !== this.#bindingRead!.statementId && projection.read.startedOrdinal > this.#lastOrdinal);
    const p = projection, e = p.enumerations, b = this.input.bindings;
    this.#check(e && setEqual(Object.keys(e), ["targetSeries", "protectedAssignments", "participants", "recoveryAnchors"]));
    const all = Object.values(e);
    this.#check(all.every(v => v && id(v.enumerationId) && Array.isArray(v.keys)) && new Set(all.map(v => v.enumerationId)).size === 4);
    strings(e.targetSeries.keys); strings(e.protectedAssignments.keys);
    const pairs = (keys: readonly (readonly string[])[]) => {
      this.#check(Array.isArray(keys) && keys.every(v => Array.isArray(v) && v.length === 2 && v.every(id)) &&
        new Set(keys.map(v => JSON.stringify(v))).size === keys.length);
    };
    pairs(e.participants.keys); pairs(e.recoveryAnchors.keys);
    this.#check(p.rows && p.loaded && setEqual(Object.keys(p.rows), PROTECTION_COLLECTIONS) && setEqual(Object.keys(p.loaded), PROTECTION_COLLECTIONS));
    for (const c of PROTECTION_COLLECTIONS) {
      this.#check(p.rows[c] && setEqual(Object.keys(p.rows[c]), ["present", "absent"]));
      strings(p.rows[c].present); strings(p.rows[c].absent); strings(p.loaded[c]);
      this.#check(setEqual(p.rows[c].present, p.loaded[c]) && p.rows[c].absent.every(k => !p.rows[c].present.includes(k)));
    }
    const fact = (c: Collection, k: string) => this.#check(p.rows[c].present.includes(k) || p.rows[c].absent.includes(k));
    const present = (c: Collection, k: string) => this.#check(p.rows[c].present.includes(k));
    for (const g of [this.input.scope.groupId, this.input.scope.affinityGroupId]) fact("groups", g);
    fact("people", this.input.scope.studentId); fact("memberships", this.input.scope.studentId);
    this.#check(Array.isArray(p.assignments) && p.assignments.every(a => id(a.assignmentId) && id(a.demoId)));
    const demos = this.#plan.filter(r => r.kind === "demo").map(r => r.key);
    const assignments = p.assignments.map(a => a.assignmentId); strings(assignments);
    this.#check(setEqual(assignments, p.loaded.assignments) && setEqual(assignments, e.protectedAssignments.keys) && p.assignments.every(a => demos.includes(a.demoId)));
    for (const entry of Object.values(b).flat()) {
      present("assignments", entry.assignmentId);
      this.#check(p.assignments.some(a => a.assignmentId === entry.assignmentId && a.demoId === entry.demoId));
    }
    this.#check(setEqual(e.targetSeries.keys, b.currentSeries.map(s => s.seriesKey)));
    for (const s of b.currentSeries) { present("series", s.seriesKey); present("attempts", s.attemptId); }
    for (const a of b.historicalAttempts) present("attempts", a.attemptId);
    for (const g of b.grants) present("grants", this.input.scope.studentId + "/" + g.assignmentId);
    this.#check(Array.isArray(p.participants));
    const participantPairs = p.participants.map(v => JSON.stringify([v.assignmentId, v.personId]));
    this.#check(new Set(participantPairs).size === participantPairs.length &&
      setEqual(participantPairs, e.participants.keys.map(v => JSON.stringify(v))));
    const anchors = new Set(b.recoveryAnchors.map(r => JSON.stringify([r.seriesKey, r.assignmentId])));
    for (const r of b.recoveryAnchors) present("recoveryAssignments", r.seriesKey);
    for (const v of p.participants) {
      this.#check(id(v.assignmentId) && id(v.personId) && id(v.seriesKey) && assignments.includes(v.assignmentId));
      const a = p.assignments.find(a => a.assignmentId === v.assignmentId)!;
      this.#check(v.seriesKey === v.personId + "/" + a.demoId);
      present("people", v.personId); present("memberships", v.personId); fact("grants", v.personId + "/" + v.assignmentId); fact("series", v.seriesKey);
      if (v.currentAttemptId !== null) { this.#check(id(v.currentAttemptId)); present("series", v.seriesKey); present("attempts", v.currentAttemptId); }
      else this.#check(p.rows.series.absent.includes(v.seriesKey));
      if (v.recoveryAssignmentId !== null) {
        this.#check(id(v.recoveryAssignmentId)); present("recoveryAssignments", v.seriesKey); present("assignments", v.recoveryAssignmentId);
        anchors.add(JSON.stringify([v.seriesKey, v.recoveryAssignmentId]));
      }
    }
    for (const g of p.loaded.grants) this.#check(p.participants.some(v => g === v.personId + "/" + v.assignmentId));
    for (const s of p.loaded.series) this.#check(p.participants.some(v => v.seriesKey === s));
    this.#check(setEqual([...anchors], e.recoveryAnchors.keys.map(v => JSON.stringify(v))));
    for (const s of b.currentSeries) this.#check(p.participants.some(v => v.personId === this.input.scope.studentId && v.assignmentId === s.assignmentId && v.currentAttemptId === s.attemptId));
    // No peer person locks are added here. Their participating writes serialize
    // under the GLOBAL demo fence; internal peer read privileges are still OPEN.
    const lower = resources([
      ...assignments.map(key => ({ kind: "assignment" as const, key })),
      ...assignments.map(key => ({ kind: "gate" as const, key })),
      ...p.loaded.series.map(key => ({ kind: "series" as const, key })),
      ...p.loaded.attempts.map(key => ({ kind: "attempt" as const, key })),
    ]);
    this.#plan = copy([...this.#plan, ...lower]); this.#projection = copy(p);
    this.#minimumVersion = p.read.snapshotVersion; this.#waitEpoch++;
    this.#lastOrdinal = this.#ledger.note(this.input.transactionId, "projection.loaded"); this.#phase = "projection";
  }
  /** FINAL post-wait mapping/liveness/rights/clock frame. Synchronous: no port
   * awaits occur from here through enterGuard. H is current affinity; neither
   * all_groups for Teacher nor original G alone establishes H visibility. */
  seal(frame: FreshFrame): ProtectionReceipt {
    try {
    this.#check(this.#phase === "projection" && this.#held && this.#acquired === this.#plan.length); this.#binding(frame);
    this.#check(this.#ledger.authenticFrame(frame) && frame.issuedOrdinal > this.#lastOrdinal && frame.issuedOrdinal === this.#ledger.lastOrdinal(this.input.transactionId) &&
      frame.snapshotVersion === this.#ledger.version && frame.snapshotVersion === this.#minimumVersion &&
      this.#projection!.read.snapshotVersion === this.#minimumVersion &&
      id(frame.frameId) && frame.waitEpoch === this.#waitEpoch && integer(frame.now) && frame.now <= 8_640_000_000_000_000 &&
      integer(frame.providerExpiresAt));
    // Preserve accepted final-frame invariant/expiry precedence before authority.
    if (frame.now >= frame.providerExpiresAt) fail("STAFF_TOKEN_INVALID", 401);
    const staff = currentStaff({ staff: frame.staff }, frame.proof, frame.now);
    this.#check(staff.personId === this.input.scope.actorId);
    requireRemovalAuthority(staff, this.input.scope.groupId);
    this.#check(frame.scope && id(frame.scope.affinityGroupId));
    requireRemovalAuthority(staff, frame.scope.affinityGroupId);
    this.#check(setEqual(Object.keys(frame.scope), Object.keys(this.input.scope)) &&
      Object.entries(this.input.scope).every(([k,v]) => frame.scope[k as keyof Scope] === v));
    this.#check(this.#projection!.rows.staff.present.includes(frame.proof.subject));
    strings(frame.affectedAssignmentIds);
    const protectedIds = this.#projection!.enumerations.protectedAssignments.keys;
    this.#check(frame.affectedAssignmentIds.every(k => protectedIds.includes(k)));
    this.#receipt = copy({ version: "r1-protection-local-v1", transactionId: this.input.transactionId,
      protectionId: this.input.protectionId, frameId: frame.frameId, scope: this.input.scope,
      lockedPersonIds: sorted(this.input.personIds), demoFenceIds: this.#plan.filter(r => r.kind === "demo").map(r => r.key),
      targetBindingDigest: this.targetBindingDigest, bindingRead: this.#bindingRead!, projectionRead: this.#projection!.read,
      enumerations: this.#projection!.enumerations, rows: this.#projection!.rows,
      protectedAssignmentIds: sorted(protectedIds), affectedAssignmentIds: sorted(frame.affectedAssignmentIds),
      waitEpoch: this.#waitEpoch, now: frame.now, resourcePlan: this.#plan });
    this.#lastOrdinal = this.#ledger.note(this.input.transactionId, "seal");
    this.#phase = "sealed"; return this.#receipt;
    } catch (error) { this.#phase = "failed"; throw error; }
  }
  revalidate(receipt: ProtectionReceipt, binding: { transactionId: string; protectionId: string; frameId: string }): void {
    this.#check(this.#held && ["sealed", "guard", "flush", "callback_returned", "commit_pending"].includes(this.#phase));
    this.#binding(binding);
    this.#check(receipt === this.#receipt && binding.frameId === receipt.frameId && receipt.waitEpoch === this.#waitEpoch &&
      this.#minimumVersion === this.#ledger.version && this.#lastOrdinal === this.#ledger.lastOrdinal(this.input.transactionId) && this.#plan.every(r => this.#ledger.owns(this.input.transactionId, r)));
  }
  enterGuard(receipt: ProtectionReceipt): void {
    this.#check(this.#phase === "sealed"); this.revalidate(receipt, receipt); this.#phase = "guard"; this.#lastOrdinal = this.#ledger.note(this.input.transactionId, "modeled.guard");
  }
  beginFlush(receipt: ProtectionReceipt): void {
    this.#check(this.#phase === "guard"); this.revalidate(receipt, receipt); this.#phase = "flush"; this.#lastOrdinal = this.#ledger.note(this.input.transactionId, "modeled.flush");
  }
  callbackReturned(receipt: ProtectionReceipt): void {
    this.#check(this.#phase === "guard" || this.#phase === "flush"); this.revalidate(receipt, receipt); this.#phase = "callback_returned"; this.#lastOrdinal = this.#ledger.note(this.input.transactionId, "callback.return");
  }
  beginCommit(): void {
    this.#check(this.#phase === "callback_returned");
    // Callback return is not the COMMIT boundary; reject intervening work.
    this.revalidate(this.#receipt!, this.#receipt!);
    this.#phase = "commit_pending";
  }
  commitAcknowledged(): void { this.#check(this.#phase === "commit_pending" && this.#held && this.#plan.every(r => this.#ledger.owns(this.input.transactionId, r))); this.#phase = "commit_ack"; }
  commitAcknowledgementLost(): Readonly<{ outcome: "commit_unknown"; status: 503; automaticMutationRetry: false }> {
    this.#check(this.#phase === "commit_pending" && this.#held); this.#phase = "commit_unknown";
    return Object.freeze({ outcome: "commit_unknown", status: 503, automaticMutationRetry: false });
  }
  beginRollback(originalError: unknown): void {
    this.#check(this.#held && !["commit_pending", "commit_ack", "commit_unknown", "rollback_pending", "rollback_ack", "rollback_unknown", "discarded", "released"].includes(this.#phase));
    this.#originalError = originalError; this.#phase = "rollback_pending";
  }
  rollbackAcknowledged(): unknown {
    this.#check(this.#phase === "rollback_pending" && this.#held); this.#phase = "rollback_ack"; return this.#originalError;
  }
  rollbackAcknowledgementLost(): unknown {
    this.#check(this.#phase === "rollback_pending" && this.#held); this.#phase = "rollback_unknown";
    return this.#originalError; // Not commit_unknown; preserve the driver's original error identity/mapping.
  }
  discard(): void {
    this.#check(this.#held && ["commit_unknown", "rollback_unknown"].includes(this.#phase));
    this.#phase = "discarded"; this.#held = false; this.#ledger.end(this.input.transactionId, "discard.unknown");
  }
  release(): void {
    this.#check(this.#held && ["commit_ack", "rollback_ack"].includes(this.#phase));
    this.#ledger.end(this.input.transactionId, this.#phase === "commit_ack" ? "commit.ack" : "rollback.ack");
    this.#held = false; this.#phase = "released";
  }
}

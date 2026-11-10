import { fail } from "./fault.ts";
import { guardRemovalActiveTest, guardRosterRemovalActiveTest, REMOVAL_DECISION } from "./membership-activity.ts";
import type { RemovalActiveTestOutcome } from "./membership-activity.ts";
import { currentStaff, groupScope, requireRosterAuthority } from "./staff-state.ts";
import { StorageUnavailable } from "./storage/postgres-transaction.ts";
import { expiryDelta, immutable, invariant, record, revision, text, validateCoverage } from "./storage/membership-preflight-port.ts";
import type { LocalMembershipPreflightPort, PreflightCommand, Protection, VerifiedActor } from "./storage/membership-preflight-port.ts";
import { requireRemovalAuthority } from "./removal-authority.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function command(value: unknown): PreflightCommand {
  if (!record(value)) fail("VALIDATION_ERROR", 422);
  const names = ["credential", "studentId", "groupId", "expectedGroupRevision", "expectedMembershipRevision"];
  const own = Reflect.ownKeys(value);
  if (own.length !== names.length || own.some(k => typeof k !== "string" || !names.includes(k))) fail("VALIDATION_ERROR", 422);
  for (const name of names) if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, name) ?? {}, "value")) fail("VALIDATION_ERROR", 422);
  if (typeof value.credential !== "string" || !value.credential.length || value.credential.length > 16384 ||
      typeof value.studentId !== "string" || !uuid.test(value.studentId) || typeof value.groupId !== "string" || !uuid.test(value.groupId) ||
      !revision(value.expectedGroupRevision) || !revision(value.expectedMembershipRevision)) fail("VALIDATION_ERROR", 422);
  return Object.freeze({ credential: value.credential, studentId: value.studentId.toLowerCase(), groupId: value.groupId.toLowerCase(),
    expectedGroupRevision: value.expectedGroupRevision, expectedMembershipRevision: value.expectedMembershipRevision });
}
function actor(value: VerifiedActor): VerifiedActor {
  invariant(record(value) && typeof value.actorId === "string" && uuid.test(value.actorId) && record(value.proof));
  const p = value.proof;
  invariant(p.kind === "staff_verified" && text(p.subject) && revision(p.notBefore) && revision(p.expiresAt) && p.expiresAt > p.notBefore);
  return immutable({ actorId: value.actorId.toLowerCase(), proof: { ...p } });
}
function outcome(value: RemovalActiveTestOutcome): RemovalActiveTestOutcome {
  if (value === REMOVAL_DECISION.CONTINUE || value === REMOVAL_DECISION.DENY_GROUP_REVISION || value === REMOVAL_DECISION.DENY_MEMBERSHIP_REVISION) return value;
  invariant(record(value) && Object.keys(value).length === 1 && value.kind === "wait_for_active_test");
  return Object.freeze({ kind: "wait_for_active_test" });
}

/** Local contract composition ONLY. No SQL implementation, production default,
 * HTTP route, Teacher expansion, final removal or unstarted-recovery revocation.
 * Port attestations are trusted obligations, not real DB completeness/locks. */
export function createMembershipPreflight(options: { mode?: unknown; port?: LocalMembershipPreflightPort } = {}) {
  return createPreflight(options, false);
}

/** Local removal-specific entry; does not implement final removal or transfer. */
export function createRosterRemovalPreflight(options: { mode?: unknown; port?: LocalMembershipPreflightPort } = {}) {
  return createPreflight(options, true);
}

function createPreflight(options: { mode?: unknown; port?: LocalMembershipPreflightPort }, rosterRemoval: boolean) {
  const p = options?.port;
  if (options?.mode !== "local_contract" || typeof p?.verifyAndLocate !== "function" || typeof p.transaction !== "function") fail("SERVICE_UNAVAILABLE", 503);
  const verify = p.verifyAndLocate.bind(p), transaction = p.transaction.bind(p);
  return async (input: unknown): Promise<RemovalActiveTestOutcome> => {
    const c = command(input), verified = actor(await verify(c.credential));
    const { credential: _, ...rest } = c;
    const scope = Object.freeze(rest);
    let entered = false, transactionId: string | undefined, result: RemovalActiveTestOutcome | undefined;
    const ack = await transaction(verified, async tx => {
      invariant(!entered); entered = true;
      invariant(text(tx.transactionId) && text(tx.protectionId) && text(tx.frameId));
      if (typeof tx.prepareAndRefresh !== "function" || typeof tx.flushExpiry !== "function") fail("SERVICE_UNAVAILABLE", 503);
      const binding: Protection = Object.freeze({ transactionId: tx.transactionId, protectionId: tx.protectionId, frameId: tx.frameId });
      transactionId = binding.transactionId;
      const prepare = tx.prepareAndRefresh.bind(tx), flush = tx.flushExpiry.bind(tx);
      const frame = await prepare(verified, scope);
      // NO external awaited port operation between this final frame and guard.
      invariant(record(frame) && frame.transactionId === binding.transactionId && frame.protectionId === binding.protectionId && frame.frameId === binding.frameId);
      invariant(frame.actor?.actorId === verified.actorId && frame.actor.proof === verified.proof);
      invariant(revision(frame.now) && frame.now <= 8_640_000_000_000_000 && revision(frame.providerExpiresAt));
      if (frame.now >= frame.providerExpiresAt) fail("STAFF_TOKEN_INVALID", 401);
      invariant(record(frame.state) && record(frame.state.staff));
      const staff = currentStaff(frame.state, verified.proof, frame.now);
      invariant(staff.personId === verified.actorId);
      if (rosterRemoval) requireRemovalAuthority(staff, scope.groupId);
      else requireRosterAuthority(staff);
      if (!groupScope(staff, scope.groupId)) fail("NOT_FOUND", 404);
      validateCoverage(frame, binding, verified, scope);
      // Detach aliases before the only mutable domain computation. Neither the
      // caller nor flush receives this state or a general continuation writer.
      const state = structuredClone(frame.state), before = structuredClone(state), now = frame.now;
      const guard = rosterRemoval ? guardRosterRemovalActiveTest : guardRemovalActiveTest;
      const guarded = await guard({ state, now: () => now }, scope.studentId, REMOVAL_DECISION.CONTINUE,
        { proof: verified.proof, groupId: scope.groupId, expectedGroupRevision: scope.expectedGroupRevision, expectedMembershipRevision: scope.expectedMembershipRevision });
      result = outcome(guarded);
      const delta = expiryDelta(before, state, now, { ...binding, actorId: verified.actorId, studentId: scope.studentId, groupId: scope.groupId });
      if (delta.attempts.length || delta.series.length || delta.gates.length) {
        const reply: unknown = await flush(delta);
        invariant(reply === undefined); // Arbitrary409 is not a clean denial.
      }
      return result;
    });
    // An invalid post-transaction ACK cannot certify success OR rollback.
    if (!entered || !result || !ack || ack.transactionId !== transactionId || ack.value !== result) throw new StorageUnavailable("commit_unknown");
    return result;
  };
}

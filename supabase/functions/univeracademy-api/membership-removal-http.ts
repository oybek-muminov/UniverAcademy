import { ApiFault, fail } from "./fault.ts";
import { parseStaffJson } from "./staff-json.ts";
import { removeRosterMember } from "./membership-removal.ts";
import { requireRemovalAuthority } from "./removal-authority.ts";
import { currentStaff, STAFF_CONTRACT_SHA } from "./staff-state.ts";
import type { MemberWrite, StaffTransactions, VerifiedStaffProof } from "./staff-state.ts";

export type MembershipRemovalHttpDependencies = {
  mode?: unknown;
  transactions?: StaffTransactions;
  // Trusted server binding: signature/issuer/audience verification and canonical
  // identity mapping, never a proof/role supplied in the request body.
  verifyStaffToken?: (token: string) => Promise<VerifiedStaffProof>;
  contractSha?: string;
  validate?: (schema: string, value: unknown) => boolean;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Removal-only LOCAL composition of the existing route and domain command.
 * No registration, provider, default store or production fallback.
 * The trusted StaffTransactions port must supply complete protected state and
 * resolve ONLY after COMMIT ACK. This interface is not proof of SQL durability,
 * exhaustive projection, live provider liveness or stable writer protection. */
export function createMembershipRemovalHttpHandler(options: MembershipRemovalHttpDependencies = {}) {
  const store = options?.transactions;
  const valid = options?.mode === "local_contract" &&
    options.contractSha === STAFF_CONTRACT_SHA &&
    typeof store?.transaction === "function" &&
    typeof options.verifyStaffToken === "function" && typeof options.validate === "function";
  // Capture trusted composition once; HTTP input cannot select ports or policy.
  const transaction = valid ? store!.transaction.bind(store) : undefined;
  const verify = valid ? options.verifyStaffToken! : undefined;
  const validate = valid ? options.validate! : undefined;
  return async (request: Request): Promise<Response> => {
    const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
    const errorResponse = (code: string, status: number) => new Response(JSON.stringify({
      error: { code, message: code, request_id: crypto.randomUUID() },
    }), { status, headers });
    try {
      if (!transaction || !verify || !validate) fail("SERVICE_UNAVAILABLE", 503);
      const token = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
      if (!token) fail("STAFF_TOKEN_INVALID", 401);
      const proof = await verify(token);
      const url = new URL(request.url), raw = await request.text();
      const route = url.pathname.match(/^\/api\/v1\/admin\/groups\/([^/]+)\/members\/?$/);
      const outcome = await transaction(async tx => {
        // Fresh post-lock clock and current rights precede body/key/target detail.
        const now = tx.now();
        if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000)
          fail("SERVICE_UNAVAILABLE", 503);
        const staff = currentStaff(tx.state, proof, now);
        if (!route || request.method !== "PUT") fail("NOT_FOUND", 404);
        const groupId = route[1].toLowerCase();
        requireRemovalAuthority(staff, groupId);
        if (!uuid.test(groupId) || !tx.state.groups[groupId]) fail("NOT_FOUND", 404);
        let parsed: unknown;
        try { parsed = parseStaffJson(raw); } catch (error) {
          if (error instanceof ApiFault) throw error;
          fail("MALFORMED_JSON", 400);
        }
        if (validate("MemberWrite", parsed) !== true) fail("VALIDATION_ERROR", 422);
        const key = request.headers.get("idempotency-key");
        if (!key || key.length < 8 || key.length > 128) fail("VALIDATION_ERROR", 422);
        // The command owns status/replay/CAS/B semantics. In particular an active
        // payload may identify a conflicting old receipt but can never add here.
        const value = await removeRosterMember({ state: tx.state, now: () => now },
          proof, groupId, parsed as MemberWrite, key);
        if ((value.kind === "removed" || value.kind === "replayed") &&
            validate("MembershipMutation", value.membership) !== true)
          fail("RESPONSE_INVARIANT_FAILED", 500);
        // Returned denials commit only accepted canonical maintenance. Exceptions
        // abort. Do not render a Response or throw a clean denial in this callback.
        return value;
      });
      // A resolved trusted transaction Promise is the local ACK boundary.
      // A rejected/unknown COMMIT is never retried or described as rollback here.
      if (outcome.kind === "denied") return errorResponse(outcome.code, 409);
      if (outcome.kind === "wait_for_active_test") return errorResponse("ACTIVE_EXAM_OR_RECOVERY", 409);
      if (outcome.kind !== "removed" && outcome.kind !== "replayed") fail("RESPONSE_INVARIANT_FAILED", 500);
      return new Response(JSON.stringify({ data: outcome.membership }), { status: 200, headers });
    } catch (error) {
      // A thrown ApiFault retains its wire mapping, including 409. It is still a
      // technical exception, not a returned clean-denial/commit outcome. The port
      // rethrows the original error after rollback ACK loss; this handler cannot
      // infer confirmed rollback or rename that uncertainty as commit_unknown.
      const fault = error instanceof ApiFault ? error : new ApiFault("INTERNAL_ERROR", 500);
      return errorResponse(fault.code, fault.status);
    }
  };
}

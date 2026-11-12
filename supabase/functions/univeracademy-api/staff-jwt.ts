import type { JWTVerifyGetKey } from "jose";
import { fail } from "./fault.ts";
import { currentStaff } from "./staff-state.ts";
import type { StaffState, VerifiedStaffProof } from "./staff-state.ts";
import type { LockedTransaction } from "./storage/postgres-transaction.ts";

export type StaffJwtProof = VerifiedStaffProof & { issuer: string; providerSessionId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createStaffJwtVerifier(config: { issuer: string; audience: string;
  algorithms: ("RS256" | "ES256")[]; trustedKeys: JWTVerifyGetKey; now: () => number }) {
  if (!config || !config.issuer.startsWith("https://") || !config.audience || !config.algorithms.length ||
      config.algorithms.some((a) => a !== "RS256" && a !== "ES256") ||
      typeof config.trustedKeys !== "function" || typeof config.now !== "function") fail("SERVICE_UNAVAILABLE", 503);
  return async (token: string): Promise<StaffJwtProof> => {
    let jose;
    try { jose=await import("jose"); } catch { fail("SERVICE_UNAVAILABLE",503); }
    const {jwtVerify,errors}=jose;
    const now = config.now();
    if (!Number.isSafeInteger(now) || now < 0) fail("SERVICE_UNAVAILABLE", 503);
    let claims;
    try {
      claims = (await jwtVerify(token, config.trustedKeys, { issuer: config.issuer, audience: config.audience,
        algorithms: config.algorithms, requiredClaims: ["iss","aud","sub","iat","exp","session_id"],
        clockTolerance: 0, currentDate: new Date(now) })).payload;
    } catch (error) {
      if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid || error instanceof errors.JWKInvalid)
        fail("SERVICE_UNAVAILABLE", 503);
      if (error instanceof errors.JOSEError) fail("STAFF_TOKEN_INVALID", 401);
      fail("SERVICE_UNAVAILABLE", 503); // Trusted resolver availability error, not a valid token.
    }
    const seconds = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && Number.isSafeInteger(n * 1000);
    if (!claims.sub || !uuid.test(claims.sub) || typeof claims.session_id !== "string" || !uuid.test(claims.session_id) ||
        !seconds(claims.iat) || !seconds(claims.exp) || (claims.nbf !== undefined && !seconds(claims.nbf)) ||
        claims.exp <= claims.iat || claims.iat * 1000 > now || claims.role !== "authenticated" || claims.is_anonymous === true)
      fail("STAFF_TOKEN_INVALID", 401);
    return { kind: "staff_verified", subject: claims.sub.toLowerCase(), issuer: config.issuer,
      providerSessionId: claims.session_id.toLowerCase(),
      notBefore: Math.max(claims.iat, claims.nbf ?? claims.iat) * 1000, expiresAt: claims.exp * 1000 };
  };
}

export async function requireLiveStaff(tx: LockedTransaction, proof: StaffJwtProof, state: Pick<StaffState,"staff">,
  liveness: (args: { issuer: string; subject: string; sessionId: string; now: number;
    transaction: LockedTransaction }) => Promise<boolean>) {
  // Invoke only after locks/current identity mapping have loaded this subject's
  // authoritative state. No roles/capabilities/user_metadata are read from JWT.
  const staff = currentStaff(state, proof, tx.now);
  if (!tx.personIds.includes(staff.personId)) fail("NOT_FOUND", 404);
  if (typeof liveness !== "function") fail("SERVICE_UNAVAILABLE", 503);
  let live: boolean;
  try { live = await liveness({ issuer: proof.issuer, subject: proof.subject,
    sessionId: proof.providerSessionId, now: tx.now, transaction: tx }); }
  catch { fail("SERVICE_UNAVAILABLE", 503); }
  if (live !== true) fail("STAFF_TOKEN_INVALID", 401);
  return staff;
}

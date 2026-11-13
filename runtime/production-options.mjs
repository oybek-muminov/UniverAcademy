import { types } from "node:util";
import { ApiFault } from "../supabase/functions/univeracademy-api/fault.ts";
import { checkSessionPolicy } from "../supabase/functions/univeracademy-api/student-state.ts";
import { publicHttpsOrigin } from "./local-cors.mjs";

const unavailable = () => new ApiFault("SERVICE_UNAVAILABLE", 503);
const callable = value => typeof value === "function";

// Configuration is server-owned data, not a factory, Promise or accessor bag.
// Inspect descriptors without evaluating getters or a thenable's `then`.
function data(value, names) {
  if (!value || typeof value !== "object" || types.isProxy(value) || types.isPromise(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw unavailable();
  const copy = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !names.includes(key) || !Object.hasOwn(descriptor, "value")) throw unavailable();
    copy[key] = descriptor.value;
  }
  return copy;
}

function strings(value) {
  if (!Array.isArray(value) || types.isProxy(value) ||
      Reflect.ownKeys(value).some(key => key !== "length" &&
        (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) throw unavailable();
  const result = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string") throw unavailable();
    result.push(descriptor.value);
  }
  return result;
}

function poolPort(pool) {
  if (!pool || typeof pool !== "object" || types.isProxy(pool) || types.isPromise(pool)) throw unavailable();
  for (let owner = pool; owner; owner = Object.getPrototypeOf(owner)) {
    if (types.isProxy(owner)) throw unavailable();
    const descriptor = Object.getOwnPropertyDescriptor(owner, "connect");
    if (descriptor) {
      if (!Object.hasOwn(descriptor, "value") || !callable(descriptor.value)) throw unavailable();
      return pool; // Opaque prepared resource: do not invoke, clone or freeze it.
    }
  }
  throw unavailable();
}

function nativeStaff(value) {
  const staff = data(value, ["jwt", "resolvePersons", "liveness", "validate", "newAssignmentId", "domain", "load", "flush"]);
  const jwt = data(staff.jwt, ["issuer", "audience", "algorithms", "trustedKeys", "now"]);
  const algorithms = strings(jwt.algorithms);
  // Same parameter boundary as createStaffJwtVerifier; this does not resolve keys.
  if (typeof jwt.issuer !== "string" || !jwt.issuer.startsWith("https://") ||
      typeof jwt.audience !== "string" || !jwt.audience || !algorithms.length ||
      algorithms.some(value => !["RS256", "ES256"].includes(value)) ||
      !callable(jwt.trustedKeys) || !callable(jwt.now) ||
      !callable(staff.liveness) || !callable(staff.validate) || !callable(staff.newAssignmentId) ||
      (staff.resolvePersons !== undefined && !callable(staff.resolvePersons))) throw unavailable();
  if (staff.domain === "first_test_relational") {
    if (staff.load !== undefined || staff.flush !== undefined) throw unavailable();
  } else if (staff.domain !== undefined || !callable(staff.load) || !callable(staff.flush)) throw unavailable();
  return Object.freeze({ ...staff, jwt: Object.freeze({ ...jwt, algorithms: Object.freeze(algorithms) }) });
}

function clerkStaff(value) {
  const clerk = data(value, ["verifier", "liveness", "staff"]);
  const verifier = data(clerk.verifier, ["issuer", "authorizedParties", "audience", "trustedKeys", "now"]);
  const parties = strings(verifier.authorizedParties);
  if (typeof verifier.issuer !== "string") throw unavailable();
  publicHttpsOrigin(verifier.issuer);
  if (!parties.length || new Set(parties).size !== parties.length ||
      !callable(verifier.trustedKeys) || !callable(verifier.now) || !callable(clerk.liveness)) throw unavailable();
  for (const party of parties) publicHttpsOrigin(party);
  const audience = data(verifier.audience, ["kind", "value"]);
  if (!((audience.kind === "required" && typeof audience.value === "string" && audience.value.length && Object.keys(audience).length === 2) ||
      (audience.kind === "clerk_default_no_audience" && Object.keys(audience).length === 1))) throw unavailable();
  const staff = data(clerk.staff, ["validate", "newAssignmentId"]);
  if (!callable(staff.validate) || !callable(staff.newAssignmentId)) throw unavailable();
  return Object.freeze({ ...clerk, staff: Object.freeze(staff), verifier: Object.freeze({ ...verifier,
    audience: Object.freeze(audience), authorizedParties: Object.freeze(parties) }) });
}

/** Assemble server-only options for the existing Vercel Node factory.
 * All resources must ALREADY be prepared. Await async SDK/pool construction
 * outside this function; readOptions must return this value synchronously.
 * No environment reads, credentials/defaults, resource constructors, connection,
 * verification, provider calls or readiness probe are performed here.
 * Settings are copied; opaque pool/functions remain trusted server references.
 * Returned configuration contains private bindings: never serialize or log it.
 * Shape validation is not evidence of a real driver, TLS, SQL/RLS, live auth,
 * production policy approval or completed removal/protection integration.
 */
export function createProductionOptions(value) {
  try {
    const options = data(value, ["apiOrigin", "allowedOrigins", "configuration"]);
    if (typeof options.apiOrigin !== "string") throw unavailable();
    publicHttpsOrigin(options.apiOrigin);
    const origins = strings(options.allowedOrigins);
    for (const origin of origins) publicHttpsOrigin(origin);
    const config = data(options.configuration, ["mode", "storage", "botToken", "clerk", "sessionPolicy", "numericPresentation", "now", "staff"]);
    const storage = data(config.storage, ["kind", "pool"]);
    if (config.mode !== "production" || storage.kind !== "postgres" || !callable(config.now)) throw unavailable();
    const pool = poolPort(storage.pool);
    const policy = data(config.sessionPolicy, ["initDataMaxAgeSeconds", "futureSkewSeconds", "accessTtlMs", "familyTtlMs", "logoutTombstoneMs", "identityCollisionAttempts", "newLogin"]);
    checkSessionPolicy(policy); // Reuse the accepted one-device/value checks.
    const numbers = data(config.numericPresentation, ["policyId", "toFiniteNumber", "toDisplayString", "toStudentPointsDisplayString"]);
    if (typeof numbers.policyId !== "string" || !numbers.policyId ||
        ![numbers.toFiniteNumber, numbers.toDisplayString, numbers.toStudentPointsDisplayString].every(callable)) throw unavailable();
    if (config.clerk !== undefined) {
      if (config.staff !== undefined || (config.botToken !== undefined && (typeof config.botToken !== "string" || !config.botToken))) throw unavailable();
      config.clerk = clerkStaff(config.clerk);
    } else {
      if (typeof config.botToken !== "string" || !config.botToken) throw unavailable();
      config.staff = nativeStaff(config.staff);
    }
    return Object.freeze({ apiOrigin: options.apiOrigin, allowedOrigins: Object.freeze(origins),
      configuration: Object.freeze({ ...config, storage: Object.freeze({ kind: storage.kind, pool }),
        sessionPolicy: Object.freeze(policy), numericPresentation: Object.freeze(numbers) }) });
  } catch {
    throw unavailable(); // No caller value, secret, original exception or cause is echoed.
  }
}

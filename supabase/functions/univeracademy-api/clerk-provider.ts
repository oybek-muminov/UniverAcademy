import { createRemoteJWKSet, customFetch } from "jose";
import { ApiFault, fail } from "./fault.ts";
import { createClerkVerifier } from "./clerk-auth.ts";
import type { ClerkIdentity, ClerkLiveness, ClerkVerifierConfiguration } from "./clerk-auth.ts";

export type ClerkProviderSettings = {
  issuer: string;
  authorizedParties: readonly string[];
  audience: ClerkVerifierConfiguration["audience"];
  jwksCacheMs: number;
  jwksCooldownMs: number;
  timeoutMs: number;
  maxJwksBytes: number;
};
// Trusted server bindings only. SDK models use camelCase, not raw REST fields.
// Reads must be uncached; the optional signal must reach the SDK transport for
// cooperative cancellation. No SDK, key/secret loading or native-fetch fallback.
export type ClerkProviderBindings = {
  now(): number;
  fetchJwks(request: Request): Promise<Response>;
  getSession(id: string, options: { signal: AbortSignal }): Promise<unknown>;
  getUser(id: string, options: { signal: AbortSignal }): Promise<unknown>;
};
const unavailable = () => new ApiFault("SERVICE_UNAVAILABLE", 503);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const stamp = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const id = (v: unknown, prefix: "user" | "sess"): v is string =>
  typeof v === "string" && new RegExp("^" + prefix + "_[A-Za-z0-9]+(?![\\s\\S])").test(v);
function origin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.origin === value && u.protocol === "https:" && !u.hostname.includes("*") &&
      !["localhost", "[::1]", "[::]", "0.0.0.0"].includes(u.hostname) &&
      !u.hostname.endsWith(".localhost") && !/^127\./.test(u.hostname);
  } catch { return false; }
}
function settings(value: unknown): ClerkProviderSettings {
  if (!object(value) || !origin(value.issuer) || !Array.isArray(value.authorizedParties) ||
      !value.authorizedParties.length || !value.authorizedParties.every(origin) ||
      new Set(value.authorizedParties).size !== value.authorizedParties.length || !object(value.audience)) throw unavailable();
  const a = value.audience;
  if (!((a.kind === "required" && typeof a.value === "string" && a.value.length > 0 && Object.keys(a).length === 2) ||
        (a.kind === "clerk_default_no_audience" && Object.keys(a).length === 1))) throw unavailable();
  for (const key of ["jwksCacheMs", "jwksCooldownMs", "timeoutMs", "maxJwksBytes"])
    if (!stamp(value[key])) throw unavailable();
  if (value.timeoutMs === 0 || value.maxJwksBytes === 0 ||
      (value.timeoutMs as number) > 2_147_483_647 || (value.maxJwksBytes as number) > 1_048_576 ||
      (value.jwksCooldownMs as number) > (value.jwksCacheMs as number)) throw unavailable();
  if (Object.keys(value).some(k => !["issuer", "authorizedParties", "audience", "jwksCacheMs", "jwksCooldownMs", "timeoutMs", "maxJwksBytes"].includes(k))) throw unavailable();
  return Object.freeze({ ...value, authorizedParties: Object.freeze([...value.authorizedParties]), audience: Object.freeze({ ...a }) }) as ClerkProviderSettings;
}

export function readClerkProductionAuthSettings(environment: Readonly<Record<string, string | undefined>>): ClerkProviderSettings {
  try { return settings(JSON.parse(environment.UA_CLERK_PROVIDER_SETTINGS!)); }
  catch { throw unavailable(); } // Never echo configuration or credential text.
}

async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, resourceRead = false, parent?:AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort:()=>void=()=>{};
  try {
    const cancelled=new Promise<never>((_,reject)=>{
      abort=()=>{controller.abort();reject(unavailable());};
      parent?.addEventListener("abort",abort,{once:true});timer=setTimeout(abort,ms);if(parent?.aborted)abort();
    });
    return await Promise.race([cancelled,Promise.resolve().then(() => {if(controller.signal.aborted)throw unavailable();return work(controller.signal);})]);
  } catch (error) {
    if (resourceRead && object(error) && error.status === 404) fail("CLERK_SESSION_REVOKED", 401);
    throw unavailable();
  } finally { clearTimeout(timer);parent?.removeEventListener("abort",abort); }
}
async function publicJwks(response: Response, limit: number, signal: AbortSignal): Promise<Response> {
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw unavailable();
  const length = response.headers.get("content-length");
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > limit)) throw unavailable();
  if (!response.body) throw unavailable();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const stop = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw unavailable();
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { stop(); throw unavailable(); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener("abort", stop); reader.releaseLock(); }
  const raw = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { throw unavailable(); }
  if (!object(parsed) || !Array.isArray(parsed.keys) || !parsed.keys.length ||
      parsed.keys.some(k => !object(k) || ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(p => Object.hasOwn(k, p)))) throw unavailable();
  // jose retains responsibility for key structure/selection/import and signature.
  return new Response(JSON.stringify(parsed), { status: 200, headers: { "content-type": "application/json" } });
}

/** Production auth configuration candidate only, not a durable HTTP bootstrap. */
export function createClerkProviderAdapter(input: ClerkProviderSettings, bindings: ClerkProviderBindings): {
  verifier: ClerkVerifierConfiguration; liveness: ClerkLiveness;
} {
  const c = settings(input);
  if (!bindings || [bindings.now, bindings.fetchJwks, bindings.getSession, bindings.getUser].some(v => typeof v !== "function")) throw unavailable();
  const clock = () => { const n = bindings.now(); if (!stamp(n)) throw unavailable(); return n; };
  const jwksUrl = c.issuer + "/.well-known/jwks.json";
  const trustedKeys = createRemoteJWKSet(new URL(jwksUrl), {
    cacheMaxAge: c.jwksCacheMs, cooldownDuration: c.jwksCooldownMs, timeoutDuration: c.timeoutMs,
    [customFetch]: (url, options) => bounded(async signal => {
      if (url !== jwksUrl || options.method !== "GET") throw unavailable();
      const combined = AbortSignal.any([signal, options.signal]);
      const response = await bindings.fetchJwks(new Request(jwksUrl, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store",
        headers: { accept: "application/json" }, signal: combined }));
      if (response.url && response.url !== jwksUrl) throw unavailable();
      return publicJwks(response, c.maxJwksBytes, combined);
    }, c.timeoutMs),
  });
  const verifier: ClerkVerifierConfiguration = Object.freeze({ issuer: c.issuer, authorizedParties: c.authorizedParties,
    audience: c.audience, trustedKeys, now: clock });
  createClerkVerifier(verifier); // Eager shape validation, no network request.
  const liveness: ClerkLiveness = async (identity: ClerkIdentity, at: number, options) => {
    if (identity.issuer !== c.issuer || !id(identity.userId, "user") || !id(identity.sessionId, "sess")) fail("CLERK_TOKEN_INVALID", 401);
    if (!stamp(at)) throw unavailable();
    const denied = () => ({ ...identity, status: "revoked", accountEnabled: false, expiresAt: 0 });
    try {
      const session = await bounded(signal => bindings.getSession(identity.sessionId, { signal }), c.timeoutMs, true,options?.signal);
      if (!object(session) || !id(session.id, "sess") || !id(session.userId, "user") || typeof session.status !== "string" ||
          !stamp(session.expireAt) || !stamp(session.abandonAt) || !Object.hasOwn(session, "actor")) throw unavailable();
      if (session.id !== identity.sessionId || session.userId !== identity.userId || session.status !== "active" || session.actor !== null) return denied();
      const user = await bounded(signal => bindings.getUser(identity.userId, { signal }), c.timeoutMs, true,options?.signal);
      const now = clock(); if (now < at) throw unavailable();
      // Revalidate both returned models after the final await and clock read.
      // A mutable SDK model must not retain an earlier active-state decision.
      if (!id(session.id, "sess") || !id(session.userId, "user") || typeof session.status !== "string" ||
          !stamp(session.expireAt) || !stamp(session.abandonAt) || !Object.hasOwn(session, "actor")) throw unavailable();
      if (session.id !== identity.sessionId || session.userId !== identity.userId || session.status !== "active" || session.actor !== null) return denied();
      if (!object(user) || !id(user.id, "user") || typeof user.banned !== "boolean" ||
          typeof user.locked !== "boolean" || typeof user.deprovisioned !== "boolean") throw unavailable();
      if (user.id !== identity.userId) return denied();
      const expiresAt = Math.min(session.expireAt, session.abandonAt);
      if (now >= expiresAt) return denied();
      const accountEnabled=!user.banned&&!user.locked&&!user.deprovisioned;
      const names=accountEnabled?{firstName:user.firstName,lastName:user.lastName}:{firstName:null,lastName:null};
      return { ...identity, status: "active", accountEnabled, expiresAt, ...names };
    } catch (error) {
      // requireLiveClerk owns the final401 denial; it maps thrown read faults503.
      if (error instanceof ApiFault && error.status === 401) return denied();
      throw error;
    }
  };
  return { verifier, liveness };
}

import type { components } from "./student-types.d.ts";

type Schema = components["schemas"];
export type StudentSchema = Schema;
export const STUDENT_CONTRACT_SHA256 = "430a2be52599c46f49ef1263ff579cd5c993954f62b7a37fd1a10814c8d05455";
// The preceding production build input is supported only by the Mini App release gate.
export const PREVIOUS_STUDENT_CONTRACT_SHA256 = "2eab3a7848b8fc439ca73e3e4d768b8706ec80f3063dbd3eeaf6d4966249918c";
export const STUDENT_PROFILE_ACCEPT = "application/json; profile=univeracademy-id-v2";
export const STUDENT_CONTRACT_VERSION = "0.3.2-univeracademy-id.1";
export const STUDENT_CONTRACT_REVIEW_STATUS = "PROVISIONAL / NOT ACCEPTED";

export class StudentClientProtocolError extends Error {
  constructor(code: string) { super(code); this.name = "StudentClientProtocolError"; }
}
export class StudentApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  constructor(status: number, code: string, requestId: string) {
    // Do not echo a raw response body, proof, URL or arbitrary server message into logs.
    super(code);
    this.name = "StudentApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

function invalidResponse(): never { throw new StudentClientProtocolError("CLIENT_INVALID_RESPONSE"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalidResponse();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) invalidResponse();
}
const uuid = (v: unknown): v is string => typeof v === "string" && v.length === 36 &&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
const utc = (v: unknown): v is string => typeof v === "string" && v.endsWith("Z") && Number.isFinite(Date.parse(v));

function currentProfileFormat(contentType: string | null): boolean {
  const [media, ...parameters] = (contentType ?? "").split(";");
  if (media.trim().toLowerCase() !== "application/json") return invalidResponse();
  let versioned = false;
  for (const parameter of parameters) {
    const index = parameter.indexOf("=");
    const name = (index < 0 ? parameter : parameter.slice(0,index)).trim().toLowerCase();
    if (name !== "profile") continue;
    const value = parameter.slice(index + 1).trim();
    if (versioned || (value !== "univeracademy-id-v2" && value !== '"univeracademy-id-v2"')) return invalidResponse();
    versioned = true;
  }
  return versioned;
}

// Old Workers ignore the client's Accept profile and return ordinary JSON. Normalize
// only their ID field, after verifying the exact Profile, before it leaves this client.
function decodeProfile(value: unknown, contentType: string | null): Schema["Profile"] {
  const profile = record(value);
  const legacy = Object.hasOwn(profile, "qadam_id");
  if (currentProfileFormat(contentType) && legacy) return invalidResponse();
  const idKey = legacy ? "qadam_id" : "univeracademy_id";
  exactKeys(profile, ["person_id","first_name","last_name","registration_complete","roles","active_group_id",idKey]);
  const id = profile[idKey];
  const roles = profile.roles;
  if (!uuid(profile.person_id) || typeof profile.first_name !== "string" || typeof profile.last_name !== "string" ||
      typeof profile.registration_complete !== "boolean" || !(profile.active_group_id === null || uuid(profile.active_group_id)) ||
      !Array.isArray(roles) || roles.some(role => !["student","teacher","admin","owner"].includes(role)) ||
      (roles.includes("student") ? typeof id !== "string" || id.length !== 10 || !/^[0-9]{10}$/.test(id) : id !== null)) {
    return invalidResponse();
  }
  const { [idKey]: displayId, ...fields } = profile;
  return { ...fields, univeracademy_id: displayId } as Schema["Profile"];
}

function decodeProfileResponse(value: unknown, contentType: string | null): Schema["SuccessProfile"] {
  const envelope = record(value);
  exactKeys(envelope, ["data"]);
  return { data: decodeProfile(envelope.data, contentType) };
}

export function decodeStudentSession(value: unknown, contentType: string | null): Schema["SuccessSession"] {
  const envelope = record(value);
  exactKeys(envelope, ["data"]);
  const session = record(envelope.data);
  exactKeys(session, ["access_token","refresh_token","expires_at","refresh_expires_at","token_type","profile"]);
  if (session.token_type !== "Bearer" || typeof session.access_token !== "string" ||
      typeof session.refresh_token !== "string" || !session.access_token || !session.refresh_token ||
      session.access_token === session.refresh_token || !utc(session.expires_at) || !utc(session.refresh_expires_at)) return invalidResponse();
  return {data: {
    token_type: "Bearer", access_token: session.access_token, refresh_token: session.refresh_token,
    expires_at: session.expires_at, refresh_expires_at: session.refresh_expires_at,
    profile: decodeProfile(session.profile, contentType),
  }};
}

export type LocalStudentClientOptions = {
  mode: "local_fixture";
  contractSha256: string;
  baseUrl: string;
  transport(request: Request): Promise<Response>;
};

export type ProductionStudentClientOptions = {
  mode: "production";
  contractSha256: string;
  baseUrl: string;
  transport(request: Request): Promise<Response>;
};
export type StudentClient = ReturnType<typeof buildStudentClient>;

// Both constructors use the same operations and wire/error/refresh behavior.
// No native-fetch fallback, secret loading, session storage or automatic retry.
export function createLocalStudentClient(options: LocalStudentClientOptions) {
  if (options.mode !== "local_fixture") throw new StudentClientProtocolError("DRAFT_CLIENT_LOCAL_ONLY");
  if (options.contractSha256 !== STUDENT_CONTRACT_SHA256) {
    throw new StudentClientProtocolError("CONTRACT_HASH_MISMATCH");
  }
  let base: URL;
  try { base = new URL(options.baseUrl); }
  catch { throw new StudentClientProtocolError("INVALID_LOCAL_BASE_URL"); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash ||
    !["127.0.0.1", "localhost", "[::1]", "local.invalid"].includes(base.hostname) ||
    base.pathname.replace(/\/$/, "") !== "/api/v1" || typeof options.transport !== "function") {
    throw new StudentClientProtocolError("INVALID_LOCAL_BASE_URL");
  }
  return buildStudentClient(`${base.origin}/api/v1`, options.transport, false);
}

export function createProductionStudentClient(options: ProductionStudentClientOptions): StudentClient {
  if (options?.mode !== "production") throw new StudentClientProtocolError("PRODUCTION_CLIENT_MODE_REQUIRED");
  if (options.contractSha256 !== STUDENT_CONTRACT_SHA256) throw new StudentClientProtocolError("CONTRACT_HASH_MISMATCH");
  let base: URL;
  try { base = new URL(options.baseUrl); } catch { throw new StudentClientProtocolError("INVALID_PRODUCTION_BASE_URL"); }
  const host = base.hostname;
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash ||
      base.pathname.replace(/\/$/, "") !== "/api/v1" || typeof options.transport !== "function" ||
      host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127\./.test(host) ||
      host === "0.0.0.0" || host === "[::]" || host.endsWith(".invalid") || host === "invalid")
    throw new StudentClientProtocolError("INVALID_PRODUCTION_BASE_URL");
  return buildStudentClient(`${base.origin}/api/v1`, options.transport, true);
}

function buildStudentClient(root: string, transport: (request: Request) => Promise<Response>, production: boolean) {
  async function send<T>(method: string, path: string,
    args: { accessToken?: string; body?: unknown; idempotencyKey?: string } = {},
    decode?: (value: unknown, contentType: string | null) => T): Promise<T> {
    const headers = new Headers({ accept: STUDENT_PROFILE_ACCEPT });
    if (args.accessToken) headers.set("authorization", `Bearer ${args.accessToken}`);
    if (args.idempotencyKey !== undefined) headers.set("idempotency-key", args.idempotencyKey);
    if (args.body !== undefined) headers.set("content-type", "application/json");
    const response = await transport(new Request(root + path, { method, headers,
      ...(production ? { redirect: "error" as const, credentials: "omit" as const, cache: "no-store" as const } : {}),
      body: args.body === undefined ? undefined : JSON.stringify(args.body) }));
    let value: unknown;
    try { value = await response.json(); }
    catch { throw new StudentClientProtocolError("CLIENT_INVALID_RESPONSE"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new StudentClientProtocolError("CLIENT_INVALID_RESPONSE");
    }
    const envelope = value as Record<string, unknown>;
    if (!response.ok) {
      const error = envelope.error;
      if (!error || typeof error !== "object" || Array.isArray(error)) {
        throw new StudentClientProtocolError("CLIENT_INVALID_RESPONSE");
      }
      const e = error as Record<string, unknown>;
      if (typeof e.code !== "string" || !/^[A-Z0-9_]+$/.test(e.code) || typeof e.request_id !== "string") {
        throw new StudentClientProtocolError("CLIENT_INVALID_RESPONSE");
      }
      throw new StudentApiError(response.status, e.code, e.request_id);
    }
    if (!Object.hasOwn(envelope, "data") || Object.hasOwn(envelope, "error")) {
      throw new StudentClientProtocolError("CLIENT_INVALID_RESPONSE");
    }
    // Generated types are not a full runtime JSON Schema validator. The local server
    // response suite separately validates pinned schemas; do not infer API acceptance.
    return decode ? decode(value, response.headers.get("content-type")) : value as T;
  }
  // New proof operations accept only their exact own data field; never read
  // caller identity extras or getters, cache a Clerk JWT, or retry a launch.
  function telegramInput(input: unknown): { init_data: string } {
    if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
        Reflect.ownKeys(input).length !== 1 || !Object.hasOwn(input, "init_data"))
      throw new StudentClientProtocolError("INVALID_TELEGRAM_REQUEST");
    const field = Object.getOwnPropertyDescriptor(input, "init_data");
    if (!field || !Object.hasOwn(field, "value") || typeof field.value !== "string" ||
        field.value.length === 0 || field.value.length > 16384)
      throw new StudentClientProtocolError("INVALID_TELEGRAM_REQUEST");
    return { init_data: field.value };
  }
  const part = encodeURIComponent;
  const pendingRefresh = new Map<string, Promise<Schema["SuccessSession"]>>();
  const attemptedRefresh = new Set<string>();
  return {
    // Review candidate only. Clerk JWT is exchanged once; opaque app proofs are
    // used for me/exams/refresh. Never persist this JWT or put it in a URL.
    exchangeClerkSession: (clerkSessionToken: string, input: Schema["ClerkExchangeRequest"] = {}) =>
      send<Schema["SuccessSession"]>("POST", "/auth/clerk", { accessToken: clerkSessionToken, body: input }, decodeStudentSession),
    async linkTelegramIdentity(clerkJwt: string, input: Schema["TelegramLinkRequest"]): Promise<Schema["SuccessAck"]> {
      const body = telegramInput(input);
      // Lexical JWT shape prevents accidental opaque-project-token transport.
      // Authentication, freshness and claim validation remain server-owned.
      if (typeof clerkJwt !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(clerkJwt))
        throw new StudentClientProtocolError("INVALID_CLERK_TOKEN");
      return send<Schema["SuccessAck"]>("POST", "/auth/telegram/link", { accessToken: clerkJwt, body });
    },
    async resumeTelegramSession(input: Schema["TelegramResumeRequest"]): Promise<Schema["SuccessSession"]> {
      return send<Schema["SuccessSession"]>("POST", "/auth/telegram/resume", { body: telegramInput(input) }, decodeStudentSession);
    },
    telegramLogin: (input: Schema["TelegramLogin"]) =>
      send<Schema["SuccessSession"]>("POST", "/auth/telegram", { body: input }, decodeStudentSession),
    refresh(input: Schema["Refresh"]): Promise<Schema["SuccessSession"]> {
      const proof = input.refresh_token, pending = pendingRefresh.get(proof);
      if (pending) return pending;
      if (attemptedRefresh.has(proof)) return Promise.reject(
        new StudentClientProtocolError("REFRESH_PROOF_ALREADY_ATTEMPTED"));
      attemptedRefresh.add(proof);
      const request = send<Schema["SuccessSession"]>("POST", "/auth/refresh", { body: input }, decodeStudentSession)
        .finally(() => pendingRefresh.delete(proof));
      pendingRefresh.set(proof, request);
      return request;
    },
    logout: (args: { accessToken?: string; body?: Schema["Logout"] } = {}) =>
      send<Schema["SuccessAck"]>("POST", "/auth/logout", args),
    // Explicit receipt-proof request: no Authorization header, fallback, or local-only ACK.
    logoutByRefresh: (input: Schema["Logout"]) =>
      send<Schema["SuccessAck"]>("POST", "/auth/logout", { body: input }),
    me: (accessToken: string) => send<Schema["SuccessProfile"]>("GET", "/me", { accessToken }, decodeProfileResponse),
    updateProfile: (accessToken: string, input: Schema["ProfileUpdate"]) =>
      send<Schema["SuccessProfile"]>("PATCH", "/me", { accessToken, body: input }, decodeProfileResponse),
    exams: (accessToken: string) => send<Schema["SuccessMetaList"]>("GET", "/exams", { accessToken }),
    exam: (accessToken: string, assignmentId: string) =>
      send<Schema["SuccessMeta"]>("GET", `/exams/${part(assignmentId)}`, { accessToken }),
    startAttempt: (accessToken: string, assignmentId: string, input: Schema["Start"], idempotencyKey: string) =>
      send<Schema["SuccessAttempt"]>("POST", `/exams/${part(assignmentId)}/attempts`,
        { accessToken, body: input, idempotencyKey }),
    resumeAttempt: (accessToken: string, attemptId: string) =>
      send<Schema["SuccessAttempt"]>("GET", `/attempts/${part(attemptId)}`, { accessToken }),
    saveAnswer: (accessToken: string, attemptId: string, questionId: string, input: Schema["SaveAnswer"]) =>
      send<Schema["SuccessAnswer"]>("PUT", `/attempts/${part(attemptId)}/answers/${part(questionId)}`,
        { accessToken, body: input }),
    submitAttempt: (accessToken: string, attemptId: string, idempotencyKey: string) =>
      send<Schema["SuccessStudentCompletedGradingResult"]>("POST", `/attempts/${part(attemptId)}/submit`,
        { accessToken, idempotencyKey }),
    result: (accessToken: string, attemptId: string) =>
      send<Schema["SuccessStudentGradingResult"]>("GET", `/attempts/${part(attemptId)}/result`, { accessToken }),
    history: (accessToken: string, assignmentId: string) =>
      send<Schema["SuccessHistory"]>("GET", `/exams/${part(assignmentId)}/history`, { accessToken }),
  };
}

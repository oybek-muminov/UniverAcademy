import { createHmac } from "node:crypto";
import { ApiFault } from "../../supabase/functions/univeracademy-api/fault.ts";
import { ratio } from "../../supabase/functions/univeracademy-api/ordinary.ts";
import { candidateHalfUp2, studentPointsHalfUp1 } from "../../supabase/functions/univeracademy-api/student-wire.ts";
import { createStudentHttpHandler } from "../../supabase/functions/univeracademy-api/student-http.ts";
import type { StudentHttpDependencies } from "../../supabase/functions/univeracademy-api/student-http.ts";
import type { StudentState, StudentTransactions, TransactionContext }
  from "../../supabase/functions/univeracademy-api/student-state.ts";

// Every identity, token/key, question and time here is synthetic. No network or DB.
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const ids = { person: id(1), other: id(2), assignment: id(10), demo: id(20),
  version: id(30), group: id(40), question: id(100), correct: id(200), wrong: id(201) };
export const clock = Date.UTC(2026, 10, 5, 12);
export const botKey = "local-only-synthetic-hmac-fixture";
export const testPolicy = {
  initDataMaxAgeSeconds: 120, futureSkewSeconds: 0,
  accessTtlMs: 15_000, familyTtlMs: 120_000, logoutTombstoneMs: 30_000,
  identityCollisionAttempts: 4, newLogin: "revoke_previous" as const,
};
export const testNumbers = { policyId: "TEST_ONLY_NOT_ACCEPTED_FOR_PRODUCTION",
  toFiniteNumber: (r: { numerator: bigint; denominator: bigint }) => Number(r.numerator) / Number(r.denominator),
  toDisplayString: candidateHalfUp2, toStudentPointsDisplayString: studentPointsHalfUp1 };

export function initialState(): StudentState {
  const questions = [0, 1].map((i) => ({ id: id(100 + i),
    optionIds: [0, 1, 2, 3].map((j) => id(200 + i * 4 + j)),
    correctOptionId: id(200 + i * 4), individualPoints: ratio(5n, 2n) }));
  const text = (markdown: string) => [{ type: "text", markdown }];
  return {
    people: {
      [ids.person]: { telegramId: 4_000_000_001, enabled: true, profile: {
        person_id: ids.person, first_name: "Sun’iy", last_name: "O‘quvchi", roles: ["student"],
        registration_complete: true, active_group_id: ids.group, qadam_id: "0100000001",
      } },
      [ids.other]: { telegramId: 4_000_000_002, enabled: true, profile: {
        person_id: ids.other, first_name: "Boshqa", last_name: "Sun’iy", roles: ["student"],
        registration_complete: true, active_group_id: null, qadam_id: "0100000002",
      } },
    }, families: {}, access: {}, refresh: {}, consumedInitData: {},
    grants: { [ids.person]: { [ids.assignment]: { rostered: true, membershipEpoch: 7, grantEpoch: 7 } } },
    assignments: { [ids.assignment]: {
      admission: { assignmentId: ids.assignment, groupId: ids.group, activeGroupId: ids.group,
        rostered: true, profileComplete: true, membershipEpoch: 7, grantEpoch: 7,
        opensAt: clock - 1000, closesAt: clock + 1000 },
      published: { demoId: ids.demo, versionId: ids.version, durationMs: 60_000,
        individualEnabled: false, questions },
      title: "Sun’iy fizika fixture", instructions: text("Faqat lokal sinov."),
      contents: Object.fromEntries(questions.map((q, i) => [q.id, {
        prompt: text(`Sun’iy savol ${i + 1}`),
        options: Object.fromEntries(q.optionIds.map((option, j) => [option, text(`Variant ${j + 1}`)])),
      }])),
      reviewGate: { id: id(50), status: "blocked", revision: 0, barrier_revision: 0,
        barrier_complete: false, eligible_unresolved_count: 1, active_count: 0,
        recovery_ready_count: 0, timezone: "Asia/Tashkent", first_opened_at: null,
        opens_at: null, closes_at: null }, cancelled: false,
    } }, series: {}, attempts: {}, receipts: {}, bonuses: {}, cancellations: {},
  };
}

export class TransactionFixture implements StudentTransactions {
  state = initialState();
  time = clock;
  events: string[] = [];
  beforeCommit: (() => Promise<void>) | null = null;
  failNextCommit = false;
  private tail = Promise.resolve();

  private readonly liveClock?: () => number;
  constructor(liveClock?: () => number) { this.liveClock = liveClock; }

  async transaction<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    // ponytail: one global fixture lock, not production locking or a load benchmark.
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    this.events.push("lock");
    try {
      const draft = structuredClone(this.state);
      const value = await work({ state: draft, now: () => {
        this.events.push("clock"); return this.liveClock ? this.liveClock() : this.time;
      } });
      if (this.beforeCommit) await this.beforeCommit();
      if (this.failNextCommit) {
        this.failNextCommit = false;
        throw new ApiFault("SERVICE_UNAVAILABLE", 503);
      }
      this.state = draft;
      this.events.push("commit");
      return value;
    } finally { release(); }
  }
}

export function signedInitData(telegramId = 4_000_000_001, queryId = "synthetic-login", at = clock) {
  const data = new URLSearchParams({ auth_date: String(Math.floor(at / 1000)), query_id: queryId,
    user: JSON.stringify({ id: telegramId, first_name: "Sun’iy", last_name: "Fixture" }) });
  const canonical = [...data.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${k}=${v}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update(botKey).digest();
  data.set("hash", createHmac("sha256", key).update(canonical).digest("hex"));
  return data.toString();
}
export const capturedReplies: { method: string; path: string; status: number; json: unknown }[] = [];
export function fixture(options: Partial<StudentHttpDependencies> = {}) {
  const store = new TransactionFixture();
  const handler = createStudentHttpHandler({ transactions: store, botToken: botKey,
    sessionPolicy: testPolicy, numericPresentation: testNumbers, ...options });
  async function call(method: string, path: string,
    config: { token?: string; body?: unknown; raw?: string; key?: string } = {}) {
    const headers: Record<string, string> = {};
    if (config.token) headers.authorization = `Bearer ${config.token}`;
    if (config.key) headers["idempotency-key"] = config.key;
    if (config.body !== undefined) headers["content-type"] = "application/json";
    const response = await handler(new Request(`http://local.invalid/api/v1${path}`, {
      method, headers, body: config.raw ?? (config.body === undefined ? undefined : JSON.stringify(config.body)),
    }));
    const json = await response.json();
    capturedReplies.push({ method, path, status: response.status, json });
    return { status: response.status, headers: response.headers, json };
  }
  async function login(telegramId = 4_000_000_001, queryId = "synthetic-login") {
    return call("POST", "/auth/telegram", { body: { init_data: signedInitData(telegramId, queryId, store.time) } });
  }
  return { store, handler, call, login };
}

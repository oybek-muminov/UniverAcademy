import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { ApiFault } from "../../supabase/functions/univeracademy-api/fault.ts";
import { createStaffHttpHandler } from "../../supabase/functions/univeracademy-api/staff-http.ts";
import type { StaffHttpDependencies } from "../../supabase/functions/univeracademy-api/staff-http.ts";
import type { MembershipEffect, StaffState, StaffTransaction, StaffTransactions } from "../../supabase/functions/univeracademy-api/staff-state.ts";
import { STAFF_CONTRACT_SHA } from "../../supabase/functions/univeracademy-api/staff-state.ts";
import { reconcileMembershipEffects } from "../../supabase/functions/univeracademy-api/membership-effects.ts";
import { createStudentHttpHandler } from "../../supabase/functions/univeracademy-api/student-http.ts";
import type { StudentTransactions } from "../../supabase/functions/univeracademy-api/student-state.ts";
import { initialState, clock, id, ids, botKey, signedInitData, testNumbers, testPolicy } from "./http-fixture.ts";

const load = createRequire(import.meta.url);
const { buildView } = load("./validator/view-builder.cjs");
const { compileView } = load("./validator/ajv-config.cjs");
const full = readFileSync(new URL("../../contracts/review-only.openapi.json", import.meta.url));
const schemaValidators: Map<string, (data: unknown) => boolean> = compileView(buildView(full).view).validators;
export const validate = (name: string, value: unknown) => Boolean(schemaValidators.get(name)?.(value));
export const staffIds = { targetGroup: id(41), thirdGroup: id(42), draft: id(31), future: id(11),
  owner: id(500), admin: id(501), teacher: id(502), unknown: id(599) };
export const transferBody = () => ({ to_group_id: staffIds.targetGroup, reason: "Synthetic authorized transfer", expected_membership_revision: 7 });
export const versionBody = () => ({ expected_revision: 3, duration_seconds: 1800,
  instructions_blocks: [{ type: "text", markdown: "Synthetic draft instructions" }], grading_config: { individual_enabled: false } });
export function initialStaffState(): StaffState {
  const student = initialState();
  student.assignments[staffIds.future] = structuredClone(student.assignments[ids.assignment]);
  student.assignments[staffIds.future].admission.assignmentId = staffIds.future;
  student.assignments[staffIds.future].admission.opensAt = clock + 100_000;
  student.assignments[staffIds.future].admission.closesAt = clock + 200_000;
  student.assignments[staffIds.future].published.demoId = id(21);
  student.grants[ids.person][staffIds.future] = { rostered: true, membershipEpoch: 7, grantEpoch: 7 };
  const common = { enabled: true, approved: true, approvedSubjectIds: ["physics"],
    capabilities: { manage_roster: true, manage_content: true },
    scope: { all_groups: false, group_ids: [ids.group, staffIds.targetGroup], all_subjects: false, subject_ids: ["physics"] } };
  return { student, staff: {
    "synthetic-owner": { ...structuredClone(common), personId: staffIds.owner, roles: ["owner"] },
    "synthetic-admin": { ...structuredClone(common), personId: staffIds.admin, roles: ["admin"] },
    "synthetic-teacher": { ...structuredClone(common), personId: staffIds.teacher, roles: ["teacher"] },
  }, groups: Object.fromEntries([ids.group, staffIds.targetGroup, staffIds.thirdGroup].map((group) => [group, { id: group }])),
  memberships: { [ids.person]: { affinityGroupId: ids.group, active: true, revision: 7, epoch: 7 } },
  versions: { [staffIds.draft]: { subjectId: "physics", questionIds: [id(100), id(101)], wire: {
    id: staffIds.draft, demo_id: ids.demo, version_no: 2, duration_seconds: 600, instructions_blocks: [{ type: "text", markdown: "Initial" }],
    status: "draft", revision: 3, grading_config: { individual_enabled: false } } } },
  recoveryAssignments: {}, notifications: {
    queued: { studentId: ids.person, assignmentId: staffIds.future, epoch: 7, status: "queued" },
    sent: { studentId: ids.person, assignmentId: staffIds.future, epoch: 7, status: "sent" },
  }, approvals: { pending: { studentId: ids.person, epoch: 7, status: "pending" },
    approved: { studentId: ids.person, epoch: 7, status: "approved" } }, receipts: {}, audit: [] };
}
export class StaffFixture implements StaffTransactions {
  state = initialStaffState(); time = clock; events: string[] = [];
  failNextCommit = false; failEffects = false;
  beforeWork: (() => Promise<void>) | null = null;
  beforeCommit: (() => Promise<void>) | null = null;
  private tail = Promise.resolve();
  effectCalls: MembershipEffect[] = [];
  private readonly liveClock?: () => number;
  constructor(liveClock?: () => number) { this.liveClock = liveClock; }
  async transaction<T>(work: (tx: StaffTransaction) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    this.events.push("lock");
    try {
      if (this.beforeWork) await this.beforeWork();
      const draft = structuredClone(this.state);
      const value = await work({ state: draft, now: () => {
        this.events.push("clock"); return this.liveClock ? this.liveClock() : this.time;
      } });
      if (this.beforeCommit) await this.beforeCommit();
      if (this.failNextCommit) { this.failNextCommit = false; throw new ApiFault("SERVICE_UNAVAILABLE", 503); }
      this.state = draft; this.events.push("commit");
      return value;
    } finally { release(); }
  }
  readonly studentTransactions: StudentTransactions = {
    transaction: (work) => this.transaction(({ state, now }) => work({ state: state.student, now })),
  };
  async effects(state: StaffState, effect: MembershipEffect): Promise<void> {
    if (this.failEffects) throw new ApiFault("SERVICE_UNAVAILABLE", 503);
    this.effectCalls.push(structuredClone(effect));
    await reconcileMembershipEffects(state, effect);
  }
}
export async function verifySyntheticStaffToken(token: string, at = clock) {
  const subject = ({ "synthetic-owner-proof": "synthetic-owner", "synthetic-admin-proof": "synthetic-admin",
    "synthetic-teacher-proof": "synthetic-teacher" } as Record<string, string>)[token];
  if (!subject) throw new ApiFault("STAFF_TOKEN_INVALID", 401);
  return { kind: "staff_verified" as const, subject, notBefore: at - 1, expiresAt: at + 1_000_000 };
}
export function staffFixture(overrides: Partial<StaffHttpDependencies> = {}) {
  const store = new StaffFixture();
  const handler = createStaffHttpHandler({ transactions: store, contractSha: STAFF_CONTRACT_SHA, validate,
    verifyStaffToken: verifySyntheticStaffToken,
    reconcileMembershipDependencies: (state, effect) => store.effects(state, effect), ...overrides });
  const student = createStudentHttpHandler({ transactions: store.studentTransactions, botToken: botKey,
    sessionPolicy: testPolicy, numericPresentation: testNumbers });
  async function call(path: string, body: unknown, options: { role?: string; key?: string; raw?: string; method?: string } = {}) {
    const reply = await handler(new Request("https://local.invalid/api/v1" + path, {
      method: options.method || (path.includes("/transfer") ? "POST" : "PATCH"), headers: {
        authorization: "Bearer " + (options.role || "synthetic-owner-proof"), "idempotency-key": options.key || "synthetic-command-key",
        "content-type": "application/json" }, body: options.raw ?? JSON.stringify(body) }));
    store.events.push("reply");
    const json = await reply.json();
    if (reply.status !== 200 && !validate("Error", json)) throw Error("STAFF_ERROR_WIRE_INVALID");
    return { status: reply.status, headers: reply.headers, json };
  }
  async function studentCall(method: string, path: string, body?: unknown, token?: string) {
    const response = await student(new Request("https://local.invalid/api/v1" + path, { method, headers: {
      ...(token ? { authorization: "Bearer " + token } : {}), "content-type": "application/json", "idempotency-key": "synthetic-student-key" },
      body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: response.status, json: await response.json() };
  }
  async function start() {
    const login = await studentCall("POST", "/auth/telegram", { init_data: signedInitData() });
    const token = login.json.data.access_token;
    const attempt = await studentCall("POST", `/exams/${ids.assignment}/attempts`, { confirmed: true }, token);
    if (attempt.status !== 200) throw Error("SYNTHETIC_START_FAILED");
    return { token, attempt: attempt.json.data };
  }
  return { store, handler, call, studentCall, start };
}

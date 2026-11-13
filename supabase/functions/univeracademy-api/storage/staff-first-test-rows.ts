import { fail } from "../fault.ts";
import { parseStaffJson } from "../staff-json.ts";
import { canWriteContent, groupScope, owner, requireRosterAuthority } from "../staff-state.ts";
import type { AuthoredQuestion, DraftRecord, StaffAccessRecord, StaffState, Version } from "../staff-state.ts";
import type { AssignmentRecord, Person, StudentState } from "../student-state.ts";
import { decodePublished, encodePublished } from "./attempt-rows.ts";
import { integer, own, query } from "./postgres-transaction.ts";
import type { LockedTransaction } from "./postgres-transaction.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (v: unknown): string => JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x);
const same = (a: unknown, b: unknown) => json(a) === json(b);
type Command = { kind: "question" | "publish" | "metadata" | "member" | "assignment";
  versionId?: string; groupId?: string; students: string[]; path: string };
type Snapshot = NonNullable<DraftRecord["publishedSnapshot"]>;
type StoredSnapshot = Omit<Snapshot, "test"> & { test: ReturnType<typeof encodePublished> };
const storeSnapshot = (s: DraftRecord["publishedSnapshot"]) => s ? { ...s, test: encodePublished(s.test) } : null;
function emptyStudent(): StudentState {
  return { people: {}, families: {}, access: {}, refresh: {}, consumedInitData: {}, grants: {},
    assignments: {}, series: {}, attempts: {}, receipts: {}, bonuses: {}, cancellations: {} };
}

// Narrow command repository, not staff CRUD. DDL/RLS and actual PostgreSQL execution
// remain unverified. All calls use the caller's one open transaction/client.
export class StaffFirstTestRows {
  private command!: Command;
  private group?: Record<string, unknown>;
  private version?: Record<string, unknown>;
  private receiptKey!: string;
  private request: Request;
  private validate: (schema: string, value: unknown) => boolean;
  constructor(request: Request, validate: (schema: string, value: unknown) => boolean) {
    this.request = request; this.validate = validate;
  }

  async lock(tx: LockedTransaction, actorId: string): Promise<void> {
    const path = new URL(this.request.url).pathname, method = this.request.method;
    const version = path.match(/^\/api\/v1\/admin\/versions\/([^/]+)(?:\/(publish|questions\/([^/]+)))?\/?$/);
    const member = path.match(/^\/api\/v1\/admin\/groups\/([^/]+)\/members\/?$/);
    let schema: string, command: Command;
    if (version && ((method === "PATCH" && !version[2]) || (method === "POST" && version[2] === "publish") ||
        (method === "PUT" && version[3]))) {
      if (!uuid.test(version[1]) || (version[3] && !uuid.test(version[3]))) fail("NOT_FOUND", 404);
      const id = version[1].toLowerCase(), kind = version[3] ? "question" : version[2] ? "publish" : "metadata";
      schema = kind === "question" ? "QuestionWrite" : kind === "publish" ? "Publish" : "VersionPatch";
      command = { kind, versionId: id, students: [], path: `/admin/versions/${id}` +
        (kind === "question" ? `/questions/${version[3].toLowerCase()}` : kind === "publish" ? "/publish" : "") };
    } else if (member && method === "PUT") {
      if (!uuid.test(member[1])) fail("NOT_FOUND", 404);
      const id = member[1].toLowerCase(); schema = "MemberWrite";
      command = { kind: "member", groupId: id, students: [], path: `/admin/groups/${id}/members` };
    } else if (/^\/api\/v1\/admin\/assignments\/?$/.test(path) && method === "POST") {
      schema = "AssignmentCreate"; command = { kind: "assignment", students: [], path: "/admin/assignments" };
    } else fail("SERVICE_UNAVAILABLE", 503); // Transfer/full staff CRUD need their own repositories.
    const body = parseStaffJson(await this.request.text()) as Record<string, unknown>;
    if (!this.validate(schema, body)) fail("VALIDATION_ERROR", 422);
    if (command.kind === "member") command.students = [(body.student_id as string).toLowerCase()];
    if (command.kind === "assignment") {
      command.students = (body.student_ids as string[]).map(id => id.toLowerCase());
      command.groupId = (body.group_id as string).toLowerCase();
      command.versionId = (body.version_id as string).toLowerCase();
    }
    for (const id of command.students) own(tx, id); // Parsed targets must match the person lock hints.
    const key = this.request.headers.get("idempotency-key");
    if (!key || key.length < 8 || key.length > 128) fail("VALIDATION_ERROR", 422);
    this.command = command; this.receiptKey = `${actorId}/${method}/${command.path}/${key}`;
    // Lock order for every first-test writer: sorted people, group, version, DB clock.
    if (command.groupId) {
      this.group = (await query(tx, "ua_first_group_lock",
        "SELECT id::text,revision::text,status FROM ua_private.groups WHERE id=$1 FOR UPDATE", [command.groupId])).rows[0];
      if (!this.group) fail("NOT_FOUND", 404);
    }
    if (command.versionId) {
      this.version = (await query(tx, "ua_first_version_lock", `SELECT v.id::text,v.demo_id::text,v.revision::text,v.status,v.wire,v.published_snapshot,d.subject_id::text,d.title
FROM ua_private.test_versions v JOIN ua_private.demos d ON d.id=v.demo_id WHERE v.id=$1 FOR UPDATE OF v`, [command.versionId])).rows[0];
      if (!this.version) fail("NOT_FOUND", 404);
    }
    const clock = await query(tx, "ua_clock", "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms");
    if (clock.rows.length !== 1) fail("RESPONSE_INVARIANT_FAILED", 500);
    tx.now = integer(clock.rows[0].now_ms);
    if (tx.now > 8_640_000_000_000_000) fail("RESPONSE_INVARIANT_FAILED", 500);
  }

  async load(tx: LockedTransaction, actor: StaffAccessRecord): Promise<StaffState> {
    own(tx, actor.personId);
    const c = this.command, subject = this.version?.subject_id as string;
    if (c.kind === "member") requireRosterAuthority(actor);
    else if (c.kind === "assignment") {
      if (!owner(actor)) {
        if (!actor.roles.includes("admin")) fail("SERVICE_UNAVAILABLE", 503);
        if (!actor.capabilities.manage_content) fail("CAPABILITY_REQUIRED", 403);
        if (!actor.scope.all_subjects && !actor.scope.subject_ids.includes(subject)) fail("NOT_FOUND", 404);
      }
    } else if (c.kind === "metadata") {
      if (!canWriteContent(actor, subject)) fail("NOT_FOUND", 404);
    } else if (!owner(actor)) {
      if (!actor.roles.includes("teacher")) fail("SERVICE_UNAVAILABLE", 503);
      if (!actor.approvedSubjectIds.includes(subject)) fail("NOT_FOUND", 404);
    }
    if (c.groupId && !groupScope(actor, c.groupId)) fail("NOT_FOUND", 404);
    const s: StaffState = { student: emptyStudent(), staff: {}, groups: {}, memberships: {}, versions: {},
      demos: {}, recoveryAssignments: {}, notifications: {}, approvals: {}, receipts: {}, audit: [] };
    if (this.group) s.groups[c.groupId!] = { id: c.groupId!, revision: integer(this.group.revision), status: this.group.status as "active" | "archived" };
    if (this.version) {
      const row = this.version, wire = row.wire as Version;
      if (wire.id !== c.versionId || wire.demo_id !== row.demo_id || wire.revision !== integer(row.revision) || wire.status !== row.status)
        fail("RESPONSE_INVARIANT_FAILED", 500);
      const questions = (await query(tx, "ua_first_questions", "SELECT id::text,record FROM ua_private.draft_questions WHERE version_id=$1 ORDER BY position,id", [c.versionId])).rows;
      const stored = row.published_snapshot as StoredSnapshot | null;
      s.versions[wire.id] = { wire, subjectId: subject, questionIds: questions.map(q => q.id as string),
        questions: Object.fromEntries(questions.map(q => [q.id, q.record as AuthoredQuestion])),
        ...(stored ? { publishedSnapshot: { ...stored, test: decodePublished(stored.test) } } : {}) };
      s.demos![wire.demo_id] = { title: row.title as string, subjectId: subject };
    }
    for (const id of new Set(c.students)) {
      const p = (await query(tx, "ua_http_person", "SELECT telegram_id::text,enabled,roles,profile FROM ua_private.people WHERE id=$1", [id])).rows[0];
      if (!p) fail("NOT_FOUND", 404);
      const profile = p.profile as Person["profile"];
      if (profile.person_id !== id || !same(profile.roles, p.roles)) fail("RESPONSE_INVARIANT_FAILED", 500);
      if(typeof p.enabled!=="boolean")fail("RESPONSE_INVARIANT_FAILED",500);
      s.student.people[id] = { telegramId: p.telegram_id===null?null:integer(p.telegram_id), enabled: p.enabled, profile };
      const m = (await query(tx, "ua_first_membership", "SELECT affinity_group_id::text,active,revision::text,epoch::text FROM ua_private.memberships WHERE person_id=$1", [id])).rows[0];
      if (!m) fail("NOT_FOUND", 404);
      s.memberships[id] = { affinityGroupId: m.affinity_group_id as string | null, active: m.active as boolean, revision: integer(m.revision), epoch: integer(m.epoch) };
      // Do not expose an existing foreign membership through a receipt replay.
      if (m.affinity_group_id && !groupScope(actor, m.affinity_group_id as string)) fail("NOT_FOUND", 404);
      s.student.grants[id] = {};
      for (const g of (await query(tx, "ua_first_grants", "SELECT assignment_id::text,rostered,grant_epoch::text FROM ua_private.grants WHERE person_id=$1", [id])).rows)
        s.student.grants[id][g.assignment_id as string] = { rostered: g.rostered as boolean, membershipEpoch: integer(m.epoch), grantEpoch: integer(g.grant_epoch) };
    }
    if (c.kind === "assignment") {
      for (const a of (await query(tx, "ua_first_assignments", "SELECT record FROM ua_private.assignments WHERE group_id=$1 AND demo_id=$2", [c.groupId, this.version!.demo_id])).rows) {
        const record = a.record as Omit<AssignmentRecord, "published"> & { published: ReturnType<typeof encodePublished> };
        s.student.assignments[record.admission.assignmentId] = { ...record, published: decodePublished(record.published) };
      }
    }
    const prior = (await query(tx, "ua_first_receipt", "SELECT payload,response FROM ua_private.staff_receipts WHERE actor_id=$1 AND key=$2", [actor.personId, this.receiptKey])).rows[0];
    if (prior) s.receipts[this.receiptKey] = { ...(prior.response as StaffState["receipts"][string]), payload: prior.payload as string };
    return s;
  }

  async flush(tx: LockedTransaction, actorId: string, before: StaffState, after: StaffState): Promise<void> {
    const write = async (name: string, text: string, values: readonly unknown[], code = "RESPONSE_INVARIANT_FAILED", status = 500) => {
      if ((await query(tx, name, text, values)).rowCount !== 1) fail(code, status);
    };
    // Session/attempt/result/recovery state is outside this repository's write scope.
    for (const key of ["families", "access", "refresh", "consumedInitData", "series", "attempts", "receipts", "bonuses", "cancellations"] as const)
      if (!same(before.student[key], after.student[key])) fail("RESPONSE_INVARIANT_FAILED", 500);
    for (const [id, next] of Object.entries(after.versions)) {
      const old = before.versions[id];
      if (same(old, next)) continue;
      if (!old || old.wire.status !== "draft" || old.publishedSnapshot || next.wire.revision !== old.wire.revision + 1 ||
          old.subjectId !== next.subjectId || old.wire.id !== next.wire.id || old.wire.demo_id !== next.wire.demo_id)
        fail("RESPONSE_INVARIANT_FAILED", 500);
      await write("ua_first_version_write", "UPDATE ua_private.test_versions SET wire=$2::jsonb,revision=$3,status=$4,published_snapshot=$5::jsonb WHERE id=$1 AND revision=$6 AND status='draft' RETURNING id",
        [id, JSON.stringify(next.wire), next.wire.revision, next.wire.status, JSON.stringify(storeSnapshot(next.publishedSnapshot)), old.wire.revision], "RESOURCE_REVISION_CONFLICT", 409);
      for (const [qid, q] of Object.entries(next.questions ?? {})) if (!same(old.questions?.[qid], q))
        await write("ua_first_question_write", "INSERT INTO ua_private.draft_questions(version_id,id,position,record) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(version_id,id) DO UPDATE SET position=EXCLUDED.position,record=EXCLUDED.record RETURNING id", [id, qid, q.position, JSON.stringify(q)]);
    }
    for (const [id, next] of Object.entries(after.groups)) if (!same(before.groups[id], next))
      await write("ua_first_group_write", "UPDATE ua_private.groups SET revision=$2 WHERE id=$1 AND revision=$3 AND status='active' RETURNING id", [id, next.revision, before.groups[id].revision], "RESOURCE_REVISION_CONFLICT", 409);
    for (const [id, next] of Object.entries(after.memberships)) if (!same(before.memberships[id], next)) {
      own(tx, id); const old = before.memberships[id];
      if (old.affinityGroupId !== null || old.active || !next.active || next.revision !== old.revision + 1 || next.epoch !== old.epoch + 1)
        fail("RESPONSE_INVARIANT_FAILED", 500);
      await write("ua_first_membership_write", "UPDATE ua_private.memberships SET affinity_group_id=$2,active=true,revision=$3,epoch=$4 WHERE person_id=$1 AND revision=$5 AND epoch=$6 AND affinity_group_id IS NULL AND NOT active RETURNING person_id", [id, next.affinityGroupId, next.revision, next.epoch, old.revision, old.epoch], "STATE_REVISION_CONFLICT", 409);
      const p = after.student.people[id], prior = before.student.people[id];
      if (!same(p, { ...prior, profile: { ...prior.profile, active_group_id: next.affinityGroupId } })) fail("RESPONSE_INVARIANT_FAILED", 500);
      await write("ua_first_person_group_write", "UPDATE ua_private.people SET profile=jsonb_set(profile,'{active_group_id}',to_jsonb($2::text),true) WHERE id=$1 AND profile->'active_group_id'='null'::jsonb RETURNING id", [id, next.affinityGroupId]);
    }
    for (const [id, a] of Object.entries(after.student.assignments)) if (!same(before.student.assignments[id], a)) {
      if (before.student.assignments[id]) fail("RESPONSE_INVARIANT_FAILED", 500);
      await write("ua_first_assignment_write", "INSERT INTO ua_private.assignments(id,group_id,demo_id,version_id,revision,record) VALUES($1,$2,$3,$4,0,$5::jsonb) ON CONFLICT DO NOTHING RETURNING id", [id, a.admission.groupId, a.published.demoId, a.published.versionId, JSON.stringify({ ...a, published: encodePublished(a.published) })], "ASSIGNMENT_CONFLICT", 409);
    }
    for (const [personId, grants] of Object.entries(after.student.grants)) for (const [id, g] of Object.entries(grants)) if (!same(before.student.grants[personId]?.[id], g)) {
      own(tx, personId);
      if (before.student.grants[personId]?.[id] || !after.student.assignments[id] || !g.rostered || g.grantEpoch !== after.memberships[personId].epoch)
        fail("RESPONSE_INVARIANT_FAILED", 500);
      await write("ua_first_grant_write", "INSERT INTO ua_private.grants(person_id,assignment_id,rostered,grant_epoch) VALUES($1,$2,true,$3) ON CONFLICT DO NOTHING RETURNING person_id", [personId, id, g.grantEpoch]);
    }
    for (const [key, receipt] of Object.entries(after.receipts)) if (!same(before.receipts[key], receipt)) {
      if (before.receipts[key] || key !== this.receiptKey || !key.startsWith(actorId + "/")) fail("RESPONSE_INVARIANT_FAILED", 500);
      const { payload, ...response } = receipt;
      await write("ua_first_receipt_write", "INSERT INTO ua_private.staff_receipts(actor_id,key,payload,response) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING key", [actorId, key, payload, JSON.stringify(response)], "IDEMPOTENCY_CONFLICT", 409);
    }
    for (const entry of after.audit) {
      if (entry.actorId !== actorId) fail("RESPONSE_INVARIANT_FAILED", 500);
      await write("ua_first_audit_write", "INSERT INTO ua_private.staff_audit(command_key,actor_id,action,target_id,revision,at_ms) VALUES($1,$2,$3,$4,$5,$6) RETURNING command_key", [this.receiptKey, actorId, entry.action, entry.targetId, entry.revision, entry.at]);
    }
  }
}

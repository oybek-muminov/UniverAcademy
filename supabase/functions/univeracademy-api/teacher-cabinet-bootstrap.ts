// Internal review adapter. No Worker mount or corresponding privileges exist here.
import { checkClerkProof, requireLiveClerk } from "./clerk-auth.ts";
import type { ClerkLiveness, ClerkProof } from "./clerk-auth.ts";
import { ApiFault, fail } from "./fault.ts";
import { currentStaff } from "./staff-state.ts";
import type { StaffAccessRecord } from "./staff-state.ts";
import { StaffAccessRows } from "./storage/staff-access-rows.ts";
import { query } from "./storage/postgres-transaction.ts";
import type { LockedTransaction } from "./storage/postgres-transaction.ts";

type Row = Readonly<{ id: string; title: string }>;
type ScopedTest = Row & Readonly<{ groupId: string; subjectId: string }>;
type ScopedMetadata = Readonly<{
  personId: string;
  complete: true;
  name: string;
  subjects: readonly Row[];
  groups: readonly Row[];
  tests: readonly ScopedTest[];
}>;

export type TeacherBootstrap = Readonly<{
  person_id: string;
  name: string;
  access: Readonly<{ teacher: true; approved: true; enabled: true }>;
  subjects: readonly string[];
  groups: readonly Row[];
  tests: readonly Row[];
}>;

type Scope = Readonly<{ personId: string; subjectIds: readonly string[]; groupIds: readonly string[] }>;

type TrustedRead = Readonly<{
  // Current, matching Clerk proof verified independently for this request.
  // Never synthesize from Student bearer, cabinet-access, URL data or JWT roles.
  proof: ClerkProof;
  liveness: ClerkLiveness;
  tx: LockedTransaction;
  signal: AbortSignal;
  // Uses DB time via the same canonical transaction (fresh on every call).
  clock: () => Promise<number>;
  // Outer runner enforces the minimum provider/token expiry at commit, as well
  // as abort and successful fresh reauthorization. Until wired, mount nothing.
  restrictLease: (expiresAt: number) => void;
  // Required authorized storage port. It must prove a complete capped scoped
  // projection; absence/uncertainty must fail, never be replaced with empty lists.
  readMetadata: (scope: Scope, signal: AbortSignal) => Promise<ScopedMetadata | null>;
}>;

function label(x: unknown): x is string {
  return typeof x === "string" && x.length <= 200 && x.trim().length > 0;
}
const uuid = (x: unknown): x is string => typeof x === "string" && x.length === 36 &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(x);
function malformed(): never { return fail("RESPONSE_INVARIANT_FAILED", 500); }

function scopeFor(s: StaffAccessRecord): Scope {
  if (!s.roles.includes("teacher") || !s.approvedSubjectIds.length) fail("FORBIDDEN",403);
  if (!uuid(s.personId) || s.approvedSubjectIds.length > 100 || s.scope.group_ids.length > 500 ||
    s.approvedSubjectIds.some(id => !label(id)) || s.scope.group_ids.some(id => !uuid(id))) malformed();
  // Teacher cabinet never promotes another role's owner/all-groups authority.
  return Object.freeze({personId:s.personId,
    subjectIds:Object.freeze([...new Set(s.approvedSubjectIds)].sort()),
    groupIds:Object.freeze([...new Set(s.scope.group_ids)].sort())});
}

function sameScope(a: Scope, b: Scope): boolean {
  return a.personId === b.personId && a.subjectIds.length === b.subjectIds.length &&
    a.groupIds.length === b.groupIds.length && a.subjectIds.every((id, i) => id === b.subjectIds[i]) &&
    a.groupIds.every((id, i) => id === b.groupIds[i]);
}

function project(meta: ScopedMetadata, scope: Scope): TeacherBootstrap {
  if (meta.complete !== true || meta.personId !== scope.personId || !label(meta.name) || !Array.isArray(meta.subjects) ||
    !Array.isArray(meta.groups) || !Array.isArray(meta.tests) || meta.subjects.length !== scope.subjectIds.length ||
    meta.groups.length !== scope.groupIds.length || meta.tests.length > 500) malformed();

  const approved = new Set(scope.subjectIds), intendedGroups = new Set(scope.groupIds);
  const seenSubjects = new Set<string>(), seenGroups = new Set<string>(), seenTests = new Set<string>();
  const subjects = (meta.subjects as readonly Row[]).map(s => {
    if (!s || !approved.has(s.id) || seenSubjects.has(s.id) || !label(s.title)) return malformed();
    seenSubjects.add(s.id);
    return s.title;
  });
  const groups = (meta.groups as readonly Row[]).map(g => {
    if (!g || !intendedGroups.has(g.id) || seenGroups.has(g.id) || !label(g.title)) return malformed();
    seenGroups.add(g.id);
    return Object.freeze({id:g.id,title:g.title});
  });
  const tests = (meta.tests as readonly ScopedTest[]).map(t => {
    if (!t || !uuid(t.id) || seenTests.has(t.id) || !seenGroups.has(t.groupId) ||
      !approved.has(t.subjectId) || !label(t.title)) return malformed();
    seenTests.add(t.id);
    return Object.freeze({id:t.id,title:t.title});
  });
  return Object.freeze({person_id:scope.personId,name:meta.name,
    access:Object.freeze({teacher:true as const,approved:true as const,enabled:true as const}),
    subjects:Object.freeze(subjects),groups:Object.freeze(groups),tests:Object.freeze(tests)});
}

export async function readTeacherCabinetBootstrap(deps: TrustedRead): Promise<TeacherBootstrap> {
  const {proof,tx,signal}=deps;
  const personId=tx.personIds[0];
  if (tx.personIds.length !== 1 || !uuid(personId)) fail("SERVICE_UNAVAILABLE",503);
  const authRows=new StaffAccessRows();
  let lastClock=-1, deadline=proof.expiresAt;
  const now=async()=>{
    signal.throwIfAborted();
    const value=await deps.clock();
    signal.throwIfAborted();
    if (!Number.isSafeInteger(value) || value < tx.now || value < lastClock) fail("SERVICE_UNAVAILABLE",503);
    lastClock=value;
    checkClerkProof(proof,value);
    if(value>=deadline) fail("CLERK_SESSION_REVOKED",401);
    return value;
  };
  const verify=async()=>{
    const checkedAt=await now();
    const expires=await requireLiveClerk(proof,checkedAt,(identity,t)=>deps.liveness(identity,t,{signal}));
    signal.throwIfAborted();
    deadline=Math.min(deadline,expires);
    deps.restrictLease(deadline);
    const dbStaff=await authRows.load(tx,{issuer:proof.issuer,subject:proof.userId},personId,"clerk").catch(error => {
      // The Clerk mapping has already been verified. A missing staff record
      // means this signed-in person has no cabinet access.
      if (error instanceof ApiFault && error.code === "STAFF_TOKEN_INVALID") fail("FORBIDDEN",403);
      throw error;
    });
    const staff=currentStaff({staff:{[proof.userId]:dbStaff}},
      {kind:"staff_verified",subject:proof.userId,notBefore:proof.notBefore,expiresAt:proof.expiresAt},await now());
    if(staff.personId!==personId) malformed();
    const scope = scopeFor(staff);
    const groups = await query(tx,"ua_teacher_visible_groups_v1",
      "SELECT id::text, status FROM ua_private.groups WHERE id=ANY($1::uuid[]) ORDER BY id", [scope.groupIds]);
    if (groups.rows.length !== scope.groupIds.length || groups.rows.some((row, i) =>
      row.id !== scope.groupIds[i] || (row.status !== "active" && row.status !== "archived"))) malformed();
    return {...scope, groupIds: Object.freeze(groups.rows.filter(row => row.status === "active").map(row => row.id as string))};
  };
  const scoped=await verify();
  const meta=await deps.readMetadata(scoped,signal);
  signal.throwIfAborted();
  if(!meta) fail("SERVICE_UNAVAILABLE",503);
  // Detach only presentational fields before another await; never propagate raw SQL rows.
  const response=project(meta,scoped);
  const current=await verify();
  if(!sameScope(scoped,current)) fail("FORBIDDEN",403);
  await now();
  return response;
}

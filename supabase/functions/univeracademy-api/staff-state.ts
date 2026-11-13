import { fail } from "./fault.ts";
import type { StudentState } from "./student-state.ts";
import type { PublishedTest } from "./ordinary.ts";
import type { components } from "../../../packages/api-client/staff-types.d.ts";

export type Version = components["schemas"]["Version"];
export type VersionPatch = components["schemas"]["VersionPatch"];
export type TransferWrite = components["schemas"]["TransferWrite"];
export type TransferResult = components["schemas"]["TransferResult"];
export type MemberWrite = components["schemas"]["MemberWrite"];
export type MembershipMutation = components["schemas"]["MembershipMutation"];
export type AssignmentCreate = components["schemas"]["AssignmentCreate"];
export type Assignment = components["schemas"]["Assignment"];
export type QuestionWrite = components["schemas"]["QuestionWrite"];
export type Publish = components["schemas"]["Publish"];
export type AuthoredQuestion = Omit<QuestionWrite, "expected_revision">;
export const STAFF_CONTRACT_SHA = "9c7518f887aafacc5cf53b73d33a87d42b11a9fcd46730185b39360e62fe3bb4";

export type StaffAccessRecord = {
  personId: string; enabled: boolean; approved: boolean;
  roles: ("teacher" | "admin" | "owner")[];
  approvedSubjectIds: string[];
  capabilities: { manage_roster: boolean; manage_content: boolean };
  scope: { all_groups: boolean; group_ids: string[]; all_subjects: boolean; subject_ids: string[] };
};
export type MembershipRecord = { affinityGroupId: string | null; active: boolean; revision: number; epoch: number };
export type DraftRecord = {
  wire: Version; subjectId: string; questionIds: string[];
  questions?: Record<string, AuthoredQuestion>;
  publishedSnapshot?: { test: PublishedTest; instructions: Version["instructions_blocks"]; questions: AuthoredQuestion[] };
};
export type MembershipChange = {
  actorId: string; studentId: string; fromGroupId: string; toGroupId: string;
  oldEpoch: number; newEpoch: number; revokedAssignmentIds: string[]; now: number;
};
export type MembershipEffect = { kind: "transferred"; change: MembershipChange } |
  { kind: "removed"; change: Omit<MembershipChange, "toGroupId"> } |
  { kind: "elapsed"; studentId: string; assignmentIds: string[]; demoIds: string[]; now: number };
export type StaffState = {
  student: StudentState;
  staff: Record<string, StaffAccessRecord>; // key = verified immutable staff subject, not a client role.
  groups: Record<string, { id: string; revision?: number; status?: "active" | "archived" }>;
  memberships: Record<string, MembershipRecord>;
  versions: Record<string, DraftRecord>;
  // Authoritative server-loaded demo metadata; not supplied by AssignmentCreate.
  demos?: Record<string, { title: string; subjectId: string }>;
  recoveryAssignments: Record<string, string>; // authoritative series-key -> original assignment anchor
  // Historical revoked start permissions only. Current eligibility remains in student.series.
  recoveryRevocations?: { seriesKey: string; generation: number; assignmentId: string; actorId: string;
    oldEpoch: number; revokedAt: number; window: { opensAt: number; closesAt: number; durationMs: number } }[];
  notifications: Record<string, { studentId: string; assignmentId: string; epoch: number; status: "queued" | "sent" | "cancelled" }>;
  approvals: Record<string, { studentId: string; epoch: number; status: "pending" | "approved" | "rejected" | "stale" }>;
  receipts: Record<string, { payload: string; transfer?: TransferResult; versionId?: string;
    membership?: MembershipMutation; assignment?: Assignment }>;
  audit: { actorId: string; action: string; targetId: string; revision: number; at: number }[];
};
export type StaffTransaction = { state: StaffState; now(): number };
export interface StaffTransactions {
  // Acquire affected auth/membership/resource locks first; resolve only after commit.
  // A returned error outcome commits lazy expiry; throwing aborts all writes.
  transaction<T>(work: (tx: StaffTransaction) => Promise<T>): Promise<T>;
}
export type VerifiedStaffProof = {
  kind: "staff_verified"; subject: string; notBefore: number; expiresAt: number;
};
export function currentStaff(state: Pick<StaffState,"staff">, proof: VerifiedStaffProof, now: number): StaffAccessRecord {
  if (proof.kind !== "staff_verified" || typeof proof.subject !== "string" ||
      !Number.isSafeInteger(proof.notBefore) || !Number.isSafeInteger(proof.expiresAt) ||
      proof.notBefore > now || now >= proof.expiresAt) fail("STAFF_TOKEN_INVALID", 401);
  const staff = state.staff[proof.subject];
  if (!staff) fail("STAFF_TOKEN_INVALID", 401);
  if (!staff.enabled) fail("ACCOUNT_DISABLED", 403);
  if (!staff.approved) fail("STAFF_NOT_APPROVED", 403);
  if (!staff.roles.length) fail("FORBIDDEN", 403);
  return staff;
}
export const owner = (staff: StaffAccessRecord) => staff.roles.includes("owner");
export const groupScope = (staff: StaffAccessRecord, id: string) =>
  owner(staff) || staff.scope.all_groups || staff.scope.group_ids.includes(id);
export function requireRosterAuthority(staff: StaffAccessRecord): void {
  if (owner(staff)) return;
  if (!staff.roles.includes("admin")) fail("FORBIDDEN", 403);
  if (!staff.capabilities.manage_roster) fail("CAPABILITY_REQUIRED", 403);
}
export function canWriteContent(staff: StaffAccessRecord, subjectId: string): boolean {
  return owner(staff) ||
    (staff.roles.includes("teacher") && staff.approvedSubjectIds.includes(subjectId)) ||
    (staff.roles.includes("admin") && staff.capabilities.manage_content &&
      (staff.scope.all_subjects || staff.scope.subject_ids.includes(subjectId)));
}
export function nextRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) fail("SERVICE_UNAVAILABLE", 503);
  return value + 1;
}

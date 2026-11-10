import { fail } from "./fault.ts";
import { groupScope, owner } from "./staff-state.ts";
import type { StaffAccessRecord } from "./staff-state.ts";

/** Removal-specific authority AFTER current identity/enabled/approval checks.
 * Does not grant transfer authority or final membership-removal permission. */
export function requireRemovalAuthority(staff: StaffAccessRecord, groupId: string): void {
  if (owner(staff)) return;
  const admin = staff.roles.includes("admin");
  if (!admin && !staff.roles.includes("teacher")) fail("FORBIDDEN", 403);
  // Capability precedes group/target visibility for both Admin and Teacher.
  if (!staff.capabilities.manage_roster) fail("CAPABILITY_REQUIRED", 403);
  if (admin ? !groupScope(staff, groupId) : !staff.scope.group_ids.includes(groupId)) fail("NOT_FOUND", 404);
}

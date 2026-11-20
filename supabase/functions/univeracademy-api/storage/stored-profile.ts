import { fail } from "../fault.ts";
import type { Person } from "../student-state.ts";

/** Older PostgreSQL rows remain readable during migration and rollback. */
export function readStoredProfile(value: unknown): Person["profile"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("RESPONSE_INVARIANT_FAILED", 500);
  }
  const stored = value as Record<string, unknown>;
  const legacy = Object.hasOwn(stored, "qadam_id");
  const current = Object.hasOwn(stored, "univeracademy_id");
  if (!legacy && !current || legacy && current && stored.qadam_id !== stored.univeracademy_id) {
    fail("RESPONSE_INVARIANT_FAILED", 500);
  }
  const cabinetId = current ? stored.univeracademy_id : stored.qadam_id;
  if (cabinetId !== null && (typeof cabinetId !== "string" || !/^[0-9]{10}$/.test(cabinetId))) {
    fail("RESPONSE_INVARIANT_FAILED", 500);
  }
  if (!legacy) return stored as Person["profile"];
  const { qadam_id: previousId, ...profile } = stored;
  return { ...profile, univeracademy_id: previousId } as Person["profile"];
}

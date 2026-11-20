import { fail } from "../fault.ts";
import type { PgClient } from "./postgres-transaction.ts";
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

// Pick a write target inside each new-person transaction. The empty scan acquires
// ACCESS SHARE on people until commit, serializing the choice with a column rename.
// Never retry application writes on an undefined-relation or permission error.
export async function registrationInsertTarget(client: PgClient) {
  const { rows } = await client.query({
    name: "ua_registration_write_target",
    text: `SELECT pg_catalog.to_regclass('ua_private.people_registration') IS NOT NULL AS expanded
      WHERE NOT EXISTS (SELECT id FROM ua_private.people WHERE false)`,
    values: [],
  });
  if (rows.length !== 1 || typeof rows[0].expanded !== "boolean") {
    fail("RESPONSE_INVARIANT_FAILED", 500);
  }
  const expanded = rows[0].expanded;
  return {
    statementSuffix: expanded ? "" : "_before_expand",
    insert: expanded
      ? "INSERT INTO ua_private.people_registration(id,telegram_id,univeracademy_id,enabled,roles,profile)"
      : "INSERT INTO ua_private.people(id,telegram_id,qadam_id,enabled,roles,profile)",
    profileJson(profile: Person["profile"]) {
      if (expanded) return JSON.stringify(profile);
      const { univeracademy_id, ...rest } = profile;
      return JSON.stringify({ ...rest, qadam_id: univeracademy_id });
    },
  };
}

// Registration owns only these three profile fields. Preserve the stored ID key
// and group under the unchanged strict RLS. The rename trigger normalizes old
// rows touched after forward, including rows that have not been backfilled yet.
export const updateRegistrationProfile = `UPDATE ua_private.people SET profile = profile || jsonb_build_object(
  'first_name', $1::jsonb->'first_name', 'last_name', $1::jsonb->'last_name',
  'registration_complete', $1::jsonb->'registration_complete') WHERE id=$2 RETURNING id`;
